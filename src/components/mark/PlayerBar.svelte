<script lang="ts">
  /**
   * The bar under a video: the playback speed, the frame steps with their keys, and the timecode, which turns into a
   * field that goes to a time or a frame. `left` adds controls after the speeds, and `jump` adds the buttons to the
   * previous and next mark (Up and Down).
   */
  import type { Snippet } from 'svelte';
  import ChevronLeft from '@jis3r/icons/icons/chevron-left';
  import ChevronRight from '@jis3r/icons/icons/chevron-right';
  import ChevronsLeft from '@jis3r/icons/icons/chevrons-left';
  import ChevronsRight from '@jis3r/icons/icons/chevrons-right';
  import Play from '@jis3r/icons/icons/play';
  import { Pause, SkipBack, SkipForward } from '@lucide/svelte';
  import Key from '../Key.svelte';
  import { timecode } from './Timeline.svelte';
  import { player, playerFrames, playerTime, togglePlay, video } from '../../lib/state/player.svelte.ts';
  import { frameIndexAt } from '../../lib/video/frames.ts';
  import Timecode from '../Timecode.svelte';
  import SpeedSlider from './SpeedSlider.svelte';

  let { duration, onstep, ongo, left, jump, testid = 'time' }: {
    duration: number; onstep: (n: number) => void; ongo: (t: number) => void; left?: Snippet;
    jump?: { go: (dir: -1 | 1) => void; enabled: boolean; what: string };
    testid?: string;
  } = $props();

  const SPEEDS = [0.25, 0.5, 0.75, 1, 2];
  const time = $derived(playerTime());
  const frames = $derived(playerFrames());

  let goingTo = $state<string | null>(null);
  /** Opens the field of the timecode (the G key of the page). */
  export const openGoTo = () => (goingTo = timecode(time));
  /**
   * Parses a time (m:ss.mmm or seconds) or a frame number (#469, f469, 1-based) into seconds of the clip. It returns
   * null when the text is unclear.
   */
  function parseGoTo(text: string): number | null {
    const t = text.trim().toLowerCase();
    const frame = /^(?:#|f|frame\s*)(\d+)$/.exec(t);
    if (frame) return frames?.length ? frames[Math.max(0, Math.min(frames.length - 1, Number(frame[1]) - 1))] : null;
    const clock = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
    return clock ? Number(clock[1] ?? 0) * 60 + Number(clock[2]) : null;
  }
  function goTo(text: string) {
    const t = parseGoTo(text);
    goingTo = null;
    if (t == null) return;
    video.pause();
    ongo(Math.max(0, Math.min(duration, t)));
  }
</script>

<div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-line px-2 py-1.5">
  <div class="flex items-center gap-1.5">
    <SpeedSlider speeds={SPEEDS} />
    {@render left?.()}
  </div>
  <!-- each button with its key caps under it -->
  <div class="flex items-start gap-1">
    {#snippet control(key: string, button: Snippet)}
      <div class="flex flex-col items-center gap-0.5">{@render button()}<Key k={key} /></div>
    {/snippet}
    {#snippet prev()}<button class="btn icon sm" onclick={() => jump?.go(-1)} aria-label="Previous {jump?.what}" title="Previous {jump?.what}" disabled={!jump?.enabled}><SkipBack size={14} /></button>{/snippet}
    {#snippet back10()}<button class="btn icon sm" onclick={() => onstep(-10)} aria-label="Back 10 frames" title="Back 10 frames"><ChevronsLeft size={14} /></button>{/snippet}
    {#snippet back1()}<button class="btn icon sm" onclick={() => onstep(-1)} aria-label="Back 1 frame" title="Back 1 frame"><ChevronLeft size={14} /></button>{/snippet}
    {#snippet play()}<button class="btn icon sm" onclick={togglePlay} aria-label={player.playing ? 'Pause' : 'Play'} title="Play or pause">{#if player.playing}<Pause size={15} />{:else}<Play size={15} />{/if}</button>{/snippet}
    {#snippet fwd1()}<button class="btn icon sm" onclick={() => onstep(1)} aria-label="Forward 1 frame" title="Forward 1 frame"><ChevronRight size={14} /></button>{/snippet}
    {#snippet fwd10()}<button class="btn icon sm" onclick={() => onstep(10)} aria-label="Forward 10 frames" title="Forward 10 frames"><ChevronsRight size={14} /></button>{/snippet}
    {#snippet next()}<button class="btn icon sm" onclick={() => jump?.go(1)} aria-label="Next {jump?.what}" title="Next {jump?.what}" disabled={!jump?.enabled}><SkipForward size={14} /></button>{/snippet}
    {#if jump}{@render control('Up', prev)}{/if}
    {@render control('Shift+Left', back10)}
    {@render control('Left', back1)}
    {@render control('Space', play)}
    {@render control('Right', fwd1)}
    {@render control('Shift+Right', fwd10)}
    {#if jump}{@render control('Down', next)}{/if}
  </div>
  <div class="flex flex-col items-end leading-tight" data-testid={testid} data-t={time} data-d={duration}>
    {#if goingTo != null}
      <!-- go to a time (1:23.456 or 83.456) or a frame (#469 or f469) -->
      <input
        class="control num h-9.5 w-40 text-right text-[18px]" aria-label="Go to a time or a frame" data-testid="goto"
        title="A time, like 1:23.456 or 83.456, or a frame, like #469. Enter goes there, Escape cancels."
        bind:value={goingTo} {@attach (el: HTMLInputElement) => { el.focus(); el.select(); }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goTo(goingTo!); } else if (e.key === 'Escape') goingTo = null; }}
        onblur={() => (goingTo = null)}
      />
    {:else}
      <!-- the field and the timecode take the same height, so the video keeps its size while the field is open -->
      <button class="flex h-9.5 items-end text-[22px] text-text hover:text-accent" onclick={openGoTo} title="Go to a time or a frame (G)"><Timecode t={time} /></button>
    {/if}
    <span class="num whitespace-nowrap text-[11px] text-muted">
      {#if frames?.length}<button class="num hover:text-accent" onclick={() => (goingTo = `#${frameIndexAt(frames!, time) + 1}`)} title="Go to a frame (G)">frame {frameIndexAt(frames, time) + 1} / {frames.length}</button>{', '}{/if}{timecode(duration, 2)}
    </span>
  </div>
</div>
