import { describe, expect, test } from 'bun:test';
import { float, move, place, rects, resize, split, stack, stacks, toggleMax, withWindows, zoneAt, type Layout } from '../../src/lib/dock/layout.ts';

const tabs = (l: Layout) => stacks(l.root).map((s) => s.tabs.join('+'));
const base = (): Layout => ({ root: split('row', [stack(['signoff']), split('col', [stack(['video', 'stab']), stack(['timeline'])], [0.7, 0.3])], [0.25, 0.75]) });

describe('dock layout', () => {
  test('a window moves next to another, and the split of that side takes it as a sibling', () => {
    const l = base(), video = stacks(l.root)[1];
    const r = move(l, { win: 'stab' }, video.id, 'right');
    expect(tabs(r)).toEqual(['signoff', 'video', 'stab', 'timeline']);
    // the video and the stabilized view now share a row inside the column
    expect(r.root.kind === 'split' && r.root.children[1].kind === 'split' && r.root.children[1].children[0].kind === 'split').toBe(true);
    expect(tabs(l)).toEqual(['signoff', 'video+stab', 'timeline']);
  });

  test('a window dropped in the middle joins the stack as its active tab', () => {
    const l = base(), timeline = stacks(l.root)[2];
    const r = move(l, { win: 'signoff' }, timeline.id, 'center');
    expect(tabs(r)).toEqual(['video+stab', 'timeline+signoff']);
    expect(stacks(r.root)[1].active).toBe(1);
    // the left column of the sign-off list went away with it
    expect(r.root.kind).toBe('split');
    expect(r.root.kind === 'split' && r.root.dir).toBe('col');
  });

  test('a whole stack moves by its bar, and a split of the same direction merges into its parent', () => {
    const l = base(), video = stacks(l.root)[1], timeline = stacks(l.root)[2];
    const r = move(l, { stack: video.id }, timeline.id, 'bottom');
    expect(tabs(r)).toEqual(['signoff', 'timeline', 'video+stab']);
    expect(r.root.kind === 'split' && r.root.children[1].kind === 'split' && r.root.children[1].children.length).toBe(2);
  });

  test('a move onto the dock edge wraps the whole tree', () => {
    const r = move(base(), { win: 'timeline' }, 'root', 'top');
    expect(r.root.kind === 'split' && r.root.dir).toBe('col');
    expect(tabs(r)[0]).toBe('timeline');
  });

  test('a move onto its own stack changes nothing', () => {
    const l = base(), timeline = stacks(l.root)[2];
    expect(move(l, { win: 'timeline' }, timeline.id, 'left')).toBe(l);
    expect(move(l, { win: 'video' }, stacks(l.root)[1].id, 'center')).toBe(l);
  });

  test('the rects share the dock by the sizes, and a minimized stack keeps its bar', () => {
    const l = base(), [a, b, c] = stacks(l.root);
    const r = rects(l, 1008, 408);
    expect(r.stacks[a.id]).toEqual({ x: 0, y: 0, w: 250, h: 408 });
    expect(r.stacks[b.id].h).toBeCloseTo(280, 6);
    expect(r.gutters).toHaveLength(2);
    c.min = true;
    const m = rects(l, 1008, 408);
    expect(m.stacks[c.id].h).toBe(26);
    expect(m.stacks[b.id].h).toBeCloseTo(408 - 8 - 26, 6);
    // an expanded stack fills the dock alone
    expect(Object.keys(rects({ ...l, expanded: b.id }, 1008, 408).stacks)).toEqual([b.id]);
  });

  test('a resize moves a share between neighbors and keeps a least share', () => {
    const l = base(), p = l.root.kind === 'split' ? l.root : null;
    const r = resize(l, p!.id, 0, 0.1);
    expect(r.root.kind === 'split' && r.root.sizes).toEqual([0.35, 0.65]);
    const s = resize(l, p!.id, 0, -1);
    expect(s.root.kind === 'split' && s.root.sizes[0]).toBeCloseTo(0.05, 9);
  });

  test('the zones: the middle quarter, and the nearest side elsewhere', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 };
    expect(zoneAt(r, 100, 50)).toBe('center');
    expect(zoneAt(r, 190, 50)).toBe('right');
    expect(zoneAt(r, 100, 5)).toBe('top');
    expect(zoneAt(r, 5, 95)).toBe('left');
    expect(zoneAt(r, 250, 50)).toBeNull();
  });

  test('a saved layout keeps to the windows of the page', () => {
    const r = withWindows(base(), ['signoff', 'video', 'timeline', 'scene']);
    expect(tabs(r)).toEqual(['signoff+scene', 'video', 'timeline']);
    // a floating window of the page stays floating, and an unknown one leaves
    const f = withWindows({ ...base(), floating: [{ win: 'map', r: box }, { win: 'old', r: box }] }, ['signoff', 'video', 'stab', 'timeline', 'map']);
    expect(f.floating?.map((x) => x.win)).toEqual(['map']);
    expect(tabs(f)).toEqual(['signoff', 'video+stab', 'timeline']);
  });

  test('a window floats out of the tree, and the last one leaves an empty stack', () => {
    const r = float(base(), 'signoff', box);
    expect(tabs(r)).toEqual(['video+stab', 'timeline']);
    expect(r.floating).toEqual([{ win: 'signoff', r: box }]);
    const alone: Layout = { root: stack(['video']) };
    const e = float(alone, 'video', box);
    expect(tabs(e)).toEqual(['']);
    // attached again on the empty tree, it fills it
    const back = move(e, { win: 'video' }, 'root', 'right');
    expect(tabs(back)).toEqual(['video']);
    expect(back.floating).toEqual([]);
  });

  test('a floating window attaches next to a stack, and a press brings a floating window on top', () => {
    const l = { ...base(), floating: [{ win: 'map', r: box }, { win: 'scene', r: box }] };
    const r = move(l, { win: 'map' }, stacks(l.root)[2].id, 'right');
    expect(tabs(r)).toEqual(['signoff', 'video+stab', 'timeline', 'map']);
    expect(r.floating?.map((x) => x.win)).toEqual(['scene']);
    expect(place(l, 'map').floating?.map((x) => x.win)).toEqual(['scene', 'map']);
    expect(place(l, 'scene')).toBe(l);
    // it keeps its floating size for its next float
    expect(r.sizes?.map).toEqual({ w: 0.3, h: 0.3 });
    expect(move(r, { win: 'signoff' }, stacks(r.root)[1].id, 'center').sizes?.map).toEqual({ w: 0.3, h: 0.3 });
  });

  test('a floating window maximizes, comes back where it was, and a move ends the maximized state', () => {
    const l = { ...base(), floating: [{ win: 'map', r: box }, { win: 'scene', r: box }] };
    const big = toggleMax(l, 'scene');
    expect(big.floating?.at(-1)).toEqual({ win: 'scene', r: { x: 0, y: 0, w: 1, h: 1 }, prev: box });
    // a press on another window keeps the state
    expect(place(big, 'map').floating?.find((f) => f.win === 'scene')?.prev).toEqual(box);
    expect(toggleMax(big, 'scene').floating?.at(-1)).toEqual({ win: 'scene', r: box });
    expect(place(big, 'scene', { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }).floating?.at(-1)?.prev).toBeUndefined();
  });
});

const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
