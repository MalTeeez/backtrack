/** Turns a scene into project data. The data is what a user enters after perfect marks, plus optional errors. */
import type { ProjectData, Pt, Settings, Sighting } from '../../src/lib/solver/types.ts';
import { game, shellPx, type Truth } from './scene.ts';

export const DEFAULT_SETTINGS: Settings = {
  fovDeg: 90, fovAxis: 'h',
  weapon: 'L52', rangeMinM: 600, rangeMaxM: 2600, limitToRange: true,
  bufferS: 40, bitrateMbps: 10, markSigmaPx: 1, compassSigmaDeg: 0.5,
};

/** An impact interval of one frame at the scene frame rate, whose middle is `t`. */
const around = (t: number, fps: number) => ({ a: t - 0.5 / fps, b: t + 0.5 / fps });

/** The weapon range presets of the app (WEAPONS in project.svelte.ts, which needs Svelte to import). */
const RANGES = { L52: [600, 2600], L81: [80, 684] } as const;

export interface Noise {
  shellPx?: () => number;
  edgePx?: () => number;
  /** Added to the typed compass heading of each sighting. */
  heading?: () => number;
  /** Added to the marked impact time. */
  impact?: number;
  /** The error of a frame time (s): the frame shows the shell at its time plus this. */
  time?: () => number;
}

export interface Options {
  n: number;
  impact?: boolean;
  noise?: Noise;
  /** The sightings spread over this many seconds before the impact, as a detected section does. Else over 10 to 90 percent of the flight. */
  last?: number;
  /**
   * The walking path of the observer goes to the solver (Sighting.walkM): exact, or with an error (m) per coordinate
   * and sighting, as the minimap path gives it. Without it the solver thinks the observer stood still.
   */
  walk?: 'exact' | (() => number);
}

/** Makes n sightings over the middle of the flight, the way a user picks them. */
export function sceneProject(tr: Truth, o: Options): ProjectData {
  const z = () => 0;
  const nz = { shellPx: z, edgePx: z, heading: z, impact: 0, ...o.noise };
  const jit = (p: Pt, f: () => number): Pt => ({ x: p.x + f(), y: p.y + f() });
  const C = game(tr.C);
  const sightings: Sighting[] = [];
  for (let i = 0; i < o.n; i++) {
    const u = i / Math.max(1, o.n - 1);
    const t = o.last ? tr.impactTime - o.last + (o.last - 1 / tr.fps) * u : tr.fireTime + tr.T * (0.1 + 0.8 * u);
    const t2 = Math.round(t * tr.fps) / tr.fps; // snap to a frame
    const px = shellPx(tr, Math.min(tr.impactTime, t2 + (nz.time?.() ?? 0)))!;
    const O = tr.observerAt(t2), Oi = tr.observerAt(tr.impactTime), wn = o.walk === 'exact' ? z : o.walk;
    sightings.push({
      id: `s${i}`, shotId: 'shot', clipId: 'clip', timeS: t2, frameW: tr.W, frameH: tr.H,
      shell: { manual: jit(px, nz.shellPx) },
      edges: tr.edges.map(([a, b]) => [jit(a, nz.edgePx), jit(b, nz.edgePx)] as [Pt, Pt]),
      heading: { manual: tr.camH + nz.heading() }, pitch: {}, roll: {},
      ...(wn ? { walkM: [O[0] - Oi[0] + wn(), O[1] - Oi[1] + wn()] as [number, number] } : {}),
    });
  }
  const weapon = tr.weapon;
  return {
    settings: { ...DEFAULT_SETTINGS, fovDeg: tr.fovDeg, weapon, rangeMinM: RANGES[weapon][0], rangeMaxM: RANGES[weapon][1] },
    clips: {},
    shots: [{
      id: 'shot', name: 'Shot 1', crater: { manual: { x: C.x, y: C.y } }, observer: {}, clipId: 'clip',
      impact: o.impact === false ? {} : { clip: { manual: around(tr.impactTime + nz.impact, tr.fps) } },
    }],
    sightings,
  };
}
