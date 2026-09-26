<script lang="ts">
  /** A keyboard shortcut as key caps, for example "Shift+Left". The arrow keys show as arrows. */
  import ArrowDown from '@jis3r/icons/icons/arrow-down';
  import ArrowLeft from '@jis3r/icons/icons/arrow-left';
  import ArrowRight from '@jis3r/icons/icons/arrow-right';
  import ArrowUp from '@jis3r/icons/icons/arrow-up';

  let { k }: { k: string } = $props();
  const ARROWS = { Left: ArrowLeft, Right: ArrowRight, Up: ArrowUp, Down: ArrowDown } as const;
</script>

<span class="inline-flex items-center gap-0.5" aria-hidden="true">
  {#each k.split('+') as key}
    {@const Arrow = ARROWS[key as keyof typeof ARROWS]}
    <kbd>{#if Arrow}<Arrow size={10} />{:else}{key}{/if}</kbd>
  {/each}
</span>
