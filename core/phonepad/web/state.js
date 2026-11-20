// Pure touch -> controller-state logic (no DOM), so it runs under `node --test`.
//
// Layout geometry: a control's x/y is its centre in percent of the screen width/height;
// sizes (button w/h, stick r) are in percent of the screen height so controls stay round.
import { bit } from "./buttons.js";

export const AXIS_MAX = 32767;
export const DEAD_ZONE = 0.15;

const STICK_AXES = { left: ["lx", "ly"], right: ["rx", "ry"] };

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
 * @returns {{cx: number, cy: number, hw: number, hh: number}} centre and half-sizes; sticks have hw = hh = radius
 */
export function box(c, W, H) {
  const hw = ((c.type === "stick" ? c.r : c.w / 2) * H) / 100;
  const hh = ((c.type === "stick" ? c.r : c.h / 2) * H) / 100;
  return { cx: (c.x * W) / 100, cy: (c.y * H) / 100, hw, hh };
}

/** Return the first control containing point (x, y) in px on a W x H screen, or null. */
export function hitTest(controls, x, y, W, H) {
  return controls.find((c) => {
    const { cx, cy, hw, hh } = box(c, W, H);
    return c.type === "stick"
      ? Math.hypot(x - cx, y - cy) <= hw
      : Math.abs(x - cx) <= hw && Math.abs(y - cy) <= hh;
  }) ?? null;
}

/**
 * Track pointers. Each pointer is bound to the control it went down on until it lifts:
 * a stick pointer keeps steering its stick outside the circle, and a button stays held
 * while any pointer bound to it is down.
 * @param {object[]} controls layout.json `controls`
 * @param {number} W screen width (px)
 * @param {number} H screen height (px)
 */
export function createTracker(controls, W, H) {
  const pointers = new Map(); // pointer id -> {c, x, y}
  const release = (id) => pointers.delete(id);
  return {
    /** Update the screen size (px) after a resize. */
    resize(w, h) { W = w; H = h; },
    /** Pointer went down at (x, y) px; returns the control it bound to, or null. */
    down(id, x, y) {
      const c = hitTest(controls, x, y, W, H);
      if (c) pointers.set(id, { c, x, y });
      return c;
    },
    /** Pointer moved to (x, y) px. */
    move(id, x, y) {
      const p = pointers.get(id);
      if (p) { p.x = x; p.y = y; }
    },
    /** Pointer lifted. */
    up: release,
    /** Pointer cancelled by the browser (same effect as up). */
    cancel: release,
    /** Release every pointer, e.g. when the page is hidden and pointerup may never arrive. */
    releaseAll() { pointers.clear(); },
    /** Current state as protocol fields: {b, lx, ly, rx, ry}. */
    snapshot() {
      const s = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
      for (const { c, x, y } of pointers.values()) {
        if (c.type === "button") { s.b |= bit(c.name); continue; }
        const { cx, cy, hw } = box(c, W, H);
        const v = shapeStick(x - cx, y - cy, hw);
        const [ax, ay] = STICK_AXES[c.name];
        s[ax] = v.x; s[ay] = v.y;
      }
      return s;
    },
  };
}
