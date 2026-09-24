/**
 * Solves an annotation file as the app does, and prints each shot: direction, gun, fit error, where the user stood and
 * the notes. For the clips in test-data/ (automation plan sections 9, 12 and 13).
 * usage: bun scripts/solve-clip.ts <file.backtrack.json> [runs]
 */
import { readFileSync } from 'node:fs';
import { applyAnnotation, type Annotation } from '../src/lib/capture/annotation.ts';
import { solveProject } from '../src/lib/solver/result.ts';
import { seeded } from '../src/lib/solver/montecarlo.ts';
import type { ProjectData, Shot } from '../src/lib/solver/types.ts';
import { DEFAULT_SETTINGS } from '../tests/synthetic/project.ts';

const a: Annotation = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const p: ProjectData = { settings: { ...DEFAULT_SETTINGS }, clips: {}, shots: [], sightings: [] };
let n = 0;
const make = { uid: () => `id${n++}`, shot: (k: number): Shot => ({ id: `shot${k}`, name: `Shot ${k}`, crater: {}, impact: {}, observer: {} }) };
for (const note of applyAnnotation(p, 'clip', a, make, { width: a.clip.width, height: a.clip.height })) console.log(note);
const r = solveProject(p, seeded(1), Number(process.argv[3] ?? 40));
const g = (m: number) => (m / 100).toFixed(2);
console.log(`weapon ${r.weapon.use} (${Object.entries(r.weapon.rms).map(([w, e]) => `${w} ${e?.toFixed(2)} deg`).join(', ')})`);
for (const s of r.shots) {
  if (!s.fit) { console.log(s.name, s.error ?? 'no fit'); continue; }
  const obs = s.observers.map((o) => `${g(o[0])}, ${g(o[1])}`).join('; ');
  console.log(`${s.name}: direction ${s.fit.th.toFixed(1)} deg, gun ${g(s.gun!.x)}, ${g(s.gun!.y)}, range ${s.gun!.range.toFixed(0)} m, fit ${s.fit.rms.toFixed(2)} deg, err90 ${s.err90?.toFixed(0)} m, observer ${obs}${s.crater ? `, crater ${s.crater.x.toFixed(2)}, ${s.crater.y.toFixed(2)} +/-${s.crater.sigmaM.toFixed(0)} m` : ''}`);
  for (const note of s.notes) console.log(`  - ${note}`);
}
