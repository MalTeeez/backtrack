<script module lang="ts">
  import { importClip } from '../../lib/capture/importClip.ts';
  import { RollingRecorder } from '../../lib/capture/rollingRecorder.ts';
  import { saveClip } from '../../lib/state/persistence.ts';
  import { clips, project, ui } from '../../lib/state/project.svelte.ts';
  import type { Clip } from '../../lib/solver/types.ts';

  // module scope keeps the buffer recording while the user is in another phase
  const status = $state({ active: false, seconds: 0, note: '', error: '' });

  async function add(clip: Clip) {
    await saveClip(clip);
    const { blob, frames: _f, ...meta } = clip;
    clips.list = [{ ...meta, bytes: blob.size }, ...clips.list];
    ui.clipId ??= meta.id;
  }

  const rec = new RollingRecorder({
    bufferS: project.settings.bufferS,
    bitrateMbps: project.settings.bitrateMbps,
    onStatus: () => { status.active = rec.active; status.seconds = rec.seconds; },
    onError: (m) => (status.error = m),
    onClip: (blob, s) => {
      const n = clips.list.filter((c) => c.source === 'buffer').length + 1;
      importClip(blob, `Clip ${n} (${s} s)`, 'buffer')
        .then(add)
        .then(() => (status.note = 'Clip saved.'))
        .catch((e) => (status.error = e.message));
    },
  });
</script>

<script lang="ts">
  import { Circle, Download, Save, Square, Trash2, Upload } from '@lucide/svelte';
  import { applyAnnotation, baseName, downloadClip, isAnnotationFile, readAnnotation } from '../../lib/capture/clipFiles.ts';
  import NumInput from '../NumInput.svelte';
  import Spinner from '../Spinner.svelte';
  import { canCapture } from '../../lib/capture/rollingRecorder.ts';
  import { deleteClip, dropClipUrl, renameClip } from '../../lib/state/persistence.ts';
  import { CAPTURE_FPS, forgetClip, newShot, uid } from '../../lib/state/project.svelte.ts';
  import { forgetStrip } from '../mark/Timeline.svelte';
  import { clipThumb, forgetThumb } from '../../lib/video/clipThumbs.svelte.ts';
  import { clearHistory } from '../../lib/state/history.svelte.ts';
  import type { ClipMeta } from '../../lib/solver/types.ts';

  const st = project.settings;
  let over = $state(false);
  let busy = $state(0);
  let confirmDelete: string | null = $state(null);
  const captureOk = canCapture();
  $effect(() => { rec.bufferS = st.bufferS; rec.bitrateMbps = st.bitrateMbps; });

  async function start() {
    status.error = status.note = '';
    try {
      await rec.start(CAPTURE_FPS);
    } catch (e) {
      const err = e as Error;
      status.error = err.name === 'NotAllowedError'
        ? 'The browser did not allow screen capture. If this page blocks screen capture, upload a clip instead.'
        : `The recording could not start (${err.message}).`;
    }
  }
  function saveBuffer() {
    status.note = rec.save() ? 'Saving...' : 'The buffer is still empty. Wait a second.';
  }

  /**
   * Imports videos and annotation files together. An annotation file belongs to the video of the same file name, or
   * to a clip with the name it records, from this upload or from earlier.
   */
  async function upload(files: FileList | null | undefined) {
    status.error = status.note = '';
    const list = [...(files ?? [])];
    const errors: string[] = [], notes: string[] = [];
    const added = new Map<string, ClipMeta>(); // base file name -> clip
    busy++;
    try {
      for (const f of list.filter((f) => !isAnnotationFile(f))) {
        try {
          const clip = await importClip(f, f.name, 'upload');
          await add(clip);
          added.set(baseName(f.name).toLowerCase(), clips.list.find((c) => c.id === clip.id)!);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      for (const f of list.filter(isAnnotationFile)) {
        try {
          const a = await readAnnotation(f);
          const clip = added.get(baseName(f.name).toLowerCase())
            ?? [...added.values()].find((c) => baseName(c.name) === baseName(a.clip.name))
            ?? clips.list.find((c) => c.name === a.clip.name);
          if (!clip) throw new Error(`${f.name} has no video. Upload it together with ${a.clip.name}.`);
          if (added.has(baseName(f.name).toLowerCase()) && clip.name !== a.clip.name) rename(clip, a.clip.name);
          notes.push(...applyAnnotation(project, clip.id, a, { uid, shot: newShot }, clip));
          notes.push(`${f.name}: ${a.sightings.length} sighting(s) added to ${clip.name}.`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    } finally {
      busy--;
    }
    status.error = errors.join(' ');
    status.note = notes.join(' ');
  }

  function rename(c: ClipMeta, name: string) {
    c.name = name;
    renameClip(c.id, name);
  }
  async function remove(c: ClipMeta) {
    await deleteClip(c.id);
    dropClipUrl(c.id);
    forgetStrip(c.id);
    forgetThumb(c.id);
    clearHistory();
    forgetClip(c.id);
    confirmDelete = null;
  }
  function download(c: ClipMeta) {
    status.error = '';
    return downloadClip($state.snapshot(project), $state.snapshot(c)).catch((e) => (status.error = e.message));
  }
  // one after another, so the browser keeps each download
  async function downloadAll() {
    for (const c of clips.list) {
      await download(c);
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  const uses = (id: string) => project.sightings.filter((s) => s.clipId === id).length;
  /** A file size in MB, or in kB below 1 MB. */
  const fmtBytes = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
  const fmtLen = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}` : '-');
</script>

<div class="grid h-full min-h-0 gap-2 lg:grid-cols-[minmax(340px,440px)_minmax(0,1fr)]">
  <div class="flex min-h-0 flex-col gap-2">
    <section class="card">
      <header class="card-head">
        <h2 class="card-title">Rolling buffer</h2>
        <span class="card-meta" data-testid="rec-status">
          <span class="inline-block h-2 w-2 {status.active ? 'animate-pulse bg-bad' : 'bg-line-strong'}"></span>
          {#if status.active}Recording, <span class="num text-text">{status.seconds}</span> s{:else}Idle{/if},
          <span class="num text-text">{clips.list.length}</span> clips
        </span>
      </header>
      <div class="card-body flex flex-col gap-3">
        {#if captureOk}
          <div class="grid grid-cols-2 gap-2">
            {#if status.active}
              <button class="btn" onclick={() => rec.stop()} data-testid="rec-stop"><Square size={13} /> Stop</button>
            {:else}
              <button class="btn primary" onclick={start} data-testid="rec-start" title="Share the game window. The app keeps the last {st.bufferS} s."><Circle size={13} /> Record</button>
            {/if}
            <button class="btn" disabled={!status.active} onclick={saveBuffer} data-testid="rec-save" title="After a shell lands, save the last {st.bufferS} s. Saving and stopping both end the screen share."><Save size={13} /> Save clip</button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <NumInput required label="Keep last" unit="s" min={5} step={1} bind:value={() => st.bufferS, (v) => (st.bufferS = Math.max(5, v!))} testid="buffer-s" />
            <NumInput required label="Quality" unit="Mbit/s" min={1} step={1} bind:value={() => st.bitrateMbps, (v) => (st.bitrateMbps = Math.max(1, v!))} />
          </div>
        {:else}
          <p class="note warn">This browser cannot record the screen here. Record with Game Bar, OBS, ShadowPlay or ReLive and upload the clip.</p>
        {/if}
        {#if status.note}<p class="note ok" data-testid="rec-note">{status.note}</p>{/if}
        {#if status.error}<p class="note bad" role="alert">{status.error}</p>{/if}
      </div>
    </section>

    <section class="card flex min-h-0 flex-1 flex-col">
      <header class="card-head"><h2 class="card-title">Upload</h2></header>
      <div class="card-body flex flex-1 flex-col gap-2">
        <label
          title="WebM or MP4, from Game Bar, OBS, ShadowPlay or ReLive. Add a .backtrack.json file to import its marks. The videos stay on this computer."
          class="drop flex-1"
          class:is-over={over}
          ondragover={(e) => { e.preventDefault(); over = true; }}
          ondragleave={() => (over = false)}
          ondrop={(e) => { e.preventDefault(); over = false; upload(e.dataTransfer?.files); }}
        >
          {#if busy}<Spinner size={20} />{:else}<Upload size={20} />{/if}
          <span class="font-small text-[12px] uppercase tracking-[0.1em]">{busy ? 'Reading...' : 'Drop videos or click'}</span>
          <input type="file" accept="video/*,.json,application/json" multiple class="sr-only" data-testid="upload" onchange={(e) => { upload(e.currentTarget.files); e.currentTarget.value = ''; }} />
        </label>
      </div>
    </section>
  </div>

  <section class="card flex min-h-0 flex-col">
    <header class="card-head">
      <h2 class="card-title">Clips</h2>
      <span class="card-meta">
        kept in this browser
        {#if clips.list.length}<button class="btn sm" onclick={downloadAll} title="Each clip as its video, and its marks as a .backtrack.json file"><Download size={12} /> Download all</button>{/if}
      </span>
    </header>
    {#if clips.list.length}
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="table" data-testid="clip-list">
          <thead><tr><th></th><th>Name</th><th>Source</th><th>Length</th><th>Resolution</th><th>Size</th><th>Date</th><th>Sightings</th><th></th></tr></thead>
          <tbody>
            {#each clips.list as c (c.id)}
              <tr>
                <td class="py-1">
                  <button class="block h-12 w-[85px] shrink-0 overflow-hidden border border-line bg-stage" title="Mark this clip" aria-label="Mark {c.name}" onclick={() => { ui.clipId = c.id; ui.phase = 'mark'; }}>
                    {#if clipThumb(c.id, c.durationS)}<img src={clipThumb(c.id, c.durationS)} alt="" class="h-full w-full object-cover" draggable="false" />{/if}
                  </button>
                </td>
                <td class="w-full min-w-48"><input class="control" value={c.name} aria-label="Clip name" onchange={(e) => rename(c, e.currentTarget.value)} /></td>
                <td><span class="tag {c.source === 'buffer' ? 'accent' : ''}">{c.source === 'buffer' ? 'Buffer' : 'Upload'}</span></td>
                <td class="num">{fmtLen(c.durationS)}</td>
                <td class="num">{c.width}x{c.height}</td>
                <td class="num">{c.bytes != null ? fmtBytes(c.bytes) : '-'}</td>
                <td class="num text-muted">{new Date(c.createdAt).toLocaleString()}</td>
                <td class="num">{uses(c.id)}</td>
                <td class="text-right">
                  <span class="inline-flex gap-1.5">
                    <button class="btn sm" onclick={() => { ui.clipId = c.id; ui.phase = 'mark'; }}>Mark</button>
                    <button class="btn icon sm" aria-label="Download {c.name}" title="Download the video, and the marks if there are any" onclick={() => download(c)}><Download size={13} /></button>
                    {#if confirmDelete === c.id}
                      <button class="btn sm danger" onclick={() => remove(c)}>Delete{uses(c.id) ? ` with ${uses(c.id)} sightings` : ''}</button>
                      <button class="btn sm" onclick={() => (confirmDelete = null)}>Keep</button>
                    {:else}
                      <button class="btn icon sm" aria-label="Delete clip" onclick={() => (confirmDelete = c.id)}><Trash2 size={13} /></button>
                    {/if}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <span class="title text-[40px] text-muted-strong">No clips yet</span>
        <span class="text-muted">Record a shot with the buffer, or upload a video.</span>
      </div>
    {/if}
  </section>
</div>
