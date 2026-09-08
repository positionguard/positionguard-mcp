# Fixtures

One file per wire state the `status` mapping must get right. Each is a
response body from the public REST API (a roster file holds only the rows
of the member whose state it captures), with IDs redacted to
`00000000-0000-4000-8000-<12 hex of the ID's SHA-256>` — stable across
captures, so the same member or area has the same placeholder in every
file — and `avatar_url` dropped. Nicknames are those of synthetic api02
test accounts (Newman, Fred, John, EarlonDev, MikeL, and a seeded member
nicknamed PositionGuard on the Dog Park roster).

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
| `members.disclosed_away.public_group.json` | EarlonDev: consent on, elsewhere, seen through the **public** Dog Park @ Marymoor, whose rosters carry no safety block | `unknown` (conservative: byte-identical to a withheld row; a deployment with `SAFETY_STATUS_ENABLED=false` looks the same) | captured 2026-09-06 (api02, Assistant key); re-captured byte-identical 2026-09-07 through Team 425 gym, where he is a named member (his Dog Park row is now `"Anonymous"`, below) |
| `members.consent_off.json` | Newman: still inside Skatepark, sharing on, agent access switched off | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.ghost.json` | Newman: global Ghost (`users.privacy_level = 'ghost'`, set by SQL), still inside Skatepark | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.ghost_join.public_group.json` | the whole Dog Park @ Marymoor roster after the fix: MikeL as himself, EarlonDev as `"Anonymous"` (anonymous join; same placeholder ID as his named rows; `avatar_url` absent on the raw wire where MikeL's row carried one) and a seeded member nicknamed PositionGuard. Newman, whom the api02 verification left Ghost-joined to the park, has **no row**. Nobody was inside the park at capture time, so every row is `inside: false` | Newman: no row; every served row `unknown` — see *Public-group Ghost* | captured 2026-09-07 (api02, Assistant key) |
| `members.sharing_off.json` | Fred and John: sharing paused; the gate suppresses before it reads consent | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.sharing_off.integration_key.json` | the same two members, seen by an **integration** key | `unknown` | captured 2026-09-06 (api02, integration key) |
| `members.stale.json` | Newman: consent on, still inside Skatepark, app force-stopped until his last position was older than the stale window (50 minutes on api02, per the safety-status runbook) | `unknown` (reason `stale`) | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.json` | private group; Skatepark has one undisclosed, Home one stale | counts + floor note | derived (Skatepark's ID follows the capture) |
| `area_counts.skateboard.disclosed.json` | Team 🛹 Skateboard with two disclosed members at Skatepark | exact count | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.undisclosed.json` | same group after Newman switched agent access off: he moves from `member_count` to `undisclosed_count` | floor, "at least 1" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.stale.json` | same group with Newman stale: still in `member_count`, now also in `stale_count` | floor, "at least 2" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.ghost.json` | same group with Newman as global Ghost: gone from every bucket | exact count | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.consent_test_group.json` | private group, nobody inside: real zeros, all three fields present | exact count | captured 2026-09-06 (api02, Assistant key; byte-identical with the integration key) |
| `area_counts.public_group.json` | Dog Park @ Marymoor, a public group: counts now served, all three fields present; real zeros because nobody was inside at capture time | exact count | captured 2026-09-07 (api02, Assistant key) |
| `area_counts.public_group.withheld.json` | the same area before the fix: one area, counts absent, never zero. Kept as the withheld shape, which `areaCountResp` still renders for an archived area or a count it could not compute | `count_unavailable` | captured 2026-09-06 (api02, Assistant key), pre-fix wire |

**Provenance.** *derived* means the file was written from the API's
rendering code (`memberResp` / `areaCountResp` in
`PositionGuard-API/internal/rest/rest.go` and the agent-consent runbook's
verified matrix), not captured from a running server. *captured* means
`npm run capture -- <group_id>` output, saved verbatim.

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
  `inside_areas` entry.

`members.ghost_join.public_group.json` and `area_counts.public_group.json`
are the post-fix wire, captured 2026-09-07: Newman is on neither. The test
that pinned the gap now asserts his absence.

**Not yet captured.** Nobody was inside the park on 2026-09-07 (Newman's
and EarlonDev's last positions were at the Skatepark, stale), so the
roster/count disagreement — `member_count: 3` beside a two-row roster —
and a masked-but-present `"Anonymous"` row with `current_area` are not in
this directory. Re-placing MikeL, EarlonDev and Newman inside the park and
re-running `npm run capture` for the Dog Park overwrites both files with
that state. The over-limit roster and a public-group floor (one member
with agent access off inside the park, ideally one stale) are likewise
uncaptured; the one remaining *derived* file is still `area_counts.json`,
a multi-area floor-count example (one area with an undisclosed member,
one with a stale member, one exact) kept because no api02 group has all
three at once; its Skatepark ID follows the capture.
