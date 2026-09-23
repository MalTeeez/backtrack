<script lang="ts">
  import logo from './assets/logo.svg';
  import { ArrowRight, Check, Columns2, Monitor, Moon, Redo2, Sun, TriangleAlert, Undo2 } from '@lucide/svelte';
  import { history, record, redo, undo } from './lib/state/history.svelte.ts';
  import Spinner from './components/Spinner.svelte';
  import RecordPhase from './components/phases/RecordPhase.svelte';
  import MarkPhase from './components/phases/MarkPhase.svelte';
  import CoordinatesPhase from './components/phases/CoordinatesPhase.svelte';
  import ResultPhase from './components/phases/ResultPhase.svelte';
  import { missing, openPhases } from './lib/state/missing.ts';
  import { listClips, loadSaved, save } from './lib/state/persistence.ts';
  import { clips, loadProject, project, ui, type Phase } from './lib/state/project.svelte.ts';
  import { cycleTheme, theme } from './lib/state/theme.svelte.ts';

  const PHASES: [Phase, string][] = [
    ['record', 'Record'],
    ['mark', 'Mark'],
    ['coordinates', 'Coordinates'],
    ['result', 'Result'],
  ];
  const need = $derived(missing(project, clips.list));
  const open = $derived(openPhases(need));
  // the result phase needs everything before it
  const needFor = $derived<Record<Phase, string[]>>({
    record: need.record,
    mark: need.mark,
    coordinates: need.coordinates,
    result: [...need.record, ...need.mark, ...need.coordinates],
  });
  // a phase is done when the phase after it is open
  const done = (i: number) => i < PHASES.length - 1 && open[i + 1];
  /** Why a locked phase is locked: the first unfinished phase before it, and what that phase lacks. */
  function lockedBecause(i: number) {
    const j = PHASES.findIndex((_, k) => k < i && !done(k));
    return `Finish ${PHASES[j][1]} first. ${needFor[PHASES[j][0]].join(' ')}`;
  }
  // the strip under the top bar: what the current phase lacks, and the warnings from marking
  const warnings = $derived(ui.phase === 'mark' || ui.phase === 'result' ? need.warnings : []);
  const strip = $derived([...needFor[ui.phase], ...warnings]);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const stripTitle = $derived(
    [needFor[ui.phase].length && plural(needFor[ui.phase].length, 'missing item'), warnings.length && plural(warnings.length, 'warning')]
      .filter(Boolean)
      .join(', '),
  );

  let ready = $state(false);
  let loadError = $state('');
  Promise.all([loadSaved(), listClips()])
    .then(([saved, list]) => {
      if (saved) loadProject(saved.data, saved.ui);
      else loadProject($state.snapshot(project));
      clips.list = list;
      if (!list.some((c) => c.id === ui.clipId)) ui.clipId = list[0]?.id ?? null;
      // reopen on the furthest phase the saved project can reach
      const reach = openPhases(missing(project, list));
      const i = PHASES.findIndex(([p]) => p === ui.phase);
      if (!reach[i]) ui.phase = PHASES[reach.lastIndexOf(true)][0];
    })
    .catch((e) => (loadError = `The app could not read the saved data (${e?.message ?? e}). It will not keep changes.`))
    .finally(() => (ready = true));

  // every change of the project goes into the undo history, from the saved project on
  $effect(() => {
    const data = $state.snapshot(project);
    if (ready && !loadError) record(data);
  });

  // save a moment after the last change
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const data = $state.snapshot(project);
    const { tool: _, ...rest } = $state.snapshot(ui);
    if (!ready || loadError) return;
    clearTimeout(timer);
    timer = setTimeout(() => save({ data, ui: rest }).catch(() => {}), 250);
  });

  // Enter and Escape leave an input, so the shortcuts work again (plan section 10)
  // Ctrl+Z undoes and Ctrl+Shift+Z or Ctrl+Y redoes, except in a text field, which keeps its own undo
  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const inField = !!t.closest('input, select, textarea');
    if (inField && (e.key === 'Enter' || e.key === 'Escape')) t.blur();
    if (inField || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  }
  // the split view shows the result next to Mark and Coordinates. It stays when an exclusion leaves too little to
  // solve, and then shows why, because that is part of what it tests.
  const canSplit = $derived(ui.phase === 'mark' || ui.phase === 'coordinates');
  const split = $derived(canSplit && ui.split);
  const THEME_LABEL = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };
</script>

<svelte:window {onkeydown} />

<div class="flex h-dvh flex-col gap-2 p-2">
  <header class="navbar shrink-0">
    <div class="flex items-center gap-2">
      <img src={logo} alt="" class="h-7 w-auto" />
      <span class="title text-[24px] uppercase leading-none">Backtrack</span>
    </div>

    <nav class="phasebar mx-auto" aria-label="Phase">
      {#each PHASES as [p, label], i}
        {#if i}<ArrowRight size={16} class="shrink-0 {open[i] ? 'text-accent' : 'text-muted'}" aria-hidden="true" />{/if}
        <button
          class="tab"
          aria-pressed={ui.phase === p}
          disabled={!open[i]}
          title={open[i] ? needFor[p].join('\n') : lockedBecause(i)}
          onclick={() => (ui.phase = p)}
          data-testid="phase-{p}"
        >
          <span class="font-small text-[11px] font-normal text-accent">{String(i + 1).padStart(2, '0')}</span>
          {label}
          {#if done(i)}<Check size={14} class="text-ok" aria-label="done" />{:else if needFor[p].length && p !== 'result'}<span class="tag warn px-1 py-0">{needFor[p].length}</span>{/if}
        </button>
      {/each}
    </nav>

    <div class="flex items-center gap-3">
        <span class="flex items-baseline gap-1.5"><span class="num text-[14px] text-text">{clips.list.length}</span><span class="label">{clips.list.length == 1 ? "clip" : "clips"}</span></span>
        <span class="flex items-baseline gap-1.5"><span class="num text-[14px] text-text">{project.sightings.length}</span><span class="label">{project.sightings.length == 1 ? "sighting" : "sightings"}</span></span>
        <span class="flex items-baseline gap-1.5"><span class="num text-[14px] text-text">{project.shots.length}</span><span class="label">{project.shots.length == 1 ? "shot" : "shots"}</span></span>
      <!-- always in the layout, so the header does not shift between phases; hidden where it does not apply -->
      <button
        class="btn sm {canSplit ? '' : 'invisible'}" aria-pressed={ui.split} onclick={() => (ui.split = !ui.split)} data-testid="split"
        title={ui.split ? 'Hide the result' : 'Show the result next to this phase, to see at once what each change does'}
      ><Columns2 size={13} /> Split with result</button>
      <!-- what the phase lacks and the warnings: a sign that opens the list. It keeps its place when empty, so the
           header does not shift. -->
      <button
        class="btn sm text-warn {strip.length ? '' : 'invisible'}" popovertarget="missing-list" title={stripTitle} data-testid="missing"
      ><TriangleAlert size={13} /> {strip.length}</button>
      <div id="missing-list" popover="auto" class="pop corner" style="--w:440px">
        <div class="card-title mb-2 text-warn">{stripTitle}</div>
        <ul class="m-0 list-disc pl-5 text-[12px] text-copy">{#each strip as m}<li>{m}</li>{/each}</ul>
      </div>
      <button class="btn icon sm" onclick={undo} disabled={!history.undo} aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="undo"><Undo2 size={14} /></button>
      <button class="btn icon sm" onclick={redo} disabled={!history.redo} aria-label="Redo" title="Redo (Ctrl+Shift+Z or Ctrl+Y)" data-testid="redo"><Redo2 size={14} /></button>
      <button class="btn icon sm" onclick={cycleTheme} title={THEME_LABEL[theme.mode]} aria-label={THEME_LABEL[theme.mode]}>
        {#if theme.mode === 'system'}<Monitor size={14} />{:else if theme.mode === 'dark'}<Moon size={14} />{:else}<Sun size={14} />{/if}
      </button>
    </div>
  </header>

  {#if loadError}<p class="note bad shrink-0">{loadError}</p>{/if}


  <main class="min-h-0 flex-1 overflow-auto">
    {#if !ready}
      <div class="flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading...</div>
    {:else if ui.phase === 'record'}
      <RecordPhase />
    {:else if ui.phase === 'mark' || ui.phase === 'coordinates'}
      <div class="grid h-full min-h-0 gap-2 {split ? 'grid-cols-[minmax(0,1fr)_minmax(360px,34vw)]' : ''}">
        <div class="min-h-0 min-w-0 overflow-auto">{#if ui.phase === 'mark'}<MarkPhase />{:else}<CoordinatesPhase />{/if}</div>
        {#if split}<div class="min-h-0 min-w-0" data-testid="split-result"><ResultPhase compact /></div>{/if}
      </div>
    {:else}
      <ResultPhase />
    {/if}
  </main>
</div>
