import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionGuardClient } from "../src/core/client.js";
import { memberStatus, statusAtArea } from "../src/core/mapping.js";
import { countMembersAtArea, whereIsMember, whoIsAtArea } from "../src/core/tools.js";
import type { WireAreaCount, WireMember } from "../src/core/types.js";
import { captureLog, fakeFetch, fixture, HOME, LOS_ANGELES, NESTED, nestedRoutes, type Routes } from "./helpers.js";

// `inside_areas` (backend e173e0f): a roster row lists every area of the
// group the member is inside, innermost first, beside `current_area`. The
// captured group nests a small "Home" inside a large "Los Angeles".
//
//   members.nested.json                  everyone disclosed everywhere
//   members.nested.outer_withheld.json   Ana withheld from assistants at Los
//                                        Angeles: her row lists Home only,
//                                        and nothing marks the omission
//
// Rule: an area on the list is a place the member is; an area missing from
// it is unknown, never "not there".

const KEY = "pg_live_0123456789abcdef0123456789abcdef";
const HOME_AREA = { area_id: HOME, name: "Home" };
const LA_AREA = { area_id: LOS_ANGELES, name: "Los Angeles" };

type State = "nested" | "nested.outer_withheld";

function member(state: State, nickname: string): WireMember {
  const r = fixture<WireMember[]>(`members.${state}.json`).find((m) => m.nickname === nickname);
  assert.ok(r, `${nickname} is on the ${state} roster`);
  return r;
}

function client(routes: Routes) {
  const { fetch } = fakeFetch(routes);
  const { log, lines } = captureLog();
  const c = new PositionGuardClient({ apiKey: KEY, baseUrl: "http://api.test/api/v1/", log, userAgent: "test", fetch });
  return { c, lines };
}

// The same world as served by a backend that predates inside_areas.
function withoutInsideAreas(routes: Routes): Routes {
  const path = `/groups/${NESTED}/members`;
  const body = (routes[path] as { body: WireMember[] }).body.map(({ inside_areas: _i, ...rest }) => rest);
  return { ...routes, [path]: { status: 200, body } };
}

// --- mapping -------------------------------------------------------------

test("inside both areas (captured) -> at_area at the innermost, with the full list beside it", () => {
  const ana = member("nested", "Ana");
  assert.equal(ana.current_area!.id, HOME);
  assert.deepEqual(memberStatus(ana), {
    status: "at_area",
    area: HOME_AREA,
    inside_areas: [HOME_AREA, LA_AREA],
    since: ana.last_update,
    position_fresh: true,
    position_age_seconds: 72,
  });
});

test("current_area is the OUTER area (synthetic ordering) -> area is still inside_areas[0], and `since` is withheld", () => {
  // Ben's current_area is Los Angeles while his list starts with Home: the
  // newest state row is the outer area's. The answer names the innermost.
  // His safety block, computed on a separate path, agrees with the list.
  // last_update is the entry time of current_area, so it is not passed off
  // as when he entered Home.
  const ben = member("nested", "Ben");
  assert.equal(ben.current_area!.id, LOS_ANGELES);
  assert.equal(ben.inside_areas![0]!.area_id, HOME);
  assert.equal(ben.safety_area, "Home");
  assert.ok(ben.last_update);
  assert.deepEqual(memberStatus(ben), {
    status: "at_area",
    area: HOME_AREA,
    inside_areas: [HOME_AREA, LA_AREA],
    position_fresh: true,
    position_age_seconds: 72,
  });
});

test("inside the outer area only (captured) -> at_area there, a list of one", () => {
  const cleo = member("nested", "Cleo");
  assert.deepEqual(memberStatus(cleo), {
    status: "at_area",
    area: LA_AREA,
    inside_areas: [LA_AREA],
    since: cleo.last_update,
    position_fresh: true,
    position_age_seconds: 72,
  });
});

test("rows inside nothing carry no inside_areas: disclosed-away is not_at_area, the bare row is unknown", () => {
  for (const state of ["nested", "nested.outer_withheld"] as const) {
    const dev = member(state, "Dev");
    assert.equal("inside_areas" in dev, false);
    assert.deepEqual(memberStatus(dev), { status: "not_at_area" });
    // Olive, the key holder, has agent access off: identity + inside: false.
    const { user_id: _u, nickname: _n, ...rest } = member(state, "Olive");
    assert.deepEqual(rest, { inside: false });
    assert.deepEqual(memberStatus(member(state, "Olive")), { status: "unknown", reason: "not_disclosed" });
  }
});

test("a member absent from inside_areas for the requested area -> unknown, never not_at_area", () => {
  // Ana, withheld at Los Angeles: a disclosed row at Home, a list of Home
  // alone. Asked about Los Angeles, the row says nothing either way.
  const ana = member("nested.outer_withheld", "Ana");
  assert.deepEqual(ana.inside_areas, [{ area_id: HOME, area_name: "Home" }]);
  const s = memberStatus(ana);
  assert.equal(s.status, "at_area");
  assert.equal(statusAtArea(s, HOME).status, "at_area");
  assert.deepEqual(statusAtArea(s, LOS_ANGELES), { status: "unknown", reason: "not_disclosed" });

  // The wire does not say why an area is missing. Cleo, disclosed everywhere
  // and simply not at Home, gets the same answer for Home.
  assert.deepEqual(statusAtArea(memberStatus(member("nested", "Cleo")), HOME), {
    status: "unknown",
    reason: "not_disclosed",
  });

  // No placed row, on either roster, is ever not_at_area for either area.
  for (const state of ["nested", "nested.outer_withheld"] as const) {
    for (const r of fixture<WireMember[]>(`members.${state}.json`).filter((m) => m.inside)) {
      for (const area of [HOME, LOS_ANGELES]) {
        assert.notEqual(statusAtArea(memberStatus(r), area).status, "not_at_area", `${r.nickname} at ${area}`);
      }
    }
  }
});

test("statusAtArea without a list (older server) falls back to current_area, with the same rule", () => {
  const { inside_areas: _i, ...ana } = member("nested", "Ana");
  const s = memberStatus(ana);
  assert.deepEqual(s, {
    status: "at_area",
    area: HOME_AREA,
    since: ana.last_update,
    position_fresh: true,
    position_age_seconds: 72,
  });
  assert.equal(statusAtArea(s, HOME).status, "at_area");
  assert.deepEqual(statusAtArea(s, LOS_ANGELES), { status: "unknown", reason: "not_disclosed" });
});

test("a held row with a list -> last_known_at_area at the innermost, list carried; a stale one returns no area at all", () => {
  const held = memberStatus({ ...member("nested", "Ana"), position_fresh: false, position_age_seconds: 36000 });
  assert.equal(held.status, "last_known_at_area");
  if (held.status === "last_known_at_area") {
    assert.deepEqual(held.area, HOME_AREA);
    assert.deepEqual(held.inside_areas, [HOME_AREA, LA_AREA]);
    assert.equal(statusAtArea(held, LOS_ANGELES).status, "last_known_at_area");
  }
  const stale = memberStatus({ ...member("nested", "Ana"), safety_status: "stale", position_fresh: false });
  assert.deepEqual(stale, { status: "unknown", reason: "stale" });
});

// --- tools ---------------------------------------------------------------

test("who_is_at_area on the outer area names members standing in the inner one; counts and names agree, no count_note", async () => {
  const { c } = client(nestedRoutes("nested"));
  const la = await whoIsAtArea(c, { group_id: NESTED, area_name: "Los Angeles" });
  assert.equal(la.status, "ok");
  if (la.status === "ok") {
    assert.deepEqual(la.confirmed, ["Ana", "Ben", "Cleo"]);
    assert.deepEqual(la.last_known, []);
    assert.equal(la.count_note, undefined, "3 counted, 3 listed");
    assert.match(la.undisclosed_note!, /^1 member /); // Olive's bare row
  }
  const home = await whoIsAtArea(c, { group_id: NESTED, area_id: HOME });
  assert.equal(home.status, "ok");
  if (home.status === "ok") {
    assert.deepEqual(home.confirmed, ["Ana", "Ben"]);
    assert.equal(home.count_note, undefined, "2 counted, 2 listed");
  }
});

test("who_is_at_area: a member withheld at the outer area only (captured) -> count_note fires where member_count against the roster is silent", async () => {
  const { c } = client(nestedRoutes("nested.outer_withheld"));
  const counts = fixture<WireAreaCount[]>("area_counts.nested.outer_withheld.json").find((a) => a.area_id === LOS_ANGELES)!;
  const r = await whoIsAtArea(c, { group_id: NESTED, area_name: "Los Angeles" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.confirmed, ["Ben", "Cleo"]);
    const listed = r.confirmed.length + r.last_known.length;
    // The comparison this replaced: member_count excludes the withheld
    // member for an agent key, so it equals the roster and says nothing.
    assert.equal(counts.member_count, listed);
    // The one that sees her: everyone the server places at the area.
    const total = counts.member_count! + counts.undisclosed_count!;
    assert.equal(total, 3);
    assert.ok(total > listed);
    assert.equal(
      r.count_note,
      "3 counted at this area, 2 listed. 1 present member is not disclosed to AI assistants — " +
        "do not report the named list as complete.",
    );
    assert.ok(!r.count_note!.includes("Ana"), "the note never names anyone");
    // Ana's row is a disclosed row (at Home), so the withheld-row note counts Olive alone.
    assert.match(r.undisclosed_note!, /^1 member /);
  }

  // The count tool, asked in the same conversation, adds up to the same three.
  const n = await countMembersAtArea(c, { group_id: NESTED, area_name: "Los Angeles" });
  assert.equal(n.status, "ok");
  if (n.status === "ok") assert.deepEqual([n.member_count, n.stale_count, n.undisclosed_count], [2, 0, 1]);

  // Home is untouched: Ana is disclosed there and still listed.
  const home = await whoIsAtArea(c, { group_id: NESTED, area_name: "Home" });
  if (home.status === "ok") {
    assert.deepEqual(home.confirmed, ["Ana", "Ben"]);
    assert.equal(home.count_note, undefined);
  } else assert.fail(home.status);
});

test("where_is_member: the innermost area, with the full list alongside", async () => {
  const { c } = client(nestedRoutes("nested"));
  assert.deepEqual(await whereIsMember(c, { nickname: "Ben" }), {
    status: "at_area",
    area: HOME_AREA,
    inside_areas: [HOME_AREA, LA_AREA],
    position_fresh: true,
    position_age_seconds: 72,
    nickname: "Ben",
    group_id: NESTED,
    group_name: "Nested Test Group",
  });
});

test("where_is_member: withheld at the outer area -> the list is Home alone, and nothing in the answer says she is outside Los Angeles", async () => {
  const { c } = client(nestedRoutes("nested.outer_withheld"));
  const r = await whereIsMember(c, { nickname: "Ana", group_id: NESTED });
  assert.equal(r.status, "at_area");
  if (r.status === "at_area") {
    assert.deepEqual(r.area, HOME_AREA);
    assert.deepEqual(r.inside_areas, [HOME_AREA]);
  }
  assert.ok(!JSON.stringify(r).includes("Los Angeles"));
  assert.ok(!JSON.stringify(r).includes("not_at_area"));
});

test("where_is_member: a fully withheld member is still unknown, with no list", async () => {
  for (const state of ["nested", "nested.outer_withheld"] as const) {
    const { c } = client(nestedRoutes(state));
    assert.deepEqual(await whereIsMember(c, { nickname: "Olive" }), {
      status: "unknown",
      reason: "not_disclosed",
      nickname: "Olive",
    });
  }
});

test("a backend without inside_areas: current_area answers, and the count says the outer list is short", async () => {
  const { c } = client(withoutInsideAreas(nestedRoutes("nested")));
  const w = await whereIsMember(c, { nickname: "Ana" });
  assert.equal(w.status, "at_area");
  if (w.status === "at_area") {
    assert.deepEqual(w.area, HOME_AREA);
    assert.equal("inside_areas" in w, false);
  }
  // Without the list only current_area can be matched: Ana, at Home, is not
  // named for Los Angeles. The count still has her, and the note says so.
  const la = await whoIsAtArea(c, { group_id: NESTED, area_id: LOS_ANGELES });
  assert.equal(la.status, "ok");
  if (la.status === "ok") {
    assert.deepEqual(la.confirmed, ["Ben", "Cleo"]);
    assert.match(la.count_note!, /^3 counted at this area, 2 listed\. The rest are counted without being listed/);
    assert.match(la.count_note!, /confirmed here, not as everyone who is here\.$/);
  }
});

test("who_is_at_area: an absent undisclosed_count is unknown, not zero; absent counts are no count at all", async () => {
  const strip = (keys: (keyof WireAreaCount)[]): Routes => {
    const routes = nestedRoutes("nested");
    const path = `/groups/${NESTED}/area-counts`;
    const body = (routes[path] as { body: WireAreaCount[] }).body.map((a) => {
      const out: Partial<WireAreaCount> = { ...a };
      for (const k of keys) delete out[k];
      return out;
    });
    return { ...routes, [path]: { status: 200, body } };
  };

  // member_count 3 against 3 listed, and no undisclosed_count: the list
  // cannot be vouched for, and the answer says that instead of assuming 0.
  const partial = await whoIsAtArea(client(strip(["undisclosed_count"])).c, { group_id: NESTED, area_id: LOS_ANGELES });
  assert.equal(partial.status, "ok");
  if (partial.status === "ok") {
    assert.deepEqual(partial.confirmed, ["Ana", "Ben", "Cleo"]);
    assert.equal(
      partial.count_note,
      "3 counted at this area, 3 listed. PositionGuard did not say how many present members are not " +
        "disclosed to AI assistants — do not report the named list as complete.",
    );
  }

  // The withheld shape (archived area, or a count that could not be
  // computed): nothing to compare, so no count_note — and never a zero.
  const none = await whoIsAtArea(client(strip(["member_count", "stale_count", "undisclosed_count"])).c, {
    group_id: NESTED,
    area_id: LOS_ANGELES,
  });
  assert.equal(none.status, "ok");
  if (none.status === "ok") {
    assert.deepEqual(none.confirmed, ["Ana", "Ben", "Cleo"]);
    assert.equal(none.count_note, undefined);
  }
});

test("log lines for the nested answers carry no member name, area name or key", async () => {
  const { c, lines } = client(nestedRoutes("nested.outer_withheld"));
  await whereIsMember(c, { nickname: "Ana" });
  await whoIsAtArea(c, { area_name: "Los Angeles" });
  await countMembersAtArea(c, { area_name: "Home" });
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(!l.includes("pg_live_"), l);
    for (const n of ["Ana", "Ben", "Cleo", "Dev", "Olive", "Home", "Los Angeles"]) assert.ok(!l.includes(n), l);
  }
});
