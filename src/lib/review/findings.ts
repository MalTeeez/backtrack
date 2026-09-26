/**
 * The findings of a shot in its clip, for the sign-off list of the Review phase (docs/review-plan.md, stage 4). They
 * list what the detection and the solver found, each with its time, its confidence and a key of its value. A finding
 * is done when the user gave the value, or signed it off while it had the same key. A new detection that changes the
 * value opens it again. Deterministic, no I/O.
 */
import { MAPS } from '../map/tiles.svelte.ts';
import { impactTime, sigmaOf, value } from '../solver/field.ts';
import type { ShotResult } from '../solver/result.ts';
import type { ClipData, Field, Id, ProjectData, Section, Shot } from '../solver/types.ts';

export type FindingType = 'map' | 'section' | 'camera' | 'shell' | 'dropped' | 'impact' | 'position' | 'height' | 'crater' | 'timing';

export interface Finding {
  id: string;
  type: FindingType;
  /** The time in the clip (s), or null for the whole clip. */
  t: number | null;
  /** One line on the value, and the numbers behind it. */
  value: string;
  details: [string, string][];
  /** 0 to 1. */
  conf: number;
  /** The value as it was signed off. A finding whose key changed is open again. */
  key: string;
  /** True when the user gave the value. Then the finding is done without a sign-off. */
  manual: boolean;
  /** Only information, which never blocks the result. */
  info?: boolean;
  /** Where the user fixes the value, as the page for manual entry and the time to show. */
  fix: { phase: 'mark' | 'coordinates'; t?: number };
}

/** The names and the order of the types. */
export const TYPES: Record<FindingType, string> = {
  map: 'Map', section: 'Section', camera: 'Camera', shell: 'Shell position', dropped: 'Frames left out', impact: 'Impact',
  position: 'Sighting position', height: 'Height above ground', crater: 'Crater', timing: 'Frame times',
};

const f2 = (v: number) => v.toFixed(2), f3 = (v: number) => v.toFixed(3);
const confOf = (f: Field<unknown> | undefined) => (f?.manual != null ? 1 : f?.auto?.conf ?? 0);

export function findings(p: ProjectData, clipId: Id, shot: Shot, r?: ShotResult | null): Finding[] {
  const out: Finding[] = [], clip: ClipData | undefined = p.clips[clipId];
  const sec: Section | undefined = clip?.sections?.find((s) => s.shotId === shot.id);

  const map = clip?.map, mapId = value(map);
  if (mapId) out.push({ id: 'map', type: 'map', t: null, value: MAPS[mapId] ?? mapId, details: [['From', map?.manual != null ? 'your pick' : 'the minimap search']], conf: confOf(map), key: mapId, manual: map?.manual != null, fix: { phase: 'mark' } });

  if (sec) {
    out.push({ id: 'section', type: 'section', t: sec.a, value: `${f2(sec.a)} to ${f2(sec.b)} s`, details: [['Ran', `${(sec.ms / 1000).toFixed(1)} s`]], conf: 1, key: `${sec.a}:${sec.b}`, manual: true, fix: { phase: 'mark', t: sec.a } });
    const h = value(sec.heading), pt = value(sec.pitch), rl = value(sec.roll) ?? 0;
    if (h != null && pt != null) {
      const ok = sec.frames.filter((f) => f.ok).length;
      out.push({
        id: 'camera', type: 'camera', t: sec.ref, value: `${h.toFixed(1)} deg, pitch ${f2(pt)} deg, roll ${f2(rl)} deg`,
        details: [['Heading', `${f2(h)} deg +/-${(sigmaOf(sec.heading) ?? 0).toFixed(2)}`], ['Pitch, roll', `${f2(pt)} deg +/-${(sigmaOf(sec.pitch) ?? 0).toFixed(2)}, ${f2(rl)} deg`], ['Frames', `${ok} of ${sec.frames.length} with a sure rotation`], ['Pitch lines', String(sec.lines.length)]],
        conf: Math.min(confOf(sec.heading), confOf(sec.pitch), sec.roll.manual != null || sec.roll.auto ? confOf(sec.roll) : 1),
        key: `${h}:${pt}:${rl}`, manual: sec.heading.manual != null && sec.pitch.manual != null, fix: { phase: 'mark', t: sec.ref },
      });
    }
    // the frames left out, as runs of the same reason
    const runs: { a: number; b: number; reason: string }[] = [];
    for (const d of sec.dropped) {
      const last = runs.at(-1), i = sec.frames.findIndex((f) => f.t === d.t);
      if (last && last.reason === d.reason && sec.frames[i - 1]?.t === last.b) last.b = d.t;
      else runs.push({ a: d.t, b: d.t, reason: d.reason });
    }
    for (const run of runs) {
      out.push({ id: `dropped:${f3(run.a)}`, type: 'dropped', t: run.a, value: `${run.a === run.b ? `${f2(run.a)} s` : `${f2(run.a)} to ${f2(run.b)} s`}, ${run.reason}`, details: [], conf: 0.5, key: `${run.a}:${run.b}:${run.reason}`, manual: false, fix: { phase: 'mark', t: run.a } });
    }
  }

  const own = p.sightings.filter((s) => s.shotId === shot.id && s.clipId === clipId && value(s.shell)).sort((a, b) => a.timeS - b.timeS);
  own.forEach((s, k) => {
    const v = value(s.shell)!, m = sec?.marks.find((x) => Math.abs(x.t - s.timeS) < 1e-3);
    out.push({
      id: `shell:${s.id}`, type: 'shell', t: s.timeS, value: `${k + 1} of ${own.length}${m ? `, score ${m.score.toFixed(0)}` : ''}`,
      details: [['Mark', `${v.x.toFixed(1)}, ${v.y.toFixed(1)} px`], ['Error', `+/-${(sigmaOf(s.shell) ?? 0).toFixed(1)} px`]],
      conf: confOf(s.shell), key: `${v.x}:${v.y}`, manual: s.shell.manual != null, fix: { phase: 'mark', t: s.timeS },
    });
  });

  const imp = shot.impact[clipId], iv = value(imp);
  if (imp && (iv || imp.auto)) {
    out.push({
      id: 'impact', type: 'impact', t: iv ? iv.a : null, value: iv ? `${f3(iv.a)} to ${f3(iv.b)} s` : `not found, ${imp.auto?.reason ?? 'mark it'}`,
      details: iv ? [['Impact time', `${f3(impactTime(iv))} s`]] : [], conf: confOf(imp), key: iv ? `${iv.a}:${iv.b}` : 'none', manual: imp.manual != null, fix: { phase: 'mark', t: iv?.b },
    });
  }

  const obs = shot.observer[clipId], ov = value(obs);
  if (obs && (ov || obs.auto)) {
    const walk = sec?.walk, walked = walk ? Math.hypot(walk.at(-1)!.x - walk[0].x, walk.at(-1)!.y - walk[0].y) * 100 : 0;
    out.push({
      id: 'position', type: 'position', t: null, value: ov ? `X ${f2(ov.x)}, Y ${f2(ov.y)}, ${walk ? `walked ${walked.toFixed(0)} m` : 'no walk'}` : 'not found',
      details: [['From', obs.manual != null ? 'your entry' : 'the minimap'], ...(r?.observerOffM != null ? [['Sightings against the minimap', `${r.observerOffM.toFixed(0)} m`] as [string, string]] : [])],
      conf: confOf(obs), key: ov ? `${ov.x}:${ov.y}` : 'none', manual: obs.manual != null, fix: { phase: 'coordinates' },
    });
  }

  const raised = shot.raisedM?.[clipId]?.manual;
  out.push({
    id: 'height', type: 'height', t: null, value: raised != null ? `+${raised.toFixed(1)} m, entered` : '0 m, the terrain data only',
    details: [['Why it matters', 'the terrain data has no walls, vehicles or built blocks']], conf: raised != null ? 1 : 0.4, key: String(raised ?? 0), manual: raised != null, fix: { phase: 'coordinates' },
  });

  const cv = value(shot.crater);
  if (cv) out.push({ id: 'crater', type: 'crater', t: null, value: `X ${f2(cv.x)}, Y ${f2(cv.y)}`, details: [['From', shot.crater.manual != null ? 'your entry' : 'the detection']], conf: confOf(shot.crater), key: `${cv.x}:${cv.y}`, manual: shot.crater.manual != null || !!shot.rangefinder, fix: { phase: 'coordinates' } });
  else if (r?.crater) out.push({ id: 'crater', type: 'crater', t: null, value: `X ${f2(r.crater.x)}, Y ${f2(r.crater.y)}, solved to +/-${r.crater.sigmaM.toFixed(0)} m`, details: [['From', 'the sighting position and the end of the flight']], conf: Math.max(0, Math.min(1, 1 - r.crater.sigmaM / 25)), key: `${r.crater.x.toFixed(1)}:${r.crater.y.toFixed(1)}`, manual: false, fix: { phase: 'coordinates' } });

  if (r?.timing) out.push({ id: 'timing', type: 'timing', t: null, value: `+/-${(r.timing.s * 1000).toFixed(0)} ms, ${r.timing.measured ? 'from the marks' : 'the default'}`, details: [], conf: r.timing.measured ? 0.8 : 0.6, key: r.timing.s.toFixed(3), manual: false, info: true, fix: { phase: 'mark' } });

  return out;
}

/** Whether a finding is done, because the user gave the value or signed off this value. */
export const isDone = (f: Finding, shot: Shot) => f.manual || shot.signoff?.[f.id] === f.key;
