<script lang="ts">
  /**
   * The map imagery of every map, for the bottom right of a map: the styles stacked as icon buttons, and the opacity
   * in one row as tall as the map select, so both bottom corners line up.
   */
  import { Contrast, Mountain, Palette } from '@lucide/svelte';
  import { setTiles, TILE_STYLES, tiles, type TileStyle } from '../lib/map/tiles.svelte.ts';

  const ICONS: Record<TileStyle, typeof Palette> = { color: Palette, gray: Contrast, topo: Mountain };
</script>

<div class="flex w-36 flex-col gap-1">
  <div class="flex flex-col gap-px border border-line bg-panel p-px" role="group" aria-label="Map style">
    {#each Object.entries(TILE_STYLES) as [s, label]}
      {@const Icon = ICONS[s as TileStyle]}
      <button class="option min-h-0 w-full justify-start gap-1.5 px-1.5 py-1 text-[11px]" aria-pressed={tiles.style === s} onclick={() => setTiles({ style: s as TileStyle })}>
        <Icon size={13} />{label}
      </button>
    {/each}
  </div>
  <label class="flex h-8 items-center gap-1.5 border border-line bg-panel px-1.5 text-[11px] text-muted">
    Opacity
    <input
      type="range" min="0.05" max="1" step="0.05" class="min-w-0 flex-1" aria-label="Map opacity"
      value={tiles.opacity} oninput={(e) => setTiles({ opacity: e.currentTarget.valueAsNumber })}
    />
    <span class="num w-7 text-right text-text">{Math.round(tiles.opacity * 100)}%</span>
  </label>
</div>
