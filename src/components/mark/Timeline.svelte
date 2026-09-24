<script module lang="ts">
  import { clipFrames, clipUrl } from '../../lib/state/persistence.ts';
  import { thumbTimes } from '../../lib/video/frames.ts';
  import { makeThumbnails } from '../../lib/video/thumbnails.ts';
  import type { Id } from '../../lib/solver/types.ts';

  // module scope, so the film strips survive a phase change. Each strip is a sorted list of frames with a picture.
  interface Thumb { t: number; src: string }
  const strips: Record<Id, Thumb[]> = $state({});
  const started = new Set<Id>();

  /** Adds the thumbnails of the frames that start at `times` to the strip of a clip, in time order. */
  async function addThumbs(id: Id, times: number[], cancelled: () => boolean) {
    const url = await clipUrl(id);
    if (!url || !times.length) return;
    await makeThumbnails(url, times, (i, src) => {
      if (!strips[id]) strips[id] = [];
      const list = strips[id]; // the reactive copy
      const t = times[i];
      let k = list.length;
      while (k > 0 && list[k - 1].t > t) k--;
      if (list[k - 1]?.t !== t) list.splice(k, 0, { t, src });
    }, () => cancelled() || !started.has(id)).catch(() => {});
  }

  /** One thumbnail per 2 s of video, each a different frame from the frame list of the clip. */
  async function strip(id: Id, durationS: number) {
    if (started.has(id)) return;
    started.add(id);
    const frames = await clipFrames(id);
    const count = Math.max(1, Math.ceil(durationS / 2));
    const times = frames?.length ? thumbTimes(frames, durationS, 2) : Array.from({ length: count }, (_, i) => (i * durationS) / count);
    await addThumbs(id, times, () => false);
  }
  /** Drops the film strip of a deleted clip. */
  export function forgetStrip(id: Id) {
    delete strips[id];
    started.delete(id);
  }

  /** The thumbnail nearest to t in a sorted strip. */
  function nearest(list: Thumb[], t: number): Thumb | undefined {
    let lo = 0, hi = list.length - 1;
    if (hi < 0) return undefined;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m + 1; else hi = m; }
    return lo > 0 && t - list[lo - 1].t < list[lo].t - t ? list[lo - 1] : list[lo];
  }

  /** A color per shot, by its place in the list. */
  export const SHOT_COLORS = ['var(--shell)', '#7fb069', '#c77dff', '#4cc9f0', '#f28482', '#e9c46a'];
  export const shotColor = (i: number) => SHOT_COLORS[i % SHOT_COLORS.length];

  /** Seconds as m:ss.mmm, with `dec` decimals. */
  export function timecode(t: number, dec = 3) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
  }
</script>

<script lang="ts">
  /**
   * The timeline of the loaded clip, as in a video editor: a ruler, the film strip, and one lane per shot with its
   * sightings as keyframes and its impact. The wheel zooms around the pointer, and Shift and the wheel pan. A drag on
   * the ruler selects a section that playback repeats; a double click on it, a right click on the ruler, its x
   * button or Alt+X clears it.
   */
  import { Flame, Maximize2, Plus, Repeat, X, ZoomIn, ZoomOut } from '@lucide/svelte';
  import { addShot, clips, clipView, project, shotsOf, ui } from '../../lib/state/project.svelte.ts';
  import { untrack } from 'svelte';
  import { frameIndexAt, frameTimeAt } from '../../lib/video/frames.ts';
  import { lacks } from '../../lib/state/missing.ts';
  import { motionFlags } from '../../lib/solver/motion.ts';
  import UseToggle from '../UseToggle.svelte';
  import { value } from '../../lib/solver/field.ts';

  let { time, clipId, frames, ongo, loop = $bindable(null) }: {
    time: number; clipId: Id | null; frames: number[] | undefined;
    ongo: (clipId: Id, t: number, sightingId?: Id) => void;
    /** The section playback repeats, in seconds of the clip. */
    loop?: { a: number; b: number } | null;
  } = $props();

  const clip = $derived(clips.list.find((c) => c.id === clipId));
  const d = $derived(clip?.durationS || 1);
  $effect(() => { if (clipId) strip(clipId, d); });

  // the visible part of the clip, in seconds. A clip opens on the part last seen, or all of it.
  let view = $state({ a: 0, b: 1 });
  $effect(() => { const id = clipId, all = { a: 0, b: d }; view = untrack(() => (id && ui.clipViews[id]?.zoom) || all); });
  const span = $derived(view.b - view.a);
  const zoomed = $derived(span < d - 1e-6);
  let width = $state(0);
  let rulerEl: HTMLElement;
  const pxPerS = $derived(width / span);
  const x = (t: number) => `${((t - view.a) / span) * 100}%`;
  const inView = (t: number) => t >= view.a - span * 0.02 && t <= view.b + span * 0.02;

  const MIN_SPAN = 0.05;
  function setView(a: number, b: number) {
    const s = Math.max(MIN_SPAN, Math.min(d, b - a));
    a = Math.max(0, Math.min(d - s, a));
    view = { a, b: a + s };
    if (clipId) clipView(clipId).zoom = s < d - 1e-6 ? { ...view } : undefined;
  }
  const zoomAt = (t: number, k: number) => setView(t - (t - view.a) * k, t + (view.b - t) * k);

  // a playhead that moves out of the zoomed view (playing, or a jump) turns the page. Only a new time does this, so
  // a zoom or a pan away from the playhead stays where the user put it.
  $effect(() => {
    const t = time;
    untrack(() => { if (zoomed && (t > view.b || t < view.a)) setView(t - span * 0.1, t + span * 0.9); });
  });

  // the film strip: tiles of the thumbnail width, fixed in time so they do not swim during a pan. Each tile shows the
  // nearest thumbnail, so a deep zoom repeats pictures instead of stretching them. When the view rests, the frames of
  // the tiles that have no picture of their own get one.
  const tileW = $derived(Math.round(56 * ((clip?.width || 16) / (clip?.height || 9))));
  const tileS = $derived(tileW / pxPerS);
  const tiles = $derived.by(() => {
    if (!width || !clipId) return [];
    const out: { t: number; src?: string }[] = [];
    const list = strips[clipId] ?? [];
    for (let k = Math.floor(view.a / tileS); k * tileS < view.b; k++) {
      const t = Math.min(d, (k + 0.5) * tileS);
      out.push({ t: k * tileS, src: nearest(list, t)?.src });
    }
    return out;
  });
  let request = 0;
  $effect(() => {
    const id = clipId, a = view.a, b = view.b, step = tileS;
    if (!id || !width) return;
    const r = ++request;
    const timer = setTimeout(() => {
      const have = new Set((strips[id] ?? []).map((x) => x.t));
      const want = new Set<number>();
      for (let k = Math.floor(a / step); k * step < b; k++) want.add(frameTimeAt(frames, Math.min(d, (k + 0.5) * step)));
      addThumbs(id, [...want].filter((t) => !have.has(t)), () => r !== request);
    }, 300);
    return () => clearTimeout(timer);
  });

  // ruler ticks: a labeled major step at least 90 px apart, 5 minor steps between, and each frame when they fit
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

  const tAt = (e: PointerEvent | WheelEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return view.a + ((e.clientX - r.left) / r.width) * span;
  };
  const clamp = (t: number) => Math.max(0, Math.min(d, t));

  // scrubbing on the film strip and the lanes. A press on a lane also picks its shot.
  let scrubEl: HTMLElement | null = null;
  function scrubDown(e: PointerEvent, shotId?: Id) {
    if (e.button !== 0 || !clipId || (e.target as HTMLElement).closest('button')) return;
    scrubEl = e.currentTarget as HTMLElement;
    scrubEl.setPointerCapture(e.pointerId);
    if (shotId) ui.shotId = shotId;
    ongo(clipId, clamp(tAt(e, scrubEl)));
  }
  function scrubMove(e: PointerEvent) {
    if (scrubEl && clipId) ongo(clipId, clamp(tAt(e, scrubEl)));
  }

  // a drag on the ruler selects the section to repeat; a click seeks; a right click clears the section
  let range = $state<{ el: HTMLElement; from: number; to: number } | null>(null);
  function rulerDown(e: PointerEvent) {
    if (e.button === 2) { loop = null; return; }
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const t = clamp(tAt(e, el));
    range = { el, from: t, to: t };
  }
  function rulerMove(e: PointerEvent) {
    if (range) range.to = clamp(tAt(e, range.el));
  }
  function rulerUp() {
    if (!range) return;
    const [a, b] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
    if ((b - a) * pxPerS > 4) loop = { a, b };
    else if (clipId) ongo(clipId, range.to);
    range = null;
  }

  // the wheel zooms around the pointer, Shift or a sideways wheel pans. Not passive, so the page does not scroll.
  const wheel = (el: HTMLElement) => {
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const pan = e.shiftKey ? e.deltaY : e.deltaX;
      if (Math.abs(pan) > Math.abs(e.shiftKey ? 0 : e.deltaY)) setView(view.a + (pan / width) * span, view.b + (pan / width) * span);
      else zoomAt(clamp(tAt(e, rulerEl)), e.deltaY > 0 ? 1.25 : 0.8);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  };

  // sightings a step where the shell jumps leads to, for an outline on their keyframes
  const jumpy = $derived(new Set(motionFlags($state.snapshot(project)).map((f) => f.to)));
  // one lane per shot of this clip; the colors stay those of the whole project
  const lanes = $derived(new Set([...shotsOf(clipId).map((s) => s.id), ui.shotId]));
  const count = (shotId: Id) => project.sightings.filter((s) => s.shotId === shotId && s.clipId === clipId).length;
</script>

<div class="flex flex-col gap-1.5" data-testid="timeline">
  <div class="flex flex-wrap items-center gap-1.5">
    <div class="flex min-w-0 flex-1 flex-wrap gap-1" role="group" aria-label="Clips">
      {#each clips.list as c (c.id)}
        <button
          class="option max-w-56 truncate px-2 py-1 text-[12px]"
          aria-pressed={c.id === clipId}
          title={c.name}
          onclick={() => ongo(c.id, c.id === clipId ? time : 0)}
        >{c.name}</button>
      {/each}
    </div>
    <span class="num text-[11px] text-muted">{timecode(view.a, 2)} to {timecode(view.b, 2)}</span>
    <button class="btn icon sm" aria-label="Zoom out" title="Zoom out (wheel down)" onclick={() => zoomAt(time, 2)} disabled={!zoomed}><ZoomOut size={14} /></button>
    <button class="btn icon sm" aria-label="Zoom in" title="Zoom in (wheel up)" onclick={() => zoomAt(time, 0.5)}><ZoomIn size={14} /></button>
    {#if loop}<button class="btn sm" onclick={() => setView(loop!.a, loop!.b)} title="Show the repeated section"><Repeat size={13} /> Zoom to loop</button>{/if}
    <button class="btn sm" onclick={() => setView(0, d)} disabled={!zoomed} title="Show the whole clip"><Maximize2 size={13} /> Reset zoom</button>
  </div>

  <div class="relative grid grid-cols-[8rem_minmax(0,1fr)] border border-line" {@attach wheel}>
    <!-- ruler -->
    <span class="border-b border-r border-line"></span>
    <div
      class="relative h-7 cursor-text touch-none select-none overflow-hidden border-b border-line bg-panel"
      title="Drag to select a section that playback repeats. Double click it, right click here or press Alt+X to clear it."
      bind:clientWidth={width}
      bind:this={rulerEl}
      role="presentation"
      onpointerdown={rulerDown}
      onpointermove={rulerMove}
      onpointerup={rulerUp}
      onpointercancel={() => (range = null)}
      oncontextmenu={(e) => e.preventDefault()}
      ondblclick={(e) => { const t = tAt(e as unknown as PointerEvent, rulerEl); if (loop && t >= loop.a && t <= loop.b) loop = null; }}
    >
      {#each frameTicks as t}<span class="absolute bottom-0 h-1 w-px bg-line-strong opacity-60" style="left:{x(t)}"></span>{/each}
      {#each ticks as k (k.t)}
        <span class="absolute bottom-0 w-px {k.major ? 'h-3 bg-muted' : 'h-1.5 bg-line-strong'}" style="left:{x(k.t)}"></span>
        {#if k.major}<span class="num absolute top-0.5 pl-1 text-[10px] text-muted" style="left:{x(k.t)}">{timecode(k.t, dec)}</span>{/if}
      {/each}
      {#if loop}
        <span class="absolute inset-y-0 border-x-2 border-accent bg-accent/30" style="left:{x(loop.a)}; width:{((loop.b - loop.a) / span) * 100}%" data-testid="loop">
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
      role="slider"
      tabindex="-1"
      aria-label="Time in {clip?.name ?? 'clip'}"
      aria-valuenow={time}
      onpointerdown={(e) => scrubDown(e)}
      onpointermove={scrubMove}
      onpointerup={() => (scrubEl = null)}
      onpointercancel={() => (scrubEl = null)}
    >
      {#each tiles as tile (tile.t)}
        {#if tile.src}
          <img src={tile.src} alt="" draggable="false" class="pointer-events-none absolute inset-y-0 h-full max-w-none opacity-70" style="left:{x(tile.t)}; width:{tileW}px" />
        {:else}
          <span class="pointer-events-none absolute inset-y-0 border-r border-black/20" style="left:{x(tile.t)}; width:{tileW}px"></span>
        {/if}
      {/each}
      {#each ticks as k (k.t)}{#if k.major}<span class="pointer-events-none absolute inset-y-0 w-px bg-black/25" style="left:{x(k.t)}"></span>{/if}{/each}
    </div>

    <!-- one lane per shot -->
    {#each project.shots as sh, si (sh.id)}
      {#if lanes.has(sh.id)}
      {@const active = sh.id === ui.shotId}
      {@const color = shotColor(si)}
      {@const list = project.sightings.filter((s) => s.shotId === sh.id && s.clipId === clipId)}
      {@const impact = clipId ? value(sh.impact[clipId])?.b : undefined}
      <div class="flex min-w-0 items-center gap-1.5 border-b border-r border-line px-2 text-[12px] {active ? 'bg-[var(--accent-soft)] text-text' : 'text-muted'}" data-testid="lane-{si}">
        <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left {sh.excluded ? 'opacity-50' : ''}" onclick={() => (ui.shotId = sh.id)} title="Mark sightings for {sh.name}">
          <span class="h-2.5 w-2.5 shrink-0" style="background:{color}"></span>
          <span class="truncate">{sh.name}</span>
          <span class="num ml-auto text-[10px] text-muted">{count(sh.id)}</span>
        </button>
        <UseToggle target={sh} what="this shot" />
      </div>
      <div
        class="relative h-7 cursor-ew-resize touch-none select-none overflow-hidden border-b border-line {active ? 'bg-[var(--accent-soft)]' : ''}"
        role="presentation"
        onpointerdown={(e) => scrubDown(e, sh.id)}
        onpointermove={scrubMove}
        onpointerup={() => (scrubEl = null)}
        onpointercancel={() => (scrubEl = null)}
      >
        {#each ticks as k (k.t)}{#if k.major}<span class="pointer-events-none absolute inset-y-0 w-px bg-line opacity-60" style="left:{x(k.t)}"></span>{/if}{/each}
        {#if list.length && impact != null}
          <!-- the flight, from the first sighting to the impact -->
          {@const first = Math.min(...list.map((s) => s.timeS))}
          <span class="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 opacity-40" style="left:{x(first)}; width:{((impact - first) / span) * 100}%; background:{color}"></span>
        {/if}
        {#each list as s (s.id)}
          {#if inView(s.timeS)}
            {@const todo = lacks(s)}
            <button
              class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 {todo.length || jumpy.has(s.id) ? 'border-warn' : active ? 'border-black/70' : 'border-black/40'} {s.excluded || sh.excluded ? 'opacity-25' : active ? '' : 'opacity-50'}"
              style="left:{x(s.timeS)}; background:{value(s.shell) ? color : 'var(--panel-solid)'}"
              title="Sighting of {sh.name} at {s.timeS.toFixed(3)} s{todo.length ? `, still needs: ${todo.join(', ')}` : ''}{jumpy.has(s.id) ? ', the shell jumps to this frame' : ''}{s.excluded ? ', left out of the calculation' : ''}"
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
    <button class="flex items-center gap-1 border-r border-line px-2 py-1 text-[11.5px] text-muted hover:text-text" onclick={addShot} title="New shot: one shell and one crater"><Plus size={12} /> Shot</button>
    <span></span>
    <!-- the repeated section over the strip and the lanes -->
    {#if loop}
      <div class="pointer-events-none absolute inset-y-0 left-[8rem] right-0 overflow-hidden">
        <span class="absolute inset-y-0 border-x border-accent/60 bg-accent/10" style="left:{x(loop.a)}; width:{((loop.b - loop.a) / span) * 100}%"></span>
      </div>
    {/if}
    <!-- the playhead over the ruler, the strip and the lanes -->
    {#if time >= view.a && time <= view.b}
      <div class="pointer-events-none absolute inset-y-0 left-[8rem] right-0">
        <span class="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style="left:{x(time)}"></span>
        <span class="absolute top-0 h-2 w-2.5 -translate-x-1/2 bg-accent [clip-path:polygon(0_0,100%_0,50%_100%)]" style="left:{x(time)}"></span>
      </div>
    {/if}
  </div>
</div>
