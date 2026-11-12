// Sliding between face buttons (#19), plus the D-pad + stick combo, on the real shipped layouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bit } from "../../phonepad/web/buttons.js";
import { AXIS_MAX, box, createTracker, hitTest } from "../../phonepad/web/state.js";
import { shapeControls } from "../../phonepad/web/layouts.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const NEUTRAL = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
const SCREENS = [[1000, 500], [1600, 900]];
const bits = (...names) => names.reduce((b, n) => b | bit(n), 0);

/** Every shipped layout at every test screen size, with helpers to find touch points. */
function* cases() {
  for (const id of ["xbox", "steam"]) {
    const { controls, theme } = JSON.parse(read(`layouts/${id}.json`));
    const cs = shapeControls(controls, theme);
    for (const [W, H] of SCREENS) {
      const geo = (name) => box(cs.find((c) => c.name === name), W, H);
      const at = (name, deg = 0, f = 0) => {
        const { cx, cy, hw } = geo(name);
        const a = (deg * Math.PI) / 180;
        return [cx + Math.cos(a) * f * hw, cy - Math.sin(a) * f * hw];
      };
      const dpad = cs.find((c) => c.type === "dpad" || c.mode === "dpad").name;
      yield { id: `${id} ${W}x${H}`, cs, W, H, geo, at, dpad, t: createTracker(cs, W, H) };
    }
  }
}

test("slide A -> B -> Y -> X without lifting: exactly the face button under the finger", () => {
  for (const { id, t, at } of cases()) {
    t.down(1, ...at("A"));
    assert.equal(t.snapshot().b, bit("A"), id);
    for (const n of ["B", "Y", "X", "A"]) {
      t.move(1, ...at(n));
      assert.equal(t.snapshot().b, bit(n), `${n} on ${id}`);
    }
    t.up(1);
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
  }
});

test("a gap between face buttons keeps the last one; far away releases; back on a face button presses again", () => {
  for (const { id, cs, W, H, t, at, geo } of cases()) {
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    t.down(1, ...at("A"));
    t.move(1, ...mid(at("A"), at("B")));
    assert.equal(hitTest(cs, ...mid(at("A"), at("B")), W, H), null, `gap is empty on ${id}`);
    assert.equal(t.snapshot().b, bit("A"), `gap keeps A on ${id}`);
    t.move(1, ...at("B"));
    t.move(1, ...mid(at("B"), at("X"))); // diamond centre
    assert.equal(t.snapshot().b, bit("B"), `centre keeps B on ${id}`);
    // Rule: released beyond one button width (w) from every face edge, held within it.
    const a = geo("A"), w = 2 * a.hw;
    t.move(1, a.cx, a.cy + a.hh + 0.5 * w);
    assert.equal(t.snapshot().b, bit("B"), `half a width out still holds on ${id}`);
    const far = [a.cx, a.cy + a.hh + 1.2 * w];
    assert.equal(hitTest(cs, ...far, W, H), null, `far point is empty on ${id}`);
    t.move(1, ...far);
    assert.deepEqual(t.snapshot(), NEUTRAL, `far releases on ${id}`);
    t.move(1, a.cx, a.cy + a.hh + 0.5 * w); // coming back near does not re-press
    assert.equal(t.snapshot().b, 0, id);
    t.move(1, ...at("Y"));
    assert.equal(t.snapshot().b, bit("Y"), `back on Y on ${id}`);
    t.up(1);
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
  }
});

test("a face finger sliding onto a stick, the D-pad, a shoulder or Back/Start/Guide presses none and releases", () => {
  for (const { id, cs, t, at, dpad } of cases()) {
    const stick = cs.find((c) => c.name === "right" || c.mode === "right").name;
    for (const target of [[stick], [dpad, 90, 0.6], ["left"], ["RB"], ["RT"], ["LB"], ["Back"], ["Start"], ["Guide"], ["R3"]]) {
      t.down(1, ...at("B"));
      t.move(1, ...at(...target));
      assert.deepEqual(t.snapshot(), NEUTRAL, `B -> ${target[0]} on ${id}`);
      t.move(1, ...at("A")); // still a face finger: back on a face button presses it
      assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit("A") }, `${target[0]} -> A on ${id}`);
      t.up(1);
    }
  }
});

test("fingers that went down elsewhere never press a face button by sliding onto it", () => {
  for (const { id, W, H, t, at, dpad } of cases()) {
    for (const start of [["LB"], ["Start"], ["RT"], ["left"], [dpad, 90, 0.6]]) {
      t.down(1, ...at(...start));
      const before = t.snapshot();
      t.move(1, ...at("A"));
      assert.equal(t.snapshot().b & bits("A", "B", "X", "Y"), 0, `${start[0]} -> A on ${id}`);
      if (start[0] === "LB" || start[0] === "Start") assert.deepEqual(t.snapshot(), before, `${start[0]} stays held on ${id}`);
      t.up(1);
    }
    assert.equal(t.down(1, W / 2, H - 1), null, `empty space on ${id}`);
    t.move(1, ...at("A"));
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
    t.up(1);
  }
});

test("one finger slides across face buttons while another holds the left stick or the D-pad", () => {
  for (const { id, t, at, dpad } of cases()) {
    t.down(1, ...at("left"));
    t.move(1, ...at("left", 90, 1));
    t.down(2, ...at("A"));
    t.move(2, ...at("Y"));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit("Y"), ly: -AXIS_MAX }, id);
    t.up(1);
    t.down(1, ...at(dpad, 0, 0.6));
    t.move(2, ...at("X"));
    assert.equal(t.snapshot().b, bits("Right", "X"), id);
    t.move(1, ...at(dpad, 45, 0.6)); // D-pad diagonal while sliding
    t.move(2, ...at("B"));
    assert.equal(t.snapshot().b, bits("Up", "Right", "B"), id);
    t.up(2);
    assert.equal(t.snapshot().b, bits("Up", "Right"), id);
    t.releaseAll();
  }
});

test("D-pad and left stick at once on the real layouts: independent, sliding the D-pad keeps the stick", () => {
  for (const { id, t, at, dpad } of cases()) {
    t.down(1, ...at("left"));
    t.move(1, ...at("left", 0, 1));
    t.down(2, ...at(dpad, 90, 0.6));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit("Up"), lx: AXIS_MAX }, id);
    t.move(2, ...at(dpad, 0, 0.6));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit("Right"), lx: AXIS_MAX }, id);
    t.move(2, ...at(dpad, 0, 0.1)); // centre dead spot
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, lx: AXIS_MAX }, id);
    t.move(2, ...at(dpad, 0, 2)); // slid off
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, lx: AXIS_MAX }, id);
    t.up(1);
    t.move(2, ...at(dpad, 270, 0.6));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit("Down") }, id);
    t.releaseAll();
  }
});

test("two fingers on face buttons press both; lifting one leaves the other; releaseAll and cancel are neutral", () => {
  for (const { id, t, at } of cases()) {
    t.down(1, ...at("A"));
    t.down(2, ...at("B"));
    assert.equal(t.snapshot().b, bits("A", "B"), id);
    t.move(2, ...at("Y"));
    assert.equal(t.snapshot().b, bits("A", "Y"), id);
    t.up(1);
    assert.equal(t.snapshot().b, bit("Y"), id);
    t.cancel(2);
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
    t.down(1, ...at("X"));
    t.move(1, ...at("A"));
    t.releaseAll();
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
    t.move(1, ...at("B")); // stale pointer after releaseAll stays released
    assert.deepEqual(t.snapshot(), NEUTRAL, id);
  }
});

test("the page lights buttons from the snapshot bits, so a sliding finger lights the face button it is on", () => {
  const js = read("controller.js");
  assert.match(js, /const s = tracker\.snapshot\(\);/);
  assert.match(js, /c\.type === "button"\) \{ els\[i\]\.classList\.toggle\("on", \(s\.b & bit\(c\.name\)\) !== 0\)/);
});
