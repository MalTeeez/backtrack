<script lang="ts">
  /** An eye that leaves a sighting or a shot out of the calculation and takes it back, to test what it changes. */
  import { Eye, EyeOff } from '@lucide/svelte';

  let { target, what }: { target: { excluded?: boolean }; what: string } = $props();
</script>

<button
  class="shrink-0 {target.excluded ? 'text-warn' : 'text-muted hover:text-text'}"
  aria-pressed={!target.excluded}
  aria-label={target.excluded ? `Use ${what} in the calculation` : `Leave ${what} out of the calculation`}
  title={target.excluded ? `Left out of the calculation. Click to use ${what} again.` : `Used in the calculation. Click to leave ${what} out and see what changes.`}
  onclick={() => (target.excluded = !target.excluded || undefined)}
>
  {#if target.excluded}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
</button>
