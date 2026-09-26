<script lang="ts">
  /**
   * Sets the map imagery of every map, from the bottom right of a map: the style as a select, like the select of the
   * map at the bottom left, and the opacity under it. Both bottom corners line up.
   */
  import Contrast from '@jis3r/icons/icons/contrast';
  import { Mountain, Palette } from '@lucide/svelte';
  import { setTiles, TILE_STYLES, tiles, type TileStyle } from '../lib/map/tiles.svelte.ts';
  import Dropdown from './Dropdown.svelte';
  import ThinSlider from './ThinSlider.svelte';

  // a moving icon where one exists, else the Lucide one
  const ICONS = { color: Palette, gray: Contrast, topo: Mountain } as const;
  const options = Object.entries(TILE_STYLES).map(([s, label]) => [s, label, ICONS[s as TileStyle]]) as [TileStyle, string, (typeof ICONS)[TileStyle]][];
</script>

<div class="flex w-36 flex-col gap-1">
  <Dropdown full label="Map style" value={tiles.style} onchange={(s) => setTiles({ style: s })} {options} testid="map-style" />
  <div class="flex h-8 items-center gap-1.5 border border-line bg-panel px-1.5 text-[11px] text-muted">
    Opacity
    <ThinSlider label="Map opacity" min={5} max={100} step={5} major={50} labels={[]} value={Math.round(tiles.opacity * 100)} onchange={(v) => setTiles({ opacity: v / 100 })} />
    <span class="num w-7 text-right text-text">{Math.round(tiles.opacity * 100)}%</span>
  </div>
</div>
