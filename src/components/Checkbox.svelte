<script lang="ts">
  /**
   * A square checkbox with its label, in place of the checkbox of the browser. With `onpick`, the page decides what a
   * click does (a Shift click that picks a range, for example), and `checked` only shows the state.
   */
  import type { Snippet } from 'svelte';
  import Check from '@jis3r/icons/icons/check';

  let { checked = $bindable(), children, label, testid, onpick }: {
    checked: boolean; children?: Snippet; testid?: string;
    /** The name of a checkbox without a visible label. */
    label?: string;
    onpick?: (e: MouseEvent) => void;
  } = $props();
</script>

<button class="cb" role="checkbox" aria-checked={checked} aria-label={label} onclick={(e) => (onpick ? onpick(e) : (checked = !checked))} data-testid={testid}>
  <span class="box" class:on={checked}>{#if checked}<Check size={11} />{/if}</span>
  {#if children}<span class="text">{@render children()}</span>{/if}
</button>

<style>
  .cb { display: inline-flex; align-items: center; gap: 8px; text-align: left; color: var(--copy); }
  .box { flex: none; width: 14px; height: 14px; display: grid; place-items: center; border: 1px solid var(--line-strong); background: var(--panel-solid); color: var(--panel-solid); transition: background 140ms ease, border-color 140ms ease; }
  .box.on { background: var(--accent); border-color: var(--accent); }
  .cb:hover .box { border-color: var(--accent-border-active); }
  .cb:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
</style>
