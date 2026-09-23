<script lang="ts">
  import { Plus, Trash2 } from '@lucide/svelte';
  import Info from '../Info.svelte';
  import NumInput from '../NumInput.svelte';
  import UseToggle from '../UseToggle.svelte';
  import CraterMap from '../CraterMap.svelte';
  import { MAPS } from '../../lib/map/tiles.svelte.ts';
  import { SOURCE_TOL_DEG, craterGame } from '../../lib/solver/sightings.ts';
  import { deleteShot, newShot, project, WEAPONS } from '../../lib/state/project.svelte.ts';
  import type { Id, MapId, Shot, Weapon } from '../../lib/solver/types.ts';

  const st = $derived(project.settings);
  const count = (id: Id) => project.sightings.filter((s) => s.shotId === id).length;
  // the crater map is open for these shots
  const onMap: Record<Id, boolean> = $state({});

  /** Switches a crater between X and Y and a rangefinder reading, and keeps where it was as X and Y. */
  function setRangefinder(s: Shot, on: boolean) {
    if (on === !!s.crater.from) return;
    const at = craterGame(s);
    s.crater = on ? { from: {} } : at ? { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 } : {};
  }

  function setWeapon(w: Weapon) {
    st.weapon = w;
    st.rangeMinM = WEAPONS[w].min; st.rangeMaxM = WEAPONS[w].max;
  }
</script>

<div class="grid min-h-full content-start gap-2 xl:grid-cols-2">
  <div class="flex flex-col gap-2">
    <section class="card">
      <header class="card-head">
        <h2 class="card-title">Craters</h2>
        <Info label="Craters">
          <p>Walk to the crater after the impact and read its X and Y from the game map, or click it on the map. 1 unit is 100 m.</p>
          <p>You do not need to give your own position. You stood near the crater, and the solver finds where.</p>
          <p><em>Suspected heading</em> is the compass heading from the crater toward the gun, if you have an idea of it. The solver then looks only within the tolerance around it. Leave it empty to search all directions.</p>
        </Info>
        <span class="card-meta"><button class="btn sm" onclick={() => project.shots.push(newShot(project.shots.length + 1))}><Plus size={12} /> Add</button></span>
      </header>
      <div class="card-body flex flex-col gap-3" data-testid="shots">
        {#each project.shots as s (s.id)}
          <div class="flex flex-col gap-1.5 border-b border-line pb-3 last:border-b-0 last:pb-0">
            <div class="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-end gap-1.5">
              <label class="flex min-w-0 flex-col gap-1"><span class="label truncate">Shot ({count(s.id)} sightings)</span><input class="control" bind:value={s.name} /></label>
              <button class="option justify-center px-2" aria-pressed={!!onMap[s.id]} onclick={() => (onMap[s.id] = !onMap[s.id])}>Map</button>
              <span class="grid h-[30px] place-items-center px-1"><UseToggle target={s} what="this shot" /></span>
              <button class="btn icon" aria-label="Delete {s.name}" onclick={() => deleteShot(s.id)}><Trash2 size={13} /></button>
            </div>
            <div class="grid w-fit grid-cols-2 gap-1" role="group" aria-label="How the crater is given">
              <button class="option min-h-0 justify-center px-2 py-1 text-[11px]" aria-pressed={!s.crater.from} onclick={() => setRangefinder(s, false)} title="The X and Y of the crater from the game map">X / Y</button>
              <button class="option min-h-0 justify-center px-2 py-1 text-[11px]" aria-pressed={!!s.crater.from} onclick={() => setRangefinder(s, true)} title="Where you stood, and the heading and distance of the crater through binoculars or a rangefinder">Rangefinder</button>
            </div>
            {#if s.crater.from}
              {@const from = s.crater.from}
              {@const at = craterGame(s)}
              <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <NumInput label="Your X" bind:value={from.x} step={0.01} />
                <NumInput label="Your Y" bind:value={from.y} step={0.01} />
                <NumInput label="Heading" unit="deg" bind:value={from.headingDeg} step={0.5} min={0} />
                <NumInput label="Distance" unit="m" bind:value={from.distanceM} step={1} min={0} />
              </div>
              <dl class="dl text-[12px]"><dt>Crater</dt><dd class="num">{at ? `X ${at.x.toFixed(2)}  Y ${at.y.toFixed(2)}` : '-'}</dd></dl>
            {/if}
            <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {#if !s.crater.from}
                <NumInput label="Crater X" bind:value={s.crater.x} step={0.01} />
                <NumInput label="Crater Y" bind:value={s.crater.y} step={0.01} />
              {/if}
              <NumInput label="Suspected heading" unit="deg" bind:value={s.sourceDeg} step={1} min={0} />
              <NumInput label="Tolerance" unit="deg" bind:value={() => s.sourceTolDeg ?? SOURCE_TOL_DEG, (v) => (s.sourceTolDeg = v)} step={1} min={1} />
            </div>
            {#if onMap[s.id]}<CraterMap shot={s} reachM={st.rangeMaxM} map={st.map} />{/if}
          </div>
        {/each}
      </div>
    </section>
  </div>

  <div class="flex flex-col gap-2">
    <section class="card">
      <header class="card-head"><h2 class="card-title" title="The map the clips come from. The crater map and the result map show its image, and the solver uses its terrain.">Map</h2></header>
      <div class="card-body flex flex-col gap-2">
        <div class="grid grid-cols-4 gap-1">
          <button class="option justify-center px-1" aria-pressed={!st.map} onclick={() => (st.map = undefined)}>None</button>
          {#each Object.entries(MAPS) as [id, name]}
            <button class="option justify-center px-1" aria-pressed={st.map === id} onclick={() => (st.map = id as MapId)}>{name}</button>
          {/each}
        </div>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h2 class="card-title" title="Use the FOV from the game settings. A wrong FOV gives wrong angles.">Camera</h2></header>
      <div class="card-body grid grid-cols-2 gap-2">
        <NumInput required label="Game FOV" unit="deg" bind:value={() => st.fovDeg, (v) => (st.fovDeg = v!)} min={10} />
        <div class="flex flex-col gap-1">
          <span class="label">FOV type</span>
          <div class="grid grid-cols-2 gap-1">
            <button class="option justify-center px-1" aria-pressed={st.fovAxis === 'h'} onclick={() => (st.fovAxis = 'h')}>Horizontal</button>
            <button class="option justify-center px-1" aria-pressed={st.fovAxis === 'v'} onclick={() => (st.fovAxis = 'v')}>Vertical</button>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h2 class="card-title" title="The solver uses the ballistics of the weapon: launch speed and drag from community data, not from Bulkhead.">Weapon</h2></header>
      <div class="card-body flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-1">
          {#each Object.entries(WEAPONS) as [k, w]}
            <button class="option flex-col items-start gap-0.5" aria-pressed={st.weapon === k} onclick={() => setWeapon(k as Weapon)}>
              <span>{w.name}</span>
              <span class="text-[11px] text-muted">{w.min} to {w.max} m</span>
            </button>
          {/each}
        </div>
        <div class="grid grid-cols-2 gap-2">
          <NumInput required label="Min range" unit="m" bind:value={() => st.rangeMinM, (v) => (st.rangeMinM = v!)} />
          <NumInput required label="Max range" unit="m" bind:value={() => st.rangeMaxM, (v) => (st.rangeMaxM = v!)} />
        </div>
        <label class="flex items-center gap-1.5 text-copy"><input type="checkbox" bind:checked={st.limitToRange} /> Keep results inside this range</label>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h2 class="card-title" title="The accuracy estimate uses these values as the size of its random errors.">Accuracy</h2></header>
      <div class="card-body grid grid-cols-2 gap-2">
        <NumInput required label="Mark accuracy" unit="px" bind:value={() => st.markSigmaPx, (v) => (st.markSigmaPx = v! > 0 ? v! : st.markSigmaPx)} step={0.1} />
        <NumInput required label="Compass accuracy" unit="deg" bind:value={() => st.compassSigmaDeg, (v) => (st.compassSigmaDeg = v! > 0 ? v! : st.compassSigmaDeg)} step={0.1} />
      </div>
    </section>
  </div>
</div>
