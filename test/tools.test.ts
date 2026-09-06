import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, PositionGuardClient } from "../src/core/client.js";
import { countMembersAtArea, listAreas, listGroups, whereIsMember, whoIsAtArea } from "../src/core/tools.js";
import { captureLog, defaultRoutes, fakeFetch, FAMILY, PUBLIC, SKATE, SKATEPARK, type Routes } from "./helpers.js";

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
  assert.deepEqual(
    r.groups.map((g) => g.name),
    ["Family", "Skate Crew", "Neighbourhood"],
  );
});

test("list_areas strips counts and tags each area with its group; never calls /areas", async () => {
  const { c, calls } = client();
  const r = await listAreas(c, { group_id: FAMILY });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.areas[0], { area_id: SKATEPARK, name: "Skatepark", group_id: FAMILY, group_name: "Family" });
  for (const a of r.areas) assert.ok(!("member_count" in a));
  assert.ok(calls.every((p) => !/\/areas$/.test(p)), `called: ${calls.join(", ")}`);
});

test("list_areas across every group", async () => {
  const { c } = client();
  const r = await listAreas(c, {});
  assert.deepEqual([...new Set(r.areas.map((a) => a.group_name))], ["Family", "Skate Crew", "Neighbourhood"]);
});

test("where_is_member: at an area", async () => {
  const { c } = client();
  const r = await whereIsMember(c, { nickname: "earl", group_id: FAMILY });
  assert.equal(r.status, "at_area");
  assert.equal(r.nickname, "Earl");
  if (r.status === "at_area") {
    assert.equal(r.area.name, "Skatepark");
    assert.equal(r.since, "2026-09-05T17:41:09.512Z");
    assert.equal(r.group_id, FAMILY);
  }
});

test("where_is_member: disclosed and away", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Fred" }), { status: "not_at_area", nickname: "Fred" });
});

for (const name of ["John", "Nina", "Sam"]) {
  test(`where_is_member: ${name} (withheld) -> unknown, not not_at_area`, async () => {
    const { c } = client();
    assert.deepEqual(await whereIsMember(c, { nickname: name }), {
      status: "unknown",
      reason: "not_disclosed",
      nickname: name,
    });
  });
}

test("where_is_member: stale -> unknown/stale", async () => {
  const { c } = client();
  assert.deepEqual(await whereIsMember(c, { nickname: "Olga" }), { status: "unknown", reason: "stale", nickname: "Olga" });
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
  const r = await whereIsMember(c, { nickname: "ear" });
  assert.equal(r.status, "at_area");
  assert.equal(r.nickname, "Earl");
  // "n" matches Nina, John and Earl-free names... make it genuinely ambiguous:
  const amb = await whereIsMember(c, { nickname: "n" });
  assert.equal(amb.status, "unknown");
  assert.equal(amb.reason, "no_such_member");
});

test("where_is_member: group_id omitted searches every group and prefers a positive row", async () => {
  // Earl's Family row is at_area; make it withheld there and keep Skate Crew's at_area.
  const routes = defaultRoutes();
  const family = (routes[`/groups/${FAMILY}/members`] as { body: unknown[] }).body.map((m) =>
    (m as { nickname?: string }).nickname === "Earl" ? { ...(m as object), inside: false, current_area: undefined, last_update: undefined, safety_status: undefined, safety_area: undefined, position_age_seconds: undefined } : m,
  );
  routes[`/groups/${FAMILY}/members`] = { status: 200, body: JSON.parse(JSON.stringify(family)) };
  const { c, calls } = client(routes);
  const r = await whereIsMember(c, { nickname: "Earl" });
  assert.equal(r.status, "at_area");
  if (r.status === "at_area") assert.equal(r.group_name, "Skate Crew");
  assert.ok(calls.includes(`/groups/${SKATE}/members`));
});

test("where_is_member: unknown group_id -> no_such_member without calling the API for it", async () => {
  const { c, calls } = client();
  const r = await whereIsMember(c, { nickname: "Earl", group_id: "not-a-group" });
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "no_such_member");
  assert.deepEqual(calls, ["/groups"]);
});

test("who_is_at_area: only disclosed members; note when the roster had withheld rows", async () => {
  const { c } = client();
  const r = await whoIsAtArea(c, { group_id: FAMILY, area_name: "skatepark" });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Earl"]); // Olga is stale, not listed
    assert.ok(r.undisclosed_note);
    assert.match(r.undisclosed_note!, /^4 members/); // John, Nina, Sam, Olga
    for (const n of ["John", "Nina", "Sam", "Olga"]) assert.ok(!r.undisclosed_note!.includes(n), "note never names anyone");
  }
});

test("who_is_at_area: no withheld rows -> no note", async () => {
  const routes = defaultRoutes();
  routes[`/groups/${FAMILY}/members`] = {
    status: 200,
    body: [
      ...(routes[`/groups/${FAMILY}/members`] as { body: unknown[] }).body.filter((m) =>
        ["Earl", "Fred"].includes((m as { nickname: string }).nickname),
      ),
    ],
  };
  const { c } = client(routes);
  const r = await whoIsAtArea(c, { group_id: FAMILY, area_id: SKATEPARK });
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.deepEqual(r.members, ["Earl"]);
    assert.equal(r.undisclosed_note, undefined);
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

test("count_members_at_area: stale present -> floor note", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { area_name: "Home", group_id: FAMILY });
  if (r.status === "ok") assert.match(r.note, /at least 2/);
  else assert.fail(r.status);
});

test("count_members_at_area: all disclosed and fresh -> exact", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { area_name: "School" });
  if (r.status === "ok") {
    assert.equal(r.member_count, 0);
    assert.match(r.note, /exact/);
  } else assert.fail(r.status);
});

test("count_members_at_area: counts absent (public group) -> unknown/count_unavailable, never zero", async () => {
  const { c } = client();
  const r = await countMembersAtArea(c, { group_id: PUBLIC, area_name: "Town Square" });
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "count_unavailable");
  assert.ok(!("member_count" in r));
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
  await whereIsMember(c, { nickname: "Earl" });
  await whoIsAtArea(c, { area_name: "Skatepark" });
  await countMembersAtArea(c, { area_name: "Skatepark" });
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(!l.includes(KEY), l);
    assert.ok(!l.includes("pg_live_"), l);
    for (const n of ["Earl", "Fred", "John", "Nina", "Sam", "Olga"]) assert.ok(!l.includes(n), l);
    assert.ok(!l.includes("Skatepark"), l);
  }
  assert.match(lines[0]!, /^INFO GET \/groups -> 200 \(3 items, \d+ms\)$/);
});
