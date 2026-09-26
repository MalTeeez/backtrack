<script lang="ts">
  /** The clips a page works on, one item each: the thumbnail, the name, the length, the size and where it came from. */
  import { clipThumb } from '../lib/video/clipThumbs.svelte.ts';
  import { clips } from '../lib/state/project.svelte.ts';
  import { timecode } from './mark/Timeline.svelte';
  import type { Id } from '../lib/solver/types.ts';

  let { ids }: { ids: Id[] } = $props();
  const list = $derived(ids.flatMap((id) => clips.list.filter((c) => c.id === id)));
</script>

<ul class="items" data-testid="clip-items">
  {#each list as c (c.id)}
    <li class="item">
      <span class="thumb">{#if clipThumb(c.id, c.durationS)}<img src={clipThumb(c.id, c.durationS)} alt="" draggable="false" />{/if}</span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-[13px] text-text">{c.name}</span>
        <span class="num text-[11.5px] text-muted">{timecode(c.durationS, 1)}, {c.width} x {c.height}, {c.source === 'buffer' ? 'recorded' : 'uploaded'}</span>
      </span>
    </li>
  {/each}
</ul>

<style>
  .items { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .item { display: flex; align-items: center; gap: 12px; padding: 6px 10px 6px 6px; border: 1px solid var(--line); background: var(--panel-solid); }
  .thumb { flex: none; width: 96px; height: 54px; overflow: hidden; border: 1px solid var(--line); background: var(--stage); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
</style>
