<script lang="ts">
  /**
   * The Review phase (docs/review-plan.md) shows the findings of the detection in a dock of windows, where the user
   * checks them and signs them off. Every window shows the frame of the shared player (player.svelte.ts). Marking stays in Mark and Coordinates.
   */
  import { untrack } from 'svelte';
  import Dock, { type WinMeta } from '../dock/Dock.svelte';
  import Viewer from '../mark/Viewer.svelte';
  import PlayerBar from '../mark/PlayerBar.svelte';
  import StabView from '../mark/StabView.svelte';
  import SectionPanel from '../mark/SectionPanel.svelte';
  import Timeline, { type Track } from '../mark/Timeline.svelte';
  import { frameCameraAt } from '../../lib/state/sections.ts';
  import ResultMap from '../result/ResultMap.svelte';
  import ShotResult from '../result/ShotResult.svelte';
  import MapChooser from '../MapChooser.svelte';
  import Spinner from '../Spinner.svelte';
  import SignOffList from '../review/SignOffList.svelte';
  import Scene3D from '../review/Scene3D.svelte';
  import { ICONS } from '../../lib/icons.ts';
  import { detectionView } from '../mark/draw.ts';
  import { presets, split, stack, withWindows, type Layout, type Node } from '../../lib/dock/layout.ts';
  import type { Finding, FindingType } from '../../lib/review/findings.ts';
  import { go, player, playerFrames, playerSection, playerTime, playerDuration, stepBy, togglePlay, usePlayer, video } from '../../lib/state/player.svelte.ts';
  import { clipData, clipInfo, clipMap, clipView, clips, currentShot, project, sameFrame, shotsOf, sightingAt, ui } from '../../lib/state/project.svelte.ts';
  import { cancelDetect, detectClipMap, detection, progress, stopMapSearch, warmDetection } from '../../lib/state/detect.svelte.ts';
  import { solve, solved } from '../../lib/state/solve.svelte.ts';
  import { value } from '../../lib/solver/field.ts';
  import { focalPx } from '../../lib/solver/camera.ts';
  import { refToFrame } from '../../lib/vision/rotation.ts';
  import type { Pt } from '../../lib/solver/types.ts';

  usePlayer();
  const loaded = $derived(player.loaded);
  // the aspect ratio of the pictures of the clip, which the smallest size of their windows keeps (lib/dock/fit.ts)
  const clipSize = $derived.by(() => { const c = clips.list.find((x) => x.id === loaded); return c ? `${c.width} / ${c.height}` : null; });
  const frames = $derived(playerFrames());
  const time = $derived(playerTime());
  const shot = $derived(currentShot());
  const sighting = $derived(loaded && loaded === ui.clipId ? sightingAt(loaded, player.frameTime) : undefined);
  const section = $derived(playerSection());
  const setSection = (s?: { a: number; b: number } | null) => { if (loaded) clipView(loaded).loop = s ?? undefined; };
  const impactHere = $derived(!!loaded && shotsOf(loaded).some((s) => { const i = value(s.impact[loaded!]); return !!i && sameFrame(i.b, player.frameTime); }));

  // the detection of this shot in this clip, with its pitch lines and its overlay on the frame on screen
  const shotSection = $derived(loaded ? project.clips[loaded]?.sections?.find((s) => s.shotId === shot.id) : undefined);
  const guides = $derived.by((): [Pt, Pt][] => {
    const R = shotSection?.frames.find((f) => sameFrame(f.t, player.frameTime))?.R;
    if (!R || !shotSection) return [];
    const w = video.videoWidth, h = video.videoHeight, st = project.settings;
    const K = { f: focalPx(w, h, st.fovDeg, st.fovAxis), cx: w / 2 - 0.5, cy: h / 2 - 0.5 };
    return shotSection.lines.map(([x1, y1, x2, y2]) => [refToFrame(K, R, { x: x1, y: y1 }), refToFrame(K, R, { x: x2, y: y2 })]);
  });
  const overlay = $derived(ui.cv && shotSection && video.videoWidth ? detectionView(shotSection, player.frameTime, video.videoWidth, video.videoHeight, project.settings) : null);

  // the value tracks of the timeline show each value of the detection over its confidence
  const tracks = $derived.by((): Track[] => {
    const sec = shotSection;
    if (!loaded || !sec) return [];
    const out: Track[] = [];
    const own = project.sightings.filter((s) => s.shotId === shot.id && s.clipId === loaded && value(s.shell)).sort((a, b) => a.timeS - b.timeS);
    out.push({ id: 'shell', label: 'Shell positions', kind: 'ticks', pts: own.map((s) => ({ t: s.timeS, c: s.shell.manual != null ? 1 : s.shell.auto?.conf ?? 0 })) });
    const heads = sec.frames.map((f) => { const c = frameCameraAt(sec, f.t); return c ? { t: f.t, v: c.h.value!, c: c.h.conf } : { t: f.t, c: 0 }; });
    const hv = heads.flatMap((q) => (q.v != null ? [q.v] : []));
    if (hv.length) out.push({ id: 'heading', label: 'Heading', kind: 'line', unit: 'deg', pts: heads, lo: Math.min(...hv) - 1, hi: Math.max(...hv) + 1 });
    out.push({ id: 'fit', label: 'Rotation fit', kind: 'line', unit: 'px', pts: sec.frames.map((f) => ({ t: f.t, v: Math.min(1, f.fitPx), c: f.ok ? 0.95 : 0.2 })), lo: 0, hi: 1 });
    if (sec.walk) {
      const end = sec.walk.at(-1)!, dist = sec.walk.map((q) => Math.hypot(q.x - end.x, q.y - end.y) * 100);
      out.push({ id: 'walk', label: 'Walk', kind: 'line', unit: 'm', pts: sec.walk.map((q, k) => ({ t: q.t, v: dist[k], c: sec.minimap?.at.conf ?? 0.5 })), lo: 0, hi: Math.max(1, ...dist) });
    }
    const imp = shot.impact[loaded], iv = value(imp);
    if (iv) out.push({ id: 'impact', label: 'Impact', kind: 'range', pts: [{ t: iv.a, v: iv.b, c: imp?.manual != null ? 1 : imp?.auto?.conf ?? 0 }] });
    return out;
  });

  // the result of the clip, as the Result phase solves it
  $effect(() => solve($state.snapshot(clipData())));
  const result = $derived.by(() => {
    const d = clipData(), ids = new Set(d.shots.map((s) => s.id)), r = solved.result;
    return r && r.shots.every((x) => ids.has(x.shotId)) && (r.shots.length || !d.sightings.length) ? r : null;
  });
  const shotResult = $derived(result?.shots.find((r) => r.shotId === shot.id));

  // for a clip without a map, the detection looks for one in the background, for the question over the video
  $effect(() => {
    if (loaded && project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]) untrack(() => detectClipMap(loaded!, playerDuration()));
    else if (loaded) untrack(warmDetection);
  });

  // the sightings and the impact of the shot, for the buttons that jump between them
  const marks = $derived(
    loaded ? [...project.sightings.filter((s) => s.shotId === shot.id && s.clipId === loaded).map((s) => s.timeS),
      ...(value(shot.impact[loaded]) ? [value(shot.impact[loaded])!.b] : [])].sort((a, b) => a - b) : [],
  );
  function jump(dir: -1 | 1) {
    if (!loaded) return;
    const t = dir > 0 ? marks.find((x) => x > time && !sameFrame(x, time)) : marks.filter((x) => x < time && !sameFrame(x, time)).at(-1);
    // a jump between sightings shows the frame itself, not its preview
    if (t != null) { video.pause(); go(loaded, t, undefined, true); }
  }
  function onkeydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); jump(k === 'arrowup' ? -1 : 1); }
    else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); stepBy((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
    else if (k === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (k === 'g') { e.preventDefault(); bar?.openGoTo(); }
  }
  let bar = $state<PlayerBar>();

  const WINS: Record<string, WinMeta> = {
    signoff: { title: 'Sign-off', icon: ICONS.listChecks, max: { w: 560 } },
    detect: { title: 'Detection', icon: ICONS.scanSearch, max: { w: 560 } },
    video: { title: 'Video', icon: ICONS.video },
    stab: { title: 'Stabilized', icon: ICONS.scan },
    scene: { title: '3D scene', icon: ICONS.box },
    map: { title: 'Map', icon: ICONS.map },
    timeline: { title: 'Timeline', icon: ICONS.gantt },
    result: { title: 'Result', icon: ICONS.trophy },
  };
  /** The layout of a first visit has the sign-off list on the left, and the video and the scene over the timeline. */
  const initial = (): Layout => ({
    root: split('row', [
      stack(['signoff', 'detect']),
      split('col', [split('row', [stack(['video', 'stab']), split('col', [stack(['scene']), stack(['map', 'result'])], [0.55, 0.45])], [0.6, 0.4]), stack(['timeline'])], [0.66, 0.34]),
    ], [0.24, 0.76]),
  });
  presets.review = initial;
  ui.docks.review = withWindows(ui.docks.review ?? initial(), Object.keys(WINS));

  /**
   * The layout for a type of finding (docs/review-plan.md, stage 7) shows the windows that show the type best, and keeps
   * the sign-off list on the left. The other windows join the first stack as tabs.
   */
  function preset(type: FindingType): Layout {
    const withList = (rest: Node): Layout => ({ root: split('row', [stack(['signoff', 'detect']), rest], [0.24, 0.76]) });
    switch (type) {
      case 'shell': return withList(split('col', [split('row', [stack(['video']), split('col', [stack(['stab']), stack(['scene'])])], [0.62, 0.38]), stack(['timeline'])], [0.74, 0.26]));
      case 'camera': return withList(split('col', [split('row', [stack(['video']), stack(['scene'])]), stack(['timeline'])], [0.74, 0.26]));
      case 'impact': return withList(split('col', [split('row', [stack(['video']), stack(['stab'])]), stack(['timeline'])], [0.74, 0.26]));
      case 'position': return withList(split('col', [split('row', [stack(['map']), stack(['scene'])]), stack(['timeline'])], [0.74, 0.26]));
      case 'height': return withList(split('row', [stack(['scene']), stack(['video'])], [0.6, 0.4]));
      case 'crater': return withList(split('row', [stack(['map', 'result']), stack(['scene'])]));
      default: return initial();
    }
  }
  let presetType: FindingType | null = null;
  function openFinding(f: Finding) {
    if (f.type === presetType) return;
    presetType = f.type;
    ui.docks.review = withWindows(preset(f.type), Object.keys(WINS));
  }
</script>

<svelte:window {onkeydown} />

{#if !clips.list.length}
  <div class="card flex h-full flex-col items-center justify-center gap-3 p-8">
    <span class="title text-[44px] text-muted-strong">Nothing to review yet</span>
    <button class="btn primary" onclick={() => (ui.phase = 'record')}>Record or upload a clip</button>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col gap-2">
  <!-- the progress of the detections that the Process button started -->
  {#if detection.batch.total && (detection.running || detection.queue.length)}
    <div class="flex shrink-0 items-center gap-3 border border-line bg-panel px-3 py-1.5 text-[12px]" data-testid="processing">
      <Spinner size={12} />
      <span class="text-text">Processing shot {Math.min(detection.batch.total, detection.batch.done + 1)} of {detection.batch.total}{detection.running ? `, ${detection.running.step}` : ''}</span>
      <span class="relative h-1.5 min-w-24 flex-1 bg-[var(--line)]"><span class="absolute inset-y-0 left-0 bg-accent transition-[width] duration-300" style="width:{progress() * 100}%"></span></span>
      <span class="num text-muted">{Math.round(progress() * 100)}%</span>
      <button class="btn sm" onclick={cancelDetect}>Stop</button>
    </div>
  {/if}
  <div class="min-h-0 flex-1">
  <Dock bind:layout={() => ui.docks.review, (l) => (ui.docks.review = l)} wins={WINS}>
    {#snippet body(w)}
      {#if w === 'video'}
        <div class="flex h-full flex-col">
          <div class="relative min-h-0 flex-1" data-media style:--aspect={clipSize}>
            {#if player.loadError}<p class="note bad m-3">{player.loadError}</p>
            {:else if loaded}
              <Viewer {video} frame={player.frame} {sighting} others={[]} copied={guides} impact={impactHere} detection={overlay} pending={null} lock={null} notes={[]} tool={false}
                onpoint={() => {}} onhover={() => {}} ondrag={() => {}} onmiddle={() => {}} onremove={() => {}} />
              {#if project.clips[loaded]?.map.manual == null && !ui.mapAsked[loaded]}
                <MapChooser big value={undefined} auto={project.clips[loaded]?.map.auto} searching={detection.searching === loaded}
                  onpick={(m) => { clipInfo(loaded!).map.manual = m; stopMapSearch(loaded!); }} onskip={() => { ui.mapAsked[loaded!] = true; stopMapSearch(loaded!); }} />
              {/if}
            {:else}<p class="m-0 flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading the clip...</p>{/if}
          </div>
          <!-- the same bar as on Setup and Mark, with the detection overlay on its left -->
          {#snippet left()}
            {#if shotSection}<button class="option min-h-0 px-1.5 py-1 text-[11px]" aria-pressed={ui.cv} onclick={() => (ui.cv = !ui.cv)} title="Draws the detection on the video. It shows the horizon and headings of the detected camera, the shell track of the section, and the impact. It also shows the HUD parts that the detection reads, and how sure the rotation of this frame is.">Detection</button>{/if}
          {/snippet}
          <PlayerBar bind:this={bar} duration={playerDuration()} onstep={stepBy} ongo={(t) => loaded && go(loaded, t)} {left}
            jump={{ go: jump, enabled: marks.length > 0, what: `sighting or impact of ${shot.name}` }} testid="review-time" />
        </div>
      {:else if w === 'stab'}
        <div class="h-full" data-media style:--aspect={clipSize}>{#if loaded}<StabView {video} frame={player.frame} time={player.frameTime} section={shotSection} />{/if}</div>
      {:else if w === 'detect'}
        <div class="h-full overflow-y-auto p-2" data-scroll-min>{#if loaded}<SectionPanel clipId={loaded} loop={section} ongo={(t) => { video.pause(); go(loaded!, t); }} />{/if}</div>
      {:else if w === 'timeline'}
        <div class="h-full overflow-y-auto p-2" data-scroll-min><Timeline {time} clipId={ui.clipId} {frames} {tracks} ongo={(c, t, s, exact) => go(c, t, s, exact)} bind:loop={() => section, setSection} /></div>
      {:else if w === 'map'}
        <!-- not a picture of its own (data-media): its controls need their room, which ResultMap keeps as its smallest size -->
        <div class="h-full">
        {#if result}<ResultMap {result} clipId={ui.clipId} map={ui.mapShown.result ?? clipMap(ui.clipId)} />
        {:else}<p class="m-0 flex h-full items-center justify-center gap-2 p-6 text-center text-muted">{#if solved.solving}<Spinner /> Solving...{:else}The map shows here after the first result.{/if}</p>{/if}
        </div>
      {:else if w === 'result'}
        <div class="h-full overflow-y-auto p-2" data-scroll-min>
          <!-- an empty window says so in its middle, as the scene and the map do -->
          {#if shotResult}<ShotResult r={shotResult} />{:else}<p class="m-0 flex h-full items-center justify-center gap-2 p-6 text-center text-muted">{#if solved.solving}<Spinner /> Solving...{:else}No result for {shot.name} yet.{/if}</p>{/if}
        </div>
      {:else if w === 'signoff'}
        <SignOffList {result} onopen={openFinding} />
      {:else if w === 'scene'}
        <div class="h-full" data-media><Scene3D {result} {time} /></div>
      {/if}
    {/snippet}
  </Dock>
  </div>
  </div>
{/if}
