<script lang="ts">
  /**
   * The detection of the current shot in this clip (automation plan sections 5 to 10): the button that runs it on the
   * section of the timeline, and what it found. The user can override the camera of the section here for every frame
   * at once.
   */
  import Trash2 from '@jis3r/icons/icons/trash-2';
  import X from '@jis3r/icons/icons/x';
  import { ScanSearch } from '@lucide/svelte';
  import AutoNum from '../AutoNum.svelte';
  import FieldTag from '../FieldTag.svelte';
  import Key from '../Key.svelte';
  import Spinner from '../Spinner.svelte';
  import { MAPS } from '../../lib/map/tiles.svelte.ts';
  import { impactTime, value } from '../../lib/solver/field.ts';
  import { applyCameras } from '../../lib/state/sections.ts';
  import { cancelDetect, detect, detection } from '../../lib/state/detect.svelte.ts';
  import { currentShot, project } from '../../lib/state/project.svelte.ts';
  import type { Id } from '../../lib/solver/types.ts';
  import { frameCache, thumbAt } from '../../lib/video/frameCache.svelte.ts';

  let { clipId, loop, ongo }: { clipId: Id; loop: { a: number; b: number } | null; ongo: (t: number) => void } = $props();
  /** Draws the thumbnail of the frame at t (frameCache.svelte.ts), again as better ones come in. */
  const thumb = (t: number) => (c: HTMLCanvasElement) => {
    $effect(() => {
      void frameCache.version;
      const b = thumbAt(clipId, t), g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      if (b) g.drawImage(b, 0, 0, c.width, c.height);
    });
  };

  const shot = $derived(currentShot());
  const sec = $derived(project.clips[clipId]?.sections?.find((s) => s.shotId === shot.id));
  // how far the user walked over the section (m)
  const walkedM = $derived(sec?.walk ? Math.hypot(sec.walk[sec.walk.length - 1].x - sec.walk[0].x, sec.walk[sec.walk.length - 1].y - sec.walk[0].y) * 100 : null);
  const running = $derived(detection.running?.clipId === clipId ? detection.running : null);
  // the section of the timeline, else the one the detection ran on before
  const range = $derived(loop ?? (sec ? { a: sec.a, b: sec.b } : null));

  // a camera value the user types for the section goes to every sighting of it
  $effect(() => {
    if (!sec) return;
    void [sec.heading.manual, sec.pitch.manual, sec.roll.manual];
    applyCameras(project, clipId, sec);
  });

  function run() {
    if (range && !running) detect(clipId, shot.id, range.a, range.b);
  }
  function remove() {
    const c = project.clips[clipId];
    if (c?.sections) c.sections = c.sections.filter((s) => s !== sec);
  }
  const s2 = (t: number) => `${t.toFixed(2)} s`;
</script>

<svelte:window onkeydown={(e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'd') { e.preventDefault(); run(); }
}} />

<div class="flex flex-col gap-2" data-testid="section-panel">
  <div class="flex flex-wrap items-center gap-2">
    {#if running}
      <span class="flex items-center gap-1.5 text-[12px] text-muted"><Spinner size={12} /> {running.step}...</span>
      <button class="btn sm ml-auto" onclick={cancelDetect}><X size={12} /> Stop</button>
    {:else}
      <button class="btn sm primary" onclick={run} disabled={!range} data-testid="detect"
        title={range ? `Find the shell, the camera, the impact and the sighting position in ${s2(range.a)} to ${s2(range.b)}` : 'Drag on the ruler of the timeline over the frames where the shell flies'}>
        <ScanSearch size={13} /> Detect in section <Key k="D" />
      </button>
      {#if !range}<span class="text-[11.5px] text-muted">Select where the shell flies on the ruler.</span>{/if}
      {#if sec}<button class="btn icon sm ml-auto" onclick={remove} aria-label="Delete the detection" title="Forget this detection. The sightings stay."><Trash2 size={13} /></button>{/if}
    {/if}
  </div>
  {#if detection.error && !running}<p class="note bad m-0">{detection.error}</p>{/if}

  {#if sec}
    <dl class="dl text-[12px]">
      <dt>Section</dt><dd class="num">{s2(sec.a)} to {s2(sec.b)}</dd>
      <!-- how long the detection ran, apart from the section, so it does not read as its length -->
      <dt>Detection</dt><dd class="num">Took {(sec.ms / 1000).toFixed(1)} s</dd>
      <dt>Shell</dt><dd class="num">{sec.marks.length} marks{sec.dropped.length ? `, ${sec.dropped.length} frames left out` : ''}</dd>
      <dt>Impact</dt>
      <dd class="num flex flex-wrap items-center gap-x-2">
        {#if sec.impact.value}<button class="hover:text-accent" onclick={() => ongo(sec.impact.value!.b)}>{impactTime(sec.impact.value).toFixed(3)} s</button>{:else}-{/if}
        <FieldTag kind="impact" field={{ auto: sec.impact }} fmt={(v) => `${impactTime(v as never).toFixed(3)} s`} />
      </dd>
      {#if sec.minimap}
        <dt>Minimap</dt>
        <dd class="num">{MAPS[sec.minimap.map.value!] ?? '-'} {value({ auto: sec.minimap.at }) ? `X ${sec.minimap.at.value!.x.toFixed(2)} Y ${sec.minimap.at.value!.y.toFixed(2)}` : '(unsure)'}</dd>
      {/if}
      {#if walkedM != null}
        <dt>Walked</dt>
        <dd class="num" title="The minimap of each frame gives the walk. The ray of each sighting starts at the sighting position of its frame, and the position above is the one at the impact.">{walkedM.toFixed(0)} m</dd>
      {/if}
    </dl>
    <div class="grid grid-cols-3 gap-1.5" title="The camera of the reference frame of the section ({sec.ref.toFixed(3)} s). A value typed here goes to every frame of the section.">
      <AutoNum label="Heading" unit="deg" kind="heading" step={0.1} bind:field={sec.heading} />
      <AutoNum label="Pitch" unit="deg" kind="pitch" step={0.1} bind:field={sec.pitch} />
      <AutoNum label="Roll" unit="deg" kind="roll" step={0.1} bind:field={sec.roll} required="level" />
    </div>
    {#each sec.notes as n}<p class="note warn m-0">{n}</p>{/each}
    {#if sec.dropped.length}
      <details class="disclosure text-[12px]">
        <summary>Frames left out</summary>
        <!-- each frame with its picture, which opens it -->
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          {#each sec.dropped as d (d.t)}
            <li class="flex items-center gap-2">
              <button class="shrink-0 border border-line hover:border-accent" onclick={() => ongo(d.t)} title="Show this frame" aria-label="Show the frame at {d.t.toFixed(3)} s">
                <canvas class="block h-[45px] w-20 bg-stage" width="160" height="90" {@attach thumb(d.t)}></canvas>
              </button>
              <span class="flex min-w-0 flex-col">
                <button class="num self-start hover:text-accent" onclick={() => ongo(d.t)}>{d.t.toFixed(3)} s</button>
                <span class="text-muted">{d.reason}</span>
              </span>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}
</div>
