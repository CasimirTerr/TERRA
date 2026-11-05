// The safety shield. Every command the brain issues, and every wheel command on every
// tick, goes through here before it reaches the motors. The brain can be a planner or a
// language model, and it can be wrong or manipulated, so the shield trusts none of it.
// It only uses the robot's own sensors and the static map.
//
//   precheck  refuses a command outright (a goal inside a no-go zone, a pick next to a person)
//   filter    limits the velocity on each tick (fleet cap, people nearby, protective stop,
//             no-go boundary)

import { NO_GO, PERSON_RADIUS, ROBOT } from "./world.js";
import { pointInRect, wrapAngle } from "./geometry.js";
import { LIDAR_RANGE, raycast } from "./sensors.js";
import { sharedZoneSpeed } from "./physics.js";

export const RULES = {
  "S1-fleet-cap": "Fleet speed cap in the building",
  "S2-people": "Speed limited with a person ahead within 2 m (ISO/TS 15066 safe speed)",
  "S3-stop": "Protective stop: obstacle inside braking distance",
  "S4-no-go": "No-go zone",
  "S5-arm": "Arm motion refused with a person in reach",
};

export class Shield {
  constructor({ enabled = true, fleetCap = 1.2, peopleRadius = 2.0, armClearance = 1.2 } = {}) {
    this.enabled = enabled;
    this.fleetCap = fleetCap;
    this.peopleRadius = peopleRadius;
    this.armClearance = armClearance;
    const z = sharedZoneSpeed(ROBOT.mass);
    this.peopleSpeed = Math.floor(z.speed * 100) / 100; // 0.29 m/s for the KX-1 (thigh)
    this.peopleRegion = z.region;
    this.active = new Set();
    this.counts = {};
  }

  // Dynamic obstacles: lidar returns the static map can't explain.
  dynamicObstacles(world, scan) {
    const { x, y, th } = world.robot;
    const out = [];
    for (let i = 0; i < scan.length; i++) {
      if (scan[i] >= LIDAR_RANGE - 0.01) continue;
      const a = th + (i / scan.length) * Math.PI * 2;
      const expected = raycast(world, x, y, a, LIDAR_RANGE, { people: false }).range;
      if (scan[i] < expected - 0.15) out.push({ range: scan[i], bearing: wrapAngle(a - th) });
    }
    return out;
  }

  precheck(world, cmd, scan) {
    if (!this.enabled) return { ok: true };
    if (cmd.tool === "navigate_to") {
      for (const z of NO_GO) {
        if (pointInRect(cmd.args.x, cmd.args.y, z, ROBOT.radius)) {
          return this.refuse("S4-no-go", `Goal (${cmd.args.x}, ${cmd.args.y}) is inside the ${z.label} no-go zone. The robot is never allowed there.`);
        }
      }
    }
    if (cmd.tool === "move") {
      const { x, y, th } = world.robot;
      const ex = x + Math.cos(th) * cmd.args.distance;
      const ey = y + Math.sin(th) * cmd.args.distance;
      for (const z of NO_GO) {
        if (pointInRect(ex, ey, z, ROBOT.radius)) return this.refuse("S4-no-go", `That move ends inside the ${z.label} no-go zone.`);
      }
    }
    if (cmd.tool === "pick" || cmd.tool === "place") {
      const near = this.dynamicObstacles(world, scan).filter((o) => o.range < this.armClearance + PERSON_RADIUS);
      if (near.length) return this.refuse("S5-arm", `A person is within ${this.armClearance} m. The arm waits until they move away.`);
    }
    return { ok: true };
  }

  refuse(rule, text) {
    this.counts[rule] = (this.counts[rule] || 0) + 1;
    return { ok: false, rule, text };
  }

  filter(world, scan, v, w) {
    const events = [];
    const fired = new Set();
    let vOut = Math.max(-0.3, Math.min(ROBOT.hardwareSpeed, v));
    if (this.enabled) {
      if (vOut > this.fleetCap) { vOut = this.fleetCap; fired.add("S1-fleet-cap"); }
      const dyn = this.dynamicObstacles(world, scan);
      // People ahead of or beside the robot (not behind it, relative to where it's going).
      const heading = vOut >= 0 ? 0 : Math.PI;
      const nearest = dyn.filter((o) => Math.abs(wrapAngle(o.bearing - heading)) < 1.75).reduce((m, o) => Math.min(m, o.range), Infinity);
      if (nearest < this.peopleRadius && Math.abs(vOut) > this.peopleSpeed) {
        vOut = Math.sign(vOut) * this.peopleSpeed;
        fired.add("S2-people");
      }
      // Protective stop, looking where the robot is going.
      const speed = Math.abs(world.robot.v);
      const dir = vOut >= 0 ? 0 : Math.PI;
      const brakeDist = (speed * speed) / (2 * ROBOT.brake);
      let blocked = false;
      for (let i = 0; i < scan.length && vOut !== 0; i++) {
        const a = wrapAngle((i / scan.length) * Math.PI * 2 - dir);
        if (Math.abs(a) > 0.6) continue;
        const isDyn = dyn.some((o) => Math.abs(wrapAngle(o.bearing - (i / scan.length) * Math.PI * 2)) < 0.03);
        const margin = ROBOT.radius + (isDyn ? 0.55 : 0.12) + brakeDist;
        if (scan[i] * Math.cos(a) < margin && scan[i] < margin + 0.6) { blocked = true; break; }
      }
      if (blocked) { vOut = 0; fired.add("S3-stop"); }
      // No-go boundary: don't let the next 0.6 s of motion cross into a zone.
      const { x, y, th } = world.robot;
      const lx = x + Math.cos(th) * (vOut * 0.6 + Math.sign(vOut) * ROBOT.radius);
      const ly = y + Math.sin(th) * (vOut * 0.6 + Math.sign(vOut) * ROBOT.radius);
      if (vOut !== 0 && NO_GO.some((z) => pointInRect(lx, ly, z))) { vOut = 0; fired.add("S4-no-go"); }
    }
    for (const rule of fired) {
      if (!this.active.has(rule)) {
        this.counts[rule] = (this.counts[rule] || 0) + 1;
        events.push({ rule, text: RULES[rule] });
      }
    }
    this.active = fired;
    return { v: vOut, w, events };
  }
}
