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
import { pixel, type Intrinsics } from './rotation.ts';
import { readCompass } from '../video/compass.ts';
import { profile, resetProfile, timed, timedAsync } from './profile.ts';
import { confRatio, confSigma, detected } from '../solver/field.ts';
import { NEEDED } from '../solver/solve.ts';
import type { Detected, MapId, Section } from '../solver/types.ts';

export interface SectionInput {
  frames: Frame[];
  /** The section (s): where the shell flies. */
  a: number; b: number;
  fovDeg: number; fovAxis: 'h' | 'v';
  /** The map of the clip when known, and where the minimap search found the user before in this clip. */
  map?: MapId;
  prior?: { map: MapId; x: number; y: number; mpp: number };
  maps: MapId[];
  tiles: TileLoader;
  mapInfo: (id: MapId) => Promise<MapInfo | null>;
  progress?: (step: string) => void;
  /** Use the GPU for the shell when there is one (default). */
  gpu?: boolean;
}

/** A shell mark with a lower score than this is too unsure to count (section 2.2: low score). */
const MARK_SCORE = 15;
/** The minimap position is good to about this (game units): the tiles and the game agree within 5 m (section 10.2). */
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
  // every frame with a rotation helps the track; only its sighting needs a sure camera
  const sf = secIdx.map((i) => ({ gray: frames[i].gray, R: st.frames[i].R, other: st.frames[i].other }));
  const { cands, valid } = await shellCandidates(cv, sf, K, pool, inp.gpu !== false);
  const tr = timed('shell: link', () => linkTrack(cands, secIdx.map((i) => frames[i].t), valid, sf, K));
  // the whole track leads to the impact; only a sighting needs a sure camera and a clear mark
  const track = secIdx.flatMap((i, k) => (tr.marks[k] ? [{ t: frames[i].t, x: tr.marks[k]!.ref.x, y: tr.marks[k]!.ref.y }] : []));
  const marks: Section['marks'] = [];
  const dropped: Section['dropped'] = [];
  secIdx.forEach((i, k) => {
    const m = tr.marks[k], t = frames[i].t;
    if (!R(i)) dropped.push({ t, reason: 'the camera of this frame is not sure' });
    else if (!m) dropped.push({ t, reason: 'no shell found' });
    else if (m.score < MARK_SCORE) dropped.push({ t, reason: 'the shell is faint' });
    else if (m.jump) dropped.push({ t, reason: 'the shell jumps here: the frame time is probably off' });
    // the vision code puts pixel centers on whole numbers; the app puts them at .5 (pixel i spans i to i + 1)
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

  // what the user should know (section 8.4)
  const notes: string[] = [];

  if (marks.length < NEEDED) notes.push(`Only ${marks.length} frame(s) have a shell mark. Mark the shell on more frames.`);
  if (marks.length && impT - marks[marks.length - 1].t > 0.5) notes.push(`The last shell mark is ${(impT - marks[marks.length - 1].t).toFixed(1)} s before the impact. Mark the shell nearer the impact if it shows.`);
  for (let k = 1; k < marks.length; k++) if (marks[k].t - marks[k - 1].t > 0.3) notes.push(`No shell marks from ${marks[k - 1].t.toFixed(2)} s to ${marks[k].t.toFixed(2)} s.`);

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
 * The map of a clip from its minimap (automation plan section 4): a few frames of one moment, searched on every map.
 * For the question when marking starts.
 */
export async function detectMap(cv: CV, inp: Pick<SectionInput, 'frames' | 'maps' | 'tiles' | 'mapInfo'>, pool?: Pool): Promise<Section['minimap']> {
  const fs = inp.frames[0].gray.h / 2160;
  // the zoom levels only: a clip without a minimap to match must not keep every core busy with the wide range
  return minimapSearch(cv, { ...inp, a: 0, b: 0, fovDeg: 0, fovAxis: 'h' }, inp.frames, fs, pool, false);
}

/** A user who moved less than this (m) over the section stood still: the minimap matches wobble by about a meter. */
const WALK_MIN_M = 3;

/**
 * Where the user was over the section, for a user who walks (section 10): the minimap of each of up to 16 frames on
 * its own, at the scale the search found, near where it found the user. The path at the impact becomes where the user
 * stood (minimap.at). Undefined for a user who stood still.
 */
async function walkPath(cv: CV, inp: SectionInput, frames: Frame[], fs: number, mm: NonNullable<Section['minimap']>, impT: number, pool?: Pool): Promise<Section['walk']> {
  const info = await inp.mapInfo(mm.map.value!);
  if (!info || frames.length < 4) return undefined;
  const n = Math.min(16, frames.length), pick = Array.from({ length: n }, (_, k) => frames[Math.round((k * (frames.length - 1)) / (n - 1))]);
  const tpls = pick.map((f) => minimapTemplate([f.minimap]));
  // the window: a whole minimap from the spot, and 50 m to walk
  const { w, h } = pick[0].minimap, at = mm.at.value!;
  const mo = await mosaic(inp.tiles, mm.map.value!, info, 6, { cx: at.x, cy: at.y, r: (Math.max(w, h) * mm.mpp) / fs / 100 + 0.5 });
  const key = `mosaic${mosaics++}`;
  const found = await Promise.all(tpls.map((tpl) => (pool ? pool.run<MinimapMatch | null>('minimap', { tpl, mo: key, mpps: [mm.mpp], fs }, { [key]: () => mo }) : Promise.resolve(matchMinimap(cv, tpl, mo, [mm.mpp], fs)))));
  pool?.drop(key);
  const pts = pick.flatMap((f, k) => { const m = found[k]; return m && m.score / Math.max(m.next, 1e-3) >= 2 ? [{ t: f.t, x: m.x, y: m.y }] : []; });
  const path = smoothPath(pts);
  if (!path) return undefined;
  const first = path(pick[0].t), last = path(impT);
  if (Math.hypot(last.x - first.x, last.y - first.y) * 100 < WALK_MIN_M) return undefined;
  mm.at.value = { x: +last.x.toFixed(3), y: +last.y.toFixed(3) };
  return [...pick.map((f) => f.t), impT].map((t) => { const p = path(t); return { t, x: +p.x.toFixed(4), y: +p.y.toFixed(4) }; });
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
 * The map and where the user stood (section 10): the minimap of up to 5 frames of the section as one template. Near an
 * earlier position of the clip first; else every map (or the known one) at zoom 4 over the zoom levels, then over a wide
 * range; then zoom 6 near the best.
 */
let mosaics = 0;
async function minimapSearch(cv: CV, inp: SectionInput, frames: Frame[], fs: number, pool?: Pool, wide = true): Promise<Section['minimap']> {
  /** The best match over the scales: spread over the pool, each worker getting the mosaic once. */
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
  // the map: how much its peak stands out against how much the peaks of the other maps do
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
