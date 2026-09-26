/**
 * The motion of the shell between the marked frames of a clip. Its angular speed as seen by the camera changes
 * smoothly (it grows as the shell comes closer), so a step that is much faster or slower than the others means that
 * the times of those frames are off. A recording that dropped or repeated frames shows the shell where it was earlier
 * or later than the frame time says.
 */
import { focalPx } from './camera.ts';
import { SightingSolver } from './sightings.ts';
import type { Id, ProjectData, Sighting } from './types.ts';

/** A step between two sightings that does not fit the motion of the other steps. */
export interface MotionFlag {
  shotId: Id; from: Id; to: Id; t0: number; t1: number;
  /** The speed of this step relative to the speed the other steps give at its time. Above 1 is too fast, below 1 too slow. */
  ratio: number;
}

/** How far a step may be off the trend (as a factor) before it counts. */
const RATIO = 2.2;
/** How many steps on each side give the trend at a step. */
const WINDOW = 3;
/**
 * The longest step (s) the check judges. Over a longer step the speed of the shell can change a lot on its own (it
 * doubles within a second near the impact, and a mortar slows down and speeds up around the top of its arc), so only
 * runs of close frames tell a wrong frame time from real motion.
 */
const MAX_STEP_S = 0.3;
const R2D = 180 / Math.PI;

/** The median of a list of numbers. */
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const stepText = (f: MotionFlag) =>
  `from ${f.t0.toFixed(3)} s to ${f.t1.toFixed(3)} s ${f.ratio > 1 ? `${f.ratio.toFixed(1)} times as fast` : `only ${Math.round(f.ratio * 100)} percent as fast`}`;

/**
 * The warning for the sighting at the end of a step that does not fit. Its frame shows the jump, and the frame before
 * it still looks right.
 */
export function motionWarning(step: MotionFlag): string {
  return `The shell moves ${stepText(step)} as the other frames suggest. The video probably skipped or repeated frames there, so the frame times are off. Try leaving this sighting out.`;
}

/** The warning of a shot with such steps, in the form of the other warnings of a shot. */
export function motionShotWarning(name: string, steps: MotionFlag[]): string {
  const list = steps.map((f) => `${f.t0.toFixed(3)} s to ${f.t1.toFixed(3)} s`).join(', ');
  return `${name} has ${steps.length === 1 ? 'a jump' : `${steps.length} jumps`} in the motion of the shell (${list}). The video probably skipped frames there.`;
}

interface Step { shotId: Id; p: Sighting; q: Sighting; dt: number; deg: number; mid: number; speed: number }

/**
 * The steps of the shell between consecutive sightings of each shot in each clip. A step holds how far the shell moved
 * as seen by the camera (deg), and its angular speed (deg/s). The steps come grouped by shot and clip, in time order.
 */
function runs(data: ProjectData, solver: SightingSolver): Step[][] {
  const out: Step[][] = [];
  for (const shot of data.shots) {
    if (shot.excluded) continue;
    const byClip = new Map<Id, Sighting[]>();
    for (const s of data.sightings) if (s.shotId === shot.id && !s.excluded) byClip.set(s.clipId, [...(byClip.get(s.clipId) ?? []), s]);
    for (const list of byClip.values()) {
      const pts = list
        .sort((a, b) => a.timeS - b.timeS)
        .map((s) => ({ s, a: solver.aim(s) }))
        .flatMap(({ s, a }) => (a.ok ? [{ s, D: a.D }] : []));
      out.push(pts.slice(1).map((q, i) => {
        const p = pts[i], dt = q.s.timeS - p.s.timeS;
        const cos = p.D[0] * q.D[0] + p.D[1] * q.D[1] + p.D[2] * q.D[2];
        const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * R2D;
        return { shotId: shot.id, p: p.s, q: q.s, dt, deg, mid: (p.s.timeS + q.s.timeS) / 2, speed: deg / dt };
      }).filter((x) => x.dt > 0 && x.speed > 0));
    }
  }
  return out;
}

/** The angular speed of the shell (deg/s) on its way to each sighting, from the sighting before it in the clip. */
export function shellSpeeds(data: ProjectData, solver = new SightingSolver(data)): Map<Id, number> {
  return new Map(runs(data, solver).flat().map((x) => [x.q.id, x.speed]));
}

/** Every step of every shot and clip that does not fit the motion of the shell. */
export function motionFlags(data: ProjectData, solver = new SightingSolver(data)): MotionFlag[] {
  const out: MotionFlag[] = [];
  const st = data.settings;
  for (const steps of runs(data, solver)) {
    // three steps are the least that give a trend to compare with
    if (steps.length < 3) continue;
    // The trend at each step fits log speed over time from its neighbors (up to 3 on each side, without the step
    // itself). The fit is a line through the medians of their pairwise slopes (Theil-Sen), which one bad neighbor
    // hardly moves. Neighbors follow the curve of the speed, which grows slowly while the shell is far and fast near
    // the impact.
    // A broken step would bend the trend of its neighbors and get them flagged too, so the trends leave out the steps
    // flagged so far, until the flags settle.
    let bad = new Set<number>();
    const expectedAt = (j: number) => {
      const near = steps.filter((x, i) => i !== j && !bad.has(i) && Math.abs(i - j) <= WINDOW && x.dt <= MAX_STEP_S);
      if (near.length < 2) return null;
      const slopes: number[] = [];
      for (let i = 0; i < near.length; i++) for (let k = i + 1; k < near.length; k++) {
        if (near[k].mid !== near[i].mid) slopes.push((Math.log(near[k].speed) - Math.log(near[i].speed)) / (near[k].mid - near[i].mid));
      }
      const b = slopes.length ? median(slopes) : 0, a = median(near.map((x) => Math.log(x.speed) - b * x.mid));
      // At the ends of a run the line extrapolates, and a noisy slope sends it far off. Thus the trend stays within the
      // speeds of the neighbors.
      const speeds = near.map((x) => x.speed);
      return Math.min(Math.max(...speeds), Math.max(Math.min(...speeds), Math.exp(a + b * steps[j].mid)));
    };
    const flag = () => {
      const found = new Map<number, MotionFlag>();
      for (const [j, x] of steps.entries()) {
        if (x.dt > MAX_STEP_S) continue;
        const expected = expectedAt(j);
        if (expected == null) continue;
        const ratio = x.speed / expected;
        // The marks and the typed headings are not exact. Thus a step only counts when it is off by more than they allow.
        const degPerPx = R2D / (focalPx(x.q.frameW, x.q.frameH, st.fovDeg, st.fovAxis) * (x.q.zoom ?? 1));
        // The step and the neighbors that predict it both carry that error, so the slack is 5 of them.
        // With the camera of one stabilized section, only the marks err from frame to frame. Else the headings err too.
        const shared = !!x.q.heading.auto?.group && x.q.heading.manual == null && x.q.heading.auto.group === x.p.heading.auto?.group;
        const slack = shared ? 5 * st.markSigmaPx * degPerPx * Math.SQRT2 : 5 * st.compassSigmaDeg * Math.SQRT2;
        if ((ratio > RATIO || ratio < 1 / RATIO) && Math.abs(x.deg - expected * x.dt) > slack) {
          found.set(j, { shotId: x.shotId, from: x.p.id, to: x.q.id, t0: x.p.timeS, t1: x.q.timeS, ratio });
        }
      }
      return found;
    };
    let found = flag();
    for (let round = 0; round < 5; round++) {
      const keys = [...found.keys()];
      if (keys.length === bad.size && keys.every((j) => bad.has(j))) break;
      bad = new Set(keys);
      found = flag();
    }
    out.push(...found.values());
  }
  return out;
}
