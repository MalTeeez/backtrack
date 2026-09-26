<script lang="ts">
  /**
   * The page of the automatic flow (docs/review-plan.md) floats the video and the timeline in the middle, where the
   * user marks the shot sections. Each window can also attach, as on the Review page. Meanwhile, the Clip details window shows what the app finds in the background, which
   * is the map and whether the FOV fits the turns of the camera. The Process button detects the section of every shot
   * and opens Review, which fills in as the detections finish.
   */
  import { untrack } from 'svelte';
  import TriangleAlert from '@jis3r/icons/icons/triangle-alert';
  import X from '@jis3r/icons/icons/x';
  import PencilLine from '@jis3r/icons/icons/pencil-line';
  import ArrowRight from '@jis3r/icons/icons/arrow-right';
  import ArrowLeft from '@jis3r/icons/icons/arrow-left';
  import LayoutDashboard from '@jis3r/icons/icons/layout-dashboard';
  import { Info } from '@lucide/svelte';
  import Dock, { type WinMeta } from '../dock/Dock.svelte';
  import { stack, withWindows, type Layout } from '../../lib/dock/layout.ts';
  import Viewer from '../mark/Viewer.svelte';
  import PlayerBar from '../mark/PlayerBar.svelte';
  import Timeline, { shotColor } from '../mark/Timeline.svelte';
  import MapChooser from '../MapChooser.svelte';
  import Timecode from '../Timecode.svelte';
  import { clipBlob } from '../../lib/state/persistence.ts';
  import { frameTiming, mediaInfo, type MediaInfo } from '../../lib/video/mediaInfo.ts';
  import Spinner from '../Spinner.svelte';
  import { openSettings } from '../SettingsDialog.svelte';
  import { ICONS } from '../../lib/icons.ts';
  import { MAPS } from '../../lib/map/tiles.svelte.ts';
  import { go, player, playerDuration, playerFrames, playerSection, playerTime, stepBy, togglePlay, usePlayer, video } from '../../lib/state/player.svelte.ts';
  import { addShotTo, clipInfo, clipMap, clipView, clips, project, shotsOf, ui } from '../../lib/state/project.svelte.ts';
  import { checkFov, detectAll, detectClipMap, detection, fovVerdict, stopMapSearch, warmDetection, type Job } from '../../lib/state/detect.svelte.ts';
  import { prefs, setPrefs } from '../../lib/state/prefs.svelte.ts';
  import type { MapId } from '../../lib/solver/types.ts';

  /** `batch` is the clips that the Process button detects together. `onback` goes back to the choice of the flow. */
  let { batch, onback }: { batch: string[]; onback: () => void } = $props();
  /** A section counts unless the user left its shot out with the eye. That section waits for a later run. */
  const counts = (p: { shotId?: string }) => !project.shots.find((s) => s.id === p.shotId)?.excluded;
  // The sections to detect in the clips of the batch, and the clips they lie in. The timeline switches between the clips of the batch.
  const todo = $derived(batch.flatMap((id) => project.clips[id]?.pending?.filter(counts).map(() => id) ?? []));
  const ready = $derived([...new Set(todo)]);
  const processLabel = $derived(!todo.length ? 'Process shots'
    : `Process ${todo.length} ${todo.length === 1 ? 'shot' : 'shots'}${ready.length > 1 ? ` in ${ready.length} clips` : ''}`);
  usePlayer();
  const loaded = $derived(player.loaded);
  const clipId = $derived(ui.clipId);
  const clip = $derived(clips.list.find((c) => c.id === clipId));
  const selection = $derived(playerSection());
  // the section tool draws shot sections on the timeline. When it is off, a drag on the timeline scrubs.
  let sectionTool = $state(true);
  let bar = $state<PlayerBar>();
  const setSelection = (s?: { a: number; b: number } | null) => { if (loaded) clipView(loaded).loop = s ?? undefined; };
  const map = $derived(clipId ? project.clips[clipId]?.map : undefined);
  const pending = $derived((clipId ? project.clips[clipId]?.pending : undefined) ?? []);
  const fov = $derived(clipId ? detection.fov[clipId] : undefined);
  const verdict = $derived(fovVerdict(fov));

  // while the user marks, the app finds the map from the minimap and checks the FOV on the first marked section
  $effect(() => {
    if (loaded && project.clips[loaded]?.map.manual == null) untrack(() => detectClipMap(loaded!, playerDuration()));
    else if (loaded) untrack(warmDetection);
  });
  $effect(() => {
    const first = pending[0];
    void [prefs.fovDeg, prefs.fovAxis];
    if (loaded && first) untrack(() => checkFov(loaded!, first.a, first.b));
  });

  function pickMap(m: MapId | undefined) {
    if (!clipId) return;
    clipInfo(clipId).map.manual = m;
    stopMapSearch(clipId);
  }
  /**
   * Takes the section of a shot that the section tool drew, moved or resized in the lane of the shot. A section drawn
   * in the lane of a new shot (shotId null) adds the shot first. The list goes back in time order when a drag ends.
   */
  function setSection(shotId: string | null, a: number, b: number, done: boolean) {
    if (!clipId) return;
    // The change goes through the state object, because `??=` gives back the plain array, and a push on it does not show.
    const info = clipInfo(clipId);
    info.pending ??= [];
    let id = shotId;
    if (!id) { addShotTo(clipId); id = project.shots.at(-1)!.id; }
    const p = { a: +a.toFixed(3), b: +b.toFixed(3), shotId: id }, i = info.pending.findIndex((x) => x.shotId === id);
    if (i >= 0) info.pending[i] = p;
    else info.pending.push(p);
    if (done) info.pending.sort((p, q) => p.a - q.a);
  }
  const sectionOf = (shotId: string) => pending.find((p) => p.shotId === shotId);
    // The section whose remove button is under the pointer. It shows in red, here and in the timeline.
  let removing = $state<number | null>(null);
  const removeSection = (i: number) => clipId && clipInfo(clipId).pending!.splice(i, 1);
  function showSection(i: number) {
    if (!loaded) return;
    video.pause();
    go(loaded, pending[i].a);
  }

  /**
   * Detects the sections of every clip of the batch in one queue and opens Review. Each section goes to the shot of its
   * lane. A section without one (an older project) goes to a shot of the clip without a detection and without marks,
   * or to a new one. A map that the search found counts as picked. Without one, the detection finds the map itself.
   */
  function processClip() {
    const used = new Set<string>(), jobs: Job[] = [];
    for (const id of ready) {
      const info = clipInfo(id);
      if (info.map.manual == null && info.map.auto?.value) info.map.manual = info.map.auto.value;
      const run = info.pending?.filter(counts) ?? [];
      for (const p of run) used.add(p.shotId ?? '');
      for (const p of run) {
        let shot = project.shots.find((s) => s.id === p.shotId)
          ?? shotsOf(id).find((s) => !used.has(s.id) && !info.sections?.some((x) => x.shotId === s.id) && !project.sightings.some((x) => x.shotId === s.id));
        if (!shot) { addShotTo(id); shot = project.shots.at(-1)!; }
        used.add(shot.id);
        jobs.push({ clipId: id, shotId: shot.id, a: p.a, b: p.b });
      }
      info.pending = info.pending?.filter((p) => !counts(p));
    }
    if (!jobs.length) return;
    // Review opens on the first job, which lies in the clip on screen when that clip has sections.
    jobs.sort((p, q) => Number(q.clipId === clipId) - Number(p.clipId === clipId));
    ui.clipId = jobs[0].clipId;
    ui.shotId = jobs[0].shotId;
    detectAll(jobs);
    ui.phase = 'review';
  }

  const s2 = (t: number) => `${t.toFixed(2)} s`;

  // What the file of the clip says about its media, read once per clip, and the timing of its frames.
  let media = $state<{ id: string; info: MediaInfo | null } | null>(null);
  $effect(() => {
    const id = clipId;
    if (!id) return;
    let stale = false;
    clipBlob(id).then((b) => (b ? mediaInfo(b) : null)).catch(() => null).then((info) => { if (!stale) media = { id, info }; });
    return () => { stale = true; };
  });
  const info = $derived(media?.id === clipId ? media.info : null);
  const timing = $derived(playerFrames()?.length ? frameTiming(playerFrames()!) : null);
  const CODECS: Record<string, string> = { avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };
  const codecName = (c: string | null) => (c ? CODECS[c] ?? c.toUpperCase() : 'Unknown');

  const WINS: Record<string, WinMeta> = {
    video: { title: 'Video', icon: ICONS.video },
    timeline: { title: 'Shot sections', icon: ICONS.gantt },
    facts: { title: 'Clip details', icon: ICONS.scanSearch, max: { w: 480, h: 720 } },
  };
  /**
   * The first arrangement floats every window. It puts the video and the timeline in the middle, and the clip details
   * to the right, and it leaves room all around.
   */
  const initial = (): Layout => ({
    root: stack([]),
    floating: [
      { win: 'video', r: { x: 0.19, y: 0.03, w: 0.58, h: 0.55 } },
      { win: 'timeline', r: { x: 0.19, y: 0.61, w: 0.58, h: 0.36 } },
      { win: 'facts', r: { x: 0.79, y: 0.03, w: 0.19, h: 0.55 } },
    ],
  });
  ui.docks.setup = withWindows(ui.docks.setup ?? initial(), Object.keys(WINS));

  function onkeydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
    if (e.altKey && e.key.toLowerCase() === 'x') { e.preventDefault(); setSelection(null); return; }
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); stepBy((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
    else if (k === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (k === 'g') { e.preventDefault(); bar?.openGoTo(); }
    else if (k === 's') { e.preventDefault(); sectionTool = !sectionTool; }
  }
</script>

<svelte:window {onkeydown} />

<Dock bind:layout={() => ui.docks.setup, (l) => (ui.docks.setup = l)} wins={WINS}>
  {#snippet body(w)}
    {#if w === 'video'}
      <div class="flex h-full flex-col">
        <div class="relative min-h-0 flex-1" data-media style:--aspect={clip ? `${clip.width} / ${clip.height}` : null}>
          {#if player.loadError}<p class="note bad m-3">{player.loadError}</p>
          {:else if loaded}
            <Viewer {video} frame={player.frame} sighting={undefined} others={[]} copied={[]} impact={false} pending={null} lock={null} notes={[]} tool={false}
              onpoint={() => {}} onhover={() => {}} ondrag={() => {}} onmiddle={() => {}} onremove={() => {}} />
          {:else}<p class="m-0 flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading the clip...</p>{/if}
        </div>
        <PlayerBar bind:this={bar} duration={playerDuration()} onstep={stepBy} ongo={(t) => loaded && go(loaded, t)} testid="setup-time" />
      </div>
    {:else if w === 'timeline'}
      <div class="flex h-full flex-col">
        <p class="m-0 flex items-start gap-2 border-b border-line px-3 py-2 text-[12px] text-copy">
          <Info size={14} class="mt-0.5 shrink-0 text-accent" />
          <span>With the section tool, drag in the lane of a shot over the frames where its shell flies, from where it shows until it lands. When every lane holds a shot, a lane for the next shot appears. Then process the shots.</span>
        </p>
        <!-- a long list of lanes scrolls, so the window does not grow past a few of them -->
        <div class="min-h-0 flex-1 overflow-y-auto p-2" data-scroll-min>
          <Timeline time={playerTime()} {clipId} frames={playerFrames()} ongo={(c, t, s, exact) => go(c, t, s, exact)} bind:loop={() => selection, setSelection}
            draw={{ on: sectionTool, get: sectionOf, set: setSection, doomed: removing != null ? pending[removing]?.shotId : null }} />
        </div>
        <div class="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <button class="btn sm" aria-pressed={sectionTool} onclick={() => (sectionTool = !sectionTool)} data-testid="section-tool"
            title="Draw shot sections on the timeline (S)"><PencilLine size={12} /> Section tool</button>
          <!-- The shots lead into the Process button, which detects them. They can take more rows. -->
          <div class="ml-auto flex min-w-0 items-center gap-2">
            {#if pending.length}
              <div class="flex min-w-0 flex-wrap items-center justify-end gap-1" data-wrap>
                <!-- in the order of the shots, as the lanes are -->
                {#each pending.map((p, i) => ({ p, i, si: project.shots.findIndex((s) => s.id === p.shotId) })).sort((x, y) => x.si - y.si) as { p, i, si } (i)}
                  {@const sh = project.shots[si]}
                  <span class="shot" class:off={sh?.excluded} class:doomed={removing === i} data-testid="pending-section">
                    <button class="flex items-center gap-1.5" onclick={() => showSection(i)}
                      title="{sh?.name ?? 'This shot'} flies from {s2(p.a)} to {s2(p.b)}.{sh?.excluded ? ' It is left out, so the Process button skips it.' : ''} Click to show it.">
                      <span class="h-2 w-2 shrink-0" style:background={si >= 0 ? shotColor(si) : 'var(--muted)'}></span>{sh?.name ?? `Shot ${i + 1}`}
                    </button>
                    <button class="grid place-items-center" onpointerenter={() => (removing = i)} onpointerleave={() => (removing = null)}
                      onclick={() => { removing = null; removeSection(i); }} aria-label="Remove this section" title="Remove this section"><X size={10} /></button>
                  </span>
                {/each}
              </div>
              <span class="grid shrink-0 place-items-center text-muted"><ArrowRight size={14} /></span>
            {/if}
            <button class="btn sm" onclick={processClip} disabled={!ready.length} data-testid="process-clip" title="Detect the section of every shot and open Review">
              <ICONS.scanSearch size={13} /> {processLabel}
            </button>
          </div>
        </div>
      </div>
    {:else if w === 'facts'}
      <div class="flex h-full flex-col gap-4 overflow-y-auto p-3 text-[12px]">
        <div class="flex flex-col gap-1.5">
          <span class="head">Map</span>
          {#if map?.manual}
            <span class="text-text">{MAPS[map.manual]}</span>
          {:else if map?.auto?.value}
            <span class="text-text" data-testid="detected-map">Detected map: {MAPS[map.auto.value]}</span>
            <span class="text-muted">{Math.round(map.auto.conf * 100)} percent sure. The detection uses it unless you pick another.</span>
          {:else if detection.searching === clipId}
            <span class="flex items-center gap-2 text-muted"><Spinner size={12} /> Looking at the minimap...</span>
          {:else}
            <span class="text-muted">The minimap did not show the map clearly. Pick it, or the detection looks again.</span>
          {/if}
          <MapChooser value={map?.manual} auto={map?.auto} onpick={pickMap} />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="label accent">Field of view</span>
          <span class="flex items-center gap-2 text-text">{prefs.fovDeg} deg, {prefs.fovAxis === 'h' ? 'horizontal' : 'vertical'} <button class="btn sm" onclick={openSettings}>Edit</button></span>
          {#if !prefs.saved}
            <p class="note warn m-0 flex gap-2"><TriangleAlert size={14} class="shrink-0" /> The FOV is not set yet, and every angle depends on it. Set the FOV of the game.</p>
          {/if}
          {#if !pending.length}
            <span class="text-muted">The check runs on the first shot section.</span>
          {:else if fov?.running}
            <span class="flex items-center gap-2 text-muted"><Spinner size={12} /> Checking the FOV on the turns of the camera...</span>
          {:else if fov?.error}
            <span class="text-muted">The check failed ({fov.error}).</span>
          {:else if verdict?.kind === 'ok'}
            <span class="text-ok" data-testid="fov-ok">It fits the turns of the camera (fit {fov!.fits[0].fit.toFixed(2)} px).</span>
          {:else if verdict?.kind === 'unknown'}
            <span class="text-muted">The camera barely turns in the first shot section, so its picture motion cannot confirm the FOV.</span>
          {:else if verdict?.kind === 'mismatch'}
            <p class="note warn m-0 flex flex-col gap-1.5" data-testid="fov-mismatch">
              <span class="flex gap-2"><TriangleAlert size={14} class="shrink-0" /> The FOV may not match the game. {fov!.fits.map((f) => `${f.fov} deg fits ${Number.isFinite(f.fit) ? `${f.fit.toFixed(2)} px` : 'not at all'}`).join(', ')}.</span>
              {#if verdict.better}<button class="btn sm self-start" onclick={() => setPrefs({ fovDeg: verdict.better! })}>Use {verdict.better} deg</button>{/if}
            </p>
          {/if}
        </div>

        {#if clip}
          <div class="flex flex-col gap-1">
            <span class="head">Clip</span>
            <!-- the labels take only their own width, so the values have room in a narrow window -->
            <dl class="dl text-[12px]" style="grid-template-columns: max-content minmax(0, 1fr)">
              <dt>Source</dt><dd>{clip.source === 'buffer' ? 'Recorded' : 'Uploaded'}, {new Date(clip.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</dd>
              <dt>Length</dt><dd><Timecode t={clip.durationS} /></dd>
              <dt>Resolution</dt><dd class="num">{clip.width} x {clip.height}{info?.video?.hdr ? ', HDR' : ''}</dd>
              {#if playerFrames()?.length}
                <dt>Frames</dt>
                <dd class="num" title="The frame rate is the typical one, from the median gap between two frames">{playerFrames()!.length}{timing ? `, ${timing.fps.toFixed(timing.fps < 20 ? 1 : 0)} per second` : ''}</dd>
              {/if}
              {#if timing}
                <dt>Longest gap</dt><dd class="num">{timing.longest.toFixed(3)} s</dd>
                <dt>Timing missteps</dt>
                <dd class="num" title="A timing misstep is a gap between two frames more than half again as long as the typical one. The recording lost frames there.">{timing.skips}</dd>
              {/if}
              {#if clip.bytes}
                <dt>File</dt><dd class="num">{(clip.bytes / 1e6).toFixed(1)} MB{info ? `, ${info.container}` : ''}</dd>
                <dt>Bit rate</dt><dd class="num">{((clip.bytes * 8) / clip.durationS / 1e6).toFixed(1)} Mbit/s</dd>
              {/if}
              <!-- the codec string only when it says more than the name of the codec -->
              {#if info?.video}<dt>Codec</dt><dd class="num">{codecName(info.video.codec)}{info.video.codecString?.includes('.') ? ` (${info.video.codecString})` : ''}</dd>{/if}
            </dl>
          </div>
        {/if}
        <!-- the actions of the page, at the bottom of the window -->
        <div class="mt-auto flex justify-between gap-2 border-t border-line pt-3">
          <button class="btn sm" onclick={onback} title="Choose between the automatic flow and marking by hand again" data-testid="change-flow"><ArrowLeft size={12} /> Back to Setup</button>
          <button class="btn sm" onclick={() => (ui.docks.setup = initial())} title="Put every window back where the page first put it" data-testid="arrange"><LayoutDashboard size={12} /> Arrange</button>
        </div>
      </div>
    {/if}
  {/snippet}
</Dock>

<style>
  /* The heading of a section of the Clip details window, with a line under it. */
  .head { display: block; padding-bottom: 4px; margin-bottom: 2px; border-bottom: 1px solid var(--line); font: 400 12.5px/1.2 var(--font-display); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text); }
  /* A small tag per shot, below the Process button in weight. */
  .shot { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 4px 0 6px; font-size: 11px; color: var(--text); border: 1px solid var(--line); }
  .shot.off { color: var(--muted); text-decoration: line-through; }
  .shot.doomed { color: var(--bad); border-color: var(--bad); text-decoration: line-through; }
  .shot button:hover { color: var(--accent); }
  .btn[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: var(--accent-fill); }
</style>
