<script lang="ts">
  /** The result: the map and a card per shot. `compact` stacks them for the split view next to another phase. */
  import Spinner from '../Spinner.svelte';
  import ResultMap from '../result/ResultMap.svelte';
  import ShotResult from '../result/ShotResult.svelte';
  import CopyButton from '../result/CopyButton.svelte';
  import { project } from '../../lib/state/project.svelte.ts';
  import { solve, solved } from '../../lib/state/solve.svelte.ts';

  let { compact = false }: { compact?: boolean } = $props();

  // the store solves again only when the inputs of the solver changed
  $effect(() => solve($state.snapshot(project)));
  const result = $derived(solved.result);
  const solving = $derived(solved.solving);
  const error = $derived(solved.error);

  const gunName = (i: number) => ((result?.guns.length ?? 0) > 1 ? `Gun ${i + 1}` : 'Gun');
  const g = (m: number) => (m / 100).toFixed(2);
</script>

<div class="grid h-full min-h-0 gap-2 {compact ? 'grid-rows-[minmax(320px,55%)_minmax(0,1fr)]' : 'xl:grid-cols-[minmax(0,1fr)_minmax(380px,32vw)]'}">
  <section class="card flex flex-col {compact ? 'min-h-0' : 'min-h-[60vh]'}">
    <header class="card-head"><h2 class="card-title">Map</h2><span class="card-meta">{#if solving}<Spinner size={12} /> Solving...{:else}game coordinates{/if}</span></header>
    <div class="min-h-0 flex-1">
      {#if result}<ResultMap {result} map={project.settings.map} />{:else}<p class="m-0 flex items-center justify-center gap-2 p-6 text-muted"><Spinner /> Solving...</p>{/if}
    </div>
  </section>

  <div class="flex min-h-0 flex-col gap-2 overflow-y-auto">
    {#if error}<p class="note bad">The solver failed ({error}).</p>{/if}

    {#if result && result.guns.length > 1}
      <p class="note info" title="Two shots come from different guns when their gun positions lie further apart than their accuracy allows.">
        The shots do not agree on one gun, so the result assumes {result.guns.length} guns.
      </p>
    {/if}
    {#each result && (result.guns.length > 1 || result.guns.some((gn) => gn.shotIds.length > 1)) ? result.guns : [] as X, gi}
      <section class="card border-[var(--accent-border-active)]" data-testid="gun-card">
        <header class="card-head">
          <h2 class="card-title">{gunName(gi)}</h2>
          <span class="card-meta">
            {X.shotIds.map((id) => result!.shots.find((r) => r.shotId === id)?.name).join(', ')}{X.method === 'combined' ? ', combined' : X.method === 'tracks' ? ', where the tracks cross' : ''}
          </span>
        </header>
        <div class="card-body flex flex-col gap-3">
          <div class="flex flex-wrap items-end justify-between gap-2">
            <span class="big text-[30px] text-text">X {g(X.x)}  Y {g(X.y)}</span>
            <CopyButton text={`X ${g(X.x)} Y ${g(X.y)}`} />
          </div>
          <dl class="dl">
            {#if X.err90 != null}<dt>Likely error</dt><dd>within <span class="text-accent">{X.err90.toFixed(0)} m</span></dd>{/if}
            {#if X.angle != null}<dt>Crossing angle</dt><dd class={X.angle < 15 ? 'text-warn' : ''}>{X.angle.toFixed(0)} deg</dd>{/if}
          </dl>
          {#if X.angle != null && X.angle < 15 && X.method === 'tracks'}
            <p class="note warn">The tracks cross at less than 15 deg. The position along the tracks is not accurate. Use shots that land far apart.</p>
          {/if}
        </div>
      </section>
    {/each}

    {#if result && !result.shots.length}
      <div class="card flex flex-col items-center gap-2 p-8 text-center">
        <span class="title text-[36px] text-muted-strong">No sightings yet</span>
        <span class="text-muted">Mark shells in phase 2.</span>
      </div>
    {/if}
    {#if result?.ground}<p class="note info">{result.ground}</p>{/if}
    {#each result?.shots ?? [] as r (r.shotId)}
      {@const gi = result!.guns.findIndex((gn) => gn.shotIds.includes(r.shotId))}
      <ShotResult {r} gun={result!.guns.length > 1 && gi >= 0 ? gunName(gi) : undefined} />
    {/each}
  </div>
</div>
