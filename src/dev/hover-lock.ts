// Dev-only helper for Agentation: when the toolbar freezes the page (key P),
// also keep hover/focus-only UI open.
//  1. CSS: copies every :hover / :focus* rule to a [data-lock-*] version and
//     sets that attribute on the elements that were hovered/focused at freeze time.
//  2. JS: blocks leave/blur/outside-click events for the app (not the toolbar).
// F8 toggles the lock by hand.

const UI = '[data-feedback-toolbar], [data-annotation-popup], [data-annotation-marker]';
const BLOCK = [
  'mouseleave', 'mouseout', 'pointerleave', 'pointerout',
  'mouseover', 'mouseenter', 'pointerover', 'pointerenter',
  'blur', 'focusout', 'mousedown', 'pointerdown',
];
const MAP: [RegExp, string, string][] = [
  [/:hover(?![\w-])/g, 'data-lock-hover', ':hover'],
  [/:focus-within(?![\w-])/g, 'data-lock-fw', ':focus-within'],
  [/:focus-visible(?![\w-])/g, 'data-lock-fv', ':focus-visible'],
  [/:focus(?![\w-])/g, 'data-lock-focus', ':focus'],
];
const HAS = /:(hover|focus)/;

const swap = (sel: string) => MAP.reduce((s, [re, cls]) => s.replace(re, `[${cls}]`), sel);

// Declarations inside a nested @media etc. (Tailwind v4 output uses this).
const NestedDecls = (globalThis as any).CSSNestedDeclarations;

// inHover: an outer selector already has :hover/:focus, so copy all declarations.
function walk(rules: CSSRuleList, inHover = false): string {
  let out = '';
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const hov = inHover || HAS.test(rule.selectorText);
      const own = hov && rule.style.length ? rule.style.cssText : '';
      const kids = rule.cssRules?.length ? walk(rule.cssRules, hov) : '';
      if (own || kids) out += `${swap(rule.selectorText)}{${own}${kids}}`;
    } else if (NestedDecls && rule instanceof NestedDecls) {
      if (inHover) out += (rule as CSSStyleRule).style.cssText;
    } else if ('cssRules' in rule && !(rule instanceof CSSKeyframesRule)) {
      const kids = walk((rule as CSSGroupingRule).cssRules, inHover);
      if (kids) out += `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${kids}}`;
    }
  }
  return out;
}

function buildCss(): string {
  let css = '';
  const sheets = [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    if ((sheet.ownerNode as Element | null)?.id === 'hover-lock-styles') continue;
    try { css += walk(sheet.cssRules); } catch { /* cross-origin sheet */ }
  }
  return css;
}

export function installHoverLock(): () => void {
  let locked = false;
  let marked: [Element, string][] = [];
  let styleEl: HTMLStyleElement | null = null;

  const stop = (e: Event) => {
    const t = e.target;
    if (t instanceof Element && t.closest(UI)) return; // let the toolbar work
    e.stopImmediatePropagation();
  };

  function lock() {
    if (locked) return;
    locked = true;
    for (const [, cls, pseudo] of MAP) {
      for (const el of document.querySelectorAll(pseudo)) {
        if (el.closest(UI)) continue;
        el.setAttribute(cls, '');
        marked.push([el, cls]);
      }
    }
    styleEl = document.createElement('style');
    styleEl.id = 'hover-lock-styles';
    styleEl.textContent = buildCss();
    document.head.appendChild(styleEl);
    for (const t of BLOCK) window.addEventListener(t, stop, true);
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    for (const t of BLOCK) window.removeEventListener(t, stop, true);
    styleEl?.remove();
    styleEl = null;
    const old = marked;
    marked = [];
    for (const [el, cls] of old) {
      el.removeAttribute(cls);
      // Replay the leave/blur events the app missed while locked.
      if (cls === 'data-lock-hover' && !el.matches(':hover')) {
        el.dispatchEvent(new PointerEvent('pointerleave'));
        el.dispatchEvent(new MouseEvent('mouseleave'));
      }
      if (cls === 'data-lock-focus' && el !== document.activeElement) {
        el.dispatchEvent(new FocusEvent('blur'));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      }
    }
  }

  // Follow Agentation's freeze state (its internal flag on window).
  let wasFrozen = false;
  const sync = () => {
    const frozen = !!(window as any).__agentation_freeze?.frozen;
    if (frozen === wasFrozen) return; // only react to freeze changes
    wasFrozen = frozen;
    (frozen ? lock : unlock)();
  };
  // The toolbar can change the freeze state after the event ends, so check in
  // a new task. MessageChannel is not paused by the freeze (setTimeout is).
  const channel = new MessageChannel();
  channel.port1.onmessage = sync;
  const syncLater = () => {
    sync(); // freeze starts at once: lock before the mouse moves
    channel.port2.postMessage(0); // unfreeze can come later
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'F8') {
      (locked ? unlock : lock)();
      return;
    }
    syncLater();
  };
  // Bubble phase on window: runs after the toolbar's own handlers.
  window.addEventListener('keydown', onKey);
  window.addEventListener('click', syncLater);

  return () => {
    unlock();
    channel.port1.close();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('click', syncLater);
  };
}
