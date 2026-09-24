/** Time spent in the parts of the detection (ms), summed over a run, to find the slowest step (plan section 14). */
export const profile: Record<string, number> = {};

export function resetProfile() {
  for (const k of Object.keys(profile)) delete profile[k];
}

/** Runs f and adds its time to the part k. */
export function timed<T>(k: string, f: () => T): T {
  const t = performance.now();
  try {
    return f();
  } finally {
    profile[k] = (profile[k] ?? 0) + performance.now() - t;
  }
}

/** The same for an async f. */
export async function timedAsync<T>(k: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await f();
  } finally {
    profile[k] = (profile[k] ?? 0) + performance.now() - t;
  }
}
