// Transient-contact model from ISO/TS 15066 (power and force limiting), the same one Caziel uses.
//   E_max = F^2 / 2k          energy a body region absorbs at its pain threshold
//   E     = 1/2 * mu * v^2    energy transferred at relative speed v
//   mu    = (1/m_H + 1/m_R)^-1
// Region values are the commonly cited ISO/TS 15066:2016 Annex A numbers (transient = 2x quasi-static).
// This is for estimating risk in simulation, not a safety certification.

export const BODY_REGIONS = {
  hand: { label: "Hand", force: 280, k: 75_000, mass: 0.6 },
  chest: { label: "Chest", force: 280, k: 25_000, mass: 40 },
  thigh: { label: "Thigh", force: 440, k: 50_000, mass: 75 },
};

export const reducedMass = (mH, mR) => 1 / (1 / mH + 1 / mR);
export const energyLimit = (r) => (r.force * r.force) / (2 * r.k);
export const impactEnergy = (r, robotMass, v) => 0.5 * reducedMass(r.mass, robotMass) * v * v;
export const safeSpeed = (r, robotMass) => r.force / Math.sqrt(reducedMass(r.mass, robotMass) * r.k);

// The most restrictive region for a mobile base of this mass.
export function sharedZoneSpeed(robotMass) {
  let best = { speed: Infinity, region: null };
  for (const [key, r] of Object.entries(BODY_REGIONS)) {
    const v = safeSpeed(r, robotMass);
    if (v < best.speed) best = { speed: v, region: key };
  }
  return best;
}

export function worstContact(robotMass, v) {
  let worst = null;
  for (const [key, r] of Object.entries(BODY_REGIONS)) {
    const e = impactEnergy(r, robotMass, v);
    const ratio = e / energyLimit(r);
    if (!worst || ratio > worst.ratio) worst = { region: key, label: r.label, energy: e, limit: energyLimit(r), ratio };
  }
  return worst;
}
