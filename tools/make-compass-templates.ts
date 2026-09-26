/**
 * Makes the digit templates and digit widths of the compass reader (src/lib/video/compass.ts) from a clip whose compass
 * headings a person read by eye (tools/compass-labels.json), and prints how well the reader does on every labeled
 * frame, each judged by templates made without it. It needs ffmpeg to cut the frames (the FFMPEG variable, or ffmpeg
 * on the path); the app itself reads frames in the browser.
 * Run it with `bun tools/make-compass-templates.ts` (DEBUG=1 prints every frame).
 */
import { join } from 'node:path';
import { DIGITS, GRID, LABELS, LETTERS, MIN_CORR, NUDGE, SHIFT, cellFeatures, channels, compassRegion, labelOf, readCompass, type Gray } from '../src/lib/video/compass.ts';
import * as model from '../src/lib/video/compassTemplates.ts';

const ROOT = join(import.meta.dir, '..');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const { clip, labels, seek = [] } = (await Bun.file(join(ROOT, 'tools', 'compass-labels.json')).json()) as {
  clip: string; labels: { t: number; heading: number; unsure: boolean }[]; seek?: { t: number; heading: number; unsure: boolean }[];
};

// the frame size of the clip
const probe = Bun.spawnSync([FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(ROOT, clip)]);
const [W, H] = probe.stdout.toString().trim().split(',').map(Number);
const R = compassRegion(W, H);

// the compass region of 2 frames per second, cut in one pass the way the labels were read (a seek to each time can
// land on a neighboring frame, which shows another heading while the camera turns)
const FPS = 2;
const raw = Bun.spawnSync([FFMPEG, '-v', 'error', '-i', join(ROOT, clip), '-vf', `fps=${FPS},crop=${R.w}:${R.h}:${R.x}:${R.y},format=gray`, '-f', 'rawvideo', '-']).stdout;
const regionAt = (t: number): Gray => {
  const i = Math.round(t * FPS), size = R.w * R.h;
  return { data: new Uint8Array(raw.buffer, raw.byteOffset + i * size, size), w: R.w, h: R.h };
};
// more frames, each cut by a seek to its time (and labeled from a crop cut the same way)
const seekAt = (t: number): Gray => {
  const out = Bun.spawnSync([FFMPEG, '-v', 'error', '-ss', String(t), '-i', join(ROOT, clip), '-frames:v', '1', '-vf', `crop=${R.w}:${R.h}:${R.x}:${R.y},format=gray`, '-f', 'rawvideo', '-']).stdout;
  return { data: new Uint8Array(out), w: R.w, h: R.h };
};
const frames = [...labels.map((l) => ({ ...l, g: regionAt(l.t) })), ...seek.map((l) => ({ ...l, g: seekAt(l.t) }))].map((f) => ({ ...f, e: channels(f.g, R.s) }));

const digitsOf = (h: number) => [Math.floor(h / 100), Math.floor(h / 10) % 10, h % 10];
const n = GRID.cols * GRID.rows * 3; // three channels
const unit = (v: Float32Array) => { const s = Math.hypot(...v) || 1; return Array.from(v, (x) => x / s); };
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * The cells of the known digits of a frame at a shift, with the widths `adv`. With templates, each digit moves within
 * NUDGE to where it fits best, as the reader does.
 */
function cells(f: (typeof frames)[number], adv: number[], dx: number, dy: number, templates: number[][] | null) {
  let x = DIGITS.x + dx;
  return digitsOf(f.heading).map((d) => {
    let best = { feat: cellFeatures(f.e, f.g, R.s, x, dy, adv[d]), x, corr: -2 };
    if (templates) for (let k = -NUDGE; k <= NUDGE; k++) {
      const feat = cellFeatures(f.e, f.g, R.s, x + k, dy, adv[d]), corr = dot(feat, templates[d]);
      if (corr > best.corr) best = { feat, x: x + k, corr };
    }
    x = best.x + adv[d];
    return { d, feat: best.feat };
  });
}

/** Templates from some frames and widths: the mean features of each digit, at the shift that fits them best. */
function train(use: typeof frames, adv: number[]) {
  let templates: number[][] | null = null, score = 0;
  for (let round = 0; round < 4; round++) {
    const sums = Array.from({ length: 10 }, () => new Float32Array(n)), counts = new Array(10).fill(0);
    score = 0;
    for (const f of use) {
      let best = { cs: cells(f, adv, 0, 0, null), score: -Infinity };
      if (templates) {
        for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
          const cs = cells(f, adv, dx, dy, templates), sc = cs.reduce((a, c) => a + dot(c.feat, templates![c.d]), 0);
          if (sc > best.score) best = { cs, score: sc };
        }
        score += best.score;
      }
      for (const c of best.cs) { for (let i = 0; i < n; i++) sums[c.d][i] += c.feat[i]; counts[c.d]++; }
    }
    templates = sums.map((s, d) => (counts[d] ? unit(s) : new Array(n).fill(0)));
  }
  return { templates: templates!, score };
}

/** Templates of the direction letters: the mean features of the letter window of each label, at its best shift. */
function trainLabels(use: typeof frames): number[][] {
  let templates: number[][] | null = null;
  for (let round = 0; round < 3; round++) {
    const sums = LABELS.map(() => new Float32Array(n)), counts = LABELS.map(() => 0);
    for (const f of use) {
      const k = labelOf(f.heading);
      let best = { feat: cellFeatures(f.e, f.g, R.s, LETTERS.x, 0, LETTERS.w), score: -Infinity };
      if (templates) for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
        const feat = cellFeatures(f.e, f.g, R.s, LETTERS.x + dx, dy, LETTERS.w), score = dot(feat, templates[k]);
        if (score > best.score) best = { feat, score };
      }
      for (let i = 0; i < n; i++) sums[k][i] += best.feat[i];
      counts[k]++;
    }
    templates = sums.map((s, k) => (counts[k] ? unit(s) : new Array(n).fill(0)));
  }
  return templates!;
}

// the widths: a narrow 1 and one width for the other digits, whichever fits the sure frames best
const sure = frames.filter((f) => !f.unsure);
let adv: number[] = [], bestScore = -Infinity;
for (let one = 10; one <= 12; one += 1) for (let wide = 17; wide <= 19; wide += 0.5) {
  const a = Array.from({ length: 10 }, (_, d) => (d === 1 ? one : wide));
  const { score } = train(sure, a);
  if (score > bestScore) { bestScore = score; adv = a; }
}
console.log(`digit widths at 2160p: 1 is ${adv[1]} px, the others ${adv[0]} px`);

// how well it reads: every frame against templates made without it, in 5 folds
let right = 0, wrong = 0, none = 0;
const lines: string[] = [];
model.ADVANCE.splice(0, model.ADVANCE.length, ...adv);
const FOLDS = 5;
for (let fold = 0; fold < FOLDS; fold++) {
  // the templates of this fold: all sure frames but the ones it tests
  const rest = sure.filter((x) => frames.indexOf(x) % FOLDS !== fold);
  model.TEMPLATES.splice(0, model.TEMPLATES.length, ...train(rest, adv).templates);
  model.LABEL_TEMPLATES.splice(0, model.LABEL_TEMPLATES.length, ...trainLabels(rest));
  for (const [i, f] of frames.entries()) {
    if (i % FOLDS !== fold) continue;
    const r = readCompass(f.g, R.s);
    if (process.env.DEBUG) {
      const raw = readCompass(f.g, R.s, { corr: -2, margin: -2 });
      console.log(`${f.t.toFixed(2)} is ${f.heading}${f.unsure ? '?' : ''} raw ${raw?.heading} corr ${raw?.corr.toFixed(2)} margin ${raw?.margin.toFixed(2)} ${raw?.heading === f.heading ? '' : 'WRONG'}`);
    }
    if (!r) none++;
    else if (r.heading === f.heading) right++;
    else { wrong++; lines.push(`  ${f.t.toFixed(2)} s: read ${r.heading}, is ${f.heading}${f.unsure ? ' (unsure label)' : ''}, corr ${r.corr.toFixed(2)}, margin ${r.margin.toFixed(2)}`); }
  }
}
console.log(`${frames.length} frames: ${right} right, ${wrong} wrong, ${none} not read`);
// how the lead limit trades readings against mistakes (the confidence limit stays)
for (const margin of [0.03, 0.02, 0.01, 0.005, 0]) {
  let ok = 0, bad = 0;
  for (let fold = 0; fold < FOLDS; fold++) {
    const rest = sure.filter((x) => frames.indexOf(x) % FOLDS !== fold);
    model.TEMPLATES.splice(0, model.TEMPLATES.length, ...train(rest, adv).templates);
    model.LABEL_TEMPLATES.splice(0, model.LABEL_TEMPLATES.length, ...trainLabels(rest));
    for (const [i, f] of frames.entries()) {
      if (i % FOLDS !== fold) continue;
      const r = readCompass(f.g, R.s, { corr: MIN_CORR, margin });
      if (r) { if (r.heading === f.heading) ok++; else { bad++; if (margin === 0) console.log(`  lead 0: read ${r.heading} at ${f.t}, is ${f.heading}${f.unsure ? '?' : ''}, corr ${r.corr.toFixed(2)}, lead ${r.margin.toFixed(3)}`); } }
    }
  }
  console.log(`lead ${margin}: ${ok} right, ${bad} wrong, ${frames.length - ok - bad} not read`);
}
for (const l of lines) console.log(l);

// the templates of all sure frames, for the app
const { templates } = train(sure, adv);
const body = templates.map((t) => `  [${t.map((v) => v.toFixed(4)).join(', ')}],`).join('\n');
const labelBody = trainLabels(sure).map((t) => `  [${t.map((v) => v.toFixed(4)).join(', ')}],`).join('\n');
await Bun.write(join(ROOT, 'src', 'lib', 'video', 'compassTemplates.ts'), `/**
 * The digit templates of the compass reader (compass.ts). They hold the mean features of each digit 0 to 9 (edges,
 * dark ring and white fill, each on a ${GRID.cols} x ${GRID.rows} grid) and the width of each digit in 2160p pixels. tools/make-compass-templates.ts writes this file from ${sure.length} frames of ${clip}.
 */
export const ADVANCE: number[] = [${adv.join(', ')}];

export const TEMPLATES: number[][] = [
${body}
];

/** The direction letters after the number, one template per label: ${LABELS.join(', ')}. */
export const LABEL_TEMPLATES: number[][] = [
${labelBody}
];
`);
console.log('wrote src/lib/video/compassTemplates.ts');
