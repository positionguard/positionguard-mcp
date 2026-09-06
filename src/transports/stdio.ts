import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../core/log.js";

// stdio: one client, one connection, for the life of the process. Claude
// Desktop and similar launchers. stdout is the protocol channel, so the
// logger given to the core must write to stderr — see index.ts.
export async function startStdio(createServer: () => McpServer, log: Logger): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("stdio transport connected");
}
