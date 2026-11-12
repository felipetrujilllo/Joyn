import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUTTONS, bit } from "../../phonepad/web/buttons.js";
import {
  AXIS_MAX, DEAD_ZONE, DPAD_DEAD_ZONE, DPAD_OUTER, box, createTracker, dpadBits, hitTest, shapeStick,
} from "../../phonepad/web/state.js";
import { DPAD_BUTTONS, THEMES, THEME_SHAPES, shapeControls } from "../../phonepad/web/layouts.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const readJson = (f) => JSON.parse(read(f));
const index = readJson("layouts/index.json");
const LAYOUTS = index.layouts.map(({ id }) => [id, readJson(`layouts/${id}.json`).controls]);
const { controls } = readJson(`layouts/${index.default}.json`);
const W = 1000, H = 500;
const center = (name) => {
  const { cx, cy, hw } = box(controls.find((c) => c.name === name), W, H);
  return [cx, cy, hw];
};
const DIRS = { Up: [0, -1], Down: [0, 1], Left: [-1, 0], Right: [1, 0] };
/** Where to touch to press `name`: a button's centre, or the dpad 60% out towards that direction. */
const at = (name) => {
  if (!(name in DIRS)) return center(name).slice(0, 2);
  const [cx, cy, r] = center("dpad");
  return [cx + DIRS[name][0] * 0.6 * r, cy + DIRS[name][1] * 0.6 * r];
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
  t.down(3, ...at("Right"));
  t.down(4, ...center("LT"));
  assert.equal(t.snapshot().b, 1 | 4 | (1 << 16) | (1 << 6));
});

test("every button maps to its own bit", () => {
  for (const name of BUTTONS) {
    const t = createTracker(controls, W, H);
    t.down(1, ...at(name));
    assert.deepEqual(t.snapshot(), { b: bit(name), lx: 0, ly: 0, rx: 0, ry: 0 }, name);
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

test("a non-face button pointer that slides off keeps its button, never another", () => {
  const t = createTracker(controls, W, H);
  t.down(1, ...center("LB"));
  t.move(1, ...center("RB"));
  assert.equal(t.snapshot().b, bit("LB"));
}); // face buttons (A/B/X/Y) slide instead since #19: see face.test.mjs

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

test("layout has every button once (as a button or from the one dpad or dpad-mode trackpad), both sticks (stick or trackpad), valid positions", () => {
  for (const [id, controls] of LAYOUTS) {
    const names = controls.filter((c) => c.type === "button").map((c) => c.name);
    const dpads = controls.filter((c) => c.type === "dpad" || (c.type === "trackpad" && c.mode === "dpad"));
    assert.ok(dpads.length <= 1, `${id}: at most one dpad`);
    const provided = [...names, ...dpads.flatMap(() => DPAD_BUTTONS)];
    assert.deepEqual([...provided].sort(), [...BUTTONS].sort());
    const drivers = controls.filter((c) => c.type === "stick" || (c.type === "trackpad" && c.mode !== "dpad"));
    assert.deepEqual(drivers.map((c) => (c.type === "stick" ? c.name : c.mode)).sort(), ["left", "right"]);
    assert.equal(controls.length, names.length + dpads.length + 2);
    for (const c of controls) {
      for (const k of c.type === "button" ? ["x", "y", "w", "h"] : ["x", "y", "r"]) {
        assert.ok(c[k] >= 0 && c[k] <= 100, `${id} ${c.name}.${k}`);
      }
      if (c.type === "button") assert.ok(c.label, `${id} ${c.name} label`);
    }
  }
});

test("no two controls overlap on a 2:1 or 16:9 screen", () => {
  assert.ok(controls.some((c) => c.type === "dpad"), "default layout has the dish dpad, and it is checked below");
  for (const [id, controls] of LAYOUTS) for (const [w, h] of [[1000, 500], [1600, 900]]) {
    const bs = controls.map((c) => box(c, w, h));
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const apart = Math.abs(a.cx - b.cx) >= a.hw + b.hw || Math.abs(a.cy - b.cy) >= a.hh + b.hh;
        assert.ok(apart, `${id}: ${controls[i].name} overlaps ${controls[j].name} at ${w}x${h}`);
      }
    }
    for (const b of bs) assert.ok(b.cx - b.hw >= 0 && b.cx + b.hw <= w && b.cy - b.hh >= 0 && b.cy + b.hh <= h);
  }
});

// D-pad dish

const R = 100;
const polar = (deg, m = 0.6) => [m * R * Math.cos((deg * Math.PI) / 180), -m * R * Math.sin((deg * Math.PI) / 180)];
const bits = (...names) => names.reduce((b, n) => b | bit(n), 0);

test("dpadBits: centre and off-dish press nothing, straight directions press one bit", () => {
  assert.equal(dpadBits(0, 0, R), 0);
  assert.equal(dpadBits(...polar(90, DPAD_DEAD_ZONE - 0.01), R), 0);
  assert.equal(dpadBits(...polar(90, DPAD_DEAD_ZONE + 0.01), R), bit("Up"));
  assert.equal(dpadBits(...polar(0, DPAD_OUTER + 0.05), R), 0);
  assert.equal(dpadBits(...polar(0, 1.5), R), 0);
  assert.equal(dpadBits(...polar(0, 1), R), bit("Right")); // the rim still counts
  assert.equal(dpadBits(0, -60, R), bit("Up")); // screen-up is Up
  assert.equal(dpadBits(0, 60, R), bit("Down"));
  assert.equal(dpadBits(-60, 0, R), bit("Left"));
  assert.equal(dpadBits(60, 0, R), bit("Right"));
});

test("dpadBits: diagonals press two bits, 45-degree sectors", () => {
  assert.equal(dpadBits(...polar(45), R), bits("Up", "Right"));
  assert.equal(dpadBits(...polar(135), R), bits("Up", "Left"));
  assert.equal(dpadBits(...polar(225), R), bits("Down", "Left"));
  assert.equal(dpadBits(...polar(315), R), bits("Down", "Right"));
  assert.equal(dpadBits(...polar(90 - 22), R), bit("Up")); // just inside Up's sector
  assert.equal(dpadBits(...polar(90 - 23), R), bits("Up", "Right")); // just inside the diagonal's
  assert.equal(dpadBits(...polar(-20), R), bit("Right"));
});

test("dpad finger slides between directions without lifting, off the dish releases", () => {
  const t = createTracker(controls, W, H);
  const [cx, cy, r] = center("dpad");
  const go = (deg, m = 0.6) => t.move(1, cx + m * r * Math.cos((deg * Math.PI) / 180), cy - m * r * Math.sin((deg * Math.PI) / 180));
  assert.equal(t.down(1, ...at("Up")).type, "dpad");
  assert.equal(t.snapshot().b, bit("Up"));
  go(45);
  assert.equal(t.snapshot().b, bits("Up", "Right"));
  go(0);
  assert.equal(t.snapshot().b, bit("Right"));
  go(0, 0.1); // back to the centre dead spot
  assert.equal(t.snapshot().b, 0);
  go(270);
  assert.equal(t.snapshot().b, bit("Down"));
  go(270, 2); // slid off the dish
  assert.equal(t.snapshot().b, 0);
  go(180);
  t.down(2, ...at("A"));
  assert.equal(t.snapshot().b, bits("Left", "A"));
  t.up(1);
  assert.equal(t.snapshot().b, bit("A"));
  t.down(3, ...at("Down"));
  t.releaseAll();
  assert.deepEqual(t.snapshot(), { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
});

test("the dpad is a circle: its box corners hit nothing", () => {
  const [cx, cy, r] = center("dpad");
  const d = controls.find((c) => c.type === "dpad");
  assert.equal(hitTest(controls, cx + 0.95 * r, cy + 0.95 * r, W, H), null);
  assert.equal(hitTest(controls, cx + 0.69 * r, cy + 0.69 * r, W, H), d);
});

// Shapes: round buttons hit like they look

const shaped = shapeControls(controls, "xbox");
const sbox = (name) => box(shaped.find((c) => c.name === name), W, H);

test("round theme: square buttons are circles, wide ones pills, every theme has a shape rule", () => {
  for (const n of ["A", "B", "X", "Y", "Back", "Start", "Guide", "L3", "R3"]) {
    assert.equal(shaped.find((c) => c.name === n).shape, "circle", n);
  }
  for (const n of ["LB", "RB", "LT", "RT"]) assert.equal(shaped.find((c) => c.name === n).shape, "pill", n);
  for (const t of THEMES) assert.ok(["round", "rect"].includes(THEME_SHAPES[t]), t);
  assert.ok(shapeControls(controls, "unknown").filter((c) => c.type === "button").every((c) => c.shape === "rect"));
  assert.ok(!("shape" in controls.find((c) => c.name === "A")), "the layout file itself is not changed");
});

test("a circular button misses in its square corner and hits inside its circle", () => {
  for (const n of ["A", "Guide", "L3"]) {
    const { cx, cy, hw } = sbox(n);
    const c = shaped.find((x) => x.name === n);
    assert.equal(hitTest(shaped, cx + 0.9 * hw, cy - 0.9 * hw, W, H), null, `${n} corner`);
    assert.equal(hitTest(shaped, cx + 0.7 * hw, cy - 0.7 * hw, W, H), c, `${n} inside`);
    assert.equal(hitTest(shaped, cx, cy + 0.98 * hw, W, H), c, `${n} edge`);
    assert.equal(hitTest(controls, cx + 0.9 * hw, cy - 0.9 * hw, W, H)?.name, n, "unshaped stays a rectangle");
  }
});

test("a pill hits like a stadium: straight middle, round ends", () => {
  const { cx, cy, hw, hh } = sbox("LB");
  const lb = shaped.find((c) => c.name === "LB");
  assert.equal(hitTest(shaped, cx, cy + 0.95 * hh, W, H), lb); // straight edge reaches the box
  assert.equal(hitTest(shaped, cx + hw - hh, cy + 0.95 * hh, W, H), lb); // where the end cap starts
  assert.equal(hitTest(shaped, cx + 0.97 * hw, cy, W, H), lb); // tip of the end
  assert.equal(hitTest(shaped, cx + 0.97 * hw, cy + 0.9 * hh, W, H), null); // box corner, outside the cap
});

test("drawing matches hitting: the page draws and hit-tests the same shaped controls", () => {
  const js = read("controller.js");
  const show = js.slice(js.indexOf("async function show("), js.indexOf("function place("));
  assert.match(show, /controls = shapeControls\(loaded\.controls, loaded\.theme\);/);
  assert.match(show, /tracker = createTracker\(controls, /);
  assert.match(show, /els = controls\.map\(/);
  assert.match(show, /if \(c\.shape\) el\.dataset\.shape = c\.shape;/);
  const css = read("style.css");
  assert.match(css, /\.button\[data-shape="circle"\], \.button\[data-shape="pill"\] \{ border-radius: 999px; \}/);
  assert.match(css, /\.dpad \{[^}]*border-radius: 50%;/);
  assert.match(css, /\.stick \{[^}]*border-radius: 50%;/);
  // every shape shapeControls can produce is one hitTest and the CSS both handle
  for (const c of shaped.filter((c) => c.type === "button")) {
    assert.ok(c.shape === "rect" || css.includes(`[data-shape="${c.shape}"]`), c.name);
  }
});

test("page lights the pressed D-pad directions", () => {
  const js = read("controller.js");
  assert.match(js, /else if \(c\.type === "dpad"\) \{[^}]*for \(const d of DPAD_BUTTONS\) el\.appendChild/);
  assert.match(js, /DPAD_BUTTONS\.forEach\(\(d, j\) => els\[i\]\.children\[j\]\.classList\.toggle\("on", \(s\.b & bit\(d\)\) !== 0\)\)/);
  const css = read("style.css");
  assert.match(css, /\.dpad \.dir\.on \{/);
  assert.match(css, /\.dpad \.dir\.on::after \{/);
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
  for (const f of ["index.html", "style.css", "controller.js", "state.js", "buttons.js", "layouts.js", "net.js", "client.js", "manifest.json"]) {
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
  for (const s of ["setPointerCapture", "pointercancel", "padstate", "loadLayout((path) => fetch(path), pick)"]) {
    assert.ok(js.includes(s), s);
  }
});
