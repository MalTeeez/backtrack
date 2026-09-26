<script lang="ts">
  /**
   * Charts the miss of each sighting against the fitted flight over the time before the impact. Filled dots show the
   * signed miss along the path of the shell, so a mark ahead of the fit is above zero. Hollow dots show the miss across
   * the path. A frame time error moves a mark only along the path. Thus a row of filled dots that swing while the
   * hollow ones stay near zero shows a timing problem, and a single dot far out shows a bad mark. A click opens the
   * sighting in Mark.
   */
  import type { ShotResult } from '../../lib/solver/result.ts';
  import { clipView, project, ui } from '../../lib/state/project.svelte.ts';

  let { r }: { r: ShotResult } = $props();
  // The chart draws at the width it has, so its text keeps its size in a wide window.
  let W = $state(320);
  const H = 130, PAD = { l: 44, r: 8, t: 8, b: 30 };
  const ss = $derived(r.sightings ?? []);
  const tMax = $derived(Math.max(0.5, ...ss.map((s) => s.tau)));
  // at least +/-0.3 deg, the scale of the robust cost
  const yMax = $derived(Math.max(0.3, ...ss.map((s) => Math.max(Math.abs(s.along), s.cross))) * 1.1);
  const x = (tau: number) => PAD.l + (1 - tau / tMax) * (W - PAD.l - PAD.r);
  const y = (d: number) => PAD.t + (1 - (d + yMax) / (2 * yMax)) * (H - PAD.t - PAD.b);
  const ticks = $derived([-yMax, -yMax / 2, 0, yMax / 2, yMax].map((v) => +v.toFixed(2)));
  // the time ticks: a step of 0.25, 0.5, 1, 2 or 5 s that gives about five
  const tStep = $derived([0.25, 0.5, 1, 2, 5].find((st) => tMax / st <= 6) ?? 10);
  const tTicks = $derived(Array.from({ length: Math.floor(tMax / tStep) + 1 }, (_, i) => i * tStep));

  function open(id: string) {
    const s = project.sightings.find((q) => q.id === id);
    if (!s) return;
    clipView(s.clipId).t = s.timeS;
    ui.clipId = s.clipId; ui.sightingId = id; ui.phase = 'mark';
  }
</script>

{#if ss.length}
  <figure class="m-0 flex flex-col gap-1" bind:clientWidth={W}>
    <figcaption class="flex flex-col gap-1 text-[11.5px] text-muted">
      <span class="text-copy">How far each sighting misses the fitted flight, <svg width="8" height="8" viewBox="0 0 8 8" class="inline align-baseline" aria-hidden="true"><circle cx="4" cy="4" r="3" class="fill-accent" /></svg> along the path of the shell and <svg width="8" height="8" viewBox="0 0 8 8" class="inline align-baseline" aria-hidden="true"><circle cx="4" cy="4" r="3" class="fill-none stroke-muted" stroke-width="1.2" /></svg> across it, where dots far from zero point to a bad mark or a wrong frame time.</span>
      {#if r.timing}<span title="The frame time error of the clip weighs the misses along the path. {r.timing.measured ? 'It comes from the jitter of the marks.' : 'It is the default, because the clip has too few fast marks.'}">frame times +/-{(r.timing.s * 1000).toFixed(0)} ms{r.timing.measured ? '' : ' (default)'}</span>{/if}
    </figcaption>
    <svg width={W} height={H} viewBox="0 0 {W} {H}" class="block" role="img" aria-label="Miss of each sighting against the fitted flight" data-testid="miss-chart">
      {#each ticks as v (v)}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} class={v === 0 ? 'stroke-muted' : 'stroke-line'} stroke-width="1" stroke-dasharray={v === 0 ? '' : '2 3'} />
        <text x={PAD.l - 4} y={y(v) + 3} text-anchor="end" class="fill-muted text-[9px]">{v}</text>
      {/each}
      <!-- the axes: the miss in degrees up, and the time before the impact to the right, which ends at the impact -->
      <text x="10" y={(PAD.t + H - PAD.b) / 2} text-anchor="middle" transform="rotate(-90 10 {(PAD.t + H - PAD.b) / 2})" class="fill-muted text-[9px]">Miss (deg)</text>
      {#each tTicks as tt (tt)}
        <line x1={x(tt)} x2={x(tt)} y1={H - PAD.b} y2={H - PAD.b + 3} class="stroke-muted" stroke-width="1" />
        <text x={x(tt)} y={H - PAD.b + 12} text-anchor="middle" class="fill-muted text-[9px]">{tt === 0 ? '0' : `-${tt}`}</text>
      {/each}
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 3} text-anchor="middle" class="fill-muted text-[9px]">Time before the impact (s)</text>
      {#each ss as s (s.id)}
        <g role="button" tabindex="0" class="cursor-pointer" onclick={() => open(s.id)} onkeydown={(e) => e.key === 'Enter' && open(s.id)}>
          <title>{s.tau.toFixed(2)} s before the impact. The miss is {s.along.toFixed(3)} deg along and {s.cross.toFixed(3)} deg across. Click to open it.</title>
          <line x1={x(s.tau)} x2={x(s.tau)} y1={y(s.along)} y2={y(s.cross)} class="stroke-line" stroke-width="1" />
          <circle cx={x(s.tau)} cy={y(s.cross)} r="2.6" class="fill-none stroke-muted" stroke-width="1.2" />
          <circle cx={x(s.tau)} cy={y(s.along)} r="2.8" class="fill-accent" />
        </g>
      {/each}
    </svg>
  </figure>
{/if}
