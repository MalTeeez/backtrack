<script lang="ts">
  /** The mark tools, the main entry point of the Mark phase, and the impact frame. */
  import { Crosshair, Eraser, Flame, Ruler } from '@lucide/svelte';
  import Key from '../Key.svelte';
  import Spinner from '../Spinner.svelte';
  import { currentShot, ui, type Tool } from '../../lib/state/project.svelte.ts';
  import type { Sighting } from '../../lib/solver/types.ts';
  import FieldTag from '../FieldTag.svelte';
  import { impactSigma, impactTime, value } from '../../lib/solver/field.ts';

  let { time, sighting, pending, compass, onimpact, onclear }: {
    time: number; sighting: Sighting | undefined; pending: boolean; onimpact: () => void; onclear: () => void;
    /**
     * The compass heading that Backtrack reads from the frame on screen. It is null when Backtrack cannot read it, and
     * undefined during the reading.
     */
    compass: number | null | undefined;
  } = $props();

  const shot = $derived(currentShot());
  const field = $derived(ui.clipId ? shot.impact[ui.clipId] : undefined);
  const interval = $derived(value(field));
  const impact = $derived(interval && impactTime(interval));

  const TOOLS: [Exclude<Tool, null>, string, string, string, typeof Crosshair][] = [
    ['shell', 'Mark shell', 'S', 'Click the shell in flight, on 2 or more frames. Drag a mark to move it.', Crosshair],
    ['edge', 'Mark vertical edge', 'V', 'Click the bottom and the top of a vertical edge, like a building corner. Each frame needs one, and the compass heading.', Ruler],
  ];
</script>

<div class="flex flex-wrap items-stretch gap-2">
  {#each TOOLS as [t, label, key, tip, Icon]}
    <button class="tool" class:idle={!ui.tool} aria-pressed={ui.tool === t} onclick={() => (ui.tool = ui.tool === t ? null : t)} data-testid="tool-{t}" title={tip}>
      <Icon size={20} />
      <span class="flex flex-col items-start">
        <span class="tool-label">{label}</span>
        <Key k={key} />
      </span>
    </button>
  {/each}
  <div class="flex min-w-[220px] flex-1 flex-col justify-center gap-1 px-1">
    <!-- the compass sits to the right of the impact, so the toolbar does not grow taller -->
    <div class="flex items-start gap-x-6">
    <dl class="dl min-w-0 text-[12px]" data-testid="impact-status">
      <dt>Impact</dt>
      {#if impact != null}
        <dd class="num flex flex-wrap items-center gap-x-2" title="The impact lies between the last clean frame at {interval!.a.toFixed(3)} s and the first frame of the impact at {interval!.b.toFixed(3)} s.">
          {impact.toFixed(3)} +/-{impactSigma(interval!).toFixed(3)} s
          <FieldTag kind="impact" {field} onreset={() => field && (field.manual = undefined)} fmt={(v) => `${impactTime(v as never).toFixed(3)} s`} />
        </dd>
        <dt>Before impact</dt><dd class="num">{time < impact ? `${(impact - time).toFixed(3)} s` : '-'}</dd>
      {:else}
        <dd class="text-warn" title="Go to the frame of the explosion and mark it with Impact frame (I).">not marked in this clip</dd>
      {/if}
    </dl>
    <dl class="dl text-[12px]">
      <dt>Compass</dt>
      <!-- a fixed box, so the spinner and the value take the same space. The rows line up on the text baseline, so the
           spinner comes with an invisible character that gives it one, or the row would move while it spins. -->
      <dd class="num inline-flex h-[1.5em] w-[5.5em] items-center whitespace-nowrap" data-testid="compass" title="Backtrack reads this from the compass at the top of the frame. A new sighting takes it as its heading.">
        {#if compass === undefined}<span aria-hidden="true">&#8203;</span><Spinner size={11} />{:else if compass === null}-{:else}{compass} deg{/if}
      </dd>
    </dl>
    </div>
  </div>
  <div class="flex flex-col justify-center gap-1">
    <button class="btn sm" onclick={onimpact} disabled={!ui.clipId} data-testid="mark-impact"><Flame size={13} /> Impact frame <Key k="I" /></button>
    <button class="btn sm" onclick={onclear} disabled={!sighting}><Eraser size={13} /> Clear frame</button>
  </div>
</div>
