# Fixtures

One file per wire state the `status` mapping must get right. Each is a
response body from the public REST API (a roster file holds only the rows
of the member whose state it captures), with IDs redacted to
`00000000-0000-4000-8000-<12 hex of the ID's SHA-256>` — stable across
captures, so the same member or area has the same placeholder in every
file — and `avatar_url` dropped. Nicknames are those of synthetic api02
test accounts (Newman, Fred, John, EarlonDev, MikeL).

**Key type of the captures.** Captured files come from an **Assistant**
(agent-type) key unless the file name says `integration_key`. The wire
shows which it was: with the integration key, Fred's and John's rows carry
`sharing_disabled: true`; with the Assistant key the same two members come
back as identity + `inside: false` and nothing else, which only the agent
gate produces. Newman, the key holder, has agent access switched on and is
therefore disclosed to the Assistant key; the gate has no self-exemption
(`AgentView.Tier` in `graph/visibility.go`).

`npm test` asserts the mapping in `src/core/mapping.ts` against every file
here. That is where `unknown` is proven before any model sees the server.

| File | State | Expected status | Provenance |
|---|---|---|---|
| `groups.json` | `GET /groups`: the Newman account's nine groups, two public | — | captured 2026-09-06 (api02, Assistant key) |
| `members.disclosed_at_area.json` | Newman: consent on, inside Skatepark (Team 🛹 Skateboard) | `at_area` | captured 2026-09-06 (api02, Assistant key) |
| `members.disclosed_away.json` | Newman: consent on, sharing on, not at any area of this group; the safety block names an area of another group | `not_at_area` | captured 2026-09-06 (api02, Assistant key) |
| `members.disclosed_away.public_group.json` | EarlonDev: consent on, fresh, elsewhere, seen through the **public** Dog Park @ Marymoor, whose rosters carry no safety block beyond the stale marker (below), so a fresh away row is bare | `unknown` (conservative: byte-identical to a withheld row; a deployment with `SAFETY_STATUS_ENABLED=false` looks the same) | captured 2026-09-06 (api02, Assistant key); re-captured byte-identical 2026-09-07 through Team 425 gym, where he is a named member (his Dog Park row is now `"Anonymous"`, below) |
| `members.consent_off.json` | Newman: still inside Skatepark, sharing on, agent access switched off | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.consent_off.public_group.json` | EarlonDev: anonymous-joined, still inside Marymoor Dog Park, agent access switched off. The mask and the gate compose: the row keeps `"Anonymous"` and the placeholder ID and is otherwise the withheld shape | `unknown` | captured 2026-09-08 (api02, Assistant key) |
| `members.ghost.json` | Newman: global Ghost (`users.privacy_level = 'ghost'`, set by SQL), still inside Skatepark | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.ghost_join.public_group.json` | the whole Dog Park @ Marymoor roster after the fixes: MikeL as himself (withheld shape) and EarlonDev as `"Anonymous"` (anonymous join; same placeholder ID as his named rows; `avatar_url` absent on the raw wire where MikeL's row carried one), standing inside the park — `inside: true`, `current_area`, `last_update` beside the mask, which hides identity, not presence. Newman, Ghost-joined and inside the park at the same moment, has **no row** | Newman: no row; Anonymous `at_area`; MikeL `unknown` — see *Public-group Ghost* | captured 2026-09-08 (api02, Assistant key) |
| `members.sharing_off.json` | Fred and John: sharing paused; the gate suppresses before it reads consent | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.sharing_off.integration_key.json` | the same two members, seen by an **integration** key | `unknown` | captured 2026-09-06 (api02, integration key) |
| `members.stale.json` | Newman: consent on, still inside Skatepark, app force-stopped until his last position was older than the stale window (50 minutes on api02, per the safety-status runbook) | `unknown` (reason `stale`) | captured 2026-09-06 (api02, Assistant key) |
| `members.stale.public_group.json` | EarlonDev: anonymous-joined, consent on, still inside Marymoor Dog Park, simulator stopped until past the stale window. The masked row keeps `inside: true` and `current_area` and carries `safety_status: "stale"` with `position_age_seconds` — the public-roster staleness signal — and no `safety_area`. Before backend `825f642` this row was byte-identical to a fresh one | `unknown` (reason `stale`) | captured 2026-09-08 (api02, Assistant key) |
| `members.fresh_at_area.json` | Newman inside Skatepark, fresh, on a server that sends `position_fresh` (`true`) | `at_area` with `position_fresh` and `position_age_seconds` | **synthetic**: `members.disclosed_at_area.json` plus `position_fresh: true` |
| `members.held_at_area.json` | Newman held at "Lake House" by the area hold: `safety_status: "at_area"`, `position_fresh: false`, `position_age_seconds: 36000` | `last_known_at_area` | **synthetic**, per the REST wire contract of `SAFETY_STATUS_AREA_HOLD` (backend `internal/rest/rest.go` `memberResp`); area ID and name are placeholders |
| `members.held_away.json` | Newman held at an area that is not one of this group's: `inside: false`, `safety_status: "at_area"`, `position_fresh: false` | `unknown` (reason `stale`) | **synthetic**, same contract |
| `members.stale_away.json` | Newman stale outside any area: `inside: false`, `safety_status: "stale"`, `position_fresh: false` | `unknown` (reason `stale`) | **synthetic**, same contract |
| `members.held.public_group.json` | EarlonDev held inside Marymoor Dog Park, seen through the public group: the public narrowing turns the hold back into `"stale"` with its age and `position_fresh: false` | `unknown` (reason `stale`) | **synthetic**, per `publicGroupSafety` (backend `internal/rest/rest.go`) |
| `area_counts.held.json` | "Lake House" with the held Newman: counted, and in `stale_count` | floor, "at least 1"; "1 at the area, 1 of them not recently confirmed" | **synthetic**, placeholder area |
| `area_counts.skateboard.disclosed.json` | Team 🛹 Skateboard with two disclosed members at Skatepark | exact count | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.undisclosed.json` | same group after Newman switched agent access off: he moves from `member_count` to `undisclosed_count` | floor, "at least 1" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.stale.json` | same group with Newman stale: still in `member_count`, now also in `stale_count` | floor, "at least 2" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.ghost.json` | same group with Newman as global Ghost: gone from every bucket | exact count | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.consent_test_group.json` | private group, nobody inside: real zeros, all three fields present | exact count | captured 2026-09-06 (api02, Assistant key; byte-identical with the integration key) |
| `area_counts.public_group.json` | Dog Park @ Marymoor, a public group, same moment as the roster above: counts served, `member_count: 2` — EarlonDev, masked on the roster, and Newman, Ghost-joined and on no roster | exact count; the roster and the count deliberately disagree | captured 2026-09-08 (api02, Assistant key) |
| `area_counts.public_group.undisclosed.json` | Dog Park @ Marymoor, same moment as `members.consent_off.public_group.json`: EarlonDev moved from `member_count` to `undisclosed_count`; Newman, Ghost-joined and inside, is the one still counted | floor, "at least 1" | captured 2026-09-08 (api02, Assistant key) |
| `area_counts.public_group.stale.json` | Dog Park @ Marymoor, same moment as `members.stale.public_group.json`: EarlonDev still in `member_count`, now also in `stale_count`; Newman, Ghost-joined and still fresh, is the other | floor, "at least 2" | captured 2026-09-08 (api02, Assistant key) |
| `area_counts.public_group.withheld.json` | the same area before the fix: one area, counts absent, never zero. Kept as the withheld shape, which `areaCountResp` still renders for an archived area or a count it could not compute | `count_unavailable` | captured 2026-09-06 (api02, Assistant key), pre-fix wire |

**Provenance.** Every file is *captured*: `npm run capture -- <group_id>`
output, saved verbatim, a roster file trimmed to the rows of the member
whose state it holds. The exceptions are the six freshness files marked
**synthetic** above: the area hold was not capturable from this machine, so
they are written to the wire contract and should be replaced by captures
from api02 with the hold on. Nothing here was written from the API's rendering
code; the last such file, a multi-area floor example, was replaced by the
public-group floor capture on 2026-09-08.

## Global Ghost

The API has a second, global Ghost (`users.privacy_level = 'ghost'`,
"invisible everywhere"). It is not the Ghost the app offers — that is the
public-group join mode below — and it was set by SQL on api02 for the
capture. The byte-identity claim therefore rests on three captures:
consent-off (Newman), global Ghost (Newman) and sharing-off (Fred, John)
are identical apart from identity, and `npm test` asserts it. Global
Ghost also removes the member from every count bucket
(`area_counts.skateboard.ghost.json`: 2/1/0 became 1/0/0 while Newman's
stale position was still inside the area), where consent-off moves them
to `undisclosed_count`.

## Public-group Ghost: fixed on the REST roster

Ghost mode exists only in public groups, as a per-member `join_mode`, next
to an anonymous join mode. The app's roster renders a Ghost member as
"Hidden member" and the map drops their node (`maskMemberForList` and
`computeViewerModes` in `PositionGuard-API/graph/visibility.go`).

**The gap, as reproduced on api02 on 2026-09-06.** `GET
/groups/{id}/members` did not read `join_mode`: it returned the real
nickname and, when the member was inside one of the group's areas,
`current_area` — to integration and agent keys alike. The agent consent
gate did not close it either: `AgentView` only knows global Ghost
(`users.privacy_level`). Newman joined Dog Park @ Marymoor fresh, in Ghost
mode, and when his position landed inside the park the Assistant key's
roster showed him there by name. That response was the previous
`members.ghost_join.public_group.json`, and this server mapped it
faithfully to `at_area`: the wire was a disclosed row, and this server
does not filter in its own code — the guarantee has to live at the API
boundary.

**The fix.** Backend commits `ea6d8af`, `374da6b`, `9f014f0` and
`6a29048`, live on api02 and api01 as of 2026-09-07. On REST, for public
groups only (private groups are byte-identical to before):

- a Ghost-joined member has **no row at all** on the roster;
- an anonymous-joined member is listed as `"Anonymous"`, `avatar_url`
  omitted, presence fields kept;
- area-counts are **served**, counting every active member regardless of
  join mode, so the roster and the count deliberately disagree;
- above `PUBLIC_GROUP_MEMBER_LIMIT` (50) the roster is the caller's own row
  only, while the counts stay full;
- a Ghost-joined group is not a shared group: no `safety_area` name, no
  `inside_areas` entry;
- since `825f642` (with `5bfa569`), a public roster carries `safety_status`
  when, and only when, it is `"stale"`, with `position_age_seconds` beside
  it, and never `safety_area` nor the place-implying tiers. Before that a
  public roster withheld the whole block, so a member dark for days read
  `inside: true` with a `current_area` and nothing to say the position was
  old. Absence on a public row is therefore ambiguous (not stale, or no
  status at all) and a fresh away row stays bare. Captured in
  `members.stale.public_group.json`: the masked row inside the park with
  the marker beside `current_area`. Also observed on 2026-09-08 on the same
  row while away, dark for over a day: `safety_status: "stale"` and
  `position_age_seconds: 121380` beside identity and `inside: false`,
  nothing else;
- since the `is_system` fix (2026-09-08), the system identity that had sat
  on the Dog Park roster as "PositionGuard" is on no roster and in no count.

`members.ghost_join.public_group.json` and `area_counts.public_group.json`
are the post-fix wire, captured 2026-09-08 with Newman Ghost-joined and
EarlonDev anonymous-joined, both standing inside the park: the count says
2, the roster lists one row at the area under the mask and has no row for
Newman. The test that pinned the gap now asserts his absence, and
`who_is_at_area`'s `count_note` is proven from this pair.

**Not yet captured.** The over-limit roster (a public group above
`PUBLIC_GROUP_MEMBER_LIMIT`, served as the caller's own row only). Every
member state this server maps, private and public, is now captured.
