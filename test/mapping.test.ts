import { test } from "node:test";
import assert from "node:assert/strict";
import { memberStatus, mergeStatuses } from "../src/core/mapping.js";
import type { WireMember } from "../src/core/types.js";
import { fixture } from "./helpers.js";

function rows(name: string): WireMember[] {
  const r = fixture<WireMember[]>(name);
  assert.ok(r.length >= 1, `${name} holds at least one row`);
  return r;
}

function row(name: string): WireMember {
  const r = rows(name);
  assert.equal(r.length, 1, `${name} holds one row`);
  return r[0]!;
}

test("disclosed member at an area (captured) -> at_area with the area and since", () => {
  const r = row("members.disclosed_at_area.json");
  assert.deepEqual(memberStatus(r), {
    status: "at_area",
    area: { area_id: r.current_area!.id, name: "Skatepark" },
    since: r.last_update,
  });
});

test("disclosed member away (safety surface on) -> not_at_area", () => {
  assert.deepEqual(memberStatus(row("members.disclosed_away.json")), { status: "not_at_area" });
});

test("disclosed member away in a PUBLIC group (captured) -> unknown, never not_at_area", () => {
  // Public rosters carry no safety block, so the row is byte-identical to a
  // withheld one (the same holds on any deployment with the safety surface
  // off); the only safe answer is unknown.
  const r = row("members.disclosed_away.public_group.json");
  assert.deepEqual({ ...r, user_id: "", nickname: "" }, { user_id: "", nickname: "", inside: false });
  assert.deepEqual(memberStatus(r), { status: "unknown", reason: "not_disclosed" });
});

for (const name of ["members.consent_off.json", "members.ghost.json", "members.sharing_off.json"]) {
  test(`${name}: the withheld shape -> unknown (not not_at_area)`, () => {
    for (const r of rows(name)) {
      assert.equal(r.inside, false, "withheld rows say inside: false");
      assert.deepEqual(memberStatus(r), { status: "unknown", reason: "not_disclosed" });
    }
  });
}

test("the three captured withheld shapes (consent-off, global Ghost, sharing-off) are indistinguishable apart from identity", () => {
  const strip = (r: WireMember) => {
    const { user_id: _u, nickname: _n, avatar_url: _a, ...rest } = r;
    return rest;
  };
  const shapes = ["members.consent_off.json", "members.ghost.json", "members.sharing_off.json"].flatMap((n) =>
    rows(n).map(strip),
  );
  assert.ok(shapes.length >= 4);
  for (const s of shapes) assert.deepEqual(s, { inside: false });
});

test("sharing_disabled: true (integration-key wire, captured) -> unknown for every row", () => {
  const rows = fixture<WireMember[]>("members.sharing_off.integration_key.json");
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.sharing_disabled, true);
    assert.deepEqual(memberStatus(r), { status: "unknown", reason: "not_disclosed" });
  }
});

test("captured disclosed-away row: safety names an area of ANOTHER group; still not_at_area, and that area is not returned", () => {
  const r = row("members.disclosed_away.json");
  assert.equal(r.safety_status, "at_area");
  assert.ok(r.safety_area);
  const s = memberStatus(r);
  assert.deepEqual(s, { status: "not_at_area" });
  assert.ok(!JSON.stringify(s).includes(r.safety_area!));
});

test("captured area-counts: private group, nobody inside -> real zeros, all three fields present", () => {
  for (const a of fixture<{ member_count?: number; stale_count?: number; undisclosed_count?: number }[]>(
    "area_counts.consent_test_group.json",
  )) {
    assert.deepEqual([a.member_count, a.stale_count, a.undisclosed_count], [0, 0, 0]);
  }
});

test("stale member still inside an area (captured) -> unknown with reason stale; the last-known area is not returned", () => {
  const r = row("members.stale.json");
  assert.equal(r.inside, true);
  assert.ok(r.current_area, "the wire still carries the last confirmed area");
  assert.deepEqual(memberStatus(r), { status: "unknown", reason: "stale" });
});

test("Ghost-joined member of a public group (captured roster) -> no row at all; the anonymous-join member is served as \"Anonymous\"", () => {
  // The whole Dog Park @ Marymoor roster as served after the backend fix
  // (test/fixtures/README.md, "Public-group Ghost"). Newman joined in Ghost
  // mode and has no row: nothing for this server to map, nothing to leak.
  // EarlonDev joined anonymously and is served under the fixed nickname
  // "Anonymous", with the same placeholder user_id as his named rows.
  const roster = rows("members.ghost_join.public_group.json");
  const newman = row("members.disclosed_at_area.json");
  assert.ok(!roster.some((r) => r.user_id === newman.user_id), "Newman's placeholder ID is not on the roster");
  assert.ok(!roster.some((r) => r.nickname === "Newman"));
  const earlon = row("members.disclosed_away.public_group.json");
  const masked = roster.find((r) => r.user_id === earlon.user_id);
  assert.ok(masked, "EarlonDev is still a member, under a masked row");
  assert.equal(masked.nickname, "Anonymous");
  for (const r of roster) {
    assert.equal(r.safety_status, undefined, "public rosters carry no safety block");
    assert.notEqual(memberStatus(r).status, "not_at_area", "an away row on a public roster is unknown, never not_at_area");
  }
});

test("inside: true without current_area (not a wire shape) -> unknown, defensively", () => {
  assert.deepEqual(memberStatus({ user_id: "x", inside: true }), { status: "unknown", reason: "not_disclosed" });
});

test("merge across groups: at_area > not_at_area > stale > not_disclosed", () => {
  const at = memberStatus(row("members.disclosed_at_area.json"));
  const away = memberStatus(row("members.disclosed_away.json"));
  const stale = memberStatus(row("members.stale.json"));
  const unk = memberStatus(row("members.consent_off.json"));
  assert.deepEqual(mergeStatuses([unk, away, at]), at);
  assert.deepEqual(mergeStatuses([unk, away]), away);
  assert.deepEqual(mergeStatuses([unk, stale]), stale);
  assert.deepEqual(mergeStatuses([unk]), unk);
  assert.deepEqual(mergeStatuses([]), { status: "unknown", reason: "not_disclosed" });
});
