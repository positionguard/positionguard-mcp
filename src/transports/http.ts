import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../core/log.js";

export interface HttpOptions {
  host: string;
  port: number;
  createServer: () => McpServer;
  log: Logger;
}

// Two MCP transports on one listener, no auth (v1 runs on a private docker
// network or localhost; the README says not to expose it):
//
//   POST/GET/DELETE /mcp   Streamable HTTP, stateless. Open WebUI. A fresh
//                          McpServer + transport per request; nothing is
//                          kept between requests because nothing needs to be.
//   GET  /sse              SSE. Home Assistant's `mcp` integration. One
//                          McpServer per connection, kept for its life so the
//                          client's POSTs to /messages can be routed back.
//   POST /messages?sessionId=…   the SSE back-channel.
//   GET  /healthz          200 {"ok":true}. For docker healthchecks.
export function startHttp(opts: HttpOptions): Promise<void> {
  const { host, port, createServer, log } = opts;
  const sseSessions = new Map<string, SSEServerTransport>();

  const listener = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    try {
      if (path === "/mcp") {
        await handleStreamable(req, res, createServer, log);
      } else if (path === "/sse" && req.method === "GET") {
        await openSse(res, createServer, sseSessions, log);
      } else if (path === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const transport = sseSessions.get(sessionId);
        if (!transport) {
          json(res, 404, { error: "unknown SSE session" });
          return;
        }
        await transport.handlePostMessage(req, res);
      } else if (path === "/healthz" && req.method === "GET") {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      log.error(`${req.method} ${path} -> handler failed (${err instanceof Error ? err.name : "error"})`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => {
      const addr = listener.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      log.info(`listening on http://${host}:${bound}  (streamable HTTP at /mcp, SSE at /sse)`);
      resolve();
    });
  });
}

async function handleStreamable(
  req: IncomingMessage,
  res: ServerResponse,
  createServer: () => McpServer,
  log: Logger,
): Promise<void> {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
  log.info(`${req.method} /mcp -> ${res.statusCode}`);
}

async function openSse(
  res: ServerResponse,
  createServer: () => McpServer,
  sessions: Map<string, SSEServerTransport>,
  log: Logger,
): Promise<void> {
  const server = createServer();
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);
  transport.onclose = () => {
    sessions.delete(transport.sessionId);
    void server.close();
    log.info(`GET /sse -> closed (${sessions.size} open)`);
  };
  await server.connect(transport); // calls transport.start(), which writes the endpoint event
  log.info(`GET /sse -> open (${sessions.size} open)`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
