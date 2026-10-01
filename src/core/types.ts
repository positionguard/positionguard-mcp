// Wire shapes of the three PositionGuard REST endpoints this server calls,
// as rendered by the API's `memberResp`, `groupResp` and `areaCountResp`
// DTOs. Optional fields are `omitempty` on the wire: absent, never null.

export interface WireGroup {
  id: string;
  name: string;
  description?: string;
  icon: string;
  group_type: string; // "private" | "public" | ...
  always_share_location: boolean;
}

export interface WireAreaBrief {
  id: string;
  name: string;
}

// One entry of a roster row's `inside_areas`. The /presence entry shape,
// {area_id, area_name} — not current_area's {id, name}.
export interface WireInsideArea {
  area_id: string;
  area_name: string;
}

// One roster row from GET /groups/{id}/members.
//
// The load-bearing fact for this server: an agent-type key receives, for any
// member it may not see, exactly `user_id`, `nickname`, `avatar_url` and
// `inside: false` — nothing else. Consent off, global Ghost and sharing off
// render identically (all three captured in test/fixtures). That shape is
// `unknown`; see mapping.ts. Public-group join modes are applied by the API
// before the roster is rendered: a Ghost-joined member has no row at all, an
// anonymous-join member is listed as "Anonymous" without avatar_url.
export interface WireMember {
  user_id: string;
  nickname?: string;
  avatar_url?: string;
  inside: boolean;
  current_area?: WireAreaBrief;
  // Every area of this group the member is inside, innermost first
  // (ascending radius). Since backend e173e0f; an older server never sends
  // it. Absent, never empty, on a row inside nothing. current_area is one of
  // its entries but not necessarily the first: it is the newest state row,
  // which for nested areas entered together can be the outer one. Each entry
  // is gated on its own, so an agent key can receive a partial list with
  // nothing marking the omission: an area missing from it is not evidence
  // the member is outside that area.
  inside_areas?: WireInsideArea[];
  last_update?: string; // RFC 3339; when the member entered current_area
  sharing_disabled?: boolean; // integration keys only; withheld from agent keys
  safety_status?: "at_area" | "in_zone" | "out_of_zone" | "fresh" | "stale" | string;
  safety_area?: string;
  position_age_seconds?: number;
  // Sent beside safety_status by servers that hold at_area through a
  // phone's silence (SAFETY_STATUS_AREA_HOLD). false = the status rests on a
  // position older than the stale window. Older servers never send it.
  position_fresh?: boolean;
}

// One entry from GET /groups/{id}/area-counts. Coordinate-free by contract.
// The three counts share one tri-state: all present (integers), or all
// absent (archived area, or the count could not be computed). Absent is
// never zero. Public groups are served counts too (since backend commits
// ea6d8af..6a29048, 2026-09-07); before that they got the absent shape.
export interface WireAreaCount {
  area_id: string;
  area_name: string;
  member_count?: number;
  stale_count?: number;
  undisclosed_count?: number;
}
