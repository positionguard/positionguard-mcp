import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../src/core/log.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as T;
}

// Group IDs from fixtures/groups.json.
export const FAMILY = "00000000-0000-4000-8000-0000000000a1";
export const SKATE = "00000000-0000-4000-8000-0000000000a2";
export const PUBLIC = "00000000-0000-4000-8000-0000000000a3";
export const SKATEPARK = "00000000-0000-4000-8000-0000000000b1";

// A route table for a fake PositionGuard API: path → status + body, or a
// function for stateful behaviour. Paths are relative to /api/v1.
export type Route = { status: number; body?: unknown; headers?: Record<string, string> };
export type Routes = Record<string, Route | (() => Route)>;

// The default world: Family holds every member fixture concatenated; Skate
// Crew holds Earl again (at the Skatepark) and one withheld row; the public
// group has an area with no counts. Note that Earl appears in two groups.
export function defaultRoutes(): Routes {
  const family = [
    ...fixture<unknown[]>("members.disclosed_at_area.json"),
    ...fixture<unknown[]>("members.disclosed_away.json"),
    ...fixture<unknown[]>("members.consent_off.json"),
    ...fixture<unknown[]>("members.ghost.json"),
    ...fixture<unknown[]>("members.sharing_off.json"),
    ...fixture<unknown[]>("members.stale.json"),
  ];
  const skate = [
    ...fixture<unknown[]>("members.disclosed_at_area.json"),
    ...fixture<unknown[]>("members.consent_off.json"),
  ];
  return {
    "/groups": { status: 200, body: fixture("groups.json") },
    [`/groups/${FAMILY}/members`]: { status: 200, body: family },
    [`/groups/${FAMILY}/area-counts`]: { status: 200, body: fixture("area_counts.json") },
    [`/groups/${SKATE}/members`]: { status: 200, body: skate },
    [`/groups/${SKATE}/area-counts`]: { status: 200, body: fixture("area_counts.json") },
    [`/groups/${PUBLIC}/members`]: { status: 200, body: [] },
    [`/groups/${PUBLIC}/area-counts`]: { status: 200, body: fixture("area_counts.public_group.json") },
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
    if (!route) return new Response(JSON.stringify({ error: "group not found" }), { status: 404 });
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
