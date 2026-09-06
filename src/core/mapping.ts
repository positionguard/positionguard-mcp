import type { WireMember } from "./types.js";

// The status vocabulary every tool answers in.
//
//   at_area      — the API says the member is inside this area, now.
//   not_at_area  — the API disclosed the member's presence and it is not
//                  inside any area of the group asked about.
//   unknown      — everything else. The API withheld the member's presence
//                  (they have not opted in to assistant access, or Ghost or
//                  sharing-off is on), or their last report is too old to
//                  vouch for. `unknown` is not evidence of absence.
export type MemberStatus =
  | { status: "at_area"; area: { area_id: string; name: string }; since?: string }
  | { status: "not_at_area" }
  | { status: "unknown"; reason: "not_disclosed" | "stale" };

// Maps one roster row to a status. Written against the API's memberResp
// rendering (internal/rest/rest.go in PositionGuard-API) and tested against
// captured responses in test/fixtures before any model sees it.
//
// The order is the argument:
//
// 1. A suppression the API chose to name (`sharing_disabled`, only ever sent
//    to integration keys) is unknown, not away. Someone who paused sharing
//    has a location; we were not told it.
// 2. `safety_status: "stale"` is unknown even when `current_area` is still
//    on the row. The row is the last state the server confirmed; the
//    architecture rule is "never a stale last-known value". Counts still
//    include stale members and say so via stale_count — a floor may carry
//    them, an individual answer may not.
// 3. Inside with an area is at_area.
// 4. Not inside is not_at_area only if the row carries something the API
//    would have withheld from a non-disclosed subject. The withheld row is
//    identity + `inside: false` and nothing else; a disclosed-away row
//    additionally carries a safety block. If the deployment has the safety
//    surface off, a disclosed-away member is indistinguishable from a
//    withheld one on the wire, and this function returns unknown — the
//    conservative direction. It never returns not_at_area for a row the API
//    could have produced by withholding.
// 5. Anything else is unknown.
export function memberStatus(row: WireMember): MemberStatus {
  if (row.sharing_disabled === true) {
    return { status: "unknown", reason: "not_disclosed" };
  }
  if (row.safety_status === "stale") {
    return { status: "unknown", reason: "stale" };
  }
  if (row.inside === true && row.current_area) {
    const out: MemberStatus = {
      status: "at_area",
      area: { area_id: row.current_area.id, name: row.current_area.name },
    };
    if (row.last_update !== undefined) out.since = row.last_update;
    return out;
  }
  if (row.inside === false && carriesDisclosedFields(row)) {
    return { status: "not_at_area" };
  }
  return { status: "unknown", reason: "not_disclosed" };
}

// True when the row has any field beyond the withheld shape
// (user_id, nickname, avatar_url, inside).
function carriesDisclosedFields(row: WireMember): boolean {
  return (
    row.last_update !== undefined ||
    row.safety_status !== undefined ||
    row.safety_area !== undefined ||
    row.position_age_seconds !== undefined
  );
}

// Precedence when the same member appears in several groups (used when the
// caller did not name a group). A member is one person with one location;
// each group's row views it through that group's areas. An at_area row is a
// positive fact and wins. A not_at_area row is a disclosed negative for that
// group's areas and beats unknown — safely, because the API withholds the
// disclosed fields from every group's row when the member's actual place is
// one they hid from assistants (attachSafety drops the block on a withheld
// match), so a not_at_area row never coexists with a hidden at_area.
export function mergeStatuses(statuses: MemberStatus[]): MemberStatus {
  const at = statuses.find((s) => s.status === "at_area");
  if (at) return at;
  const away = statuses.find((s) => s.status === "not_at_area");
  if (away) return away;
  const stale = statuses.find((s) => s.status === "unknown" && s.reason === "stale");
  if (stale) return stale;
  return { status: "unknown", reason: "not_disclosed" };
}
