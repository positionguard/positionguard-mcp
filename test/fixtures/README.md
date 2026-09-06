# Fixtures

One file per wire state the `status` mapping must get right. Each is a whole
response body from the public REST API as an **agent-type** key sees it
(except where the name says otherwise), with IDs redacted to
`00000000-0000-4000-8000-…` placeholders. Nicknames are those of synthetic
test accounts.

`npm test` asserts the mapping in `src/core/mapping.ts` against every file
here. That is where `unknown` is proven before any model sees the server.

| File | State | Expected status | Provenance |
|---|---|---|---|
| `groups.json` | `GET /groups`: two private groups, one public | — | derived |
| `members.disclosed_at_area.json` | consent on, inside Skatepark | `at_area` | derived |
| `members.disclosed_away.json` | consent on, not at any group area, safety surface on | `not_at_area` | derived |
| `members.disclosed_away.safety_off.json` | consent on, away, deployment with `SAFETY_STATUS_ENABLED=false` | `unknown` (conservative: byte-identical to a withheld row) | derived |
| `members.consent_off.json` | agent access not enabled by the member | `unknown` | derived |
| `members.ghost.json` | member is globally Ghost, consent on | `unknown` | derived |
| `members.sharing_off.json` | member paused sharing, consent on | `unknown` | derived |
| `members.sharing_off.integration_key.json` | same member, seen by an **integration** key | `unknown` | derived |
| `members.stale.json` | consent on, still inside an area, no position for > stale window | `unknown` (reason `stale`) | derived |
| `area_counts.json` | private group; Skatepark has one undisclosed, Home one stale | counts + floor note | derived |
| `area_counts.public_group.json` | public group: counts absent, never zero | `count_unavailable` | derived |

**Provenance.** *derived* means the file was written from the API's
rendering code (`memberResp` / `areaCountResp` in
`PositionGuard-API/internal/rest/rest.go` and the agent-consent runbook's
verified matrix), not captured from a running server. Replace each with a
real api02 capture — `npm run capture -- <group_id>` prints redacted
responses — and change the column to `captured YYYY-MM-DD`. The three
withheld rows (`consent_off`, `ghost`, `sharing_off`) are expected to be
byte-identical apart from identity; that sameness is the guarantee.
