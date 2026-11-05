// Global path planning on the static map: an occupancy grid with shelves, walls and the
// no-go zones inflated by the robot's radius, searched with A*, then shortened so the
// robot drives straight segments between corners. People are not in the map. They are
// handled live by the safety shield, the way a local controller would.

import { H, NO_GO, ROBOT, SHELVES, W } from "./world.js";
import { distToRect } from "./geometry.js";

export const CELL = 0.2;
const COLS = Math.round(W / CELL);
const ROWS = Math.round(H / CELL);
const INFLATE = ROBOT.radius + 0.12;

let GRID = null;
function grid() {
  if (GRID) return GRID;
  GRID = new Uint8Array(COLS * ROWS);
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const x = (i + 0.5) * CELL;
      const y = (j + 0.5) * CELL;
      let blocked = x < INFLATE || y < INFLATE || x > W - INFLATE || y > H - INFLATE;
      for (const r of SHELVES) if (!blocked && distToRect(x, y, r) < INFLATE) blocked = true;
      for (const z of NO_GO) if (!blocked && distToRect(x, y, z) < INFLATE) blocked = true;
      GRID[j * COLS + i] = blocked ? 1 : 0;
    }
  }
  return GRID;
}

const cellOf = (x, y) => [Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL))), Math.min(ROWS - 1, Math.max(0, Math.floor(y / CELL)))];
const centre = (i, j) => [(i + 0.5) * CELL, (j + 0.5) * CELL];
export const isFree = (x, y) => { const [i, j] = cellOf(x, y); return grid()[j * COLS + i] === 0; };

function nearestFree(i, j) {
  const g = grid();
  if (!g[j * COLS + i]) return [i, j];
  for (let r = 1; r < 12; r++) {
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < COLS && b < ROWS && !g[b * COLS + a]) return [a, b];
    }
  }
  return null;
}

function lineFree(ax, ay, bx, by) {
  const d = Math.hypot(bx - ax, by - ay);
  const n = Math.ceil(d / (CELL * 0.5));
  for (let k = 0; k <= n; k++) {
    const t = n ? k / n : 0;
    if (!isFree(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
  }
  return true;
}

// Returns a list of [x, y] waypoints (excluding the start) or null if there is no path.
export function plan(sx, sy, gx, gy) {
  const g = grid();
  const s = nearestFree(...cellOf(sx, sy));
  const e = nearestFree(...cellOf(gx, gy));
  if (!s || !e) return null;
  const key = (i, j) => j * COLS + i;
  const open = new Map([[key(...s), { i: s[0], j: s[1], g: 0, f: 0, parent: null }]]);
  const closed = new Map();
  const h = (i, j) => Math.hypot(i - e[0], j - e[1]);
  while (open.size) {
    let cur = null;
    for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
    open.delete(key(cur.i, cur.j));
    closed.set(key(cur.i, cur.j), cur);
    if (cur.i === e[0] && cur.j === e[1]) {
      const cells = [];
      for (let n = cur; n; n = n.parent) cells.unshift(centre(n.i, n.j));
      cells[cells.length - 1] = isFree(gx, gy) ? [gx, gy] : cells[cells.length - 1];
      return smooth([[sx, sy], ...cells]).slice(1);
    }
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = cur.i + di, b = cur.j + dj;
      if (a < 0 || b < 0 || a >= COLS || b >= ROWS || g[key(a, b)] || closed.has(key(a, b))) continue;
      if (di && dj && (g[key(cur.i + di, cur.j)] || g[key(cur.i, cur.j + dj)])) continue;
      const cost = cur.g + (di && dj ? Math.SQRT2 : 1);
      const old = open.get(key(a, b));
      if (!old || cost < old.g) open.set(key(a, b), { i: a, j: b, g: cost, f: cost + h(a, b), parent: cur });
    }
  }
  return null;
}

function smooth(pts) {
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineFree(pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}
