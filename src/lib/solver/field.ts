/**
 * The rule for values that Backtrack detects and the user can override (automation plan section 2). A field is
 * automatic when its detector is confident enough, required when it is not and the user gave nothing, manual when the
 * user gave a value, and manual with a warning when that value differs from a confident automatic one by more than
 * 3 sigma and more than a minimum for its kind. Deterministic, without I/O.
 */
import { angleDiff } from './camera.ts';
import type { Detected, Field, Impact, MapId, Pt, Weapon, XY } from './types.ts';

/** An automatic value with a confidence below this does not count. */
export const REQUIRED_BELOW = 0.5;

/** The kinds of values, with the unit of their sigma. */
export interface Kinds {
  heading: number; // deg
  pitch: number; // deg
  roll: number; // deg
  shell: Pt; // video px
  impact: Impact; // s
  observer: XY; // game units
  crater: XY; // game units
  map: MapId;
  weapon: Weapon;
}
export type Kind = keyof Kinds;

/**
 * The rule of each kind holds the sigma at which the confidence is 50 percent, the least difference that earns a
 * warning, and the difference of two values. The sigmas are first proposals of section 2.2, and the benchmark sets the
 * final values.
 */
const RULES: { [K in Kind]: { limit: number; min: number; diff: (a: Kinds[K], b: Kinds[K]) => number } } = {
  heading: { limit: 0.3, min: 0.5, diff: (a, b) => Math.abs(angleDiff(a, b)) },
  pitch: { limit: 0.3, min: 0.3, diff: (a, b) => Math.abs(a - b) },
  roll: { limit: 0.3, min: 0.3, diff: (a, b) => Math.abs(a - b) },
  shell: { limit: 3, min: 3, diff: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) },
  impact: { limit: 0.1, min: 0.05, diff: (a, b) => Math.abs(impactTime(a) - impactTime(b)) },
  observer: { limit: 0.1, min: 0.1, diff: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) },
  crater: { limit: 0.25, min: 0.1, diff: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) },
  map: { limit: 0, min: 0, diff: (a, b) => (a === b ? 0 : 1) },
  weapon: { limit: 0, min: 0, diff: (a, b) => (a === b ? 0 : 1) },
};

/** The impact time the solver uses, which is the middle of the interval (section 9). */
export const impactTime = (i: Impact) => (i.a + i.b) / 2;
/** Its standard deviation, which is half the interval. */
export const impactSigma = (i: Impact) => (i.b - i.a) / 2;

/** The confidence (0 to 1) of a value with standard deviation sigma. It is 50 percent at the limit of its kind. */
export const confSigma = (kind: Kind, sigma: number) => 2 ** -((sigma / RULES[kind].limit) ** 2);
/** The confidence from the ratio of the best score to the next one. It is 0 at a ratio of 1 and 50 percent at `limit`. */
export const confRatio = (ratio: number, limit: number) => (ratio <= 1 ? 0 : 1 - 2 ** -((ratio - 1) / (limit - 1)));
/** A detection with its confidence from sigma. */
export const detected = <K extends Kind>(kind: K, value: Kinds[K] | undefined, sigma: number, reason?: string): Detected<Kinds[K]> =>
  ({ value, sigma, conf: value === undefined ? 0 : confSigma(kind, sigma), ...(reason ? { reason } : {}) });

/** The automatic value, when it is confident enough to count. */
export function autoValue<T>(f: Field<T> | undefined): T | undefined {
  const a = f?.auto;
  return a && a.value !== undefined && a.conf >= REQUIRED_BELOW ? a.value : undefined;
}
/** The value the solver uses, which is the user's value or else a confident automatic one. */
export const value = <T>(f: Field<T> | undefined): T | undefined => f?.manual ?? autoValue(f);
/** The standard deviation that goes with value(). An automatic value has the one of its detector, a manual value none. */
export const sigmaOf = <T>(f: Field<T> | undefined): number | undefined => (f?.manual === undefined && autoValue(f) !== undefined ? f!.auto!.sigma : undefined);

export type FieldState = 'auto' | 'required' | 'manual' | 'warned';

/** How far a manual value is off a confident automatic one, when that earns a warning (section 2.2). */
export function offBy<K extends Kind>(kind: K, f: Field<Kinds[K]> | undefined): number | null {
  const a = autoValue(f), m = f?.manual;
  if (a === undefined || m === undefined) return null;
  const r = RULES[kind] as { min: number; diff: (a: Kinds[K], b: Kinds[K]) => number };
  const d = r.diff(m, a), sigma = f!.auto!.sigma ?? 0;
  return d > r.min && d > 3 * sigma ? d : null;
}

export function fieldState<K extends Kind>(kind: K, f: Field<Kinds[K]> | undefined): FieldState {
  if (f?.manual !== undefined) return offBy(kind, f) != null ? 'warned' : 'manual';
  return autoValue(f) !== undefined ? 'auto' : 'required';
}

/** An empty field. */
export const field = <T>(manual?: T): Field<T> => (manual === undefined ? {} : { manual });

const UNITS: Record<Kind, string> = { heading: 'deg', pitch: 'deg', roll: 'deg', shell: 'px', impact: 's', observer: 'units', crater: 'units', map: '', weapon: '' };

/**
 * The warning of a manual value that differs from a confident automatic one, for the field and the result notes. The
 * warning opens with `what`, the name of the value.
 */
export function fieldWarning<K extends Kind>(kind: K, f: Field<Kinds[K]> | undefined, fmt: (v: Kinds[K]) => string, what = 'Your value'): string | null {
  const d = offBy(kind, f);
  if (d == null) return null;
  const a = autoValue(f)!;
  const by = kind === 'map' || kind === 'weapon' ? '' : ` by ${d.toFixed(kind === 'observer' || kind === 'crater' ? 2 : kind === 'impact' ? 3 : 1)} ${UNITS[kind]}`;
  return `${what} differs from the automatic ${fmt(a)}${by}.`;
}
