import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUTTONS, bit } from "../../phonepad/web/buttons.js";
import { AXIS_MAX, DEAD_ZONE, box, createTracker, hitTest, shapeStick } from "../../phonepad/web/state.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const { controls } = JSON.parse(read("layout.json"));
const W = 1000, H = 500;
const center = (name) => {
  const { cx, cy, hw } = box(controls.find((c) => c.name === name), W, H);
  return [cx, cy, hw];
};

// Stick shaping

test("inside the dead zone is centred", () => {
  assert.deepEqual(shapeStick(0, 0, 100), { x: 0, y: 0 });
  assert.deepEqual(shapeStick(DEAD_ZONE * 100 - 1, 0, 100), { x: 0, y: 0 });
  assert.deepEqual(shapeStick(-5, 10, 100), { x: 0, y: 0 });
});

test("edge and beyond reach full range, up is negative Y", () => {
  assert.deepEqual(shapeStick(100, 0, 100), { x: AXIS_MAX, y: 0 });
  assert.deepEqual(shapeStick(-300, 0, 100), { x: -AXIS_MAX, y: 0 });
  assert.deepEqual(shapeStick(0, -100, 100), { x: 0, y: -AXIS_MAX });
  assert.deepEqual(shapeStick(0, 250, 100), { x: 0, y: AXIS_MAX });
});

test("rescales past the dead zone, keeps direction, stays integer and in range", () => {
  const half = shapeStick(DEAD_ZONE * 100 + (1 - DEAD_ZONE) * 50, 0, 100);
  assert.equal(half.x, Math.round(AXIS_MAX / 2));
  for (let a = 0; a < 360; a += 7) {
    for (const m of [20, 60, 100, 400]) {
      const dx = m * Math.cos((a * Math.PI) / 180), dy = m * Math.sin((a * Math.PI) / 180);
      const { x, y } = shapeStick(dx, dy, 100);
      assert.ok(Number.isInteger(x) && Number.isInteger(y));
      assert.ok(Math.abs(x) <= AXIS_MAX && Math.abs(y) <= AXIS_MAX);
      assert.ok(Math.hypot(x, y) <= AXIS_MAX + 1);
      assert.ok(Math.abs(Math.atan2(y, x) - Math.atan2(dy, dx)) < 1e-3
        || Math.abs(Math.abs(Math.atan2(y, x) - Math.atan2(dy, dx)) - 2 * Math.PI) < 1e-3);
    }
  }
});

// Hit testing and bitmask

test("hit test finds each control at its centre and nothing on empty space", () => {
  for (const c of controls) {
    const { cx, cy } = box(c, W, H);
    assert.equal(hitTest(controls, cx, cy, W, H), c);
  }
  assert.equal(hitTest(controls, W / 2, H - 1, W, H), null);
});

test("pressing named buttons gives the protocol bitmask", () => {
  const t = createTracker(controls, W, H);
  t.down(1, ...center("A"));
  t.down(2, ...center("X"));
  assert.equal(t.snapshot().b, 5);
  t.down(3, ...center("Right"));
  t.down(4, ...center("LT"));
  assert.equal(t.snapshot().b, 1 | 4 | (1 << 16) | (1 << 6));
});

test("every button maps to its own bit", () => {
  for (const name of BUTTONS) {
    const t = createTracker(controls, W, H);
    t.down(1, ...center(name));
    assert.deepEqual(t.snapshot(), { b: bit(name), lx: 0, ly: 0, rx: 0, ry: 0 });
  }
});

// Pointer tracker

test("stick and button at once, lifting one leaves the other", () => {
  const t = createTracker(controls, W, H);
  const [lx, ly, r] = center("left");
  t.down(1, lx, ly);
  t.move(1, lx, ly - r); // full up
  t.down(2, ...center("A"));
  assert.deepEqual(t.snapshot(), { b: bit("A"), lx: 0, ly: -AXIS_MAX, rx: 0, ry: 0 });
  t.up(2);
  assert.deepEqual(t.snapshot(), { b: 0, lx: 0, ly: -AXIS_MAX, rx: 0, ry: 0 });
  t.down(2, ...center("A"));
  t.up(1);
  assert.deepEqual(t.snapshot(), { b: bit("A"), lx: 0, ly: 0, rx: 0, ry: 0 });
});

test("both sticks report on their own axes", () => {
  const t = createTracker(controls, W, H);
  const [lx, ly, lr] = center("left");
  const [rx, ry, rr] = center("right");
  t.down(1, lx, ly); t.move(1, lx + lr, ly);
  t.down(2, rx, ry); t.move(2, rx, ry + rr);
  assert.deepEqual(t.snapshot(), { b: 0, lx: AXIS_MAX, ly: 0, rx: 0, ry: AXIS_MAX });
});

test("a stick pointer outside its circle still steers that stick", () => {
  const t = createTracker(controls, W, H);
  const [rx, ry] = center("right");
  const [ax, ay] = center("A");
  t.down(1, rx, ry);
  t.move(1, ax, ay); // drag over the A button
  const s = t.snapshot();
  assert.equal(s.b, 0);
  assert.ok(s.rx > 0 && Math.hypot(s.rx, s.ry) > AXIS_MAX - 2);
});

test("a button pointer that slides off keeps its button, never another", () => {
  const t = createTracker(controls, W, H);
  t.down(1, ...center("A"));
  t.move(1, ...center("B"));
  assert.equal(t.snapshot().b, bit("A"));
});

test("cancel releases, unknown pointers and empty space are ignored", () => {
  const t = createTracker(controls, W, H);
  const [lx, ly, r] = center("left");
  t.down(1, lx, ly); t.move(1, lx - r, ly);
  t.down(2, ...center("B"));
  t.cancel(1);
  t.cancel(2);
  assert.equal(t.down(3, W / 2, H - 1), null);
  t.move(3, lx, ly); t.move(9, lx, ly); t.up(9);
  assert.deepEqual(t.snapshot(), { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
});

test("two pointers on one button keep it held until both lift", () => {
  const t = createTracker(controls, W, H);
  const [x, y] = center("Y");
  t.down(1, x, y);
  t.down(2, x + 1, y + 1);
  t.up(1);
  assert.equal(t.snapshot().b, bit("Y"));
  t.up(2);
  assert.equal(t.snapshot().b, 0);
});

test("resize rescales the geometry", () => {
  const t = createTracker(controls, W, H);
  t.resize(2 * W, 2 * H);
  const [lx, ly, r] = center("left");
  t.down(1, 2 * lx, 2 * ly);
  t.move(1, 2 * lx, 2 * (ly + r));
  assert.equal(t.snapshot().ly, AXIS_MAX);
});

// Layout file

test("layout has every button once, both sticks, valid positions", () => {
  const names = controls.filter((c) => c.type === "button").map((c) => c.name);
  assert.deepEqual([...names].sort(), [...BUTTONS].sort());
  assert.deepEqual(controls.filter((c) => c.type === "stick").map((c) => c.name).sort(), ["left", "right"]);
  assert.equal(controls.length, BUTTONS.length + 2);
  for (const c of controls) {
    for (const k of c.type === "stick" ? ["x", "y", "r"] : ["x", "y", "w", "h"]) {
      assert.ok(c[k] >= 0 && c[k] <= 100, `${c.name}.${k}`);
    }
    if (c.type === "button") assert.ok(c.label, `${c.name} label`);
  }
});

test("no two controls overlap on a 2:1 or 16:9 screen", () => {
  for (const [w, h] of [[1000, 500], [1600, 900]]) {
    const bs = controls.map((c) => box(c, w, h));
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const apart = Math.abs(a.cx - b.cx) >= a.hw + b.hw || Math.abs(a.cy - b.cy) >= a.hh + b.hh;
        assert.ok(apart, `${controls[i].name} overlaps ${controls[j].name} at ${w}x${h}`);
      }
    }
    for (const b of bs) assert.ok(b.cx - b.hw >= 0 && b.cx + b.hw <= w && b.cy - b.hh >= 0 && b.cy + b.hh <= h);
  }
});

// Static page checks (no browser in CI)

test("releaseAll lets go of every held control, and stale pointers stay released", () => {
  const t = createTracker(controls, W, H);
  const [lx, ly, r] = center("left");
  t.down(1, lx, ly);
  t.move(1, lx + r, ly); // full right
  t.down(2, ...center("A"));
  t.down(3, ...center("LT"));
  t.releaseAll();
  assert.deepEqual(t.snapshot(), { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  t.move(1, lx - r, ly); // a late move for a released pointer must not revive it
  t.up(2);
  assert.deepEqual(t.snapshot(), { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
  t.down(4, ...center("B")); // new touches still work
  assert.deepEqual(t.snapshot(), { b: bit("B"), lx: 0, ly: 0, rx: 0, ry: 0 });
});

test("page releases everything when hidden or unfocused", () => {
  const js = read("controller.js");
  assert.match(js, /addEventListener\("visibilitychange", \(\) => \{ if \(document\.hidden\) releaseAll\(\); \}\)/);
  assert.match(js, /addEventListener\("pagehide", releaseAll\)/);
  assert.match(js, /addEventListener\("blur", releaseAll\)/);
  assert.match(js, /tracker\.releaseAll\(\); update\(\);/);
});

test("page loads nothing from the network", () => {
  for (const f of ["index.html", "style.css", "controller.js", "state.js", "buttons.js", "net.js", "client.js", "manifest.json"]) {
    const text = read(f);
    assert.doesNotMatch(text, /https?:|\/\/[\w-]+\.[a-z]|@import|url\(/i, f);
  }
});

test("page has the viewport meta, rotate overlay and no-touch-gesture CSS", () => {
  const html = read("index.html");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">/);
  assert.match(html, /id="rotate"[^>]*>Rotate your phone</);
  assert.match(html, /<script type="module" src="controller.js">/);
  const css = read("style.css");
  for (const rule of ["touch-action: none", "user-select: none", "-webkit-user-select: none",
    "-webkit-touch-callout: none", "overflow: hidden"]) {
    assert.ok(css.includes(rule), rule);
  }
  assert.match(css, /@media \(orientation: portrait\)\s*\{\s*#rotate\s*\{\s*display: flex/);
  const js = read("controller.js");
  for (const s of ["setPointerCapture", "pointercancel", "padstate", 'fetch("layout.json")']) {
    assert.ok(js.includes(s), s);
  }
});
