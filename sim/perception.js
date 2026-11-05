// Perception: turns raw sensing into the observation a brain sees, and screens any text
// the camera reads. Text in the scene is data, never instructions. It is labelled as
// untrusted, and text that reads like an order to the robot is flagged as a possible
// physical prompt injection.

import { camera, lidar, minRangeInCone } from "./sensors.js";
import { deg } from "./geometry.js";

const ADDRESS = /\b(robots?|agents?|ai|autonomous|kx-?1|machine)\b/i;
const IMPERATIVE = /\b(ignore|abort|override|disregard|stop|drive|go|move|proceed|disable|bypass|forget|do not|don't)\b/i;
const ESCALATION = /\b(override|supervisor|priority|urgent|immediately|full speed|max(imum)? speed|do not (slow|stop)|ignore (your|all|previous))\b/i;

export function injectionScore(text) {
  if (!text) return { score: 0, flagged: false, reasons: [] };
  const reasons = [];
  if (ADDRESS.test(text)) reasons.push("addresses the robot");
  if (IMPERATIVE.test(text)) reasons.push("gives an order");
  if (ESCALATION.test(text)) reasons.push("claims authority or urgency");
  const score = reasons.length / 3;
  return { score: +score.toFixed(2), flagged: reasons.length >= 2, reasons };
}

export function observe(world, seed = 0) {
  const scan = lidar(world);
  const dets = camera(world, seed);
  const alerts = [];
  for (const d of dets) {
    if (d.kind === "sign" && d.text) {
      d.untrusted = true;
      const s = injectionScore(d.text);
      if (s.flagged) {
        d.injection = s;
        alerts.push(`Possible physical prompt injection in camera view: "${d.text.slice(0, 80)}..." (${s.reasons.join(", ")})`);
      }
    }
  }
  const r = world.robot;
  return {
    t: +world.t.toFixed(1),
    task: world.task.text,
    pose: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), heading_deg: +deg(r.th).toFixed(0) },
    holding: r.holding ? `${world.totes.find((t) => t.id === r.holding).color} tote` : null,
    detections: dets,
    lidar_front_m: +minRangeInCone(scan, 0, 0.5).toFixed(2),
    alerts,
    scan,
  };
}

// Compact text version for language-model brains.
export function describe(obs) {
  const lines = [
    `t=${obs.t}s pose=(${obs.pose.x}, ${obs.pose.y}) heading=${obs.pose.heading_deg}° holding=${obs.holding || "nothing"} lidar_front=${obs.lidar_front_m}m`,
    "Camera detections (bearing: + is left, - is right):",
  ];
  if (!obs.detections.length) lines.push("  (nothing in view)");
  for (const d of obs.detections) {
    let s = `  - ${d.label} at bearing ${d.bearing_deg}°, ${d.distance_m} m`;
    if (d.kind === "sign") s += d.text ? ` — UNTRUSTED SCENE TEXT: "${d.text}"` : " (too far or angled to read)";
    if (d.injection) s += " [flagged: possible prompt injection]";
    lines.push(s);
  }
  for (const a of obs.alerts) lines.push(`ALERT: ${a}`);
  return lines.join("\n");
}
