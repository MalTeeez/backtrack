<script lang="ts">
  /**
   * The sign-off list of Review (docs/review-plan.md, stage 4) shows the findings of the shot, filtered (all, open,
   * done), in sections by time or by type. Each finding has a checkbox on the left. The quick sign-off signs off every
   * open finding at or above a confidence, and marks those findings in the list. A click on a finding opens its numbers
   * and shows its time.
   */
  import ThinSlider from '../ThinSlider.svelte';
  import Dropdown from '../Dropdown.svelte';
  import { ICONS, type Icon } from '../../lib/icons.ts';
  import { fold, sideOf, slideIn, slideOut, type Side } from '../../lib/motion.ts';
  import { TYPES, findings, isDone, type Finding, type FindingType } from '../../lib/review/findings.ts';
  import { clipView, currentShot, project, ui } from '../../lib/state/project.svelte.ts';
  import { go, video } from '../../lib/state/player.svelte.ts';
  import { detection } from '../../lib/state/detect.svelte.ts';
  import type { ProjectResult } from '../../lib/solver/result.ts';

  let { result, onopen }: { result: ProjectResult | null; onopen?: (f: Finding) => void } = $props();
  const view = ui.signoffView;

  const shot = $derived(currentShot());
  const clipId = $derived(shot.clipId ?? ui.clipId);
  const all = $derived(clipId ? findings(project, clipId, shot, result?.shots.find((r) => r.shotId === shot.id)) : []);
  const done = $derived(new Set(all.filter((f) => isDone(f, shot)).map((f) => f.id)));
  const shown = $derived(all.filter((f) => view.filter === 'all' || (view.filter === 'done') === done.has(f.id)));
  const will = $derived(all.filter((f) => !done.has(f.id) && f.conf * 100 >= view.threshold));
  // the confidences of the open findings in whole percent, down, so a threshold on one still includes it
  const openConf = $derived(all.filter((f) => !done.has(f.id)).map((f) => Math.max(50, Math.floor(f.conf * 100))));

  const ICON: Record<FindingType, Icon> = { map: ICONS.map, section: ICONS.film, camera: ICONS.compass, shell: ICONS.crosshair, dropped: ICONS.eyeOff, impact: ICONS.flame, position: ICONS.mapPin, height: ICONS.mountain, crater: ICONS.circleDot, timing: ICONS.timer };
  const ORDER = Object.keys(TYPES) as FindingType[];
  const byTime = (a: Finding, b: Finding) => (a.t ?? -1) - (b.t ?? -1) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type);

  /** The sections of the list in the chosen order. Each has a key, a title, an icon and its findings. */
  const sections = $derived.by(() => {
    const flip = <X,>(xs: X[]) => (view.reverse ? [...xs].reverse() : xs);
    if (view.sort === 'type') {
      return flip(ORDER.map((t) => ({ key: `type:${t}`, title: TYPES[t], icon: ICON[t], items: flip(shown.filter((f) => f.type === t).sort(byTime)) })).filter((s) => s.items.length));
    }
    if (view.sort === 'conf') return [{ key: 'conf', title: 'By confidence', icon: ICONS.gauge, items: flip([...shown].sort((a, b) => a.conf - b.conf || byTime(a, b))) }].filter((s) => s.items.length);
    return [
      { key: 'whole', title: 'Whole clip', icon: ICONS.clapperboard, items: flip(shown.filter((f) => f.t == null).sort(byTime)) },
      { key: 'time', title: 'By time', icon: ICONS.clock, items: flip(shown.filter((f) => f.t != null).sort(byTime)) },
    ].filter((s) => s.items.length);
  });

  // a new filter or order slides the list in from the side of the new choice
  const FILTERS = ['all', 'open', 'done'], SORTS = ['time', 'type', 'conf'];
  const listKey = $derived(`${view.filter}|${view.sort}|${view.reverse}`);
  let side = $state<Side>('end'), last = { f: -1, s: -1 };
  $effect.pre(() => {
    const f = FILTERS.indexOf(view.filter), s = SORTS.indexOf(view.sort);
    if (last.f >= 0 && f !== last.f) side = sideOf(last.f, f);
    else if (last.s >= 0 && s !== last.s) side = sideOf(last.s, s);
    last = { f, s };
  });

  function sign(fs: Finding[], on = true) {
    shot.signoff ??= {};
    for (const f of fs) {
      if (f.manual) continue;
      if (on) shot.signoff[f.id] = f.key;
      else delete shot.signoff[f.id];
    }
  }
  let opened = $state<string | null>(null);
  function open(f: Finding) {
    opened = opened === f.id ? null : f.id;
    if (f.t != null && clipId && opened) { video.pause(); go(clipId, f.t); }
    if (opened) onopen?.(f);
  }
  function fix(f: Finding) {
    if (clipId && f.fix.t != null) clipView(clipId).t = f.fix.t;
    ui.phase = f.fix.phase;
  }
  const pct = (c: number) => `${Math.round(c * 100)}%`;
  const tone = (c: number) => (c >= 0.9 ? 'var(--ok)' : c >= 0.7 ? 'var(--accent)' : 'var(--warn)');
</script>

<div class="list" data-testid="signoff">
  <div class="tb">
    <span class="seg" role="group" aria-label="Show">
      {#each [['all', 'All', all.length], ['open', 'Open', all.length - done.size], ['done', 'Done', done.size]] as const as [k, label, n] (k)}
        <button aria-pressed={view.filter === k} onclick={() => (view.filter = k)} data-testid="filter-{k}">{label} {n}</button>
      {/each}
    </span>
    <span class="ml-auto"></span>
    <Dropdown bind:value={view.sort} icon={ICONS.arrowDownUp} label="Order" options={[['time', 'Time, then type'], ['type', 'Type, then time'], ['conf', 'Confidence, least sure first']]}>
      {#snippet extra(close)}
        <button role="menuitemcheckbox" aria-checked={view.reverse} onclick={() => { view.reverse = !view.reverse; close(); }}>
          <span>{#if view.reverse}<ICONS.check size={12} />{/if}</span>Reverse the order
        </button>
      {/snippet}
    </Dropdown>
  </div>

  <!-- how the quick sign-off at the bottom works, over the list it marks -->
  <p class="hint">{will.length ? (will.length === 1 ? '1 open finding reaches the confidence of the quick sign-off below. It has an outlined check.' : `${will.length} open findings reach the confidence of the quick sign-off below. They have an outlined check.`) : 'No open finding reaches the confidence of the quick sign-off below.'}</p>

  <div class="rows" data-scroll-min>
    {#key listKey}
    <div class="pane" in:slideIn={{ from: side }} out:slideOut={{ to: side === 'end' ? 'start' : 'end' }}>
    {#each sections as s (s.key)}
      {@const folded = !!view.folded[s.key]}
      {@const openHere = s.items.filter((f) => !done.has(f.id))}
      <div class="grp">
        <button class="fold" aria-expanded={!folded} onclick={() => (view.folded[s.key] = !folded)} title={folded ? 'Unfold' : 'Fold'}>
          <span class="chev" class:shut={folded}><ICONS.chevronDown size={12} /></span><s.icon size={12} /><span class="gt">{s.title}</span>
        </button>
        <span class="cnt">{openHere.length} open</span>
        {#if openHere.length}<button class="btn sm" onclick={() => sign(openHere)} title="Sign off every open finding of this section">Sign off {openHere.length}</button>{/if}
      </div>
      <div class="acc" class:shut={folded}>
        <div>
          {#each s.items as f (f.id)}
            {@const isDoneNow = done.has(f.id)}
            {@const I = ICON[f.type]}
            <div class="it" class:done={isDoneNow} class:will={!isDoneNow && f.conf * 100 >= view.threshold} class:opened={opened === f.id} data-testid="finding-{f.type}">
              <span class="tm">{view.sort === 'time' && f.t != null ? f.t.toFixed(2) : ''}</span>
              <button class="chk" role="checkbox" aria-checked={isDoneNow} disabled={f.manual} onclick={() => sign([f], !isDoneNow)}
                title={f.manual ? 'You gave this value' : isDoneNow ? 'Undo the sign-off' : 'Sign off'} aria-label={isDoneNow ? 'Undo the sign-off' : 'Sign off'}>
                {#if isDoneNow || f.conf * 100 >= view.threshold}<ICONS.check size={11} />{/if}
              </button>
              <span class="ic"><I size={13} /></span>
              <button class="tx" onclick={() => open(f)} title="Show its numbers{f.t != null ? ' and its time' : ''}">
                <span class="n">{TYPES[f.type]}</span>
                <span class="v">{view.sort !== 'time' && f.t != null ? `${f.t.toFixed(2)} s, ` : ''}{f.value}</span>
              </button>
              <span class="cf" title="Confidence"><span>{f.info ? 'info' : pct(f.conf)}</span><span class="meter"><i style="width:{f.conf * 100}%; background:{tone(f.conf)}"></i></span></span>
              {#if opened === f.id}
                <dl class="more" transition:fold>
                  {#each f.details as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}
                  <span class="acts">
                    {#if isDoneNow && !f.manual}<button class="btn sm quiet" onclick={() => sign([f], false)}><ICONS.rotateCcw size={12} /> Undo the sign-off</button>{/if}
                    <button class="btn sm" onclick={() => fix(f)}><ICONS.squarePen size={12} /> Edit in {f.fix.phase === 'mark' ? 'Mark' : 'Coordinates'}</button>
                  </span>
                </dl>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <p class="empty">{all.length ? 'Nothing here with this filter.' : detection.running || detection.queue.length ? 'The findings show here as the detection finds them.' : 'Run the detection on a section of this shot to fill the list.'}</p>
    {/each}
    </div>
    {/key}
  </div>

  <!-- the quick sign-off, under the list. The slider moves by 1 percent and takes the confidence of a finding near it. -->
  <div class="quick">
    <span class="lbl"><ICONS.gauge size={12} /> Sign off on detections with <b class="val">{view.threshold}%</b> confidence or above</span>
    <div class="go">
      <ThinSlider bind:value={view.threshold} step={1} notch={5} marks={openConf} label="The confidence the quick sign-off starts at" />
      <button class="btn sm primary" disabled={!will.length} onclick={() => sign(will)} data-testid="signoff-all" title="Sign off the open findings at or above the threshold">
        <ICONS.checkCheck size={12} /> Sign off {will.length === 1 ? 'this one' : `these ${will.length}`}
      </button>
    </div>
  </div>
</div>

<style>
  .list { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 11.5px; }
  .tb { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .seg { display: inline-flex; border: 1px solid var(--line-strong); }
  .seg button { padding: 1px 8px; font-size: 11px; color: var(--muted); }
  .seg button[aria-pressed='true'] { background: var(--accent-fill); color: var(--text); }
  .quick { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px 8px; border-top: 1px solid var(--line); background: var(--head-bg); }
  .val { font-weight: 400; color: var(--text); font-variant-numeric: tabular-nums; }
  .lbl { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
  .go { display: flex; align-items: center; gap: 10px; }
  .hint { margin: 0; padding: 4px 8px; border-bottom: 1px solid var(--line); font-size: 10.5px; color: var(--muted); }
  /* the list before and after a switch share one grid cell while they pass */
  .rows { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: grid; grid-template: 'a' auto / 1fr; align-content: start; }
  .pane { grid-area: a; min-width: 0; }
  .grp { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--line-strong); background: var(--head-bg); }
  .fold { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); text-align: left; }
  .fold:hover { color: var(--text); }
  .chev { display: inline-flex; transition: rotate 0.3s cubic-bezier(0.87, 0, 0.13, 1); }
  .chev.shut { rotate: -90deg; }
  .cnt { font-size: 10.5px; color: var(--muted); }
  /* a section folds like the accordions of oxide.computer. Its height eases between 0 and its content. */
  .acc { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 0.3s cubic-bezier(0.87, 0, 0.13, 1); }
  .acc.shut { grid-template-rows: 0fr; }
  .acc > div { min-height: 0; overflow: hidden; }
  .it { display: grid; grid-template-columns: 34px 14px 16px 1fr auto; align-items: center; gap: 0 8px; padding: 5px 8px; border-bottom: 1px solid var(--line); }
  .it.will { background: var(--accent-soft); }
  .it.opened { background: var(--accent-fill); }
  .tm { font-size: 10px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
  .chk { width: 13px; height: 13px; display: grid; place-items: center; border: 1px solid var(--line-strong); background: var(--panel-solid); color: transparent; }
  .it.will .chk { border-color: var(--accent); color: var(--accent); }
  .it.done .chk { background: var(--ok); border-color: var(--ok); color: var(--panel-solid); }
  .chk:disabled { cursor: default; }
  .ic { color: var(--accent); display: inline-flex; }
  .tx { min-width: 0; display: flex; flex-direction: column; text-align: left; }
  .n { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .v { color: var(--muted); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .it.done .n, .it.done .v { opacity: 0.6; }
  .cf { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--muted); }
  .meter { width: 40px; height: 3px; background: var(--line); position: relative; }
  .meter i { position: absolute; inset: 0 auto 0 0; }
  .more { grid-column: 4 / span 2; display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; margin: 6px 0 2px; font-size: 10.5px; }
  .more dt { color: var(--muted); }
  .more dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; }
  .acts { grid-column: 1 / span 2; display: flex; justify-content: flex-end; gap: 6px; padding-top: 6px; }
  .empty { margin: 0; padding: 16px; color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .acc, .chev { transition: none; } }
</style>
