// Pure touch -> controller-state logic (no DOM), so it runs under `node --test`.
//
// Layout geometry: a control's x/y is its centre in percent of the screen width/height;
// sizes (button w/h, stick/dpad/trackpad r) are in percent of the screen height so controls stay round.
import { bit } from "./buttons.js";

export const AXIS_MAX = 32767;
export const DEAD_ZONE = 0.15;

export const DPAD_DEAD_ZONE = 0.25; // fraction of the dish radius that presses nothing
export const DPAD_OUTER = 1.1; // a finger this far out (in radii) has slid off the dish

const FACE = ["A", "B", "X", "Y"]; // buttons a finger can slide between
const STICK_AXES = { left: ["lx", "ly"], right: ["rx", "ry"] };
// 45-degree sectors counter-clockwise from screen-right (index = round(angle / 45) mod 8).
const DPAD_SECTORS = [["Right"], ["Up", "Right"], ["Up"], ["Up", "Left"], ["Left"], ["Down", "Left"], ["Down"], ["Down", "Right"]]
  .map((names) => names.reduce((b, n) => b | bit(n), 0));

/**
 * D-pad bits for a touch on the dish: 8-way by angle (diagonals press two), nothing in the
 * centre dead zone or once the finger is off the dish. Screen y grows down, so up is -dy.
 * @param {number} dx offset from the dish centre (px)
 * @param {number} dy offset from the dish centre (px)
 * @param {number} r dish radius (px)
 * @returns {number} bitmask of Up/Down/Left/Right
 */
export function dpadBits(dx, dy, r) {
  const m = Math.hypot(dx, dy) / r;
  if (m < DPAD_DEAD_ZONE || m > DPAD_OUTER) return 0;
  return DPAD_SECTORS[(Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) + 8) % 8];
}

/**
 * Shape a stick offset into protocol axes: radial dead zone, rescaled so the edge
 * reaches full range, clamped to the unit circle. Screen y grows down, so up is negative Y.
 * @param {number} dx offset from the stick centre (px)
 * @param {number} dy offset from the stick centre (px)
 * @param {number} r stick radius (px)
 * @returns {{x: number, y: number}} integers in -32767..32767
 */
export function shapeStick(dx, dy, r, deadZone = DEAD_ZONE) {
  const m = Math.hypot(dx, dy) / r;
  if (m <= deadZone) return { x: 0, y: 0 };
  const k = (Math.min(1, (m - deadZone) / (1 - deadZone)) * AXIS_MAX) / (m * r);
  return { x: Math.round(dx * k) || 0, y: Math.round(dy * k) || 0 }; // `|| 0` turns -0 into 0
}

/**
 * Pixel geometry of a layout control on a W x H screen.
 * @returns {{cx: number, cy: number, hw: number, hh: number}} centre and half-sizes; sticks, dpads and trackpads have hw = hh = radius
 */
export function box(c, W, H) {
  const hw = ((c.type === "button" ? c.w / 2 : c.r) * H) / 100;
  const hh = ((c.type === "button" ? c.h / 2 : c.r) * H) / 100;
  return { cx: (c.x * W) / 100, cy: (c.y * H) / 100, hw, hh };
}

/**
 * Return the first control containing point (x, y) in px on a W x H screen, or null.
 * Sticks, dpads and trackpads are circles; buttons are rectangles unless `c.shape` is "circle" or "pill"
 * (set by layouts.js shapeControls), which hit as a stadium: the drawn shape, not its box.
 */
export function hitTest(controls, x, y, W, H) {
  return controls.find((c) => edgeDistance(c, x, y, W, H) <= 0) ?? null;
}

/**
 * Distance (px) from point (x, y) to the edge of control c's hit shape (see hitTest); 0 or less inside.
 * Exact outside circles and stadiums; inside a rectangle it is 0, which is all hitTest needs.
 */
export function edgeDistance(c, x, y, W, H) {
  const { cx, cy, hw, hh } = box(c, W, H);
  const ax = Math.abs(x - cx), ay = Math.abs(y - cy);
  if (c.type !== "button") return Math.hypot(ax, ay) - hw;
  if (c.shape !== "circle" && c.shape !== "pill") return Math.hypot(Math.max(0, ax - hw), Math.max(0, ay - hh));
  const r = Math.min(hw, hh); // stadium: a rectangle with round ends of radius r (a circle when hw = hh)
  return Math.hypot(Math.max(0, ax - (hw - r)), Math.max(0, ay - (hh - r))) - r;
}

/**
 * Track pointers. Each pointer is bound to the control it went down on until it lifts:
 * a stick pointer keeps steering its stick outside the circle, a dpad pointer presses
 * whichever direction it is on now (sliding between directions works without lifting),
 * and a button stays held while any pointer bound to it is down.
 * Face buttons (A/B/X/Y) slide: a finger that went down on one presses whichever face button
 * it is over now, one at a time. In a gap it keeps the last one; it releases (presses nothing)
 * once it is over a non-face control, or over nothing and farther than that last button's own
 * width from every face button's edge. Sliding back onto a face button presses it again.
 * Fingers that went down elsewhere never press a face button by sliding onto it.
 * A trackpad (`mode` "left"/"right") sets that stick's axes from where the finger is on it
 * (centre neutral, rim full, same dead zone as a stick); `mode` "dpad" presses like the dpad.
 * Two fingers on one stick-driving control: the one that went down last wins until it lifts.
 * @param {object[]} controls layout `controls`
 * @param {number} W screen width (px)
 * @param {number} H screen height (px)
 */
export function createTracker(controls, W, H) {
  const pointers = new Map(); // pointer id -> {c, x, y, face}; c is null while a face finger is released
  const faces = controls.filter((c) => c.type === "button" && FACE.includes(c.name));
  const release = (id) => pointers.delete(id);
  return {
    /** Update the screen size (px) after a resize. */
    resize(w, h) { W = w; H = h; },
    /** Pointer went down at (x, y) px; returns the control it bound to, or null. */
    down(id, x, y) {
      const c = hitTest(controls, x, y, W, H);
      if (c) pointers.set(id, { c, x, y, face: faces.includes(c) });
      return c;
    },
    /** Pointer moved to (x, y) px. */
    move(id, x, y) {
      const p = pointers.get(id);
      if (!p) return;
      p.x = x; p.y = y;
      if (!p.face) return;
      const over = hitTest(controls, x, y, W, H);
      if (faces.includes(over)) p.c = over;
      else if (over || !faces.some((f) => edgeDistance(f, x, y, W, H) <= (p.c?.w ?? 0) * H / 100)) p.c = null;
    },
    /** Pointer lifted. */
    up: release,
    /** Pointer cancelled by the browser (same effect as up). */
    cancel: release,
    /** Release every pointer, e.g. when the page is hidden and pointerup may never arrive. */
    releaseAll() { pointers.clear(); },
    /**
     * Where the finger on control `c` is (the last one down if several), for drawing a trackpad's dot.
     * @returns {{dx: number, dy: number} | null} px offset from c's centre, clamped to its radius; null when untouched
     */
    finger(c) {
      let f = null;
      for (const p of pointers.values()) if (p.c === c) f = p;
      if (!f) return null;
      const { cx, cy, hw } = box(c, W, H);
      const dx = f.x - cx, dy = f.y - cy;
      const k = Math.min(1, hw / Math.hypot(dx, dy)); // hypot 0 -> Infinity -> 1
      return { dx: dx * k, dy: dy * k };
    },
    /** Current state as protocol fields: {b, lx, ly, rx, ry}. */
    snapshot() {
      const s = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
      for (const { c, x, y } of pointers.values()) {
        if (!c) continue;
        if (c.type === "button") { s.b |= bit(c.name); continue; }
        const { cx, cy, hw } = box(c, W, H);
        if (c.type === "dpad" || (c.type === "trackpad" && c.mode === "dpad")) { s.b |= dpadBits(x - cx, y - cy, hw); continue; }
        const v = shapeStick(x - cx, y - cy, hw);
        const [ax, ay] = STICK_AXES[c.type === "trackpad" ? c.mode : c.name];
        s[ax] = v.x; s[ay] = v.y;
      }
      return s;
    },
  };
}
