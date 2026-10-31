import assert from "node:assert/strict";
import { test } from "node:test";
import { ageOn, isAtLeastEighteen, requestedAmountRangeForAge } from "../src/loans.js";

test("age eligibility changes on the eighteenth birthday", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  assert.equal(isAtLeastEighteen(new Date("2008-10-27T00:00:00.000Z"), now), true);
  assert.equal(isAtLeastEighteen(new Date("2008-10-28T00:00:00.000Z"), now), false);
});

test("age-based loan request ranges change on the twenty-sixth birthday", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  assert.equal(ageOn(new Date("2001-10-27T00:00:00.000Z"), now), 25);
  assert.equal(ageOn(new Date("2000-10-27T00:00:00.000Z"), now), 26);
  assert.deepEqual(requestedAmountRangeForAge(18), { min: 1000, max: 30000 });
  assert.deepEqual(requestedAmountRangeForAge(25), { min: 1000, max: 30000 });
  assert.deepEqual(requestedAmountRangeForAge(26), { min: 30000, max: 200000 });
  assert.equal(requestedAmountRangeForAge(17), null);
});
