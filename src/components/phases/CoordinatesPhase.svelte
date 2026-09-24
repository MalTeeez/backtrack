<script lang="ts">
  import { Plus, Trash2 } from '@lucide/svelte';
  import Info from '../Info.svelte';
  import NumInput from '../NumInput.svelte';
  import FieldTag from '../FieldTag.svelte';
  import UseToggle from '../UseToggle.svelte';
  import CraterMap from '../CraterMap.svelte';
  import { SOURCE_TOL_DEG, craterGame } from '../../lib/solver/sightings.ts';
  import { value } from '../../lib/solver/field.ts';
  import { addShot, clips, deleteShot, project, shotsOf, ui, WEAPONS } from '../../lib/state/project.svelte.ts';
  import { solved } from '../../lib/state/solve.svelte.ts';
  import type { Field, Id, Shot, Weapon, XY } from '../../lib/solver/types.ts';

  const st = $derived(project.settings);
  // the shots of the clip picked in Mark: a shot belongs to one clip for now
  const shown = $derived(shotsOf(ui.clipId));
  const clipName = $derived(clips.list.find((c) => c.id === ui.clipId)?.name);
  const count = (id: Id) => project.sightings.filter((s) => s.shotId === id).length;
  const resultOf = (id: Id) => solved.result?.shots.find((r) => r.shotId === id);
  const round = (v: number | undefined) => (v == null ? undefined : Math.round(v * 100) / 100);
  const fmtXY = (p: unknown) => { const q = p as XY; return `${q.x.toFixed(2)}, ${q.y.toFixed(2)}`; };

  /**
   * One coordinate of a point field: the value the solver uses, and a typed value that makes it the user's. `make`
   * gives the field for writing, made on first use.
   */
  const coord = (f: Field<XY> | undefined, make: () => Field<XY>, k: 'x' | 'y') => ({
    get: () => round(value(f)?.[k]),
    set: (v: number | undefined) => {
      const w = make(), cur = w.manual ?? value(w), other = k === 'x' ? cur?.y : cur?.x;
      w.manual = v == null ? undefined : k === 'x' ? { x: v, y: other ?? v } : { x: other ?? v, y: v };
    },
  });
  /** Where the user stood during a shot, as a field made on first use. */
  const observer = (s: Shot) => { s.observer[s.clipId!] ??= {}; return s.observer[s.clipId!]; };

  /** Switches a crater between X and Y and a rangefinder reading, and keeps where it was as X and Y. */
  function setRangefinder(s: Shot, on: boolean) {
    if (on === !!s.rangefinder) return;
    const at = craterGame(s);
    if (on) s.rangefinder = {};
    else {
      s.rangefinder = undefined;
      if (at) s.crater.manual = { x: round(at.x)!, y: round(at.y)! };
    }
  }

  /** Picks a weapon, or leaves it to the solver (undefined). */
  function setWeapon(w: Weapon | undefined) {
    st.weapon = w;
    if (w) { st.rangeMinM = WEAPONS[w].min; st.rangeMaxM = WEAPONS[w].max; }
  }
  const weapon = $derived(solved.result?.weapon);
</script>

<div class="grid min-h-full content-start gap-2 xl:grid-cols-2">
  <div class="flex flex-col gap-2">
    <section class="card">
      <header class="card-head">
        <h2 class="card-title">Craters{clipName ? ` of ${clipName}` : ''}</h2>
        <Info label="Craters">
          <p>Walk to the crater after the impact and read its X and Y from the game map, or click it on the map. 1 unit is 100 m.</p>
          <p>Where you stood comes from the minimap. With it, the crater is optional: the solver finds it from the end of the flight.</p>
          <p><em>Suspected heading</em> is the compass heading from the crater toward the gun, if you have an idea of it. The solver then looks only within the tolerance around it. Leave it empty to search all directions.</p>
        </Info>
        <span class="card-meta"><button class="btn sm" onclick={addShot}><Plus size={12} /> Add</button></span>
      </header>
      <div class="card-body flex flex-col gap-3" data-testid="shots">
        {#each shown as s (s.id)}
          {@const r = resultOf(s.id)}
          {@const obs = s.clipId ? s.observer[s.clipId] : undefined}
          <div class="flex flex-col gap-1.5 border-b border-line pb-3 last:border-b-0 last:pb-0">
            <div class="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-end gap-1.5">
              <label class="flex min-w-0 flex-col gap-1"><span class="label truncate">Shot ({count(s.id)} sightings)</span><input class="control" bind:value={s.name} /></label>
              <button class="option justify-center px-2" aria-pressed={!!ui.mapOpen[s.id]} onclick={() => (ui.mapOpen[s.id] = !ui.mapOpen[s.id])}>Map</button>
              <span class="grid h-[30px] place-items-center px-1"><UseToggle target={s} what="this shot" /></span>
              <button class="btn icon" aria-label="Delete {s.name}" onclick={() => deleteShot(s.id)}><Trash2 size={13} /></button>
            </div>
            <div class="grid w-fit grid-cols-2 gap-1" role="group" aria-label="How the crater is given">
              <button class="option min-h-0 justify-center px-2 py-1 text-[11px]" aria-pressed={!s.rangefinder} onclick={() => setRangefinder(s, false)} title="The X and Y of the crater from the game map">X / Y</button>
              <button class="option min-h-0 justify-center px-2 py-1 text-[11px]" aria-pressed={!!s.rangefinder} onclick={() => setRangefinder(s, true)} title="Where you stood, and the heading and distance of the crater through binoculars or a rangefinder">Rangefinder</button>
            </div>
            {#if s.rangefinder}
              {@const from = s.rangefinder}
              {@const at = craterGame(s)}
              <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <NumInput label="Your X" bind:value={from.x} step={0.01} />
                <NumInput label="Your Y" bind:value={from.y} step={0.01} />
                <NumInput label="Heading" unit="deg" bind:value={from.headingDeg} step={0.5} min={0} />
                <NumInput label="Distance" unit="m" bind:value={from.distanceM} step={1} min={0} />
              </div>
              <dl class="dl text-[12px]"><dt>Crater</dt><dd class="num">{at ? `X ${at.x.toFixed(2)}  Y ${at.y.toFixed(2)}` : '-'}</dd></dl>
            {:else}
              {@const cx = coord(s.crater, () => s.crater, 'x')}
              {@const cy = coord(s.crater, () => s.crater, 'y')}
              <div class="grid grid-cols-2 gap-1.5">
                <NumInput label="Crater X" bind:value={cx.get, cx.set} step={0.01} placeholder={r?.crater ? r.crater.x.toFixed(2) : ''} />
                <NumInput label="Crater Y" bind:value={cy.get, cy.set} step={0.01} placeholder={r?.crater ? r.crater.y.toFixed(2) : ''} />
              </div>
              {#if value(s.crater) || s.crater.auto}<FieldTag kind="crater" field={s.crater} fmt={fmtXY} onreset={() => (s.crater.manual = undefined)} />{/if}
              {#if r?.crater}
                <p class="m-0 text-[11.5px] text-muted" data-testid="solved-crater" title="From where you stood and the end of the flight (automation plan section 11)">
                  Solved from where you stood: <span class="num text-text">X {r.crater.x.toFixed(2)}  Y {r.crater.y.toFixed(2)}</span> +/-{r.crater.sigmaM.toFixed(0)} m
                </p>
              {/if}
            {/if}
            {#if s.clipId}
              {@const ox = coord(obs, () => observer(s), 'x')}
              {@const oy = coord(obs, () => observer(s), 'y')}
              <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1.5" title="Where you stood during the flight, from the minimap. The solver weighs it against the sightings.">
                <NumInput label="You stood at X" step={0.01} placeholder="minimap" bind:value={ox.get, ox.set} />
                <NumInput label="You stood at Y" step={0.01} placeholder="minimap" bind:value={oy.get, oy.set} />
                <button class="option h-[30px] justify-center px-2 text-[11px]" aria-pressed={!!ui.mapOpen[`${s.id}:obs`]} onclick={() => (ui.mapOpen[`${s.id}:obs`] = !ui.mapOpen[`${s.id}:obs`])} title="Pick where you stood on the map">Map</button>
              </div>
              {#if obs && (value(obs) || obs.auto)}<FieldTag kind="observer" field={obs} fmt={fmtXY} required="optional" onreset={() => (observer(s).manual = undefined)} />{/if}
              {#if ui.mapOpen[`${s.id}:obs`]}
                <CraterMap viewId={`${s.id}:obs`} shot={s} reachM={st.rangeMaxM} observer={value(obs)} onpick={(q) => (observer(s).manual = q)} />
              {/if}
            {/if}
            <div class="grid grid-cols-2 gap-1.5">
              <div class="flex min-w-0 flex-col gap-0.5">
                <NumInput label="Suspected heading" unit="deg" bind:value={s.sourceDeg} step={1} min={0} placeholder={r?.ambiguous ? 'required' : ''} />
                {#if r?.ambiguous && s.sourceDeg == null}
                  <span class="flex flex-wrap items-center gap-1 text-[11px]"><span class="tag warn px-1 py-0" title="Two directions fit the sightings about equally well">required</span><span class="num text-muted">{r.ambiguous.th.map((t) => t.toFixed(0)).join(' or ')} deg?</span></span>
                {/if}
              </div>
              <NumInput label="Tolerance" unit="deg" bind:value={() => s.sourceTolDeg ?? SOURCE_TOL_DEG, (v) => (s.sourceTolDeg = v)} step={1} min={1} />
            </div>
            {#if ui.mapOpen[s.id]}<CraterMap viewId={s.id} shot={s} reachM={st.rangeMaxM} observer={value(obs)} />{/if}
          </div>
        {/each}
      </div>
    </section>
  </div>

  <div class="flex flex-col gap-2">
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
      <header class="card-head">
        <h2 class="card-title" title="The solver uses the ballistics of the weapon: launch speed and drag from community data, not from Bulkhead.">Weapon</h2>
        {#if weapon}<span class="card-meta"><FieldTag kind="weapon" field={weapon.field} fmt={(w) => WEAPONS[w as Weapon].name} /></span>{/if}
      </header>
      <div class="card-body flex flex-col gap-2">
        <div class="grid grid-cols-3 gap-1">
          <button class="option flex-col items-start gap-0.5" aria-pressed={!st.weapon} onclick={() => setWeapon(undefined)} title="The solver tries each weapon and takes the one that fits clearly better">
            <span>Automatic</span>
            <span class="text-[11px] text-muted">{weapon?.field.auto?.value && !st.weapon ? WEAPONS[weapon.field.auto.value].name : 'by the fit'}</span>
          </button>
          {#each Object.entries(WEAPONS) as [k, w]}
            <button class="option flex-col items-start gap-0.5" aria-pressed={st.weapon === k} onclick={() => setWeapon(k as Weapon)}>
              <span>{w.name}</span>
              <span class="text-[11px] text-muted">{w.min} to {w.max} m{weapon?.rms[k as Weapon] != null ? `, fit ${weapon.rms[k as Weapon]!.toFixed(2)} deg` : ''}</span>
            </button>
          {/each}
        </div>
        {#if st.weapon}
          <div class="grid grid-cols-2 gap-2">
            <NumInput required label="Min range" unit="m" bind:value={() => st.rangeMinM, (v) => (st.rangeMinM = v!)} />
            <NumInput required label="Max range" unit="m" bind:value={() => st.rangeMaxM, (v) => (st.rangeMaxM = v!)} />
          </div>
        {/if}
        <label class="flex items-center gap-1.5 text-copy"><input type="checkbox" bind:checked={st.limitToRange} /> Keep results inside the weapon range</label>
      </div>
    </section>

    <section class="card">
      <header class="card-head"><h2 class="card-title" title="The accuracy estimate uses these values as the size of its random errors, for the values you gave. Automatic values bring their own.">Accuracy</h2></header>
      <div class="card-body grid grid-cols-2 gap-2">
        <NumInput required label="Mark accuracy" unit="px" bind:value={() => st.markSigmaPx, (v) => (st.markSigmaPx = v! > 0 ? v! : st.markSigmaPx)} step={0.1} />
        <NumInput required label="Compass accuracy" unit="deg" bind:value={() => st.compassSigmaDeg, (v) => (st.compassSigmaDeg = v! > 0 ? v! : st.compassSigmaDeg)} step={0.1} />
      </div>
    </section>
  </div>
</div>
