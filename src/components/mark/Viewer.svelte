<script lang="ts">
  /**
   * The video itself, as large as the space allows. A transparent canvas on it takes the pointer, and the marks and
   * labels go on a second canvas over the whole box at screen resolution, so they stay sharp at any zoom.
   * The <video> element must be on the page, because Chrome stops decoding a playing video that nobody can see. A
   * press on a mark drags it, and a press anywhere else places a point with the active tool. The wheel zooms into the
   * video around the pointer, and a right drag (or a left drag without a tool) pans. A middle click locks the
   * magnifier.
   */
  import Maximize2 from '@jis3r/icons/icons/maximize-2';
  import type { Pt, Sighting } from '../../lib/solver/types.ts';
  import { player } from '../../lib/state/player.svelte.ts';
  import { drawDetection, drawMarks, drawNotes, hitMark, type DetectionView, type Handle, type MarkTarget, type Note, type NoteBox } from './draw.ts';

  let {
    video, frame, sighting, others, copied, impact, pending, tool, lock, notes, detection = null, onpoint, onhover, ondrag, onmiddle, onremove,
  }: {
    video: HTMLVideoElement; frame: number; sighting: Sighting | undefined; pending: Pt | null; tool: boolean;
    /** Sightings of other shots on this frame, drawn faded. */
    others: Sighting[];
    /** Guide lines, drawn dashed. They are the vertical lines that the detection took the pitch from. */
    copied: [Pt, Pt][];
    /** Whether this frame is the impact of a shot. If it is, the viewer gets a red frame. */
    impact: boolean;
    /** What the detection used and found on this frame, drawn under the marks. */
    detection?: DetectionView | null;
    lock: Pt | null; notes: Note[]; onpoint: (p: Pt) => void; onhover: (p: Pt) => void; ondrag: (h: Handle, p: Pt) => void;
    onmiddle: (p: Pt) => void; onremove: (t: MarkTarget) => void;
  } = $props();

  // The zoom is a scale and the screen offset of the video, applied as a CSS transform. The canvas moves with the
  // video, so its bounding box still maps the pointer to video pixels.
  let zoom = $state({ k: 1, ox: 0, oy: 0 });
  let pan: { x: number; y: number; ox: number; oy: number } | null = $state(null);
  let inner: HTMLDivElement;
  const MAX_ZOOM = 16;
  function setZoom(k: number, ox: number, oy: number) {
    ox = Math.max(size.w * (1 - k), Math.min(0, ox));
    oy = Math.max(size.h * (1 - k), Math.min(0, oy));
    // At the cap, nothing updates. The wheel handler must stay cheap, or Firefox scrolls the page before it answers.
    if (k === zoom.k && ox === zoom.ox && oy === zoom.oy) return;
    zoom = { k, ox, oy };
  }
  const wheel = (el: HTMLElement) => {
    const on = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = inner.getBoundingClientRect();
      // the pointer relative to the untransformed video, and the video point under it, which stays under it
      const sx = e.clientX - (r.left - zoom.ox), sy = e.clientY - (r.top - zoom.oy);
      const px = (sx - zoom.ox) / zoom.k, py = (sy - zoom.oy) / zoom.k;
      const k = Math.max(1, Math.min(MAX_ZOOM, zoom.k * (e.deltaY > 0 ? 0.8 : 1.25)));
      setZoom(k, sx - k * px, sy - k * py);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  };

  let canvas: HTMLCanvasElement, over: HTMLCanvasElement, box: HTMLDivElement;
  // the label under the pointer, found in the boxes of the last drawing (in pixels of the overlay)
  let hoverNote = $state<number | null>(null);
  let boxes: NoteBox[] = [];
  /** A pointer position in pixels of the overlay. */
  const onOverlay = (e: MouseEvent): Pt => {
    const r = box.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };
  const noteAt = (p: Pt) => {
    // the hovered label is on top, then the others from the last drawn
    const order = boxes.map((_, i) => i).reverse().sort((a, b) => Number(b === hoverNote) - Number(a === hoverNote));
    return order.find((i) => p.x >= boxes[i].x && p.x <= boxes[i].x + boxes[i].w && p.y >= boxes[i].y && p.y <= boxes[i].y + boxes[i].h) ?? null;
  };
  let boxW = $state(0), boxH = $state(0);
  let active = $state<Handle | null>(null); // the mark under the pointer
  let dragging = $state(false);
  let downAt: Pt | null = null;

  // fit the video into the box with its aspect ratio, because a stretched canvas maps clicks to the wrong pixels
  const size = $derived.by(() => {
    void frame;
    const w = video.videoWidth || 16, h = video.videoHeight || 9;
    const s = Math.min(boxW / w, boxH / h) || 0;
    return { w: Math.floor(w * s), h: Math.floor(h * s) };
  });

  // a new size (a resized window) starts unzoomed
  const sizeKey = $derived(`${size.w}x${size.h}`); // a string, because size is a new object on every frame
  $effect(() => { void sizeKey; zoom = { k: 1, ox: 0, oy: 0 }; });

  // the width of the video on the screen, for the size of the frames the player keeps for its steps
  $effect(() => { if (size.w) player.viewPx = Math.round(size.w * (window.devicePixelRatio || 1)); });
  const drawPreview = (c: HTMLCanvasElement) => {
    $effect(() => {
      const p = player.preview;
      if (!p) return;
      if (c.width !== p.bmp.width || c.height !== p.bmp.height) { c.width = p.bmp.width; c.height = p.bmp.height; }
      c.getContext('2d')!.drawImage(p.bmp, 0, 0);
    });
  };
  const mount = (node: HTMLElement) => {
    Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    node.prepend(video);
    // the video may already sit in the viewer of the next page
    return () => { if (video.parentNode === node) video.remove(); };
  };

  // the pointer canvas keeps the size of the video, so its box maps the pointer to video pixels
  $effect(() => {
    void frame;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
  });

  // The marks and labels go on the overlay at screen resolution. A video point goes through the fit, the pan and the
  // zoom to its place on screen, and lines and text keep their screen size.
  $effect(() => {
    void frame;
    const w = video.videoWidth, dpr = window.devicePixelRatio || 1;
    const W = Math.round(boxW * dpr), H = Math.round(boxH * dpr);
    if (over.width !== W || over.height !== H) { over.width = W; over.height = H; }
    const g = over.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    if (!w || !size.w) return;
    // The video sits in the middle of the box (place-items-center), so its offset needs no layout of the page.
    const sc = (size.w / w) * zoom.k, left = (boxW - size.w) / 2 + zoom.ox, top = (boxH - size.h) / 2 + zoom.oy;
    const T = (p: Pt): Pt => ({ x: (left + p.x * sc) * dpr, y: (top + p.y * sc) * dpr });
    const lw = 1.25 * dpr;
    if (detection) drawDetection(g, detection, T, dpr, w, video.videoHeight);
    g.globalAlpha = 0.55;
    for (const o of others) drawMarks(g, o, null, T, lw);
    g.globalAlpha = 1;
    if (copied.length) {
      g.setLineDash([6 * lw, 4 * lw]);
      drawMarks(g, { edges: copied } as Sighting, null, T, lw);
      g.setLineDash([]);
    }
    drawMarks(g, sighting, pending, T, lw, active);
    if (lock) {
      // The locked magnifier spot covers 30 video pixels.
      const a = T({ x: lock.x - 15, y: lock.y - 15 }), b = T({ x: lock.x + 15, y: lock.y + 15 });
      g.strokeStyle = '#ffffff'; g.lineWidth = lw; g.setLineDash([4 * lw, 3 * lw]);
      g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      g.setLineDash([]);
    }
    // a mark out of view (zoomed in) gets no label, instead of one pushed to the edge
    boxes = drawNotes(g, notes.map((n) => { const at = T(n.at); return { ...n, at, hidden: at.x < 0 || at.y < 0 || at.x > W || at.y > H }; }), dpr, hoverNote != null && hoverNote < notes.length ? hoverNote : null);
  });

  const toVideo = (e: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };
  // 10 screen pixels, in video pixels
  const tol = () => (10 * canvas.width) / canvas.getBoundingClientRect().width;

  function down(e: PointerEvent) {
    if (e.button === 1) { e.preventDefault(); onmiddle(toVideo(e)); return; }
    const p = toVideo(e), o = onOverlay(e);
    // the remove button of the hovered label
    const x = hoverNote != null ? boxes[hoverNote]?.remove : undefined;
    if (e.button === 0 && x && o.x >= x.x && o.x <= x.x + x.w && o.y >= x.y && o.y <= x.y + x.h) {
      onremove(notes[hoverNote!].target);
      hoverNote = null;
      return;
    }
    const hit = e.button === 0 ? hitMark(sighting, p, tol()) : null;
    if (e.button === 2 || (e.button === 0 && !tool && !hit && zoom.k > 1)) {
      canvas.setPointerCapture(e.pointerId);
      pan = { x: e.clientX, y: e.clientY, ox: zoom.ox, oy: zoom.oy };
      return;
    }
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    active = hit;
    if (active) dragging = true;
    else downAt = p;
  }
  function move(e: PointerEvent) {
    if (pan) { setZoom(zoom.k, pan.ox + e.clientX - pan.x, pan.oy + e.clientY - pan.y); return; }
    const p = toVideo(e);
    onhover(p);
    const n = noteAt(onOverlay(e));
    if (n !== hoverNote) hoverNote = n;
    if (dragging && active) ondrag(active, p);
    else active = hitMark(sighting, p, tol());
  }
  function up(e: PointerEvent) {
    if (pan) { pan = null; return; }
    if (!dragging && downAt) onpoint(toVideo(e));
    dragging = false;
    downAt = null;
  }
</script>

<div class="relative grid h-full w-full place-items-center overflow-hidden bg-stage" bind:this={box} bind:clientWidth={boxW} bind:clientHeight={boxH} {@attach wheel}>
  <div
    bind:this={inner}
    class="relative origin-top-left"
    style="width:{size.w}px; height:{size.h}px; transform:translate({zoom.ox}px, {zoom.oy}px) scale({zoom.k}); will-change:transform"
    {@attach mount}
  >
    <!-- the preview of the frame a seek goes to, over the video until the video shows it (player.svelte.ts) -->
    <canvas class="pointer-events-none absolute inset-0 block h-full w-full" hidden={!player.preview} {@attach drawPreview}></canvas>
    <canvas
      bind:this={canvas}
      class="absolute inset-0 block h-full w-full touch-none {pan ? 'cursor-grabbing' : active ? 'cursor-move' : tool ? 'cursor-crosshair' : zoom.k > 1 ? 'cursor-grab' : ''}"
      data-testid="viewer"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={() => { dragging = false; downAt = null; pan = null; }}
      onpointerleave={() => (hoverNote = null)}
      onmousedown={(e) => { if (e.button === 1) e.preventDefault(); }}
      oncontextmenu={(e) => e.preventDefault()}
    ></canvas>
    <!-- The impact frame gets a red frame on the video itself. It zooms with the video, so its width divides by the zoom. -->
    {#if impact}<div class="pointer-events-none absolute inset-0 border-[#e5484d]" style="border-width:{4 / zoom.k}px" data-testid="impact-frame"></div>{/if}
  </div>
  <canvas bind:this={over} class="pointer-events-none absolute inset-0 block h-full w-full"></canvas>
  {#if zoom.k > 1}
    <div class="absolute right-2 top-2 flex items-center gap-1.5 border border-line bg-panel px-1.5 py-1 text-[11px] text-muted">
      <span class="num text-text" title="The wheel zooms, and a right drag pans.">{zoom.k.toFixed(1)}x</span>
      <button class="btn sm" onclick={() => (zoom = { k: 1, ox: 0, oy: 0 })} data-testid="video-zoom-reset"><Maximize2 size={12} /> Reset zoom</button>
    </div>
  {/if}
</div>
