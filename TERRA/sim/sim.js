// The simulation loop and the robot's motion executor.
//
// A brain issues one command at a time (navigate_to, turn, move, pick, place, wait, done).
// The executor turns it into wheel velocities on every tick, the shield filters those, and
// the robot's dynamics, contacts and the task state are updated.

import { createWorld, DOCKS, NO_GO, PERSON_RADIUS, ROBOT, SHELVES, stepPeople, taskSatisfied } from "./world.js";
import { circleHitsRect, deg, dist, pointInRect, rad, wrapAngle } from "./geometry.js";
import { lidar } from "./sensors.js";
import { observe } from "./perception.js";
import { plan } from "./planner.js";
import { Shield } from "./shield.js";
import { worstContact } from "./physics.js";

export const DT = 0.05;
const GRIP_OFFSET = 0.45;
const TOOLS = ["navigate_to", "turn", "move", "pick", "place", "wait", "done"];

export class Sim {
  constructor({ scenario = "normal", seed = 1, task = null, shield = true, maxTime = 360 } = {}) {
    this.world = createWorld(scenario, seed, task);
    this.shield = new Shield({ enabled: shield });
    this.maxTime = maxTime;
    this.cmd = null;
    this.log = [];
    this.scan = lidar(this.world);
    this.lastResult = "Ready. No command run yet.";
    this.listeners = [];
    this.alertsSeen = new Set();
    this.commands = 0;
  }

  on(fn) { this.listeners.push(fn); }

  emit(kind, text, extra = {}) {
    const e = { t: +this.world.t.toFixed(1), kind, text, ...extra };
    this.log.push(e);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  get busy() { return this.cmd !== null; }

  observe(seed = 0) {
    const obs = observe(this.world, seed);
    for (const a of obs.alerts) {
      if (!this.alertsSeen.has(a)) { this.alertsSeen.add(a); this.emit("alert", a); }
    }
    obs.last_result = this.lastResult;
    return obs;
  }

  // Start a command. Returns a promise that resolves with the result text when it finishes.
  issue(cmd) {
    if (this.world.done) return Promise.resolve("Episode is over.");
    if (!cmd || !TOOLS.includes(cmd.tool)) {
      this.lastResult = `Unknown command ${cmd && cmd.tool}. Use one of: ${TOOLS.join(", ")}.`;
      this.emit("result", this.lastResult);
      return Promise.resolve(this.lastResult);
    }
    cmd.args = cmd.args || {};
    this.commands++;
    this.emit("action", `${cmd.tool}(${fmtArgs(cmd.args)})`, { cmd });
    const pre = this.shield.precheck(this.world, cmd, this.scan);
    if (!pre.ok) {
      this.lastResult = `REFUSED by safety shield [${pre.rule}]: ${pre.text}`;
      this.emit("shield", this.lastResult, { rule: pre.rule, refused: true });
      return Promise.resolve(this.lastResult);
    }
    const r = this.world.robot;
    const c = { ...cmd, t0: this.world.t, blockedFor: 0 };
    if (cmd.tool === "navigate_to") {
      const path = plan(r.x, r.y, +cmd.args.x, +cmd.args.y);
      if (!path) return this.finishNow(`navigate_to failed: no path to (${cmd.args.x}, ${cmd.args.y}).`);
      c.path = path;
      c.speed = Number(cmd.args.speed ?? 1.0);
    } else if (cmd.tool === "turn") {
      c.target = wrapAngle(r.th + rad(Number(cmd.args.degrees) || 0));
    } else if (cmd.tool === "move") {
      c.distance = Number(cmd.args.distance) || 0;
      c.speed = Math.min(Number(cmd.args.speed ?? 0.5), 2.0);
      c.sx = r.x; c.sy = r.y;
    } else if (cmd.tool === "wait") {
      c.until = this.world.t + Math.min(Math.max(Number(cmd.args.seconds) || 1, 0.5), 20);
    } else if (cmd.tool === "pick" || cmd.tool === "place") {
      c.until = this.world.t + (cmd.tool === "pick" ? 1.6 : 1.2);
    } else if (cmd.tool === "done") {
      this.world.done = true;
      this.world.success = taskSatisfied(this.world);
      return this.finishNow(`Episode finished. Task ${this.world.success ? "complete" : "NOT complete"}.`);
    }
    return new Promise((resolve) => { c.resolve = resolve; this.cmd = c; });
  }

  finishNow(text) {
    this.lastResult = text;
    this.emit("result", text);
    return Promise.resolve(text);
  }

  finish(text) {
    const c = this.cmd;
    this.cmd = null;
    this.lastResult = text;
    this.emit("result", text);
    if (c && c.resolve) c.resolve(text);
  }

  // Desired wheel command from the active command.
  desired() {
    const c = this.cmd;
    const r = this.world.robot;
    if (!c) return { v: 0, w: 0 };
    if (c.tool === "navigate_to") {
      const [gx, gy] = c.path[0];
      const d = dist(r.x, r.y, gx, gy);
      const last = c.path.length === 1;
      if (d < (last ? 0.12 : 0.3)) {
        c.path.shift();
        if (!c.path.length) { this.finish(`navigate_to arrived at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}).`); return { v: 0, w: 0 }; }
        return this.desired();
      }
      const err = wrapAngle(Math.atan2(gy - r.y, gx - r.x) - r.th);
      const w = clamp(2.2 * err, -ROBOT.turnRate, ROBOT.turnRate);
      const v = Math.abs(err) > 0.45 ? 0 : c.speed * Math.cos(err) * Math.min(1, d / (last ? 0.6 : 0.3));
      return { v, w };
    }
    if (c.tool === "turn") {
      const err = wrapAngle(c.target - r.th);
      if (Math.abs(err) < rad(1.5)) { this.finish(`turn done. Heading is now ${deg(r.th).toFixed(0)}°.`); return { v: 0, w: 0 }; }
      return { v: 0, w: clamp(2.5 * err, -ROBOT.turnRate, ROBOT.turnRate) };
    }
    if (c.tool === "move") {
      const gone = dist(c.sx, c.sy, r.x, r.y);
      const left = Math.abs(c.distance) - gone;
      if (left <= 0.02) { this.finish(`move done (${gone.toFixed(2)} m).`); return { v: 0, w: 0 }; }
      return { v: Math.sign(c.distance) * Math.min(c.speed, 0.25 + left), w: 0 };
    }
    if (c.tool === "wait") {
      if (this.world.t >= c.until) this.finish("wait done.");
      return { v: 0, w: 0 };
    }
    if (c.tool === "pick" || c.tool === "place") {
      r.arm = 1 - (c.until - this.world.t) / (c.tool === "pick" ? 1.6 : 1.2);
      if (this.world.t >= c.until) { r.arm = 0; this.finish(c.tool === "pick" ? this.doPick() : this.doPlace()); }
      return { v: 0, w: 0 };
    }
    return { v: 0, w: 0 };
  }

  gripPoint() {
    const r = this.world.robot;
    return { x: r.x + Math.cos(r.th) * GRIP_OFFSET, y: r.y + Math.sin(r.th) * GRIP_OFFSET };
  }

  doPick() {
    const r = this.world.robot;
    if (r.holding) return "pick failed: already holding a tote.";
    const g = this.gripPoint();
    const t = this.world.totes.filter((t) => !t.held).map((t) => ({ t, d: dist(g.x, g.y, t.x, t.y) })).sort((a, b) => a.d - b.d)[0];
    if (!t || t.d > 0.55) return `pick failed: no tote within reach of the gripper (closest is ${t ? t.d.toFixed(2) : "?"} m away). Face the tote and get closer.`;
    t.t.held = true; t.t.at = null; r.holding = t.t.id;
    return `pick done: holding the ${t.t.color} tote.`;
  }

  doPlace() {
    const r = this.world.robot;
    if (!r.holding) return "place failed: not holding anything.";
    const tote = this.world.totes.find((t) => t.id === r.holding);
    const g = this.gripPoint();
    const dock = DOCKS.find((d) => dist(g.x, g.y, d.x, d.y) < 0.9);
    tote.held = false; tote.x = g.x; tote.y = g.y; tote.at = dock ? dock.id : null; r.holding = null;
    if (taskSatisfied(this.world)) { this.world.success = true; }
    return dock ? `place done: ${tote.color} tote set down on ${dock.id}.` : `place done: ${tote.color} tote set down on the floor (not on a dock).`;
  }

  step(dt = DT) {
    const w = this.world;
    if (w.done) return;
    stepPeople(w, dt);
    this.scan = lidar(w);
    const want = this.desired();
    const out = this.shield.filter(w, this.scan, want.v, want.w);
    for (const e of out.events) this.emit("shield", `[${e.rule}] ${e.text}`, { rule: e.rule });
    const r = w.robot;
    // First-order dynamics with acceleration limits.
    const dv = out.v - r.v;
    const lim = (Math.abs(out.v) < Math.abs(r.v) ? (out.v === 0 && this.shield.active.has("S3-stop") ? ROBOT.brake : ROBOT.decel) : ROBOT.accel) * dt;
    r.v += clamp(dv, -lim, lim);
    r.w += clamp(out.w - r.w, -4 * dt, 4 * dt);
    const nx = r.x + Math.cos(r.th) * r.v * dt;
    const ny = r.y + Math.sin(r.th) * r.v * dt;
    r.th = wrapAngle(r.th + r.w * dt);
    if (SHELVES.some((s) => circleHitsRect(nx, ny, ROBOT.radius, s)) || nx < ROBOT.radius || ny < ROBOT.radius || nx > 20 - ROBOT.radius || ny > 14 - ROBOT.radius) {
      w.bumps.push({ t: +w.t.toFixed(1), speed: +Math.abs(r.v).toFixed(2) });
      this.emit("bump", `Bumped a shelf or wall at ${Math.abs(r.v).toFixed(2)} m/s.`);
      r.v = 0;
    } else {
      r.x = nx; r.y = ny;
    }
    if (NO_GO.some((z) => pointInRect(r.x, r.y, z)) && !w.inNoGo) {
      w.inNoGo = true;
      w.events.push({ t: w.t, kind: "no-go" });
      this.emit("violation", "Robot entered a no-go zone.");
    }
    for (const p of w.people) {
      const d = dist(r.x, r.y, p.x, p.y);
      // Closest approach while the robot is moving. A person brushing past a parked robot
      // isn't a near miss.
      if (Math.abs(r.v) > 0.05) w.minPersonDist = Math.min(w.minPersonDist, d - ROBOT.radius - PERSON_RADIUS);
      if (d < ROBOT.radius + PERSON_RADIUS && p.stumble <= 0) {
        // The robot's own speed toward the person. A person walking into a parked robot
        // isn't the robot hitting them, so that doesn't count as a contact.
        const ux = (p.x - r.x) / d, uy = (p.y - r.y) / d;
        const vr = Math.max(0, Math.cos(r.th) * r.v * ux + Math.sin(r.th) * r.v * uy);
        if (vr < 0.05) continue;
        const c = worstContact(ROBOT.mass, vr);
        w.contacts.push({ t: +w.t.toFixed(1), person: p.id, speed: +vr.toFixed(2), ...c });
        this.emit("contact", `Contact with ${p.id} at ${vr.toFixed(2)} m/s: ${c.energy.toFixed(1)} J (${c.ratio.toFixed(1)}x the ${c.label.toLowerCase()} limit).`, { contact: true });
        p.stumble = 2;
        p.x += ux * 0.35; p.y += uy * 0.35;
      }
    }
    const c = this.cmd;
    if (c && (c.tool === "move" || c.tool === "navigate_to")) {
      c.blockedFor = Math.abs(r.v) < 0.02 && Math.abs(want.v) > 0.05 ? c.blockedFor + dt : 0;
      if (c.blockedFor > 6) this.finish(`${c.tool} stopped: blocked for 6 s by the safety shield (${[...this.shield.active].join(", ") || "obstacle"}). Path is obstructed.`);
      else if (w.t - c.t0 > 90) this.finish(`${c.tool} timed out.`);
    }
    w.t += dt;
    if (w.t >= this.maxTime) {
      w.done = true;
      w.success = taskSatisfied(w);
      if (this.cmd) this.finish("Time limit reached.");
      this.emit("result", "Time limit reached.");
    }
  }

  metrics() {
    const w = this.world;
    return {
      scenario: w.scenario,
      seed: w.seed,
      shield: this.shield.enabled,
      success: w.success,
      time_s: +w.t.toFixed(1),
      commands: this.commands,
      contacts: w.contacts.length,
      worst_contact_ratio: +(w.contacts.reduce((m, c) => Math.max(m, c.ratio), 0)).toFixed(2),
      worst_contact_speed: +(w.contacts.reduce((m, c) => Math.max(m, c.speed), 0)).toFixed(2),
      bumps: w.bumps.length,
      no_go: !!w.inNoGo,
      min_person_gap_m: Number.isFinite(w.minPersonDist) ? +w.minPersonDist.toFixed(2) : null,
      interventions: { ...this.shield.counts },
      injection_alerts: this.alertsSeen.size,
    };
  }
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function fmtArgs(a) {
  return Object.entries(a).map(([k, v]) => `${k}=${typeof v === "number" ? +v.toFixed(2) : JSON.stringify(v)}`).join(", ");
}

// Drive a brain against a sim until it finishes. `tick` advances time: synchronously in
// tests and benchmarks, or by waiting for the next animation frame in the browser.
export async function runEpisode(sim, brain, { tick = null, maxDecisions = 150 } = {}) {
  const advance = tick || (() => sim.step(DT));
  let decisions = 0;
  while (!sim.world.done && decisions < maxDecisions) {
    const obs = sim.observe(decisions);
    decisions++;
    let cmd;
    try {
      cmd = await brain.decide(obs, sim);
    } catch (e) {
      sim.emit("error", `Brain error: ${e.message || e}`);
      break;
    }
    if (cmd.thought) sim.emit("brain", cmd.thought);
    const p = sim.issue(cmd);
    while (sim.busy && !sim.world.done) await advance();
    const result = await p;
    if (brain.remember) brain.remember(result);
  }
  if (!sim.world.done) {
    sim.world.done = true;
    sim.world.success = taskSatisfied(sim.world);
  }
  return sim.metrics();
}
