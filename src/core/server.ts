import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, type PositionGuardClient } from "./client.js";
import type { Logger } from "./log.js";
import { countMembersAtArea, listAreas, listGroups, whereIsMember, whoIsAtArea } from "./tools.js";

export interface ServerDeps {
  client: PositionGuardClient;
  log: Logger;
  version: string;
}

// The tool descriptions below are product surface: they are what the model
// reads, and they carry the one distinction this server exists to make.
// If a model ever turns `unknown` into "away", the fix is here, not in
// anyone's prompt.
const UNKNOWN_RULE =
  "`unknown` means you don't know; it does not mean they're away. Say so. " +
  "Never present an unknown as an absence, and never guess a location.";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// Builds one McpServer with the five tools registered. The SDK binds a
// server instance to exactly one transport, so each transport calls this
// once per connection (per request, for stateless HTTP). It is cheap: the
// tools close over the shared client, and hold no state of their own.
export function createServer(deps: ServerDeps): McpServer {
  const { client, log } = deps;
  const server = new McpServer(
    { name: "positionguard-mcp", version: deps.version },
    {
      instructions:
        "PositionGuard answers questions about which members of the key holder's groups are at " +
        "named areas (home, school, the club), never coordinates. Members choose whether " +
        "assistants may see them. A `status` of `unknown` means the member has not made their " +
        "presence visible to assistants, or their last report is too old: it is not evidence " +
        "that they are away. Counts are floors when undisclosed_count or stale_count is non-zero.",
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "Lists the PositionGuard groups the key holder belongs to, with their IDs. " +
        "Call this first when you need a group_id for another tool, or when asked what " +
        "groups exist. Returns {status: \"ok\", groups: [{group_id, name, group_type}]}.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => run("list_groups", log, () => listGroups(client)),
  );

  server.registerTool(
    "list_areas",
    {
      title: "List areas",
      description:
        "Lists the named areas (places) of a group, or of every group when group_id is " +
        "omitted. Names and IDs only: no coordinates, no counts. Use count_members_at_area " +
        "for how many people are at an area. " +
        "Returns {status: \"ok\", areas: [{area_id, name, group_id, group_name}]}.",
      inputSchema: {
        group_id: z.string().optional().describe("Group ID from list_groups. Omit to list every group's areas."),
      },
      annotations: READ_ONLY,
    },
    (args) => run("list_areas", log, () => listAreas(client, args)),
  );

  server.registerTool(
    "where_is_member",
    {
      title: "Where is a member",
      description:
        "Reports whether one member is currently at a named area. Looks the member up by " +
        "nickname (case-insensitive) in the given group, or in every group when group_id is " +
        "omitted. Returns one of:\n" +
        "  {status: \"at_area\", area: {area_id, name}, since}  — they are at that area now;\n" +
        "  {status: \"not_at_area\"}  — their presence is shared with assistants and they are not at any of the group's areas;\n" +
        "  {status: \"unknown\", reason}  — see below.\n" +
        "Returns `unknown` when the member hasn't shared their presence with assistants, or " +
        "their location is stale (reason \"not_disclosed\" or \"stale\"), and with reason " +
        "\"no_such_member\" when no member has that nickname — do not invent one. " +
        UNKNOWN_RULE,
      inputSchema: {
        nickname: z.string().min(1).describe("The member's nickname as shown in PositionGuard."),
        group_id: z.string().optional().describe("Restrict the search to one group. Omit to search every group."),
      },
      annotations: READ_ONLY,
    },
    (args) => run("where_is_member", log, () => whereIsMember(client, args)),
  );

  server.registerTool(
    "who_is_at_area",
    {
      title: "Who is at an area",
      description:
        "Lists the members currently at one area, by area_id or area_name, in one group or " +
        "across every group when group_id is omitted. Lists only members who've chosen to be " +
        "visible to assistants. If `undisclosed_note` is present, others may be there too: " +
        "report the list as \"confirmed here\", not as everyone. " +
        "Returns {status: \"ok\", area, group_id, group_name, members: [nickname…], " +
        "undisclosed_note?} or {status: \"unknown\", reason: \"no_such_area\"}.",
      inputSchema: {
        area_id: z.string().optional().describe("Area ID from list_areas. Preferred when known."),
        area_name: z.string().optional().describe("Area name, case-insensitive. Used when area_id is omitted."),
        group_id: z.string().optional().describe("Restrict to one group. Omit to search every group."),
      },
      annotations: READ_ONLY,
    },
    (args) => run("who_is_at_area", log, () => whoIsAtArea(client, args)),
  );

  server.registerTool(
    "count_members_at_area",
    {
      title: "Count members at an area",
      description:
        "Counts how many members are at one area, without identities. Find the area by " +
        "area_id or area_name, in one group or across every group when group_id is omitted. " +
        "Returns {status: \"ok\", area, group_id, group_name, member_count, stale_count, " +
        "undisclosed_count, note}. `member_count` is a floor: `undisclosed_count` members are " +
        "at the area but chose not to be visible to assistants, and `stale_count` haven't " +
        "reported recently. Report the count as 'at least N' when either is non-zero. " +
        "When the API provides no count (reason \"count_unavailable\") the answer is unknown, " +
        "not zero.",
      inputSchema: {
        area_id: z.string().optional().describe("Area ID from list_areas. Preferred when known."),
        area_name: z.string().optional().describe("Area name, case-insensitive. Used when area_id is omitted."),
        group_id: z.string().optional().describe("Restrict to one group. Omit to search every group."),
      },
      annotations: READ_ONLY,
    },
    (args) => run("count_members_at_area", log, () => countMembersAtArea(client, args)),
  );

  return server;
}

// Runs one tool and renders its answer. The answer is JSON text — the most
// portable content type across MCP clients (HA's client, Open WebUI and
// Claude Desktop all read it). An ApiError becomes an MCP tool error with
// the API's status in one sentence; anything else is reported as a server
// error without its message, which could carry a body fragment.
async function run(
  tool: string,
  log: Logger,
  fn: () => Promise<{ status: string; reason?: string }>,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    log.info(`tool ${tool} -> ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof ApiError) {
      log.warn(`tool ${tool} -> api error ${err.status}`);
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    if (err instanceof Error && err.message.startsWith("Provide ")) {
      // Argument problem raised by the tool itself; safe to relay verbatim.
      log.warn(`tool ${tool} -> bad arguments`);
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    log.error(`tool ${tool} -> failed (${err instanceof Error ? err.name : "error"})`);
    return { isError: true, content: [{ type: "text", text: "positionguard-mcp failed to answer; see server log." }] };
  }
}
