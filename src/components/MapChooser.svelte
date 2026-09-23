<script lang="ts">
  /**
   * Picks the map of the project. `big` is the prompt in the middle of a map without one, because a map without its
   * image is of no use. Otherwise it is a small select that changes the map.
   */
  import { MAPS } from '../lib/map/tiles.svelte.ts';
  import { project } from '../lib/state/project.svelte.ts';
  import type { MapId } from '../lib/solver/types.ts';

  let { big = false }: { big?: boolean } = $props();
</script>

{#if big}
  <div class="absolute inset-0 grid place-items-center bg-[var(--bg)]/70 p-4">
    <div class="card flex max-w-md flex-col items-center gap-3 p-5 text-center">
      <span class="title text-[22px] text-text" title="The map shows its image and the solver uses its terrain once you pick it.">Which map is it?</span>
      <div class="flex flex-wrap justify-center gap-2" data-testid="map-choice">
        {#each Object.entries(MAPS) as [id, name]}
          <button class="btn primary" onclick={() => (project.settings.map = id as MapId)}>{name}</button>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <select class="control h-8 w-full py-0 text-[11px]" aria-label="Map" bind:value={() => project.settings.map ?? '', (v) => (project.settings.map = (v || undefined) as MapId | undefined)}>
    {#each Object.entries(MAPS) as [id, name]}<option value={id}>{name}</option>{/each}
    <option value="">No map</option>
  </select>
{/if}
