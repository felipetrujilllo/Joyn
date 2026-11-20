import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { layoutProblems, loadLayout } from "../../phonepad/web/layouts.js";

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
  const p = layoutProblems(variant((cs) => cs.push({ type: "stick", name: "left", x: 50, y: 95, r: 2 })));
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
  assert.deepEqual(await loadLayout(served()), { controls: xbox.controls });
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
  assert.match(js, /import \{ loadLayout \} from "\.\/layouts\.js";/);
  assert.match(js, /if \(loaded\.error\) \{\s*pad\.className = "error";\s*pad\.textContent = loaded\.error;\s*throw/);
  assert.ok(js.indexOf("if (loaded.error)") < js.indexOf("createTracker(controls"));
  assert.doesNotMatch(js, /layout\.json/);
  assert.match(read("style.css"), /#pad\.error \{/);
});
