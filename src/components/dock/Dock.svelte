<script lang="ts" module>
  import type { Icon } from '../../lib/icons.ts';
  /** The dock knows the title and the icon of a window. The page renders its body. */
  /** `max` is the largest size of the window in px. A resize does not grow it past that. */
  export interface WinMeta { title: string; icon: Icon; max?: { w?: number; h?: number } }
</script>

<script lang="ts">
  /**
   * The windows of a page (docs/review-plan.md, stage 2). A window is attached or floating, and the button at the top
   * right of its bar switches it. Attached windows fill the page in a tree of splits and stacks. Floating windows lie
   * on top, each at a share of the page, and move by their bar and resize from every edge and corner.
   *
   * The frames and the window bodies lie flat, absolutely placed. Thus a move, a reflow, an expand, or a restore only
   * moves boxes (eased in 0.25 s), and no window body mounts again. A tab or the empty part of a bar drags an attached
   * window. Over another window, the drag shows five zones and a shell where the window would land. The windows move
   * only on the drop. Every gutter and the corner grip of an attached window resize.
   */
  import { flushSync, untrack, type Snippet } from 'svelte';
  import { markParts, minHeight, minWidth } from '../../lib/dock/fit.ts';
  import { ICONS } from '../../lib/icons.ts';
  import BetweenHorizontalStart from '@jis3r/icons/icons/between-horizontal-start';
  import BetweenHorizontalEnd from '@jis3r/icons/icons/between-horizontal-end';
  import BetweenVerticalStart from '@jis3r/icons/icons/between-vertical-start';
  import BetweenVerticalEnd from '@jis3r/icons/icons/between-vertical-end';
  import { popIn, popOut, sideOf } from '../../lib/motion.ts';
  import { findStack, float, move, place, toggleMax, rects, resize, shareOf, setStack, stackOf, stacks, zoneAt, type Float, type Held, type Layout, type Rect, type Side, type Stack, type WinId } from '../../lib/dock/layout.ts';

  let { layout = $bindable(), wins, body }: { layout: Layout; wins: Record<WinId, WinMeta>; body: Snippet<[WinId]> } = $props();

  const BAR = 26, EDGE = 14;
  let W = $state(0), H = $state(0), box: HTMLDivElement;
  // The boxes ease only once the dock has its size, so the first layout does not grow out of the corner.
  let settled = $state(false);
  $effect(() => { if (W && H && !settled) requestAnimationFrame(() => (settled = true)); });

  // A drag of an attached window holds the window or its stack, and aims at a zone under the pointer.
  let drag = $state<{ held: Held; x: number; y: number; target?: { id: string; side: Side } } | null>(null);

  const R = $derived(rects(layout, W, H));
  const all = $derived(stacks(layout.root).filter((s) => s.tabs.length));
  const floats = $derived(layout.floating ?? []);
  // The windows the drag holds: one tab, or every tab of a stack.
  const heldWins = $derived(drag ? ('win' in drag.held ? [drag.held.win] : findStack(layout.root, drag.held.stack)?.tabs ?? []) : []);

  // The smallest size of each floating window, as fitFloats last measured its content.
  let mins = $state<Record<WinId, { w: number; h: number }>>({});
  /**
   * The pixels of a floating window. It keeps its max size and grows to the size its content needs, up to the size of
   * the page. It may lie partly outside the page. The layout keeps the size the user gave it, so a size measured too
   * large for a moment does not stay.
   */
  function px(f: Float): Rect {
    const max = wins[f.win]?.max, least = mins[f.win];
    const w = Math.min(W, Math.max(Math.min(f.r.w * W, max?.w ?? Infinity), least?.w ?? 0));
    const h = Math.min(H, Math.max(Math.min(f.r.h * H, max?.h ?? Infinity), least?.h ?? 0));
    return { x: f.r.x * W, y: f.r.y * H, w, h };
  }

  // The Attach button of a floating window under the pointer, whose spot the shell shows.
  let attaching = $state<WinId | null>(null);
  /** The shell shows where the held window lands: its stack in the layout that the drop makes. */
  const shell = $derived.by(() => {
    const aim = drag?.target ? { held: drag.held, ...drag.target } : attaching ? { held: { win: attaching }, ...attachTarget(attaching) } : null;
    if (!aim) return null;
    const next = move(layout, aim.held, aim.id, aim.side);
    const first = 'win' in aim.held ? aim.held.win : findStack(layout.root, aim.held.stack)?.tabs[0];
    const s = first ? stackOf(next.root, first) : undefined;
    return s ? rects(next, W, H).stacks[s.id] ?? null : null;
  });

  /**
   * Places the body of a window under the bar of its frame. An attached body shows while its tab is active and the
   * stack is open and shown. A floating body lies above the attached ones, in the order of the floating windows.
   */
  /** The layer of the frame of an expanded window, above every floating window. */
  const EXPANDED_Z = 500;
  function bodyOf(w: WinId): (Rect & { on: boolean; z: number; attached: boolean }) | null {
    const i = floats.findIndex((f) => f.win === w);
    if (i >= 0) {
      const p = px(floats[i]);
      return { x: p.x + 1, y: p.y + BAR, w: Math.max(0, p.w - 2), h: Math.max(0, p.h - BAR - 1), on: true, z: 11 + 3 * i, attached: false };
    }
    const s = all.find((x) => x.tabs.includes(w)), r = s && R.stacks[s.id];
    if (!s || !r) return null;
    // An expanded window lies above the floating ones too.
    const z = layout.expanded === s.id ? EXPANDED_Z + 1 : 1;
    return { x: r.x + 1, y: r.y + BAR, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - BAR - 1), on: s.tabs[s.active] === w && !s.min, z, attached: true };
  }

  // On a tab switch, the new body slides in from the side of its tab, and the old one slides out to the other side.
  const motion: Record<WinId, string> = $state({});
  function activate(id: string, i: number) {
    const s = findStack(layout.root, id);
    if (!s || s.active === i) return;
    const from = s.tabs[s.active], to = s.tabs[i], side = sideOf(s.active, i);
    motion[to] = `from-${side}`;
    motion[from] = `to-${side === 'end' ? 'start' : 'end'}`;
    layout = setStack(layout, id, { active: i });
    setTimeout(() => { delete motion[to]; delete motion[from]; }, 260);
  }

  const local = (e: PointerEvent) => { const b = box.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

  // A click on a tab or a bar selects, and a press that moves 4 px starts a drag.
  // `attach` is the floating window whose Attach button the press is on. A click there attaches it.
  let press: { held: Held; x: number; y: number; stack: string; tab?: number; attach?: WinId } | null = null;
  function down(e: PointerEvent, stack: string, tab?: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-ctl]')) return;
    const s = findStack(layout.root, stack)!;
    press = { held: tab != null ? { win: s.tabs[tab] } : { stack }, ...local(e), stack, tab };
    window.addEventListener('pointermove', pmove);
    window.addEventListener('pointerup', pup, { once: true });
  }
  function pmove(e: PointerEvent) {
    const p = local(e);
    if (!drag && press && Math.hypot(p.x - press.x, p.y - press.y) > 4) { drag = { held: press.held, ...p }; window.addEventListener('keydown', esc); }
    if (!drag) return;
    drag.x = p.x;
    drag.y = p.y;
    aim(p.x, p.y);
  }
  /** The zone at a point. It is a band along the dock edge or a zone of an attached window. */
  function targetAt(x: number, y: number, held: Held, inner = DRAG_INNER): { id: string; side: Side } | undefined {
    let t: { id: string; side: Side } | undefined;
    const edge: Side | null = x < EDGE ? 'left' : x > W - EDGE ? 'right' : y < EDGE ? 'top' : y > H - EDGE ? 'bottom' : null;
    if (edge) t = { id: 'root', side: edge };
    else for (const s of all) { const r = R.stacks[s.id], z = r && zoneAt(r, x, y, inner); if (z) { t = { id: s.id, side: z }; break; } }
    // A zone that changes nothing is no zone.
    return t && move(layout, held, t.id, t.side) !== layout ? t : undefined;
  }
  /** Aims the drag at the zone under the pointer. */
  function aim(x: number, y: number) {
    const t = targetAt(x, y, drag!.held);
    if (t?.id !== drag!.target?.id || t?.side !== drag!.target?.side) drag!.target = t;
  }
  function pup() {
    window.removeEventListener('pointermove', pmove);
    window.removeEventListener('keydown', esc);
    if (drag?.target) {
      if ('win' in drag.held) keepShownSize(drag.held.win);
      layout = move(layout, drag.held, drag.target.id, drag.target.side);
      const first = 'win' in drag.held ? drag.held.win : findStack(layout.root, drag.held.stack)?.tabs[0];
      if (first) growToMin(first);
    }
    else if (!drag && press?.tab != null) activate(press.stack, press.tab);
    else if (!drag && press?.attach) attach(press.attach);
    drag = null;
    press = null;
  }
  function esc(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    drag = null;
    press = null;
    window.removeEventListener('pointermove', pmove);
  }

  /** Floats the active window of a stack, a little below and right of where the stack lies. */
  function floatOut(s: Stack, r: Rect) {
    // The window takes the size it last had while it floated, or else the size of its stack. It moves down and right by
    // the height of a bar, as far as the page lets it.
    const win = s.tabs[s.active], was = layout.sizes?.[win];
    const w = Math.min(W, was ? was.w * W : r.w), h = Math.min(H, was ? was.h * H : r.h);
    const x = Math.max(0, Math.min(W - w, r.x + BAR)), y = Math.max(0, Math.min(H - h, r.y + BAR));
    layout = float(layout, win, { x: x / W, y: y / H, w: w / W, h: h / H });
  }
  /**
   * Where the Attach button puts a floating window: the zone under the middle of the window, as if a drag dropped it
   * there. Without a zone there, the window attaches at the right edge of the dock.
   */
  function attachTarget(w: WinId): { id: string; side: Side } {
    const f = floats.find((g) => g.win === w), p = f && px(f);
    return (p && targetAt(p.x + p.w / 2, p.y + p.h / 2, { win: w }, ATTACH_INNER)) ?? { id: 'root', side: 'right' };
  }
  /** Maximizes a floating window or puts it back, and measures its content again at its new width. */
  function maxFloat(w: WinId) {
    layout = toggleMax(layout, w);
    requestAnimationFrame(fitFloats);
  }
  function attach(w: WinId) {
    attaching = null;
    keepShownSize(w);
    const t = attachTarget(w);
    layout = move(layout, { win: w }, t.id, t.side);
    growToMin(w);
  }
  /**
   * Writes the size a floating window shows, which its content may have grown past the size in the layout, into the
   * layout. Attaching keeps that size for the next float.
   */
  function keepShownSize(w: WinId) {
    const f = floats.find((g) => g.win === w);
    if (!f) return;
    const p = px(f);
    layout = { ...layout, floating: layout.floating!.map((g) => (g.win === w ? { win: w, r: { ...g.r, w: p.w / W, h: p.h / H } } : g)) };
  }
  /** A drag on the Attach button of a floating window moves it into the attached windows, like a drag of a tab. */
  function attachDown(e: PointerEvent, w: WinId) {
    if (e.button !== 0) return;
    e.stopPropagation();
    press = { held: { win: w }, ...local(e), stack: '', attach: w };
    window.addEventListener('pointermove', pmove);
    window.addEventListener('pointerup', pup, { once: true });
  }

  // A drag of a floating window moves it by its bar (edges '') or resizes it by an edge or a corner (a mix of n, s, e
  // and w). The cursor of the drag holds over the whole dock while the pointer outruns the bar or the edge.
  let moving = $state<string | null>(null);
  const CURSOR: Record<string, string> = { '': 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const SNAP_PX = 12;
  let snapped = $state<Side[]>([]);

  /**
   * Measures the smallest size of each floating window from its content (lib/dock/fit.ts). px() grows the window to
   * it. It runs when the page opens and when its size changes, so a saved or first arrangement does not cut off the
   * content.
   */
  function fitFloats() {
    for (const f of layout.floating ?? []) {
      const inner = box?.querySelector<HTMLElement>(`.body[data-win="${f.win}"] .inner`), body = inner?.parentElement;
      if (!inner || !body) continue;
      // The height counts at the width the window floats at. A body may still be on its way there from an attached
      // spot, and its content is lower while it is wider.
      const style = body.style.cssText;
      body.style.transition = 'none';
      body.style.width = `${Math.max(0, px(f).w - 2)}px`;
      const unmark = markParts(inner), minW = minWidth(inner), minH = minHeight(inner, minW) + BAR + 1;
      unmark();
      body.style.cssText = style;
      const m = { w: minW + 2, h: minH }, old = mins[f.win];
      if (!old || Math.abs(old.w - m.w) > 0.5 || Math.abs(old.h - m.h) > 0.5) mins[f.win] = m;
    }
  }
  // The floating windows by name. A move or a resize makes a new layout, and this string keeps the effects below from
  // running again for it.
  const floatWins = $derived(floats.map((f) => f.win).join(' '));
  $effect(() => {
    void [settled, W, H, floatWins];
    if (settled) untrack(() => requestAnimationFrame(fitFloats));
  });
  // The content of a window can grow, for example by a new row of the timeline or a first result on the map, so a
  // change of the elements of a body fits the windows again, at most every 300 ms. An attached window fits again only
  // when its content no longer fits it, which costs little while a clip plays.
  $effect(() => {
    if (!settled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overflowing = () => [...box.querySelectorAll<HTMLElement>('.body.attached:not(.off) .inner')].some((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    const watch = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        if (moving || drag || resizing) return;
        if (floatWins) fitFloats();
        if (overflowing()) fitAttached();
      }, 300);
    });
    // The bodies stay in the page for the life of the dock, whether they float or not.
    for (const el of box.querySelectorAll('.body .inner')) watch.observe(el, { childList: true, subtree: true });
    return () => { watch.disconnect(); clearTimeout(timer); };
  });
  function grab(e: PointerEvent, win: WinId, edges: string) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-ctl]')) return;
    e.preventDefault();
    layout = place(layout, win);
    const f = layout.floating?.find((x) => x.win === win);
    if (!f) return;
    const start = { x: e.clientX, y: e.clientY }, max = { w: wins[win]?.max?.w ?? Infinity, h: wins[win]?.max?.h ?? Infinity };
    let r0 = px(f);
    // A maximized window that the bar drags gets its size back, and keeps the pointer at the same share of its bar.
    if (f.prev && !edges) {
      const w = Math.min(f.prev.w * W, max.w), h = Math.min(f.prev.h * H, max.h), at = (start.x - box.getBoundingClientRect().left - r0.x) / r0.w;
      r0 = { x: r0.x + at * (r0.w - w), y: r0.y, w, h };
    }
    // The content stays whole (lib/dock/fit.ts). The window is no smaller than its content measures. A narrower window,
    // where text wraps to more lines, can need more height.
    const inner = edges ? box.querySelector<HTMLElement>(`.body[data-win="${win}"] .inner`) : null;
    // The smallest width is the one fitFloats measured last. Only a window it has not measured yet measures here. The
    // measure of the height needs no marks.
    let leastW = mins[win] ? mins[win].w - 2 : 0;
    if (inner && !mins[win]) { const unmark = markParts(inner); leastW = minWidth(inner); unmark(); }
    const size = (v: number, min: number, top: number) => Math.max(min, Math.min(top, v));
    // The smallest height at a width, measured with the body set to that width for a moment. A narrower window never
    // needs less height, so a height measured at a width holds as a bound for every wider one. A move measures only
    // when the height it asks for is under that bound, and then at its own width.
    const measured: [number, number][] = [], exact = new Map<number, number>();
    const minHAt = (w: number) => {
      const known = exact.get(Math.round(w));
      if (known != null) return known;
      const body = inner!.parentElement!, style = body.style.cssText;
      body.style.transition = 'none';
      body.style.width = `${Math.max(0, w - 2)}px`;
      const h = minHeight(inner!, leastW) + BAR + 1;
      body.style.cssText = style;
      measured.push([w, h]);
      exact.set(Math.round(w), h);
      return h;
    };
    const boundAt = (w: number) => {
      let b = Infinity;
      for (const [mw, mh] of measured) if (mw <= w + 0.5 && mh < b) b = mh;
      // a first bound 24 px narrower serves the next moves of a narrowing drag
      return b < Infinity ? b : minHAt(Math.max(leastW + 2, w - 24));
    };
    moving = CURSOR[edges];
    const on = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      let { x, y, w, h } = r0;
      if (!edges) { x += dx; y += dy; }
      if (edges.includes('e')) w = size(r0.w + dx, leastW + 2, max.w);
      if (edges.includes('w')) { w = size(r0.w - dx, leastW + 2, max.w); x = r0.x + r0.w - w; }
      if (inner) {
        const want = edges.includes('s') ? r0.h + dy : edges.includes('n') ? r0.h - dy : r0.h;
        h = size(want, want >= boundAt(w) ? 0 : minHAt(w), max.h);
        if (edges.includes('n')) y = r0.y + r0.h - h;
      }
      // A window or an edge within SNAP_PX of an edge of the page snaps to it, and a band along that edge lights up.
      const sides: Side[] = [];
      if (!edges) {
        if (Math.abs(x) < SNAP_PX) { x = 0; sides.push('left'); } else if (Math.abs(W - x - w) < SNAP_PX) { x = W - w; sides.push('right'); }
        if (Math.abs(y) < SNAP_PX) { y = 0; sides.push('top'); } else if (Math.abs(H - y - h) < SNAP_PX) { y = H - h; sides.push('bottom'); }
      } else {
        if (edges.includes('e') && Math.abs(W - x - w) < SNAP_PX) { w = W - x; sides.push('right'); }
        if (edges.includes('w') && Math.abs(x) < SNAP_PX) { w += x; x = 0; sides.push('left'); }
        if (edges.includes('s') && Math.abs(H - y - h) < SNAP_PX) { h = H - y; sides.push('bottom'); }
        if (edges.includes('n') && Math.abs(y) < SNAP_PX) { h += y; y = 0; sides.push('top'); }
      }
      snapped = sides;
      // The bar stays on the dock.
      x = Math.max(-w + 80, Math.min(W - 80, x));
      y = Math.max(0, Math.min(H - BAR, y));
      layout = place(layout, win, { x: x / W, y: y / H, w: w / W, h: h / H });
    };
    // the content is measured again at the size the drag left
    const off = () => { moving = null; snapped = []; window.removeEventListener('pointermove', on); if (edges) requestAnimationFrame(fitFloats); };
    window.addEventListener('pointermove', on);
    window.addEventListener('pointerup', off, { once: true });
  }

  // A gutter drag resizes its two neighbors, and the corner grip drags the gutters right of and below its window. A
  // gutter moves only as far as every shown window stays no smaller than its content measures (lib/dock/fit.ts) and
  // no larger than its max size. A window already past a limit when the drag starts can stay there.
  let resizing = $state(false);
  function gutterDrag(e: PointerEvent, gs: typeof R.gutters) {
    if (e.button !== 0 || !gs.length) return;
    e.preventDefault();
    e.stopPropagation();
    const start = local(e), from = layout;
    resizing = true;
    const shown = measureShown();
    const on = (ev: PointerEvent) => {
      const p = local(ev);
      for (const g of gs) {
        const want = shareOf(from, g.split, g.i) + (g.dir === 'row' ? p.x - start.x : p.y - start.y) / g.size;
        moveGutter(shown, g, want - shareOf(layout, g.split, g.i));
      }
    };
    window.addEventListener('pointermove', on);
    window.addEventListener('pointerup', () => {
      resizing = false;
      window.removeEventListener('pointermove', on);
    }, { once: true });
  }
  type Shown = ReturnType<typeof measureShown>;
  /**
   * The attached bodies on screen, with the smallest width of their content and their size now. The smallest height
   * depends on the width, so `hs` keeps it by width as the drag measures it.
   */
  function measureShown() {
    flushSync();
    // The content of a body lies in its .inner, placed over the whole body.
    // The size now comes from the layout, because a body may still be on its way there.
    return [...box.querySelectorAll<HTMLElement>('.body.attached:not(.off)')].map((el) => {
      const inner = el.querySelector<HTMLElement>('.inner')!, unmark = markParts(inner), minW = minWidth(inner), win = el.dataset.win!;
      unmark();
      const now = bodySize(layout, R.stacks, win) ?? { w: el.offsetWidth, h: el.offsetHeight };
      return { el, inner, win, minW, w0: now.w, h0: now.h, hs: new Map<number, number>() };
    });
  }
  /** The smallest height of a body at a width, measured with the body set to that width for a moment. */
  function minHOf(b: Shown[number], w: number) {
    const k = Math.round(w);
    let h = b.hs.get(k);
    if (h == null) {
      const style = b.el.style.cssText;
      b.el.style.transition = 'none';
      b.el.style.width = `${w}px`;
      h = minHeight(b.inner, b.minW);
      b.el.style.cssText = style;
      b.hs.set(k, h);
    }
    return h;
  }
  /** The size of the body of a window in a layout, from the layout alone (the body sits inside the border and under the bar). */
  function bodySize(l: Layout, stacksOf: Record<string, Rect>, win: WinId) {
    const s = stackOf(l.root, win), r = s && stacksOf[s.id];
    return r && { w: Math.max(0, r.w - 2), h: Math.max(0, r.h - BAR - 1) };
  }
  /**
   * Whether no body of a layout shrinks past the smallest size of its content and none grows past its max size. A body
   * already past a limit may stay there. The layout is not applied: the sizes come from its rects, and only a body that
   * gets lower measures its content.
   */
  function fits(shown: Shown, l: Layout) {
    const stacksOf = rects(l, W, H).stacks;
    return shown.every((b) => {
      const sz = bodySize(l, stacksOf, b.win), max = wins[b.win]?.max;
      if (!sz) return true;
      const { w, h } = sz;
      const small = (w < b.minW - 0.5 && w < b.w0 - 0.5) || (h < b.h0 - 0.5 && h < minHOf(b, w) - 0.5);
      const big = (w > (max?.w ?? Infinity) && w > b.w0 + 0.5) || (h > (max?.h ?? Infinity) && h > b.h0 + 0.5);
      return !small && !big;
    });
  }
  /** Moves a gutter by a share d, or else by halves of it, so a fast drag still reaches the limit. */
  function moveGutter(shown: Shown, g: (typeof R.gutters)[number], d: number) {
    for (let k = 0; Math.abs(d) * g.size > 1 && k < 10; d /= 2, k++) {
      const next = resize(layout, g.split, g.i, d);
      if (fits(shown, next)) { layout = next; return; }
    }
  }
  /**
   * Grows an attached window that a drop left smaller than its content to that size, by the gutters on its sides, as
   * far as its neighbors can give way.
   */
  function growToMin(win: WinId, shown = measureShown()) {
    const me = shown.find((b) => b.win === win);
    if (me) {
      for (const dir of ['row', 'col'] as const) {
        for (const side of [1, -1]) {
          const s = stackOf(layout.root, win), r = s && R.stacks[s.id], sz = bodySize(layout, R.stacks, win);
          if (!r || !sz) break;
          const need = dir === 'row' ? me.minW - sz.w : minHOf(me, sz.w) - sz.h;
          if (need < 1) break;
          // the gutter after the window (side 1) moves on, and the one before it moves back
          const g = R.gutters.find((g) => g.dir === dir && (dir === 'row'
            ? Math.abs((side > 0 ? g.x : g.x + g.w) - (side > 0 ? r.x + r.w : r.x)) < 1.5 && g.y <= r.y + 1 && g.y + g.h >= r.y + r.h - 1
            : Math.abs((side > 0 ? g.y : g.y + g.h) - (side > 0 ? r.y + r.h : r.y)) < 1.5 && g.x <= r.x + 1 && g.x + g.w >= r.x + r.w - 1));
          if (g) moveGutter(shown, g, (side * need) / g.size);
        }
      }
    }
  }
  /**
   * Grows every attached window that is smaller than its content, when the page opens, when the page changes size and
   * when the arrangement changes (Arrange, a preset, a drop). A first arrangement in a small page can leave a window too
   * small, as the map of Review, whose controls then fall off its bottom.
   */
  function fitAttached() {
    if (layout.expanded || drag || resizing) return;
    const shown = measureShown();
    for (const b of shown) {
      const now = bodySize(layout, R.stacks, b.win);
      if (!now) continue;
      // the size now, after the windows before it grew
      b.w0 = now.w;
      b.h0 = now.h;
      if (b.minW > now.w + 1 || minHOf(b, now.w) > now.h + 1) growToMin(b.win, shown);
    }
  }
  // The attached stacks with their shown tab. A gutter drag keeps this string, so only a new arrangement fits again.
  const treeKey = $derived(all.map((s) => `${s.id}:${s.tabs[s.active]}:${s.min ? 1 : 0}`).join(' ') + '|' + (layout.expanded ?? ''));
  $effect(() => {
    void [settled, W, H, treeKey];
    if (settled) untrack(() => requestAnimationFrame(fitAttached));
  });
  const touching = (r: Rect) => [
    R.gutters.find((g) => g.dir === 'row' && Math.abs(g.x - (r.x + r.w)) < 1 && g.y <= r.y + 1 && g.y + g.h >= r.y + r.h - 1),
    R.gutters.find((g) => g.dir === 'col' && Math.abs(g.y - (r.y + r.h)) < 1 && g.x <= r.x + 1 && g.x + g.w >= r.x + r.w - 1),
  ].filter((g) => !!g);

  // The switcher of an expanded window lists the other windows it can expand in its place.
  let switching = $state(false);
  const expandable = $derived(all.filter((s) => s.id !== layout.expanded));

  /**
   * Where the middle square of the zones starts, as a share of the window. The Attach button aims with the middle of a
   * window, which lands on a window more often than a pointer aims at its middle, so its middle square is smaller.
   */
  const DRAG_INNER = 0.25, ATTACH_INNER = 0.4;
  /** The zones a drop or the Attach button aims at, with the size of their middle square, as percent of the window. */
  const hint = $derived(drag?.target ? { ...drag.target, k: DRAG_INNER * 100 } : !drag && attaching ? { ...attachTarget(attaching), k: ATTACH_INNER * 100 } : null);
  /** The polygons of the zones, in percent of the window, with a middle square from k to 100 - k. */
  const zones = (k: number): Record<Side, string> => ({
    top: `0,0 100,0 ${100 - k},${k} ${k},${k}`, bottom: `${k},${100 - k} ${100 - k},${100 - k} 100,100 0,100`,
    left: `0,0 ${k},${k} ${k},${100 - k} 0,100`, right: `${100 - k},${k} 100,0 100,100 ${100 - k},${100 - k}`,
    center: `${k},${k} ${100 - k},${k} ${100 - k},${100 - k} ${k},${100 - k}`,
  });
  /**
   * The icon in each zone, with its middle in percent of the window. It shows the split the drop makes, rows for the top
   * and the bottom and columns for the sides, and whether the window goes first or last. The middle stacks it as a tab.
   * The icon of the zone under the pointer plays its motion once.
   */
  const zoneIcons = (k: number) => [
    { side: 'top', icon: BetweenHorizontalStart, x: 50, y: k / 2 }, { side: 'bottom', icon: BetweenHorizontalEnd, x: 50, y: 100 - k / 2 },
    { side: 'left', icon: BetweenVerticalStart, x: k / 2, y: 50 }, { side: 'right', icon: BetweenVerticalEnd, x: 100 - k / 2, y: 50 },
    { side: 'center', icon: ICONS.layers, x: 50, y: 50, label: 'Stack to tabs' },
  ] as const;
</script>

<div class="dock" bind:this={box} bind:clientWidth={W} bind:clientHeight={H} class:dragging={!!drag} class:resizing class:moving={moving != null}
  style:cursor={moving} class:settled data-testid="dock">
  {#each all as s (s.id)}
    {@const r = R.stacks[s.id]}
    {#if r}
      <div class="win" class:min={s.min} style="left:{r.x}px; top:{r.y}px; width:{r.w}px; height:{r.h}px{layout.expanded === s.id ? `; z-index:${EXPANDED_Z}` : ''}" data-stack={s.id}>
        <!-- A double click on the bar expands the window, and another restores the layout. -->
        <div class="bar" role="toolbar" tabindex="-1" aria-label="Window bar" onpointerdown={(e) => down(e, s.id)}
          ondblclick={(e) => !(e.target as HTMLElement).closest('[data-ctl]') && (layout = { ...layout, expanded: layout.expanded === s.id ? undefined : s.id })}>
          {#each s.tabs as w, i (w)}
            {@const M = wins[w]}
            <button class="dtab" class:on={i === s.active} onpointerdown={(e) => { e.stopPropagation(); down(e, s.id, i); }} data-testid="tab-{w}" title="{M?.title ?? w}. Drag to move this window. Click to show it.">
              {#if M}<M.icon size={13} /><span class="tt">{M.title}</span>{:else}<span class="tt">{w}</span>{/if}
            </button>
          {/each}
          <!-- The switcher shows only when another attached window could take the place. -->
          {#if layout.expanded === s.id && expandable.length}
            <span class="switcher" data-ctl>
              <button class="sw-face" onclick={() => (switching = !switching)} aria-expanded={switching} title="Expand another window in its place">
                <ICONS.appWindow size={12} /> Expanded <ICONS.chevronDown size={12} />
              </button>
              {#if switching}
                <span class="sw-menu" role="menu" in:popIn out:popOut>
                  {#each expandable as o (o.id)}
                    <button role="menuitem" onclick={() => { layout = { ...layout, expanded: o.id }; switching = false; }}>{o.tabs.map((w) => wins[w]?.title ?? w).join(', ')}</button>
                  {/each}
                </span>
              {/if}
            </span>
          {/if}
          <span class="ctl" data-ctl>
            {#if layout.expanded === s.id}
              <button onclick={() => (layout = { ...layout, expanded: undefined })} title="Restore the layout" aria-label="Restore the layout" data-testid="restore-{s.tabs[0]}"><ICONS.minimize size={13} /></button>
            {:else}
              {#if s.min}
                <button onclick={() => (layout = setStack(layout, s.id, { min: false }))} title="Restore" aria-label="Restore"><ICONS.restore size={13} /></button>
              {:else}
                <button onclick={() => (layout = setStack(layout, s.id, { min: true }))} title="Minimize" aria-label="Minimize" data-testid="min-{s.tabs[0]}"><ICONS.minus size={13} /></button>
              {/if}
              <button onclick={() => (layout = { ...layout, expanded: s.id })} title="Expand" aria-label="Expand" data-testid="expand-{s.tabs[0]}"><ICONS.maximize size={13} /></button>
              <button onclick={() => floatOut(s, r)} title="Float this window" aria-label="Float" data-testid="float-{s.tabs[s.active]}"><ICONS.float size={13} /></button>
            {/if}
          </span>
        </div>
        {#if !s.min && layout.expanded !== s.id}
          <span class="grip" role="separator" aria-label="Resize" onpointerdown={(e) => gutterDrag(e, touching(r))}></span>
        {/if}
      </div>
    {/if}
  {/each}

  {#each R.gutters as g (g.split + ':' + g.i)}
    <span class="gutter {g.dir}" role="separator" aria-orientation={g.dir === 'row' ? 'vertical' : 'horizontal'} aria-label="Resize" style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px" onpointerdown={(e) => gutterDrag(e, [g])}></span>
  {/each}

  <!-- The frames keep their place in the page, and z-index stacks them. A frame that moved in the page between the
       press and the release of a button would lose the click. -->
  {#each Object.keys(wins).filter((w) => floats.some((f) => f.win === w)) as w (w)}
    {@const i = floats.findIndex((f) => f.win === w)}
    {@const f = floats[i]}
    {@const M = wins[f.win]}
    {#if M && W}
      {@const p = px(f)}
      <!-- A floating window takes three layers: its frame, its body over it, and its edges over both. -->
      <div class="win floating" style="left:{p.x}px; top:{p.y}px; width:{p.w}px; height:{p.h}px; z-index:{10 + 3 * i}" data-testid="win-{f.win}"
        role="presentation" onpointerdown={() => (layout = place(layout, f.win))}>
        <!-- A double click on the bar or on an edge maximizes the window, and another puts it back. -->
        <div class="bar" role="toolbar" tabindex="-1" aria-label="Drag to move {M.title}" onpointerdown={(e) => grab(e, f.win, '')}
          ondblclick={(e) => !(e.target as HTMLElement).closest('[data-ctl]') && maxFloat(f.win)}>
          <span class="dtab on"><M.icon size={13} />{M.title}</span>
          <span class="ctl" data-ctl>
            <button onclick={() => maxFloat(f.win)} title={f.prev ? 'Restore' : 'Maximize'} aria-label={f.prev ? 'Restore' : 'Maximize'} data-testid="max-{f.win}">
              {#if f.prev}<ICONS.minimize size={13} />{:else}<ICONS.maximize size={13} />{/if}
            </button>
            <!-- A click attaches the window where its middle lies, and a drag attaches it where it drops. A key press
                 clicks without a pointer. -->
            <button onclick={(e) => e.detail === 0 && attach(f.win)} onpointerdown={(e) => attachDown(e, f.win)}
              onpointerenter={() => (attaching = f.win)} onpointerleave={() => (attaching = null)}
              title="Attach this window to the page. Drag to pick the spot." aria-label="Attach" data-testid="attach-{f.win}"><ICONS.attach size={13} /></button>
          </span>
        </div>
      </div>
      <!-- The edges lie over the body too, so all of each edge takes the pointer, as far as it lights up. -->
      <div class="edges" style="left:{p.x}px; top:{p.y}px; width:{p.w}px; height:{p.h}px; z-index:{12 + 3 * i}">
        {#each EDGES as ed (ed)}<span class="edge {ed}" role="separator" aria-label="Resize" onpointerdown={(e) => grab(e, f.win, ed)} ondblclick={() => maxFloat(f.win)}></span>{/each}
        <span class="grip" aria-hidden="true"></span>
      </div>
    {/if}
  {/each}

  {#each Object.keys(wins) as w (w)}
    {@const b = bodyOf(w)}
    <div class="body" class:attached={b?.attached} class:off={!b?.on && !motion[w]} class:leaving={motion[w]?.startsWith('to')}
      style={b ? `left:${b.x}px; top:${b.y}px; width:${b.w}px; height:${b.h}px; z-index:${b.z}` : ''} data-win={w}
      role="presentation" onpointerdown={() => b && !b.attached && (layout = place(layout, w))}>
      <div class="inner" data-motion={motion[w]}>{@render body(w)}</div>
    </div>
  {/each}

  <!-- The edges of the page a floating window snapped to. -->
  {#each snapped as t (t)}
    <div class="edge-band snap" style={t === 'left' ? 'left:0;top:0;bottom:0;width:3px' : t === 'right' ? 'right:0;top:0;bottom:0;width:3px' : t === 'top' ? 'left:0;right:0;top:0;height:3px' : 'left:0;right:0;bottom:0;height:3px'}></div>
  {/each}

  <!-- The shell of the spot the held window lands on, or the spot of a window that Attach gives back. The windows move
       only on the drop or the click. -->
  {#if shell}<div class="shell" style="left:{shell.x}px; top:{shell.y}px; width:{shell.w}px; height:{shell.h}px" data-testid="shell"></div>{/if}
  <!-- The zones of the window a drop or the Attach button aims at, or the band of the dock edge. -->
  {#if hint?.id === 'root'}
    {@const t = hint.side}
    <div class="edge-band" style={t === 'left' ? 'left:0;top:0;bottom:0;width:10px' : t === 'right' ? 'right:0;top:0;bottom:0;width:10px' : t === 'top' ? 'left:0;right:0;top:0;height:10px' : 'left:0;right:0;bottom:0;height:10px'}></div>
  {:else if hint && R.stacks[hint.id]}
    {@const r = R.stacks[hint.id]}
    <svg class="zones" style="left:{r.x}px; top:{r.y + BAR}px; width:{r.w}px; height:{r.h - BAR}px" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {#each Object.entries(zones(hint.k)) as [k, pts] (k)}<polygon points={pts} class:hot={hint.side === k} vector-effect="non-scaling-stroke" />{/each}
    </svg>
    {#each zoneIcons(hint.k) as z (z.side)}
      <span class="zicon" class:hot={hint.side === z.side} style="left:{r.x + (r.w * z.x) / 100}px; top:{r.y + BAR + ((r.h - BAR) * z.y) / 100}px"><z.icon size={24} animate={hint.side === z.side} />{#if 'label' in z}<span class="zlabel">{z.label}</span>{/if}</span>
    {/each}
  {/if}
  {#if drag}
    <div class="held" style="left:{drag.x + 12}px; top:{drag.y + 10}px">
      {#each heldWins as w (w)}{@const M = wins[w]}<span class="flex items-center gap-1.5">{#if M}<M.icon size={13} />{M.title}{:else}{w}{/if}</span>{/each}
    </div>
  {/if}
</div>

<style>
  .dock { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
  .dock.dragging { cursor: move; user-select: none; }
  .dock.moving { user-select: none; }
  .dock.dragging *, .dock.moving * { cursor: inherit !important; }
  .dock.resizing :is(.win, .body), .dock.moving :is(.win, .body) { transition: none !important; }
  .win, .body, .shell { position: absolute; }
  .settled .win, .settled .body { transition: left 0.25s cubic-bezier(0, 0, 0.2, 1), top 0.25s cubic-bezier(0, 0, 0.2, 1), width 0.25s cubic-bezier(0, 0, 0.2, 1), height 0.25s cubic-bezier(0, 0, 0.2, 1); }
  /* The shadow next to the border is centered, so the bottom edge does not look thicker than the others. */
  .win { background: var(--panel-solid); border: 1px solid var(--line-strong); box-shadow: 0 0 0 1px var(--tint), 0 0 2px #00000024, 0 8px 8px -8px #00000029; display: flex; flex-direction: column; }
  .win.floating { box-shadow: 0 0 0 1px var(--tint), 0 0 2px #00000024, 0 12px 24px -8px #00000033; }
  .bar { display: flex; align-items: stretch; height: 25px; flex: none; background: var(--head-bg); border-bottom: 1px solid var(--line); cursor: move; overflow: hidden; }
  /* With many tabs the bar keeps its controls: the tabs shrink, the others before the one shown, and their names cut
     off down to their icons. */
  .dtab { display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; font: 600 11px var(--font-tab); color: var(--muted); white-space: nowrap; position: relative; cursor: move; min-width: 37px; flex: 0 10 auto; overflow: hidden; }
  .dtab.on { flex-shrink: 1; }
  .dtab :global(svg), .dtab :global([role='img']) { flex-shrink: 0; }
  .tt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .dtab.on { color: var(--accent); background: var(--panel-solid); }
  .dtab.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); }
  /* The controls sit on the ground of a tab, apart by a line of the bar. */
  .ctl { margin-left: auto; display: flex; flex-shrink: 0; align-items: stretch; gap: 1px; padding-left: 1px; color: var(--muted); }
  .ctl button { display: grid; place-items: center; width: 24px; background: var(--panel-solid); }
  .ctl button:hover, .dtab:hover { color: var(--text); }
  .body { z-index: 1; overflow: hidden; }
  .body.off { visibility: hidden; pointer-events: none; }
  .body.leaving { pointer-events: none; }
  .inner { position: absolute; inset: 0; animation-duration: 0.25s; animation-timing-function: cubic-bezier(0, 0, 0.2, 1); animation-fill-mode: both; }
  .inner[data-motion='from-end'] { animation-name: enter-from-end; }
  .inner[data-motion='from-start'] { animation-name: enter-from-start; }
  .inner[data-motion='to-end'] { animation-name: exit-to-end; }
  .inner[data-motion='to-start'] { animation-name: exit-to-start; }
  @keyframes enter-from-end { from { opacity: 0; transform: translateX(200px); } to { opacity: 1; transform: none; } }
  @keyframes enter-from-start { from { opacity: 0; transform: translateX(-200px); } to { opacity: 1; transform: none; } }
  @keyframes exit-to-end { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(200px); } }
  @keyframes exit-to-start { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(-200px); } }
  .grip { position: absolute; right: 1px; bottom: 1px; width: 11px; height: 11px; z-index: 3; cursor: nwse-resize; opacity: 0.7;
    background: linear-gradient(135deg, transparent 0 45%, var(--muted) 45% 52%, transparent 52% 68%, var(--muted) 68% 75%, transparent 75%); }
  .edges { position: absolute; pointer-events: none; }
  .edges .grip { right: 2px; bottom: 2px; pointer-events: none; }
  .gutter { position: absolute; z-index: 2; }
  .gutter.row { cursor: col-resize; }
  .gutter.col { cursor: row-resize; }
  .gutter:hover, .gutter:active { background: var(--accent-border-active); }
  /* The edges of a floating window, to resize it. */
  .edge { position: absolute; z-index: 2; pointer-events: auto; }
  /* A side reaches 3 px out of the window and 3 px into it, between the two corners. It lights up along its whole
     length, out to the outer corners. */
  .edge.n, .edge.s { left: 19px; right: 19px; height: 6px; cursor: ns-resize; }
  .edge.n { top: -3px; } .edge.s { bottom: -3px; }
  .edge.e, .edge.w { top: 19px; bottom: 19px; width: 6px; cursor: ew-resize; }
  .edge.e { right: -3px; } .edge.w { left: -3px; }
  .edge::before { content: ''; position: absolute; inset: 0; }
  .edge.n::before, .edge.s::before { inset: 0 -19px; }
  .edge.e::before, .edge.w::before { inset: -19px 0; }
  /* A corner is a triangle that reaches 3 px out of the window and 19 px into it, with its two sharp tips cut off over
     their outer third. Its clip takes the pointer only within that shape, so it lights up where it can be grabbed. */
  .edge.ne, .edge.nw, .edge.se, .edge.sw { width: 22px; height: 22px; }
  .edge.se { right: -3px; bottom: -3px; cursor: nwse-resize; clip-path: polygon(67% 33%, 100% 33%, 100% 100%, 33% 100%, 33% 67%); }
  .edge.sw { left: -3px; bottom: -3px; cursor: nesw-resize; clip-path: polygon(33% 33%, 0 33%, 0 100%, 67% 100%, 67% 67%); }
  .edge.ne { right: -3px; top: -3px; cursor: nesw-resize; clip-path: polygon(67% 67%, 100% 67%, 100% 0, 33% 0, 33% 33%); }
  .edge.nw { left: -3px; top: -3px; cursor: nwse-resize; clip-path: polygon(33% 67%, 0 67%, 0 0, 67% 0, 67% 33%); }
  .edge:hover { z-index: 4; }
  .edge:hover::before { background: var(--accent-border-active); }
  .zones { position: absolute; z-index: 1000; pointer-events: none; }
  /* The zones cover the window a little, so they read over a busy video, and the zone under the pointer more. */
  .zones polygon { fill: color-mix(in srgb, var(--panel-solid) 45%, transparent); stroke: var(--line-strong); stroke-width: 1; }
  .zones polygon.hot { fill: color-mix(in srgb, var(--accent) 28%, color-mix(in srgb, var(--panel-solid) 55%, transparent)); stroke: var(--accent); }
  .zicon { position: absolute; z-index: 1001; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--muted-strong); pointer-events: none; }
  .zlabel { font: 600 11px var(--font-tab); white-space: nowrap; }
  .zicon.hot { color: var(--accent); }
  .edge-band { position: absolute; z-index: 1000; background: var(--accent); opacity: 0.6; pointer-events: none; }
  /* The shell eases from spot to spot as the pointer moves between zones. */
  .shell { z-index: 1002; pointer-events: none; background: var(--accent); opacity: 0.18; box-shadow: inset 0 0 0 2px var(--accent);
    transition: left 0.15s cubic-bezier(0, 0, 0.2, 1), top 0.15s cubic-bezier(0, 0, 0.2, 1), width 0.15s cubic-bezier(0, 0, 0.2, 1), height 0.15s cubic-bezier(0, 0, 0.2, 1); }
  .held { position: absolute; z-index: 1003; display: flex; gap: 12px; padding: 4px 10px; font: 600 11px var(--font-tab); color: var(--accent); background: var(--panel-solid); border: 1px solid var(--accent); box-shadow: 0 12px 30px #00000059; opacity: 0.9; pointer-events: none; white-space: nowrap; }
  .switcher { position: relative; display: inline-flex; align-self: center; margin-left: 8px; }
  .sw-face { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; height: 18px; font-size: 11px; color: var(--text); border: 1px solid var(--line-strong); }
  .sw-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 8; min-width: 180px; display: flex; flex-direction: column; padding: 4px 0; background: var(--panel-solid); border: 1px solid var(--line-strong); box-shadow: 0 16px 24px -8px #0000003d; transform-origin: top center; }
  .sw-menu button { text-align: left; padding: 3px 10px; font-size: 11px; color: var(--copy); }
  .sw-menu button:hover { background: var(--accent-soft); color: var(--text); }
  @media (prefers-reduced-motion: reduce) {
    .settled .win, .settled .body, .shell { transition: none; }
    .inner { animation-name: none !important; }
  }
</style>
