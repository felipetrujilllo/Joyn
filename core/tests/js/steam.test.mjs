// Steam-Controller-style layout (#17): real steam.json + its theme, checked end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUTTONS, bit } from "../../phonepad/web/buttons.js";
import { AXIS_MAX, box, createTracker } from "../../phonepad/web/state.js";
import {
  ICONS, THEMES, THEME_SHAPES, chooseLayout, layoutProblems, loadLayout, nextLayout, shapeControls,
} from "../../phonepad/web/layouts.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const index = JSON.parse(read("layouts/index.json"));
const steam = JSON.parse(read("layouts/steam.json"));
const NEUTRAL = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
const SCREENS = [[1000, 500], [1600, 900]];
const DPAD = { Up: 90, Down: 270, Left: 180, Right: 0 };

const fakeFetch = (files) => async (path) => ({
  ok: path in files, status: path in files ? 200 : 404, json: async () => JSON.parse(files[path]),
});
const steamCss = () => read("style.css").match(/\[data-theme="steam"\]\s*\{([^}]*)\}/)[1];

test("steam.json: steam theme, left stick, right-stick and D-pad trackpads, no dish or D-pad buttons, valid", () => {
  const cs = steam.controls;
  assert.equal(steam.theme, "steam");
  assert.deepEqual(cs.filter((c) => c.type === "stick").map((c) => c.name), ["left"]);
  assert.deepEqual(cs.filter((c) => c.type === "trackpad").map((c) => c.mode).sort(), ["dpad", "right"]);
  assert.ok(!cs.some((c) => c.type === "dpad"), "no dish");
  assert.ok(!cs.some((c) => ["Up", "Down", "Left", "Right"].includes(c.name)), "no D-pad buttons");
  assert.deepEqual(["Back", "Start", "Guide"].map((n) => cs.find((c) => c.name === n).icon), ["view", "menu", "home"]);
  assert.deepEqual(layoutProblems(steam), []);
});

test("steam: no grips or extras, only the 13 non-D-pad buttons, the left stick and two trackpads", () => {
  const buttons = steam.controls.filter((c) => c.type === "button").map((c) => c.name).sort();
  assert.deepEqual(buttons, BUTTONS.filter((b) => !(b in DPAD)).sort());
  assert.equal(steam.controls.length, 13 + 1 + 2);
});

test("steam: every one of the 17 buttons is reachable and presses exactly its bit; pads and stick drive their axes", () => {
  for (const [W, H] of SCREENS) {
    const cs = shapeControls(steam.controls, "steam");
    const t = createTracker(cs, W, H);
    const at = (name, deg = 0, f = 0) => {
      const { cx, cy, hw } = box(cs.find((c) => c.name === name), W, H);
      const a = (deg * Math.PI) / 180;
      return [cx + Math.cos(a) * f * hw, cy - Math.sin(a) * f * hw];
    };
    for (const b of BUTTONS) {
      const p = b in DPAD ? at("lpad", DPAD[b], 0.6) : at(b);
      t.down(1, ...p);
      assert.deepEqual(t.snapshot(), { ...NEUTRAL, b: bit(b) }, `${b} at ${W}x${H}`);
      t.up(1);
    }
    t.down(1, ...at("rpad", 0, 1));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, rx: AXIS_MAX });
    t.move(1, ...at("rpad", 90, 1));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, ry: -AXIS_MAX });
    t.up(1);
    const [lx, ly] = at("left");
    t.down(1, lx, ly);
    t.move(1, ...at("left", 180, 1));
    assert.deepEqual(t.snapshot(), { ...NEUTRAL, lx: -AXIS_MAX });
    t.releaseAll();
  }
});

test("steam is listed, chosen by ?layout=steam, cycled by the switch, and loads with its theme", async () => {
  assert.ok(index.layouts.some((l) => l.id === "steam" && l.name === "Steam"));
  assert.equal(index.default, "xbox");
  assert.equal(chooseLayout(index, { search: "?k=tok&layout=steam" }), "steam");
  assert.equal(nextLayout(index, "xbox"), "steam");
  assert.equal(nextLayout(index, "steam"), "xbox");
  const f = fakeFetch(Object.fromEntries(["layouts/index.json", "layouts/xbox.json", "layouts/steam.json"].map((p) => [p, read(p)])));
  assert.deepEqual(await loadLayout(f, () => "steam"), { id: "steam", index, controls: steam.controls, theme: "steam" });
  assert.equal((await loadLayout(f, (ix) => nextLayout(ix, "xbox"))).theme, "steam");
});

test("steam theme is registered, round, and neutral: A/B/X/Y share one colour", () => {
  assert.ok(THEMES.includes("steam"));
  assert.equal(THEME_SHAPES.steam, "round");
  const css = steamCss();
  const face = ["--a", "--b", "--x", "--y"].map((v) => css.match(new RegExp(`${v}:\\s*([^;]+);`))[1].trim());
  assert.equal(new Set(face).size, 1, face.join(" "));
});

test("no logos or artwork: steam.json and its CSS block have no images, urls or brand names", () => {
  const json = read("layouts/steam.json");
  for (const c of steam.controls) if (c.icon !== undefined) assert.ok(["home", "view", "menu"].includes(c.icon), c.icon);
  for (const c of steam.controls) assert.doesNotMatch(`${c.label ?? ""} ${c.name}`, /steam|valve/i);
  assert.doesNotMatch(json, /url\(|https?:|<svg|<img|\.png|\.svg|data:/i);
  assert.doesNotMatch(steamCss(), /url\(|https?:|image|data:|valve|logo/i);
  for (const name of ["home", "view", "menu"]) assert.doesNotMatch(ICONS[name], /steam|valve/i);
});
