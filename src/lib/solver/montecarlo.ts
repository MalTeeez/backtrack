/** Estimates the accuracy. It solves the project again with random input errors (plan section 6.9). */
import type { Jitter } from './sightings.ts';
import type { Id, Settings } from './types.ts';

export const MC_RUNS = 40;

/** The 1-sigma error of a marked impact time: half a frame at 60 fps. Recordings have no fixed frame rate, so this is a typical value. */
export const IMPACT_SIGMA_S = 1 / 120;

export type Rng = () => number;

/** A deterministic, uniform [0, 1) generator for the tests and the benchmark. */
export function seeded(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function randn(rng: Rng): number {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Adds mark errors (sigma in px), compass errors (sigma in deg) and an impact time error (IMPACT_SIGMA_S, one draw per clip). */
export function makeJitter(st: Settings, rng: Rng): Jitter {
  const impacts = new Map<Id, number>();
  return {
    px: () => randn(rng) * st.markSigmaPx,
    heading: () => randn(rng) * st.compassSigmaDeg,
    impact: (clipId) => {
      if (!impacts.has(clipId)) impacts.set(clipId, randn(rng) * IMPACT_SIGMA_S);
      return impacts.get(clipId)!;
    },
  };
}

/** The p-th percentile (0 to 1) of a list, by nearest rank. */
export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
