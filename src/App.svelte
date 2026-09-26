<script lang="ts">
  import logo from './assets/logo.svg';
  import Settings from '@jis3r/icons/icons/settings';
  import Sun from '@jis3r/icons/icons/sun';
  import TriangleAlert from '@jis3r/icons/icons/triangle-alert';
  import LayoutDashboard from '@jis3r/icons/icons/layout-dashboard';
  import { ArrowRight, Check, Columns2, Monitor, Moon, Redo2, Undo2 } from '@lucide/svelte';
  import { history, record, redo, undo } from './lib/state/history.svelte.ts';
  import Spinner from './components/Spinner.svelte';
  import RecordPhase from './components/phases/RecordPhase.svelte';
  import MarkPhase from './components/phases/MarkPhase.svelte';
  import ReviewPhase from './components/phases/ReviewPhase.svelte';
  import SetupPhase from './components/phases/SetupPhase.svelte';
  import CoordinatesPhase from './components/phases/CoordinatesPhase.svelte';
  import ResultPhase from './components/phases/ResultPhase.svelte';
  import { missing, openPhases } from './lib/state/missing.ts';
  import { listClips, loadSaved, save } from './lib/state/persistence.ts';
  import { DATA_VERSION, clipData, clipInfo, clipMap, clips, fixShot, loadProject, project, ui, type Phase, type Ui } from './lib/state/project.svelte.ts';
  import type { ProjectData } from './lib/solver/types.ts';
  import MapChooser from './components/MapChooser.svelte';
  import SettingsDialog, { openSettings } from './components/SettingsDialog.svelte';
  import { prefs } from './lib/state/prefs.svelte.ts';
  import { cycleTheme, theme } from './lib/state/theme.svelte.ts';
  import { sideOf, slideIn, slideOut, type Side } from './lib/motion.ts';
  import { presets } from './lib/dock/layout.ts';
  import { Agentation } from '@panth977/agentation-svelte';
  import { installHoverLock } from './dev/hover-lock';

  $effect(() => (import.meta.env.DEV ? installHoverLock() : undefined));

  // Setup asks for the map, the FOV, and the shot sections. Review follows, and Mark and Coordinates form one group
  // with it as its manual pages.
  const PHASES: [Phase, string][] = [
    ['record', 'Record'],
    ['setup', 'Setup'],
    ['review', 'Review'],
    ['mark', 'Mark'],
    ['coordinates', 'Coordinates'],
    ['result', 'Result'],
  ];
  // the checks and the counts see only the selected clip, because a shot belongs to one clip for now
  const clipView = $derived(clipData());
  const need = $derived(missing(clipView, clips.list));
  const gates = $derived(openPhases(need));
  // Review opens with Mark, because it shows what the detection found for marking
  const open = $derived([gates[0], gates[1], gates[1], gates[1], gates[2], gates[3]]);
  // Setup is done once the selected clip is set to manual, or has a detected section
  const setupDone = $derived(!!ui.clipId && (project.clips[ui.clipId]?.mode === 'manual' || !!project.clips[ui.clipId]?.sections?.length));
  // the result phase needs everything before it
  const needFor = $derived<Record<Phase, string[]>>({
    record: need.record,
    setup: [],
    review: [...need.mark, ...need.coordinates],
    mark: need.mark,
    coordinates: need.coordinates,
    result: [...need.record, ...need.mark, ...need.coordinates],
  });
  // a phase is done when the phase that follows it is open. Record opens Mark, Mark opens Coordinates, and Review and
  // Coordinates open the result.
  const NEXT: Record<Phase, number> = { record: 3, setup: -1, review: 5, mark: 4, coordinates: 5, result: -1 };
  const done = (i: number) => (PHASES[i][0] === 'setup' ? setupDone : NEXT[PHASES[i][0]] > 0 && open[NEXT[PHASES[i][0]]]);
  /** Says why a locked phase is locked. It names the first unfinished phase before it and what that phase lacks. */
  function lockedBecause(i: number) {
    const j = PHASES.findIndex(([p], k) => k < i && p !== 'review' && p !== 'setup' && !done(k));
    return `Finish ${PHASES[j][1]} first. ${needFor[PHASES[j][0]].join(' ')}`;
  }
  // the strip under the top bar lists what the current phase lacks and the warnings from marking
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
  let loadNote = $state('');
  Promise.all([loadSaved(), listClips()])
    .then(([saved, list]) => {
      // marks of another version of the data do not load, but the clips stay
      if (saved && saved.version === DATA_VERSION) loadProject(saved.data, saved.ui);
      else {
        if (saved) loadNote = 'The saved marks come from an older version of Backtrack and did not load. The clips are still here.';
        loadProject($state.snapshot(project));
      }
      clips.list = list;
      if (!list.some((c) => c.id === ui.clipId)) ui.clipId = list[0]?.id ?? null;
      fixShot();
      // reopen on the furthest phase the selected clip can reach
      const g = openPhases(missing(clipData(), list)), reach = [g[0], g[1], g[1], g[1], g[2], g[3]];
      const i = PHASES.findIndex(([p]) => p === ui.phase);
      if (!reach[i]) ui.phase = PHASES[reach.lastIndexOf(true)][0];
    })
    .catch((e) => (loadError = `The app could not read the saved data (${e?.message ?? e}). It will not keep changes.`))
    .finally(() => (ready = true));

  // the project takes the FOV of the user's settings, because the solver and the annotation files read it from there.
  // The effect also reads the project's value, so it corrects an undo that brings back an old FOV.
  $effect(() => {
    if (!ready) return;
    const st = project.settings;
    if (st.fovDeg !== prefs.fovDeg) st.fovDeg = prefs.fovDeg;
    if (st.fovAxis !== prefs.fovAxis) st.fovAxis = prefs.fovAxis;
  });

  // Save a moment after the last change. The project and the UI state each have their own copy, so a change of the UI
  // state, which a drag of a window makes on every move, does not copy the whole project.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedData: ProjectData | undefined, savedUi: Omit<Ui, 'tool'> | undefined;
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => savedData && savedUi && save({ data: savedData, ui: savedUi, version: DATA_VERSION }).catch(() => {}), 250);
  };

  // every change of the project goes into the undo history, from the saved project on
  $effect(() => {
    const data = $state.snapshot(project);
    if (!ready || loadError) return;
    record(data);
    savedData = data;
    saveSoon();
  });
  $effect(() => {
    const { tool: _, ...rest } = $state.snapshot(ui);
    if (!ready || loadError) return;
    savedUi = rest;
    saveSoon();
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
  // Review has no window of its own for the actions of the page, so the header holds its Arrange button.
  const canArrange = $derived(ui.phase === 'review');
  const split = $derived(canSplit && ui.split);
  // a new phase slides in from the side of the phase bar it lies on, seen from the phase before
  let phaseSide = $state<Side>('end'), lastPhase = -1;
  $effect.pre(() => {
    const i = PHASES.findIndex(([p]) => p === ui.phase);
    if (lastPhase >= 0 && i !== lastPhase) phaseSide = sideOf(lastPhase, i);
    lastPhase = i;
  });
  // while the prompt picks the mode of a clip, the header shows only the phases
  const prompting = $derived(ui.phase === 'setup' && !!ui.clipId && project.clips[ui.clipId]?.mode !== 'auto');
  const THEME_LABEL = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };
</script>

<svelte:window {onkeydown} />
<SettingsDialog />

<div class="flex h-dvh flex-col gap-2 p-2">
  <header class="navbar shrink-0">
    <div class="flex items-center gap-2">
      <img src={logo} alt="" class="h-5 w-auto" />
      <span class="title text-[18px] uppercase leading-none">Backtrack</span>
    </div>

    <nav class="phasebar mx-auto" aria-label="Phase">
      {#snippet phase(p: Phase, label: string, i: number, n: number | null)}
        <button
          class="tab {n == null ? 'sub' : ''}"
          aria-pressed={ui.phase === p}
          disabled={!open[i]}
          title={open[i] ? needFor[p].join('\n') : lockedBecause(i)}
          onclick={() => (ui.phase = p)}
          data-testid="phase-{p}"
        >
          {#if n != null}<span class="font-small text-[11px] font-normal text-accent">{String(n).padStart(2, '0')}</span>{/if}
          {label}
          {#if done(i)}<Check size={14} class="text-ok" aria-label="done" />{:else if needFor[p].length && p !== 'result'}<span class="tag warn px-1 py-0">{needFor[p].length}</span>{/if}
        </button>
      {/snippet}
      {@render phase('record', 'Record', 0, 1)}
      <ArrowRight size={16} class="shrink-0 {open[1] ? 'text-accent' : 'text-muted'}" aria-hidden="true" />
      {@render phase('setup', 'Setup', 1, 2)}
      <ArrowRight size={16} class="shrink-0 {open[2] ? 'text-accent' : 'text-muted'}" aria-hidden="true" />
      <span class="phasegroup" role="group" aria-label="Review and the manual pages">
        {@render phase('review', 'Review', 2, 3)}
        {@render phase('mark', 'Mark', 3, null)}
        {@render phase('coordinates', 'Coordinates', 4, null)}
      </span>
      <ArrowRight size={16} class="shrink-0 {open[5] ? 'text-accent' : 'text-muted'}" aria-hidden="true" />
      {@render phase('result', 'Result', 5, 4)}
    </nav>

    <!-- A thin line parts the groups of the header: the phases, the clip, undo and redo, and the theme. -->
    {#snippet sep()}<span class="h-5 w-px shrink-0 bg-line-strong" aria-hidden="true"></span>{/snippet}
    <div class="flex items-center gap-3">
      {@render sep()}
      <!-- the map of the selected clip (automation plan section 4) -->
      <!-- the map and the FOV of the clip, once it is past the prompt that picks its mode -->
      {#if ui.clipId && ui.phase !== 'record' && !prompting}
        {@const id = ui.clipId}
        <label class="flex items-center gap-1.5" title="The map of this clip. The maps show its image, and the solver uses its terrain." data-testid="clip-map">
          <span class="label">Map</span>
          <span class="w-28"><MapChooser value={clipMap(id)} auto={project.clips[id]?.map.auto} onpick={(m) => (clipInfo(id).map.manual = m)} /></span>
        </label>
      {/if}
      {#if !prompting}
      <!-- the settings of the user hold the FOV of the game, which the detection needs before any mark -->
      <button class="btn sm {prefs.saved ? '' : 'text-warn'}" onclick={openSettings} data-testid="settings"
        title={prefs.saved ? `Open the settings. The game FOV is ${prefs.fovDeg} deg (${prefs.fovAxis === 'h' ? 'horizontal' : 'vertical'}).` : 'Set the FOV of the game. Every angle depends on it.'}>
        <Settings size={13} /> FOV {prefs.fovDeg}{prefs.saved ? '' : '?'}
      </button>
      {/if}
      <!-- the button stays in the layout, so the header does not shift between phases. It hides where it does not apply,
           and the Arrange button of the pages with windows takes its place. -->
      <button
        class="btn sm {canSplit ? '' : canArrange ? 'hidden' : 'invisible'}" aria-pressed={ui.split} onclick={() => (ui.split = !ui.split)} data-testid="split"
        title={ui.split ? 'Hide the result' : 'Show the result next to this phase, to see at once what each change does'}
      ><Columns2 size={13} /><span class="hidden min-[1800px]:inline"> Split with result</span></button>
      <button class="btn sm {canArrange ? '' : 'hidden'}" onclick={() => presets[ui.phase] && (ui.docks[ui.phase] = presets[ui.phase]())} data-testid="arrange"
        title="Put every window back where the page first put it"><LayoutDashboard size={13} /><span class="hidden min-[1800px]:inline"> Arrange</span></button>
      <!-- a sign that opens the list of what the phase lacks and the warnings. It keeps its place when empty, so the
           header does not shift. -->
      <button
        class="btn sm text-warn {strip.length ? '' : 'invisible'}" popovertarget="missing-list" title={stripTitle} data-testid="missing"
      ><TriangleAlert size={13} /> {strip.length}</button>
      <div id="missing-list" popover="auto" class="pop corner" style="--w:440px">
        <div class="card-title mb-2 text-warn">{stripTitle}</div>
        <ul class="m-0 list-disc pl-5 text-[12px] text-copy">{#each strip as m}<li>{m}</li>{/each}</ul>
      </div>
      <!-- the counts, where the header has the room, right against undo and redo -->
      <span class="hidden items-center gap-3 min-[1800px]:flex">
        <span class="flex items-baseline gap-1.5"><span class="num text-[13px] text-text">{clips.list.length}</span><span class="label">{clips.list.length == 1 ? 'clip' : 'clips'}</span></span>
        <span class="flex items-baseline gap-1.5"><span class="num text-[13px] text-text">{clipView.sightings.length}</span><span class="label">{clipView.sightings.length == 1 ? 'sighting' : 'sightings'}</span></span>
        <span class="flex items-baseline gap-1.5"><span class="num text-[13px] text-text">{clipView.shots.length}</span><span class="label">{clipView.shots.length == 1 ? 'shot' : 'shots'}</span></span>
      </span>
      {@render sep()}
      <button class="btn icon sm" onclick={undo} disabled={!history.undo} aria-label="Undo" title="Undo (Ctrl+Z)" data-testid="undo"><Undo2 size={14} /></button>
      <button class="btn icon sm" onclick={redo} disabled={!history.redo} aria-label="Redo" title="Redo (Ctrl+Shift+Z or Ctrl+Y)" data-testid="redo"><Redo2 size={14} /></button>
      {@render sep()}
      <button class="btn icon sm" onclick={cycleTheme} title={THEME_LABEL[theme.mode]} aria-label={THEME_LABEL[theme.mode]}>
        {#if theme.mode === 'system'}<Monitor size={14} />{:else if theme.mode === 'dark'}<Moon size={14} />{:else}<Sun size={14} />{/if}
      </button>
    </div>
  </header>

  {#if loadError}<p class="note bad shrink-0">{loadError}</p>{/if}
  {#if loadNote}<p class="note warn shrink-0">{loadNote} <button class="btn sm ml-2" onclick={() => (loadNote = '')}>OK</button></p>{/if}


  <!-- a phase change slides the new page in from the side of its phase, and the old one out to the other side. Both
       share one grid cell while they pass. -->
  <main class="grid min-h-0 flex-1 overflow-hidden">
    {#if !ready}
      <div class="flex items-center justify-center gap-2 p-8 text-muted"><Spinner /> Loading...</div>
    {:else}
      {#key ui.phase}
        <div class="min-h-0 min-w-0 overflow-auto [grid-area:1/1]" in:slideIn={{ from: phaseSide }} out:slideOut={{ to: phaseSide === 'end' ? 'start' : 'end' }}>
          {#if ui.phase === 'record'}
            <RecordPhase />
          {:else if ui.phase === 'setup'}
            <SetupPhase />
          {:else if ui.phase === 'review'}
            <ReviewPhase />
          {:else if ui.phase === 'mark' || ui.phase === 'coordinates'}
            <div class="grid h-full min-h-0 gap-2 {split ? 'grid-cols-[minmax(0,1fr)_minmax(360px,34vw)]' : ''}">
              <div class="min-h-0 min-w-0 overflow-auto">{#if ui.phase === 'mark'}<MarkPhase />{:else}<CoordinatesPhase />{/if}</div>
              {#if split}<div class="min-h-0 min-w-0" data-testid="split-result"><ResultPhase compact /></div>{/if}
            </div>
          {:else}
            <ResultPhase />
          {/if}
        </div>
      {/key}
    {/if}
  </main>
</div>

{#if import.meta.env.DEV}
  <Agentation endpoint="http://localhost:4747" />
{/if}
