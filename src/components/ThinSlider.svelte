<script lang="ts">
  /**
   * A thin square slider. It has a 2 px track with a notch every `notch` and a label every 25, and ticks above the track
   * for the given marks (lit at or above the value). The part from the value to the end is filled. The arrow keys move
   * it by a step. A value within 1.5 steps of a mark takes the mark, so each mark is easy to reach.
   */
  let { value = $bindable(), min = 50, max = 100, step = 5, notch = step, marks = [], label, labels, major = 25, format = (v: number) => `${v}%`, onchange }: {
    value: number; min?: number; max?: number; step?: number; notch?: number; marks?: number[]; label: string;
    /** The values that get a label under the track. Defaults to the ends and the middle. */
    labels?: number[];
    /** A longer notch at every multiple of this. */
    major?: number;
    format?: (v: number) => string;
    onchange?: (v: number) => void;
  } = $props();
  const put = (v: number) => { value = v; onchange?.(v); };

  let track: HTMLDivElement;
  const at = (v: number) => ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100;
  const snap = (v: number) => {
    const mark = marks.reduce<number | null>((best, m) => (Math.abs(m - v) <= 1.5 * step && (best == null || Math.abs(m - v) < Math.abs(best - v)) ? m : best), null);
    return Math.max(min, Math.min(max, mark ?? Math.round(v / step) * step));
  };
  const notches = $derived(Array.from({ length: Math.floor((max - min) / notch) + 1 }, (_, k) => min + k * notch));
  function set(e: PointerEvent) {
    const r = track.getBoundingClientRect();
    put(snap(min + ((e.clientX - r.left) / r.width) * (max - min)));
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    set(e);
    // The slider gives the focus back after a drag, so the keys of the page (the arrows step frames) keep working.
    el.addEventListener('pointerup', () => el.blur(), { once: true });
  }
  function key(e: KeyboardEvent) {
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, Home: min - value, End: max - value }[e.key];
    if (d == null) return;
    // the page does not step frames for these keys
    e.preventDefault();
    e.stopPropagation();
    // a key moves by a whole step, past a mark too
    put(Math.max(min, Math.min(max, Math.round((value + d) / step) * step)));
  }
</script>

<div class="slider" role="slider" tabindex="0" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={format(value)}
  onpointerdown={down} onpointermove={(e) => { if (e.buttons & 1) set(e); }} onkeydown={key}>
  <div class="track" bind:this={track}>
    <span class="on" style="left:{at(value)}%"></span>
    {#each notches as n (n)}<span class="notch" class:major={n % major === 0} style="left:{at(n)}%"></span>{/each}
    {#each labels ?? [min, (min + max) / 2, max] as n (n)}<span class="lab" style="left:{at(n)}%">{n}</span>{/each}
    {#each marks as m, i (i)}<span class="mark" class:lit={m >= value} style="left:{at(m)}%"></span>{/each}
    <span class="thumb" style="left:{at(value)}%"></span>
  </div>
</div>

<style>
  /* the horizontal resize cursor, as on the speed slider */
  .slider { position: relative; height: 26px; min-width: 60px; flex: 1; cursor: ew-resize; touch-action: none; padding-inline: 5px; }
  .slider:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .track { position: absolute; left: 5px; right: 5px; top: 11px; height: 2px; background: var(--line-strong); }
  .on { position: absolute; top: 0; bottom: 0; right: 0; background: var(--accent); }
  .notch { position: absolute; top: 5px; width: 1px; height: 2px; background: var(--line-strong); }
  .notch.major { height: 4px; background: var(--muted); }
  .lab { position: absolute; top: 8px; transform: translateX(-50%); font-size: 8.5px; color: var(--muted); }
  .mark { position: absolute; top: -7px; width: 2px; height: 5px; transform: translateX(-50%); background: var(--muted); }
  .mark.lit { background: var(--accent); }
  .thumb { position: absolute; top: -5px; width: 8px; height: 12px; transform: translateX(-50%); background: var(--panel-solid); box-shadow: 0 0 0 1px var(--accent), 0 2px 2px #00000033; }
</style>
