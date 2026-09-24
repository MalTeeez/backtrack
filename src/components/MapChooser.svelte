<script lang="ts">
  /**
   * Picks a map. `big` is the prompt over a view without one: the question when marking starts (automation plan
   * section 4), with the detected map first when there is one. Otherwise it is a small select.
   */
  import { MAPS } from '../lib/map/tiles.svelte.ts';
  import type { Detected, MapId } from '../lib/solver/types.ts';

  let { value, onpick, big = false, auto, onskip, searching = false }: {
    value: MapId | undefined; onpick: (id: MapId | undefined) => void; big?: boolean;
    /** The minimap search is still running. */
    searching?: boolean;
    /** What the minimap search found, shown first with its confidence. */
    auto?: Detected<MapId>;
    /** The prompt can be closed without a map. */
    onskip?: () => void;
  } = $props();

  const order = $derived(Object.entries(MAPS).sort(([a], [b]) => Number(b === auto?.value) - Number(a === auto?.value)) as [MapId, string][]);
</script>

{#if big}
  <div class="absolute inset-0 z-10 grid place-items-center bg-[var(--bg)]/70 p-4">
    <div class="card flex max-w-md flex-col items-center gap-3 p-5 text-center">
      <span class="title text-[22px] text-text" title="The maps show its image and the solver uses its terrain once you pick it.">Which map is it?</span>
      {#if searching}<span class="text-[12px] text-muted">Looking at the minimap...</span>{:else if auto && !auto.value}<span class="text-[12px] text-muted">The minimap did not show the map clearly.</span>{/if}
      <div class="flex flex-wrap justify-center gap-2" data-testid="map-choice">
        {#each order as [id, name]}
          <button class="btn {id === auto?.value ? 'primary' : ''}" onclick={() => onpick(id)} title={id === auto?.value ? `Found in the minimap, ${Math.round(auto.conf * 100)} percent sure` : undefined}>
            {name}{#if id === auto?.value}{' '}<span class="text-[11px] opacity-80">auto {Math.round(auto.conf * 100)}%</span>{/if}
          </button>
        {/each}
      </div>
      {#if onskip}<button class="btn sm" onclick={onskip}>Not now</button>{/if}
    </div>
  </div>
{:else}
  <select class="control h-8 w-full py-0 text-[11px]" aria-label="Map" bind:value={() => value ?? '', (v) => onpick((v || undefined) as MapId | undefined)}>
    {#each Object.entries(MAPS) as [id, name]}<option value={id}>{name}{id === auto?.value ? ' (auto)' : ''}</option>{/each}
    <option value="">No map</option>
  </select>
{/if}
