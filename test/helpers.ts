import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../src/core/log.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;
}

// Group IDs from fixtures/groups.json (captured from api02; see fixtures/README.md).
export const FAMILY = "00000000-0000-4000-8000-bc531f349788"; // "Family"
export const SKATE = "00000000-0000-4000-8000-2c3dbeff7817"; // "Team 🛹 Skateboard"
export const CONSENT = "00000000-0000-4000-8000-3d569ac8d566"; // holds Newman's disclosed-away row
export const EVENT = "00000000-0000-4000-8000-f6177b48ca28"; // holds Newman's global-Ghost row
export const FRIENDS = "00000000-0000-4000-8000-0aaaa555fdd7"; // holds Newman's consent-off row
export const PUBLIC = "00000000-0000-4000-8000-4108066fb6b0"; // "Dog Park @ Marymoor", group_type public
export const GYM = "00000000-0000-4000-8000-ae78a59cc7e0"; // "Team 425 gym", group_type public
export const SKATEPARK = "00000000-0000-4000-8000-8dd8d8268acd"; // area of "Team 🛹 Skateboard"; Family serves that group's captured counts, so it shares it

// A route table for a fake PositionGuard API: path → status + body, or a
// function for stateful behaviour. Paths are relative to /api/v1.
export type Route = { status: number; body?: unknown; headers?: Record<string, string> };
export type Routes = Record<string, Route | (() => Route)>;

// The default world, built on the captured group list. Each members.*.json
// holds one state of one synthetic member, so a roster is a concatenation:
// Newman appears in five groups in five different states, each row a capture
// from a real group: at the Skatepark in "Family", stale at the Skatepark in
// "Team 🛹 Skateboard", disclosed-away in "Consent Test Group", withheld
// (consent off) in "Friends", global Ghost in "Event". He is also a
// Ghost-joined member of the public "Dog Park @ Marymoor", whose roster is
// served whole (members.ghost_join.public_group.json) and has no row for
// him. Fred and John (sharing off) sit in "Family" and the Consent Test
// Group; EarlonDev (away, no safety block) in the public "Team 425 gym".
export function defaultRoutes(): Routes {
  const family = [
    ...fixture<unknown[]>("members.disclosed_at_area.json"),
    ...fixture<unknown[]>("members.sharing_off.json"),
  ];
  const skate = [...fixture<unknown[]>("members.stale.json")];
  const consent = [
    ...fixture<unknown[]>("members.disclosed_away.json"),
    ...fixture<unknown[]>("members.sharing_off.json"),
  ];
  const friends = [...fixture<unknown[]>("members.consent_off.json")];
  const event = [...fixture<unknown[]>("members.ghost.json")];
  const park = [...fixture<unknown[]>("members.ghost_join.public_group.json")];
  const gym = [...fixture<unknown[]>("members.disclosed_away.public_group.json")];
  return {
    "/groups": { status: 200, body: fixture("groups.json") },
    [`/groups/${FAMILY}/members`]: { status: 200, body: family },
    // Family's counts are the Skateboard group's captured undisclosed counts:
    // the Skatepark row (1/0/1) matches Family's roster above, Newman at the
    // Skatepark and one of the withheld two inside it; Safeway is a real 0.
    [`/groups/${FAMILY}/area-counts`]: { status: 200, body: fixture("area_counts.skateboard.undisclosed.json") },
    [`/groups/${SKATE}/members`]: { status: 200, body: skate },
    [`/groups/${SKATE}/area-counts`]: { status: 200, body: fixture("area_counts.skateboard.stale.json") },
    [`/groups/${CONSENT}/members`]: { status: 200, body: consent },
    [`/groups/${CONSENT}/area-counts`]: { status: 200, body: fixture("area_counts.consent_test_group.json") },
    [`/groups/${FRIENDS}/members`]: { status: 200, body: friends },
    [`/groups/${EVENT}/members`]: { status: 200, body: event },
    [`/groups/${EVENT}/area-counts`]: { status: 200, body: [] },
    [`/groups/${FRIENDS}/area-counts`]: { status: 200, body: [] },
    [`/groups/${PUBLIC}/members`]: { status: 200, body: park },
    [`/groups/${PUBLIC}/area-counts`]: { status: 200, body: fixture("area_counts.public_group.json") },
    [`/groups/${GYM}/members`]: { status: 200, body: gym },
  };
}

// An in-process fetch that serves the route table and records every call,
// so tests can assert what was (and was not) requested.
export function fakeFetch(routes: Routes, calls: string[] = []): { fetch: typeof fetch; calls: string[] } {
  const f: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(path);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer pg_live_")) {
      return new Response(JSON.stringify({ error: "authentication required" }), { status: 401 });
    }
    const r = routes[path];
    const route = typeof r === "function" ? r() : r;
    if (!route) {
      // A listed group with no fake route answers empty, so the captured
      // eight-group list works without a route per group; anything else 404s.
      const m = /^\/groups\/([^/]+)\/(members|area-counts)$/.exec(path);
      const listed = (routes["/groups"] as Route | undefined)?.body as { id: string }[] | undefined;
      if (m && listed?.some((g) => g.id === m[1])) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "group not found" }), { status: 404 });
    }
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch: f, calls };
}

// The same fake over a real TCP listener, for the transport tests that spawn
// the built server as a child process.
export function fakeApiServer(routes: Routes): Promise<{ baseUrl: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const { fetch: f } = fakeFetch(routes, calls);
  const srv: Server = createServer(async (req, res) => {
    const r = await f(`http://x${req.url}`, { headers: { authorization: req.headers.authorization ?? "" } });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
        calls,
        close: () =>
          new Promise((r) => {
            srv.closeAllConnections();
            srv.close(() => r());
          }),
      });
    });
  });
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m) => lines.push(`INFO ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    },
  };
}
