/** Draws the marks of a sighting on a canvas, and finds the mark under the pointer. */
import { edgeReport, focalPx } from '../../lib/solver/camera.ts';
import { fieldState, value, type FieldState } from '../../lib/solver/field.ts';
import type { Aim, SightingResult } from '../../lib/solver/sightings.ts';
import type { Pt, Settings, Sighting } from '../../lib/solver/types.ts';

export const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * A compass rose of radius r around a map point, north up: a tick every 10 deg, a number every 30 deg, and the
 * suspected heading with its tolerance as an arc when there is one.
 */
export function compassRose(g: CanvasRenderingContext2D, x: number, y: number, r: number, suspect?: { deg: number; tol: number }) {
  const dir = (a: number): [number, number] => [Math.sin((a * Math.PI) / 180), -Math.cos((a * Math.PI) / 180)];
  g.save();
  g.lineCap = 'butt'; g.setLineDash([]);
  if (suspect) {
    const a = ((suspect.deg - 90) * Math.PI) / 180, t = (suspect.tol * Math.PI) / 180;
    g.strokeStyle = css('--accent'); g.lineWidth = 8; g.globalAlpha = 0.7;
    g.beginPath(); g.arc(x, y, r - 4, a - t, a + t); g.stroke();
    g.globalAlpha = 1;
  }
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke();
  g.font = `600 10px 'Commit Mono', ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  for (let a = 0; a < 360; a += 10) {
    const [dx, dy] = dir(a), len = a % 90 ? (a % 30 ? 4 : 7) : 10;
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x + dx * r, y + dy * r); g.lineTo(x + dx * (r - len), y + dy * (r - len)); g.stroke();
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.2; g.stroke();
    if (a % 30) continue;
    const t = a % 90 ? String(a) : 'NESW'[a / 90], tx = x + dx * (r + 11), ty = y + dy * (r + 11);
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(t, tx, ty);
    g.fillStyle = '#ffffff'; g.fillText(t, tx, ty);
  }
  g.restore();
}

/**
 * Marks over the video ignore the page theme. They use bright colors that show on game footage. The shell mark has a
 * color per state of its field (automation plan section 2.3): the user's, automatic, or the user's where it differs
 * from a confident automatic one. An automatic mark too unsure to count shows dashed.
 */
const MARK = { shell: '#e1b06e', edge: '#6a9fcc', grab: '#ffffff' };
export const SHELL_COLORS: Record<FieldState, string> = { manual: MARK.shell, auto: '#5fd4c4', required: '#5fd4c4', warned: '#ff6b6b' };

/** A mark the user can drag: the shell, or one end of an edge. */
export type Handle = { kind: 'shell' } | { kind: 'edge'; i: number; j: 0 | 1 };

const same = (a: Handle | null, b: Handle) =>
  !!a && a.kind === b.kind && (a.kind === 'shell' || (b.kind === 'edge' && a.i === b.i && a.j === b.j));

/** The mark nearest to p within `tol` video pixels, or null. */
export function hitMark(s: Sighting | undefined, p: Pt, tol: number): Handle | null {
  if (!s) return null;
  let best: Handle | null = null, bd = tol;
  const test = (q: Pt, h: Handle) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bd) { bd = d; best = h; }
  };
  s.edges.forEach(([a, b], i) => { test(a, { kind: 'edge', i, j: 0 }); test(b, { kind: 'edge', i, j: 1 }); });
  const shell = value(s.shell);
  if (shell) test(shell, { kind: 'shell' });
  return best;
}

/** `T` maps video pixels to canvas pixels. `active` is the mark under the pointer or in a drag. */
export function drawMarks(g: CanvasRenderingContext2D, s: Sighting | undefined, pending: Pt | null, T: (p: Pt) => Pt, lw: number, active: Handle | null = null) {
  g.lineWidth = lw;
  if (s) {
    s.edges.forEach(([a0, b0], i) => {
      const a = T(a0), b = T(b0);
      g.strokeStyle = MARK.edge;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      [a, b].forEach((p, j) => {
        g.strokeStyle = same(active, { kind: 'edge', i, j: j as 0 | 1 }) ? MARK.grab : MARK.edge;
        g.beginPath(); g.arc(p.x, p.y, 3 * lw, 0, 7); g.stroke();
      });
    });
    const state = fieldState('shell', s.shell);
    const shell = value(s.shell) ?? s.shell.auto?.value;
    if (shell) {
      const p = T(shell), r = 8 * lw;
      g.strokeStyle = same(active, { kind: 'shell' }) ? MARK.grab : SHELL_COLORS[state];
      g.setLineDash(state === 'required' ? [3 * lw, 3 * lw] : []);
      g.beginPath(); g.arc(p.x, p.y, r, 0, 7);
      // a crosshair with a gap, so the shell itself stays visible
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.moveTo(p.x + dx * 1.2 * r, p.y + dy * 1.2 * r);
        g.lineTo(p.x + dx * 2.2 * r, p.y + dy * 2.2 * r);
      }
      g.stroke();
      g.setLineDash([]);
    }
  }
  if (pending) {
    const p = T(pending);
    g.fillStyle = MARK.edge;
    g.beginPath(); g.arc(p.x, p.y, 4 * lw, 0, 7); g.fill();
  }
}

/**
 * A label next to a mark. Collapsed, it shows its title with one key value and a count of warnings. Hovered, it shows
 * every line and each warning. `at` is the video pixel it starts from.
 */
export interface Note {
  kind: 'edge' | 'shell'; target: MarkTarget; at: Pt; title: string; short: string; lines: string[]; warn: string[];
  /** A label of another shot: shown, but without a remove button. */
  fixed?: boolean;
  /** Where a copied mark comes from: a short line for the collapsed label, a long one for the open label. */
  from?: { short: string; long: string };
  /** Its mark is out of view (the video is zoomed): no label, and an empty box. */
  hidden?: boolean;
}

/** The mark a label belongs to, for its remove button: the shell, edge i, or the edge in progress. */
export type MarkTarget = { kind: 'shell' } | { kind: 'edge'; i: number } | { kind: 'pending' };

/** Solver errors about what the Coordinates phase asks for: the crater. */
export const forLater = (error: string) => error.includes('has no X');

const fmtPt = (p: Pt) => `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;

/**
 * The labels of a sighting: each edge with its ends and the pitch it gives, the edge in progress, and the shell with
 * its azimuth and elevation once the camera is known. `aim` and `r` are the aim and the solve of the sighting.
 */
export function markNotes(
  s: Sighting | undefined, pending: Pt | null, size: { w: number; h: number }, st: Settings, aim: Aim | null, r: SightingResult | null,
  /** The angular speed of the shell (deg/s) since the sighting before this one, if there is one. */
  speed?: number,
): Note[] {
  const out: Note[] = [];
  const noCamera = s && !s.sameCameraAsPrevious
    ? [...(s.edges.length || value(s.pitch) != null ? [] : ['No vertical edge yet.']), ...(value(s.heading) == null ? ['No compass heading yet.'] : [])]
    : [];
  const W = s?.frameW ?? size.w, H = s?.frameH ?? size.h;
  if (!W || !H) return out;
  const f = focalPx(W, H, st.fovDeg, st.fovAxis) * (s?.zoom ?? 1);
  const rep = edgeReport(s?.edges ?? [], W, H, f, st.markSigmaPx);
  const edges = (s?.edges ?? []).map(([a, b], i) => ({ a, b, ...rep.edges[i] }));
  edges.forEach((e, i) => {
    const warn: string[] = !value(s?.shell) && i === 0 ? [...noCamera] : [];
    if (e.pitch == null) warn.push('Gives no pitch. Mark it again.');
    else if (e.offBy != null) warn.push(`${Math.abs(e.offBy).toFixed(1)} deg off the other edges, left out. Is it vertical?`);
    out.push({
      kind: 'edge',
      target: { kind: 'edge', i },
      at: e.a.y < e.b.y ? e.a : e.b,
      title: `Edge ${i + 1}`,
      short: e.pitch == null ? 'no pitch' : `pitch ${e.pitch.toFixed(2)} deg`,
      lines: [`${fmtPt(e.a)} to ${fmtPt(e.b)}`, e.pitch == null ? 'No pitch' : `Pitch ${e.pitch.toFixed(2)} +/-${e.sigma.toFixed(2)} deg`],
      warn,
    });
  });
  if (pending) out.push({ kind: 'edge', target: { kind: 'pending' }, at: pending, title: `Edge ${edges.length + 1}`, short: 'click the other end', lines: [fmtPt(pending), 'Click the other end.'], warn: [] });
  const shell = value(s?.shell);
  if (s && shell) {
    const state = fieldState('shell', s.shell);
    const auto = s.shell.auto;
    out.push({
      kind: 'shell',
      target: { kind: 'shell' },
      at: shell,
      title: state === 'auto' ? `Shell (auto ${Math.round(auto!.conf * 100)}%)` : 'Shell',
      short: [aim?.ok ? `el ${aim.el.toFixed(2)} deg` : fmtPt(shell), ...(speed != null ? [`${speed.toFixed(2)} deg/s`] : [])].join(', '),
      lines: [
        fmtPt(shell),
        ...(state !== 'auto' && auto?.value ? [`Automatic mark ${fmtPt(auto.value)}`] : []),
        ...(aim?.ok ? [`Azimuth ${aim.az.toFixed(2)} deg, elevation ${aim.el.toFixed(2)} deg`] : []),
        ...(speed != null ? [`Moves ${speed.toFixed(2)} deg/s since the sighting before`] : []),
      ],
      // the crater comes in Coordinates, so its absence is no problem while marking
      warn: [
        ...(noCamera.length ? noCamera : r && !r.ok && !forLater(r.error) ? [r.error] : []),
        ...(state === 'warned' ? ['Differs from the automatic mark.'] : []),
      ],
    });
  }
  return out;
}

/** Label backgrounds: dark tints of the mark colors, so the white and orange text stays readable. */
const NOTE_BG = { edge: 'rgba(20, 46, 72, 0.9)', shell: 'rgba(72, 46, 12, 0.9)' };
const WARN = '#ffc56b';

/** A drawn label, in canvas pixels. A hovered label also has its remove button. */
export interface NoteBox { x: number; y: number; w: number; h: number; remove?: { x: number; y: number; w: number; h: number } }

/**
 * Draws labels to the upper right of their points, or to the left near the right side, and returns their boxes. The
 * hovered label opens up and goes on top, and the labels near it fade, so they do not hide it. `k` is canvas px per
 * CSS px.
 */
export function drawNotes(g: CanvasRenderingContext2D, notes: Note[], k: number, hovered: number | null): NoteBox[] {
  const fs = 11 * k, lh = 14 * k, pad = 4 * k, gap = 12 * k, near = 24 * k;
  g.font = `${fs}px 'Commit Mono', ui-monospace, monospace`;
  g.textBaseline = 'top';
  const rows = notes.map((n, i) => i === hovered
    ? [{ t: n.title, c: '#ffffff' }, ...n.lines.map((t) => ({ t, c: '#c9d3dd' })), ...(n.from ? [{ t: n.from.long, c: '#9fb0c0' }] : []), ...n.warn.map((t) => ({ t, c: WARN }))]
    : [{ t: n.title, c: '#ffffff' }, { t: n.short, c: '#c9d3dd' }, ...(n.from ? [{ t: n.from.short, c: '#9fb0c0' }] : []), ...(n.warn.length ? [{ t: `! ${n.warn.length} warning${n.warn.length > 1 ? 's' : ''}`, c: WARN }] : [])]);
  const widest = (rs: { t: string }[]) => Math.max(...rs.map((r) => g.measureText(r.t).width)) + 2 * pad;
  const close = lh; // the remove button of the hovered label, in its top right corner
  const W = g.canvas.width, H = g.canvas.height;

  // each label goes to the first spot next to its mark that no label placed before covers (with its collapsed size,
  // so opening it on hover does not move it): to the right, below and above, then to the left, then further down on
  // either side. Without a free spot, it takes the one that overlaps least.
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const overlap = (a: { x: number; y: number; w: number; h: number }) => placed.reduce((sum, b) =>
    sum + Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + pad) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + pad), 0);
  const spots = notes.map((n, i) => {
    if (n.hidden) return { x: 0, y: 0, cost: 0 };
    const small = i === hovered ? [{ t: n.title }, { t: n.short }, ...(n.from ? [{ t: n.from.short }] : []), ...(n.warn.length ? [{ t: '! 1 warning' }] : [])] : rows[i];
    const w = widest(small), h = small.length * lh + 2 * pad, { x: px, y: py } = n.at;
    const tries: [number, number][] = [
      [px + gap, py - gap - h / 2], [px + gap, py + gap], [px + gap, py - gap - h],
      [px - gap - w, py - gap - h / 2], [px - gap - w, py + gap], [px - gap - w, py - gap - h],
      ...[1, 2, 3, 4].flatMap((k): [number, number][] => [[px + gap, py + gap + k * (h + pad)], [px - gap - w, py + gap + k * (h + pad)], [px + gap, py - gap - h - k * (h + pad)]]),
    ];
    let best = { x: 0, y: 0, cost: Infinity };
    for (const [tx, ty] of tries) {
      const x = Math.max(0, Math.min(W - w, tx)), y = Math.max(0, Math.min(H - h, ty)), cost = overlap({ x, y, w, h });
      if (cost < best.cost) best = { x, y, cost };
      if (cost === 0) break;
    }
    placed.push({ x: best.x, y: best.y, w, h });
    return best;
  });

  const boxes: NoteBox[] = notes.map((n, i) => {
    if (n.hidden) return { x: 0, y: 0, w: 0, h: 0 };
    const removable = i === hovered && !n.fixed;
    const w = widest(rows[i]) + (removable ? close + pad : 0), h = rows[i].length * lh + 2 * pad;
    // an open label grows from its spot, and moves back in only when it would leave the frame
    const x = Math.max(0, Math.min(W - w, spots[i].x)), y = Math.max(0, Math.min(H - h, spots[i].y));
    return { x, y, w, h, remove: removable ? { x: x + w - close - pad / 2, y: y + pad / 2, w: close, h: close } : undefined };
  });
  const hb = hovered != null ? boxes[hovered] : null;
  const crowds = (b: NoteBox) => !!hb && b.x < hb.x + hb.w + near && b.x + b.w > hb.x - near && b.y < hb.y + hb.h + near && b.y + b.h > hb.y - near;
  const order = notes.map((_, i) => i).filter((i) => i !== hovered);
  if (hovered != null && boxes[hovered]) order.push(hovered);
  for (const i of order) {
    const b = boxes[i];
    if (notes[i].hidden) continue;
    g.globalAlpha = i !== hovered && crowds(b) ? 0.12 : 1;
    // a label that had to move away from its mark gets a thin line back to it
    const { x: px, y: py } = notes[i].at, cx = Math.max(b.x, Math.min(b.x + b.w, px)), cy = Math.max(b.y, Math.min(b.y + b.h, py));
    if (Math.hypot(cx - px, cy - py) > 2.5 * gap) {
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1 * k;
      g.beginPath(); g.moveTo(px, py); g.lineTo(cx, cy); g.stroke();
    }
    g.fillStyle = NOTE_BG[notes[i].kind];
    g.fillRect(b.x, b.y, b.w, b.h);
    rows[i].forEach((r, j) => { g.fillStyle = r.c; g.fillText(r.t, b.x + pad, b.y + pad + j * lh); });
    if (b.remove) {
      const x = b.remove;
      g.fillStyle = 'rgba(255, 90, 80, 0.25)'; g.fillRect(x.x, x.y, x.w, x.h);
      g.strokeStyle = '#ff8a80'; g.lineWidth = 1.5 * k;
      const m = x.w * 0.3;
      g.beginPath(); g.moveTo(x.x + m, x.y + m); g.lineTo(x.x + x.w - m, x.y + x.h - m); g.moveTo(x.x + x.w - m, x.y + m); g.lineTo(x.x + m, x.y + x.h - m); g.stroke();
    }
  }
  g.globalAlpha = 1;
  g.textBaseline = 'alphabetic';
  return boxes;
}
