// Button bit order for the `b` bitmask. Must match protocol.py (the source of truth).
export const BUTTONS = Object.freeze([
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "Guide",
  "L3", "R3", "Up", "Down", "Left", "Right",
]);

/** Return the bitmask value for a button name; throws on an unknown name. */
export function bit(name) {
  const i = BUTTONS.indexOf(name);
  if (i < 0) throw new Error(`unknown button: ${name}`);
  return 1 << i;
}
