/**
 * A worker of the vision pool (src/lib/vision/pool.ts). It runs one task at a time with its own OpenCV. Arguments that
 * are strings name shared data that an earlier message put here.
 */
import { loadCv } from '../vision/cv.ts';
import { features, relative } from '../vision/stabilize.ts';
import { bandCandidates, type BandJob } from '../vision/shell.ts';
import { matchMinimap, minimapTemplate, type Mosaic, type Template } from '../vision/minimap.ts';
import { readCompass } from '../video/compass.ts';
import { profile, resetProfile } from '../vision/profile.ts';
import type { Feats } from '../vision/stabilize.ts';
import type { Gray8 } from '../vision/image.ts';
import type { Intrinsics } from '../vision/rotation.ts';

const store = new Map<string, unknown>();

type Args = Record<string, unknown>;
const tasks: Record<string, (cv: unknown, a: Args) => unknown> = {
  features: (cv, a) => features(cv, a.g as Gray8),
  relative: (cv, a) => relative(cv, a.fj as Feats, a.fi as Feats, a.gj as Gray8, a.gi as Gray8, a.Kh as Intrinsics, a.f as number, a.seed as number),
  shellBand: (cv, a) => bandCandidates(cv, a.job as BandJob),
  minimap: (cv, a) => matchMinimap(cv, a.tpl as Template, a.mo as Mosaic, a.mpps as number[], a.fs as number),
  walkMatch: (cv, a) => matchMinimap(cv, minimapTemplate(a.crops as Parameters<typeof minimapTemplate>[0]), a.mo as Mosaic, a.mpps as number[], a.fs as number),
  warm: () => null,
  compass: (_cv, a) => (a.list as { g: Gray8; s: number }[]).map(({ g, s }) => readCompass(g, s)),
};

self.onmessage = async ({ data: m }: MessageEvent<{ id: number; task: string; args: Args; put: Args }>) => {
  for (const [k, v] of Object.entries(m.put)) store.set(k, v);
  if (m.task === 'drop') { for (const k of m.args.keys as string[]) store.delete(k); return; }
  try {
    const { cv } = await loadCv();
    const args = Object.fromEntries(Object.entries(m.args).map(([k, v]) => [k, typeof v === 'string' && store.has(v) ? store.get(v) : v]));
    resetProfile();
    const result = tasks[m.task](cv, args);
    postMessage({ id: m.id, result, profile: { ...profile } });
  } catch (e) {
    let msg = String((e as Error)?.message ?? e);
    if (typeof e === 'number') msg = (await loadCv()).cv.exceptionFromPtr(e).msg;
    postMessage({ id: m.id, error: msg });
  }
};
