/** Searches the direction and elevation of one shot and finds the gun position (plan sections 6.6 to 6.8). */
import { fitBallistic } from './ballisticFit.ts';
import { D2R } from './camera.ts';
import type { Ray, ShotSolution, SolveOptions, Vec3 } from './types.ts';

/** The fewest sightings a shot needs: each gives two angles, for the direction, elevation and observer shift. */
export const NEEDED = 2;

export function solveShot(rays: Ray[], C: Vec3, opt: SolveOptions): ShotSolution {
  if (rays.length < NEEDED) return { error: `This shot has ${rays.length} sightings with an impact time and needs ${NEEDED} or more.` };
  const full = opt.center == null;
  const lo = full ? 0 : opt.center! - opt.tol, hi = full ? 360 : opt.center! + opt.tol;
  const search = (strict: boolean, ground: boolean) =>
    fitBallistic(opt.ballistics, rays, { C, zGun: opt.zGun, lo, hi, range: strict ? [opt.rmin, opt.rmax] : null, ground: ground ? opt.ground : undefined, near: opt.near });

  // first with the range limit and the terrain, then without the range limit, and last without the terrain
  let rangeApplied = opt.useRange, fit = search(rangeApplied, true);
  if (!fit && rangeApplied) { rangeApplied = false; fit = search(false, true); }
  if (!fit && opt.ground) {
    rangeApplied = opt.useRange;
    fit = search(rangeApplied, false) ?? (rangeApplied ? search((rangeApplied = false), false) : null);
    if (fit) fit.ignoresTerrain = true;
  }
  if (!fit) return { error: 'No direction agrees with the sightings. Check the headings, the suspected heading and the crater.' };
  const th = fit.th * D2R;
  const gun = { range: fit.R, x: C[0] + fit.R * Math.sin(th), y: C[1] + fit.R * Math.cos(th), launchEl: fit.e, tof: fit.T };
  return { fit, gun, rangeApplied, rangeRequested: opt.useRange, n: rays.length };
}
