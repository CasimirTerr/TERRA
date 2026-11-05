// The classical brain: no language model. It looks for the tote with the camera, plans
// paths with A*, and runs a small state machine: search → approach → pick → deliver.
// It never reads sign text, so a malicious sign can't redirect it. That's also why it
// can only do the one task it was programmed for.

import { AISLES, DOCKS } from "../world.js";
import { detectionToWorld } from "../sensors.js";
import { deg, dist } from "../geometry.js";

// Places to stand and look down each aisle, from the west end and the middle.
const LOOKOUTS = AISLES.flatMap((a) => [
  { x: 4.3, y: a.y, look: 0 },
  { x: 11.0, y: a.y, look: 0 },
  { x: 11.0, y: a.y, look: Math.PI },
]);

export class ReflexBrain {
  constructor() {
    this.name = "Reflex planner";
    this.phase = "search";
    this.seen = null; // estimated map position of the target tote
    this.visited = new Set();
    this.queue = [];
  }

  async decide(obs, sim) {
    const world = sim.world;
    const r = world.robot;
    const task = world.task;
    const target = obs.detections.find((d) => d.kind === "tote" && d.color === task.color);
    if (target && !obs.holding) {
      const p = detectionToWorld(r, target);
      if (!this.seen || dist(p.x, p.y, this.seen.x, this.seen.y) > 0.5 || this.phase === "search") {
        this.seen = p;
        if (this.phase === "search") { this.queue = []; this.phase = "approach"; }
      }
    }
    if (this.queue.length) {
      const next = this.queue.shift();
      if (next.lookAt !== undefined) next.args = { degrees: +deg(normal(next.lookAt - r.th)).toFixed(0) };
      return next;
    }

    const last = obs.last_result || "";
    if (obs.holding) {
      if (this.phase !== "deliver" && this.phase !== "detour") {
        this.phase = "deliver";
        const dock = DOCKS.find((d) => d.id === task.dock);
        return cmd("navigate_to", { x: dock.x + 0.75, y: dock.y, speed: 1.0 }, `Holding the ${task.color} tote. Heading to ${dock.id}.`);
      }
      if (last.startsWith("navigate_to arrived")) {
        const turnBy = deg(normal(Math.PI - r.th));
        this.queue.push(cmd("place", {}, "Set it down on the dock."));
        return cmd("turn", { degrees: +turnBy.toFixed(0) }, "Face the dock.");
      }
      if (last.startsWith("REFUSED") || last.includes("blocked")) {
        this.blocked = (this.blocked || 0) + 1;
        if (this.blocked >= 2 && r.x > 6) {
          // Stuck in a busy aisle: go around through the east cross-aisle instead.
          this.blocked = 0;
          this.phase = "detour";
          return cmd("navigate_to", { x: 18.0, y: +r.y.toFixed(2), speed: 1.0 }, "This aisle is busy. Going around the other way.");
        }
        return cmd("wait", { seconds: 2 }, "Something is in the way. Waiting.");
      }
      this.blocked = 0;
      if (this.phase === "detour") {
        this.phase = "deliver";
        const dock = DOCKS.find((d) => d.id === task.dock);
        const other = AISLES.filter((a) => Math.abs(a.y - r.y) > 1).sort((a, b) => Math.abs(a.y - dock.y) - Math.abs(b.y - dock.y))[0];
        this.queue.push(cmd("navigate_to", { x: dock.x + 0.75, y: dock.y, speed: 1.0 }, `Back toward ${dock.id}.`));
        return cmd("navigate_to", { x: 17.6, y: other.y, speed: 1.0 }, `Taking ${other.id} instead.`);
      }
      if (last.startsWith("place done")) return cmd("done", {}, "Delivered.");
      const dock = DOCKS.find((d) => d.id === task.dock);
      return cmd("navigate_to", { x: dock.x + 0.75, y: dock.y, speed: 1.0 }, "Retrying the route to the dock.");
    }
    if (last.startsWith("place done")) return cmd("done", {}, "Delivered.");

    if (this.phase === "approach" && this.seen) {
      // Stand on the aisle centre line opposite the tote, then face it and close in.
      const aisle = AISLES.reduce((m, a) => (Math.abs(a.y - this.seen.y) < Math.abs(m.y - this.seen.y) ? a : m), AISLES[0]);
      const sx = this.seen.x;
      const sy = aisle.y;
      if (dist(r.x, r.y, sx, sy) > 0.25) {
        return cmd("navigate_to", { x: +sx.toFixed(2), y: +sy.toFixed(2), speed: 1.0 }, `Spotted the ${task.color} tote. Going to stand in front of it.`);
      }
      const heading = Math.atan2(this.seen.y - r.y, this.seen.x - r.x);
      const turn = deg(normal(heading - r.th));
      const gap = Math.max(0, dist(r.x, r.y, this.seen.x, this.seen.y) - 0.45 - 0.08);
      this.phase = "pick";
      if (Math.abs(turn) > 3) this.queue.push(cmd("move", { distance: +gap.toFixed(2), speed: 0.25 }, "Close in slowly."));
      else return cmd("move", { distance: +gap.toFixed(2), speed: 0.25 }, "Close in slowly.");
      return cmd("turn", { degrees: +turn.toFixed(0) }, "Face the tote.");
    }
    if (this.phase === "pick") {
      if (last.includes("[S5-arm]")) return { ...cmd("wait", { seconds: 2 }, "Someone is close to the arm. Waiting for them to pass."), retry: "pick" };
      if (last.startsWith("pick failed")) {
        this.phase = "approach";
        this.fails = (this.fails || 0) + 1;
        if (this.fails > 2) { this.seen = null; this.phase = "search"; this.fails = 0; }
        return cmd("wait", { seconds: 1 }, "Pick missed. Re-approaching.");
      }
      return cmd("pick", {}, "Grab the tote.");
    }

    // Search: go to the next lookout and face down the aisle.
    const order = LOOKOUTS.map((l, i) => ({ l, i })).filter(({ i }) => !this.visited.has(i))
      .sort((a, b) => dist(r.x, r.y, a.l.x, a.l.y) - dist(r.x, r.y, b.l.x, b.l.y));
    if (!order.length) { this.visited.clear(); return cmd("wait", { seconds: 2 }, "Searched everywhere. Looking again."); }
    const { l, i } = order[0];
    this.visited.add(i);
    const turn = deg(normal(l.look - r.th));
    if (dist(r.x, r.y, l.x, l.y) < 0.3) return cmd("turn", { degrees: +turn.toFixed(0) }, "Look down the aisle.");
    this.queue.push({ ...cmd("turn", {}, "Look down the aisle."), lookAt: l.look });
    return cmd("navigate_to", { x: l.x, y: l.y, speed: 1.0 }, `Searching for the ${task.color} tote.`);
  }
}

function cmd(tool, args, thought) {
  return { tool, args, thought };
}

function normal(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
