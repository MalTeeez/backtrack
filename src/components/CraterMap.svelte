<script lang="ts">
  /**
   * Picks a crater on a map in game coordinates: the downloaded map image when there is one, a grid, and the crater
   * with a ring every 500 m of the weapon range and the suspected heading. The wheel zooms, a drag pans, and a click
   * sets the crater X and Y. With `onpick`, a click picks another point instead (where the user stood for a sighting),
   * which the map shows as `observer`.
   */
  import { compassRose, css } from './mark/draw.ts';
  import { drawTiles, mapInfo } from '../lib/map/tiles.svelte.ts';
  import { SOURCE_TOL_DEG } from '../lib/solver/sightings.ts';
  import type { Id, MapId, Shot } from '../lib/solver/types.ts';
  import { theme } from '../lib/state/theme.svelte.ts';
  import { ui } from '../lib/state/project.svelte.ts';
  import MapStyle from './MapStyle.svelte';
  import MapChooser from './MapChooser.svelte';
  import { craterGame } from '../lib/solver/sightings.ts';

  let { viewId, shot, reachM, map, onpick, observer }: {
    /** Where the view is kept (ui.mapViews): the shot for the crater, the sighting for where the user stood. */
    viewId: Id; shot: Shot; reachM: number; map: MapId | undefined;
    onpick?: (p: { x: number; y: number }) => void; observer?: { x?: number; y?: number } | null;
  } = $props();
  const seen = $derived(observer?.x != null && observer?.y != null ? { x: observer.x, y: observer.y } : null);

  let canvas: HTMLCanvasElement;
  let width = $state(0);
  let hover = $state<{ x: number; y: number } | null>(null);
  let tick = $state(0); // bumped when a map tile arrives
  let zoom = $state<string | null>(null); // the tile zoom drawn
  // square, but only as tall as the space from its top to the bottom of the page area, so it fits without a scroll
  let room = $state(window.innerHeight);
  const H = $derived(Math.max(240, Math.min(width, room)));
  const fitArea = (node: HTMLElement) => {
    const area = node.closest('main') ?? document.documentElement;
    const measure = () => {
      const top = node.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
      room = area.clientHeight - top - 24; // 24 px for the padding below the card
    };
    const ro = new ResizeObserver(measure);
    ro.observe(area);
    measure();
    // a map that opens below the fold scrolls into view
    requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => ro.disconnect();
  };

  const crater = $derived(craterGame(shot));
  const info = $derived(map ? mapInfo(map) : Promise.resolve(null));
  let loadedInfo = $state<Awaited<ReturnType<typeof mapInfo>>>(null);
  $effect(() => { let live = true; info.then((i) => { if (live) loadedInfo = i; }); return () => { live = false; }; });

  // the view: center and span (game units across the shorter side). It starts on the crater, wide enough for the
  // weapon range, and the wheel and drags change it.
  const fit = () => ({ cx: seen?.x ?? crater?.x ?? 80, cy: seen?.y ?? crater?.y ?? 80, span: onpick ? 6 : (reachM * 2.2) / 100 || 30 });
  // the map opens where the user left it
  let view = $state(ui.mapViews[viewId] || fit());
  $effect(() => { ui.mapViews[viewId] = { ...view }; });
  const scale = $derived(Math.min(width, H) / view.span); // px per game unit
  const toPx = (x: number, y: number): [number, number] => [width / 2 + (x - view.cx) * scale, H / 2 - (y - view.cy) * scale];
  const toGame = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: view.cx + (e.clientX - r.left - width / 2) / scale, y: view.cy - (e.clientY - r.top - H / 2) / scale };
  };

  $effect(() => {
    void theme.current, tick;
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    zoom = map && loadedInfo ? drawTiles(g, map, loadedInfo, { toPx, pxPerUnit: scale, width, height: H }, () => tick++) : null;
    g.font = `10px 'Commit Mono', monospace`;
    const step = [0.5, 1, 2, 5, 10, 20].find((s) => (width / scale) / s <= 16) ?? 20;
    g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1;
    for (let x = Math.floor((view.cx - width / 2 / scale) / step) * step; x < view.cx + width / 2 / scale; x += step) {
      const [px] = toPx(x, 0); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.fillText(String(+x.toFixed(1)), px + 2, H - 3);
    }
    for (let y = Math.floor((view.cy - H / 2 / scale) / step) * step; y < view.cy + H / 2 / scale; y += step) {
      const [, py] = toPx(0, y); g.beginPath(); g.moveTo(0, py); g.lineTo(width, py); g.stroke(); g.fillText(String(+y.toFixed(1)), 2, py - 2);
    }
    g.strokeStyle = css('--accent'); g.fillStyle = css('--accent'); g.globalAlpha = 0.5;
    if (crater) {
      const [px, py] = toPx(crater.x, crater.y);
      for (let r = 5; r * 100 <= reachM + 1; r += 5) { g.beginPath(); g.arc(px, py, r * scale, 0, 7); g.stroke(); }
      if (shot.sourceDeg != null) {
        // the suspected heading, as a wedge out to the weapon range
        const tol = shot.sourceTolDeg ?? SOURCE_TOL_DEG, r = (reachM / 100) * scale;
        const a = ((shot.sourceDeg - 90) * Math.PI) / 180, t = (tol * Math.PI) / 180;
        g.globalAlpha = 0.15; g.beginPath(); g.moveTo(px, py); g.arc(px, py, r, a - t, a + t); g.closePath(); g.fill();
        g.globalAlpha = 0.8; g.beginPath(); g.moveTo(px, py); g.lineTo(px + r * Math.cos(a), py + r * Math.sin(a)); g.stroke();
      }
      g.globalAlpha = 1;
      compassRose(g, px, py, 60);
      g.fillStyle = css('--impact'); g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, py, 6, 0, 7); g.fill(); g.stroke();
    }
    if (seen) {
      // where the user stood: a triangle, as on the result map
      const [px, py] = toPx(seen.x, seen.y);
      g.fillStyle = css('--accent'); g.strokeStyle = '#000'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, py - 9); g.lineTo(px + 8, py + 6); g.lineTo(px - 8, py + 6); g.closePath(); g.fill(); g.stroke();
    }
  });

  // a press that moves more than 4 px pans. Otherwise it is a click, which sets the crater.
  let press = $state<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  function down(e: PointerEvent) {
    canvas.setPointerCapture(e.pointerId);
    press = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  }
  function move(e: PointerEvent) {
    hover = toGame(e);
    if (!press) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (Math.hypot(dx, dy) > 4) press.moved = true;
    if (press.moved) view = { ...view, cx: press.cx - dx / scale, cy: press.cy + dy / scale };
  }
  function up(e: PointerEvent) {
    if (press && !press.moved) {
      const p = toGame(e), at = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
      if (onpick) onpick(at);
      else shot.crater = at;
    }
    press = null;
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    const p = toGame(e), k = e.deltaY > 0 ? 1.25 : 0.8;
    const span = Math.max(0.3, Math.min(200, view.span * k));
    // zoom around the pointer: the game point under it stays under it
    view = { span, cx: p.x - (p.x - view.cx) * (span / view.span), cy: p.y - (p.y - view.cy) * (span / view.span) };
  }
</script>

<div class="relative" bind:clientWidth={width} {@attach fitArea}>
  <canvas
    bind:this={canvas}
    class="block w-full touch-none border border-line bg-bg {press?.moved ? 'cursor-grabbing' : 'cursor-crosshair'}"
    style="height:{H}px"
    aria-label={onpick ? 'Map to pick where you stood' : `Map to pick the crater of ${shot.name}`}
    title={onpick ? 'The wheel zooms, a drag pans, and a click sets where you stood.' : 'The wheel zooms, a drag pans, and a click sets the crater.'}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointerleave={() => (hover = null)}
    onwheel={wheel}
  ></canvas>
  <span class="pointer-events-none absolute right-1.5 top-1 border border-line bg-panel px-1.5 text-[11px] text-muted">
    {hover ? `X ${hover.x.toFixed(2)}  Y ${hover.y.toFixed(2)}` : 'X -  Y -'}{zoom ? `  Zoom ${zoom}` : ''}
  </span>
  <button class="btn sm absolute left-1.5 top-1" onclick={() => (view = fit())} title="Back to the crater and the weapon range">Fit</button>
  <div class="absolute bottom-1.5 right-1.5"><MapStyle /></div>
  {#if map}<div class="absolute bottom-1.5 left-1.5 w-36"><MapChooser /></div>{/if}
  {#if !map}
    <MapChooser big />
  {:else if !loadedInfo}
    <span class="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 border border-line bg-panel px-1.5 text-[11px] text-warn">No map image. Run bun tools/fetch-map-data.ts.</span>
  {/if}
</div>
