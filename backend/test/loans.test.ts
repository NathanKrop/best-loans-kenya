import assert from "node:assert/strict";
import { test } from "node:test";
import { isAtLeastEighteen } from "../src/loans.js";
import { parseTransactionDate } from "../src/payments.js";

test("age eligibility changes on the eighteenth birthday", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  assert.equal(isAtLeastEighteen(new Date("2008-10-27T00:00:00.000Z"), now), true);
  assert.equal(isAtLeastEighteen(new Date("2008-10-28T00:00:00.000Z"), now), false);
});

test("parses valid Safaricom timestamps from Nairobi time", () => {
  assert.equal(parseTransactionDate("20261027150000")?.toISOString(), "2026-10-27T12:00:00.000Z");
  assert.equal(parseTransactionDate("20261327150000"), undefined);
});
