/** Estimates the accuracy. It solves the project again with random input errors (plan section 6.9). */
import type { Jitter } from './sightings.ts';
import type { Id, Settings } from './types.ts';

export const MC_RUNS = 40;

/** The least error of an impact time (s), for an interval of zero width. */
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

/**
 * Adds mark errors (px), compass errors (deg) and errors of automatic angles (deg), each with the sigma of its value or
 * the accuracy of the settings, and an impact time error (one draw per clip, anywhere in the impact interval).
 */
export function makeJitter(st: Settings, rng: Rng): Jitter {
  const impacts = new Map<Id, number>(), groups = new Map<string, number>();
  // one standard normal draw per group, so values of one fit move together
  const shared = (group: string | undefined) => {
    if (!group) return randn(rng);
    if (!groups.has(group)) groups.set(group, randn(rng));
    return groups.get(group)!;
  };
  return {
    px: (sigma = st.markSigmaPx) => randn(rng) * sigma,
    heading: (sigma = st.compassSigmaDeg, group) => shared(group) * sigma,
    angle: (sigma, group) => shared(group) * sigma,
    impact: (clipId, half) => {
      if (!impacts.has(clipId)) impacts.set(clipId, half > 0 ? (2 * rng() - 1) * half : randn(rng) * IMPACT_SIGMA_S);
      return impacts.get(clipId)!;
    },
  };
}

/** The p-th percentile (0 to 1) of a list, by nearest rank. */
export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
