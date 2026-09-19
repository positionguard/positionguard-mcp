import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionGuardClient } from "../src/core/client.js";
import { formatAge, memberStatus, mergeStatuses } from "../src/core/mapping.js";
import { countMembersAtArea, whereIsMember, whoIsAtArea } from "../src/core/tools.js";
import type { WireMember } from "../src/core/types.js";
import { captureLog, defaultRoutes, fakeFetch, FAMILY, fixture, PUBLIC, type Routes } from "./helpers.js";

// Position freshness (the server's area hold, SAFETY_STATUS_AREA_HOLD).
// A held row keeps safety_status "at_area" through a phone's silence and
// carries position_fresh: false with the true age. Rule: position_fresh
// present -> use it; absent (older server) -> exactly the pre-hold answer.

const KEY = "pg_live_0123456789abcdef0123456789abcdef";
const LAKE_HOUSE = "00000000-0000-4000-8000-00000000a001";

function row(name: string): WireMember {
  const r = fixture<WireMember[]>(name);
  assert.equal(r.length, 1, `${name} holds one row`);
  return r[0]!;
}

function client(routes: Routes) {
  const { fetch } = fakeFetch(routes);
  const { log } = captureLog();
  return new PositionGuardClient({ apiKey: KEY, baseUrl: "http://api.test/api/v1/", log, userAgent: "test", fetch });
}

// Family's roster is Newman held at the Lake House, and its counts put one
// member there, stale.
function heldWorld(extraFamilyRows: unknown[] = []): Routes {
  const routes = defaultRoutes();
  routes[`/groups/${FAMILY}/members`] = {
    status: 200,
    body: [...fixture<unknown[]>("members.held_at_area.json"), ...extraFamilyRows],
  };
  routes[`/groups/${FAMILY}/area-counts`] = { status: 200, body: fixture("area_counts.held.json") };
  return routes;
}

// --- mapping -------------------------------------------------------------

test("fresh at_area (position_fresh true) -> at_area, freshness passed through", () => {
  const r = row("members.fresh_at_area.json");
  assert.deepEqual(memberStatus(r), {
    status: "at_area",
    area: { area_id: r.current_area!.id, name: "Skatepark" },
    since: r.last_update,
    position_fresh: true,
    position_age_seconds: 2116,
  });
});

test("held at_area (position_fresh false, 36,000 s) -> last_known_at_area with its age, never at_area", () => {
  const r = row("members.held_at_area.json");
  assert.deepEqual(memberStatus(r), {
    status: "last_known_at_area",
    area: { area_id: LAKE_HOUSE, name: "Lake House" },
    position_fresh: false,
    last_confirmed_seconds_ago: 36000,
    note:
      "Last confirmed at Lake House 10 h ago; no newer position. " +
      "Relay this as their last known place with its age, not as where they are now. " +
      "`since` is when they entered the area, not when they were last confirmed.",
    since: r.last_update,
  });
});

test("field absent (captured, pre-hold server) -> exactly the pre-hold answer, no freshness fields added", () => {
  const r = row("members.disclosed_at_area.json");
  assert.equal("position_fresh" in r, false);
  assert.deepEqual(memberStatus(r), {
    status: "at_area",
    area: { area_id: r.current_area!.id, name: "Skatepark" },
    since: r.last_update,
  });
});

test("stale outside an area -> unknown/stale (unchanged)", () => {
  assert.deepEqual(memberStatus(row("members.stale_away.json")), { status: "unknown", reason: "stale" });
});

test("held row not inside this group's areas -> unknown/stale, never not_at_area from an old position", () => {
  assert.deepEqual(memberStatus(row("members.held_away.json")), { status: "unknown", reason: "stale" });
});

test("narrowed rows: a held member on a public roster is stale there; a row with no safety fields is unchanged", () => {
  // publicGroupSafety turns a held at_area back into stale before rendering.
  assert.deepEqual(memberStatus(row("members.held.public_group.json")), { status: "unknown", reason: "stale" });
  // The captured Dog Park roster: "Anonymous" inside the park, no safety block.
  const anon = fixture<WireMember[]>("members.ghost_join.public_group.json").find((m) => m.nickname === "Anonymous")!;
  assert.equal(anon.safety_status, undefined);
  assert.deepEqual(memberStatus(anon), {
    status: "at_area",
    area: { area_id: anon.current_area!.id, name: anon.current_area!.name },
    since: anon.last_update,
  });
});

test("held with no age -> unknown/stale (nothing to state an age with)", () => {
  const { position_age_seconds: _a, ...r } = row("members.held_at_area.json");
  assert.deepEqual(memberStatus(r), { status: "unknown", reason: "stale" });
});

test("merge: at_area beats last_known_at_area beats not_at_area", () => {
  const fresh = memberStatus(row("members.fresh_at_area.json"));
  const held = memberStatus(row("members.held_at_area.json"));
  const away = memberStatus(row("members.disclosed_away.json"));
  assert.equal(mergeStatuses([held, fresh]).status, "at_area");
  assert.equal(mergeStatuses([away, held]).status, "last_known_at_area");
});

test("formatAge is coarse and never says 0", () => {
  assert.deepEqual([10, 1500, 36000, 3 * 86400].map(formatAge), ["1 min", "25 min", "10 h", "3 days"]);
});

// --- tools ---------------------------------------------------------------

test("where_is_member: held member -> last_known_at_area with age and plain-language note, never at_area", async () => {
  const r = await whereIsMember(client(heldWorld()), { nickname: "Newman", group_id: FAMILY });
  assert.equal(r.status, "last_known_at_area");
  if (r.status === "last_known_at_area") {
    assert.equal(r.last_confirmed_seconds_ago, 36000);
    assert.equal(r.position_fresh, false);
    assert.match(r.note, /^Last confirmed at Lake House 10 h ago; no newer position\./);
    assert.equal(r.group_name, "Family");
  }
});

test("where_is_member: across groups, a held row answers with its group", async () => {
  const r = await whereIsMember(client(heldWorld()), { nickname: "Newman" });
  // The Skateboard group's stale row and the Consent group's away row lose
  // to the held one; the Skatepark at_area row is gone with Family's roster.
  assert.equal(r.status, "last_known_at_area");
  if (r.status === "last_known_at_area") assert.equal(r.group_id, FAMILY);
});

test("who_is_at_area: fresh and held members come back in separate lists, never merged", async () => {
  const fresh = { ...row("members.held_at_area.json"), user_id: "00000000-0000-4000-8000-00000000b002", nickname: "MikeL", position_fresh: true, position_age_seconds: 120 };
  const routes = heldWorld([fresh]);
  routes[`/groups/${FAMILY}/area-counts`] = {
    status: 200,
    body: [{ ...fixture<object[]>("area_counts.held.json")[0], member_count: 2, stale_count: 1 }],
  };
  const r = await whoIsAtArea(client(routes), { group_id: FAMILY, area_name: "Lake House" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.confirmed, ["MikeL"]);
    assert.deepEqual(r.last_known, [{ nickname: "Newman", last_confirmed_seconds_ago: 36000 }]);
    assert.deepEqual(r.members, r.confirmed);
    assert.match(r.last_known_note!, /^1 member was last confirmed here but has no newer position\./);
    assert.equal(r.count_note, undefined, "two counted, two listed");
  }
});

test("who_is_at_area: no held rows -> empty last_known, no note", async () => {
  const r = await whoIsAtArea(client(defaultRoutes()), { group_id: FAMILY, area_name: "Skatepark" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.last_known, []);
    assert.equal(r.last_known_note, undefined);
    assert.deepEqual(r.confirmed, r.members);
  }
});

test("public roster: a held member narrowed to stale is unknown in where_is_member and never listed", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${PUBLIC}/members`] = { status: 200, body: fixture("members.held.public_group.json") };
  const c = client(routes);
  assert.deepEqual(await whereIsMember(c, { nickname: "Anonymous", group_id: PUBLIC }), {
    status: "unknown",
    reason: "stale",
    nickname: "Anonymous",
  });
  const who = await whoIsAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  if (who.status === "ok") {
    assert.deepEqual(who.confirmed, []);
    assert.deepEqual(who.last_known, []);
  } else assert.fail(who.status);
});

test("count_members_at_area: held member -> 'N at the area, M of them not recently confirmed', sub-count kept", async () => {
  const r = await countMembersAtArea(client(heldWorld()), { group_id: FAMILY, area_name: "Lake House" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [1, 1, 0]);
    assert.match(r.note, /at least 1/);
    assert.match(r.note, /1 at the area, 1 of them not recently confirmed/);
    assert.ok(!r.note.includes("0 members"), "no clause for an empty bucket");
  }
});

test("count_members_at_area: stale and undisclosed together -> 'At least N at the area, M of them not recently confirmed'", async () => {
  const routes = heldWorld();
  routes[`/groups/${FAMILY}/area-counts`] = {
    status: 200,
    body: [{ ...fixture<object[]>("area_counts.held.json")[0], member_count: 3, stale_count: 1, undisclosed_count: 2 }],
  };
  const r = await countMembersAtArea(client(routes), { group_id: FAMILY, area_name: "Lake House" });
  if (r.status === "ok") {
    assert.match(r.note, /At least 3 at the area, 1 of them not recently confirmed/);
    assert.match(r.note, /2 members are at the area but chose not to be visible/);
  } else assert.fail(r.status);
});
