/**
 * The accuracy benchmark (plan section 9) makes 20 random runs per scene, error type and sighting count.
 * `bun run bench` prints the tables and writes them to docs/benchmark.md.
 */
import { randn, seeded } from '../../src/lib/solver/montecarlo.ts';
import { solveProject } from '../../src/lib/solver/result.ts';
import { type Noise, type Options, sceneProject } from './project.ts';
import { makeScene, type SceneOptions, type SceneWeapon } from './scene.ts';

const RUNS = 20;
const COUNTS = [2, 5, 15, 40];
const rng = seeded(5);
const n = (sigma: number) => () => randn(rng) * sigma;

const CASES: { label: string; o: Omit<Options, 'n'> | (() => Omit<Options, 'n'>); scene?: SceneOptions }[] = [
  { label: 'Shell marks +/-1 px', o: { noise: { shellPx: n(1) } } },
  { label: 'Shell and edge marks +/-1 px', o: { noise: { shellPx: n(1), edgePx: n(1) } } },
  { label: 'Shell and edge marks +/-1 px, impact +/-0.5 frame', o: () => ({ noise: { shellPx: n(1), edgePx: n(1), impact: n(0.5 / 60)() } }) },
  { label: 'Compass +/-0.5 deg per sighting', o: { noise: { heading: n(0.5) } } },
  { label: 'Compass +/-0.5 deg, same error for all', o: () => { const e = n(0.5)(); return { noise: { heading: () => e } satisfies Noise }; } },
  // a detected section: the last 2 s before the impact, with the frame time errors of the capture test (entire
  // screen at 4K about 10 ms, a window capture about 30 ms)
  { label: 'Last 2 s, marks +/-1 px, frame times +/-10 ms', o: { last: 2, noise: { shellPx: n(1), time: n(0.01) } } },
  { label: 'Last 2 s, marks +/-1 px, frame times +/-30 ms', o: { last: 2, noise: { shellPx: n(1), time: n(0.03) } } },
  // a user who walks at 1.5 m/s during the last 3 s: without and with the path of the minimap
  { label: 'Last 3 s, walking 1.5 m/s, path not known', o: { last: 3, noise: { shellPx: n(1) } }, scene: { walk: [1.06, 1.06] } },
  { label: 'Last 3 s, walking 1.5 m/s, path +/-1 m', o: { last: 3, noise: { shellPx: n(1) }, walk: n(1) }, scene: { walk: [1.06, 1.06] } },
];

const SCENES: { title: string; weapon: SceneWeapon; text: string }[] = [
  { title: 'L52', weapon: 'L52', text: 'The gun is 2000 m from the crater and fires at 300 m/s with drag (low arc). The observer stands 40 m from the crater, and the solver finds where.' },
  { title: 'L81', weapon: 'L81', text: 'The mortar is 400 m from the crater and fires at 96.6 m/s with drag (high arc). The observer stands 30 m from the crater, and the solver finds where.' },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

const sections: string[] = [];
for (const sc of SCENES) {
  const trs = new Map<SceneOptions | undefined, ReturnType<typeof makeScene>>();
  const sceneOf = (o?: SceneOptions) => { if (!trs.has(o)) trs.set(o, makeScene({ weapon: sc.weapon, ...o })); return trs.get(o)!; };
  console.log(`\n${sc.title}`);
  const rows: string[] = [];
  for (const c of CASES) {
    const cells: string[] = [];
    for (const count of COUNTS) {
      const errs: number[] = [];
      for (let k = 0; k < RUNS; k++) {
        const o = typeof c.o === 'function' ? c.o() : c.o;
        const tr = sceneOf(c.scene), p = sceneProject(tr, { ...o, n: count });
        const r = solveProject(p, rng, 0).shots[0];
        errs.push(r.gun ? Math.hypot(r.gun.x - tr.G[0], r.gun.y - tr.G[1]) : Infinity);
      }
      const fail = errs.filter((e) => !Number.isFinite(e)).length;
      const ok = errs.filter(Number.isFinite);
      cells.push(ok.length ? `${pct(ok, 0.5).toFixed(0)} / ${pct(ok, 0.9).toFixed(0)}${fail ? ` (${fail} failed)` : ''}` : `all ${fail} failed`);
    }
    rows.push(`| ${c.label} | ${cells.join(' | ')} |`);
    console.log(rows.at(-1));
  }
  sections.push(`## ${sc.title}

${sc.text}

| Errors | ${COUNTS.map((c) => `${c} sightings`).join(' | ')} |
|---|${COUNTS.map(() => '---').join('|')}|
${rows.join('\n')}`);
}

const md = `# Accuracy benchmark

\`bun run bench\` (tests/synthetic/benchmark.ts) generates this file. The camera has a 90 deg FOV, 1280x720 pixels and
60 fps. Each cell summarizes ${RUNS} runs with random errors. It shows the **median / 90th percentile** gun error in
meters, over the runs that gave a result.

${sections.join('\n\n')}
`;
await Bun.write(new URL('../../docs/benchmark.md', import.meta.url), md);
console.log('\nThe benchmark wrote docs/benchmark.md.');
