import type { PositionGuardClient } from "./client.js";
import { memberStatus, mergeStatuses, type MemberStatus } from "./mapping.js";
import type { WireAreaCount, WireGroup, WireMember } from "./types.js";

// Tool handlers: plain async functions from validated arguments to a
// JSON-serialisable answer. No transport, no MCP types, no I/O beyond the
// client. server.ts wraps them; tests call them directly.
//
// Every answer carries a `status`. "ok" means the question was answered;
// "unknown" means it was not, and `reason` says why in one word. An API
// failure is not an answer and is thrown (ApiError) for server.ts to render
// as a tool error.

// --- list_groups ---------------------------------------------------------

export interface ListGroupsResult {
  status: "ok";
  groups: { group_id: string; name: string; group_type: string }[];
}

export async function listGroups(client: PositionGuardClient): Promise<ListGroupsResult> {
  const groups = await client.listGroups();
  return {
    status: "ok",
    groups: groups.map((g) => ({ group_id: g.id, name: g.name, group_type: g.group_type })),
  };
}

// --- list_areas ----------------------------------------------------------

export interface ListAreasArgs {
  group_id?: string | undefined;
}

export interface ListAreasResult {
  status: "ok";
  areas: { area_id: string; name: string; group_id: string; group_name: string }[];
}

// Names and IDs only. The counts that ride on the same response are
// count_members_at_area's job, and geometry is never requested at all.
export async function listAreas(client: PositionGuardClient, args: ListAreasArgs): Promise<ListAreasResult> {
  const groups = await groupsToSearch(client, args.group_id);
  const areas: ListAreasResult["areas"] = [];
  for (const g of groups) {
    const counts = await client.listAreaCounts(g.id);
    for (const a of counts) {
      areas.push({ area_id: a.area_id, name: a.area_name, group_id: g.id, group_name: g.name });
    }
  }
  return { status: "ok", areas };
}

// --- where_is_member -----------------------------------------------------

export interface WhereIsMemberArgs {
  nickname: string;
  group_id?: string | undefined;
}

export type WhereIsMemberResult =
  | (MemberStatus & { nickname: string; group_id?: string; group_name?: string })
  | { status: "unknown"; reason: "no_such_member"; nickname: string };

export async function whereIsMember(
  client: PositionGuardClient,
  args: WhereIsMemberArgs,
): Promise<WhereIsMemberResult> {
  const query = args.nickname.trim();
  const groups = await groupsToSearch(client, args.group_id);

  // Every row for this nickname across the groups searched, with the group
  // it came from. Exact (case-insensitive) match first; if nothing matches
  // exactly and exactly one member's nickname contains the query, use that
  // one — a deterministic convenience for "Earl" vs "Earl L.", never a
  // guess between candidates.
  const exact: { row: WireMember; group: WireGroup }[] = [];
  const partial: { row: WireMember; group: WireGroup }[] = [];
  for (const g of groups) {
    const members = await client.listMembers(g.id);
    for (const row of members) {
      const nick = row.nickname;
      if (!nick) continue;
      if (sameName(nick, query)) exact.push({ row, group: g });
      else if (nick.toLowerCase().includes(query.toLowerCase())) partial.push({ row, group: g });
    }
  }

  let matches = exact;
  if (matches.length === 0) {
    const distinct = new Set(partial.map((m) => m.row.user_id));
    if (distinct.size === 1) matches = partial;
  }
  if (matches.length === 0) {
    return { status: "unknown", reason: "no_such_member", nickname: query };
  }

  const first = matches[0]!;
  const merged = mergeStatuses(matches.map((m) => memberStatus(m.row)));
  const out: WhereIsMemberResult = { ...merged, nickname: first.row.nickname ?? query };
  if (merged.status === "at_area" || merged.status === "last_known_at_area") {
    // Name the group whose area answered, so a follow-up who_is_at_area can
    // be asked precisely.
    const src = matches.find((m) => memberStatus(m.row).status === merged.status) ?? first;
    out.group_id = src.group.id;
    out.group_name = src.group.name;
  }
  return out;
}

// --- who_is_at_area ------------------------------------------------------

export interface AreaArgs {
  group_id?: string | undefined;
  area_id?: string | undefined;
  area_name?: string | undefined;
}

export type WhoIsAtAreaResult =
  | {
      status: "ok";
      area: { area_id: string; name: string };
      group_id: string;
      group_name: string;
      // Fresh: the server has a recent position inside this area.
      confirmed: string[];
      // Held: last confirmed inside this area, nothing newer since. Never
      // merged into `confirmed`.
      last_known: { nickname: string; last_confirmed_seconds_ago: number }[];
      // The same list as `confirmed`, kept for clients written against 0.1.0.
      members: string[];
      last_known_note?: string;
      undisclosed_note?: string;
      count_note?: string;
    }
  | { status: "unknown"; reason: "no_such_area" };

export async function whoIsAtArea(client: PositionGuardClient, args: AreaArgs): Promise<WhoIsAtAreaResult> {
  const resolved = await resolveArea(client, args);
  if (!resolved) return { status: "unknown", reason: "no_such_area" };

  const members = await client.listMembers(resolved.group.id);
  const present: string[] = [];
  const lastKnown: { nickname: string; last_confirmed_seconds_ago: number }[] = [];
  let unknownRows = 0;
  for (const row of members) {
    const s = memberStatus(row);
    if (s.status === "at_area" && s.area.area_id === resolved.area.area_id) {
      present.push(row.nickname ?? "(unnamed member)");
    } else if (s.status === "last_known_at_area" && s.area.area_id === resolved.area.area_id) {
      lastKnown.push({
        nickname: row.nickname ?? "(unnamed member)",
        last_confirmed_seconds_ago: s.last_confirmed_seconds_ago,
      });
    } else if (s.status === "unknown") {
      unknownRows++;
    }
  }

  const out: WhoIsAtAreaResult = {
    status: "ok",
    area: { area_id: resolved.area.area_id, name: resolved.area.area_name },
    group_id: resolved.group.id,
    group_name: resolved.group.name,
    confirmed: present,
    last_known: lastKnown,
    members: present,
  };
  if (lastKnown.length > 0) {
    const one = lastKnown.length === 1;
    out.last_known_note =
      `${lastKnown.length} member${one ? " was" : "s were"} last confirmed here but ` +
      `${one ? "has" : "have"} no newer position. Relay each with its age ` +
      "(last_confirmed_seconds_ago), as last known here, never as present now.";
  }
  if (unknownRows > 0) {
    out.undisclosed_note =
      `${unknownRows} member${unknownRows === 1 ? "" : "s"} of this group ` +
      `${unknownRows === 1 ? "has" : "have"} not shared presence with assistants, or ` +
      `${unknownRows === 1 ? "has" : "have"} no fresh report. Any of them may be at this area. ` +
      "This list is who is confirmed here, not everyone who is here.";
  }

  // The area's count rode along on the call that resolved the area. When it
  // exceeds the rows listed, the roster is not the whole answer and the list
  // must not be presented as one: a public group serves no row for a
  // Ghost-joined member and, above its member limit, no row but the caller's
  // own; a private group keeps a stale member's row, which is not listed.
  const counted = resolved.area.member_count;
  const listed = present.length + lastKnown.length;
  if (counted !== undefined && counted > listed) {
    out.count_note =
      `${counted} counted at this area, ${listed === 0 ? "none" : listed} listed. ` +
      "The rest are counted without being listed: they joined the group in Ghost mode, the roster " +
      "is capped, or their last report is not fresh. " +
      "Report the list as who is confirmed here, not as everyone who is here.";
  }
  return out;
}

// --- count_members_at_area -----------------------------------------------

export type CountMembersAtAreaResult =
  | {
      status: "ok";
      area: { area_id: string; name: string };
      group_id: string;
      group_name: string;
      member_count: number;
      stale_count: number;
      undisclosed_count: number;
      note: string;
    }
  | { status: "unknown"; reason: "no_such_area" }
  | {
      status: "unknown";
      reason: "count_unavailable";
      area: { area_id: string; name: string };
      group_id: string;
      group_name: string;
      note: string;
    };

export async function countMembersAtArea(
  client: PositionGuardClient,
  args: AreaArgs,
): Promise<CountMembersAtAreaResult> {
  const resolved = await resolveArea(client, args);
  if (!resolved) return { status: "unknown", reason: "no_such_area" };

  const a = resolved.area;
  const area = { area_id: a.area_id, name: a.area_name };
  const group_id = resolved.group.id;
  const group_name = resolved.group.name;

  // The three counts share one tri-state on the wire: present together or
  // absent together. Absent means the API did not produce a number — it is
  // not zero, and the answer is unknown.
  if (a.member_count === undefined || a.stale_count === undefined || a.undisclosed_count === undefined) {
    return {
      status: "unknown",
      reason: "count_unavailable",
      area,
      group_id,
      group_name,
      note:
        "PositionGuard did not provide a count for this area: it is archived, or the count " +
        "could not be computed. Do not report zero; say the count is not available.",
    };
  }

  // stale_count members are inside member_count, last confirmed here but
  // with nothing newer (the server holds them at the area). The note puts
  // the sub-count beside the count in words, so it is relayed with it.
  const floor = a.undisclosed_count > 0 || a.stale_count > 0;
  const parts: string[] = [];
  if (floor) parts.push(`member_count is a floor: report it as "at least ${a.member_count}".`);
  if (a.stale_count > 0) {
    parts.push(
      `${a.undisclosed_count > 0 ? "At least " : ""}${a.member_count} at the area, ` +
        `${a.stale_count} of them not recently confirmed: say so, and relay ` +
        `${a.stale_count === 1 ? "that one" : "those"} as last known there, not as present now.`,
    );
  }
  if (a.undisclosed_count > 0) {
    parts.push(
      `${a.undisclosed_count} member${a.undisclosed_count === 1 ? " is" : "s are"} at the area but ` +
        "chose not to be visible to assistants.",
    );
  }
  const note = floor
    ? parts.join(" ")
    : "Every member the server places at this area is disclosed and fresh; the count is exact.";

  return {
    status: "ok",
    area,
    group_id,
    group_name,
    member_count: a.member_count,
    stale_count: a.stale_count,
    undisclosed_count: a.undisclosed_count,
    note,
  };
}

// --- shared --------------------------------------------------------------

async function groupsToSearch(client: PositionGuardClient, groupId: string | undefined): Promise<WireGroup[]> {
  const groups = await client.listGroups();
  if (groupId === undefined) return groups;
  // A group ID the key's owner is not a member of is indistinguishable from a
  // nonexistent one (the API answers 404 to both). Filter here so the
  // subsequent call is never made for a group we already know is absent.
  return groups.filter((g) => g.id === groupId);
}

interface ResolvedArea {
  group: WireGroup;
  area: WireAreaCount;
}

// Finds an area by ID or by case-insensitive name, within one group or
// across all of them. First match wins in group order; the answer names the
// group so the model can see which one answered.
async function resolveArea(client: PositionGuardClient, args: AreaArgs): Promise<ResolvedArea | null> {
  const id = args.area_id?.trim();
  const name = args.area_name?.trim();
  if (!id && !name) {
    throw new Error("Provide area_id or area_name.");
  }
  const groups = await groupsToSearch(client, args.group_id);
  for (const g of groups) {
    const counts = await client.listAreaCounts(g.id);
    const hit = counts.find((a) => (id && a.area_id === id) || (name && sameName(a.area_name, name)));
    if (hit) return { group: g, area: hit };
  }
  return null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
