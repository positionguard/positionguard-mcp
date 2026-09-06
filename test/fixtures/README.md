# Fixtures

One file per wire state the `status` mapping must get right. Each is a
response body from the public REST API (a roster file holds only the rows
of the member whose state it captures), with IDs redacted to
`00000000-0000-4000-8000-<12 hex of the ID's SHA-256>` — stable across
captures, so the same member or area has the same placeholder in every
file — and `avatar_url` dropped. Nicknames are those of synthetic api02
test accounts (Newman, Fred, John).

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
| `members.disclosed_away.public_group.json` | EarlonDev: consent on, elsewhere, seen through the **public** Dog Park @ Marymoor, whose rosters carry no safety block | `unknown` (conservative: byte-identical to a withheld row; a deployment with `SAFETY_STATUS_ENABLED=false` looks the same) | captured 2026-09-06 (api02, Assistant key) |
| `members.consent_off.json` | Newman: still inside Skatepark, sharing on, agent access switched off | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.ghost_join.public_group.json` | Newman: joined Dog Park @ Marymoor, a public group he was not a member of before, in Ghost mode; consent on; standing inside Marymoor Dog Park (his presence endpoint listed the park at the same moment) | `at_area` — see *Known API gap* | captured 2026-09-06 (api02, Assistant key) |
| `members.sharing_off.json` | Fred and John: sharing paused; the gate suppresses before it reads consent | `unknown` | captured 2026-09-06 (api02, Assistant key) |
| `members.sharing_off.integration_key.json` | the same two members, seen by an **integration** key | `unknown` | captured 2026-09-06 (api02, integration key) |
| `members.stale.json` | Newman: consent on, still inside Skatepark, app force-stopped until his last position was older than the stale window (50 minutes on api02, per the safety-status runbook) | `unknown` (reason `stale`) | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.json` | private group; Skatepark has one undisclosed, Home one stale | counts + floor note | derived (Skatepark's ID follows the capture) |
| `area_counts.skateboard.disclosed.json` | Team 🛹 Skateboard with two disclosed members at Skatepark | exact count | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.undisclosed.json` | same group after Newman switched agent access off: he moves from `member_count` to `undisclosed_count` | floor, "at least 1" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.skateboard.stale.json` | same group with Newman stale: still in `member_count`, now also in `stale_count` | floor, "at least 2" | captured 2026-09-06 (api02, Assistant key) |
| `area_counts.consent_test_group.json` | private group, nobody inside: real zeros, all three fields present | exact count | captured 2026-09-06 (api02, Assistant key; byte-identical with the integration key) |
| `area_counts.public_group.json` | Dog Park @ Marymoor, a public group: one area, counts absent, never zero | `count_unavailable` | captured 2026-09-06 (api02, Assistant key) |

**Provenance.** *derived* means the file was written from the API's
rendering code (`memberResp` / `areaCountResp` in
`PositionGuard-API/internal/rest/rest.go` and the agent-consent runbook's
verified matrix), not captured from a running server. *captured* means
`npm run capture -- <group_id>` output, saved verbatim. ## Known API gap: public-group Ghost is not masked on the REST roster

Ghost mode exists only in public groups, as a per-member `join_mode`. The
app's roster renders such a member as "Hidden member" and the map drops
their node (`maskMemberForList` and `computeViewerModes` in
`PositionGuard-API/graph/visibility.go`). `GET /groups/{id}/members` does
not read `join_mode`: it returns the real nickname and, when the member is
inside one of the group's areas, `current_area` — to integration and agent
keys alike. The agent consent gate does not close this either: `AgentView`
only knows global Ghost (`users.privacy_level`). Observed on api02 on
2026-09-06: Newman joined Dog Park @ Marymoor fresh, in Ghost mode, and
when his position landed inside the park the Assistant key's roster
showed him there by name. The fixture above is that response.

This server maps the row faithfully to `at_area`, because the wire is a
disclosed row and this server does not filter in its own code — the
guarantee has to live at the API boundary. Until the API masks join-mode
Ghost, an assistant whose key holder is in a public group can be told
that a Ghost-joined member is at that group's area. Reported to the
backend; when fixed, this row becomes the withheld shape and the tests
that pin the current behaviour flip to `unknown`.

Every member state is now captured. The one remaining *derived* file is
`area_counts.json`, a multi-area floor-count example (one area with an
undisclosed member, one with a stale member, one exact) kept because no
api02 group has all three at once; its Skatepark ID follows the capture.
