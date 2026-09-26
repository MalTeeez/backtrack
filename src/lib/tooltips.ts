/**
 * The tooltips of the app, in place of the ones of the browser. Every element with a `title` gets one. After the
 * pointer rests on it for DELAY_MS, a panel with the title opens below it (above it near the bottom of the window).
 * One listener on the document does this for every element, present and future.
 *
 * The browser shows its own tooltip for the nearest element with a `title`, so while the pointer is over an element,
 * the titles of the element and of all its ancestors move into `data-tip`. They come back when the pointer leaves the
 * element. A title the page sets meanwhile moves into `data-tip` as well.
 */
const DELAY_MS = 450;

let tip: HTMLDivElement | null = null;
let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const stashed = new Set<HTMLElement>();

function panel(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  return tip;
}

function stash(el: HTMLElement) {
  const t = el.getAttribute('title');
  if (t == null) return;
  el.dataset.tip = t;
  el.removeAttribute('title');
  stashed.add(el);
}

function show(el: HTMLElement) {
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  const p = panel(), r = el.getBoundingClientRect();
  p.textContent = text;
  p.hidden = false;
  const w = p.offsetWidth, h = p.offsetHeight, gap = 6;
  const below = r.bottom + gap + h <= innerHeight;
  p.style.left = `${Math.max(gap, Math.min(innerWidth - w - gap, r.left + r.width / 2 - w / 2))}px`;
  p.style.top = `${below ? r.bottom + gap : r.top - gap - h}px`;
  p.style.transformOrigin = below ? 'top center' : 'bottom center';
  p.getAnimations().forEach((a) => a.cancel());
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    p.animate([{ opacity: 0, transform: 'perspective(2000px) rotateX(-30deg) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 100, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
}

/** Closes the panel. The titles stay stashed while the pointer is over the element, so the browser shows none. */
function close() {
  clearTimeout(timer);
  if (tip) tip.hidden = true;
}

/** Closes the panel and gives the titles back, when the pointer leaves the element. */
function release() {
  close();
  for (const el of stashed) {
    if (!el.hasAttribute('title') && el.dataset.tip != null) el.setAttribute('title', el.dataset.tip);
    delete el.dataset.tip;
  }
  stashed.clear();
  host = null;
}

export function tooltips(root: Document = document) {
  root.addEventListener('pointerover', (e) => {
    // An element with data-notip shows no tooltip, not even the one of an ancestor, and not the one of the browser.
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip], [data-notip]');
    if (el === host) return;
    release();
    if (!el) return;
    host = el;
    for (let a: HTMLElement | null = el; a; a = a.parentElement) stash(a);
    if (!el.hasAttribute('data-notip')) timer = setTimeout(() => show(el), DELAY_MS);
  });
  root.addEventListener('pointerout', (e) => {
    if (host && !(e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) release();
  });
  root.addEventListener('pointerdown', close, true);
  root.addEventListener('scroll', close, true);
  root.addEventListener('keydown', close, true);
  // A title that the page sets on a stashed element (a reactive tooltip) moves into data-tip at once.
  new MutationObserver((changes) => {
    for (const c of changes) {
      const el = c.target as HTMLElement;
      if (stashed.has(el) && el.hasAttribute('title')) stash(el);
    }
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['title'] });
}
