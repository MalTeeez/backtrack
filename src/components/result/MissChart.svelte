<script lang="ts">
  /**
   * The miss of each sighting against the fitted flight over the time before the impact: along the path of the shell
   * (filled, signed: a mark ahead of the fit is above zero) and across it (hollow). A frame time error moves a mark
   * only along the path, so a row of filled dots that swing while the hollow ones stay near zero is a timing problem,
   * and a single dot far out is a bad mark. A click opens the sighting in Mark.
   */
  import type { ShotResult } from '../../lib/solver/result.ts';
  import { clipView, project, ui } from '../../lib/state/project.svelte.ts';

  let { r }: { r: ShotResult } = $props();
  const W = 320, H = 110, PAD = { l: 34, r: 6, t: 6, b: 18 };
  const ss = $derived(r.sightings ?? []);
  const tMax = $derived(Math.max(0.5, ...ss.map((s) => s.tau)));
  // at least +/-0.3 deg, the scale of the robust cost
  const yMax = $derived(Math.max(0.3, ...ss.map((s) => Math.max(Math.abs(s.along), s.cross))) * 1.1);
  const x = (tau: number) => PAD.l + (1 - tau / tMax) * (W - PAD.l - PAD.r);
  const y = (d: number) => PAD.t + (1 - (d + yMax) / (2 * yMax)) * (H - PAD.t - PAD.b);
  const ticks = $derived([-yMax, -yMax / 2, 0, yMax / 2, yMax].map((v) => +v.toFixed(2)));

  function open(id: string) {
    const s = project.sightings.find((q) => q.id === id);
    if (!s) return;
    clipView(s.clipId).t = s.timeS;
    ui.clipId = s.clipId; ui.sightingId = id; ui.phase = 'mark';
  }
</script>

{#if ss.length}
  <figure class="flex flex-col gap-1">
    <figcaption class="flex flex-wrap justify-between gap-x-3 text-[11.5px] text-muted">
      <span><span class="text-accent">●</span> along the path <span class="ml-2">○</span> across it (deg)</span>
      {#if r.timing}<span title="The frame time error of the clip that weighs the misses along the path: {r.timing.measured ? 'from the jitter of the marks' : 'the default, the clip has too few fast marks'}">frame times +/-{(r.timing.s * 1000).toFixed(0)} ms{r.timing.measured ? '' : ' (default)'}</span>{/if}
    </figcaption>
    <svg viewBox="0 0 {W} {H}" class="w-full" role="img" aria-label="Miss of each sighting against the fitted flight" data-testid="miss-chart">
      {#each ticks as v (v)}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} class={v === 0 ? 'stroke-muted' : 'stroke-line'} stroke-width="1" stroke-dasharray={v === 0 ? '' : '2 3'} />
        <text x={PAD.l - 4} y={y(v) + 3} text-anchor="end" class="fill-muted text-[9px]">{v}</text>
      {/each}
      <text x={PAD.l} y={H - 4} class="fill-muted text-[9px]">-{tMax.toFixed(1)} s</text>
      <text x={W - PAD.r} y={H - 4} text-anchor="end" class="fill-muted text-[9px]">impact</text>
      {#each ss as s (s.id)}
        <g role="button" tabindex="0" class="cursor-pointer" onclick={() => open(s.id)} onkeydown={(e) => e.key === 'Enter' && open(s.id)}>
          <title>{s.tau.toFixed(2)} s before the impact: {s.along.toFixed(3)} deg along, {s.cross.toFixed(3)} deg across. Click to open it.</title>
          <line x1={x(s.tau)} x2={x(s.tau)} y1={y(s.along)} y2={y(s.cross)} class="stroke-line" stroke-width="1" />
          <circle cx={x(s.tau)} cy={y(s.cross)} r="2.6" class="fill-none stroke-muted" stroke-width="1.2" />
          <circle cx={x(s.tau)} cy={y(s.along)} r="2.8" class="fill-accent" />
        </g>
      {/each}
    </svg>
  </figure>
{/if}
