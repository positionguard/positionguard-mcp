// Prints redacted copies of the three responses this server reads, for
// test/fixtures. Run against api02 with a synthetic test group, never
// against production data.
//
//   POSITIONGUARD_API_KEY=pg_live_… POSITIONGUARD_API_BASE=http://api02:8080/api/v1 \
//     npm run capture -- <group_id>
//
// Redaction: every UUID becomes 00000000-0000-4000-8000-<12 hex chars of
// its SHA-256>, so the same member or area gets the same placeholder in
// every capture and fixtures for different states line up; avatar_url is
// dropped. Nicknames are kept — they are what the tests match on — so use a
// group whose members are synthetic.
// Nothing here writes a file: read the output, decide which state it
// captures, and save it under the name test/fixtures/README.md gives it.

import { createHash } from "node:crypto";

const key = process.env.POSITIONGUARD_API_KEY;
const base = (process.env.POSITIONGUARD_API_BASE ?? "https://api.positionguardai.com/api/v1").replace(/\/+$/, "");
const groupId = process.argv[2];
if (!key || !key.startsWith("pg_live_") || !groupId) {
  process.stderr.write("usage: POSITIONGUARD_API_KEY=pg_live_… npm run capture -- <group_id>\n");
  process.exit(2);
}

function redactId(id: string): string {
  return `00000000-0000-4000-8000-${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 12)}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "avatar_url") continue;
      out[k] = typeof val === "string" && UUID.test(val) ? redactId(val) : redact(val);
    }
    return out;
  }
  return v;
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const paths = ["/groups", `/groups/${groupId}/members`, `/groups/${groupId}/area-counts`];
for (const p of paths) {
  const body = await get(p);
  process.stdout.write(`\n# GET ${p.replace(groupId, redactId(groupId))}\n${JSON.stringify(redact(body), null, 2)}\n`);
}
