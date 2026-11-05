# Changelog

## 1.0.0 (2026-11-04)

First release.

- Simulator: 20 x 14 m warehouse with shelves, docks, no-go zones, totes, walking people and signs; differential-drive robot with acceleration and braking limits, a gripper, and contact physics.
- Sensors: 90° camera with occlusion and noise, 120-beam lidar. Perception with untrusted-text labelling and prompt-injection screening.
- Brains: A* planner with a search/approach/pick/deliver state machine, and Claude as a vision-language-action brain (one tool call per step, camera frames in the browser).
- Safety shield: fleet speed cap, ISO/TS 15066 safe speed near people, protective stop, no-go zones, arm hold near people.
- Benchmark: 3 scenarios x 20 seeds x shield on/off, written to results/bench.json and checked in CI.
- Live site: 3D warehouse, robot camera view with detection boxes, lidar plot, brain log, mission control, and Claude via an API key or claude.ai.
