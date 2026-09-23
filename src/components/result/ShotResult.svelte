<script lang="ts">
  import CopyButton from './CopyButton.svelte';
  import UseToggle from '../UseToggle.svelte';
  import { project } from '../../lib/state/project.svelte.ts';
  import type { ShotResult } from '../../lib/solver/result.ts';

  /** `gun` names the gun of the shot when the shots point to several. */
  let { r, gun }: { r: ShotResult; gun?: string } = $props();
  const shot = $derived(project.shots.find((s) => s.id === r.shotId));
  const f0 = (v: number) => v.toFixed(0);
  const g = (m: number) => (m / 100).toFixed(2);
</script>

<section class="card" data-testid="shot-result">
  <header class="card-head">
    <h2 class="card-title">{r.name}</h2>
    <span class="card-meta">
      {#if gun}<span class="tag">{gun}</span>{/if}
      {#if r.fit}<span class="tag accent">weapon ballistics and impact time</span>{/if}
      {#if shot}<UseToggle target={shot} what="this shot" />{/if}
    </span>
  </header>
  <div class="card-body flex flex-col gap-3">
    {#if r.excluded}
      <p class="note info">Left out of the calculation.</p>
    {:else if r.error}
      <p class="note bad">{r.error}</p>
    {:else if r.fit}
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <span class="label accent">Gun</span>
          {#if r.gun}
            <span class="big block text-[26px] text-text" data-testid="gun">X {g(r.gun.x)}  Y {g(r.gun.y)}</span>
          {:else}<span class="block text-muted">Not found</span>{/if}
        </div>
        {#if r.gun}<CopyButton text={`X ${g(r.gun.x)} Y ${g(r.gun.y)}`} />{/if}
      </div>
      <dl class="dl">
        {#if r.err90 != null}<dt>Likely error</dt><dd>within <span class="text-accent">{f0(r.err90)} m</span> (9 of 10 runs)</dd>{/if}
        <dt>Direction</dt>
        <dd>{r.fit.th.toFixed(1)} deg from the crater{#if r.dirRange}{' '}<span class="text-muted">({r.dirRange[0].toFixed(1)} to {r.dirRange[1].toFixed(1)} deg)</span>{/if}</dd>
        {#if r.gun}
          <dt>Range</dt><dd>{f0(r.gun.range)} m</dd>
          <dt>Launch angle</dt><dd>{r.gun.launchEl.toFixed(1)} deg <span class="text-muted">({r.gun.launchEl > 45 ? 'high' : 'low'} arc)</span></dd>
          <dt>Flight time</dt><dd>{r.gun.tof.toFixed(1)} s</dd>
        {/if}
        {#if r.ground}<dt>Gun height</dt><dd>{(r.ground.gun - r.ground.crater).toFixed(0)} m <span class="text-muted">relative to the crater, from the terrain</span></dd>{/if}
        <dt>You stood</dt><dd>{#each Object.values(r.fit.shifts) as [dx, dy], i}{i ? ', ' : ''}{f0(Math.hypot(dx, dy))} m from the crater{/each}</dd>
        <dt>Fit error</dt><dd title="How far the rays miss the fitted flight. Near the impact the shell is close, so a few meters are several degrees there.">{r.fit.missM.toFixed(1)} m, {r.fit.rms.toFixed(2)} deg RMS</dd>
        <dt>Sightings</dt><dd>{r.n}</dd>
      </dl>
    {/if}
    {#each r.notes as n}<p class="note warn">{n}</p>{/each}
  </div>
</section>
