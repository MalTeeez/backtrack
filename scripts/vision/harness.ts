/**
 * Runs the detection of a section on a clip of test-data/, in the page, and leaves the result in window.__result.
 * Query: clip (file name in test-data), a, b (seconds to decode), sec (a,b of the section inside them), fov, v (verbose).
 */
import { decodeFrames, type Frame } from '../../src/lib/vision/decode.ts';
import { loadCv } from '../../src/lib/vision/cv.ts';
import { detectMap, detectSection, walkMatches } from '../../src/lib/vision/pipeline.ts';
import { Pool, poolRunner } from '../../src/lib/vision/pool.ts';
import { localRunner, stabilize } from '../../src/lib/vision/stabilize.ts';
import { rotationAngle } from '../../src/lib/vision/rotation.ts';
import { lastCandidates } from '../../src/lib/vision/shell.ts';
import { applySection } from '../../src/lib/state/sections.ts';
import { solveProject } from '../../src/lib/solver/result.ts';
import { seeded } from '../../src/lib/solver/montecarlo.ts';
import type { ProjectData, Section } from '../../src/lib/solver/types.ts';
import { matchMinimap, minimapTemplate, mosaic, type MapInfo, type TileLoader } from '../../src/lib/vision/minimap.ts';
import type { MapId } from '../../src/lib/solver/types.ts';

/** Map tiles from the dev server, as gray. */
const loadTile: TileLoader = async (map, z, x, y) => {
  const r = await fetch(`/local-data/maps/${map}/zoom_${z}/${x}_${y}.webp`);
  if (!r.ok || !r.headers.get('content-type')?.includes('webp')) return null;
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data, out = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return { data: out, w: bmp.width, h: bmp.height };
};
const mapInfo = async (id: MapId): Promise<MapInfo> => (await fetch(`/local-data/maps/${id}/map.json`)).json();
const MAPS: MapId[] = ['bakurani', 'ozeti', 'zestafona'];

const q = new URLSearchParams(location.search);
const log = (s: string) => { document.getElementById('log')!.textContent += s + '\n'; console.log(s); };
const w = window as unknown as { __result?: unknown; __error?: string; __images?: Record<string, string> };
w.__images = {};
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

(async () => {
  const blob = await (await fetch(`/test-data/${q.get('clip')}`)).blob();
  const a = Number(q.get('a')), b = Number(q.get('b'));
  let t = performance.now();
  const frames: Frame[] = [];
  for await (const f of decodeFrames(blob, a, b)) frames.push(f);
  log(`decoded ${frames.length} frames ${frames[0]?.gray.w}x${frames[0]?.gray.h} (${frames[0]?.format}) in ${ms(t)}`);
  { const g = frames[Math.floor(frames.length / 2)].gray; let s = 0; for (let i = 0; i < g.data.length; i += 997) s += g.data[i]; log(`gray checksum ${s} at ${frames[Math.floor(frames.length / 2)].t.toFixed(3)}`); }
  if (q.get('task') === 'gray') {
    // the gray of one frame with three luma weightings, from a canvas: to find how the browser turned YUV into RGB
    const v = document.createElement('video');
    void v;
    w.__result = {};
    return;
  }
  const { cv } = await loadCv();
  const { w: W, h: H } = frames[0].gray;
  const K = { f: W / 2 / Math.tan((Number(q.get('fov') ?? 100) * Math.PI) / 360), cx: W / 2 - 0.5, cy: H / 2 - 0.5 };
  const sec = q.get('sec')?.split(',').map(Number);
  const section: [number, number] = sec ? [frames.findIndex((x) => x.t >= sec[0] - 0.01), frames.findLastIndex((x) => x.t <= sec[1] + 0.01)] : [0, frames.length - 1];

  if (q.get('task') === 'timing') {
    // the content timing error (capture-test-plan.md section 4): during an even turn, the turn angle of each frame
    // against a smooth local fit of its neighbors (+/-4 frames, without itself), over the local turn speed
    const { cv: cvT } = await loadCv();
    const Wt = frames[0].gray.w, Ht = frames[0].gray.h;
    const Kt = { f: Wt / 2 / Math.tan((Number(q.get('fov') ?? 100) * Math.PI) / 360), cx: Wt / 2 - 0.5, cy: Ht / 2 - 0.5 };
    const mid = Math.floor(frames.length / 2);
    const stT = await stabilize(new Pool() ? poolRunner(new Pool()) : localRunner(cvT), frames, Kt, { section: [mid, mid] });
    const ok = stT.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.R);
    // the signed turn angle: about the mean axis of all rotations
    const axis = [0, 0, 0];
    for (const { f } of ok) { const R = f.R!; axis[0] += R[7] - R[5]; axis[1] += R[2] - R[6]; axis[2] += R[3] - R[1]; }
    const an = Math.hypot(...axis);
    const ang = ok.map(({ f }) => { const R = f.R!, v = [R[7] - R[5], R[1 + 1] - R[6], R[3] - R[1]]; return (Math.sign(v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]) || 1) * rotationAngle(R); });
    const ts = ok.map(({ f }) => f.t), dts: number[] = [];
    for (let k = 4; k < ok.length - 4; k++) {
      const nb = [-4, -3, -2, -1, 1, 2, 3, 4].map((d) => k + d), t0 = ts[k];
      // least squares y = a + b (t - t0) + c (t - t0)^2 over the neighbors
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
      for (const j of nb) { const u = ts[j] - t0, row = [1, u, u * u]; for (let r = 0; r < 3; r++) { y[r] += row[r] * ang[j]; for (let c = 0; c < 3; c++) A[r][c] += row[r] * row[c]; } }
      const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(A), sol = [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, cc) => (cc === c ? y[r] : v)))) / D);
      const speed = sol[1];
      if (Math.abs(speed) < 2) continue; // deg/s: a turn too slow to tell the time
      dts.push((ang[k] - sol[0]) / speed);
    }
    const s2 = [...dts].sort((x, y) => x - y), med = s2[s2.length >> 1], mad = [...dts.map((x) => Math.abs(x - med))].sort((x, y) => x - y)[dts.length >> 1];
    const rms = Math.sqrt(dts.reduce((x, v) => x + v * v, 0) / dts.length);
    log(`timing: ${dts.length} frames of the turn, error rms ${(1000 * rms).toFixed(1)} ms, robust sigma ${(1000 * 1.4826 * mad).toFixed(1)} ms, largest ${(1000 * Math.max(...dts.map(Math.abs))).toFixed(0)} ms, ${ok.length} of ${frames.length} frames stabilized, axis ${an.toFixed(3)}`);
    w.__result = { frames: stT.frames.map((f) => ({ t: f.t, R: f.R, ok: f.ok })) };
    return;
  }
  if (q.get('task') === 'crops') {
    // the minimap of one frame per second, side by side
    let last = -1;
    for (const f of frames) {
      if (Math.floor(f.t) === last) continue;
      last = Math.floor(f.t);
      const m = f.minimap, c = document.createElement('canvas');
      c.width = m.w; c.height = m.h;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(m.data), m.w, m.h), 0, 0);
      w.__images![`mm_${f.t.toFixed(2)}`] = c.toDataURL('image/png');
    }
    w.__result = {};
    return;
  }
  if (q.get('task') === 'walk') {
    // the minimap of each walk point, for templates over several spans (s): how much each match stands out, and how
    // far each lies from the median of the points
    const pool = new Pool(), inp = { frames, a, b, fovDeg: 100, fovAxis: 'h' as const, map: (q.get('map') as MapId) || undefined, maps: MAPS, tiles: loadTile, mapInfo };
    const mm = await detectMap(cv, inp, pool);
    if (!mm?.at.value) { log('walk: no minimap'); w.__result = {}; return; }
    log(`walk: minimap ${mm.map.value} at ${mm.at.value.x.toFixed(2)},${mm.at.value.y.toFixed(2)} ${mm.mpp} m/px, ratio conf ${mm.at.conf.toFixed(2)}`);
    for (const span of (q.get('spans') ?? '0,0.1,0.3,0.5').split(',').map(Number)) {
      const t0 = performance.now(), found = (await walkMatches(cv, inp, frames, H / 2160, mm, pool, span))!;
      const ok = found.filter((f) => f.m), med = (xs: number[]) => [...xs].sort((u, v) => u - v)[xs.length >> 1];
      const mx = med(ok.map((f) => f.m!.x)), my = med(ok.map((f) => f.m!.y));
      const ratios = found.map((f) => (f.m ? f.m.score / Math.max(f.m.next, 1e-3) : 0));
      log(`span ${span}: ${ms(t0)}, ratio min ${Math.min(...ratios).toFixed(2)} median ${med(ratios).toFixed(2)}, ${ratios.filter((r) => r >= 2).length}/${found.length} kept, offsets (m) ${ok.map((f) => (Math.hypot(f.m!.x - mx, f.m!.y - my) * 100).toFixed(1)).join(' ')}`);
    }
    w.__result = {};
    return;
  }
  if (q.get('task') === 'minimap') {
    // the map and the position from a few frames: every map at zoom 4 over a range of scales, then zoom 6 near the best
    const idx = Array.from({ length: Math.min(5, frames.length) }, (_, k) => Math.round((k * (frames.length - 1)) / Math.max(1, Math.min(5, frames.length) - 1)));
    const tpl = minimapTemplate(idx.map((i) => frames[i].minimap));
    const fs = H / 2160;
    const fineArg = q.get('fine')?.split(',');
    if (fineArg) {
      // a wide scale search at zoom 6 near a known position: fine=map,x,y,lo,hi
      const [map, x, y, lo, hi, z = 6, r = 5] = [fineArg[0] as MapId, ...fineArg.slice(1).map(Number)] as [MapId, number, number, number, number, number?, number?];
      const mo = await mosaic(loadTile, map, await mapInfo(map), z, { cx: x, cy: y, r });
      const sc: number[] = [];
      for (let v = lo; v <= hi; v *= 1.01) sc.push(v);
      const m = matchMinimap(cv, tpl, mo, sc, H / 2160);
      log(`fine ${map} zoom ${z} ${frames[0].t.toFixed(2)}-${frames.at(-1)!.t.toFixed(2)}: ${m ? `score ${m.score.toFixed(3)} next ${m.next.toFixed(3)} at ${m.x.toFixed(2)},${m.y.toFixed(2)} ${m.mpp.toFixed(3)} m/px` : 'none'}`);
      w.__result = {};
      return;
    }
    const scales = Array.from({ length: 60 }, (_, k) => 0.3 * 1.037 ** k).filter((m) => m <= 2.6);
    t = performance.now();
    const found: { map: MapId; m: NonNullable<ReturnType<typeof matchMinimap>> }[] = [];
    for (const map of (q.get('maps')?.split(',') as MapId[] | undefined) ?? MAPS) {
      const info = await mapInfo(map);
      const mo = await mosaic(loadTile, map, info, Number(q.get('zc') ?? 4));
      const m = matchMinimap(cv, tpl, mo, scales, fs);
      if (m) found.push({ map, m });
      log(`${map} zoom ${q.get('zc') ?? 4} ${mo.g.w}x${mo.g.h}: ${m ? `score ${m.score.toFixed(3)} next ${m.next.toFixed(3)} at ${m.x.toFixed(2)},${m.y.toFixed(2)} ${m.mpp.toFixed(3)} m/px` : 'none'} (${ms(t)})`);
    }
    const best = found.sort((u, v) => v.m.score - u.m.score)[0];
    if (best) {
      t = performance.now();
      const info = await mapInfo(best.map);
      const mo = await mosaic(loadTile, best.map, info, 6, { cx: best.m.x, cy: best.m.y, r: 4 });
      const fine = Array.from({ length: 41 }, (_, k) => best.m.mpp * (0.9 + k * 0.005));
      const m = matchMinimap(cv, tpl, mo, fine, fs);
      log(`fine ${best.map} zoom 6: ${m ? `score ${m.score.toFixed(3)} next ${m.next.toFixed(3)} at ${m.x.toFixed(2)},${m.y.toFixed(2)} ${m.mpp.toFixed(3)} m/px` : 'none'} (${ms(t)})`);
    }
    w.__result = {};
    return;
  }

  // the whole detection of the section, as the app runs it; repeat=n runs it n times on one pool, as the app keeps
  // its pool: the first run pays for starting the workers
  const pool = q.get('pool') === '0' ? undefined : new Pool(Number(q.get('workers')) || undefined);
  let r!: Awaited<ReturnType<typeof detectSection>>;
  for (let run = 0; run < Number(q.get('repeat') ?? 1); run++) {
    t = performance.now();
    r = await detectSection(cv, {
      frames, a: sec?.[0] ?? a, b: sec?.[1] ?? b, fovDeg: Number(q.get('fov') ?? 100), fovAxis: 'h',
      map: (q.get('map') as MapId) || undefined, maps: MAPS, tiles: loadTile, mapInfo, gpu: q.get('gpu') !== '0', progress: (x) => log(`- ${x} (${ms(t)})`),
    }, pool);
    log(`section in ${ms(t)} (${r.ms} ms), ref ${r.ref.toFixed(3)}`);
    log(`profile ${Object.entries(r.profile ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (q.get('v')) for (const f of r.frames) log(`  ${f.t.toFixed(3)} ${f.ok ? 'ok ' : 'BAD'} inl ${f.inliers} fit ${f.fitPx}`);
  const fmt = (d: { value?: unknown; sigma?: number; conf: number; reason?: string }, k = 2) =>
    `${typeof d.value === 'number' ? d.value.toFixed(k) : JSON.stringify(d.value)} +/-${d.sigma?.toFixed(k)} conf ${(100 * d.conf).toFixed(0)}%${d.reason ? ` (${d.reason})` : ''}`;
  log(`pitch ${fmt(r.pitch.auto!)}, roll ${fmt(r.roll.auto!)}, heading ${fmt(r.heading.auto!)}`);
  log(`impact ${fmt(r.impact, 3)}`);
  if (r.minimap) log(`minimap ${r.minimap.map.value} ${(100 * r.minimap.map.conf).toFixed(0)}%, at ${fmt(r.minimap.at)}, ${r.minimap.mpp} m/px`);
  if (r.walk) log(`walk ${r.walk.map((p) => `${p.t.toFixed(2)} ${p.x.toFixed(3)},${p.y.toFixed(3)}`).join('; ')}`);
  log(`marks ${r.marks.length}, dropped ${r.dropped.map((d) => `${d.t.toFixed(3)} ${d.reason}`).join('; ')}`);
  for (const n of r.notes) log(`note: ${n}`);
  if (q.get('v')) for (const m of r.marks) log(`  mark ${m.t.toFixed(3)} ${m.x.toFixed(1)},${m.y.toFixed(1)} ref ${m.rx.toFixed(1)},${m.ry.toFixed(1)} score ${m.score.toFixed(1)}`);
  // against the user's marks of the annotation file
  const ann = await fetch(`/test-data/${q.get('clip')!.replace(/[.]webm$/, '.backtrack.json')}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const user = (ann?.sightings ?? []).filter((x: { shell: { manual?: unknown } }) => x.shell?.manual) as { timeS: number; shell: { manual: { x: number; y: number } } }[];
  const d = r.marks.flatMap((m) => {
    const u = user.find((x) => Math.abs(x.timeS - m.t) < 0.004);
    return u ? [Math.hypot(m.x - u.shell.manual.x, m.y - u.shell.manual.y)] : [];
  });
  if (q.get('probe')) {
    // candidates near a point of the reference camera in every frame of the section: probe=x,y,r
    const [px, py, pr] = q.get('probe')!.split(',').map(Number);
    const secT = frames.filter((x) => x.t >= (sec?.[0] ?? a) - 0.01 && x.t <= (sec?.[1] ?? b) + 0.01).map((x) => x.t);
    for (const [k, t0] of secT.entries()) {
      const near = lastCandidates.list.filter((c) => c.i === k && Math.hypot(c.x - px, c.y - py) < pr).sort((u, v) => v.score - u.score);
      log(`  probe ${t0.toFixed(3)}: ${near.slice(0, 5).map((c) => `${c.x},${c.y} ${c.score.toFixed(1)}`).join('; ')}`);
    }
  }
  if (d.length) log(`against the user: ${d.length} frames, mean ${(d.reduce((x, y) => x + y, 0) / d.length).toFixed(1)} px, max ${Math.max(...d).toFixed(1)} px, ${d.filter((x) => x <= 5).length} within 5 px`);
  // the solver on the detection, with the crater, the impact and the FOV of the annotation file
  if (ann) {
    const shot = ann.shots.find((x: { impact: { manual?: { b: number } } }) => x.impact?.manual && x.impact.manual.b >= (sec?.[1] ?? b) - 0.01) ?? ann.shots[0];
    const p: ProjectData = {
      settings: { fovDeg: ann.settings.fovDeg, fovAxis: 'h', weapon: 'L52', rangeMinM: 600, rangeMaxM: 2600, limitToRange: true, bufferS: 40, bitrateMbps: 25, markSigmaPx: 1, compassSigmaDeg: 0.5 },
      clips: {}, sightings: [],
      shots: [{ id: 's', name: shot.name, crater: shot.crater, impact: {}, observer: {}, clipId: 'c' }],
    };
    let n = 0;
    // pitch=<deg>: the user's pitch for the section, as the section panel takes it
    if (q.get('pitch')) r.pitch.manual = Number(q.get('pitch'));
    applySection(p, 'c', { ...(r as Omit<Section, 'id' | 'shotId' | 'ranAt'>), id: 'sec', shotId: 's', ranAt: 0 }, { uid: () => `x${n++}` });
    // the user's impact when the detection has none
    if (!r.impact.value) p.shots[0].impact.c = { manual: shot.impact.manual };
    const res = solveProject(p, seeded(1), 20).shots[0];
    log(`solve with ${p.sightings.length} sightings: ${res.fit ? `direction ${res.fit.th.toFixed(1)} deg, fit ${res.fit.rms.toFixed(2)} deg, gun ${(res.gun!.x / 100).toFixed(2)},${(res.gun!.y / 100).toFixed(2)}, observer ${res.observers.map((o) => `${(o[0] / 100).toFixed(2)},${(o[1] / 100).toFixed(2)}`).join(' ')}, err90 ${res.err90?.toFixed(0)} m` : res.error}`);
    for (const nn of res.notes) log(`  solver note: ${nn}`);
  }
  w.__result = r;
})().catch(async (e) => {
  // OpenCV throws C++ exceptions as numbers
  if (typeof e === 'number') { const { cv } = await loadCv(); e = new Error(cv.exceptionFromPtr(e).msg); }
  w.__error = String(e?.stack ?? e); log(w.__error);
});
