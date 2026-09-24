/**
 * Settings of the user rather than of a project, kept in this browser: the field of view of the game, set once. The
 * project copies them (App.svelte), so the solver and the annotation files still see the FOV a solve used.
 */

const KEY = 'backtrack:prefs';

export interface Prefs {
  /** The field of view of the game (deg), and whether the game gives it horizontally or vertically. */
  fovDeg: number; fovAxis: 'h' | 'v';
  /** The user saved the settings once; until then the header asks for them. */
  saved: boolean;
}

const DEFAULTS: Prefs = { fovDeg: 90, fovAxis: 'h', saved: false };

function stored(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

export const prefs: Prefs = $state(stored());

/** Changes the settings and keeps them in this browser. */
export function setPrefs(change: Partial<Prefs>) {
  Object.assign(prefs, change, { saved: true });
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
}

/** The range of FOV the game allows, as the settings dialog takes it. */
export const FOV_RANGE = { min: 30, max: 150 };
