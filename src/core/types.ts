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
  last_update?: string; // RFC 3339; when the member entered current_area
  sharing_disabled?: boolean; // integration keys only; withheld from agent keys
  safety_status?: "at_area" | "in_zone" | "out_of_zone" | "stale" | string;
  safety_area?: string;
  position_age_seconds?: number;
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
