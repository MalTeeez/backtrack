/**
 * The smallest size of a window. The browser arranges the content of its body at the smallest size that still shows it
 * whole, and a resize stops there. What "whole" means lives in app.css (the measure-w and measure-h rules), in units of
 * the text, not in pixels:
 * - Text stays on one line, except prose (own text of four words or more), which wraps no narrower than --prose-min.
 * - A row of controls does not wrap, unless it has data-wrap. A box that may shrink to nothing (min-width 0, as a flex
 *   or grid item that truncates) counts its content.
 * - A scroll area shows all of its content, except a long list (data-scroll-min), which keeps --scroll-min of it.
 * - A picture (data-media, which is a video, a canvas or a map) takes no width of its own. It keeps the height it has
 *   at the smallest width of the window and its aspect ratio (--aspect).
 */

/**
 * Marks the parts that the measure treats apart: prose, rows of controls that wrap, and boxes that may shrink to
 * nothing. It reads the computed styles, because a component may style itself in its own CSS. The returned function
 * removes the marks again.
 */
export function markParts(body: Element): () => void {
  const marked: [Element, string][] = [];
  const mark = (el: Element, k: string, v = '') => { el.setAttribute(k, v); marked.push([el, k]); };
  for (const el of body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.flexWrap === 'wrap' && cs.display.includes('flex')) mark(el, 'data-row');
    if (cs.minWidth === '0px') mark(el, 'data-shrink');
    if (el.closest('button, a, label, [role="button"]')) continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) own += n.textContent;
    if (own.trim().split(/\s+/).length >= 4) mark(el, 'data-prose', cs.display === 'inline' ? 'inline' : '');
  }
  return () => { for (const [el, k] of marked) el.removeAttribute(k); };
}

function measure(body: HTMLElement, cls: string, get: (el: HTMLElement) => number): number {
  body.classList.add(cls);
  const v = get(body);
  body.classList.remove(cls);
  return v;
}
/** The smallest width of the body. */
export const minWidth = (body: HTMLElement) => measure(body, 'measure-w', (el) => el.offsetWidth);
/** The smallest height of the body at the width it has now, with its pictures as at the smallest width `least`. */
export function minHeight(body: HTMLElement, least: number): number {
  body.style.setProperty('--media-w', `${least}px`);
  const h = measure(body, 'measure-h', (el) => el.offsetHeight);
  body.style.removeProperty('--media-w');
  return h;
}
