<script lang="ts">
  import type { Snippet } from 'svelte';
  /** An "i" button that opens its content in a native popover. */
  let { children, label = 'Explain', w = 380 }: { children: Snippet; label?: string; w?: number } = $props();
  const id = `pop${Math.random().toString(36).slice(2, 9)}`;
</script>

<button type="button" class="info-btn" popovertarget={id} aria-label={label} title={label}>i</button>
<div {id} popover="auto" class="pop" style="--w:{w}px">
  <div class="card-title mb-3 text-accent">{label}</div>
  {@render children()}
</div>
