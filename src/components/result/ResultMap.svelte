<script lang="ts">
  /**
   * Canvas map in game coordinates: craters, estimated observer positions, tracks and Monte Carlo guns, over the map
   * imagery. It starts on everything the result has. The wheel zooms around the pointer, a drag pans, and Fit goes back.
   */
  import { css } from '../mark/draw.ts';
  import type { ProjectResult } from '../../lib/solver/result.ts';
  import { theme } from '../../lib/state/theme.svelte.ts';
  import { drawTiles, mapInfo } from '../../lib/map/tiles.svelte.ts';
  import type { Grid, MapId } from '../../lib/solver/types.ts';
  import { REACH, STEEP_DEG } from '../../lib/terrain/analysis.ts';
  import MapStyle from '../MapStyle.svelte';
  import { Maximize2 } from '@lucide/svelte';
  import MapChooser from '../MapChooser.svelte';
  import { project } from '../../lib/state/project.svelte.ts';

  let { result, map }: { result: ProjectResult; map?: MapId } = $props();

  let tick = $state(0); // bumped when a map tile arrives
  let zoom = $state<string | null>(null); // the tile zoom drawn
  let info = $state<Awaited<ReturnType<typeof mapInfo>>>(null);
  $effect(() => { let live = true; if (map) mapInfo(map).then((i) => { if (live) info = i; }); else info = null; return () => { live = false; }; });

  let canvas: HTMLCanvasElement;
  let width = $state(0), height = $state(0);
  const D2R = Math.PI / 180;

  // the terrain layers, which the stack at the bottom left switches on and off
  let layers = $state({ steep: true, out: true, high: true });

  /** A grid as an image, one pixel per cell, made once per grid and layer. */
  type Color = (v: number) => [number, number, number, number] | null;
  const images = new WeakMap<Grid, Map<Color, HTMLCanvasElement>>();
  function gridImage(g: Grid, color: Color) {
    if (!images.has(g)) images.set(g, new Map());
    let c = images.get(g)!.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = g.w; c.height = g.h;
    const img = new ImageData(g.w, g.h);
    for (let i = 0; i < g.data.length; i++) {
      const rgba = color(g.data[i]);
      if (rgba) img.data.set(rgba, i * 4);
    }
    c.getContext('2d')!.putImageData(img, 0, 0);
    images.get(g)!.set(color, c);
    return c;
  }
  const OUT_COLOR: Color = (v) => (v === REACH.safe ? [40, 170, 80, 110] : null);
  const HIGH_COLOR: Color = (v) => (v === REACH.high ? [235, 190, 40, 95] : null);
  const STEEP_COLOR: Color = (v) => (v !== 255 && v > STEEP_DEG ? [140, 25, 25, 120] : null);
  const LAYERS: { key: keyof typeof layers; label: string; swatch: string; tip: string }[] = [
    { key: 'steep', label: 'Steep ground', swatch: 'rgb(140,25,25)', tip: `Ground steeper than ${STEEP_DEG} deg, where a gun vehicle is unlikely to stand. Hollow dots are Monte Carlo guns on such ground.` },
    { key: 'out', label: 'Out of reach', swatch: 'rgb(40,170,80)', tip: 'Ground no shell of the gun can land on, from the terrain only (no buildings or trees).' },
    { key: 'high', label: 'High arc only', swatch: 'rgb(235,190,40)', tip: 'Ground only the high arc of the gun lands on, with a long flight time.' },
  ];

  // only the layers the result has: steep ground needs terrain, the reach layers need the second worker message
  const shownLayers = $derived(LAYERS.filter((l) => (l.key === 'steep' ? result.shots.some((r) => r.slope) : !!result.safe)));

  // the view in meters: center and span across the shorter side. Null follows the result.
  let manual = $state<{ cx: number; cy: number; span: number } | null>(null);
  let shown = { cx: 0, cy: 0, sc: 1 }; // the view of the last drawing, for the pointer
  const toMeters = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: shown.cx + (e.clientX - r.left - width / 2) / shown.sc, y: shown.cy - (e.clientY - r.top - height / 2) / shown.sc };
  };
  const wheel = (el: HTMLElement) => {
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const p = toMeters(e), k = e.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.max(100, Math.min(40000, (Math.min(width, height) / shown.sc) * k));
      const sc = Math.min(width, height) / span, r = canvas.getBoundingClientRect();
      // the point under the pointer stays under it
      manual = { span, cx: p.x - (e.clientX - r.left - width / 2) / sc, cy: p.y + (e.clientY - r.top - height / 2) / sc };
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  };
  let drag = $state<{ x: number; y: number; cx: number; cy: number } | null>(null);
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, cx: shown.cx, cy: shown.cy };
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    const span = Math.min(width, height) / shown.sc;
    manual = { span, cx: drag.cx - (e.clientX - drag.x) / shown.sc, cy: drag.cy + (e.clientY - drag.y) / shown.sc };
  }

  $effect(() => {
    void theme.current, tick; // the colors come from the theme
    const W = width, H = height;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const pts: number[][] = [];
    for (const r of result.shots) {
      if (r.C) pts.push(r.C);
      if (r.gun) pts.push([r.gun.x, r.gun.y]);
      pts.push(...r.observers);
    }
    for (const gn of result.guns) pts.push([gn.x, gn.y]);
    const font = `11px 'Commit Mono', ui-monospace, monospace`;
    const bold = `600 13px 'Commit Mono', ui-monospace, monospace`;
    // text with a dark halo, so it reads on any imagery
    const label = (t: string, x: number, y: number) => {
      g.font = bold; g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineJoin = 'round';
      g.strokeText(t, x, y); g.fillStyle = '#ffffff'; g.fillText(t, x, y);
    };
    if (!pts.length) {
      g.fillStyle = css('--muted'); g.font = font;
      g.fillText('The map shows here after the first result.', 14, 24);
      return;
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const auto = {
      cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 800) * 1.25,
    };
    const { cx, cy, span } = manual ?? auto;
    const sc = Math.min(W, H) / span;
    shown = { cx, cy, sc };
    const T = (x: number, y: number): [number, number] => [W / 2 + (x - cx) * sc, H / 2 - (y - cy) * sc];

    zoom = map && info ? drawTiles(g, map, info, { toPx: (x, y) => T(x * 100, y * 100), pxPerUnit: sc * 100, width: W, height: H }, () => tick++) : null;

    // grid in game units
    const step = [100, 200, 500, 1000, 2000, 5000].find((v) => (Math.max(W, H) / sc) / v <= 14) ?? 5000;
    g.strokeStyle = css('--line'); g.fillStyle = css('--muted'); g.lineWidth = 1; g.font = font;
    for (let x = Math.floor((cx - W / 2 / sc) / step) * step; x < cx + W / 2 / sc; x += step) {
      const [px] = T(x, 0);
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      g.fillText(String(x / 100), px + 3, H - 5);
    }
    for (let y = Math.floor((cy - H / 2 / sc) / step) * step; y < cy + H / 2 / sc; y += step) {
      const [, py] = T(0, y);
      g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke();
      g.fillText(String(y / 100), 4, py - 3);
    }

    // the terrain layers, drawn cell by cell without smoothing
    const drawGrid = (grid: Grid, color: Color) => {
      const [x, y] = T(grid.x0, grid.y0);
      g.imageSmoothingEnabled = false;
      g.drawImage(gridImage(grid, color), x, y, grid.w * grid.cell * sc, grid.h * grid.cell * sc);
      g.imageSmoothingEnabled = true;
    };
    if (layers.out && result.safe) drawGrid(result.safe.grid, OUT_COLOR);
    if (layers.high && result.safe) drawGrid(result.safe.grid, HIGH_COLOR);
    if (layers.steep) for (const r of result.shots) if (r.slope) drawGrid(r.slope, STEEP_COLOR);

    const gun = css('--gun');

    // the weapon range around each gun: where it can reach from there, as two labeled circles
    const several = result.guns.length > 1;
    const gunName = (i: number) => (several ? `Gun ${i + 1}` : 'Gun');
    for (const [gi, center] of result.guns.entries()) {
      const [px, py] = T(center.x, center.y);
      for (const [m, kind] of [[project.settings.rangeMinM, 'min range'], [project.settings.rangeMaxM, 'max range']] as const) {
        const name = several ? `${gunName(gi)} ${kind}` : kind[0].toUpperCase() + kind.slice(1);
        const rad = m * sc;
        g.setLineDash([8, 6]);
        g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 4; g.beginPath(); g.arc(px, py, rad, 0, 7); g.stroke();
        g.strokeStyle = gun; g.lineWidth = 2; g.beginPath(); g.arc(px, py, rad, 0, 7); g.stroke();
        g.setLineDash([]);
        // the label goes to the first side of the circle that is on the map and clear of the legend
        const text = `${name} ${m} m`;
        g.font = bold;
        const tw = g.measureText(text).width;
        const spots: [number, number][] = [[px - tw / 2, py - rad - 7], [px - tw / 2, py + rad + 16], [px + rad + 6, py + 5], [px - rad - tw - 6, py + 5]];
        const spot = spots.find(([x, y]) => x > 4 && x + tw < W - 4 && y > 70 && y < H - 8);
        if (spot) label(text, spot[0], spot[1]);
      }
    }

    for (const r of result.shots) {
      if (!r.C) continue;
      const [ccx, ccy] = T(r.C[0], r.C[1]);
      if (r.fit) {
        const L = 3500;
        const at = (a: number) => T(r.C![0] + L * Math.sin(a * D2R), r.C![1] + L * Math.cos(a * D2R));
        if (r.dirRange) {
          let [a0, a1] = r.dirRange;
          if (a1 < a0) a1 += 360;
          g.fillStyle = gun; g.globalAlpha = 0.22;
          g.beginPath(); g.moveTo(ccx, ccy);
          for (let a = a0; a <= a1 + 1e-9; a += Math.max(0.2, (a1 - a0) / 30)) g.lineTo(...at(a));
          g.closePath(); g.fill(); g.globalAlpha = 1;
        }
        // the track: a dark casing under the colored dashes
        g.setLineDash([10, 6]); g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 6;
        g.beginPath(); g.moveTo(ccx, ccy); g.lineTo(...at(r.fit.th)); g.stroke();
        g.strokeStyle = gun; g.lineWidth = 3.5;
        g.beginPath(); g.moveTo(ccx, ccy); g.lineTo(...at(r.fit.th)); g.stroke(); g.setLineDash([]);
        g.fillStyle = gun; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
        // a gun on steep ground is unlikely: a hollow dot
        for (const q of r.mc) {
          const [qx, qy] = T(q.x, q.y);
          g.beginPath(); g.arc(qx, qy, 3, 0, 7);
          if (q.steep) { g.strokeStyle = gun; g.lineWidth = 1.5; g.stroke(); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1; }
          else { g.fill(); g.stroke(); }
        }
        if (r.gun) {
          const [gx, gy] = T(r.gun.x, r.gun.y);
          g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 6; g.beginPath(); g.arc(gx, gy, 11, 0, 7); g.stroke();
          g.strokeStyle = gun; g.lineWidth = 3.5; g.beginPath(); g.arc(gx, gy, 11, 0, 7); g.stroke();
        }
      }
      g.fillStyle = css('--impact'); g.strokeStyle = '#000000'; g.lineWidth = 2;
      g.beginPath(); g.arc(ccx, ccy, 8, 0, 7); g.fill(); g.stroke();
      label(r.name, ccx + 12, ccy + 5);
      g.fillStyle = css('--accent'); g.strokeStyle = '#000000'; g.lineWidth = 1.5;
      for (const o of r.observers) {
        const [ox, oy] = T(o[0], o[1]);
        g.beginPath(); g.moveTo(ox, oy - 9); g.lineTo(ox + 8, oy + 6); g.lineTo(ox - 8, oy + 6); g.closePath(); g.fill(); g.stroke();
      }
    }
    // a gun of several shots, or every gun when there are several, gets its cross and name
    for (const [gi, gn] of result.guns.entries()) {
      if (!several && gn.shotIds.length < 2) continue;
      const [px, py] = T(gn.x, gn.y);
      const cross = () => { g.beginPath(); g.moveTo(px - 12, py - 12); g.lineTo(px + 12, py + 12); g.moveTo(px + 12, py - 12); g.lineTo(px - 12, py + 12); g.stroke(); };
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 7; cross();
      g.strokeStyle = gun; g.lineWidth = 4; cross();
      label(gunName(gi), px + 16, py + 5);
    }
  });
</script>

<div class="relative h-full min-h-[320px] w-full" bind:clientWidth={width} bind:clientHeight={height}>
  <canvas
    bind:this={canvas}
    class="absolute inset-0 block touch-none {drag ? 'cursor-grabbing' : 'cursor-grab'}"
    aria-label="Map of the result"
    data-testid="result-map"
    {@attach wheel}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (drag = null)}
    onpointercancel={() => (drag = null)}
  ></canvas>
  <div class="absolute right-2 top-2 flex max-w-[calc(100%-6rem)] flex-wrap gap-x-4 gap-y-1 border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-muted">
    <span><span class="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-impact align-[-1px]"></span>Crater</span>
    <span><span class="mr-1 inline-block h-2.5 w-2.5 bg-accent align-[-1px]" style="clip-path: polygon(50% 0, 100% 100%, 0 100%)"></span>Where you stood (estimated)</span>
    <span><span class="mr-1 inline-block h-0.5 w-4 bg-gun align-middle"></span>Track, gun, possible positions</span>
    <span><span class="mr-1 text-gun">X</span>Gun from its shots</span>
    <span><span class="mr-1 inline-block w-4 border-t-2 border-dashed border-gun align-middle"></span>Weapon range from the gun</span>
    {#if zoom}<span>Zoom {zoom}</span>{/if}
  </div>
  <button class="btn sm absolute left-2 top-2" onclick={() => (manual = null)} disabled={!manual} title="Show the whole result"><Maximize2 size={12} /> Fit</button>
  <div class="absolute bottom-2 right-2"><MapStyle /></div>
  {#if map}
    <div class="absolute bottom-2 left-2 flex w-36 flex-col gap-1">
      <!-- the terrain layers, stacked like the map styles -->
      {#if shownLayers.length}
        <div class="flex flex-col gap-px border border-line bg-panel p-px" role="group" aria-label="Terrain layers">
          {#each shownLayers as l (l.key)}
            <button class="option min-h-0 w-full justify-start gap-1.5 px-1.5 py-1 text-[11px]" aria-pressed={layers[l.key]} title={l.tip} onclick={() => (layers[l.key] = !layers[l.key])}>
              <span class="inline-block h-2.5 w-2.5 shrink-0 {layers[l.key] ? '' : 'opacity-30'}" style="background:{l.swatch}"></span>{l.label}
            </button>
          {/each}
        </div>
      {/if}
      <MapChooser />
    </div>
  {:else}<MapChooser big />{/if}
</div>
