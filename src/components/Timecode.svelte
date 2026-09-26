<script lang="ts">
  /**
   * A timecode with a hint above it that names the unit of each part. A line runs over the text, with short ticks up at
   * its ends and where the parts meet, and the unit (m, s, ms) stands above each part.
   */
  import { timecode } from './mark/Timeline.svelte';

  let { t }: { t: number } = $props();
  // 00:45.466 gives the minutes, the seconds and the milliseconds
  const parts = $derived(timecode(t, 3).split(/[:.]/));
</script>

<span class="tc num"><span class="part" data-unit="m">{parts[0]}</span><span class="sep">:</span><span class="part" data-unit="s">{parts[1]}</span><span class="sep">.</span><span class="part" data-unit="ms">{parts[2]}</span></span>

<style>
  .tc { position: relative; display: inline-block; padding-top: 13px; line-height: 1; white-space: nowrap; }
  /* the line, with a tick up at each end */
  .tc::before { content: ''; position: absolute; left: 0; right: 0; top: 8px; height: 4px; border: 1px solid var(--line-strong); border-top: 0; }
  .part, .sep { position: relative; }
  /* the tick where two parts meet */
  .sep::before { content: ''; position: absolute; left: 50%; top: -5px; width: 1px; height: 4px; background: var(--line-strong); }
  .part::before {
    content: attr(data-unit); position: absolute; left: 50%; top: -13px; transform: translateX(-50%);
    font: 9px/1 var(--font-small); color: var(--muted); letter-spacing: 0;
  }
</style>
