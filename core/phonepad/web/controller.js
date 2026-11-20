// DOM glue: render layout.json, feed pointer events to the tracker, draw state.
// The current state is published as `padstate` events on `document` (detail: {b, lx, ly, rx, ry}).
import { AXIS_MAX, box, createTracker } from "./state.js";
import { bit } from "./buttons.js";

const pad = document.getElementById("pad");
const { controls } = await (await fetch("layout.json")).json();
const tracker = createTracker(controls, innerWidth, innerHeight);
const els = controls.map((c) => {
  const el = document.createElement("div");
  el.className = c.type;
  if (c.type === "stick") el.appendChild(document.createElement("div")).className = "knob";
  else el.textContent = c.label;
  return pad.appendChild(el);
});
let last = "";

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
    const [x, y] = c.name === "left" ? [s.lx, s.ly] : [s.rx, s.ry];
    const r = box(c, innerWidth, innerHeight).hw;
    els[i].firstChild.style.transform = `translate(${(x / AXIS_MAX) * r}px, ${(y / AXIS_MAX) * r}px)`;
  });
  document.dispatchEvent(new CustomEvent("padstate", { detail: s }));
}

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
place();
update();
