import { test } from "node:test";
import assert from "node:assert/strict";
import { memberStatus, mergeStatuses } from "../src/core/mapping.js";
import type { WireMember } from "../src/core/types.js";
import { fixture } from "./helpers.js";

function row(name: string): WireMember {
  const rows = fixture<WireMember[]>(name);
  assert.equal(rows.length, 1, `${name} holds one row`);
  return rows[0]!;
}

test("disclosed member at an area -> at_area with the area and since", () => {
  assert.deepEqual(memberStatus(row("members.disclosed_at_area.json")), {
    status: "at_area",
    area: { area_id: "00000000-0000-4000-8000-0000000000b1", name: "Skatepark" },
    since: "2026-09-05T17:41:09.512Z",
  });
});

test("disclosed member away (safety surface on) -> not_at_area", () => {
  assert.deepEqual(memberStatus(row("members.disclosed_away.json")), { status: "not_at_area" });
});

test("disclosed member away on a deployment with the safety surface off -> unknown, never not_at_area", () => {
  // The row is byte-identical to a withheld row, so the only safe answer is unknown.
  assert.deepEqual(memberStatus(row("members.disclosed_away.safety_off.json")), {
    status: "unknown",
    reason: "not_disclosed",
  });
});

for (const name of ["members.consent_off.json", "members.ghost.json", "members.sharing_off.json"]) {
  test(`${name}: the withheld shape -> unknown (not not_at_area)`, () => {
    const r = row(name);
    assert.equal(r.inside, false, "withheld rows say inside: false");
    assert.deepEqual(memberStatus(r), { status: "unknown", reason: "not_disclosed" });
  });
}

test("the three withheld shapes are indistinguishable apart from identity", () => {
  const strip = (name: string) => {
    const { user_id: _u, nickname: _n, avatar_url: _a, ...rest } = row(name);
    return rest;
  };
  assert.deepEqual(strip("members.consent_off.json"), strip("members.ghost.json"));
  assert.deepEqual(strip("members.ghost.json"), strip("members.sharing_off.json"));
});

test("sharing_disabled: true (integration-key wire) -> unknown", () => {
  assert.deepEqual(memberStatus(row("members.sharing_off.integration_key.json")), {
    status: "unknown",
    reason: "not_disclosed",
  });
});

test("stale member still inside an area -> unknown with reason stale; the last-known area is not returned", () => {
  const r = row("members.stale.json");
  assert.equal(r.inside, true);
  assert.ok(r.current_area, "the wire still carries the last confirmed area");
  assert.deepEqual(memberStatus(r), { status: "unknown", reason: "stale" });
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
