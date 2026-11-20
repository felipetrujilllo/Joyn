// Layout files (no DOM): `layouts/index.json` names the layouts, `layouts/<id>.json` holds one.
import { BUTTONS } from "./buttons.js";
import { box } from "./state.js";

// Phone shapes a layout must fit without overlap: 2:1 and 16:9 landscape.
const SCREENS = [[1000, 500], [1600, 900]];

/**
 * Check a parsed layout file.
 * @param {any} layout parsed `layouts/<id>.json`
 * @returns {string[]} human-readable problems; empty when the layout is usable
 */
export function layoutProblems(layout) {
  const controls = layout?.controls;
  if (!Array.isArray(controls)) return ["no controls list"];
  const problems = [];
  const sized = [];
  for (const c of controls) {
    const keys = { stick: ["x", "y", "r"], button: ["x", "y", "w", "h"] }[c?.type];
    if (!keys) { problems.push(`${c?.name}: unknown type ${c?.type}`); continue; }
    const bad = keys.filter((k) => !(typeof c[k] === "number" && c[k] >= 0 && c[k] <= 100));
    if (bad.length) problems.push(`${c.name}: ${bad.join(", ")} must be a number 0..100`);
    else sized.push(c);
    if (c.type === "button" && !c.label) problems.push(`${c.name}: no label`);
  }
  const names = controls.filter((c) => c?.type === "button").map((c) => c.name);
  for (const b of BUTTONS) {
    const n = names.filter((x) => x === b).length;
    if (n !== 1) problems.push(n ? `${b} appears ${n} times` : `${b} is missing`);
  }
  for (const x of names) if (!BUTTONS.includes(x)) problems.push(`unknown button ${x}`);
  const sticks = controls.filter((c) => c?.type === "stick").map((c) => c.name).sort();
  if (sticks.join() !== "left,right") problems.push(`sticks must be left and right, got [${sticks}]`);
  for (const [W, H] of SCREENS) {
    const bs = sized.map((c) => box(c, W, H));
    bs.forEach((a, i) => {
      if (a.cx - a.hw < 0 || a.cx + a.hw > W || a.cy - a.hh < 0 || a.cy + a.hh > H) {
        problems.push(`${sized[i].name} goes off-screen at ${W}x${H}`);
      }
      for (let j = i + 1; j < bs.length; j++) {
        const b = bs[j];
        if (Math.abs(a.cx - b.cx) < a.hw + b.hw && Math.abs(a.cy - b.cy) < a.hh + b.hh) {
          problems.push(`${sized[i].name} overlaps ${sized[j].name} at ${W}x${H}`);
        }
      }
    });
  }
  return problems;
}

/**
 * Load the default layout. Never throws: any failure becomes a short message for the page.
 * @param {(path: string) => Promise<{ok: boolean, status: number, json(): Promise<any>}>} fetchFn e.g. `fetch`
 * @returns {Promise<{controls: object[]} | {error: string}>}
 */
export async function loadLayout(fetchFn) {
  let id = "?";
  const getJson = async (path) => {
    const r = await fetchFn(path);
    if (!r.ok) throw new Error(`${path} returned ${r.status}`);
    return r.json();
  };
  try {
    const index = await getJson("layouts/index.json");
    if (typeof index?.default !== "string" || !/^[\w-]+$/.test(index.default)) throw new Error("layouts/index.json has no valid default");
    id = index.default;
    const layout = await getJson(`layouts/${id}.json`);
    const problems = layoutProblems(layout);
    if (problems.length) {
      throw new Error(problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : ""));
    }
    return { controls: layout.controls };
  } catch (e) {
    return { error: `Couldn't load the controller layout (${id}): ${e.message}` };
  }
}
