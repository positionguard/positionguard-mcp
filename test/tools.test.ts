import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, PositionGuardClient } from "../src/core/client.js";
import { countMembersAtArea, listAreas, listGroups, whereIsMember, whoIsAtArea } from "../src/core/tools.js";
import { fixture } from "./helpers.js";
import { captureLog, CONSENT, defaultRoutes, EVENT, fakeFetch, FAMILY, FRIENDS, PUBLIC, SKATE, SKATEPARK, type Routes } from "./helpers.js";

const KEY = "pg_live_0123456789abcdef0123456789abcdef";

function client(routes: Routes = defaultRoutes()) {
  const { fetch, calls } = fakeFetch(routes);
  const { log, lines } = captureLog();
  const c = new PositionGuardClient({ apiKey: KEY, baseUrl: "http://api.test/api/v1/", log, userAgent: "test", fetch });
  return { c, calls, lines };
}

test("list_groups", async () => {
  const { c } = client();
  const r = await listGroups(c);
  assert.equal(r.status, "ok");
  assert.equal(r.groups.length, 9);
  assert.deepEqual(r.groups.find((g) => g.group_id === PUBLIC), {
    group_id: PUBLIC,
    name: "Dog Park @ Marymoor",
    group_type: "public",
  });
});

test("list_areas strips counts and tags each area with its group; never calls /areas", async () => {
  const { c, calls } = client();
  const r = await listAreas(c, { group_id: FAMILY });
  assert.equal(r.status, "ok");
  assert.deepEqual(
    r.areas.find((a) => a.area_id === SKATEPARK),
    { area_id: SKATEPARK, name: "Skatepark", group_id: FAMILY, group_name: "Family" },
  );
  for (const a of r.areas) assert.ok(!("member_count" in a));
  assert.ok(calls.every((p) => !/\/areas$/.test(p)), `called: ${calls.join(", ")}`);
});

test("list_areas across every group", async () => {
  const { c } = client();
  const r = await listAreas(c, {});
  // Only the groups with fake area routes have areas; the rest answer empty in the fake API.
  assert.deepEqual(
    [...new Set(r.areas.map((a) => a.group_name))].sort(),
    ["Consent Test Group", "Family", "Dog Park @ Marymoor", "Team 🛹 Skateboard"].sort(),
  );
});

test("where_is_member: at an area (captured row)", async () => {
  const { c } = client();
  const r = await whereIsMember(c, { nickname: "newman", group_id: FAMILY });
  assert.equal(r.status, "at_area");
  assert.equal(r.nickname, "Newman");
  if (r.status === "at_area") {
    assert.equal(r.area.area_id, SKATEPARK);
    assert.equal(r.area.name, "Skatepark");
    assert.match(r.since!, /^2026-/);
    assert.equal(r.group_id, FAMILY);
  }
});

test("where_is_member: disclosed and away (captured row: inside:false with a safety block)", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "newman", group_id: CONSENT }), {
    status: "not_at_area",
    nickname: "Newman",
  });
});

test("where_is_member: Newman with consent off (captured row) -> unknown, not not_at_area", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Newman", group_id: FRIENDS }), {
    status: "unknown",
    reason: "not_disclosed",
    nickname: "Newman",
  });
});

test("where_is_member: Newman as global Ghost (captured row) -> unknown, not not_at_area", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Newman", group_id: EVENT }), {
    status: "unknown",
    reason: "not_disclosed",
    nickname: "Newman",
  });
});

test("count_members_at_area: captured Skatepark with Newman as global Ghost -> 1/0/0, in no bucket at all", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${SKATE}/area-counts`] = { status: 200, body: fixture("area_counts.skateboard.ghost.json") };
  const r = await countMembersAtArea(client(routes).c, { group_id: SKATE, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [1, 0, 0]);
});

test("where_is_member: Ghost-joined member of a public group (captured roster) -> no_such_member in that group; the roster has no row for him", async () => {
  // The Dog Park roster is served whole and Newman, who joined in Ghost
  // mode, is not on it (test/fixtures/README.md, "Public-group Ghost").
  // Asked about that group alone, no such member is visible; asked across
  // every group, his private-group rows answer as before.
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Newman", group_id: PUBLIC }), {
    status: "unknown",
    reason: "no_such_member",
    nickname: "Newman",
  });
  const all = await whereIsMember(c, { nickname: "Newman" });
  assert.equal(all.status, "at_area");
  if (all.status === "at_area") assert.equal(all.group_name, "Family");
});

test("who_is_at_area: public group (captured roster and count) -> the masked member listed as \"Anonymous\", the Ghost-joined member counted but never listed", async () => {
  // Newman (Ghost-joined) and EarlonDev (anonymous-joined) were both inside
  // the park: the count says 2, the roster lists one row at the area, under
  // the mask, and has no row for Newman. MikeL's row is the withheld shape.
  // One listed, one withheld, two counted — and the answer says all three.
  const { c } = client();
  const r = await whoIsAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Anonymous"]);
    assert.match(r.undisclosed_note!, /^1 member /);
    assert.match(r.count_note!, /^2 counted at this area, 1 listed\./);
    for (const n of ["Newman", "EarlonDev", "MikeL"]) {
      assert.ok(!r.undisclosed_note!.includes(n));
      assert.ok(!r.count_note!.includes(n));
    }
  }
});

test("where_is_member: disclosed member away in a PUBLIC group (captured row) -> unknown, because public rosters carry no safety block", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "EarlonDev" }), {
    status: "unknown",
    reason: "not_disclosed",
    nickname: "EarlonDev",
  });
});

for (const name of ["Fred", "John"]) {
  test(`where_is_member: ${name} (withheld) -> unknown, not not_at_area`, async () => {
    const { c } = client();
    assert.deepEqual(await whereIsMember(c, { nickname: name }), {
      status: "unknown",
      reason: "not_disclosed",
      nickname: name,
    });
  });
}

test("where_is_member: stale (captured row, still inside the area) -> unknown/stale, area not returned", async () => {
  const { c } = client();
  const r = await whereIsMember(c, { nickname: "Newman", group_id: SKATE });
  assert.deepEqual(r, { status: "unknown", reason: "stale", nickname: "Newman" });
  assert.ok(!JSON.stringify(r).includes("Skatepark"));
});

test("where_is_member: nobody by that name -> unknown/no_such_member, not an error", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Zebedee" }), {
    status: "unknown",
    reason: "no_such_member",
    nickname: "Zebedee",
  });
});

test("where_is_member: unique partial match is accepted, ambiguous is not", async () => {
  const { c } = client();
  const r = await whereIsMember(c, { nickname: "newm" });
  assert.equal(r.status, "at_area");
  assert.equal(r.nickname, "Newman");
  // "n" matches Newman, John, EarlonDev and Anonymous: genuinely ambiguous.
  const amb = await whereIsMember(c, { nickname: "n" });
  assert.equal(amb.status, "unknown");
  assert.equal(amb.reason, "no_such_member");
});

test("where_is_member: group_id omitted searches every group; at_area beats not_at_area beats unknown", async () => {
  // Newman is at_area in Family and not_at_area in the Skateboard group.
  const { c, calls } = client();
  const r = await whereIsMember(c, { nickname: "Newman" });
  assert.equal(r.status, "at_area");
  if (r.status === "at_area") assert.equal(r.group_name, "Family");
  assert.ok(calls.includes(`/groups/${SKATE}/members`));

  // Withhold his at_area row (Family): the Consent Test Group's
  // disclosed-away row answers, beating the Skateboard group's stale row.
  const routes = defaultRoutes();
  const withhold = (path: string) => {
    const body = (routes[path] as { body: unknown[] }).body.map((m) =>
      (m as { nickname?: string }).nickname === "Newman"
        ? { user_id: (m as { user_id: string }).user_id, nickname: "Newman", inside: false }
        : m,
    );
    routes[path] = { status: 200, body };
  };
  withhold(`/groups/${FAMILY}/members`);
  const r2 = await whereIsMember(client(routes).c, { nickname: "Newman" });
  assert.deepEqual(r2, { status: "not_at_area", nickname: "Newman" });
});

test("where_is_member: unknown group_id -> no_such_member without calling the API for it", async () => {
  const { c, calls } = client();
  const r = await whereIsMember(c, { nickname: "Newman", group_id: "not-a-group" });
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "no_such_member");
  assert.deepEqual(calls, ["/groups"]);
});

test("who_is_at_area: only disclosed members; note when the roster had withheld rows", async () => {
  const { c } = client();
  const r = await whoIsAtArea(c, { group_id: FAMILY, area_name: "skatepark" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Newman"]); // Olga is stale, not listed
    assert.ok(r.undisclosed_note);
    assert.match(r.undisclosed_note!, /^2 members/); // Fred, John
    for (const n of ["Fred", "John"]) assert.ok(!r.undisclosed_note!.includes(n), "note never names anyone");
  }
});

test("who_is_at_area: no withheld rows -> no note", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${FAMILY}/members`] = {
    status: 200,
    body: [
      ...(routes[`/groups/${FAMILY}/members`] as { body: unknown[] }).body.filter((m) =>
        ["Newman"].includes((m as { nickname: string }).nickname),
      ),
    ],
  };
  const { c } = client(routes);
  const r = await whoIsAtArea(c, { group_id: FAMILY, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Newman"]);
    assert.equal(r.undisclosed_note, undefined);
    assert.equal(r.count_note, undefined, "one counted, one listed: nothing to add");
  }
});

test("who_is_at_area: count above the rows listed (captured Skatepark, Newman stale) -> count_note beside the undisclosed note", async () => {
  // The Skateboard group in the default world: the roster is Newman's stale
  // row (unknown, so not listed) and the counts from the same capture are
  // 2/1/0. Two counted, none listed, and the answer says so.
  const { c } = client();
  const r = await whoIsAtArea(c, { group_id: SKATE, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, []);
    assert.match(r.undisclosed_note!, /^1 member /);
    assert.match(r.count_note!, /^2 counted at this area, none listed\./);
    assert.ok(!r.count_note!.includes("Newman"));
  }
});

test("who_is_at_area: count above a roster with nothing withheld (the Ghost-joined or capped shape) -> count_note alone", async () => {
  // Newman's captured at-area row beside the captured Skatepark count of 2:
  // one listed, two counted, no withheld row to hang a note on. This is what
  // a public group serves when a Ghost-joined member is inside, or above its
  // member limit, and without count_note the one row reads as everyone.
  const routes = defaultRoutes();
  routes[`/groups/${SKATE}/members`] = { status: 200, body: fixture("members.disclosed_at_area.json") };
  routes[`/groups/${SKATE}/area-counts`] = { status: 200, body: fixture("area_counts.skateboard.disclosed.json") };
  const { c } = client(routes);
  const r = await whoIsAtArea(c, { group_id: SKATE, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Newman"]);
    assert.equal(r.undisclosed_note, undefined);
    assert.match(r.count_note!, /^2 counted at this area, 1 listed\./);
    assert.match(r.count_note!, /confirmed here/);
  }
});

test("who_is_at_area: unknown area -> unknown/no_such_area", async () => {
  const { c } = client();
  assert.deepEqual(await whoIsAtArea(c, { area_name: "Moon" }), { status: "unknown", reason: "no_such_area" });
});

test("who_is_at_area / count: area_id or area_name is required", async () => {
  const { c } = client();
  await assert.rejects(whoIsAtArea(c, { group_id: FAMILY }), /Provide area_id or area_name/);
  await assert.rejects(countMembersAtArea(c, {}), /Provide area_id or area_name/);
});

test("count_members_at_area: undisclosed present -> floor note 'at least N'", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { area_name: "Skatepark" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.member_count, 1);
    assert.equal(r.undisclosed_count, 1);
    assert.equal(r.stale_count, 0);
    assert.match(r.note, /at least 1/);
    assert.equal(r.group_name, "Family"); // first group in order
  }
});

test("count_members_at_area: captured Skatepark with Newman's consent off -> 1/0/1 and 'at least 1'", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${SKATE}/area-counts`] = { status: 200, body: fixture("area_counts.skateboard.undisclosed.json") };
  const { c } = client(routes);
  const r = await countMembersAtArea(c, { group_id: SKATE, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [1, 0, 1]);
    assert.match(r.note, /at least 1/);
  }
});

test("count_members_at_area: captured Skatepark with Newman stale -> 2/1/0 and 'at least 2'", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { area_id: SKATEPARK, group_id: SKATE });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [2, 1, 0]);
    assert.match(r.note, /at least 2/);
  }
});

test("count_members_at_area: public group with a member consent-off inside (captured) -> 1/0/1 and 'at least 1'", async () => {
  // EarlonDev switched agent access off while inside the park: the count
  // moved him from member_count to undisclosed_count. Newman, Ghost-joined
  // and inside, is the one still counted.
  const routes = defaultRoutes();
  routes[`/groups/${PUBLIC}/area-counts`] = { status: 200, body: fixture("area_counts.public_group.undisclosed.json") };
  const { c } = client(routes);
  const r = await countMembersAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [1, 0, 1]);
    assert.match(r.note, /at least 1/);
  }
});

test("who_is_at_area: public group with the masked member consent-off (captured) -> nobody listed, one withheld, one counted", async () => {
  // Same moment as area_counts.public_group.undisclosed.json: EarlonDev's
  // masked row is now the withheld shape (identity + inside: false), so the
  // mask and the consent gate compose — neither his name nor his presence
  // is on the wire — while Newman is counted with no row.
  const routes = defaultRoutes();
  routes[`/groups/${PUBLIC}/members`] = { status: 200, body: fixture("members.consent_off.public_group.json") };
  routes[`/groups/${PUBLIC}/area-counts`] = { status: 200, body: fixture("area_counts.public_group.undisclosed.json") };
  const { c } = client(routes);
  const r = await whoIsAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, []);
    assert.match(r.undisclosed_note!, /^1 member /);
    assert.match(r.count_note!, /^1 counted at this area, none listed\./);
  }
});

test("public group with the masked member stale inside (captured): where_is_member and who_is_at_area say unknown, count says 'at least 2'", async () => {
  // Same moment: EarlonDev's masked row is inside: true with current_area
  // and safety_status "stale"; the count is 2/1/0 (Newman, Ghost-joined
  // and still fresh, plus EarlonDev stale). No tool presents the stale
  // last-known position as presence, and the count says it is a floor.
  const routes = defaultRoutes();
  routes[`/groups/${PUBLIC}/members`] = { status: 200, body: fixture("members.stale.public_group.json") };
  routes[`/groups/${PUBLIC}/area-counts`] = { status: 200, body: fixture("area_counts.public_group.stale.json") };
  const { c } = client(routes);

  const w = await whereIsMember(c, { nickname: "Anonymous", group_id: PUBLIC });
  assert.deepEqual(w, { status: "unknown", reason: "stale", nickname: "Anonymous" });

  const who = await whoIsAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(who.status, "ok");
  if (who.status === "ok") {
    assert.deepEqual(who.members, []);
    assert.match(who.undisclosed_note!, /^1 member /);
    assert.match(who.count_note!, /^2 counted at this area, none listed\./);
  }

  const n = await countMembersAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(n.status, "ok");
  if (n.status === "ok") {
    assert.deepEqual([n.member_count, n.stale_count, n.undisclosed_count], [2, 1, 0]);
    assert.match(n.note, /at least 2/);
  }
});

test("count_members_at_area: all disclosed and fresh (captured Safeway, nobody inside) -> exact", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { area_name: "Safeway" });
  if (r.status === "ok") {
    assert.equal(r.member_count, 0);
    assert.match(r.note, /exact/);
  } else assert.fail(r.status);
});

test("count_members_at_area: counts absent (the withheld shape, captured from a public group before the fix) -> unknown/count_unavailable, never zero", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${PUBLIC}/area-counts`] = { status: 200, body: fixture("area_counts.public_group.withheld.json") };
  const { c } = client(routes);
  const r = await countMembersAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "count_unavailable");
  assert.ok(!("member_count" in r));
  if (r.reason === "count_unavailable") {
    assert.match(r.note, /archived, or the count could not be computed/);
    assert.ok(!r.note.includes("private"), "public groups are served counts now; the note must not say otherwise");
  }
});

test("count_members_at_area: public group, counts served (captured) -> 2/0/0, one of them Ghost-joined and on no roster", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { group_id: PUBLIC, area_name: "Marymoor Dog Park" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual([r.member_count, r.stale_count, r.undisclosed_count], [2, 0, 0]);
    assert.match(r.note, /exact/);
  }
});

// --- client behaviour ----------------------------------------------------

test("client refuses to fetch /areas even if asked", async () => {
  const { c } = client();
  // Reach the private path through the type system's back door on purpose.
  const anyClient = c as unknown as { get: (p: string) => Promise<unknown> };
  await assert.rejects(anyClient.get(`/groups/${FAMILY}/areas`), /never requests area geometry/);
});

test("429 surfaces as ApiError with Retry-After and is not retried", async () => {
  let hits = 0;
  const routes: Routes = {
    "/groups": () => {
      hits++;
      return { status: 429, headers: { "retry-after": "7" } };
    },
  };
  const { c } = client(routes);
  await assert.rejects(listGroups(c), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 7);
    assert.match(e.message, /rate limit.*Wait 7s/);
    return true;
  });
  assert.equal(hits, 1, "exactly one request");
});

test("401 and 403 name the key; 404 names the group; 5xx says try later", async () => {
  for (const [status, re] of [
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [404, /no such group/],
    [503, /try again later/i],
  ] as const) {
    const { c } = client({ "/groups": { status } });
    await assert.rejects(listGroups(c), (e: unknown) => e instanceof ApiError && re.test(e.message));
  }
});

test("non-array body is an ApiError, not a crash", async () => {
  const { c } = client({ "/groups": { status: 200, body: { error: "weird" } } });
  await assert.rejects(listGroups(c), /unexpected response shape/);
});

test("log lines carry paths, statuses and counts — never the key or a member name", async () => {
  const { c, lines } = client();
  await whereIsMember(c, { nickname: "Newman" });
  await whoIsAtArea(c, { area_name: "Skatepark" });
  await countMembersAtArea(c, { area_name: "Skatepark" });
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(!l.includes(KEY), l);
    assert.ok(!l.includes("pg_live_"), l);
    for (const n of ["Newman", "EarlonDev", "Fred", "John", "MikeL"]) assert.ok(!l.includes(n), l);
    assert.ok(!l.includes("Skatepark"), l);
  }
  assert.match(lines[0]!, /^INFO GET \/groups -> 200 \(9 items, \d+ms\)$/);
});
