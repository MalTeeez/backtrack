<script lang="ts">
  /**
   * The playback speed as a slider with evenly spaced stops, one per speed, and the speed under each stop. A press or a
   * drag picks the nearest stop, and the arrow keys step while the slider has the focus.
   */
  import { ui } from '../../lib/state/project.svelte.ts';

  let { speeds }: { speeds: number[] } = $props();
  const label = (sp: number) => `${sp >= 1 ? sp : '.' + String(sp).split('.')[1]}x`;
  const at = $derived(Math.max(0, speeds.indexOf(ui.speed)));
  const pct = (i: number) => (i / (speeds.length - 1)) * 100;

  let rail: HTMLElement;
  function pick(e: PointerEvent) {
    const r = rail.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    ui.speed = speeds[Math.round(u * (speeds.length - 1))];
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    pick(e);
    const move = (ev: PointerEvent) => pick(ev);
    // The slider gives the focus back, so the keys of the page (the arrows step frames) keep working.
    const up = () => { el.removeEventListener('pointermove', move); el.blur(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  }
  function onkeydown(e: KeyboardEvent) {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (!step) return;
    // the page does not step frames for these keys
    e.preventDefault();
    e.stopPropagation();
    ui.speed = speeds[Math.max(0, Math.min(speeds.length - 1, at + step))];
  }
</script>

<div class="speed" role="slider" tabindex="0" aria-label="Playback speed" aria-valuemin={speeds[0]} aria-valuemax={speeds.at(-1)} aria-valuenow={ui.speed}
  aria-valuetext={label(ui.speed)} title="Playback speed" onpointerdown={down} {onkeydown} data-testid="speed">
  <span class="label head">Play speed</span>
  <div class="rail" bind:this={rail}>
    {#each speeds as sp, i (sp)}<span class="stop" style:left="{pct(i)}%"></span>{/each}
    <span class="fill" style:width="{pct(at)}%"></span>
    <span class="thumb" style:left="{pct(at)}%"></span>
  </div>
  <div class="labels">
    {#each speeds as sp, i (sp)}<span class:on={i === at} style:left="{pct(i)}%">{label(sp)}</span>{/each}
  </div>
</div>

<style>
  .speed { width: 124px; padding: 0 10px; cursor: ew-resize; touch-action: none; user-select: none; outline: none; }
  .head { display: block; margin: 0 -10px 1px; }
  .speed:focus-visible { box-shadow: 0 0 0 1px var(--accent); }
  .rail { position: relative; height: 16px; }
  .rail::before { content: ''; position: absolute; left: 0; right: 0; top: 7px; height: 2px; background: var(--line-strong); }
  .fill { position: absolute; left: 0; top: 7px; height: 2px; background: var(--accent); transition: width 120ms ease-out; }
  .stop { position: absolute; top: 4px; width: 1px; height: 8px; background: var(--line-strong); transform: translateX(-50%); }
  .thumb { position: absolute; top: 1px; width: 8px; height: 14px; background: var(--accent); transform: translateX(-50%); transition: left 120ms ease-out; }
  .labels { position: relative; height: 12px; }
  .labels span { position: absolute; top: 0; transform: translateX(-50%); font: 10px/1 var(--font-mono); color: var(--muted); white-space: nowrap; }
  .labels span.on { color: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .fill, .thumb { transition: none; } }
</style>
