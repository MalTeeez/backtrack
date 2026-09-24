<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsDownUp, ChevronsUpDown, Flame, Pause, Play, Plus, SkipBack, SkipForward } from '@lucide/svelte';
  import Spinner from '../Spinner.svelte';
  import Key from '../Key.svelte';
  import Viewer from '../mark/Viewer.svelte';
  import Magnifier from '../mark/Magnifier.svelte';
  import Timeline, { timecode } from '../mark/Timeline.svelte';
  import MarkToolbar from '../mark/MarkToolbar.svelte';
  import SightingList, { allFolded, foldAll } from '../mark/SightingList.svelte';
  import { markNotes, type Handle, type MarkTarget } from '../mark/draw.ts';
  import { SightingSolver } from '../../lib/solver/sightings.ts';
  import { shellSpeeds } from '../../lib/solver/motion.ts';
  import { readVideoCompass, readVideoCompassRaw } from '../../lib/video/compassRead.ts';
  import { MIN_CORR, MIN_MARGIN } from '../../lib/video/compass.ts';
  import { addShot, clips, currentShot, fixShot, project, sameFrame, shotsOf, sightingAt, uid, ui } from '../../lib/state/project.svelte.ts';
  import { clipFrames, clipUrl } from '../../lib/state/persistence.ts';
  import { frameIndexAt, frameTimeAt, seekTimeFor } from '../../lib/video/frames.ts';
  import type { Id, Pt, Sighting } from '../../lib/solver/types.ts';
  import { seek, stepFrames } from '../../lib/video/frameStepper.ts';
  import { fixDuration } from '../../lib/video/webmDuration.ts';

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  let loaded = $state<Id | null>(null);
  let frames = $state.raw<number[] | undefined>(); // presentation time of every frame of the loaded clip
  let loadError = $state('');
  let frameTime = $state(0); // presentation time of the frame on screen
  let scrub = $state<number | null>(null); // where a running seek goes, so the playhead follows the pointer at once
  let frame = $state(0); // goes up by one for every new picture on the screen
  let playing = $state(false);
  // playback speed; a new clip resets playbackRate to defaultPlaybackRate, so both change
  const SPEEDS = [0.25, 0.5, 0.75, 1, 2];
  let speed = $state(1);
  $effect(() => { video.defaultPlaybackRate = video.playbackRate = speed; });
  let hover = $state<Pt | null>(null);
  let lock = $state<Pt | null>(null); // a locked magnifier spot
  let pending = $state<Pt | null>(null); // first point of an edge

  const time = $derived(scrub ?? frameTime);
  const shot = $derived(currentShot());
  const sighting = $derived(loaded && loaded === ui.clipId ? sightingAt(loaded, frameTime) : undefined);
  // the sightings of the other shots on this frame, shown unless a mark is on its way
  const others = $derived(
    loaded && loaded === ui.clipId && !ui.tool && !pending
      ? project.sightings.filter((s) => s.clipId === loaded && s.shotId !== shot.id && sameFrame(s.timeS, frameTime))
      : [],
  );
  // a sighting with the camera of an earlier one: the earlier sighting with its own camera, whose edges it uses
  const source = $derived.by(() => {
    if (!sighting?.sameCameraAsPrevious) return null;
    const s = sighting;
    return project.sightings
      .filter((x) => x.clipId === s.clipId && x.timeS < s.timeS && !x.sameCameraAsPrevious && x.edges.length)
      .sort((a, b) => b.timeS - a.timeS)[0] ?? null;
  });
  /** The name of a sighting as the list shows it: its number within its shot, and the shot when it is another one. */
  function sightingName(x: Sighting) {
    const order = new Map(clips.list.map((c, i) => [c.id, i]));
    const list = project.sightings
      .filter((y) => y.shotId === x.shotId)
      .sort((a, b) => (a.clipId === b.clipId ? a.timeS - b.timeS : (order.get(a.clipId) ?? 0) - (order.get(b.clipId) ?? 0)));
    const n = `Sighting ${list.findIndex((y) => y.id === x.id) + 1}`;
    return x.shotId === shot.id ? n : `${project.shots.find((y) => y.id === x.shotId)?.name ?? 'Other shot'}, ${n.toLowerCase()}`;
  }
  // any shot lands on this frame
  const impactHere = $derived(!!loaded && project.shots.some((s) => s.impactTimeS[loaded!] != null && sameFrame(s.impactTimeS[loaded!], frameTime)));

  // the labels next to the marks of this frame: those of the shot, and those of the other shots with their name
  const notes = $derived.by(() => {
    void frame;
    const data = $state.snapshot(project), solver = new SightingSolver(data), size = { w: video.videoWidth, h: video.videoHeight };
    const speeds = shellSpeeds(data, solver);
    const of = (s: Sighting | undefined, p: Pt | null) => {
      const snap = s && $state.snapshot(s);
      return markNotes(s, p, size, project.settings, snap ? solver.aim(snap) : null, snap ? solver.solve(snap) : null, s && speeds.get(s.id));
    };
    const name = (id: Id) => project.shots.find((x) => x.id === id)?.name ?? 'Other shot';
    // the copied edges: labels without a remove button, which say where they come from
    const copiedNotes = source
      ? markNotes({ ...$state.snapshot(source), shell: undefined }, null, size, project.settings, null, null).map((n) => ({
          ...n, fixed: true, from: { short: 'from prev', long: `Copied with the camera of ${sightingName(source)} at ${source.timeS.toFixed(3)} s` },
        }))
      : [];
    return [...of(sighting, pending), ...copiedNotes, ...others.flatMap((o) => of(o, null).map((n) => ({ ...n, title: `${name(o.shotId)}: ${n.title}`, fixed: true })))];
  });

  // Recordings have no fixed frame rate. The frame list of the clip (prepareClip.ts) gives the start time of the frame
  // on screen, in every browser.
  const shown = () => { frameTime = frameTimeAt(frames, video.currentTime); frame++; };
  video.addEventListener('seeked', shown);
  video.addEventListener('loadeddata', shown);
  video.addEventListener('pause', () => { playing = false; shown(); });
  // the section of the timeline that playback repeats (Timeline.svelte), for the loaded clip
  let section = $state<{ a: number; b: number } | null>(null);
  // a section belongs to one clip
  $effect(() => { void loaded; section = null; });
  video.addEventListener('play', () => {
    playing = true;
    // playback starts inside the section, and goes back to its start at its end
    if (section && (video.currentTime < section.a || video.currentTime >= section.b)) video.currentTime = seekTimeFor(section.a);
    const tick = () => {
      if (!playing) return;
      if (section && video.currentTime >= section.b) video.currentTime = seekTimeFor(section.a);
      shown();
      requestAnimationFrame(tick);
    };
    tick();
  });
  $effect(() => () => { video.pause(); video.removeAttribute('src'); });

  // A seek takes a moment, and a drag on the timeline asks for many. Only the newest target counts, so the queue
  // skips targets that a later one replaced. A playing video keeps playing from the new place.
  let target: number | null = null;
  let seeking = false;
  async function seekTo(t: number) {
    scrub = target = Math.max(0, t);
    if (seeking) return;
    seeking = true;
    while (target != null) {
      const next: number = target;
      target = null;
      await seek(video, seekTimeFor(next));
    }
    seeking = false;
    scrub = null;
  }

  // load the selected clip
  let wanted: { t: number; sightingId?: Id; play: boolean } | null = null;
  $effect(() => {
    const id = ui.clipId;
    if (!id || id === loaded) return;
    let stale = false;
    loadError = '';
    lock = null; // a locked magnifier spot belongs to the clip before
    (async () => {
      // the frame list comes first: preparing an older clip replaces its video
      const list = await clipFrames(id);
      const url = await clipUrl(id);
      if (stale) return;
      frames = list;
      if (!url) { loadError = 'The video of this clip is missing.'; return; }
      video.src = url;
      await new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error('This browser cannot play this video.')); });
      await fixDuration(video);
      if (stale) return;
      loaded = id;
      await seek(video, seekTimeFor(wanted?.t ?? 0));
      frameTime = frameTimeAt(frames, video.currentTime);
      if (wanted?.sightingId) ui.sightingId = wanted.sightingId;
      if (wanted?.play) video.play();
      wanted = null;
    })().catch((e) => (loadError = e.message));
    return () => { stale = true; };
  });

  function go(clipId: Id, t: number, sightingId?: Id) {
    pending = null;
    if (sightingId) ui.sightingId = sightingId;
    if (clipId !== loaded) { wanted = { t, sightingId, play: playing }; ui.clipId = clipId; return; }
    seekTo(t);
  }

  function togglePlay() {
    if (!loaded) return;
    if (video.paused) video.play();
    else video.pause();
  }
  let stepping = false;
  async function stepBy(n: number) {
    if (!loaded || stepping || seeking) return;
    stepping = true;
    video.pause();
    pending = null;
    try {
      frameTime = await stepFrames(video, frames, n, frameTime);
    } finally {
      stepping = false;
    }
  }

  // the timecode turns into a field that jumps to a time or a frame
  let goingTo = $state<string | null>(null);
  const openGoTo = () => (goingTo = timecode(time));
  /** A time (m:ss.mmm or seconds) or a frame number (#469, f469, 1-based), as seconds of the clip. Null if unclear. */
  function parseGoTo(text: string): number | null {
    const t = text.trim().toLowerCase();
    const frame = /^(?:#|f|frame\s*)(\d+)$/.exec(t);
    if (frame) return frames?.length ? frames[Math.max(0, Math.min(frames.length - 1, Number(frame[1]) - 1))] : null;
    const clock = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
    return clock ? Number(clock[1] ?? 0) * 60 + Number(clock[2]) : null;
  }
  function goTo(text: string) {
    const t = parseGoTo(text);
    goingTo = null;
    if (t == null || !loaded) return;
    video.pause();
    go(loaded, Math.max(0, Math.min(duration, t)));
  }

  /**
   * Jumps to the previous or next sighting of the current shot in this clip, or its impact. Sightings of the frame on
   * screen do not count, so repeated presses walk through them.
   */
  const marks = $derived(
    loaded ? [...project.sightings.filter((s) => s.shotId === shot.id && s.clipId === loaded).map((s) => ({ t: s.timeS, id: s.id as Id | undefined })),
      ...(shot.impactTimeS[loaded] != null ? [{ t: shot.impactTimeS[loaded], id: undefined }] : [])].sort((a, b) => a.t - b.t) : [],
  );
  function jump(dir: -1 | 1) {
    if (!loaded) return;
    const m = dir > 0 ? marks.find((x) => x.t > time && !sameFrame(x.t, time)) : marks.filter((x) => x.t < time && !sameFrame(x.t, time)).at(-1);
    if (m) { video.pause(); go(loaded, m.t, m.id); }
  }

  /** Returns the sighting on this frame, and makes one if there is none yet. */
  function here(): Sighting | null {
    // the video on screen may still be the clip before a switch: marks go only to a shot of that clip
    if (!loaded || shot.clipId !== loaded) return null;
    const found = sightingAt(loaded, frameTime);
    if (found) return found;
    project.sightings.push({
      id: uid(), shotId: shot.id, clipId: loaded, timeS: frameTime,
      frameW: video.videoWidth, frameH: video.videoHeight,
      edges: [], sameCameraAsPrevious: false,
    });
    const s = project.sightings.at(-1)!; // the reactive copy
    ui.sightingId = s.id;
    // the heading from the compass in the frame, once; after that it is the user's to change
    const h = compassNow();
    if (h != null) s.headingDeg = h;
    return s;
  }

  // the compass heading of the frame on screen, for the toolbar. A reading takes about 10 ms at 4K, so it waits until
  // the frame is on screen, and none runs while the video plays. `undefined` while it is pending. It reads a second
  // time a moment later: right after a seek, a browser can still draw the frame before it into a canvas.
  let compass = $state<{ t: number; heading: number | null } | undefined>(undefined);
  $effect(() => {
    void frame;
    const t = frameTime;
    if (!loaded || playing) { compass = undefined; return; }
    compass = undefined;
    // the first reading may see the frame before the seek, so it only shows a heading; "no reading" waits for the
    // second one, which keeps the spinner on instead of flashing a dash
    const read = (last: boolean) => {
      // mid-seek the video has no picture to read (the canvas comes out empty): the end of the seek reads again
      if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const raw = readVideoCompassRaw(video), heading = raw?.sure?.heading ?? null;
      if (heading != null || last) compass = { t, heading };
      // a failed reading goes to the console with what the reader saw, to improve the reader
      if (heading == null && last) {
        console.info('[compass] no reading', {
          frameTime: t, frame: frames?.length ? frameIndexAt(frames, t) + 1 : undefined, videoTime: video.currentTime,
          size: `${video.videoWidth}x${video.videoHeight}`,
          guess: raw?.guess ? { heading: raw.guess.heading, corr: +raw.guess.corr.toFixed(3), margin: +raw.guess.margin.toFixed(3) } : null,
          limits: { corr: MIN_CORR, margin: MIN_MARGIN },
        });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = setTimeout(() => read(true), 250);
    const raf = requestAnimationFrame(() => { timer = setTimeout(() => read(false)); });
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); clearTimeout(again); };
  });
  /** The compass heading of the frame on screen: the toolbar's reading when it is for this frame, else read now. */
  function compassNow() {
    if (compass && sameFrame(compass.t, frameTime)) return compass.heading;
    return readVideoCompass(video)?.heading ?? null;
  }

  const round = (p: Pt): Pt => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

  function place(raw: Pt) {
    if (!ui.tool || playing) return;
    const p = round(raw);
    if (ui.tool === 'edge' && !pending) { pending = p; return; }
    const s = here();
    if (!s) return;
    if (ui.tool === 'shell') s.shell = p;
    else { s.edges.push([pending!, p]); pending = null; }
  }

  /** Moves a mark that the user drags in the video or the magnifier. */
  function drag(h: Handle, raw: Pt) {
    if (!sighting || playing) return;
    if (h.kind === 'shell') sighting.shell = round(raw);
    else sighting.edges[h.i][h.j] = round(raw);
  }

  /** Removes a mark from the button on its label. */
  function removeMark(t: MarkTarget) {
    if (t.kind === 'pending') pending = null;
    else if (!sighting) return;
    else if (t.kind === 'shell') sighting.shell = undefined;
    else sighting.edges.splice(t.i, 1);
  }

  function markImpact() {
    if (!loaded || shot.clipId !== loaded) return;
    const t = shot.impactTimeS[loaded];
    if (t != null && sameFrame(t, frameTime)) delete shot.impactTimeS[loaded];
    else shot.impactTimeS[loaded] = frameTime;
  }
  function clearMarks() {
    if (!sighting) return;
    sighting.shell = undefined;
    sighting.edges = [];
    pending = null;
  }
  // a clip shows only its own shots, so a switch to another clip also switches to one of its shots, or to a new one
  const clipShots = $derived(shotsOf(ui.clipId));
  $effect(() => {
    void ui.clipId;
    untrack(fixShot);
  });

  // keyboard shortcuts, never while an input has focus (plan section 10)
  // the magnifier: L locks it, Z changes its zoom, and Ctrl with the arrows moves a locked spot (Shift: 10 times)
  const ZOOMS = [4, 8, 16];
  let magZoom = $state(8);
  function nudgeLens(dx: number, dy: number) {
    const c = lock ?? hover;
    if (c) lock = { x: c.x + dx, y: c.y + dy };
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    // Alt+X clears the repeated section, as in video editors
    if (e.altKey && e.key.toLowerCase() === 'x') { e.preventDefault(); section = null; return; }
    if (e.altKey) return;
    const arrow = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[e.key.toLowerCase()];
    if ((e.ctrlKey || e.metaKey) && arrow) {
      e.preventDefault();
      const step = e.shiftKey ? 7.5 : 0.75;
      nudgeLens(arrow[0] * step, arrow[1] * step);
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const tool = { s: 'shell', v: 'edge' } as const;
    if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); jump(k === 'arrowup' ? -1 : 1); }
    else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); stepBy((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
    else if (k === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (k in tool) { ui.tool = ui.tool === tool[k as keyof typeof tool] ? null : tool[k as keyof typeof tool]; pending = null; }
    else if (k === 'i') markImpact();
    else if (k === 'g') { e.preventDefault(); openGoTo(); }
    else if (k === 'l') lock = lock ? null : hover;
    else if (k === 'z') magZoom = ZOOMS[(ZOOMS.indexOf(magZoom) + 1) % ZOOMS.length];
    else if (k === 'escape') { ui.tool = null; pending = null; }
  }

  const shotSightings = $derived(project.sightings.filter((s) => s.shotId === shot.id).map((s) => s.id));
  const duration = $derived(clips.list.find((c) => c.id === loaded)?.durationS ?? 0);
</script>

<svelte:window {onkeydown} />

{#if !clips.list.length}
  <div class="card flex h-full flex-col items-center justify-center gap-3 p-8">
    <span class="title text-[44px] text-muted-strong">Nothing to mark yet</span>
    <button class="btn primary" onclick={() => (ui.phase = 'record')}>Record or upload a clip</button>
  </div>
{:else}
  <div class="grid h-full min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_400px]">
    <div class="flex min-h-[70vh] min-w-0 flex-col gap-2">
      <section class="card shrink-0 border-[var(--accent-border)] p-2">
        <MarkToolbar {time} {sighting} compass={compass && sameFrame(compass.t, time) ? compass.heading : undefined} pending={!!pending} onimpact={markImpact} onclear={clearMarks} />
      </section>

      <section class="card flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1">
          {#if loadError}
            <p class="note bad m-3">{loadError}</p>
          {:else if loaded}
            <Viewer {video} {frame} {sighting} {others} copied={source?.edges ?? []} impact={impactHere} {pending} {lock} {notes} tool={!!ui.tool} onpoint={place} onhover={(p) => (hover = p)} ondrag={drag} onmiddle={(p) => (lock = lock ? null : p)} onremove={removeMark} />
          {:else}
            <p class="m-0 flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading the clip...</p>
          {/if}
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-line px-2 py-1.5">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <div class="flex flex-wrap gap-px" role="group" aria-label="Playback speed">
              {#each SPEEDS as sp}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={speed === sp} onclick={() => (speed = sp)} title="Play at {sp}x speed">{sp}x</button>{/each}
            </div>
            {#if sighting}<span class="tag accent">Sighting on this frame</span>{/if}
          </div>
          <!-- each button with its key caps under it -->
          <div class="flex items-start gap-1">
            {#snippet control(key: string, button: import('svelte').Snippet)}
              <div class="flex flex-col items-center gap-0.5">{@render button()}<Key k={key} /></div>
            {/snippet}
            {#snippet prev()}<button class="btn icon sm" onclick={() => jump(-1)} aria-label="Previous sighting" title="Previous sighting or impact of {shot.name}" disabled={!marks.length}><SkipBack size={14} /></button>{/snippet}
            {#snippet back10()}<button class="btn icon sm" onclick={() => stepBy(-10)} aria-label="Back 10 frames" title="Back 10 frames"><ChevronsLeft size={14} /></button>{/snippet}
            {#snippet back1()}<button class="btn icon sm" onclick={() => stepBy(-1)} aria-label="Back 1 frame" title="Back 1 frame"><ChevronLeft size={14} /></button>{/snippet}
            {#snippet play()}<button class="btn icon sm" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause">{#if playing}<Pause size={15} />{:else}<Play size={15} />{/if}</button>{/snippet}
            {#snippet fwd1()}<button class="btn icon sm" onclick={() => stepBy(1)} aria-label="Forward 1 frame" title="Forward 1 frame"><ChevronRight size={14} /></button>{/snippet}
            {#snippet fwd10()}<button class="btn icon sm" onclick={() => stepBy(10)} aria-label="Forward 10 frames" title="Forward 10 frames"><ChevronsRight size={14} /></button>{/snippet}
            {#snippet next()}<button class="btn icon sm" onclick={() => jump(1)} aria-label="Next sighting" title="Next sighting or impact of {shot.name}" disabled={!marks.length}><SkipForward size={14} /></button>{/snippet}
            {@render control('Up', prev)}
            {@render control('Shift+Left', back10)}
            {@render control('Left', back1)}
            {@render control('Space', play)}
            {@render control('Right', fwd1)}
            {@render control('Shift+Right', fwd10)}
            {@render control('Down', next)}
          </div>
          <div class="flex flex-col items-end leading-tight" data-testid="time" data-t={time} data-d={duration}>
            {#if goingTo != null}
              <!-- jump to a time (1:23.456 or 83.456) or a frame (#469 or f469) -->
              <input
                class="control num h-[33px] w-40 text-right text-[18px]" aria-label="Go to a time or a frame" data-testid="goto"
                title="A time, like 1:23.456 or 83.456, or a frame, like #469. Enter jumps, Escape cancels."
                bind:value={goingTo} {@attach (el: HTMLInputElement) => { el.focus(); el.select(); }}
                onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goTo(goingTo!); } else if (e.key === 'Escape') goingTo = null; }}
                onblur={() => (goingTo = null)}
              />
            {:else}
              <button class="num text-[22px] text-text hover:text-accent" onclick={openGoTo} title="Go to a time or a frame (G)">{timecode(time)}</button>
            {/if}
            <span class="num text-[11px] text-muted">
              {#if frames?.length}<button class="num hover:text-accent" onclick={() => (goingTo = `#${frameIndexAt(frames!, time) + 1}`)} title="Go to a frame (G)">frame {frameIndexAt(frames, time) + 1} / {frames.length}</button>{', '}{/if}{timecode(duration, 2)}
            </span>
          </div>
        </div>
      </section>

      <section class="card shrink-0">
        <header class="card-head min-h-0 py-1.5">
          <h2 class="card-title text-[11px]">Timeline</h2>
          <span class="card-meta">
            <span class="inline-block h-2 w-2 rotate-45 bg-shell"></span>sighting
            <Flame size={11} class="text-impact" />impact
            <span class="inline-block h-2 w-[3px] bg-edge"></span>edges
          </span>
        </header>
        <div class="max-h-[40vh] overflow-y-auto p-2"><Timeline {time} clipId={ui.clipId} {frames} ongo={go} bind:loop={section} /></div>
      </section>
    </div>

    <aside class="flex min-h-0 min-w-0 flex-col gap-2">
      <section class="card shrink-0 p-2">
        <Magnifier
          {video} {frame} center={lock ?? hover} locked={!!lock} {sighting} {pending} onpoint={place} ondrag={drag}
          onlock={() => (lock = lock ? null : hover)}
          onnudge={nudgeLens} bind:zoom={magZoom}
        />
      </section>
      <section class="card flex min-h-[260px] flex-1 flex-col">
        <header class="card-head gap-2">
          <h2 class="card-title">Sightings</h2>
          {#if shotSightings.length}
            {@const all = allFolded(shotSightings)}
            <button class="btn sm ml-auto" onclick={() => foldAll(shotSightings, !all)} data-testid="fold-all" title={all ? 'Expand all sightings' : 'Collapse all sightings'}>
              {#if all}<ChevronsUpDown size={13} /> Expand all{:else}<ChevronsDownUp size={13} /> Collapse all{/if}
            </button>
          {/if}
          <select class="control {shotSightings.length ? '' : 'ml-auto'} w-auto min-w-0 max-w-[45%]" bind:value={ui.shotId} aria-label="Shot" data-testid="shot-select">
            {#each project.shots.filter((s) => s.id === shot.id || clipShots.includes(s)) as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
          </select>
          <button class="btn icon sm" onclick={addShot} title="New shot: one shell and one crater" aria-label="New shot"><Plus size={13} /></button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-2"><SightingList ongo={go} /></div>
      </section>
    </aside>
  </div>
{/if}
