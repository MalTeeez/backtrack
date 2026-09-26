/**
 * The detection of one section (automation plan sections 5 to 10): stabilization, pitch and roll from vertical lines,
 * the heading from the compass readings, the shell track, the impact from the track, and the minimap. It works on
 * decoded frames (decode.ts) that run from a little before the section to about a second after it, for the impact.
 */
import type { CV } from './cv.ts';
import type { Frame } from './decode.ts';
import { localRunner, stabilize } from './stabilize.ts';
import { poolRunner, type Pool } from './pool.ts';
import { fitPitchRoll, verticalSegments } from './lines.ts';
import { fuseHeading, yawOf } from './heading.ts';
import { linkTrack, shellCandidates } from './shell.ts';
import { impactFromTrack } from './impact.ts';
import { levelScales, matchMinimap, minimapTemplate, mosaic, smoothPath, wideScales, type MapInfo, type MinimapMatch, type Mosaic, type TileLoader } from './minimap.ts';
import { pixel, rotationAngle, type Intrinsics } from './rotation.ts';
import { readCompass } from '../video/compass.ts';
import { profile, resetProfile, timed, timedAsync } from './profile.ts';
import { confRatio, confSigma, detected } from '../solver/field.ts';
import { NEEDED } from '../solver/solve.ts';
import type { Detected, MapId, Section } from '../solver/types.ts';

export interface SectionInput {
  frames: Frame[];
  /** The section (s), the span where the shell flies. */
  a: number; b: number;
  fovDeg: number; fovAxis: 'h' | 'v';
  /** The map of the clip when known, and the sighting position that the minimap search found earlier in this clip. */
  map?: MapId;
  prior?: { map: MapId; x: number; y: number; mpp: number };
  maps: MapId[];
  tiles: TileLoader;
  mapInfo: (id: MapId) => Promise<MapInfo | null>;
  progress?: (step: string) => void;
  /** Whether the shell search uses the GPU when there is one. Defaults to true. */
  gpu?: boolean;
}

/** A shell mark with a lower score than this is too unsure to count (section 2.2, low score). */
const MARK_SCORE = 15;
/** The minimap position is good to about this (game units), as the tiles and the game agree within 5 m (section 10.2). */
const MINIMAP_SIGMA = 0.05;

/** Runs the detection of a section. With a pool, the work per frame runs on all CPU cores. */
export async function detectSection(cv: CV, inp: SectionInput, pool?: Pool): Promise<Omit<Section, 'id' | 'shotId' | 'ranAt'>> {
  const t0 = performance.now(), step = inp.progress ?? (() => {});
  resetProfile();
  const frames = inp.frames;
  if (frames.length < 3) throw new Error('The section has too few frames.');
  const { w: W, h: H } = frames[0].gray;
  const half = (inp.fovAxis === 'v' ? H : W) / 2;
  const K: Intrinsics = { f: half / Math.tan((inp.fovDeg * Math.PI) / 360), cx: W / 2 - 0.5, cy: H / 2 - 0.5 };
  const inSec = (t: number) => t >= inp.a - 1e-3 && t <= inp.b + 1e-3;
  const secIdx = frames.map((_, i) => i).filter((i) => inSec(frames[i].t));
  if (secIdx.length < 2) throw new Error('The section has fewer than two frames.');

  step('Stabilizing');
  // ponytail: the steps run one after the other. Running the compass and the minimap during the stabilization made a
  // warm section slower (4.7 to 5.4 s), because their jobs queue before the chains of the stabilization.
  const st = await stabilize(pool ? poolRunner(pool) : localRunner(cv), frames, K, { section: [secIdx[0], secIdx[secIdx.length - 1]] });
  const R = (i: number) => (st.frames[i].ok ? st.frames[i].R : null);

  step('Pitch and roll');
  const good = secIdx.filter((i) => st.frames[i].ok && st.frames[i].inliers >= 100);
  const pick = good.filter((_, k) => k % Math.max(1, Math.ceil(good.length / 10)) === 0);
  const segs = timed('lines: segments', () => pick.map((i) => ({ segs: verticalSegments(frames[i].gray), R: st.frames[i].R! })));
  const lf = timed('lines: fit', () => fitPitchRoll(K, segs));
  const pitch: Detected<number> = lf ? detected('pitch', lf.pitch, lf.pitchSigma) : { conf: 0, reason: 'no vertical lines' };
  const roll: Detected<number> = lf ? detected('roll', lf.roll, lf.rollSigma) : { conf: 0, reason: 'no vertical lines' };

  step('Heading');
  const withCam = frames.map((_, i) => i).filter((i) => R(i));
  const shown = await timedAsync('heading: compass', () => readCompasses(withCam.map((i) => frames[i].compass), H / 2160, pool));
  const readings = withCam.flatMap((i, k) => (shown[k] ? [{ shown: shown[k]!.heading, yaw: yawOf(lf?.pitch ?? 0, lf?.roll ?? 0, R(i)!) }] : []));
  const hf = fuseHeading(readings);
  const heading: Detected<number> = hf
    ? { value: hf.heading, sigma: hf.sigma, conf: hf.used < hf.readings / 2 ? 0 : confSigma('heading', hf.sigma), ...(hf.used < hf.readings / 2 ? { reason: 'the compass readings disagree' } : {}) }
    : { conf: 0, reason: 'the compass reader was not sure of any frame' };

  step('Shell');
  // every frame with a rotation helps the track. Only its sighting needs a sure camera.
  const sf = secIdx.map((i) => ({ gray: frames[i].gray, R: st.frames[i].R, other: st.frames[i].other }));
  const { cands, valid } = await shellCandidates(cv, sf, K, pool, inp.gpu !== false);
  const tr = timed('shell: link', () => linkTrack(cands, secIdx.map((i) => frames[i].t), valid, sf, K));
  // the whole track leads to the impact. Only a sighting needs a sure camera and a clear mark.
  const track = secIdx.flatMap((i, k) => (tr.marks[k] ? [{ t: frames[i].t, x: tr.marks[k]!.ref.x, y: tr.marks[k]!.ref.y }] : []));
  const marks: Section['marks'] = [];
  const dropped: Section['dropped'] = [];
  secIdx.forEach((i, k) => {
    const m = tr.marks[k], t = frames[i].t;
    if (!R(i)) dropped.push({ t, reason: 'the camera of this frame is not sure' });
    else if (!m) dropped.push({ t, reason: 'no shell found' });
    else if (m.score < MARK_SCORE) dropped.push({ t, reason: 'the shell is faint' });
    else if (m.jump) dropped.push({ t, reason: 'the shell jumps here, so the frame time is probably off' });
    // the vision code puts pixel centers on whole numbers. The app puts them at .5 (pixel i spans i to i + 1).
    else marks.push({ t, x: m.frame.x + 0.5, y: m.frame.y + 0.5, rx: m.ref.x, ry: m.ref.y, score: m.score });
  });

  step('Impact');
  const imp = timed('impact', () => impactFromTrack(frames.map((f, i) => ({ t: f.t, gray: f.gray, R: R(i) })), K, track));
  const impact: Section['impact'] = imp && Number.isFinite(imp.b)
    ? { value: { a: imp.a, b: imp.b }, sigma: (imp.b - imp.a) / 2, conf: imp.conf, at: imp.at }
    : { conf: 0, reason: imp?.reason ?? 'no shell track to follow' };
  // marks at or after the impact are debris, not the shell
  if (impact.value) for (let k = marks.length - 1; k >= 0 && marks[k].t >= impact.value.b - 1e-3; k--) dropped.push({ t: marks.splice(k, 1)[0].t, reason: 'after the impact' });

  step('Minimap');
  const minimap = await timedAsync('minimap', () => minimapSearch(cv, inp, secIdx.map((i) => frames[i]), H / 2160, pool)).catch(() => undefined);
  const impT = impact.value ? (impact.value.a + impact.value.b) / 2 : inp.b;
  const walk = minimap?.at.value && (await timedAsync('minimap: walk', () => walkPath(cv, inp, frames.filter((f) => f.t >= inp.a - 1e-3 && f.t <= impT + 1e-3), H / 2160, minimap, impT, pool)).catch(() => undefined));

  // the notes for the user (section 8.4)
  const notes: string[] = [];

  if (marks.length < NEEDED) notes.push(`${!marks.length ? 'No frame has' : marks.length === 1 ? 'Only 1 frame has' : `Only ${marks.length} frames have`} a shell mark, and the solver needs ${NEEDED}. Mark the shell on more frames.`);
  if (marks.length && impT - marks[marks.length - 1].t > 0.5) notes.push(`The last shell mark is ${(impT - marks[marks.length - 1].t).toFixed(1)} s before the impact. Mark the shell nearer the impact if it shows.`);
  for (let k = 1; k < marks.length; k++) if (marks[k].t - marks[k - 1].t > 0.3) notes.push(`The shell has no marks from ${marks[k - 1].t.toFixed(2)} s to ${marks[k].t.toFixed(2)} s.`);

  const lines = (lf?.lines ?? []).map((l) => {
    const a = pixel(K, l.a), b = pixel(K, l.b);
    return a && b ? ([a.x, a.y, b.x, b.y] as [number, number, number, number]) : null;
  }).filter((x): x is [number, number, number, number] => !!x);

  return {
    a: inp.a, b: inp.b, ms: Math.round(performance.now() - t0), width: W, height: H,
    profile: Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, Math.round(v)])),
    ref: frames[st.ref].t,
    frames: st.frames.map((f) => ({ t: f.t, R: f.R, ok: f.ok, inliers: f.inliers, fitPx: +f.fitPx.toFixed(3) })),
    heading: { auto: heading }, pitch: { auto: pitch }, roll: { auto: roll },
    marks, lines, impact, minimap, ...(walk ? { walk } : {}), dropped: dropped.sort((p, q) => p.t - q.t), notes,
  };
}

/**
 * Finds the map of a clip from its minimap (automation plan section 4). It searches a few frames of one moment on every
 * map. It answers the question when marking starts.
 */
export async function detectMap(cv: CV, inp: Pick<SectionInput, 'frames' | 'maps' | 'tiles' | 'mapInfo'>, pool?: Pool): Promise<Section['minimap']> {
  const fs = inp.frames[0].gray.h / 2160;
  // search the zoom levels only, so a clip without a minimap to match does not keep every core busy with the wide range
  return minimapSearch(cv, { ...inp, a: 0, b: 0, fovDeg: 0, fovAxis: 'h' }, inp.frames, fs, pool, false);
}

/**
 * Measures how well a pure rotation fits the frames at each FOV (deg). It returns the share of frames with a sure
 * rotation, their median fit (px), and how far the camera turned (deg). A wrong focal length does not fit a turning
 * camera.
 */
export async function fovCheck(cv: CV, frames: Frame[], fovs: number[], axis: 'h' | 'v', pool?: Pool) {
  if (frames.length < 3) throw new Error('The section has too few frames.');
  const { w: W, h: H } = frames[0].gray, fits: { fov: number; sure: number; fit: number }[] = [];
  let turnDeg = 0;
  for (const fov of fovs) {
    const half = (axis === 'v' ? H : W) / 2, K = { f: half / Math.tan((fov * Math.PI) / 360), cx: W / 2 - 0.5, cy: H / 2 - 0.5 };
    const st = await stabilize(pool ? poolRunner(pool) : localRunner(cv), frames, K, { section: [0, frames.length - 1] });
    const withR = st.frames.filter((f) => f.R), med = withR.map((f) => f.fitPx).sort((a, b) => a - b)[withR.length >> 1] ?? Infinity;
    fits.push({ fov, sure: st.frames.filter((f) => f.ok).length / st.frames.length, fit: med });
    if (fov === fovs[0]) turnDeg = Math.max(0, ...withR.map((f) => rotationAngle(f.R!)));
  }
  return { fits, turnDeg };
}

/** A user who moved less than this (m) over the section stood still, as the minimap matches wobble by about a meter. */
const WALK_MIN_M = 3;

/**
 * The minimap template of each walk point is the median of the frames within this many seconds around it (up to 5).
 * The median removes what changes from frame to frame, as the template of the whole section does. A walk of 1.5 m/s
 * moves 0.2 m in that time, less than a minimap pixel.
 */
export const WALK_SPAN_S = 0.3;

/**
 * Matches the minimap of up to 16 points of the section on its own (section 10). Each point is a median over `span`
 * seconds, matched at the scale and near the position that the search found. With a pool, each point runs on a worker.
 */
export async function walkMatches(cv: CV, inp: SectionInput, frames: Frame[], fs: number, mm: NonNullable<Section['minimap']>, pool?: Pool, span = WALK_SPAN_S) {
  const info = await inp.mapInfo(mm.map.value!);
  if (!info || frames.length < 4) return null;
  const n = Math.min(16, frames.length), pick = Array.from({ length: n }, (_, k) => frames[Math.round((k * (frames.length - 1)) / (n - 1))]);
  const cropsOf = (t: number) => {
    const near = frames.filter((f) => Math.abs(f.t - t) <= span / 2 + 1e-6), m = Math.min(5, near.length);
    return Array.from({ length: m }, (_, k) => near[Math.round((k * (near.length - 1)) / Math.max(1, m - 1))].minimap);
  };
  // the window spans a whole minimap from the spot, and 50 m to walk
  const { w, h } = pick[0].minimap, at = mm.at.value!;
  const mo = await mosaic(inp.tiles, mm.map.value!, info, 6, { cx: at.x, cy: at.y, r: (Math.max(w, h) * mm.mpp) / fs / 100 + 0.5 });
  const key = `mosaic${mosaics++}`;
  const found = await Promise.all(pick.map((f) => (pool
    ? pool.run<MinimapMatch | null>('walkMatch', { crops: cropsOf(f.t), mo: key, mpps: [mm.mpp], fs }, { [key]: () => mo })
    : Promise.resolve(matchMinimap(cv, minimapTemplate(cropsOf(f.t)), mo, [mm.mpp], fs)))));
  pool?.drop(key);
  return pick.map((f, k) => ({ t: f.t, m: found[k] }));
}

/**
 * The path of a user who walks over the section. It smooths the matches of walkMatches that stand out at least 2
 * times. The path at the impact becomes the sighting position (minimap.at). Returns undefined for a user who stood
 * still.
 */
async function walkPath(cv: CV, inp: SectionInput, frames: Frame[], fs: number, mm: NonNullable<Section['minimap']>, impT: number, pool?: Pool): Promise<Section['walk']> {
  const found = await walkMatches(cv, inp, frames, fs, mm, pool);
  if (!found) return undefined;
  const pts = found.flatMap(({ t, m }) => (m && m.score / Math.max(m.next, 1e-3) >= 2 ? [{ t, x: m.x, y: m.y }] : []));
  const path = smoothPath(pts);
  if (!path) return undefined;
  const first = path(found[0].t), last = path(impT);
  if (Math.hypot(last.x - first.x, last.y - first.y) * 100 < WALK_MIN_M) return undefined;
  mm.at.value = { x: +last.x.toFixed(3), y: +last.y.toFixed(3) };
  return [...found.map((f) => f.t), impT].map((t) => { const p = path(t); return { t, x: +p.x.toFixed(4), y: +p.y.toFixed(4) }; });
}

/** Reads the compass of each frame, in chunks over the pool when there is one. */
async function readCompasses(list: Frame['compass'][], s: number, pool?: Pool) {
  if (!pool) return list.map((g) => readCompass(g, s));
  const n = Math.ceil(list.length / pool.size), chunks: Frame['compass'][][] = [];
  for (let k = 0; k < list.length; k += n) chunks.push(list.slice(k, k + n));
  const out = await Promise.all(chunks.map((c) => pool.run<ReturnType<typeof readCompass>[]>('compass', { list: c.map((g) => ({ g, s })) })));
  return out.flat();
}

/**
 * Finds the map and the sighting position (section 10), with the minimap of up to 5 frames of the section as one
 * template. The search tries an earlier position of the clip first. Otherwise, it searches every map (or the known one)
 * at zoom 4 over the zoom levels, then over a wide range. Then it searches at zoom 6 near the best match.
 */
let mosaics = 0;
async function minimapSearch(cv: CV, inp: SectionInput, frames: Frame[], fs: number, pool?: Pool, wide = true): Promise<Section['minimap']> {
  /** The best match over the scales, spread over the pool. Each worker gets the mosaic once. */
  const matchAll = async (tpl: ReturnType<typeof minimapTemplate>, mo: Mosaic, scales: number[]): Promise<MinimapMatch | null> => {
    if (!pool) return matchMinimap(cv, tpl, mo, scales, fs);
    const key = `mosaic${mosaics++}`, n = Math.min(pool.size, scales.length), parts: number[][] = Array.from({ length: n }, () => []);
    scales.forEach((sc, k) => parts[k % n].push(sc));
    const res = await Promise.all(parts.map((p) => pool.run<MinimapMatch | null>('minimap', { tpl, mo: key, mpps: p, fs }, { [key]: () => mo })));
    pool.drop(key);
    return res.reduce<MinimapMatch | null>((a, b) => (b && (!a || b.score > a.score) ? b : a), null);
  };
  const n = Math.min(5, frames.length);
  const tpl = minimapTemplate(Array.from({ length: n }, (_, k) => frames[Math.round((k * (frames.length - 1)) / Math.max(1, n - 1))].minimap));
  const fine = async (map: MapId, x: number, y: number, mpp: number) => {
    const info = await inp.mapInfo(map);
    if (!info) return null;
    const mo = await mosaic(inp.tiles, map, info, 6, { cx: x, cy: y, r: 3 });
    return matchAll(tpl, mo, Array.from({ length: 21 }, (_, k) => mpp * (0.95 + k * 0.005)));
  };
  const ratio = (m: MinimapMatch) => m.score / Math.max(m.next, 1e-3);
  if (inp.prior && (!inp.map || inp.map === inp.prior.map)) {
    const m = await fine(inp.prior.map, inp.prior.x, inp.prior.y, inp.prior.mpp);
    if (m && ratio(m) >= 3) return result(inp.prior.map, m, inp.map ? 1 : 0.9);
  }
  const maps = inp.map ? [inp.map] : inp.maps;
  const coarse = async (scales: number[]) => {
    const out: { map: MapId; m: MinimapMatch }[] = [];
    for (const map of maps) {
      const info = await inp.mapInfo(map);
      if (!info) continue;
      const m = await matchAll(tpl, await mosaic(inp.tiles, map, info, 4), scales);
      if (m) out.push({ map, m });
    }
    return out.sort((p, q) => ratio(q.m) - ratio(p.m));
  };
  let found = await coarse(levelScales());
  if (wide && (!found.length || ratio(found[0].m) < 3)) found = await coarse(wideScales());
  if (!found.length) return undefined;
  const best = found[0];
  // the map confidence compares how much its peak stands out with how much the peaks of the other maps do
  const mapConf = inp.map ? 1 : found.length > 1 ? confRatio(ratio(best.m) / ratio(found[1].m), 3) : 0.5;
  const m = (await fine(best.map, best.m.x, best.m.y, best.m.mpp)) ?? best.m;
  return result(best.map, m, mapConf);

  function result(map: MapId, m: MinimapMatch, mapConf: number): Section['minimap'] {
    const r = ratio(m), conf = confRatio(r, 3);
    return {
      map: { value: map, conf: Math.min(mapConf, conf), ...(conf < 0.5 ? { reason: 'the minimap does not match the map clearly' } : {}) },
      at: { value: { x: +m.x.toFixed(3), y: +m.y.toFixed(3) }, sigma: MINIMAP_SIGMA, conf, ...(conf < 0.5 ? { reason: `the best match stands out only ${r.toFixed(1)} times` } : {}) },
      mpp: +m.mpp.toFixed(4),
    };
  }
}
