// Trackpad control (#16): a round pad that drives a stick's axes or acts as a D-pad.
// Tested on fake layouts built from xbox.json, since no shipped layout uses trackpads yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bit } from "../../phonepad/web/buttons.js";
import { AXIS_MAX, DEAD_ZONE, DPAD_OUTER, box, createTracker, hitTest } from "../../phonepad/web/state.js";
import { SWITCH_ZONE, layoutProblems } from "../../phonepad/web/layouts.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const xbox = JSON.parse(read("layouts/xbox.json"));
const W = 1000, H = 500;
const NEUTRAL = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

/** xbox.json controls with the controls named in `swaps` replaced in place (same geometry) by `swaps[name]` fields. */
const swap = (swaps) => xbox.controls.map((c) => (c.name in swaps ? { x: c.x, y: c.y, r: c.r, ...swaps[c.name] } : { ...c }));
const find = (cs, name) => cs.find((c) => c.name === name);
// Right stick -> right-mode trackpad, dish -> dpad-mode trackpad.
const pads = swap({
  right: { type: "trackpad", name: "rpad", mode: "right" },
  dpad: { type: "trackpad", name: "dpad", mode: "dpad" },
});
const geo = (name, cs = pads) => {
  const { cx, cy, hw } = box(find(cs, name), W, H);
  return [cx, cy, hw];
};
/** Touch `name` at `f` radii out towards angle `deg` (counter-clockwise from screen-right). */
const touchAt = (name, deg, f, cs = pads) => {
  const [cx, cy, r] = geo(name, cs);
  const a = (deg * Math.PI) / 180;
  return [cx + Math.cos(a) * f * r, cy - Math.sin(a) * f * r];
};

test("fake trackpad layout is itself valid", () => {
  assert.deepEqual(layoutProblems({ controls: pads }), []);
});

// Stick mode

test("stick mode: centre is neutral, edge is full, up is negative, dead zone is 0", () => {
  const leftPad = swap({ left: { type: "trackpad", name: "lpad", mode: "left" } });
  const t = createTracker(leftPad, W, H);
  t.down(1, ...touchAt("lpad", 0, 0, leftPad));
  assert.deepEqual(t.snapshot(), NEUTRAL);
  t.move(1, ...touchAt("lpad", 0, 1, leftPad)); // right edge
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, lx: AXIS_MAX });
  t.move(1, ...touchAt("lpad", 90, 1, leftPad)); // top edge
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, ly: -AXIS_MAX });
  t.move(1, ...touchAt("lpad", 200, DEAD_ZONE - 0.02, leftPad));
  assert.deepEqual(t.snapshot(), NEUTRAL);
  t.move(1, ...touchAt("lpad", 180, 0.5, leftPad)); // halfway left: partial, not full
  const s = t.snapshot();
  assert.ok(s.lx < 0 && s.lx > -AXIS_MAX && s.ly === 0, JSON.stringify(s));
  // touching (not dragging from the centre) is absolute: a fresh touch at the edge is full at once
  t.up(1);
  t.down(2, ...touchAt("lpad", 270, 1, leftPad));
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, ly: AXIS_MAX });
});

test("stick mode: a right-mode pad drives rx/ry, not lx/ly", () => {
  const t = createTracker(pads, W, H);
  assert.equal(t.down(1, ...touchAt("rpad", 0, 1)).type, "trackpad");
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, rx: AXIS_MAX });
  t.move(1, ...touchAt("rpad", 270, 1));
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, ry: AXIS_MAX });
});

// D-pad mode

test("dpad mode: each part presses its direction, diagonals two, centre none", () => {
  const t = createTracker(pads, W, H);
  for (const [deg, want] of [[90, bit("Up")], [270, bit("Down")], [180, bit("Left")], [0, bit("Right")],
    [45, bit("Up") | bit("Right")], [225, bit("Down") | bit("Left")]]) {
    t.down(1, ...touchAt("dpad", deg, 0.6));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: want }, `${deg} deg`);
    t.up(1);
  }
  t.down(1, ...touchAt("dpad", 0, 0));
  assert.deepEqual(t.snapshot(), NEUTRAL);
});

test("dpad mode: sliding between directions without lifting, off the pad releases", () => {
  const t = createTracker(pads, W, H);
  t.down(1, ...touchAt("dpad", 90, 0.6));
  assert.equal(t.snapshot().b, bit("Up"));
  t.move(1, ...touchAt("dpad", 0, 0.6));
  assert.equal(t.snapshot().b, bit("Right"));
  t.move(1, ...touchAt("dpad", 270, 0.6));
  assert.equal(t.snapshot().b, bit("Down"));
  t.move(1, ...touchAt("dpad", 270, DPAD_OUTER + 0.1));
  assert.equal(t.snapshot().b, 0);
  t.move(1, ...touchAt("dpad", 180, 0.6)); // back on the pad: still bound, presses again
  assert.equal(t.snapshot().b, bit("Left"));
});

// Several fingers, letting go

test("stick-mode pad + dpad-mode pad + button at once; lifting one leaves the others; releaseAll is neutral", () => {
  const t = createTracker(pads, W, H);
  t.down(1, ...touchAt("rpad", 90, 1));
  t.down(2, ...touchAt("dpad", 180, 0.6));
  t.down(3, ...geo("A").slice(0, 2));
  const [lx, ly, lr] = geo("left");
  t.down(4, lx, ly); t.move(4, lx + lr, ly);
  assert.deepEqual(t.snapshot(), { b: bit("Left") | bit("A"), lx: AXIS_MAX, ly: 0, rx: 0, ry: -AXIS_MAX });
  t.up(2);
  assert.deepEqual(t.snapshot(), { b: bit("A"), lx: AXIS_MAX, ly: 0, rx: 0, ry: -AXIS_MAX });
  t.up(1);
  assert.deepEqual(t.snapshot(), { b: bit("A"), lx: AXIS_MAX, ly: 0, rx: 0, ry: 0 });
  t.down(5, ...touchAt("rpad", 0, 1));
  t.down(6, ...touchAt("dpad", 90, 0.6));
  t.releaseAll();
  assert.deepEqual(t.snapshot(), NEUTRAL);
});

test("letting go of a pad is neutral (axes 0, bits cleared), also via cancel", () => {
  const t = createTracker(pads, W, H);
  t.down(1, ...touchAt("rpad", 30, 1));
  t.down(2, ...touchAt("dpad", 45, 0.6));
  assert.notDeepEqual(t.snapshot(), NEUTRAL);
  t.up(1);
  t.cancel(2);
  assert.deepEqual(t.snapshot(), NEUTRAL);
  assert.equal(t.finger(find(pads, "rpad")), null);
});

test("two fingers on one stick-mode pad: the last one down wins until it lifts", () => {
  const t = createTracker(pads, W, H);
  t.down(1, ...touchAt("rpad", 0, 1));
  t.down(2, ...touchAt("rpad", 180, 1));
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, rx: -AXIS_MAX });
  t.move(1, ...touchAt("rpad", 90, 1)); // the older finger moving changes nothing
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, rx: -AXIS_MAX });
  t.up(2);
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, ry: -AXIS_MAX });
});

test("finger(): offset of the touch on a pad, clamped to its rim, null when untouched", () => {
  const t = createTracker(pads, W, H);
  const rpad = find(pads, "rpad");
  const [cx, cy, r] = geo("rpad");
  assert.equal(t.finger(rpad), null);
  t.down(1, cx + 0.3 * r, cy - 0.2 * r);
  assert.deepEqual(t.finger(rpad), { dx: 0.3 * r, dy: -0.2 * r });
  t.move(1, cx, cy + 3 * r); // dragged far off: the dot stays on the rim
  assert.deepEqual(t.finger(rpad), { dx: 0, dy: r });
  t.move(1, cx, cy);
  assert.deepEqual(t.finger(rpad), { dx: 0, dy: 0 });
  t.up(1);
  assert.equal(t.finger(rpad), null);
});

test("only a trackpad's mode counts: a stick with a stray mode still acts as a stick", () => {
  const stray = swap({ left: { type: "stick", name: "left", mode: "dpad" } });
  const t = createTracker(stray, W, H);
  t.down(1, ...touchAt("left", 90, 1, stray)); // top edge of the left stick
  assert.deepEqual(t.snapshot(), { ...NEUTRAL, ly: -AXIS_MAX }); // stick values, no D-pad bits
});

test("a trackpad is a circle: its box corners hit nothing", () => {
  const [cx, cy, r] = geo("rpad");
  const rpad = find(pads, "rpad");
  assert.equal(hitTest(pads, cx + 0.95 * r, cy - 0.95 * r, W, H), null);
  assert.equal(hitTest(pads, cx + 0.69 * r, cy - 0.69 * r, W, H), rpad);
});

// Validator

test("validator: left trackpad + right stick + dpad-mode trackpad + the other buttons is valid", () => {
  const cs = swap({
    left: { type: "trackpad", name: "lpad", mode: "left" },
    dpad: { type: "trackpad", name: "dpad", mode: "dpad" },
  });
  assert.ok(find(cs, "right").type === "stick");
  assert.deepEqual(layoutProblems({ controls: cs }), []);
});

test("validator: each stick driven exactly once, by a stick or a trackpad", () => {
  const both = [...pads, { type: "trackpad", name: "lpad", mode: "left", x: 50, y: 50, r: 2 }];
  assert.deepEqual(layoutProblems({ controls: both }), ["left stick is driven 2 times"]);
  const noRight = pads.filter((c) => c.name !== "rpad");
  assert.deepEqual(layoutProblems({ controls: noRight }), ["right stick is missing"]);
  const misnamed = swap({ right: { type: "stick", name: "middle" } });
  assert.deepEqual(layoutProblems({ controls: misnamed }), ["middle: a stick must be named left or right", "right stick is missing"]);
});

test("validator: unknown or missing trackpad mode is reported", () => {
  for (const mode of ["up", undefined, "toString"]) {
    const cs = pads.map((c) => (c.name === "rpad" ? { ...c, mode } : c));
    assert.deepEqual(layoutProblems({ controls: cs }), [`rpad: unknown mode ${mode}`, "right stick is missing"], String(mode));
  }
});

test("validator: a dpad-mode trackpad provides Up/Down/Left/Right once", () => {
  const extraUp = [...pads, { type: "button", name: "Up", label: "U", x: 50, y: 50, w: 4, h: 4 }];
  assert.deepEqual(layoutProblems({ controls: extraUp }), ["Up appears 2 times"]);
  const withDish = [...pads, { type: "dpad", name: "dish", x: 50, y: 50, r: 2 }];
  assert.deepEqual(layoutProblems({ controls: withDish }),
    ["Up appears 2 times", "Down appears 2 times", "Left appears 2 times", "Right appears 2 times"]);
});

test("validator: trackpad position in range, on screen, not overlapping, clear of the switch", () => {
  const edit = (name, fields) => ({ controls: pads.map((c) => (c.name === name ? { ...c, ...fields } : c)) });
  assert.deepEqual(layoutProblems(edit("rpad", { r: 120 })), ["rpad: r must be a number 0..100"]);
  assert.deepEqual(layoutProblems(edit("rpad", { x: undefined })), ["rpad: x must be a number 0..100"]);
  const a = find(pads, "A");
  const over = layoutProblems(edit("rpad", { x: a.x, y: a.y }));
  assert.ok(over.includes("rpad overlaps A at 1000x500"), over.join("; "));
  const off = layoutProblems(edit("dpad", { y: 95 }));
  assert.ok(off.includes("dpad goes off-screen at 1600x900"), off.join("; "));
  const sw = layoutProblems(edit("rpad", { x: SWITCH_ZONE.x, y: 20, r: 10 }));
  assert.ok(sw.includes("rpad overlaps the layout switch at 1000x500"), sw.join("; "));
});

test("validator: the real xbox layout still has no problems", () => {
  assert.deepEqual(layoutProblems(xbox), []);
});

// Drawing (static checks, no browser in CI)

test("page draws a trackpad as a pad with a dot (no knob) that follows the finger", () => {
  const js = read("controller.js");
  assert.match(js, /else if \(c\.type === "trackpad"\) el\.appendChild\(document\.createElement\("div"\)\)\.className = "dot";/);
  const dots = js.slice(js.indexOf("function drawDots("), js.indexOf("function update("));
  assert.match(dots, /const f = tracker\.finger\(c\);/);
  assert.match(dots, /classList\.toggle\("on", f !== null\)/);
  assert.match(dots, /style\.transform = `translate\(\$\{f\.dx\}px, \$\{f\.dy\}px\)`/);
  const update = js.slice(js.indexOf("function update("));
  assert.ok(update.indexOf("drawDots();") < update.indexOf("if (key === last) return;"), "dots redraw even when the snapshot is unchanged");
  assert.match(update, /if \(c\.type === "trackpad"\) return;/); // never treated as a stick knob
});

test("trackpad CSS is a flat circle coloured from the theme, dot hidden until touched", () => {
  const css = read("style.css");
  const theme = css.match(/\[data-theme="xbox"\]\s*\{([^}]*)\}/)[1];
  for (const v of ["--trackpad", "--trackpad-ring", "--trackpad-dot"]) {
    assert.match(theme, new RegExp(`${v}:`), `xbox defines ${v}`);
    assert.ok(css.includes(`var(${v})`), `base uses ${v}`);
  }
  assert.match(css, /\.trackpad \{[^}]*border-radius: 50%;/);
  assert.match(css, /\.trackpad \.dot \{[^}]*visibility: hidden;/);
  assert.match(css, /\.trackpad \.dot\.on \{ visibility: visible; \}/);
});
