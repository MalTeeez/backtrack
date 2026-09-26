<script module lang="ts">
  import type { Id, Shot } from '../../lib/solver/types.ts';

  /** A color per shot, by its place in the list. */
  export const SHOT_COLORS = ['var(--shell)', '#7fb069', '#c77dff', '#4cc9f0', '#f28482', '#e9c46a'];
  export const shotColor = (i: number) => SHOT_COLORS[i % SHOT_COLORS.length];

  /**
   * A value track under the lanes, for the Review phase. It shows the value as a line, as ticks, or as a time range,
   * over its confidence as a tinted area. `c` is 0 to 1. A line maps `v` from `lo` to `hi`, and a range runs from `t`
   * to `v`.
   */
  export interface Track {
    id: string; label: string; kind: 'line' | 'ticks' | 'range'; pts: { t: number; v?: number; c: number }[]; lo?: number; hi?: number; unit?: string;
    /**
     * Makes the ranges of a range track into zones that the user can move and resize. The timeline calls it with a
     * range while the range changes, and with `done` at the end.
     */
    edit?: (i: number, a: number, b: number, done: boolean) => void;
  }

  /** Formats seconds as m:ss.mmm, with `dec` decimals. */
  export function timecode(t: number, dec = 3) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
  }
</script>

<script lang="ts">
  /**
   * The timeline of the loaded clip, as in a video editor: a ruler, the film strip, and one lane per shot with its
   * sightings as keyframes and its impact. The wheel zooms around the pointer, and Shift and the wheel pan. A drag on
   * the ruler selects a section that playback repeats. A double click on it, a right click on the ruler, its x button
   * or Alt+X clears it. That section and the ranges of an editable track are zones. A drag on the middle of a zone
   * moves it along, and a drag on an edge resizes it and snaps to the marks near it. Scrubbing snaps to the start and
   * the end of the clip.
   */
  import Maximize2 from '@jis3r/icons/icons/maximize-2';
  import Plus from '@jis3r/icons/icons/plus';
  import X from '@jis3r/icons/icons/x';
  import { Flame, Repeat, ZoomIn, ZoomOut } from '@lucide/svelte';
  import { addShot, batchClips, clips, clipView, deleteShot, flowOf, project, shotsOf, ui } from '../../lib/state/project.svelte.ts';
  import ArrowLeftRight from '@jis3r/icons/icons/arrow-left-right';
  import { untrack } from 'svelte';
  import { frameIndexAt, sameFrame } from '../../lib/video/frames.ts';
  import { frameCache, thumbAt } from '../../lib/video/frameCache.svelte.ts';
  import { portal } from '../../lib/portal.ts';
  import { lacks } from '../../lib/state/missing.ts';
  import { motionFlags } from '../../lib/solver/motion.ts';
  import UseToggle from '../UseToggle.svelte';
  import { value } from '../../lib/solver/field.ts';
  import { clipThumb } from '../../lib/video/clipThumbs.svelte.ts';

  let { time, clipId, frames, ongo, loop = $bindable(null), tracks = [], draw }: {
    time: number; clipId: Id | null; frames: number[] | undefined;
    tracks?: Track[];
    /**
     * The section tool of the automatic flow. While `on`, a drag in the lane of a shot draws its section, and a drag in
     * the lane of a new shot (shotId null) draws the section of a new shot. `get` gives the section of a shot, and
     * `set` takes a section while it changes, with `done` at the end.
     */
    draw?: {
      on: boolean; get: (shotId: Id) => { a: number; b: number } | undefined; set: (shotId: Id | null, a: number, b: number, done: boolean) => void;
      /** The shot whose section a remove button under the pointer would delete. Its section shows in red. */
      doomed?: Id | null;
    };
    /** `exact` asks for the frame itself, not a quick preview first (player.svelte.ts). */
    ongo: (clipId: Id, t: number, sightingId?: Id, exact?: boolean) => void;
    /** The section playback repeats, in seconds of the clip. */
    loop?: { a: number; b: number } | null;
  } = $props();

  const clip = $derived(clips.list.find((c) => c.id === clipId));
  const batch = $derived(batchClips());
  const d = $derived(clip?.durationS || 1);

  // The view is the visible part of the clip, in seconds. A clip opens on the part last seen, or on all of it.
  let view = $state({ a: 0, b: 1 });
  $effect(() => {
    const id = clipId, all = { a: 0, b: d };
    cancelAnimationFrame(anim);
    anim = 0;
    const v = untrack(() => (id && ui.clipViews[id]?.zoom) || all);
    view = v;
    goal = { ...v };
  });
  const span = $derived(view.b - view.a);
  const zoomed = $derived(span < d - 1e-6);
  let width = $state(0);
  let rulerEl: HTMLElement;
  const pxPerS = $derived(width / span);
  const x = (t: number) => `${((t - view.a) / span) * 100}%`;
  // A line starts on a whole pixel of the screen, so every tick draws equally sharp and dark. The pixels of the screen
  // can be smaller than those of the page, with a scaled display.
  const dpr = window.devicePixelRatio || 1;
  const xPx = (t: number) => Math.round((t - view.a) * pxPerS * dpr) / dpr;
  const xLine = (t: number) => `${xPx(t)}px`;
  /**
   * The place and the look of a shot section from a to b. Its edges lie on whole pixels of the screen, and its outline
   * is a border, which the browser rounds to whole pixels on each side alike. So it draws the same at every zoom: 2 px
   * at the start and the end, and 1 px at the top and the bottom.
   */
  const sectionStyle = (a: number, b: number, color: string) =>
    `left:${xPx(a)}px; width:${xPx(b) - xPx(a)}px; background:${tint(color, 22)}; border:solid ${color}; border-width:1px 2px`;
  const inView = (t: number) => t >= view.a - span * 0.02 && t <= view.b + span * 0.02;

  // A smooth change closes a share of the way to the goal on every frame: 1 - e^(-dt / ZOOM_TAU_MS). It starts fast
  // and slows down, and a new goal during the move turns it without a jolt.
  const ZOOM_TAU_MS = 70;
  // The typical time of a frame, from the middle gap between frames. At the closest zoom one frame takes half the
  // timeline, so the view spans at least two frames.
  const frameGap = $derived.by(() => {
    if (!frames || frames.length < 2) return 1 / 30;
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  });
  const minSpan = $derived(2 * frameGap);
  // The view a smooth zoom heads for. A zoom that comes while one runs starts from here, so fast wheel steps add up.
  let goal = { a: 0, b: 1 };
  let anim = 0;
  /** Shows the part of the clip from a to b. A smooth change eases there, and a drag or a turn of the page jumps. */
  function setView(a: number, b: number, smooth = false) {
    const s = Math.max(minSpan, Math.min(d, b - a));
    a = Math.max(0, Math.min(d - s, a));
    goal = { a, b: a + s };
    if (clipId) clipView(clipId).zoom = s < d - 1e-6 ? { ...goal } : undefined;
    if (!smooth || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(anim);
      anim = 0;
      view = { ...goal };
      return;
    }
    if (anim) return;
    // The time of a frame can lie before the call, so the first frame counts as one frame of 60 per second.
    let last = -1;
    const step = (now: number) => {
      const f = 1 - Math.exp(-Math.max(0, last < 0 ? 16 : now - last) / ZOOM_TAU_MS);
      last = now;
      const next = { a: view.a + (goal.a - view.a) * f, b: view.b + (goal.b - view.b) * f };
      // It ends within a third of a pixel of the goal.
      const done = Math.max(Math.abs(goal.a - next.a), Math.abs(goal.b - next.b)) * pxPerS < 0.3;
      view = done ? { ...goal } : next;
      anim = done ? 0 : requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  /**
   * Zooms by k around time t, smoothly. At the closest or the widest view, the zoom stops there with t in place, so
   * the view does not slide sideways.
   */
  function zoomAt(t: number, k: number) {
    const g = goal.b - goal.a, s = Math.max(minSpan, Math.min(d, g * k));
    if (Math.abs(s - g) < 1e-9) return;
    k = s / g;
    setView(t - (t - goal.a) * k, t + (goal.b - t) * k, true);
  }

  // a playhead that moves out of the zoomed view (playing, or a jump) turns the page. Only a new time does this, so
  // a zoom or a pan away from the playhead stays where the user put it.
  $effect(() => {
    const t = time;
    untrack(() => { if (zoomed && (t > view.b || t < view.a)) setView(t - span * 0.1, t + span * 0.9); });
  });

  // The film strip has tiles fixed in time, so they do not swim during a pan or a zoom. The time of a tile is a power
  // of two seconds, which makes a tile at most as wide as a thumbnail and more than half as wide. A picture keeps its
  // size and sits in the middle of its tile, which cuts off its sides. So a zoom only widens the part of each picture
  // that shows, and at twice the zoom each tile splits in two without a picture changing size. Each tile shows the
  // thumbnail of its middle frame, or the nearest one made so far (frameCache.svelte.ts).
  const tileW = $derived(Math.round(56 * ((clip?.width || 16) / (clip?.height || 9))));
  const tileS = $derived(2 ** Math.floor(Math.log2(tileW / pxPerS)));
  // Neighbor tiles with the same picture join into one run, which repeats the whole picture from its middle out and
  // cuts off only its two ends.
  const tiles = $derived.by(() => {
    if (!width || !clipId) return [];
    void frameCache.version; // the thumbnails that came in since
    const at = (k: number) => thumbAt(clipId, Math.min(d, Math.max(0, (k + 0.5) * tileS)));
    const out: { t: number; end: number; bmp?: ImageBitmap }[] = [];
    const k0 = Math.floor(view.a / tileS);
    let k = k0;
    for (; k * tileS < view.b; k++) {
      const bmp = at(k), last = out.at(-1);
      if (bmp && last?.bmp === bmp) last.end = (k + 1) * tileS;
      else out.push({ t: k * tileS, end: (k + 1) * tileS, bmp });
    }
    // The runs at the two ends of the view reach on past it, so their middle, where their pictures line up from, stays
    // put during a pan. A run cut at the edge of the view would move its pictures with every step.
    const first = out[0], last = out.at(-1);
    if (first?.bmp) for (let j = k0 - 1, n = 0; n < 500 && j * tileS >= 0 && at(j) === first.bmp; j--, n++) first.t = j * tileS;
    if (last?.bmp) for (let n = 0; n < 500 && k * tileS < d && at(k) === last.bmp; k++, n++) last.end = (k + 1) * tileS;
    return out;
  });
  // The strip is one canvas, drawn again in full on every change of the view. Its pictures are decoded already, so a
  // zoom never shows a frame without them, as elements with a new background picture would while it decodes.
  let stripCanvas = $state<HTMLCanvasElement>();
  let stripH = $state(0);
  $effect(() => {
    const c = stripCanvas, list = tiles, dpr = window.devicePixelRatio || 1;
    if (!c || !width || !stripH) return;
    const W = Math.round(width * dpr), H = Math.round(stripH * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    for (const tile of list) {
      const x0 = xPx(tile.t) * dpr, x1 = xPx(tile.end) * dpr;
      if (!tile.bmp) {
        // a tile without a picture yet shows its end
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.fillRect(Math.round(x1) - 1, 0, 1, H);
        continue;
      }
      // the picture keeps its size and repeats from the middle of the run out, cut off only at the ends
      const tw = tileW * dpr, mid = (x0 + x1) / 2;
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, H);
      g.clip();
      // only the pictures on the canvas, at the same places as the run lines them up
      const from = Math.max(x0, -tw), to = Math.min(x1, W + tw);
      for (let x = mid - tw / 2 - Math.ceil((mid - tw / 2 - from) / tw) * tw; x < to; x += tw) g.drawImage(tile.bmp, x, 0, tw, H);
      g.restore();
    }
  });

  // The ruler has a labeled major step at least 90 px apart, 5 minor steps between, and a tick per frame when they fit.
  const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const major = $derived(STEPS.find((s) => s * pxPerS >= 90) ?? 300);
  const ticks = $derived.by(() => {
    const out: { t: number; major: boolean }[] = [];
    const minor = major / 5;
    for (let i = Math.floor(view.a / minor); i * minor <= view.b; i++) out.push({ t: i * minor, major: i % 5 === 0 });
    return out;
  });
  const dec = $derived(major >= 1 ? 0 : major >= 0.1 ? 1 : 2);
  const frameTicks = $derived.by(() => {
    if (!frames?.length || (frames.length / d) * (1 / pxPerS) > 1 / 5) return [];
    const out: number[] = [];
    for (let i = frameIndexAt(frames, view.a); i < frames.length && frames[i] <= view.b; i++) out.push(frames[i]);
    return out;
  });

  // At 8 frames or fewer in view, the ruler shows each frame as a band with its number, and the frame on screen stands out.
  const frameBands = $derived.by(() => {
    if (!frames?.length) return [];
    const i0 = frameIndexAt(frames, view.a), i1 = frameIndexAt(frames, view.b);
    if (i1 - i0 + 1 > 8) return [];
    return Array.from({ length: i1 - i0 + 1 }, (_, k) => ({ i: i0 + k, a: frames[i0 + k], b: frames[i0 + k + 1] ?? d }));
  });
  /**
   * The start of the frame nearest to t. A drag of the playhead, of the edge of a zone or of a new section lands on the
   * start of a frame, where the video can show it, so the playhead stays with the pointer and the edge.
   */
  function atFrame(t: number) {
    if (!frames?.length) return t;
    const i = frameIndexAt(frames, t), next = frames[i + 1];
    return next != null && next - t < t - frames[i] ? next : frames[i];
  }

  const tAt = (e: PointerEvent | WheelEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return view.a + ((e.clientX - r.left) / r.width) * span;
  };
  const clamp = (t: number) => Math.max(0, Math.min(d, t));

  // A press on the film strip or a lane scrubs. A press on a lane also picks its shot. With the section tool on, a
  // press on a lane draws instead, in the lane `lane` (null for the lane of a new shot).
  let scrubEl: HTMLElement | null = null;
  // The section the tool draws, in its lane and in the color of its shot. The video follows the pointer meanwhile.
  let drawing = $state<{ a: number; b: number; lane: Id | null; color: string } | null>(null);
  function scrubDown(e: PointerEvent, shotId?: Id, lane?: { id: Id | null; color: string }) {
    if (e.button !== 0 || !clipId || (e.target as HTMLElement).closest('button')) return;
    scrubEl = e.currentTarget as HTMLElement;
    scrubEl.setPointerCapture(e.pointerId);
    const draws = !!draw?.on && !!lane;
    lineColor = draws ? lane!.color : 'var(--accent)';
    const t = atFrame(snap(clamp(tAt(e, scrubEl)), draws ? edges : ends));
    if (draws) drawing = { a: t, b: t, lane: lane!.id, color: lane!.color };
    else if (shotId) ui.shotId = shotId;
    // a new section shows its frames themselves, and a scrub its previews first
    ongo(clipId, t, undefined, draws);
  }
  /** Ends a press. A drawn section longer than 50 ms goes to the tool, and a shorter one was a click. */
  function scrubUp() {
    if (drawing && draw) {
      const a = Math.min(drawing.a, drawing.b), b = Math.max(drawing.a, drawing.b);
      if (b - a > 0.05) draw.set(drawing.lane, a, b, true);
    }
    drawing = null;
    scrubEl = null;
    snapped = null;
    hint = null;
  }
  function scrubMove(e: PointerEvent) {
    if (!scrubEl || !clipId) { hover(e); return; }
    const t = atFrame(snap(clamp(tAt(e, scrubEl)), drawing ? edges : ends));
    if (drawing) { drawing.b = t; hint = t; }
    ongo(clipId, t, undefined, !!drawing);
  }

  // A drag on the ruler selects the section to repeat. A click seeks, and a right click clears the section.
  let range = $state<{ el: HTMLElement; from: number; to: number } | null>(null);
  function rulerDown(e: PointerEvent) {
    if (e.button === 2) { loop = null; return; }
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    lineColor = 'var(--accent)';
    const t = atFrame(snap(clamp(tAt(e, el)), ends));
    range = { el, from: t, to: t };
  }
  function rulerMove(e: PointerEvent) {
    if (!range) { hover(e); return; }
    const to = atFrame(snap(clamp(tAt(e, range.el)), ends));
    if (to === range.to) return;
    range.to = to;
    // Once the press is a drag, the playhead and the video follow the moving end of the new section, as they follow
    // the edge of a section that exists.
    if (clipId && Math.abs(to - range.from) * pxPerS > 4) ongo(clipId, to, undefined, true);
  }
  function rulerUp() {
    if (!range) return;
    const [a, b] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
    if ((b - a) * pxPerS > 4) loop = { a, b };
    else if (clipId) ongo(clipId, range.to);
    range = null;
    snapped = null;
  }

  // A time within SNAP_PX of a mark snaps to the mark, which lights up across the timeline meanwhile.
  const SNAP_PX = 8;
  let snapped = $state<number | null>(null);
  // The hint shows the same line before a press: over the edge of a zone, and near the start or the end of the clip,
  // where a click jumps.
  let hint = $state<number | null>(null);
  // The line takes the color of what it belongs to: the zone of the edge, or the playhead at the ends of the clip.
  let lineColor = $state('var(--accent)');
  const edgeHint = (t: number, color: string) => { hint = t; lineColor = color; };
  function hover(e: PointerEvent) {
    if ((e.target as Element).closest('.grip')) return;
    const t = tAt(e, rulerEl), near = ends.find((m) => Math.abs(m - t) <= SNAP_PX / pxPerS);
    hint = near ?? null;
    lineColor = 'var(--accent)';
  }
  function snap(t: number, marks: number[]): number {
    let best: number | null = null, dist = SNAP_PX / pxPerS;
    for (const m of marks) if (Math.abs(m - t) <= dist) { best = m; dist = Math.abs(m - t); }
    snapped = best;
    return best ?? t;
  }
  const ends = $derived([0, d]);
  /**
   * What a drawn edge snaps to: the ends of the clip, the sightings, the impacts and the zones. The edge of a zone also
   * snaps to the playhead, which a drawn edge moves itself.
   */
  const edges = $derived([
    0, d, ...(loop ? [loop.a, loop.b] : []),
    ...project.sightings.filter((s) => s.clipId === clipId).map((s) => s.timeS),
    ...shotsOf(clipId).map((sh) => (clipId ? value(sh.impact[clipId])?.b : undefined)).filter((t) => t != null),
    ...tracks.filter((tr) => tr.kind === 'range').flatMap((tr) => tr.pts.flatMap((p) => [p.t, p.v ?? p.t])),
    ...(draw ? shotsOf(clipId).flatMap((sh) => { const s = draw.get(sh.id); return s ? [s.a, s.b] : []; }) : []),
  ]);
  const marks = $derived([...edges, time]);

  /** A shot is free for the section tool while its lane holds nothing: no section, no sighting and no impact. */
  const isFree = (sh: Shot) => !!clipId && !draw?.get(sh.id) && !project.clips[clipId]?.sections?.some((x) => x.shotId === sh.id)
    && !project.sightings.some((s) => s.shotId === sh.id && s.clipId === clipId) && value(sh.impact[clipId]) == null;
  // With the tool on and no free lane, a lane for a new shot follows the lanes of the shots.
  const newLane = $derived(!!draw?.on && !project.shots.some((sh) => lanes.has(sh.id) && isFree(sh)));
  /** A tint of a color of a shot, for a free lane and for a section. */
  const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

  // A drag on the middle of a zone moves it, and a click there seeks. A drag on an edge moves that edge, and an edge
  // dragged over the other edge becomes the other end of the zone.
  interface Zone { a: number; b: number; color: string; set: (a: number, b: number, done: boolean) => void }
  let zoning = $state<'grabbing' | 'ew-resize' | null>(null);
  function zoneDown(e: PointerEvent, z: Zone, part: 'move' | 'a' | 'b') {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, t0 = tAt(e, rulerEl), len = z.b - z.a, anchor = part === 'a' ? z.b : z.a;
    const others = marks.filter((m) => m !== z.a && m !== z.b);
    let now = { a: z.a, b: z.b }, moved = false;
    zoning = part === 'move' ? 'grabbing' : 'ew-resize';
    lineColor = z.color;
    const on = (ev: PointerEvent) => {
      moved ||= Math.abs(ev.clientX - x0) > 3;
      if (!moved) return;
      const t = tAt(ev, rulerEl);
      if (part === 'move') { const a = Math.max(0, Math.min(d - len, z.a + t - t0)); now = { a, b: a + len }; }
      else {
        const s = atFrame(snap(clamp(t), others));
        now = { a: Math.min(anchor, s), b: Math.max(anchor, s) };
        // The line follows the edge that moves, and so does the playhead, as in a drag of the playhead.
        hint = s;
        if (clipId) ongo(clipId, s, undefined, true);
      }
      z.set(now.a, now.b, false);
    };
    const off = () => {
      window.removeEventListener('pointermove', on);
      zoning = null;
      snapped = null;
      hint = null;
      if (moved) z.set(now.a, now.b, true);
      else if (clipId) ongo(clipId, clamp(t0));
    };
    window.addEventListener('pointermove', on);
    window.addEventListener('pointerup', off, { once: true });
  }

  // A drag with the middle button pans a zoomed view, and the grab cursor holds over the timeline meanwhile.
  function panDown(e: PointerEvent) {
    if (e.button !== 1) return;
    // This also stops the browser from scrolling on its own on a middle click.
    e.preventDefault();
    e.stopPropagation();
    if (!zoomed) return;
    const x0 = e.clientX, a0 = view.a, b0 = view.b;
    zoning = 'grabbing';
    const on = (ev: PointerEvent) => { const dt = ((x0 - ev.clientX) / width) * (b0 - a0); setView(a0 + dt, b0 + dt); };
    const off = () => { zoning = null; window.removeEventListener('pointermove', on); };
    window.addEventListener('pointermove', on);
    window.addEventListener('pointerup', off, { once: true });
  }

  // The wheel zooms around the pointer, and Shift or a sideways wheel pans. The listener is not passive, so the page
  // does not scroll.
  const wheel = (el: HTMLElement) => {
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const pan = e.shiftKey ? e.deltaY : e.deltaX, g = goal.b - goal.a;
      if (Math.abs(pan) > Math.abs(e.shiftKey ? 0 : e.deltaY)) setView(goal.a + (pan / width) * g, goal.b + (pan / width) * g);
      // the time under the pointer in the view the zoom heads for, so it stays under the pointer
      else zoomAt(clamp(goal.a + ((e.clientX - rulerEl.getBoundingClientRect().left) / width) * g), e.deltaY > 0 ? 1.25 : 0.8);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  };

  // The sightings that a jump of the shell leads to get an outline on their keyframes.
  const jumpy = $derived(new Set(motionFlags($state.snapshot(project)).map((f) => f.to)));
  // Each shot of this clip gets a lane. The colors stay those of the whole project.
  const lanes = $derived(new Set([...shotsOf(clipId).map((s) => s.id), ui.shotId]));
  // The shot whose delete button is under the pointer. Its lane and its section show in red.
  let deleting = $state<Id | null>(null);
  // The value of a track under the pointer, in a tooltip at the pointer while it is over the track.
  let trackTip = $state<{ x: number; y: number; text: string } | null>(null);
  function trackTipAt(e: PointerEvent, tr: Track) {
    const t = tAt(e, e.currentTarget as HTMLElement);
    const inRange = tr.kind === 'range' ? tr.pts.find((p) => t >= p.t && t <= (p.v ?? p.t)) : undefined;
    const p = inRange ?? tr.pts.reduce<Track['pts'][number] | undefined>((b, q) => (!b || Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b), undefined);
    // only a point within 8 px of the pointer counts, except in a range
    if (!p || (!inRange && Math.abs(p.t - t) * pxPerS > 8)) { trackTip = null; return; }
    const sure = `${Math.round(p.c * 100)} percent sure`;
    const text = tr.kind === 'range' ? `${tr.label} from ${p.t.toFixed(3)} s to ${(p.v ?? p.t).toFixed(3)} s, ${sure}`
      : p.v != null ? `${tr.label} ${p.v.toFixed(2)}${tr.unit ? ` ${tr.unit}` : ''} at ${p.t.toFixed(3)} s, ${sure}`
      : tr.kind === 'line' ? `${tr.label} at ${p.t.toFixed(3)} s has no value`
      : `${tr.label} at ${p.t.toFixed(3)} s, ${sure}`;
    // above the pointer, since the timeline often lies at the bottom of the page
    trackTip = { x: e.clientX + 14, y: e.clientY - 34, text };
  }
  const count = (shotId: Id) => project.sightings.filter((s) => s.shotId === shotId && s.clipId === clipId).length;
  /**
   * The length of a section, as long as the section is wide enough on screen. It drops the decimals first and keeps the
   * unit, then shows nothing. A length under a second keeps its decimal. A character of the text (11 px, monospace)
   * takes 0.6 of its size, and the edges keep 2 px each.
   */
  function lengthText(dt: number) {
    const w = dt * pxPerS;
    return [`${dt.toFixed(2)}s`, `${dt.toFixed(1)}s`, ...(dt >= 1 ? [`${Math.round(dt)}s`] : [])].find((t) => t.length * 6.6 + 4 <= w);
  }
</script>

{#snippet length(dt: number, color: string)}
  {@const t = lengthText(dt)}
  {#if t}<span class="pointer-events-none absolute inset-0 grid place-items-center whitespace-nowrap text-[11px]" style:color={color}>{t}</span>{/if}
{/snippet}

{#if trackTip}<span class="hidden" {@attach portal}><span class="tip" style="left:{trackTip.x}px; top:{trackTip.y}px" data-testid="track-tip">{trackTip.text}</span></span>{/if}
<div class="flex flex-col gap-1.5" class:zoning={zoning != null} style:cursor={zoning} data-testid="timeline">
  <div class="flex flex-wrap items-center gap-1.5">
    <div class="flex min-w-0 flex-1 flex-wrap gap-1" role="group" aria-label="Clips">
      <!-- The buttons switch between the clips of the batch (batchClips). -->
      {#each clips.list.filter((c) => batch.includes(c.id)) as c (c.id)}
        <button
          class="option min-h-7 min-w-0 max-w-64 justify-start gap-1.5 py-0 pl-0.5 pr-2 text-[12px]"
          aria-pressed={c.id === clipId}
          title={c.name}
          onclick={() => ongo(c.id, c.id === clipId ? time : 0)}
        >
          <span class="h-[22px] w-10 shrink-0 overflow-hidden bg-stage">
            {#if clipThumb(c.id, c.durationS)}<img src={clipThumb(c.id, c.durationS)} alt="" draggable="false" class="h-full w-full object-cover" />{/if}
          </span>
          <span class="min-w-0 truncate">{c.name}</span>
        </button>
      {/each}
    </div>
    <span class="num text-[11px] text-muted">{timecode(view.a, 2)} to {timecode(view.b, 2)}</span>
    <button class="btn icon sm" aria-label="Zoom out" title="Zoom out (wheel down)" onclick={() => zoomAt(time, 2)} disabled={!zoomed}><ZoomOut size={14} /></button>
    <button class="btn icon sm" aria-label="Zoom in" title="Zoom in (wheel up)" onclick={() => zoomAt(time, 0.5)}><ZoomIn size={14} /></button>
    {#if loop}<button class="btn sm" onclick={() => setView(loop!.a, loop!.b, true)} title="Show the repeated section"><Repeat size={13} /> Zoom to loop</button>{/if}
    <button class="btn sm" onclick={() => setView(0, d, true)} disabled={!zoomed} title="Show the whole clip"><Maximize2 size={13} /> Reset zoom</button>
  </div>

  <div class="relative grid grid-cols-[11rem_minmax(0,1fr)] border border-line" {@attach wheel} role="presentation" onpointerdowncapture={panDown}
    onmousedowncapture={(e) => e.button === 1 && e.preventDefault()}>
    <!-- ruler -->
    <span class="border-b border-r border-line"></span>
    <div
      class="relative h-7 cursor-text touch-none select-none overflow-hidden border-b border-line bg-panel"
      data-testid="ruler"
      title="Drag to select a section that playback repeats. Double click it, right click here or press Alt+X to clear it."
      bind:clientWidth={width}
      bind:this={rulerEl}
      role="presentation"
      onpointerdown={rulerDown}
      onpointermove={rulerMove}
      onpointerleave={() => (hint = null)}
      onpointerup={rulerUp}
      onpointercancel={() => (range = null)}
      oncontextmenu={(e) => e.preventDefault()}
      ondblclick={(e) => { const t = tAt(e as unknown as PointerEvent, rulerEl); if (loop && t >= loop.a && t <= loop.b) loop = null; }}
    >
      <!-- Three heights: the steps with a label, the steps between them, and the frames, which the clip
           does not space evenly. -->
      {#each frameBands as fb (fb.i)}
        <span class="pointer-events-none absolute inset-y-0 {fb.i % 2 ? 'bg-black/[0.04]' : ''} {sameFrame(fb.a, time) ? 'bg-[var(--accent-soft)]' : ''}"
          style="left:{xLine(fb.a)}; width:{xPx(fb.b) - xPx(fb.a)}px">
          <!-- the number at the bottom left, below the time labels at the top -->
          <span class="num absolute bottom-0.5 left-1 whitespace-nowrap text-[9px] leading-none {sameFrame(fb.a, time) ? 'text-accent' : 'text-muted'}">#{fb.i + 1}</span>
        </span>
      {/each}
      {#each frameTicks as t}<span class="absolute bottom-0 h-[3px] w-px bg-line-strong opacity-60" style="left:{xLine(t)}"></span>{/each}
      {#each ticks as k (k.t)}
        <span class="absolute bottom-0 w-px {k.major ? 'h-3 bg-muted' : 'h-2 bg-line-strong'}" style="left:{xLine(k.t)}"></span>
        {#if k.major}<span class="num absolute top-0.5 pl-1 text-[10px] text-muted" style="left:{x(k.t)}">{timecode(k.t, dec)}</span>{/if}
      {/each}
      {#if loop}
        {@const z = { a: loop.a, b: loop.b, color: 'var(--accent)', set: (a: number, b: number) => (loop = { a, b }) }}
        <span class="zone absolute inset-y-0 border-x-2 border-accent bg-accent/30" style="left:{x(loop.a)}; width:{((loop.b - loop.a) / span) * 100}%" data-testid="loop"
          role="presentation" data-notip onpointerdown={(e) => zoneDown(e, z, 'move')}>
          <span class="grip start" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'a')} onpointerenter={() => edgeHint(z.a, z.color)} onpointerleave={() => (hint = null)}></span>
          <span class="grip end" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'b')} onpointerenter={() => edgeHint(z.b, z.color)} onpointerleave={() => (hint = null)}></span>
          <button class="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center bg-panel text-muted hover:text-text" aria-label="Clear the repeated section" title="Clear the repeated section (Alt+X)" onclick={() => (loop = null)}><X size={11} /></button>
        </span>
      {/if}
      {#if range}
        <span class="absolute inset-y-0 border-x border-accent bg-accent/25" style="left:{x(Math.min(range.from, range.to))}; width:{(Math.abs(range.to - range.from) / span) * 100}%"></span>
      {/if}
    </div>

    <!-- film strip -->
    <span class="flex items-center border-b border-r border-line px-2 text-[11px] text-muted">Video</span>
    <div
      class="relative h-14 cursor-ew-resize touch-none select-none overflow-hidden border-b border-line bg-stage"
      data-testid="strip"
      role="slider"
      tabindex="-1"
      aria-label="Time in {clip?.name ?? 'clip'}"
      aria-valuenow={time}
      onpointerdown={(e) => scrubDown(e)}
      onpointermove={scrubMove}
      onpointerleave={() => (hint = null)}
      onpointerup={scrubUp}
      onpointercancel={() => { drawing = null; scrubEl = null; }}
    >
      <canvas bind:this={stripCanvas} bind:clientHeight={stripH} class="pointer-events-none absolute inset-0 block h-full w-full opacity-70"></canvas>
      {#each ticks as k (k.t)}{#if k.major}<span class="pointer-events-none absolute inset-y-0 w-px bg-black/25" style="left:{xLine(k.t)}"></span>{/if}{/each}
    </div>

    <!-- one lane per shot -->
    {#each project.shots as sh, si (sh.id)}
      {#if lanes.has(sh.id)}
      {@const active = sh.id === ui.shotId}
      {@const color = shotColor(si)}
      {@const list = project.sightings.filter((s) => s.shotId === sh.id && s.clipId === clipId)}
      {@const impact = clipId ? value(sh.impact[clipId])?.b : undefined}
      {@const sec = clipId ? project.clips[clipId]?.sections?.find((x) => x.shotId === sh.id) : undefined}
      {@const pend = draw?.get(sh.id)}
      {@const doomed = draw?.doomed === sh.id || deleting === sh.id}
      {@const free = !!draw?.on && isFree(sh)}
      {@const own = flowOf(sh)}
      <div class="flex min-w-0 items-center gap-1.5 border-b border-r border-line px-2 text-[12px] {doomed ? 'text-bad' : active ? 'bg-[var(--accent-soft)] text-text' : 'text-muted'}" data-testid="lane-{si}">
        <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left {sh.excluded ? 'opacity-50' : ''}" onclick={() => (ui.shotId = sh.id)} title="Mark sightings for {sh.name}">
          <span class="h-2.5 w-2.5 shrink-0" style="background:{color}"></span>
          <span class="truncate">{sh.name}</span>
          {#if count(sh.id)}<span class="num ml-auto text-[10px] text-muted">{count(sh.id)}</span>{/if}
        </button>
        {#if own && clipId && project.clips[clipId]?.mode}
          <!-- a shot of one flow can show in the other one too, for example when the automatic flow hands it to marking by hand -->
          {@const other = own === 'auto' ? 'manual' : 'automatic'}
          <button class="grid h-5 w-5 shrink-0 place-items-center {sh.shared ? 'text-accent' : 'text-muted hover:text-text'}" aria-pressed={!!sh.shared}
            aria-label={sh.shared ? `Show ${sh.name} only in the ${own === 'auto' ? 'automatic' : 'manual'} flow` : `Also show ${sh.name} in the ${other} flow`}
            title={sh.shared ? `${sh.name} shows in both flows. Click to show it only in the ${own === 'auto' ? 'automatic' : 'manual'} flow.` : `Also show ${sh.name} in the ${other} flow`}
            data-testid="share-shot-{si}" onclick={() => (sh.shared = !sh.shared || undefined)}><ArrowLeftRight size={12} /></button>
        {/if}
        <UseToggle target={sh} what="this shot" />
        <button class="grid h-5 w-5 shrink-0 place-items-center text-muted hover:text-bad" aria-label="Delete {sh.name}" title="Delete {sh.name} with its sightings and its section" data-testid="delete-shot-{si}"
          onpointerenter={() => (deleting = sh.id)} onpointerleave={() => (deleting = null)} onclick={() => { deleting = null; deleteShot(sh.id); }}><X size={11} /></button>
      </div>
      <div
        class="relative h-7 {draw?.on ? 'cursor-crosshair' : 'cursor-ew-resize'} touch-none select-none overflow-hidden border-b border-line {active && !free ? 'bg-[var(--accent-soft)]' : ''}"
        class:left-out={sh.excluded}
        style={free ? `background:${tint(color, 12)}; box-shadow:inset 3px 0 0 ${color}` : ''}
        role="presentation" data-testid="track-lane-{si}"
        onpointerdown={(e) => scrubDown(e, sh.id, { id: sh.id, color })}
        onpointermove={scrubMove}
        onpointerleave={() => (hint = null)}
        onpointerup={scrubUp}
        onpointercancel={() => { drawing = null; scrubEl = null; }}
      >
        {#each ticks as k (k.t)}{#if k.major}<span class="pointer-events-none absolute inset-y-0 w-px bg-line opacity-60" style="left:{xLine(k.t)}"></span>{/if}{/each}
        {#if free && !(drawing && drawing.lane === sh.id)}
          <span class="pointer-events-none absolute inset-0 flex items-center pl-2 text-[11px]" style="color:{color}">Drag over the flight of the shell of {sh.name}</span>
        {/if}
        {#if pend && !(drawing && drawing.lane === sh.id)}
          <!-- The section of the shot for the automatic flow. The middle moves it and an edge resizes it. -->
          {@const z = { a: pend.a, b: pend.b, color, set: (a: number, b: number, done: boolean) => draw!.set(sh.id, a, b, done) }}
          <span class="zone absolute inset-y-1" style={sectionStyle(z.a, z.b, doomed ? 'var(--bad)' : color)}
            role="presentation" data-notip data-testid="section-{si}" onpointerdown={(e) => zoneDown(e, z, 'move')}>
            <!-- the length of the flight, which says at a glance whether the section fits a shell -->
            {@render length(z.b - z.a, doomed ? 'var(--bad)' : color)}
            <span class="grip start" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'a')} onpointerenter={() => edgeHint(z.a, z.color)} onpointerleave={() => (hint = null)}></span>
            <span class="grip end" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'b')} onpointerenter={() => edgeHint(z.b, z.color)} onpointerleave={() => (hint = null)}></span>
          </span>
        {/if}
        {#if drawing && drawing.lane === sh.id}
          <span class="pointer-events-none absolute inset-y-1" style={sectionStyle(Math.min(drawing.a, drawing.b), Math.max(drawing.a, drawing.b), color)}>{@render length(Math.abs(drawing.b - drawing.a), color)}</span>
        {/if}
        {#if sec}
          <!-- the section of the detection, and the frames it left out -->
          <span class="pointer-events-none absolute bottom-0 h-[3px] bg-accent/60" style="left:{x(sec.a)}; width:{((sec.b - sec.a) / span) * 100}%" title="Detection"></span>
          {#each sec.dropped as d (d.t)}{#if inView(d.t)}<span class="pointer-events-none absolute bottom-0 h-2 w-px -translate-x-1/2 bg-warn" style="left:{x(d.t)}"></span>{/if}{/each}
        {/if}
        {#if list.length && impact != null}
          <!-- the flight, from the first sighting to the impact -->
          {@const first = Math.min(...list.map((s) => s.timeS))}
          <span class="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 opacity-40" style="left:{x(first)}; width:{((impact - first) / span) * 100}%; background:{color}"></span>
        {/if}
        {#each list as s (s.id)}
          {#if inView(s.timeS)}
            {@const todo = lacks(s)}
            <button
              class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 {todo.length || jumpy.has(s.id) ? 'border-warn' : active ? 'border-black/70' : 'border-black/40'} {s.excluded ? 'opacity-25' : active ? '' : 'opacity-50'}"
              style="left:{x(s.timeS)}; background:{value(s.shell) ? color : 'var(--panel-solid)'}"
              title="Sighting of {sh.name} at {s.timeS.toFixed(3)} s.{todo.length ? ` It still needs: ${todo.join(', ')}.` : ''}{jumpy.has(s.id) ? ' The shell jumps to this frame.' : ''}{s.excluded ? ' The calculation leaves it out.' : ''}"
              aria-label="Sighting of {sh.name} at {s.timeS.toFixed(3)} s"
              onclick={() => { ui.shotId = sh.id; if (clipId) ongo(clipId, s.timeS, s.id); }}
            ></button>
            {#if s.edges.length}<span class="pointer-events-none absolute bottom-0 h-1.5 w-[3px] -translate-x-1/2" style="left:{x(s.timeS)}; background:var(--edge)"></span>{/if}
          {/if}
        {/each}
        {#if impact != null && inView(impact)}
          <button
            class="absolute inset-y-0 flex -translate-x-1/2 items-center text-impact {active ? '' : 'opacity-50'}"
            style="left:{x(impact)}"
            title="Impact of {sh.name} at {impact.toFixed(3)} s"
            aria-label="Impact of {sh.name}"
            onclick={() => { ui.shotId = sh.id; if (clipId) ongo(clipId, impact); }}
          ><Flame size={16} fill="currentColor" /></button>
        {/if}
      </div>
      {/if}
    {/each}
    {#if newLane}
      <!-- Every lane holds something, so the section tool draws the next shot in a lane of its own. -->
      {@const color = shotColor(project.shots.length)}
      <!-- It is the last row, so the frame of the timeline draws its bottom line. -->
      <button class="flex min-w-0 items-center gap-1.5 border-r border-line px-2 text-left text-[12px] text-muted hover:text-text" onclick={addShot}
        title="Add the next shot. Its lane then takes the section."><Plus size={12} /> New shot</button>
      <div
        class="relative h-7 cursor-crosshair touch-none select-none overflow-hidden"
        style="background:{tint(color, 12)}; box-shadow:inset 3px 0 0 {color}"
        role="presentation" data-testid="track-lane-new"
        onpointerdown={(e) => scrubDown(e, undefined, { id: null, color })}
        onpointermove={scrubMove}
        onpointerleave={() => (hint = null)}
        onpointerup={scrubUp}
        onpointercancel={() => { drawing = null; scrubEl = null; }}
      >
        {#if drawing && drawing.lane === null}
          <span class="pointer-events-none absolute inset-y-1" style={sectionStyle(Math.min(drawing.a, drawing.b), Math.max(drawing.a, drawing.b), color)}>{@render length(Math.abs(drawing.b - drawing.a), color)}</span>
        {:else}
          <span class="pointer-events-none absolute inset-0 flex items-center pl-2 text-[11px]" style="color:{color}">Drag over the flight of the shell of the next shot</span>
        {/if}
      </div>
    {/if}
    <!-- The lane of the next shot adds a shot itself. -->
    {#if !newLane}
    <button class="flex items-center gap-1 border-r border-line px-2 py-1 text-[11.5px] text-muted hover:text-text" onclick={addShot} title="Add a new shot. A shot has one shell and one crater."><Plus size={12} /> Shot</button>
    <span></span>
    {/if}
    <!-- each value track shows the value over its confidence -->
    {#each tracks as tr (tr.id)}
      {@const X = (t: number) => ((t - view.a) / span) * 100}
      {@const mean = tr.pts.length ? tr.pts.reduce((a, p) => a + p.c, 0) / tr.pts.length : 0}
      {@const tone = mean >= 0.9 ? 'var(--ok)' : mean >= 0.7 ? 'var(--accent)' : 'var(--warn)'}
      {@const Y = (v: number) => 18 - ((v - (tr.lo ?? 0)) / ((tr.hi ?? 1) - (tr.lo ?? 0) || 1)) * 16}
      <div class="flex min-w-0 items-center border-b border-r border-line px-2 text-[11px] text-muted" title={tr.label}><span class="truncate">{tr.label}</span></div>
      <div class="relative h-6 overflow-hidden border-b border-line" data-testid="track-{tr.id}" role="presentation"
        onpointermove={(e) => trackTipAt(e, tr)} onpointerleave={() => (trackTip = null)}>
        <svg class="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
          {#if tr.kind === 'range'}
            {#each tr.pts as p, i (i)}<rect x={X(p.t)} width={Math.max(0.3, X(p.v ?? p.t) - X(p.t))} y="0" height="20" fill={tone} opacity={0.25 + 0.5 * p.c} />{/each}
          {:else}
            <polygon points="{X(tr.pts[0]?.t ?? 0)},20 {tr.pts.map((p) => `${X(p.t)},${20 - p.c * 18}`).join(' ')} {X(tr.pts.at(-1)?.t ?? 0)},20" fill={tone} opacity="0.22" />
            {#if tr.kind === 'line'}
              <polyline points={tr.pts.filter((p) => p.v != null).map((p) => `${X(p.t)},${Y(p.v!)}`).join(' ')} fill="none" stroke="var(--text)" stroke-width="1.25" vector-effect="non-scaling-stroke" />
            {:else}
              {#each tr.pts as p, i (i)}<line x1={X(p.t)} x2={X(p.t)} y1="4" y2="16" stroke="var(--shell)" stroke-width="1.5" vector-effect="non-scaling-stroke" />{/each}
            {/if}
          {/if}
        </svg>
        {#if tr.kind === 'range' && tr.edit}
          {#each tr.pts as p, i (i)}
            {@const z = { a: p.t, b: p.v ?? p.t, color: tone, set: (a: number, b: number, done: boolean) => tr.edit!(i, a, b, done) }}
            <span class="zone absolute inset-y-0" style="left:{x(z.a)}; width:{((z.b - z.a) / span) * 100}%" data-testid="zone-{tr.id}-{i}"
              role="presentation" data-notip onpointerdown={(e) => zoneDown(e, z, 'move')}>
              <span class="grip start" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'a')} onpointerenter={() => edgeHint(z.a, z.color)} onpointerleave={() => (hint = null)}></span>
              <span class="grip end" role="presentation" onpointerdown={(e) => zoneDown(e, z, 'b')} onpointerenter={() => edgeHint(z.b, z.color)} onpointerleave={() => (hint = null)}></span>
            </span>
          {/each}
        {/if}
      </div>
    {/each}
    <!-- the repeated section over the strip and the lanes -->
    {#if loop}
      <div class="pointer-events-none absolute inset-y-0 left-[11rem] right-0 overflow-hidden">
        <span class="absolute inset-y-0 border-x border-accent/60 bg-accent/10" style="left:{x(loop.a)}; width:{((loop.b - loop.a) / span) * 100}%"></span>
      </div>
    {/if}
    <!-- The line of the mark an edge or the playhead snapped to, or of a hint before the press. -->
    {#if (snapped ?? hint) != null && (snapped ?? hint)! >= view.a && (snapped ?? hint)! <= view.b}
      <div class="pointer-events-none absolute inset-y-0 left-[11rem] right-0" data-testid={snapped != null ? 'snap' : 'snap-hint'}>
        <span class="absolute inset-y-0 w-[3px] -translate-x-1/2" style="left:{x((snapped ?? hint)!)}; background:{lineColor}; opacity:{snapped != null ? 1 : 0.55}"></span>
      </div>
    {/if}
    <!-- the playhead over the ruler, the strip and the lanes -->
    {#if time >= view.a && time <= view.b}
      <div class="pointer-events-none absolute inset-y-0 left-[11rem] right-0">
        <!-- Both sit on whole pixels of the screen, so the line stays sharp while it moves. The notch covers the top
             border of the timeline and the end of the line's outline. -->
        <span class="absolute inset-y-0 w-0.5 -translate-x-px bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style="left:{xLine(time)}"></span>
        <span class="absolute -top-px h-[9px] w-2.5 -translate-x-[5px] bg-accent [clip-path:polygon(0_0,100%_0,50%_100%)]" style="left:{xLine(time)}"></span>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The edges of a zone have a hit area of half a line on each side of the edge. */
  .grip { position: absolute; top: 0; bottom: 0; width: 0.5rem; cursor: ew-resize; }
  .grip.start { left: -0.25rem; }
  .grip.end { right: -0.25rem; }
  /* The cursor of a drag holds over the whole timeline. The timeline itself carries it inline. */
  .zoning :global(*) { cursor: inherit !important; }
  .zoning { user-select: none; }
  /* A shot left out of the calculation shows its section, its sightings and its impact in grey. */
  .left-out > * { filter: grayscale(1) opacity(0.4); }
</style>
