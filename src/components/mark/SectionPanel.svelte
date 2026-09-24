<script lang="ts">
  /**
   * The detection of the current shot in this clip (automation plan sections 5 to 10): the button that runs it on the
   * section of the timeline, and what it found. The camera of the section can be overridden here for every frame at once.
   */
  import { ScanSearch, Trash2, X } from '@lucide/svelte';
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

  let { clipId, loop, ongo }: { clipId: Id; loop: { a: number; b: number } | null; ongo: (t: number) => void } = $props();

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
        title={range ? `Find the shell, the camera, the impact and where you stood in ${s2(range.a)} to ${s2(range.b)}` : 'Drag on the ruler of the timeline over the frames where the shell flies'}>
        <ScanSearch size={13} /> Detect in section <Key k="D" />
      </button>
      {#if !range}<span class="text-[11.5px] text-muted">Select where the shell flies on the ruler.</span>{/if}
      {#if sec}<button class="btn icon sm ml-auto" onclick={remove} aria-label="Delete the detection" title="Forget this detection. The sightings stay."><Trash2 size={13} /></button>{/if}
    {/if}
  </div>
  {#if detection.error && !running}<p class="note bad m-0">{detection.error}</p>{/if}

  {#if sec}
    <dl class="dl text-[12px]">
      <dt>Section</dt><dd class="num">{s2(sec.a)} to {s2(sec.b)} <span class="text-muted">({(sec.ms / 1000).toFixed(1)} s)</span></dd>
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
        <dd class="num" title="The minimap of each frame: the rays of the sightings start where you were on their frame, and the position above is the one at the impact.">{walkedM.toFixed(0)} m</dd>
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
        <ul class="m-0 list-none p-0">
          {#each sec.dropped as d}<li><button class="num hover:text-accent" onclick={() => ongo(d.t)}>{d.t.toFixed(3)} s</button> <span class="text-muted">{d.reason}</span></li>{/each}
        </ul>
      </details>
    {/if}
  {/if}
</div>
