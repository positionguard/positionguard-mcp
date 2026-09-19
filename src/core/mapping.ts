import type { WireMember } from "./types.js";

// The status vocabulary every tool answers in.
//
//   at_area             — the API says the member is inside this area, now.
//   last_known_at_area  — the member was last confirmed inside this area, but
//                         that position is older than the stale window and
//                         nothing newer has arrived (the server's area hold).
//                         It is a last-known place with an age, never a
//                         statement about now.
//   not_at_area         — the API disclosed the member's presence and it is
//                         not inside any area of the group asked about.
//   unknown             — everything else. The API withheld the member's
//                         presence (they have not opted in to assistant
//                         access, or sharing is paused, or global Ghost is
//                         on), or their last report is too old to vouch for.
//                         `unknown` is not evidence of absence.
//
// `since` on either area status is when the member ENTERED the area, not
// when their position was last confirmed.
export type MemberStatus =
  | {
      status: "at_area";
      area: { area_id: string; name: string };
      since?: string;
      position_fresh?: true;
      position_age_seconds?: number;
    }
  | {
      status: "last_known_at_area";
      area: { area_id: string; name: string };
      since?: string;
      position_fresh: false;
      last_confirmed_seconds_ago: number;
      note: string;
    }
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
// 3. Inside with an area is at_area — unless `position_fresh` is false.
//    That is the server's area hold: safety_status stays "at_area" through a
//    phone's silence, with the true age beside it. It becomes
//    last_known_at_area, carrying that age, so no answer states it as now.
//    `position_fresh` absent (an older server) means exactly today's rule.
// 4. Not inside is not_at_area only if the row carries something the API
//    would have withheld from a non-disclosed subject. The withheld row is
//    identity + `inside: false` and nothing else; a disclosed-away row
//    additionally carries a safety block. If the deployment has the safety
//    surface off, a disclosed-away member is indistinguishable from a
//    withheld one on the wire, and this function returns unknown — the
//    conservative direction. It never returns not_at_area for a row the API
//    could have produced by withholding. A held row that is not inside this
//    group's areas is a stale position too: unknown/stale, exactly what the
//    same row said before the hold existed.
// 5. Anything else is unknown.
export function memberStatus(row: WireMember): MemberStatus {
  if (row.sharing_disabled === true) {
    return { status: "unknown", reason: "not_disclosed" };
  }
  if (row.safety_status === "stale") {
    return { status: "unknown", reason: "stale" };
  }
  if (row.inside === true && row.current_area) {
    const area = { area_id: row.current_area.id, name: row.current_area.name };
    if (row.position_fresh === false) {
      // A held at_area always carries its age; without one there is nothing
      // to say "last confirmed N ago" with, so it is plain stale.
      if (row.position_age_seconds === undefined) {
        return { status: "unknown", reason: "stale" };
      }
      const age = row.position_age_seconds;
      const held: MemberStatus = {
        status: "last_known_at_area",
        area,
        position_fresh: false,
        last_confirmed_seconds_ago: age,
        note:
          `Last confirmed at ${area.name} ${formatAge(age)} ago; no newer position. ` +
          "Relay this as their last known place with its age, not as where they are now." +
          (row.last_update !== undefined ? " `since` is when they entered the area, not when they were last confirmed." : ""),
      };
      if (row.last_update !== undefined) held.since = row.last_update;
      return held;
    }
    const out: MemberStatus = { status: "at_area", area };
    if (row.last_update !== undefined) out.since = row.last_update;
    if (row.position_fresh === true) {
      out.position_fresh = true;
      if (row.position_age_seconds !== undefined) out.position_age_seconds = row.position_age_seconds;
    }
    return out;
  }
  if (row.inside === false && carriesDisclosedFields(row)) {
    if (row.position_fresh === false) {
      return { status: "unknown", reason: "stale" };
    }
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

// "10 h", "25 min", "3 days": coarse on purpose. The exact seconds ride
// beside it for anyone who wants them.
export function formatAge(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${Math.max(min, 1)} min`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} h`;
  return `${Math.round(seconds / 86400)} days`;
}

// Precedence when the same member appears in several groups (used when the
// caller did not name a group). A member is one person with one location;
// each group's row views it through that group's areas. An at_area row is a
// positive fact and wins. A last_known_at_area row is the next best thing
// the server has — a place with an age — and beats a disclosed negative. A
// not_at_area row is a disclosed negative for that group's areas and beats
// unknown — safely, because the API withholds the disclosed fields from
// every group's row when the member's actual place is one they hid from
// assistants (attachSafety drops the block on a withheld match), so a
// not_at_area row never coexists with a hidden at_area.
export function mergeStatuses(statuses: MemberStatus[]): MemberStatus {
  const at = statuses.find((s) => s.status === "at_area");
  if (at) return at;
  const held = statuses.find((s) => s.status === "last_known_at_area");
  if (held) return held;
  const away = statuses.find((s) => s.status === "not_at_area");
  if (away) return away;
  const stale = statuses.find((s) => s.status === "unknown" && s.reason === "stale");
  if (stale) return stale;
  return { status: "unknown", reason: "not_disclosed" };
}
