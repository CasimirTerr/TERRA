#!/usr/bin/env node
// Benchmark: run a brain across every scenario, with and without the safety shield.
//
//   node bench/run.js                         reflex planner, 20 seeds, writes results/bench.json
//   node bench/run.js --seeds 5
//   ANTHROPIC_API_KEY=... node bench/run.js --brain claude --seeds 3 --out results/claude.json
//
// Every episode is deterministic for a given scenario and seed (except the Claude brain).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Sim, runEpisode } from "../sim/sim.js";
import { SCENARIOS } from "../sim/world.js";
import { ReflexBrain } from "../sim/brains/reflex.js";
import { ClaudeBrain, apiTransport } from "../sim/brains/claude.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const seeds = Number(arg("seeds", 20));
const brainName = arg("brain", "reflex");
const out = arg("out", brainName === "reflex" ? "results/bench.json" : `results/${brainName}.json`);

function makeBrain() {
  if (brainName === "reflex") return new ReflexBrain();
  if (brainName === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY to benchmark the Claude brain.");
    return new ClaudeBrain({ transport: apiTransport(process.env.ANTHROPIC_API_KEY) });
  }
  throw new Error(`unknown brain ${brainName}`);
}

function summarize(runs) {
  const n = runs.length;
  const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
  const gaps = runs.map((r) => r.min_person_gap_m).filter((g) => g !== null);
  const interventions = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.interventions)) interventions[k] = (interventions[k] || 0) + v;
  return {
    episodes: n,
    success_rate: +(sum((r) => (r.success ? 1 : 0)) / n).toFixed(3),
    mean_time_s: +(sum((r) => r.time_s) / n).toFixed(1),
    episodes_with_contact: sum((r) => (r.contacts ? 1 : 0)),
    contacts: sum((r) => r.contacts),
    worst_contact_ratio: Math.max(0, ...runs.map((r) => r.worst_contact_ratio)),
    worst_contact_speed: Math.max(0, ...runs.map((r) => r.worst_contact_speed)),
    closest_gap_m: gaps.length ? +Math.min(...gaps).toFixed(2) : null,
    bumps: sum((r) => r.bumps),
    no_go_entries: sum((r) => (r.no_go ? 1 : 0)),
    injection_alerts: sum((r) => r.injection_alerts),
    interventions,
  };
}

const started = Date.now();
const table = [];
const episodes = [];
for (const scenario of Object.keys(SCENARIOS)) {
  for (const shield of [true, false]) {
    const runs = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const sim = new Sim({ scenario, seed, shield });
      const m = await runEpisode(sim, makeBrain());
      runs.push(m);
      episodes.push(m);
    }
    const row = { scenario, label: SCENARIOS[scenario].label, shield, ...summarize(runs) };
    table.push(row);
    console.log(
      `${scenario.padEnd(10)} shield=${shield ? "on " : "off"}  success ${(row.success_rate * 100).toFixed(0).padStart(3)}%  ` +
      `contacts ${String(row.contacts).padStart(3)} in ${row.episodes_with_contact}/${row.episodes} episodes  ` +
      `worst ${row.worst_contact_ratio.toFixed(1)}x  closest ${row.closest_gap_m} m  mean ${row.mean_time_s}s`,
    );
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ brain: brainName, seeds, generated_by: "bench/run.js", table, episodes }, null, 1) + "\n");
console.log(`\n${episodes.length} episodes in ${((Date.now() - started) / 1000).toFixed(1)} s → ${out}`);
