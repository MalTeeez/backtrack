<script module lang="ts">
  import { ui } from '../../lib/state/project.svelte.ts';
  // folded sightings live in the UI state, so they stay folded across phase changes and reloads
  /** Whether every one of these sightings is folded, and folding or opening them all. */
  export const allFolded = (ids: string[]) => ids.length > 0 && ids.every((id) => ui.folded[id]);
  export function foldAll(ids: string[], fold: boolean) {
    for (const id of ids) ui.folded[id] = fold;
  }
</script>

<script lang="ts">
  /** The sightings of the current shot: their values as fields, and notes only for what is missing or wrong. */
  import { ChevronDown, ChevronRight, Trash2 } from '@lucide/svelte';
  import NumInput from '../NumInput.svelte';
  import UseToggle from '../UseToggle.svelte';
  import CraterMap from '../CraterMap.svelte';
  import { timecode } from './Timeline.svelte';
  import { SightingSolver } from '../../lib/solver/sightings.ts';
  import { motionFlags, motionWarning, shellSpeeds } from '../../lib/solver/motion.ts';
  import { lacks } from '../../lib/state/missing.ts';
  import { forLater } from './draw.ts';
  import { clips, currentShot, deleteSighting, project } from '../../lib/state/project.svelte.ts';
  import type { Id } from '../../lib/solver/types.ts';

  let { ongo }: { ongo: (clipId: Id, t: number, sightingId?: Id) => void } = $props();

  const shot = $derived(currentShot());
  const clipName = (id: Id) => clips.list.find((c) => c.id === id)?.name ?? 'Missing clip';
  const order = $derived(new Map(clips.list.map((c, i) => [c.id, i])));
  const list = $derived(
    project.sightings
      .filter((s) => s.shotId === shot.id)
      .sort((a, b) => (a.clipId === b.clipId ? a.timeS - b.timeS : (order.get(a.clipId) ?? 0) - (order.get(b.clipId) ?? 0))),
  );
  const solver = $derived(new SightingSolver($state.snapshot(project)));
  // the steps where the shell jumps, as warnings on the sightings they lead to
  const jumps = $derived(motionFlags($state.snapshot(project), solver));
  const jumpsOf = (id: Id) => jumps.filter((f) => f.to === id).map(motionWarning);
  const speeds = $derived(shellSpeeds($state.snapshot(project), solver));
  // the sightings whose position map is open
  const round = (v: number | undefined) => (v == null ? undefined : Math.round(v * 100) / 100);
  // the user enters the crater in phase 3, so its absence is no problem here
  const needsCoords = forLater;
  const CAMERA = { 'compass and edges': 'From the compass heading and the edges', copied: 'Copied from an earlier sighting in this clip' };
  const deg = (v: number) => `${v.toFixed(2)} deg`;
</script>

<div class="flex flex-col gap-1.5" data-testid="sighting-list">
  {#if !list.length}
    <p class="m-0 p-1 text-[12px] text-muted" title="Mark the shell on a frame, then one or two vertical edges and the compass heading. 2 frames are the least, and about 10 give a good result.">
      {shot.name} has no sightings yet.
    </p>
  {/if}
  {#each list as s, i (s.id)}
    {@const r = solver.solve(s)}
    {@const a = solver.aim(s)}
    {@const todo = lacks(s)}
    {@const jump = jumpsOf(s.id)}
    {@const bad = (!r.ok && !needsCoords(r.error) && !todo.length) || r.warnings.length > 0 || jump.length > 0}
    {@const tau = shot.impactTimeS[s.clipId] != null ? shot.impactTimeS[s.clipId] - s.timeS : null}
    {@const selected = ui.sightingId === s.id}
    <div
      class="min-w-0 border p-2.5 text-[12.5px] [overflow-wrap:anywhere] {selected ? 'border-[var(--accent-border-active)] bg-[var(--accent-soft)]' : 'border-line'} {s.excluded ? 'opacity-60' : ''}"
      style="box-shadow: {selected ? 'inset 2px 0 0 var(--accent)' : 'none'}"
      aria-current={selected}
      data-testid="sighting"
      {@attach (el) => { if (selected) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}
    >
      <div class="flex items-center gap-2">
        <button class="text-muted hover:text-text" aria-label={ui.folded[s.id] ? 'Expand' : 'Collapse'} aria-expanded={!ui.folded[s.id]} onclick={() => (ui.folded[s.id] = !ui.folded[s.id])}>
          {#if ui.folded[s.id]}<ChevronRight size={14} />{:else}<ChevronDown size={14} />{/if}
        </button>
        <button class="card-title text-[11px] hover:text-accent" onclick={() => ongo(s.clipId, s.timeS, s.id)}>Sighting {i + 1}</button>
        {#if ui.folded[s.id]}
          <span class="num min-w-0 truncate text-[11.5px] text-muted">{timecode(s.timeS)}{a.ok ? `, el ${deg(a.el)}` : ''}</span>
          {#if bad}<span class="tag warn px-1 py-0" title={[...(!r.ok ? [r.error] : []), ...r.warnings, ...jump].join('\n')}>!</span>{/if}
        {/if}
        {#if todo.length}<span class="tag warn shrink-0 px-1 py-0" title="Still needs: {todo.join(', ')}" data-testid="incomplete">Incomplete</span>{/if}
        {#if s.excluded}<span class="tag px-1 py-0">Left out</span>{/if}
        <span class="ml-auto"></span>
        <UseToggle target={s} what="this sighting" />
        <button class="text-muted hover:text-bad" aria-label="Delete sighting" onclick={() => deleteSighting(s.id)}><Trash2 size={13} /></button>
      </div>
      {#if !ui.folded[s.id]}
      <dl class="dl mt-1.5 text-[12px]">
        <dt>Clip</dt><dd class="truncate" title={clipName(s.clipId)}>{clipName(s.clipId)}</dd>
        <dt>Time</dt>
        <dd><button class="num text-accent underline decoration-dotted underline-offset-2 hover:text-text" onclick={() => ongo(s.clipId, s.timeS, s.id)} title="Go to this frame">{timecode(s.timeS)}</button></dd>
        <dt>Before impact</dt><dd class="num">{tau != null ? `${tau.toFixed(3)} s` : '-'}</dd>
        <dt>Shell</dt><dd class="num">{s.shell ? `${s.shell.x.toFixed(1)}, ${s.shell.y.toFixed(1)}` : '-'}</dd>
        <dt>Edges</dt><dd class="num">{s.edges.length}</dd>
        <dt>Azimuth</dt><dd class="num">{a.ok ? deg(a.az) : '-'}</dd>
        <dt>Elevation</dt><dd class="num">{a.ok ? deg(a.el) : '-'}</dd>
        <dt>Shell speed</dt><dd class="num" title="How fast the shell moves as seen by the camera, since the sighting before this one">{speeds.has(s.id) ? `${speeds.get(s.id)!.toFixed(2)} deg/s` : '-'}</dd>
        {#if a.ok}
          <dt>Camera</dt><dd class="num" title={CAMERA[a.cam.source]}>heading {deg(a.cam.h)}, pitch {deg(a.cam.p)}{a.cam.source === 'copied' ? ' (copied)' : ''}</dd>
        {/if}
      </dl>
      {#if !s.sameCameraAsPrevious}
        <div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
          <span title="The compass heading of the game at this frame. A new sighting fills it from the compass in the frame.">
            <NumInput label="Compass heading" unit="deg" step={0.5} bind:value={s.headingDeg} />
          </span>
          <span title="The zoom of binoculars or a scope on this frame. The field of view is the game FOV divided by it."><NumInput label="Zoom" unit="x" step={0.5} min={1} bind:value={() => s.zoom ?? 1, (v) => (s.zoom = v && v > 0 && v !== 1 ? v : undefined)} /></span>
        </div>
      {/if}
      {@const copied = !s.position && s.sameCameraAsPrevious ? solver.position(s) : null}
      <div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1.5" title="Where you stood on this frame, from the minimap. Optional: without it, the solver estimates the spot near the crater.">
        <NumInput label="Your X (optional)" step={0.01} placeholder={copied ? String(copied.x) : 'minimap'} bind:value={() => s.position?.x, (v) => (s.position = { ...s.position, x: round(v) })} />
        <NumInput label="Your Y (optional)" step={0.01} placeholder={copied ? String(copied.y) : 'minimap'} bind:value={() => s.position?.y, (v) => (s.position = { ...s.position, y: round(v) })} />
        <button class="option h-[30px] justify-center px-2 text-[11px]" aria-pressed={!!ui.mapOpen[s.id]} onclick={() => (ui.mapOpen[s.id] = !ui.mapOpen[s.id])} title="Pick where you stood on the map">Map</button>
      </div>
      {#if ui.mapOpen[s.id]}
        <div class="mt-1.5">
          <CraterMap viewId={s.id} shot={shot} reachM={project.settings.rangeMaxM} map={project.settings.map} observer={s.position ?? copied} onpick={(q) => (s.position = q)} />
        </div>
      {/if}
      <label class="mt-2 flex items-start gap-1.5 text-copy" title="Use the camera of the previous sighting in this clip, when the view did not move">
        <input type="checkbox" class="mt-[3px] shrink-0" bind:checked={s.sameCameraAsPrevious} /> Same camera as the previous sighting
      </label>
      {#if todo.length}<div class="note warn mt-1.5">Still needs: {todo.join(', ')}.</div>
      {:else if !r.ok && !needsCoords(r.error)}<div class="note bad mt-1.5">{r.error}</div>{/if}
      {#each r.warnings as w}<div class="note warn mt-1">{w}</div>{/each}
      {#each jump as w}<div class="note warn mt-1" data-testid="motion-warning">{w}</div>{/each}
      {/if}
    </div>
  {/each}
</div>
