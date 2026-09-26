<script lang="ts">
  /**
   * The start of a batch of clips, where the user picks the automatic flow (the windows of SetupDesk.svelte) or marking
   * by hand, which goes to Mark. The batch is the clips picked in the clip list, or else the clip on screen. The pick
   * of the mode stays with each clip of the batch, and this page offers it again.
   */
  import Radar from '@jis3r/icons/icons/radar';
  import Paperclip from '@jis3r/icons/icons/paperclip';
  import SetupDesk from './SetupDesk.svelte';
  import ClipItems from '../ClipItems.svelte';
  import { batchClips, clipInfo, clips, fixShot, project, ui } from '../../lib/state/project.svelte.ts';

  const clipId = $derived(ui.clipId);
  const batch = $derived(batchClips());
  const mode = $derived(clipId ? project.clips[clipId]?.mode : undefined);
  function choose(m: 'auto' | 'manual' | undefined) {
    for (const id of batch) clipInfo(id).mode = m;
    // the selected shot may belong to the other flow
    fixShot();
    if (m === 'manual') ui.phase = 'mark';
  }
</script>

{#if !clips.list.length}
  <div class="card flex h-full flex-col items-center justify-center gap-3 p-8">
    <span class="title text-[44px] text-muted-strong">No clip yet</span>
    <button class="btn primary" onclick={() => (ui.phase = 'record')}>Record or upload a clip</button>
  </div>
{:else if mode === 'auto'}
  <SetupDesk {batch} onback={() => choose(undefined)} />
{:else}
  <div class="flex h-full items-center justify-center p-6">
    <div class="flex w-full max-w-2xl flex-col gap-5">
      <h2 class="title text-[30px] text-text">Select Mode</h2>
      <ClipItems ids={batch} />
      <div class="grid gap-6 sm:grid-cols-2">
        <div class="flex flex-col items-center gap-2 text-center">
          <button class="btn" onclick={() => choose('auto')} data-testid="mode-auto"><Radar size={14} /> Automatic</button>
          <p class="m-0 text-[12.5px] text-copy">Mark where the shots fly on the timeline. Backtrack finds the shell, the camera, the impact and the sighting position, and you check what it found.</p>
        </div>
        <div class="flex flex-col items-center gap-2 text-center">
          <button class="btn" class:picked={mode === 'manual'} onclick={() => choose('manual')} data-testid="mode-manual"><Paperclip size={14} /> Manual</button>
          <p class="m-0 text-[12.5px] text-copy">Mark the shell, the edges and the impact on the frames yourself, and enter the coordinates.</p>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .picked { border-color: var(--accent-border-active); }
</style>
