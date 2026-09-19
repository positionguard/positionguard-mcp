import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultRoutes, fakeApiServer, FAMILY, type Routes } from "./helpers.js";

// End-to-end over the built server (dist/index.js): a fake PositionGuard API
// on localhost, the real process, and the SDK's own clients for each of the
// three transports. `npm test` builds first.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
const KEY = "pg_live_0123456789abcdef0123456789abcdef";

interface Started {
  proc: ChildProcess;
  port: number;
  stderr: string[];
  stop: () => Promise<void>;
}

function startHttpServer(apiBase: string, env: Record<string, string> = {}): Promise<Started> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    const proc = spawn(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH ?? "",
        POSITIONGUARD_API_KEY: KEY,
        POSITIONGUARD_API_BASE: apiBase,
        TRANSPORT: "http",
        HOST: "127.0.0.1",
        PORT: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout!.on("data", (d) => stderr.push(`STDOUT ${d}`)); // must stay empty for http too
    proc.stderr!.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        stderr.push(line);
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
        if (m) {
          resolve({
            proc,
            port: Number(m[1]),
            stderr,
            stop: () =>
              new Promise((r) => {
                proc.once("exit", () => r());
                proc.kill("SIGTERM");
              }),
          });
        }
      }
    });
    proc.once("exit", (code) => reject(new Error(`server exited early (${code}):\n${stderr.join("\n")}`)));
  });
}

async function callAll(client: Client): Promise<void> {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["count_members_at_area", "list_areas", "list_groups", "where_is_member", "who_is_at_area"],
  );
  const where = tools.tools.find((t) => t.name === "where_is_member")!;
  assert.match(where.description!, /`unknown` means you don't know; it does not mean they're away\./);
  // A last-known answer is relayed with its age, never as current presence.
  for (const name of ["where_is_member", "who_is_at_area"]) {
    const d = tools.tools.find((t) => t.name === name)!.description!;
    assert.match(d, /must be relayed with its age .* never as where they are now\./, name);
  }
  assert.match(where.description!, /`since` is when they entered the area/);
  assert.match(tools.tools.find((t) => t.name === "count_members_at_area")!.description!, /not recently confirmed/);
  assert.equal(where.annotations?.readOnlyHint, true);

  const r1 = await client.callTool({ name: "where_is_member", arguments: { nickname: "John" } });
  const t1 = (r1.content as { type: string; text: string }[])[0]!.text;
  assert.deepEqual(JSON.parse(t1), { status: "unknown", reason: "not_disclosed", nickname: "John" });

  const r2 = await client.callTool({ name: "count_members_at_area", arguments: { area_name: "Skatepark", group_id: FAMILY } });
  const t2 = JSON.parse((r2.content as { type: string; text: string }[])[0]!.text);
  assert.equal(t2.status, "ok");
  assert.equal(t2.member_count, 1);
  assert.equal(t2.undisclosed_count, 1);

  const r3 = await client.callTool({ name: "who_is_at_area", arguments: {} });
  assert.equal(r3.isError, true);
  assert.match((r3.content as { type: string; text: string }[])[0]!.text, /Provide area_id or area_name/);
}

test("refuses an unknown TRANSPORT", async () => {
  const api = await fakeApiServer(defaultRoutes());
  try {
    await assert.rejects(startHttpServer(api.baseUrl, { TRANSPORT: "websocket" }), /TRANSPORT must be/);
  } finally {
    await api.close();
  }
});

test("refuses to start without a pg_live_ key", async () => {
  const api = await fakeApiServer(defaultRoutes());
  try {
    await assert.rejects(startHttpServer(api.baseUrl, { POSITIONGUARD_API_KEY: "sk-nope" }), /must start with "pg_live_"/);
  } finally {
    await api.close();
  }
});

test("exits with a clear message when the key is rejected at startup", async () => {
  const routes: Routes = { "/groups": { status: 401, body: { error: "authentication required" } } };
  const api = await fakeApiServer(routes);
  try {
    await assert.rejects(startHttpServer(api.baseUrl), /rejected the API key \(HTTP 401\)[\s\S]*Assistant \(agent-type\) key/);
  } finally {
    await api.close();
  }
});

test("streamable HTTP at /mcp", async () => {
  const api = await fakeApiServer(defaultRoutes());
  const srv = await startHttpServer(api.baseUrl);
  try {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
    await callAll(client);
    await client.close();

    // The startup line shows 16 characters of the key and nothing more.
    assert.ok(srv.stderr.some((l) => l.includes(`key ${KEY.slice(0, 16)}…`)));
    for (const l of srv.stderr) {
      assert.ok(!l.includes(KEY), l);
      assert.ok(!l.startsWith("STDOUT"), l);
      for (const n of ["John", "Newman", "Skatepark"]) assert.ok(!l.includes(n), l);
    }
  } finally {
    await srv.stop();
    await api.close();
  }
});

test("SSE at /sse with the back-channel at /messages", async () => {
  const api = await fakeApiServer(defaultRoutes());
  const srv = await startHttpServer(api.baseUrl);
  try {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${srv.port}/sse`)));
    await callAll(client);
    await client.close();
  } finally {
    await srv.stop();
    await api.close();
  }
});

test("healthz and 404", async () => {
  const api = await fakeApiServer(defaultRoutes());
  const srv = await startHttpServer(api.baseUrl);
  try {
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true });
    const n = await fetch(`http://127.0.0.1:${srv.port}/nope`);
    assert.equal(n.status, 404);
    const m = await fetch(`http://127.0.0.1:${srv.port}/messages?sessionId=x`, { method: "POST", body: "{}" });
    assert.equal(m.status, 404);
  } finally {
    await srv.stop();
    await api.close();
  }
});

test("stdio", async () => {
  const api = await fakeApiServer(defaultRoutes());
  try {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH ?? "",
        POSITIONGUARD_API_KEY: KEY,
        POSITIONGUARD_API_BASE: api.baseUrl,
        TRANSPORT: "stdio",
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    await callAll(client);
    await client.close();
  } finally {
    await api.close();
  }
});
