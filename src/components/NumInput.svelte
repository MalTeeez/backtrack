<script lang="ts">
  /**
   * A number field. While the user types, the field keeps its text, an empty one included. An optional field turns
   * empty into undefined ("not known yet"). A required field keeps its last number and shows it again on blur.
   */
  let {
    value = $bindable(),
    label,
    step = 'any',
    min,
    placeholder = '',
    unit = '',
    required = false,
    testid,
  }: {
    value: number | undefined; label: string; step?: number | 'any'; min?: number; placeholder?: string; unit?: string;
    required?: boolean; testid?: string;
  } = $props();

  function input(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    if (el.value === '') { if (!required) value = undefined; return; }
    if (Number.isFinite(el.valueAsNumber)) value = el.valueAsNumber;
  }
  // after an empty or invalid edit, show the number the field really holds
  const blur = (e: FocusEvent & { currentTarget: HTMLInputElement }) => { e.currentTarget.value = value == null ? '' : String(value); };
</script>

<label class="flex min-w-0 flex-col gap-1">
  <span class="label truncate">{label}{#if unit}{' '}<span class="normal-case tracking-normal">({unit})</span>{/if}</span>
  <input class="control" type="number" {step} {min} {placeholder} data-testid={testid} value={value ?? ''} oninput={input} onblur={blur} />
</label>
