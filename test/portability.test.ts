import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/core must stay runnable in a Cloudflare Worker: no Node built-ins, no
// process, no filesystem. fetch and AbortSignal are web standards.
const core = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core");

test("src/core imports nothing Node-only", () => {
  for (const f of readdirSync(core)) {
    const src = readFileSync(join(core, f), "utf8");
    assert.doesNotMatch(src, /from\s+["']node:/, `${f} imports a node: module`);
    assert.doesNotMatch(src, /require\(/, `${f} uses require`);
    assert.doesNotMatch(src, /\bprocess\./, `${f} touches process`);
    assert.doesNotMatch(src, /from\s+["']\.\.\/transports/, `${f} imports a transport`);
  }
});

test("src/core never spells the geometry endpoint as a request path", () => {
  for (const f of readdirSync(core)) {
    const src = readFileSync(join(core, f), "utf8");
    // The only occurrences allowed are the guard regex and comments.
    const hits = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => /`[^`]*\/areas`|"[^"]*\/areas"/.test(l));
    assert.deepEqual(hits, [], `${f}: ${hits.join(" | ")}`);
  }
});
