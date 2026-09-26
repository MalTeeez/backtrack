<script lang="ts">
  /**
   * A zoomed view around the pointer, or around a locked spot (a middle click on the video or the lock button). A
   * click in it places the point with sub-pixel accuracy, and a press on a mark drags it with the same accuracy. The
   * arrows move a locked spot by 0.75 video pixels (7.5 with Shift), which grows on screen with the zoom. The Mark
   * phase gives it the keys: L locks, Z changes the zoom, and Ctrl with the arrows moves the spot. The marks
   * also grow with the zoom, as if drawn on the video.
   */
  import ChevronDown from '@jis3r/icons/icons/chevron-down';
  import ChevronLeft from '@jis3r/icons/icons/chevron-left';
  import ChevronRight from '@jis3r/icons/icons/chevron-right';
  import ChevronUp from '@jis3r/icons/icons/chevron-up';
  import { Lock, LockOpen } from '@lucide/svelte';
  import Key from '../Key.svelte';
  import type { Pt, Sighting } from '../../lib/solver/types.ts';
  import { css, drawMarks, hitMark, type Handle } from './draw.ts';
  import { theme } from '../../lib/state/theme.svelte.ts';

  let {
    video, frame, center, locked, sighting, pending, onpoint, ondrag, onlock, onnudge, zoom = $bindable(8),
  }: {
    video: HTMLVideoElement; frame: number; center: Pt | null; locked: boolean; sighting: Sighting | undefined;
    pending: Pt | null; onpoint: (p: Pt) => void; ondrag: (h: Handle, p: Pt) => void;
    onlock: () => void; onnudge: (dx: number, dy: number) => void; zoom?: number;
  } = $props();

  const nudge = (e: MouseEvent, dx: number, dy: number) => { const k = e.shiftKey ? 7.5 : 0.75; onnudge(dx * k, dy * k); };

  const SIZE = 480; // canvas pixels, shown at half size so the view is sharp on high-DPI screens
  let canvas: HTMLCanvasElement;
  let active = $state<Handle | null>(null);
  let dragging = $state(false);
  let downAt: Pt | null = null;

  /** Canvas pixels per video pixel. */
  const scale = $derived(zoom * (SIZE / 240));

  $effect(() => {
    void frame, theme.current; // the background follows the theme
    const g = canvas.getContext('2d')!;
    g.fillStyle = css('--stage');
    g.fillRect(0, 0, SIZE, SIZE);
    if (center && video.videoWidth) {
      const sw = SIZE / scale, sx = center.x - sw / 2, sy = center.y - sw / 2;
      g.imageSmoothingEnabled = false;
      g.drawImage(video, sx, sy, sw, sw, 0, 0, SIZE, SIZE);
      drawMarks(g, sighting, pending, (p) => ({ x: (p.x - sx) * scale, y: (p.y - sy) * scale }), 2.4 * (zoom / 8), active);
    }
    reticle(g);
  });

  function reticle(g: CanvasRenderingContext2D) {
    const c = SIZE / 2;
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, c); g.lineTo(c - 18, c); g.moveTo(c + 18, c); g.lineTo(SIZE, c);
    g.moveTo(c, 0); g.lineTo(c, c - 18); g.moveTo(c, c + 18); g.lineTo(c, SIZE);
    g.stroke();
  }

  /** The video pixel under the pointer, or null before the pointer was over the video. */
  function toVideo(e: PointerEvent): Pt | null {
    if (!center) return null;
    const r = canvas.getBoundingClientRect();
    const lx = ((e.clientX - r.left) * SIZE) / r.width, ly = ((e.clientY - r.top) * SIZE) / r.height;
    const sw = SIZE / scale;
    return { x: center.x - sw / 2 + lx / scale, y: center.y - sw / 2 + ly / scale };
  }
  // 10 screen pixels, in video pixels
  const tol = () => (10 * SIZE) / canvas.getBoundingClientRect().width / scale;

  function down(e: PointerEvent) {
    if (e.button === 1) { e.preventDefault(); if (locked) onlock(); return; }
    const p = toVideo(e);
    if (e.button !== 0 || !p) return;
    canvas.setPointerCapture(e.pointerId);
    active = hitMark(sighting, p, tol());
    if (active) dragging = true;
    else downAt = p;
  }
  function move(e: PointerEvent) {
    const p = toVideo(e);
    if (!p) return;
    if (dragging && active) ondrag(active, p);
    else active = hitMark(sighting, p, tol());
  }
  function up(e: PointerEvent) {
    const p = toVideo(e);
    if (!dragging && downAt && p) onpoint(p);
    dragging = false;
    downAt = null;
  }
</script>

<div class="flex gap-2">
  <canvas
    bind:this={canvas}
    width={SIZE}
    height={SIZE}
    class="aspect-square w-[min(240px,30vh)] shrink-0 self-start touch-none border {locked ? 'border-accent' : 'border-line'} {active ? 'cursor-move' : 'cursor-crosshair'}"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => { dragging = false; downAt = null; }}
    onmousedown={(e) => { if (e.button === 1) e.preventDefault(); }}
    data-testid="magnifier"
    title="It follows the pointer over the video, and a middle click locks it. Click in it for sub-pixel marks, or drag a mark to move it."
  ></canvas>
  <div class="flex min-w-0 flex-col gap-2">
    <span class="card-title text-[11px]">Magnifier</span>
    <!-- two lines of fixed height, so locking does not move the controls -->
    <span class="num flex h-8 flex-col text-[11px] leading-4 {locked ? 'text-accent' : 'text-muted'}" data-testid="magnifier-status">
      <span class="truncate">{locked ? 'Locked at' : 'Unlocked'}</span>
      <span class="truncate">{locked ? `${center!.x.toFixed(2)}, ${center!.y.toFixed(2)}` : ''}</span>
    </span>
    <span class="label flex items-center gap-1.5">Zoom <Key k="Z" /></span>
    <div class="grid grid-cols-3 gap-1">
      {#each [4, 8, 16] as z}<button class="option justify-center px-1" aria-pressed={zoom === z} onclick={() => (zoom = z)}>{z}x</button>{/each}
    </div>
    <div class="flex flex-col gap-1 text-[11px] text-muted">
      <span class="flex items-center gap-1.5" title="Lock the magnifier where the pointer is, or free it"><Key k="L" /> lock</span>
      <span class="flex items-center gap-1.5" title="Move the locked spot by 0.75 px, or 7.5 px with Shift"><Key k="Ctrl" /> and arrows</span>
    </div>
    <div class="grid w-fit grid-cols-3 gap-1" role="group" aria-label="Move the magnifier">
      <span></span>
      <button class="btn icon sm" aria-label="Move up" title="Move up 0.75 px, or 7.5 px with Shift" disabled={!center} onclick={(e) => nudge(e, 0, -1)}><ChevronUp size={14} /></button>
      <span></span>
      <button class="btn icon sm" aria-label="Move left" title="Move left 0.75 px, or 7.5 px with Shift" disabled={!center} onclick={(e) => nudge(e, -1, 0)}><ChevronLeft size={14} /></button>
      <button class="btn icon sm {locked ? 'primary' : ''}" aria-label={locked ? 'Unlock' : 'Lock'} aria-pressed={locked} title={locked ? 'Unlock, so the magnifier follows the pointer again' : 'Lock at the current spot'} disabled={!center} onclick={onlock} data-testid="magnifier-lock">
        {#if locked}<Lock size={14} />{:else}<LockOpen size={14} />{/if}
      </button>
      <button class="btn icon sm" aria-label="Move right" title="Move right 0.75 px, or 7.5 px with Shift" disabled={!center} onclick={(e) => nudge(e, 1, 0)}><ChevronRight size={14} /></button>
      <span></span>
      <button class="btn icon sm" aria-label="Move down" title="Move down 0.75 px, or 7.5 px with Shift" disabled={!center} onclick={(e) => nudge(e, 0, 1)}><ChevronDown size={14} /></button>
      <span></span>
    </div>
  </div>
</div>
