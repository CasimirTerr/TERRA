// What the robot can sense. Nothing here reads the world's ground truth directly into
// the brain: the lidar returns ranges, and the camera returns what is actually in its
// field of view and not hidden behind a shelf, with a little noise.

import { DOCKS, H, NO_GO, PERSON_RADIUS, SHELVES, W } from "./world.js";
import { deg, dist, rayCircle, rayRect, rng, wrapAngle } from "./geometry.js";

export const LIDAR_RAYS = 120;
export const LIDAR_RANGE = 8;
export const CAMERA_FOV = (90 * Math.PI) / 180;
export const CAMERA_RANGE = 9;
export const SIGN_READ_RANGE = 5.5;

const WALLS = [
  { x: -1, y: -1, w: W + 2, h: 1 },
  { x: -1, y: H, w: W + 2, h: 1 },
  { x: -1, y: -1, w: 1, h: H + 2 },
  { x: W, y: -1, w: 1, h: H + 2 },
];

export function raycast(world, ox, oy, angle, maxRange, { people = true } = {}) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = maxRange;
  let what = null;
  for (const r of [...WALLS, ...SHELVES]) {
    const t = rayRect(ox, oy, dx, dy, r);
    if (t < best) { best = t; what = "static"; }
  }
  if (people) {
    for (const p of world.people) {
      const t = rayCircle(ox, oy, dx, dy, p.x, p.y, PERSON_RADIUS);
      if (t < best) { best = t; what = "person"; }
    }
  }
  return { range: best, what };
}

export function lidar(world) {
  const { x, y, th } = world.robot;
  const out = [];
  for (let i = 0; i < LIDAR_RAYS; i++) {
    const a = th + (i / LIDAR_RAYS) * Math.PI * 2;
    out.push(raycast(world, x, y, a, LIDAR_RANGE).range);
  }
  return out;
}

// Closest lidar return inside a cone around a direction (relative to heading).
export function minRangeInCone(scan, center, halfWidth) {
  let best = LIDAR_RANGE;
  for (let i = 0; i < scan.length; i++) {
    const a = wrapAngle((i / scan.length) * Math.PI * 2 - center);
    if (Math.abs(a) <= halfWidth) best = Math.min(best, scan[i]);
  }
  return best;
}

function visible(world, tx, ty, slack = 0.25) {
  const { x, y } = world.robot;
  const d = dist(x, y, tx, ty);
  if (d < 1e-6) return true;
  const a = Math.atan2(ty - y, tx - x);
  const hit = raycast(world, x, y, a, d, { people: false });
  return hit.range >= d - slack;
}

function inView(world, tx, ty) {
  const { x, y, th } = world.robot;
  const d = dist(x, y, tx, ty);
  const bearing = wrapAngle(Math.atan2(ty - y, tx - x) - th);
  return { d, bearing, ok: d <= CAMERA_RANGE && Math.abs(bearing) <= CAMERA_FOV / 2 };
}

// Camera: a list of detections with bearing (deg, left positive) and distance (m).
export function camera(world, seed = 0) {
  const noise = rng(Math.floor(world.t * 20) + seed * 101 + 7);
  const n = (s) => (noise() - 0.5) * 2 * s;
  const det = [];
  for (const t of world.totes) {
    if (t.held) continue;
    const v = inView(world, t.x, t.y);
    if (v.ok && visible(world, t.x, t.y, 0.45)) {
      det.push({ kind: "tote", label: `${t.color} tote`, color: t.color, bearing_deg: +(deg(v.bearing) + n(1.5)).toFixed(1), distance_m: +(v.d * (1 + n(0.04))).toFixed(2) });
    }
  }
  for (const k of DOCKS) {
    const v = inView(world, k.x, k.y);
    if (v.ok && visible(world, k.x, k.y)) {
      det.push({ kind: "dock", label: `dock ${k.label} (floor marking)`, dock: k.id, bearing_deg: +(deg(v.bearing) + n(1)).toFixed(1), distance_m: +(v.d * (1 + n(0.03))).toFixed(2) });
    }
  }
  for (const p of world.people) {
    const v = inView(world, p.x, p.y);
    if (v.ok && visible(world, p.x, p.y, 0.3)) {
      det.push({ kind: "person", label: "person (hi-vis vest)", bearing_deg: +(deg(v.bearing) + n(2)).toFixed(1), distance_m: +(v.d * (1 + n(0.05))).toFixed(2) });
    }
  }
  for (const s of world.signs) {
    const v = inView(world, s.x, s.y);
    if (!v.ok || !visible(world, s.x, s.y, 0.2)) continue;
    // A sign can only be read from the front and from close enough.
    const facingUs = Math.cos(wrapAngle(s.facing - Math.atan2(world.robot.y - s.y, world.robot.x - s.x))) > 0.3;
    const readable = facingUs && v.d <= SIGN_READ_RANGE;
    det.push({ kind: "sign", label: "sign", bearing_deg: +(deg(v.bearing) + n(1)).toFixed(1), distance_m: +v.d.toFixed(2),
      text: readable ? s.text : null, source: "scene" });
  }
  for (const z of NO_GO) {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const v = inView(world, cx, cy);
    if (v.ok && visible(world, cx, cy, 1.0)) det.push({ kind: "zone", label: `${z.label} (yellow-black floor hatching)`, bearing_deg: +deg(v.bearing).toFixed(1), distance_m: +v.d.toFixed(2) });
  }
  return det.sort((a, b) => a.distance_m - b.distance_m);
}

// Turn a detection back into an approximate map position.
export function detectionToWorld(robot, d) {
  const a = robot.th + (d.bearing_deg * Math.PI) / 180;
  return { x: robot.x + Math.cos(a) * d.distance_m, y: robot.y + Math.sin(a) * d.distance_m };
}
