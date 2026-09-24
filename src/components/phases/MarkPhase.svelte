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
  import { detectionView, markNotes, type Handle, type MarkTarget } from '../mark/draw.ts';
  import { SightingSolver } from '../../lib/solver/sightings.ts';
  import { shellSpeeds } from '../../lib/solver/motion.ts';
  import { readVideoCompass, readVideoCompassRaw } from '../../lib/video/compassRead.ts';
  import { MIN_CORR, MIN_MARGIN } from '../../lib/video/compass.ts';
  import { addShot, clipInfo, clipMap, clips, clipView, currentShot, fixShot, newSighting, project, sameFrame, shotsOf, sightingAt, ui } from '../../lib/state/project.svelte.ts';
  import { detected, value } from '../../lib/solver/field.ts';
  import MapChooser from '../MapChooser.svelte';
  import SectionPanel from '../mark/SectionPanel.svelte';
  import StabView from '../mark/StabView.svelte';
  import { refToFrame } from '../../lib/vision/rotation.ts';
  import { focalPx } from '../../lib/solver/camera.ts';
  import { detectClipMap, detection, stopMapSearch } from '../../lib/state/detect.svelte.ts';
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
  $effect(() => { video.defaultPlaybackRate = video.playbackRate = ui.speed; });
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
  // any shot lands on this frame
  const impactHere = $derived(!!loaded && project.shots.some((s) => { const i = value(s.impact[loaded!]); return !!i && sameFrame(i.b, frameTime); }));

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
    return [...of(sighting, pending), ...others.flatMap((o) => of(o, null).map((n) => ({ ...n, title: `${name(o.shotId)}: ${n.title}`, fixed: true })))];
  });

  // Recordings have no fixed frame rate. The frame list of the clip (prepareClip.ts) gives the start time of the frame
  // on screen, in every browser.
  const shown = () => { frameTime = frameTimeAt(frames, video.currentTime); frame++; };
  video.addEventListener('seeked', shown);
  video.addEventListener('loadeddata', shown);
  video.addEventListener('pause', () => { playing = false; shown(); });
  // the section of the timeline that playback repeats (Timeline.svelte), for the loaded clip
  const section = $derived((loaded && ui.clipViews[loaded]?.loop) || null);
  const setSection = (s?: { a: number; b: number } | null) => { if (loaded) clipView(loaded).loop = s ?? undefined; };
  // the frame on screen, kept while paused, so the clip opens on it again (after a phase change or a reload)
  $effect(() => {
    const t = frameTime;
    if (loaded && !playing) untrack(() => clipView(loaded!)).t = t;
  });
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
  $effect(() => () => { if (loaded) clipView(loaded).t = frameTime; video.pause(); video.removeAttribute('src'); });

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
      await seek(video, seekTimeFor(wanted?.t ?? ui.clipViews[id]?.t ?? 0));
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
      ...(value(shot.impact[loaded]) ? [{ t: value(shot.impact[loaded])!.b, id: undefined }] : [])].sort((a, b) => a.t - b.t) : [],
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
    project.sightings.push(newSighting({ shotId: shot.id, clipId: loaded, timeS: frameTime, frameW: video.videoWidth, frameH: video.videoHeight }));
    const s = project.sightings.at(-1)!; // the reactive copy
    ui.sightingId = s.id;
    // the heading from the compass in the frame: the display shows whole degrees, so it is uniform over one degree
    const h = compassNow();
    s.heading.auto = h != null ? detected('heading', h, 1 / Math.sqrt(12)) : { conf: 0, reason: 'the compass reader is not sure of this frame' };
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
    if (ui.tool === 'shell') s.shell.manual = p;
    else { s.edges.push([pending!, p]); pending = null; }
  }

  /** Moves a mark that the user drags in the video or the magnifier. */
  function drag(h: Handle, raw: Pt) {
    if (!sighting || playing) return;
    if (h.kind === 'shell') sighting.shell.manual = round(raw);
    else sighting.edges[h.i][h.j] = round(raw);
  }

  /** Removes a mark from the button on its label. */
  function removeMark(t: MarkTarget) {
    if (t.kind === 'pending') pending = null;
    else if (!sighting) return;
    // the user's mark goes first, then the automatic one
    else if (t.kind === 'shell') { if (sighting.shell.manual) sighting.shell.manual = undefined; else sighting.shell.auto = undefined; }
    else sighting.edges.splice(t.i, 1);
  }

  /**
   * The user marks the first frame that shows the impact. The impact happened between the frame before it and this
   * one, and the solver takes the middle (automation plan section 9).
   */
  function markImpact() {
    if (!loaded || shot.clipId !== loaded) return;
    shot.impact[loaded] ??= {};
    const f = shot.impact[loaded]; // the reactive copy
    if (f.manual && sameFrame(f.manual.b, frameTime)) f.manual = undefined;
    else f.manual = { a: frames?.length ? frames[Math.max(0, frameIndexAt(frames, frameTime) - 1)] : frameTime - 1 / 60, b: frameTime };
  }
  function clearMarks() {
    if (!sighting) return;
    sighting.shell = {};
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
  function nudgeLens(dx: number, dy: number) {
    const c = lock ?? hover;
    if (c) lock = { x: c.x + dx, y: c.y + dy };
  }

  function onkeydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    // Alt+X clears the repeated section, as in video editors
    if (e.altKey && e.key.toLowerCase() === 'x') { e.preventDefault(); setSection(null); return; }
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
    else if (k === 'z') ui.magZoom = ZOOMS[(ZOOMS.indexOf(ui.magZoom) + 1) % ZOOMS.length];
    else if (k === 'escape') { ui.tool = null; pending = null; }
  }

  // the map of a clip that has none: found in the background, for the question above the video
  $effect(() => {
    if (loaded && project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]) untrack(() => detectClipMap(loaded!, duration));
  });

  // the detection of this shot in this clip, and the vertical lines of its pitch in the frame on screen
  const shotSection = $derived(loaded ? project.clips[loaded]?.sections?.find((s) => s.shotId === shot.id) : undefined);
  const guides = $derived.by((): [Pt, Pt][] => {
    const R = shotSection?.frames.find((f) => sameFrame(f.t, frameTime))?.R;
    if (!R || !shotSection) return [];
    const w = video.videoWidth, h = video.videoHeight, st = project.settings;
    const K = { f: focalPx(w, h, st.fovDeg, st.fovAxis), cx: w / 2 - 0.5, cy: h / 2 - 0.5 };
    return shotSection.lines.map(([x1, y1, x2, y2]) => [refToFrame(K, R, { x: x1, y: y1 }), refToFrame(K, R, { x: x2, y: y2 })]);
  });
  const detectionOverlay = $derived(ui.cv && shotSection && video.videoWidth ? detectionView(shotSection, frameTime, video.videoWidth, video.videoHeight, project.settings) : null);
  const VIEWS = [['video', 'Video'], ['stab', 'Stabilized'], ['both', 'Both']] as const;

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
            <div class="relative grid h-full {ui.view === 'both' ? 'grid-cols-2 gap-1' : ''}">
              <!-- the video stays on the page in every view: a browser stops decoding a video nobody can see -->
              <div class="relative min-w-0 {ui.view === 'stab' ? 'pointer-events-none absolute inset-0 opacity-0' : ''}">
                <Viewer {video} {frame} {sighting} {others} copied={guides} impact={impactHere} detection={detectionOverlay} {pending} {lock} {notes} tool={!!ui.tool} onpoint={place} onhover={(p) => (hover = p)} ondrag={drag} onmiddle={(p) => (lock = lock ? null : p)} onremove={removeMark} />
              </div>
              {#if ui.view !== 'video'}<div class="relative min-w-0"><StabView {video} {frame} time={frameTime} section={shotSection} /></div>{/if}
              <!-- the map, asked when marking of a clip starts (automation plan section 4) -->
              <!-- the question stays until the user picks: the detected map only goes first -->
              {#if project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]}
                <MapChooser big value={undefined} auto={project.clips[loaded]?.map.auto} searching={detection.running?.clipId === loaded && !detection.running.shotId}
                  onpick={(m) => { clipInfo(loaded!).map.manual = m; stopMapSearch(loaded!); }} onskip={() => { ui.mapAsked[loaded!] = true; stopMapSearch(loaded!); }} />
              {/if}
            </div>
          {:else}
            <p class="m-0 flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading the clip...</p>
          {/if}
        </div>
        <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-line px-2 py-1.5">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <div class="flex flex-wrap gap-px" role="group" aria-label="Playback speed">
              {#each SPEEDS as sp}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.speed === sp} onclick={() => (ui.speed = sp)} title="Play at {sp}x speed">{sp}x</button>{/each}
            </div>
            <div class="flex gap-px" role="group" aria-label="View" title="The video, or the stabilized view of the detection: the frames turned into its reference camera">
              {#each VIEWS as [v, label]}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.view === v} onclick={() => (ui.view = v)} data-testid="view-{v}">{label}</button>{/each}
            </div>
            {#if shotSection}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.cv} onclick={() => (ui.cv = !ui.cv)} data-testid="view-cv" title="On the video: the horizon and headings of the detected camera, the shell track of the section, the impact, the HUD parts the detection reads, and how sure the rotation of this frame is">Detection</button>{/if}
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
        <div class="max-h-[40vh] overflow-y-auto p-2"><Timeline {time} clipId={ui.clipId} {frames} ongo={go} bind:loop={() => section, setSection} /></div>
      </section>
    </div>

    <aside class="flex min-h-0 min-w-0 flex-col gap-2">
      <section class="card shrink-0 p-2">
        <Magnifier
          {video} {frame} center={lock ?? hover} locked={!!lock} {sighting} {pending} onpoint={place} ondrag={drag}
          onlock={() => (lock = lock ? null : hover)}
          onnudge={nudgeLens} bind:zoom={ui.magZoom}
        />
      </section>
      {#if loaded}
        <section class="card shrink-0">
          <header class="card-head min-h-0 py-1.5"><h2 class="card-title text-[11px]" title="Backtrack finds the shell, the camera, the impact and where you stood in the section of the timeline">Detection of {shot.name}</h2></header>
          <div class="card-body p-2"><SectionPanel clipId={loaded} loop={section} ongo={(t) => { video.pause(); go(loaded!, t); }} /></div>
        </section>
      {/if}
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
