import { test } from "node:test";
import assert from "node:assert/strict";
import { BUTTONS, bit } from "../../phonepad/web/buttons.js";

test("bit order matches the protocol", () => {
  assert.equal(BUTTONS.length, 17);
  assert.equal(bit("A"), 1);
  assert.equal(bit("Guide"), 1 << 10);
  assert.equal(bit("Right"), 1 << 16);
});

test("unknown button throws", () => {
  assert.throws(() => bit("Z"), /unknown button/);
});
