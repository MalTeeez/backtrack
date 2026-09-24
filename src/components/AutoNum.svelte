<script lang="ts">
  /**
   * A number that Backtrack can detect: the field shows the value the solver uses, typing a value makes it the
   * user's, and emptying the field goes back to the automatic value. FieldTag shows the state.
   */
  import NumInput from './NumInput.svelte';
  import FieldTag from './FieldTag.svelte';
  import { autoValue, type Kind } from '../lib/solver/field.ts';
  import type { Field } from '../lib/solver/types.ts';

  let { field = $bindable(), kind, label, unit = '', step = 'any', min, digits = 2, required = 'required' }: {
    field: Field<number>; kind: Kind; label: string; unit?: string; step?: number | 'any'; min?: number;
    /** Decimals of the automatic value. */
    digits?: number;
    /** The text of the state without a value, for a value that has a fallback. */
    required?: string;
  } = $props();

  const round = (v: number) => Math.round(v * 10 ** digits) / 10 ** digits;
  const shown = $derived(field.manual ?? (autoValue(field) != null ? round(autoValue(field)!) : undefined));
</script>

<div class="flex min-w-0 flex-col gap-0.5">
  <NumInput {label} {unit} {step} {min} placeholder={field.auto?.value != null ? String(round(field.auto.value)) : required}
    bind:value={() => shown, (v) => (field.manual = v)} />
  <FieldTag {kind} {field} {required} onreset={() => (field.manual = undefined)} fmt={(v) => `${round(v as number)}${unit ? ` ${unit}` : ''}`} />
</div>
