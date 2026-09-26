<script module lang="ts">
  let dialog: HTMLDialogElement | undefined = $state();
  /** Opens the settings as a modal dialog. The dialog takes the focus, and Escape closes it. */
  export const openSettings = () => dialog?.showModal();
</script>

<script lang="ts">
  /**
   * The settings of the user, as a modal dialog. They hold the field of view of the game, which every angle and the
   * stabilization depend on. They stay in this browser for every project (prefs.svelte.ts).
   */
  import X from '@jis3r/icons/icons/x';
  import { FOV_RANGE, prefs, setPrefs } from '../lib/state/prefs.svelte.ts';

  // the dialog edits a copy. Save keeps it, and Escape and Cancel drop it.
  let fov = $state(prefs.fovDeg), axis = $state(prefs.fovAxis);
  const valid = $derived(Number.isFinite(fov) && fov >= FOV_RANGE.min && fov <= FOV_RANGE.max);
  const reset = () => { fov = prefs.fovDeg; axis = prefs.fovAxis; };

  function save(e: SubmitEvent) {
    e.preventDefault();
    if (!valid) return;
    setPrefs({ fovDeg: fov, fovAxis: axis });
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="card m-auto w-[min(440px,calc(100vw-2rem))] p-0 text-text backdrop:bg-black/50" onclose={reset} data-testid="settings-dialog">
  <form class="flex flex-col" onsubmit={save}>
    <header class="card-head">
      <h2 class="card-title">Settings</h2>
      <button type="button" class="btn icon sm ml-auto" aria-label="Close" onclick={() => dialog?.close()}><X size={13} /></button>
    </header>
    <div class="card-body flex flex-col gap-3">
      <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
        <legend class="label mb-1">Game</legend>
        <label class="flex flex-col gap-1" title="The field of view in the settings of the game. Every angle and the stabilization depend on it.">
          <span class="label">Field of view (deg)</span>
          <input class="control num" type="number" min={FOV_RANGE.min} max={FOV_RANGE.max} step="1" bind:value={fov} data-testid="fov-input" />
        </label>
        <div class="grid grid-cols-2 gap-1" role="group" aria-label="FOV type">
          <button type="button" class="option justify-center px-1" aria-pressed={axis === 'h'} onclick={() => (axis = 'h')}>Horizontal</button>
          <button type="button" class="option justify-center px-1" aria-pressed={axis === 'v'} onclick={() => (axis = 'v')}>Vertical</button>
        </div>
        {#if !valid}<p class="note warn m-0">The FOV must lie between {FOV_RANGE.min} and {FOV_RANGE.max} deg.</p>{/if}
      </fieldset>
      <p class="m-0 text-[11.5px] text-muted">These settings stay in this browser for every project.</p>
    </div>
    <footer class="flex justify-end gap-2 border-t border-line p-2">
      <button type="button" class="btn sm" onclick={() => dialog?.close()}>Cancel</button>
      <button type="submit" class="btn sm primary" disabled={!valid} data-testid="settings-save">Save</button>
    </footer>
  </form>
</dialog>
