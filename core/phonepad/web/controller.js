// DOM glue: render a layout from layouts/, feed pointer events to the tracker, draw state.
// The current state is published as `padstate` events on `document` (detail: {b, lx, ly, rx, ry}).
// The #switch button swaps layouts in place; the page (and client.js's connection) never reloads.
import { AXIS_MAX, box, createTracker } from "./state.js";
import { bit } from "./buttons.js";
import { DPAD_BUTTONS, ICONS, chooseLayout, loadLayout, nextLayout, saveLayout, savedLayout, shapeControls } from "./layouts.js";

const pad = document.getElementById("pad");
const switcher = document.getElementById("switch");
const store = (() => { try { return localStorage; } catch { return null; } })(); // can throw when disabled
let layout = null; // {id, index, controls, theme} of the layout on screen
let controls = [];
let els = [];
let tracker = createTracker([], innerWidth, innerHeight);
let last = "";

/**
 * Load the layout `pick(index)` names and build its controls, replacing the current ones.
 * On failure the pad shows the loader's message and has no controls.
 * @param {(index: object) => string} pick
 * @returns {Promise<boolean>} true when the layout is on screen
 */
async function show(pick) {
  const loaded = await loadLayout((path) => fetch(path), pick);
  pad.replaceChildren();
  if (loaded.error) {
    pad.className = "error";
    pad.textContent = loaded.error;
    controls = els = [];
    tracker = createTracker(controls, innerWidth, innerHeight);
    return false;
  }
  pad.className = "";
  document.documentElement.dataset.theme = loaded.theme; // style.css [data-theme] picks the colours
  layout = loaded;
  controls = shapeControls(loaded.controls, loaded.theme); // same shapes for drawing and hit testing
  tracker = createTracker(controls, innerWidth, innerHeight);
  els = controls.map((c) => {
    const el = document.createElement("div");
    el.className = c.type;
    el.dataset.name = c.name;
    if (c.shape) el.dataset.shape = c.shape;
    if (c.type === "stick") el.appendChild(document.createElement("div")).className = "knob";
    else if (c.type === "dpad") {
      el.setAttribute("aria-label", c.label ?? "D-pad");
      for (const d of DPAD_BUTTONS) el.appendChild(document.createElement("div")).className = `dir ${d.toLowerCase()}`;
    }
    else if (c.icon) { el.innerHTML = ICONS[c.icon]; el.setAttribute("aria-label", c.label); } // validated icon name
    else el.textContent = c.label;
    return pad.appendChild(el);
  });
  // ?. / ?? : a malformed index.json (default not listed) must not break the page or the button
  const entry = Array.isArray(loaded.index.layouts) ? loaded.index.layouts.find((l) => l?.id === loaded.id) : null;
  switcher.textContent = `⇄ ${entry?.name ?? loaded.id}`;
  switcher.hidden = false;
  saveLayout(store, loaded.id);
  last = "";
  place();
  update();
  return true;
}

/** Position every control for the current screen size. */
function place() {
  tracker.resize(innerWidth, innerHeight);
  controls.forEach((c, i) => {
    const { cx, cy, hw, hh } = box(c, innerWidth, innerHeight);
    Object.assign(els[i].style, {
      left: `${cx - hw}px`, top: `${cy - hh}px`, width: `${2 * hw}px`, height: `${2 * hh}px`,
    });
  });
}

/** Redraw and publish the tracker state if it changed. */
function update() {
  const s = tracker.snapshot();
  const key = JSON.stringify(s);
  if (key === last) return;
  last = key;
  controls.forEach((c, i) => {
    if (c.type === "button") { els[i].classList.toggle("on", (s.b & bit(c.name)) !== 0); return; }
    if (c.type === "dpad") { // children are in DPAD_BUTTONS order
      DPAD_BUTTONS.forEach((d, j) => els[i].children[j].classList.toggle("on", (s.b & bit(d)) !== 0));
      return;
    }
    const [x, y] = c.name === "left" ? [s.lx, s.ly] : [s.rx, s.ry];
    const r = box(c, innerWidth, innerHeight).hw;
    els[i].firstChild.style.transform = `translate(${(x / AXIS_MAX) * r}px, ${(y / AXIS_MAX) * r}px)`;
  });
  document.dispatchEvent(new CustomEvent("padstate", { detail: s }));
}

if (!(await show((index) => chooseLayout(index, { search: location.search, saved: savedLayout(store) })))) {
  throw new Error(pad.textContent); // stop here: no controls to wire up
}

// Listeners use whatever `tracker` is current, so a layout switch adds none.
pad.addEventListener("pointerdown", (e) => {
  if (!tracker.down(e.pointerId, e.clientX, e.clientY)) return;
  pad.setPointerCapture(e.pointerId);
  update();
});
pad.addEventListener("pointermove", (e) => { tracker.move(e.pointerId, e.clientX, e.clientY); update(); });
pad.addEventListener("pointerup", (e) => { tracker.up(e.pointerId); update(); });
pad.addEventListener("pointercancel", (e) => { tracker.cancel(e.pointerId); update(); });
// Screen lock, app switch or a system overlay can swallow pointerup; release everything so nothing stays held.
const releaseAll = () => { tracker.releaseAll(); update(); };
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });
addEventListener("pagehide", releaseAll);
addEventListener("blur", releaseAll);
for (const type of ["contextmenu", "gesturestart", "dblclick"]) {
  document.addEventListener(type, (e) => e.preventDefault());
}
addEventListener("resize", place);

// #switch sits outside #pad, so its touches never reach the tracker.
let switching = false;
switcher.addEventListener("click", async () => {
  if (switching) return;
  switching = true;
  try {
    releaseAll(); // neutral padstate goes out before the old controls disappear
    await show((index) => nextLayout(index, layout.id));
  } finally {
    switching = false; // even if the switch failed, the button keeps working
  }
});
