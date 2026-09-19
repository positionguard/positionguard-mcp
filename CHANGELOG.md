# Changelog

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
