# Changelog

## Unreleased

- `where_is_member`: `area` is the innermost area the member is in
  (`inside_areas[0]` on the wire) and the answer carries `inside_areas`,
  every area of the group they are disclosed in. An area missing from the
  list is not evidence the member is outside it, and the tool description
  says so. `since` is omitted when the area named is not the one the API
  timed the entry for.
- `who_is_at_area`: matches the requested area against `inside_areas`, so a
  member in an inner area is named for the outer one. `count_note` now
  compares `member_count + undisclosed_count` with the names listed, says
  how many present members are not disclosed to assistants, and tells the
  model not to report the list as complete. Before, a member disclosed at
  an inner area and withheld at the outer one left the outer list short
  with no note at all.
- Against a server that doesn't send `inside_areas`, `current_area` answers
  as before.

## 0.1.1 — unreleased

- `where_is_member`: a member the server holds at an area through a
  silent phone (`position_fresh: false`) is answered as
  `last_known_at_area`, with `last_confirmed_seconds_ago` and a
  plain-language note, never as `at_area`. A fresh answer carries
  `position_fresh` and `position_age_seconds` when the server sends them.
  A held member who is not at one of the group's areas is `unknown`
  (`stale`), not `not_at_area`.
- `who_is_at_area`: returns `confirmed` and `last_known` as separate lists,
  with `last_known_note`. `members` still holds the confirmed list, for
  0.1.0 clients.
- `count_members_at_area`: the note says "N at the area, M of them not
  recently confirmed", and no longer prints a clause for an empty bucket.
- Tool descriptions and server instructions: a last-known answer must be
  relayed with its age, never as current presence; `since` is the
  area-entry time.
- Against a server that doesn't send `position_fresh`, every answer is
  unchanged.

## 0.1.0

- First release: `list_groups`, `list_areas`, `where_is_member`,
  `who_is_at_area`, `count_members_at_area`.
