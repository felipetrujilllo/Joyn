import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  ICONS, SWITCH_ZONE, THEMES, chooseLayout, layoutProblems, loadLayout, nextLayout, saveLayout, savedLayout,
} from "../../phonepad/web/layouts.js";

const WEB = new URL("../../phonepad/web/", import.meta.url);
const read = (f) => readFileSync(new URL(f, WEB), "utf8");
const index = JSON.parse(read("layouts/index.json"));
const xbox = JSON.parse(read("layouts/xbox.json"));

/** xbox.json with `edit` applied to a deep copy of its controls. */
const variant = (edit) => {
  const controls = structuredClone(xbox.controls);
  edit(controls);
  return { controls };
};
const find = (controls, name) => controls.find((c) => c.name === name);

/** A fetch stand-in serving `files` (path -> text); missing paths are 404. */
const fakeFetch = (files) => async (path) => ({
  ok: path in files,
  status: path in files ? 200 : 404,
  json: async () => JSON.parse(files[path]),
});
const served = (extra = {}) => fakeFetch({
  "layouts/index.json": read("layouts/index.json"),
  "layouts/xbox.json": read("layouts/xbox.json"),
  ...extra,
});

// Real layout files

test("index lists every layout file once, and its default is listed", () => {
  const ids = index.layouts.map((l) => l.id);
  const files = readdirSync(new URL("layouts/", WEB)).filter((f) => f !== "index.json");
  assert.deepEqual(files.sort(), ids.map((id) => `${id}.json`).sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(index.default));
  assert.equal(index.default, "xbox");
  for (const l of index.layouts) assert.ok(l.name, `${l.id} name`);
});

test("every listed layout has no problems", () => {
  for (const { id } of index.layouts) {
    assert.deepEqual(layoutProblems(JSON.parse(read(`layouts/${id}.json`))), [], id);
  }
});

// Validator

test("validator reports a missing button", () => {
  const p = layoutProblems(variant((cs) => cs.splice(cs.indexOf(find(cs, "Guide")), 1)));
  assert.deepEqual(p, ["Guide is missing"]);
});

test("validator reports a duplicate button", () => {
  const p = layoutProblems(variant((cs) => { find(cs, "Back").name = "Start"; }));
  assert.ok(p.includes("Start appears 2 times"), p.join("; "));
  assert.ok(p.includes("Back is missing"), p.join("; "));
});

test("validator reports a third stick", () => {
  const p = layoutProblems(variant((cs) => cs.push({ type: "stick", name: "left", x: 50, y: 50, r: 2 })));
  assert.deepEqual(p, ["sticks must be left and right, got [left,left,right]"]);
});

test("validator reports a position outside 0..100", () => {
  const p = layoutProblems(variant((cs) => { find(cs, "A").x = 120; }));
  assert.deepEqual(p, ["A: x must be a number 0..100"]);
});

test("validator reports two overlapping buttons", () => {
  const p = layoutProblems(variant((cs) => { Object.assign(find(cs, "B"), { x: find(cs, "A").x, y: find(cs, "A").y }); }));
  assert.ok(p.includes("B overlaps A at 1000x500"), p.join("; "));
  assert.ok(p.includes("B overlaps A at 1600x900"), p.join("; "));
});

test("validator reports a control going off-screen", () => {
  const p = layoutProblems(variant((cs) => { find(cs, "LT").x = 1; }));
  assert.ok(p.includes("LT goes off-screen at 1000x500"), p.join("; "));
});

test("validator reports malformed files", () => {
  assert.deepEqual(layoutProblems(null), ["no controls list"]);
  assert.deepEqual(layoutProblems({ controls: "nope" }), ["no controls list"]);
  assert.ok(layoutProblems(variant((cs) => { find(cs, "A").type = "pad"; })).includes("A: unknown type pad"));
  assert.ok(layoutProblems(variant((cs) => { delete find(cs, "A").label; })).includes("A: no label"));
  assert.ok(layoutProblems(variant((cs) => { find(cs, "left").r = "22"; })).includes("left: r must be a number 0..100"));
  assert.ok(layoutProblems(variant((cs) => { find(cs, "A").name = "Z"; })).includes("unknown button Z"));
});

// Loader: controls or a short message, never a throw

test("loader returns the default layout's controls", async () => {
  assert.deepEqual(await loadLayout(served()), { id: "xbox", index, controls: xbox.controls, theme: "xbox" });
});

test("loader turns a missing layout file into a message", async () => {
  const r = await loadLayout(fakeFetch({ "layouts/index.json": read("layouts/index.json") }));
  assert.deepEqual(r, { error: "Couldn't load the controller layout (xbox): layouts/xbox.json returned 404" });
});

test("loader turns a missing index into a message", async () => {
  const r = await loadLayout(fakeFetch({}));
  assert.deepEqual(r, { error: "Couldn't load the controller layout (?): layouts/index.json returned 404" });
});

test("loader turns broken JSON into a message", async () => {
  const r = await loadLayout(served({ "layouts/xbox.json": '{"controls": [' }));
  assert.match(r.error, /^Couldn't load the controller layout \(xbox\): \S/);
  assert.equal(r.controls, undefined);
});

test("loader turns an index without a usable default into a message", async () => {
  for (const text of ["{}", '{"default": "../x"}', '{"default": 3}']) {
    const r = await loadLayout(served({ "layouts/index.json": text }));
    assert.deepEqual(r, { error: "Couldn't load the controller layout (?): layouts/index.json has no valid default" }, text);
  }
});

test("loader turns validator problems into a short message", async () => {
  const bad = variant((cs) => { find(cs, "A").x = 120; find(cs, "Guide").name = "B"; });
  const r = await loadLayout(served({ "layouts/xbox.json": JSON.stringify(bad) }));
  assert.match(r.error, /^Couldn't load the controller layout \(xbox\): A: x must be a number 0\.\.100 \(\+\d+ more\)$/);
});

test("loader survives fetch itself failing (server gone)", async () => {
  const r = await loadLayout(async () => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(r, { error: "Couldn't load the controller layout (?): Failed to fetch" });
});

test("page shows the loader's message instead of starting the controls", () => {
  const js = read("controller.js");
  assert.match(js, /import \{[^}]*\bloadLayout\b[^}]*\} from "\.\/layouts\.js";/);
  assert.match(js, /if \(loaded\.error\) \{\s*pad\.className = "error";\s*pad\.textContent = loaded\.error;[^}]*return false;/);
  assert.match(js, /if \(!\(await show\([^\n]*\)\)\) \{\s*throw/); // a failed first load stops before wiring listeners
  assert.ok(js.indexOf("if (loaded.error)") < js.indexOf("createTracker(controls"));
  assert.doesNotMatch(js, /layout\.json/);
  assert.match(read("style.css"), /#pad\.error \{/);
});

test("validator reports a control under the layout switch button", () => {
  const p = layoutProblems(variant((cs) => { Object.assign(find(cs, "Back"), { x: SWITCH_ZONE.x, y: SWITCH_ZONE.y }); }));
  assert.ok(p.includes("Back overlaps the layout switch at 1000x500"), p.join("; "));
  assert.ok(p.includes("Back overlaps the layout switch at 1600x900"), p.join("; "));
  assert.ok(!layoutProblems(xbox).some((x) => x.includes("switch")));
});

// Choosing a layout: link, then saved choice, then the default

const three = { default: "b", layouts: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] };

test("chooseLayout: link wins over saved, saved over default", () => {
  assert.equal(chooseLayout(three, { search: "?k=tok&layout=c", saved: "a" }), "c");
  assert.equal(chooseLayout(three, { search: "?k=tok", saved: "a" }), "a");
  assert.equal(chooseLayout(three, { search: "", saved: null }), "b");
  assert.equal(chooseLayout(three), "b");
});

test("chooseLayout: unknown or unsafe ids fall back", () => {
  assert.equal(chooseLayout(three, { search: "?layout=steam", saved: "a" }), "a");
  assert.equal(chooseLayout(three, { search: "?layout=../x", saved: "../x" }), "b");
  assert.equal(chooseLayout(three, { search: "?layout=", saved: "" }), "b");
  assert.equal(chooseLayout(index, { search: "?layout=steam" }), "xbox"); // real index: unknown -> Xbox
});

test("nextLayout cycles and wraps; one layout returns itself", () => {
  assert.equal(nextLayout(three, "a"), "b");
  assert.equal(nextLayout(three, "b"), "c");
  assert.equal(nextLayout(three, "c"), "a");
  assert.equal(nextLayout(index, "xbox"), "xbox");
});

test("saved layout choice round-trips and survives broken storage", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  assert.equal(savedLayout(storage), null);
  saveLayout(storage, "c");
  assert.equal(savedLayout(storage), "c");
  assert.equal(map.get("phonepad.layout"), "c");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(savedLayout(broken), null);
  assert.doesNotThrow(() => saveLayout(broken, "c"));
  assert.equal(savedLayout(null), null);
  assert.doesNotThrow(() => saveLayout(null, "c"));
});

test("loader loads the layout pick() names, and unknown picks load the default", async () => {
  const other = variant((cs) => { find(cs, "A").label = "Other A"; });
  const twoIndex = { default: "xbox", layouts: [{ id: "xbox", name: "Xbox" }, { id: "other", name: "Other" }] };
  const f = served({ "layouts/index.json": JSON.stringify(twoIndex), "layouts/other.json": JSON.stringify(other) });
  assert.deepEqual(await loadLayout(f, () => "other"), { id: "other", index: twoIndex, controls: other.controls, theme: "xbox" });
  assert.deepEqual(await loadLayout(f, (ix) => nextLayout(ix, "other")), { id: "xbox", index: twoIndex, controls: xbox.controls, theme: "xbox" });
  for (const bad of ["steam", "../x", undefined]) {
    assert.equal((await loadLayout(f, () => bad)).id, "xbox", String(bad));
  }
  const missing = served({ "layouts/index.json": JSON.stringify(twoIndex) });
  assert.deepEqual(await loadLayout(missing, () => "other"), { error: "Couldn't load the controller layout (other): layouts/other.json returned 404" });
});

// Switching on the page (static: no browser in CI)

test("switching releases everything first, saves the choice and never reloads", () => {
  const js = read("controller.js");
  const handler = js.slice(js.indexOf('switcher.addEventListener("click"'));
  assert.ok(handler.indexOf("releaseAll()") > -1 && handler.indexOf("releaseAll()") < handler.indexOf("await show("), "releaseAll before building");
  assert.match(handler, /show\(\(index\) => nextLayout\(index, layout\.id\)\)/);
  assert.match(js, /const releaseAll = \(\) => \{ tracker\.releaseAll\(\); update\(\); \};/);
  const show = js.slice(js.indexOf("async function show("), js.indexOf("function place("));
  assert.ok(show.indexOf("pad.replaceChildren()") < show.indexOf("createTracker(controls"), "old controls removed before new ones");
  assert.match(show, /saveLayout\(store, loaded\.id\)/);
  assert.match(js, /chooseLayout\(index, \{ search: location\.search, saved: savedLayout\(store\) \}\)/);
  assert.doesNotMatch(js, /location\.(reload|assign|replace|href\s*=)/);
  // listeners are added once, at top level, not inside show()
  assert.doesNotMatch(show, /addEventListener/);
});

test("a malformed index can't jam the switch button", async () => {
  const js = read("controller.js");
  const handler = js.slice(js.indexOf('switcher.addEventListener("click"'));
  // the busy flag is reset in a finally, so a failed or throwing switch never leaves the button dead
  assert.match(handler, /switching = true;\s*try \{[\s\S]*await show\([\s\S]*\} finally \{\s*switching = false;/);
  // the label falls back to the id instead of reading .name of a missing entry
  assert.match(js, /\$\{entry\?\.name \?\? loaded\.id\}/);
  assert.doesNotMatch(js, /\.find\([^)]*\)\.name/);
  // a list whose default isn't listed still loads (the label code above must cope with it)
  const r = await loadLayout(served({ "layouts/index.json": JSON.stringify({ default: "xbox", layouts: [{ id: "other" }] }) }));
  assert.equal(r.id, "xbox");
  // and a list that isn't a list turns a switch into a message, not a throw
  const broken = served({ "layouts/index.json": JSON.stringify({ default: "xbox", layouts: "nope" }) });
  const s = await loadLayout(broken, (ix) => nextLayout(ix, "xbox"));
  assert.match(s.error, /^Couldn't load the controller layout/);
});

test("switch button sits outside #pad, at SWITCH_ZONE, with no-gesture CSS", () => {
  const html = read("index.html");
  assert.match(html, /<div id="pad"><\/div>\s*(<!--[^>]*-->\s*)?<button id="switch" type="button" hidden>/);
  const css = read("style.css");
  const rule = css.match(/#switch \{([^}]*)\}/)[1];
  const z = SWITCH_ZONE;
  assert.ok(rule.includes(`left: calc(${z.x}vw - ${z.w / 2}vh)`), "left");
  assert.ok(rule.includes(`top: ${z.y - z.h / 2}vh`), "top");
  assert.ok(rule.includes(`width: ${z.w}vh`) && rule.includes(`height: ${z.h}vh`), "size");
  assert.ok(z.h >= 8, "big enough to tap");
  for (const r of ["touch-action: none", "user-select: none", "-webkit-user-select: none"]) assert.ok(rule.includes(r), r);
});

// Themes and icons

/** style.css split into theme blocks ({id: Set of --names defined}) and the rest (base rules). */
const themeCss = () => {
  const css = read("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const themes = {};
  const base = css.replace(/\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g, (_, id, body) => {
    themes[id] = { body, vars: new Set(body.match(/--[\w-]+(?=\s*:)/g)) };
    return "";
  });
  return { base, themes };
};

test("real xbox layout names the xbox theme; a missing theme loads as the default", async () => {
  assert.equal(xbox.theme, "xbox");
  const { theme, ...noTheme } = xbox;
  assert.deepEqual(layoutProblems(noTheme), []);
  assert.equal((await loadLayout(served({ "layouts/xbox.json": JSON.stringify(noTheme) }))).theme, "xbox");
});

test("validator accepts a known theme and rejects an unknown or unsafe one", () => {
  assert.deepEqual(layoutProblems({ ...xbox, theme: "xbox" }), []);
  for (const bad of ["steam", "../xbox", "xbox;}", 7, null, ""]) {
    assert.deepEqual(layoutProblems({ ...xbox, theme: bad }), [`unknown theme ${bad}`], String(bad));
  }
});

test("loader returns the layout's theme", async () => {
  const r = await loadLayout(served());
  assert.equal(r.theme, "xbox");
});

test("every theme defines every colour the base rules use, and every named theme exists", () => {
  const { base, themes } = themeCss();
  const used = new Set(base.match(/var\(--[\w-]+/g).map((v) => v.slice(4)));
  const local = new Set(base.match(/--[\w-]+(?=\s*:)/g)); // set by base rules themselves (e.g. --face)
  assert.ok(used.size > 5);
  assert.deepEqual(Object.keys(themes).sort(), [...THEMES].sort());
  for (const [id, { vars }] of Object.entries(themes)) {
    for (const v of used) if (!local.has(v)) assert.ok(vars.has(v), `${id} lacks ${v}`);
  }
  for (const f of readdirSync(new URL("layouts/", WEB)).filter((f) => f !== "index.json")) {
    const t = JSON.parse(read(`layouts/${f}`)).theme;
    if (t !== undefined) assert.ok(t in themes, `${f}: theme ${t} not in style.css`);
  }
});

test("theme blocks hold only colours, so the no-zoom/no-scroll and rotate rules apply in every theme", () => {
  const { base, themes } = themeCss();
  for (const [id, { body }] of Object.entries(themes)) {
    for (const decl of body.split(";").map((d) => d.trim()).filter(Boolean)) {
      assert.match(decl, /^--[\w-]+\s*:/, `${id}: ${decl}`);
    }
  }
  for (const rule of ["touch-action: none", "user-select: none", "-webkit-user-select: none",
    "-webkit-touch-callout: none", "overflow: hidden"]) {
    assert.ok(base.includes(rule), rule);
  }
  assert.match(base, /@media \(orientation: portrait\)\s*\{\s*#rotate\s*\{\s*display: flex/);
  assert.doesNotMatch(base, /data-theme/); // no theme-specific rule can override them
});

test("xbox theme colours A green, B red, X blue, Y yellow", () => {
  const { base, themes } = themeCss();
  const css = read("style.css");
  const hue = (v) => {
    const hex = css.match(new RegExp(`\\[data-theme="xbox"\\][^}]*${v}:\\s*#([0-9a-f]{6})`, "i"))[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return { r, g, b };
  };
  const { r: ar, g: ag, b: ab } = hue("--a"); assert.ok(ag > ar && ag > ab, "A green");
  const { r: br, g: bg, b: bb } = hue("--b"); assert.ok(br > bg && br > bb, "B red");
  const { r: xr, g: xg, b: xb } = hue("--x"); assert.ok(xb > xr && xb > xg, "X blue");
  const { r: yr, g: yg, b: yb } = hue("--y"); assert.ok(yr > yb + 100 && yg > yb + 100, "Y yellow");
  for (const n of ["A", "B", "X", "Y"]) {
    assert.match(base, new RegExp(`\\.button\\[data-name="${n}"\\] \\{ --face: var\\(--${n.toLowerCase()}\\); \\}`), n);
  }
  assert.match(base, /\.button\[data-name="A"\][^{]*\{\s*color: var\(--face\);\s*border-color: var\(--face\);/);
  assert.match(base, /\.button\.on\[data-name="A"\][^{]*\{\s*background: var\(--face\);\s*color: var\(--on-face\);/);
  assert.ok(themes.xbox.vars.has("--on-face"));
});

test("Guide shows a local home icon, keeps a label, and unknown icons are rejected", () => {
  const guide = find(xbox.controls, "Guide");
  assert.equal(guide.icon, "home");
  assert.ok(guide.label);
  assert.match(ICONS.home, /^<svg [^>]*viewBox="[^"]+"[^>]*>.*<\/svg>$/);
  assert.doesNotMatch(ICONS.home, /https?:|url\(|<image|href/i);
  const p = layoutProblems(variant((cs) => { find(cs, "Guide").icon = "xbox-logo"; }));
  assert.deepEqual(p, ["Guide: unknown icon xbox-logo"]);
  const noLabel = layoutProblems(variant((cs) => { delete find(cs, "Guide").label; }));
  assert.deepEqual(noLabel, ["Guide: no label"]);
  const js = read("controller.js");
  assert.match(js, /import \{[^}]*\bICONS\b[^}]*\} from "\.\/layouts\.js";/);
  assert.match(js, /else if \(c\.icon\) \{ el\.innerHTML = ICONS\[c\.icon\]; el\.setAttribute\("aria-label", c\.label\); \}/);
});

test("show() applies the layout's theme and tags each control by name, every time a layout loads", () => {
  const js = read("controller.js");
  const show = js.slice(js.indexOf("async function show("), js.indexOf("function place("));
  const success = show.slice(show.indexOf('pad.className = "";'));
  assert.match(success, /document\.documentElement\.dataset\.theme = loaded\.theme;/);
  assert.match(show, /el\.dataset\.name = c\.name;/);
  // the page has a theme before the first layout loads (e.g. the error message)
  assert.match(read("index.html"), /<html lang="en" data-theme="xbox">/);
});

// D-pad dish and new icons

test("validator: one dpad provides Up/Down/Left/Right; mixing, doubling or dropping it is reported", () => {
  assert.equal(xbox.controls.filter((c) => c.type === "dpad").length, 1);
  assert.ok(!xbox.controls.some((c) => ["Up", "Down", "Left", "Right"].includes(c.name)));
  assert.deepEqual(layoutProblems(xbox), []);
  const dpad = find(xbox.controls, "dpad");
  const extraUp = layoutProblems(variant((cs) => cs.push({ type: "button", name: "Up", label: "U", x: 50, y: 50, w: 4, h: 4 })));
  assert.deepEqual(extraUp, ["Up appears 2 times"]);
  const two = layoutProblems(variant((cs) => cs.push({ ...dpad, x: 50, y: 50, r: 2 })));
  assert.deepEqual(two, ["Up appears 2 times", "Down appears 2 times", "Left appears 2 times", "Right appears 2 times"]);
  const none = layoutProblems(variant((cs) => cs.splice(cs.indexOf(find(cs, "dpad")), 1)));
  assert.deepEqual(none, ["Up is missing", "Down is missing", "Left is missing", "Right is missing"]);
  // four D-pad buttons instead of the dpad is still a valid layout
  const four = variant((cs) => {
    cs.splice(cs.indexOf(find(cs, "dpad")), 1, ...[["Up", 40, 66], ["Down", 40, 92], ["Left", 33, 79], ["Right", 47, 79]]
      .map(([name, x, y]) => ({ type: "button", name, label: name, x, y, w: 10, h: 10 })));
  });
  assert.deepEqual(layoutProblems(four), []);
});

test("validator: dpad position must be in range, on screen and not overlapping", () => {
  assert.deepEqual(layoutProblems(variant((cs) => { find(cs, "dpad").r = 120; })), ["dpad: r must be a number 0..100"]);
  assert.deepEqual(layoutProblems(variant((cs) => { delete find(cs, "dpad").x; })), ["dpad: x must be a number 0..100"]);
  const over = layoutProblems(variant((cs) => { Object.assign(find(cs, "dpad"), { x: find(cs, "A").x, y: find(cs, "A").y }); }));
  assert.ok(over.includes("A overlaps dpad at 1000x500") || over.includes("dpad overlaps A at 1000x500"), over.join("; "));
  const off = layoutProblems(variant((cs) => { find(cs, "dpad").y = 95; }));
  assert.ok(off.includes("dpad goes off-screen at 1600x900"), off.join("; "));
  const sw = layoutProblems(variant((cs) => { Object.assign(find(cs, "dpad"), { x: SWITCH_ZONE.x, y: 20, r: 10 }); }));
  assert.ok(sw.includes("dpad overlaps the layout switch at 1000x500"), sw.join("; "));
});

test("Back shows the view icon, Start the menu icon, Guide home; all local SVG with labels", () => {
  assert.deepEqual(["Back", "Start", "Guide"].map((n) => find(xbox.controls, n).icon), ["view", "menu", "home"]);
  assert.equal(find(xbox.controls, "Back").label, "Back");
  assert.equal(find(xbox.controls, "Start").label, "Start");
  for (const name of ["home", "view", "menu"]) {
    assert.match(ICONS[name], /^<svg viewBox="0 0 24 24" aria-hidden="true">.*<\/svg>$/, name);
    assert.match(ICONS[name], /currentColor/, name);
    assert.doesNotMatch(ICONS[name], /https?:|url\(|<image|href|xmlns|<script|\son\w+=/i, name);
  }
  assert.equal((ICONS.view.match(/<rect /g) ?? []).length, 2); // two overlapping rounded squares
  assert.match(ICONS.view, /rx="/);
  assert.equal((ICONS.menu.match(/M4 \d+h16/g) ?? []).length, 3); // three horizontal lines
  for (const bad of ["xbox-logo", "toString", "__proto__"]) {
    assert.deepEqual(layoutProblems(variant((cs) => { find(cs, "Start").icon = bad; })), [`Start: unknown icon ${bad}`], bad);
  }
});

test("dish colours come from the theme block", () => {
  const { base, themes } = themeCss();
  for (const v of ["--dpad-tile", "--dpad-tile-alt", "--dpad-line", "--dpad-shade", "--dpad-on"]) {
    assert.ok(base.includes(`var(${v})`), `base uses ${v}`);
    for (const [id, { vars }] of Object.entries(themes)) assert.ok(vars.has(v), `${id} defines ${v}`);
  }
  assert.match(base, /\.dpad \{[^}]*conic-gradient/); // faceted tiles drawn by CSS, no images
});
