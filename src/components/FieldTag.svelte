<script lang="ts">
  /**
   * The state of a value that Backtrack can detect (automation plan section 2): automatic with its confidence,
   * required with the reason, or manual with the automatic value next to it, a warning when they differ, and a
   * button that goes back to the automatic value.
   */
  import { RotateCcw } from '@lucide/svelte';
  import { autoValue, fieldState, fieldWarning, type Kind, type Kinds } from '../lib/solver/field.ts';
  import type { Field } from '../lib/solver/types.ts';

  let { kind, field, fmt, required = 'required', onreset }: {
    kind: Kind; field: Field<Kinds[Kind]> | undefined; fmt: (v: Kinds[Kind]) => string;
    /** The text of the required state. */
    required?: string;
    /** Drops the user's value, so the automatic one counts again. Without it, no reset button. */
    onreset?: () => void;
  } = $props();

  const state = $derived(fieldState(kind, field));
  const auto = $derived(autoValue(field));
  const warning = $derived(fieldWarning(kind, field, fmt));
  const pct = $derived(field?.auto ? Math.round(field.auto.conf * 100) : 0);
</script>

<span class="flex min-w-0 flex-wrap items-center gap-1 text-[11px]" data-testid="field-{kind}" data-state={state}>
  {#if state === 'auto'}
    <span class="tag accent px-1 py-0" title="Found by Backtrack, {pct} percent sure. Type a value to override it.">auto {pct}%</span>
  {:else if state === 'required'}
    <span class="tag warn px-1 py-0" title={field?.auto?.reason ?? (field?.auto ? `Backtrack is only ${pct} percent sure` : 'Backtrack found no value')}>{required}</span>
    {#if field?.auto?.value !== undefined}<span class="num text-muted" title="The automatic value, too unsure to count">({fmt(field.auto.value)}?)</span>{/if}
  {:else}
    <span class="tag {state === 'warned' ? 'warn' : ''} px-1 py-0" title={warning ?? 'Your value'}>{state === 'warned' ? 'differs' : 'manual'}</span>
    {#if auto !== undefined}
      <span class="num truncate text-muted" title={warning ?? `Backtrack found ${fmt(auto)}, ${pct} percent sure`}>auto {fmt(auto)}</span>
      {#if onreset}<button class="text-muted hover:text-accent" aria-label="Use the automatic value" title="Use the automatic value {fmt(auto)}" onclick={onreset}><RotateCcw size={11} /></button>{/if}
    {/if}
  {/if}
</span>
