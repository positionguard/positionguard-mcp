#!/usr/bin/env node
import { createRequire } from "node:module";
import { ApiError, PositionGuardClient } from "./core/client.js";
import { checkApiKey, DEFAULT_API_BASE, keyDisplayPrefix } from "./core/config.js";
import type { Logger } from "./core/log.js";
import { createServer } from "./core/server.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

// env → core → transport. This file is the only place that reads process.env
// or exits; core/ stays free of both so it can run in a Worker unchanged.

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// stderr for everything: under TRANSPORT=stdio, stdout belongs to the
// protocol. One line per event, no bodies, no key, no member names.
const log: Logger = {
  info: (m) => process.stderr.write(`${stamp()} INFO  ${m}\n`),
  warn: (m) => process.stderr.write(`${stamp()} WARN  ${m}\n`),
  error: (m) => process.stderr.write(`${stamp()} ERROR ${m}\n`),
};
function stamp(): string {
  return new Date().toISOString();
}

// Refusing to start: log, set the exit code, and return so the event loop
// drains. process.exit() right after a stderr write can drop the line on
// platforms where pipes are asynchronous (macOS), and the one line that
// says why the container died is the one worth keeping.
function refuse(...lines: string[]): void {
  for (const l of lines) log.error(l);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const apiKey = process.env.POSITIONGUARD_API_KEY;
  const keyCheck = checkApiKey(apiKey);
  if (!keyCheck.ok) {
    return refuse(keyCheck.reason);
  }
  const baseUrl = process.env.POSITIONGUARD_API_BASE || DEFAULT_API_BASE;
  const transport = (process.env.TRANSPORT || "http").toLowerCase();
  if (transport !== "http" && transport !== "stdio") {
    return refuse(`TRANSPORT must be "http" or "stdio", got "${transport}".`);
  }

  const client = new PositionGuardClient({
    apiKey: apiKey!,
    baseUrl,
    log,
    userAgent: `positionguard-mcp/${version}`,
  });

  log.info(`positionguard-mcp ${version}; key ${keyDisplayPrefix(apiKey!)}…; api ${baseUrl}`);

  // Startup check: one GET /groups. A rejected key is a configuration
  // error and the process should not sit there looking healthy. Anything
  // else (the API being briefly unreachable) is not: every tool call
  // re-checks, so start and let the log say what happened.
  try {
    const groups = await client.listGroups();
    if (groups.length === 0) {
      log.warn("the key's owner is in no groups; every tool will answer with empty lists");
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return refuse(
        `startup check failed: ${err.message}`,
        "Use an Assistant (agent-type) key with presence:read, counts:read and groups:read.",
      );
    }
    log.warn(`startup check could not reach the API (${err instanceof Error ? err.message : "error"}); continuing`);
  }

  const factory = () => createServer({ client, log, version });

  if (transport === "stdio") {
    await startStdio(factory, log);
    return;
  }

  const port = Number(process.env.PORT || 8788);
  const host = process.env.HOST || "0.0.0.0";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return refuse(`PORT must be a TCP port number, got "${process.env.PORT}".`);
  }
  await startHttp({ host, port, createServer: factory, log });
}

main().catch((err) => {
  refuse(`fatal: ${err instanceof Error ? err.message : String(err)}`);
});
