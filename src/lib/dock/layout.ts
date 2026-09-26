/**
 * The layout of a dock (docs/review-plan.md, stage 2) is a tree of splits and stacks. A split lays out its children in
 * a row or a column, each with a share of its size. A stack holds windows as tabs and shows one. Every operation
 * returns a new layout and leaves its input unchanged. Deterministic, no DOM.
 */
export type WinId = string;
export interface Split { kind: 'split'; id: string; dir: 'row' | 'col'; children: Node[]; sizes: number[] }
export interface Stack { kind: 'stack'; id: string; tabs: WinId[]; active: number; min?: boolean }
export type Node = Split | Stack;
/**
 * `expanded` is the stack that fills the dock, with the others hidden. The tree itself stays as it was. `floating` holds
 * the windows outside the tree, each at a share of the dock (x, y, w and h from 0 to 1). The window on top comes last.
 * Absent means no floating window. With every window floating, the tree is one empty stack. `sizes` holds the size
 * (w and h, as shares of the dock) that each attached window last had while it floated, for when it floats again.
 */
export interface Layout { root: Node; expanded?: string; floating?: Float[]; sizes?: Record<WinId, { w: number; h: number }> }
/** `prev` is where a maximized floating window was, for its restore. */
export interface Float { win: WinId; r: Rect; prev?: Rect }
export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center';
/** What a drag holds, which is one window (its tab) or a whole stack (its bar). */
export type Held = { win: WinId } | { stack: string };

// a layout is plain data. JSON also copies the state proxies of Svelte, which structuredClone refuses
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

let ids = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(ids++).toString(36)}`;

/** The first layout of each page with windows, by page. The Arrange button of the header puts it back. */
export const presets: Record<string, () => Layout> = {};

export const stack = (tabs: WinId[], active = 0): Stack => ({ kind: 'stack', id: newId('s'), tabs, active });
export const split = (dir: Split['dir'], children: Node[], sizes = children.map(() => 1 / children.length)): Split => ({ kind: 'split', id: newId('p'), dir, children, sizes });

/** Every stack of a tree, in order. */
export function stacks(n: Node): Stack[] {
  return n.kind === 'stack' ? [n] : n.children.flatMap(stacks);
}
export function findStack(n: Node, id: string): Stack | undefined {
  return stacks(n).find((s) => s.id === id);
}
export function stackOf(n: Node, win: WinId): Stack | undefined {
  return stacks(n).find((s) => s.tabs.includes(win));
}
/** The split that holds a node, and the node's index in it. */
function parentOf(root: Node, id: string): { p: Split; i: number } | null {
  if (root.kind === 'stack') return null;
  const i = root.children.findIndex((c) => c.id === id);
  if (i >= 0) return { p: root, i };
  for (const c of root.children) { const r = parentOf(c, id); if (r) return r; }
  return null;
}

/** Drops empty stacks, lifts the only child of a split, and merges a split into a parent of the same direction. */
function tidy(n: Node): Node | null {
  if (n.kind === 'stack') return n.tabs.length ? { ...n, active: Math.min(n.active, n.tabs.length - 1) } : null;
  const kids: Node[] = [], sizes: number[] = [];
  n.children.forEach((c, i) => {
    const t = tidy(c);
    if (!t) return;
    if (t.kind === 'split' && t.dir === n.dir) t.children.forEach((g, j) => { kids.push(g); sizes.push(n.sizes[i] * t.sizes[j]); });
    else { kids.push(t); sizes.push(n.sizes[i]); }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const sum = sizes.reduce((a, b) => a + b, 0);
  return { ...n, children: kids, sizes: sizes.map((s) => s / sum) };
}

/** Takes what the drag holds out of the tree. Returns the tabs it moves and the tree without them. */
function take(root: Node, held: Held): { tabs: WinId[]; active: number; root: Node | null } {
  const c = clone(root);
  if ('win' in held) {
    const s = stackOf(c, held.win);
    if (!s) return { tabs: [], active: 0, root: c };
    s.tabs.splice(s.tabs.indexOf(held.win), 1);
    return { tabs: [held.win], active: 0, root: tidy(c) };
  }
  const s = findStack(c, held.stack);
  if (!s) return { tabs: [], active: 0, root: c };
  const tabs = s.tabs, active = s.active;
  s.tabs = [];
  return { tabs, active, root: tidy(c) };
}

/** Keeps the expanded stack and the floating windows of `l` on a new tree. */
const keep = (l: Layout, root: Node, floating = l.floating, sizes = l.sizes): Layout => ({
  root, floating, expanded: l.expanded && findStack(root, l.expanded)?.tabs.length ? l.expanded : undefined, ...(sizes ? { sizes } : {}),
});
const isFloating = (l: Layout, win: WinId) => !!l.floating?.some((f) => f.win === win);

/**
 * Moves what the drag holds next to a target stack (or the whole tree, target 'root') on a side, or into it as tabs
 * (center). A floating window attaches this way. A move onto the stack that already holds everything the drag holds
 * changes nothing.
 */
export function move(l: Layout, held: Held, target: string, side: Side): Layout {
  const floats = 'win' in held && isFloating(l, held.win);
  if (!floats) {
    const from = 'win' in held ? stackOf(l.root, held.win) : findStack(l.root, held.stack);
    if (!from) return l;
    if (from.id === target && (side === 'center' || from.tabs.length === ('win' in held ? 1 : from.tabs.length))) return l;
  }
  const { tabs, active, root: rest } = floats ? { tabs: [(held as { win: WinId }).win], active: 0, root: clone(l.root) } : take(l.root, held);
  const root = rest ?? stack([]);
  const floating = floats ? l.floating!.filter((f) => f.win !== (held as { win: WinId }).win) : l.floating;
  // a floating window that attaches keeps its size for its next float
  const was = floats ? l.floating!.find((f) => f.win === (held as { win: WinId }).win)! : undefined;
  const sizes = was ? { ...l.sizes, [was.win]: { w: was.r.w, h: was.r.h } } : l.sizes;
  const t = target === 'root' ? root : findStack(root, target);
  if (!t) return l;
  if (side === 'center' && t.kind === 'stack') {
    t.tabs.push(...tabs);
    t.active = t.tabs.length - tabs.length + active;
    return keep(l, root, floating, sizes);
  }
  const moved = stack(tabs, active);
  const dir: Split['dir'] = side === 'left' || side === 'right' ? 'row' : 'col', before = side === 'left' || side === 'top';
  const at = t.id === root.id ? null : parentOf(root, t.id);
  if (at && at.p.dir === dir) {
    // The moved stack becomes a sibling in the split of the target and takes half of the target's share.
    const half = at.p.sizes[at.i] / 2;
    at.p.sizes[at.i] = half;
    at.p.children.splice(before ? at.i : at.i + 1, 0, moved);
    at.p.sizes.splice(before ? at.i : at.i + 1, 0, half);
    return keep(l, tidy(root)!, floating, sizes);
  }
  const pair = split(dir, before ? [moved, t] : [t, moved]);
  if (!at) return keep(l, tidy(pair)!, floating, sizes);
  at.p.children[at.i] = pair;
  return keep(l, tidy(root)!, floating, sizes);
}

/** Takes a window out of the tree and floats it on top at `r`. */
export function float(l: Layout, win: WinId, r: Rect): Layout {
  if (isFloating(l, win)) return l;
  const { tabs, root } = take(l.root, { win });
  if (!tabs.length) return l;
  return keep(l, root ?? stack([]), [...(l.floating ?? []), { win, r }]);
}

/** Moves a floating window to `r`, or only brings it on top without `r`. */
export function place(l: Layout, win: WinId, r?: Rect): Layout {
  const f = l.floating?.find((x) => x.win === win);
  if (!f || (!r && l.floating!.at(-1)?.win === win)) return l;
  // a move or a resize ends a maximized window, and a press only brings it on top
  return { ...l, floating: [...l.floating!.filter((x) => x.win !== win), r ? { win, r } : f] };
}

/** Maximizes a floating window over the whole dock, or puts a maximized one back where it was. It comes on top. */
export function toggleMax(l: Layout, win: WinId): Layout {
  const f = l.floating?.find((x) => x.win === win);
  if (!f) return l;
  const next: Float = f.prev ? { win, r: f.prev } : { win, r: { x: 0, y: 0, w: 1, h: 1 }, prev: f.r };
  return { ...l, floating: [...l.floating!.filter((x) => x.win !== win), next] };
}

function findSplit(n: Node, id: string): Split | null {
  return n.kind === 'stack' ? null : n.id === id ? n : n.children.map((c) => findSplit(c, id)).find(Boolean) ?? null;
}
/** The share of child `i` of a split, or 0 without the split. */
export const shareOf = (l: Layout, splitId: string, i: number) => findSplit(l.root, splitId)?.sizes[i] ?? 0;

/** Resizes the children i and i + 1 of a split by `delta` (a share of the split), and keeps each at least `least`. */
export function resize(l: Layout, splitId: string, i: number, delta: number, least = 0.05): Layout {
  const c = clone(l);
  const p = findSplit(c.root, splitId);
  if (!p || i < 0 || i + 1 >= p.sizes.length) return l;
  const total = p.sizes[i] + p.sizes[i + 1];
  const a = Math.max(least, Math.min(total - least, p.sizes[i] + delta));
  p.sizes[i] = a;
  p.sizes[i + 1] = total - a;
  return c;
}

/** Changes the active tab or the minimized state of one stack. */
export function setStack(l: Layout, id: string, change: Partial<Pick<Stack, 'active' | 'min'>>): Layout {
  const c = clone(l), s = findStack(c.root, id);
  if (s) Object.assign(s, change);
  return c;
}

/**
 * Limits the windows of a layout to `wins`. Windows it lacks go into the first stack, and unknown ones leave, from the
 * tree and from the floating windows.
 */
export function withWindows(l: Layout, wins: WinId[]): Layout {
  const c = clone(l);
  const floating = c.floating?.filter((f) => wins.includes(f.win));
  for (const s of stacks(c.root)) s.tabs = s.tabs.filter((w) => wins.includes(w));
  const have = new Set([...stacks(c.root).flatMap((s) => s.tabs), ...(floating ?? []).map((f) => f.win)]);
  const first = stacks(c.root)[0];
  for (const w of wins) if (!have.has(w)) first.tabs.push(w);
  return keep(c, tidy(c.root) ?? stack([]), floating);
}

export interface Rect { x: number; y: number; w: number; h: number }
/** A gap between two children of a split, to resize them. */
export interface Gutter extends Rect { split: string; i: number; dir: Split['dir']; size: number }

/**
 * The position of each stack in a dock of w x h pixels, and the gutters between them. A minimized stack keeps only its
 * bar, `bar` pixels in a column and `minW` pixels in a row. An expanded stack fills the dock alone.
 */
export function rects(l: Layout, w: number, h: number, gap = 8, bar = 26, minW = 160): { stacks: Record<string, Rect>; gutters: Gutter[] } {
  const out: Record<string, Rect> = {}, gutters: Gutter[] = [];
  if (l.expanded && findStack(l.root, l.expanded)) return { stacks: { [l.expanded]: { x: 0, y: 0, w, h } }, gutters };
  const place = (n: Node, r: Rect) => {
    if (n.kind === 'stack') { out[n.id] = n.min ? { ...r, h: bar } : r; return; }
    const row = n.dir === 'row', span = (row ? r.w : r.h) - gap * (n.children.length - 1);
    // a minimized child takes a fixed size, and the others share the rest by their sizes
    const fixed = n.children.map((c) => (c.kind === 'stack' && c.min ? (row ? minW : bar) : 0));
    const free = Math.max(0, span - fixed.reduce((a, b) => a + b, 0));
    const share = n.sizes.reduce((a, s, i) => a + (fixed[i] ? 0 : s), 0) || 1;
    let at = row ? r.x : r.y;
    n.children.forEach((c, i) => {
      const len = fixed[i] || (free * n.sizes[i]) / share;
      place(c, row ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len });
      at += len;
      if (i < n.children.length - 1) {
        gutters.push(row ? { x: at, y: r.y, w: gap, h: r.h, split: n.id, i, dir: n.dir, size: span } : { x: r.x, y: at, w: r.w, h: gap, split: n.id, i, dir: n.dir, size: span });
        at += gap;
      }
    });
  };
  place(l.root, { x: 0, y: 0, w, h });
  return { stacks: out, gutters };
}

/**
 * The zone of a rect under a point. The middle square, from `inner` to 1 - `inner` of the rect on both axes, stacks.
 * The four sides are trapezoids from the edge to that square. Returns null outside the rect.
 */
export function zoneAt(r: Rect, x: number, y: number, inner = 0.25): Side | null {
  const u = (x - r.x) / r.w, v = (y - r.y) / r.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (u >= inner && u <= 1 - inner && v >= inner && v <= 1 - inner) return 'center';
  // the nearest edge, measured in shares of the rect, so the diagonals split the sides
  const d = { left: u, right: 1 - u, top: v, bottom: 1 - v };
  return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}
