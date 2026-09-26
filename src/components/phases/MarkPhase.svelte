<script lang="ts">
  import { untrack } from 'svelte';
  import ChevronsDownUp from '@jis3r/icons/icons/chevrons-down-up';
  import ChevronsUpDown from '@jis3r/icons/icons/chevrons-up-down';
  import Plus from '@jis3r/icons/icons/plus';
  import { Flame } from '@lucide/svelte';
  import Spinner from '../Spinner.svelte';
  import PlayerBar from '../mark/PlayerBar.svelte';
  import Viewer from '../mark/Viewer.svelte';
  import Magnifier from '../mark/Magnifier.svelte';
  import Timeline from '../mark/Timeline.svelte';
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
  import Dropdown from '../Dropdown.svelte';
  import SectionPanel from '../mark/SectionPanel.svelte';
  import StabView from '../mark/StabView.svelte';
  import { refToFrame } from '../../lib/vision/rotation.ts';
  import { focalPx } from '../../lib/solver/camera.ts';
  import { detectClipMap, detection, stopMapSearch, warmDetection } from '../../lib/state/detect.svelte.ts';
  import { frameIndexAt } from '../../lib/video/frames.ts';
  import { go as playerGo, player, playerFrames, playerSection, playerTime, stepBy as playerStep, togglePlay, usePlayer, video } from '../../lib/state/player.svelte.ts';
  import type { Id, Pt, Sighting } from '../../lib/solver/types.ts';

  // the other pages share the video, the frame on screen and playback (player.svelte.ts)
  usePlayer();
  const loaded = $derived(player.loaded);
  const frames = $derived(playerFrames());
  const loadError = $derived(player.loadError);
  const frameTime = $derived(player.frameTime);
  const frame = $derived(player.frame);
  const playing = $derived(player.playing);
  let hover = $state<Pt | null>(null);
  let lock = $state<Pt | null>(null); // a locked magnifier spot
  let pending = $state<Pt | null>(null); // first point of an edge

  const time = $derived(playerTime());
  const shot = $derived(currentShot());
  const sighting = $derived(loaded && loaded === ui.clipId ? sightingAt(loaded, frameTime) : undefined);
  // the sightings of the other shots on this frame, shown unless a mark is on its way
  const others = $derived(
    loaded && loaded === ui.clipId && !ui.tool && !pending
      ? project.sightings.filter((s) => s.clipId === loaded && s.shotId !== shot.id && sameFrame(s.timeS, frameTime))
      : [],
  );
  // any shot lands on this frame
  const impactHere = $derived(!!loaded && shotsOf(loaded).some((s) => { const i = value(s.impact[loaded!]); return !!i && sameFrame(i.b, frameTime); }));

  // the labels next to the marks of this frame, for the shot and for the other shots with their name
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

  // the section of the timeline that playback repeats (Timeline.svelte), for the loaded clip
  const section = $derived(playerSection());
  const setSection = (s?: { a: number; b: number } | null) => { if (loaded) clipView(loaded).loop = s ?? undefined; };
  // a locked magnifier spot belongs to the clip before
  $effect(() => { void ui.clipId; lock = null; });

  function go(clipId: Id, t: number, sightingId?: Id, exact = false) {
    pending = null;
    playerGo(clipId, t, sightingId, exact);
  }
  function stepBy(n: number) {
    if (!loaded) return;
    pending = null;
    playerStep(n);
  }

  let bar = $state<PlayerBar>();

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
    // a jump between sightings shows the frame itself, not its preview
    if (m) { video.pause(); go(loaded, m.t, m.id, true); }
  }

  /** Returns the sighting on this frame, and makes one if there is none yet. */
  function here(): Sighting | null {
    // the video on screen can still be the clip before a switch. Marks go only to a shot of that clip.
    if (!loaded || shot.clipId !== loaded) return null;
    const found = sightingAt(loaded, frameTime);
    if (found) return found;
    project.sightings.push(newSighting({ shotId: shot.id, clipId: loaded, timeS: frameTime, frameW: video.videoWidth, frameH: video.videoHeight }));
    const s = project.sightings.at(-1)!; // the reactive copy
    ui.sightingId = s.id;
    // the heading from the compass in the frame. The display shows whole degrees, so the error is uniform over one degree.
    const h = compassNow();
    s.heading.auto = h != null ? detected('heading', h, 1 / Math.sqrt(12)) : { conf: 0, reason: 'the compass reader is not sure of this frame' };
    return s;
  }

  // the compass heading of the frame on screen, for the toolbar. A reading takes about 10 ms at 4K, so it waits until
  // the frame is on screen, and none runs while the video plays. It is `undefined` while the reading is pending. A
  // second reading follows a moment later, because right after a seek, a browser can still draw the previous frame
  // into a canvas.
  let compass = $state<{ t: number; heading: number | null } | undefined>(undefined);
  $effect(() => {
    void frame;
    const t = frameTime;
    if (!loaded || playing) { compass = undefined; return; }
    compass = undefined;
    // the first reading can see the frame before the seek, so it only shows a heading. "No reading" waits for the
    // second one, which keeps the spinner on instead of flashing a dash.
    const read = (last: boolean) => {
      // mid-seek the video has no picture to read, and the canvas comes out empty. The end of the seek reads again.
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
  /** The compass heading of the frame on screen. It takes the reading of the toolbar for this frame, else it reads now. */
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
  // for the magnifier, L locks it, Z changes its zoom, and Ctrl with the arrows moves a locked spot (10 times as far
  // with Shift)
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
    else if (k === 'g') { e.preventDefault(); bar?.openGoTo(); }
    else if (k === 'l') lock = lock ? null : hover;
    else if (k === 'z') ui.magZoom = ZOOMS[(ZOOMS.indexOf(ui.magZoom) + 1) % ZOOMS.length];
    else if (k === 'escape') { ui.tool = null; pending = null; }
  }

  // for a clip without a map, the detection looks for one in the background, for the question above the video
  $effect(() => {
    if (loaded && project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]) untrack(() => detectClipMap(loaded!, duration));
    else if (loaded) untrack(warmDetection);
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
              <!-- the video stays on the page in every view, because a browser stops decoding a video that nobody can see -->
              <div class="relative min-w-0 {ui.view === 'stab' ? 'pointer-events-none absolute inset-0 opacity-0' : ''}">
                <Viewer {video} {frame} {sighting} {others} copied={guides} impact={impactHere} detection={detectionOverlay} {pending} {lock} {notes} tool={!!ui.tool} onpoint={place} onhover={(p) => (hover = p)} ondrag={drag} onmiddle={(p) => (lock = lock ? null : p)} onremove={removeMark} />
              </div>
              {#if ui.view !== 'video'}<div class="relative min-w-0"><StabView {video} {frame} time={frameTime} section={shotSection} /></div>{/if}
              <!-- the question for the map, when the marking of a clip starts (automation plan section 4) -->
              <!-- the question stays until the user picks. The detected map only goes first. -->
              {#if project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]}
                <MapChooser big value={undefined} auto={project.clips[loaded]?.map.auto} searching={detection.searching === loaded}
                  onpick={(m) => { clipInfo(loaded!).map.manual = m; stopMapSearch(loaded!); }} onskip={() => { ui.mapAsked[loaded!] = true; stopMapSearch(loaded!); }} />
              {/if}
            </div>
          {:else}
            <p class="m-0 flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading the clip...</p>
          {/if}
        </div>
        <PlayerBar bind:this={bar} {duration} onstep={stepBy} ongo={(t) => loaded && go(loaded, t)}
          jump={{ go: jump, enabled: !!marks.length, what: `sighting or impact of ${shot.name}` }}>
          {#snippet left()}
            <div class="flex gap-px" role="group" aria-label="View" title="The video, or the stabilized view of the detection. The stabilized view turns the frames into the reference camera of the detection.">
              {#each VIEWS as [v, label]}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.view === v} onclick={() => (ui.view = v)} data-testid="view-{v}">{label}</button>{/each}
            </div>
            {#if shotSection}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.cv} onclick={() => (ui.cv = !ui.cv)} data-testid="view-cv" title="Draws the detection on the video. It shows the horizon and headings of the detected camera, the shell track of the section, and the impact. It also shows the HUD parts that the detection reads, and how sure the rotation of this frame is.">Detection</button>{/if}
            {#if sighting}<span class="tag accent">Sighting on this frame</span>{/if}
          {/snippet}
        </PlayerBar>
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
          <header class="card-head min-h-0 py-1.5"><h2 class="card-title text-[11px]" title="Backtrack finds the shell, the camera, the impact and the sighting position in the section of the timeline">Detection of {shot.name}</h2></header>
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
          <span class={shotSightings.length ? '' : 'ml-auto'}>
            <Dropdown label="Shot" testid="shot-select" value={ui.shotId ?? ''} onchange={(v) => (ui.shotId = v)}
              options={project.shots.filter((s) => s.id === shot.id || clipShots.includes(s)).map((s): [string, string] => [s.id, s.name])} />
          </span>
          <button class="btn icon sm" onclick={addShot} title="A new shot, with one shell and one crater" aria-label="New shot"><Plus size={13} /></button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-2"><SightingList ongo={go} /></div>
      </section>
    </aside>
  </div>
{/if}
