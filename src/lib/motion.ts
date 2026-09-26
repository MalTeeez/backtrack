/**
 * The motion of the app, after the navigation menu and the accordions of oxide.computer (docs/review-plan.md, stage
 * 8). Content that replaces other content slides 200 px from the side of the new choice and fades, in 0.25 s with a
 * decelerating curve. A popup opens from 90 percent scale and a 30 deg tilt in 0.2 s, and closes to 95 percent and
 * 10 deg. Content that opens or folds eases its height in 0.3 s. With reduced motion, every one of them is a fade of
 * 0.1 s.
 */
import { slide as svelteSlide } from 'svelte/transition';

/** A CSS cubic-bezier curve as a function of t (0 to 1), solved by Newton steps with a bisection fallback. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s, dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx, y = (s: number) => ((ay * s + by) * s + cy) * s;
  return (t) => {
    if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
    let s = t;
    for (let i = 0; i < 8; i++) { const e = x(s) - t, d = dx(s); if (Math.abs(e) < 1e-6) return y(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) { if (x(s) < t) lo = s; else hi = s; s = (lo + hi) / 2; }
    return y(s);
  };
}
export const easeOut = bezier(0, 0, 0.2, 1);
export const easeFold = bezier(0.87, 0, 0.13, 1);
const ease = bezier(0.25, 0.1, 0.25, 1);

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fade = { duration: 100, css: (t: number) => `opacity: ${t}` };

/** The side content slides from or to, which is the side of the choice before (start) or after (end) the current one. */
export type Side = 'start' | 'end';
/** The side of a change from index a to index b. A later choice comes from the end. */
export const sideOf = (a: number, b: number): Side => (b >= a ? 'end' : 'start');

/** New content enters 200 px from a side and fades in. */
export function slideIn(_node: Element, { from = 'end' as Side } = {}) {
  if (reduced()) return fade;
  const k = from === 'end' ? 200 : -200;
  return { duration: 250, easing: easeOut, css: (t: number, u: number) => `opacity: ${t}; transform: translateX(${k * u}px)` };
}
/** Old content leaves 200 px to a side and fades out. */
export function slideOut(_node: Element, { to = 'start' as Side } = {}) {
  if (reduced()) return fade;
  const k = to === 'end' ? 200 : -200;
  return { duration: 250, easing: easeOut, css: (t: number, u: number) => `opacity: ${t}; transform: translateX(${k * u}px)` };
}
/** A popup opens from a tilt. */
export function popIn(_node: Element, { duration = 200, from = 0.9 } = {}) {
  if (reduced()) return fade;
  return { duration, easing: ease, css: (t: number, u: number) => `opacity: ${t}; transform: perspective(2000px) rotateX(${-30 * u}deg) scale(${from + (1 - from) * t})` };
}
/** A popup closes to a smaller tilt. */
export function popOut(_node: Element, { duration = 200 } = {}) {
  if (reduced()) return fade;
  return { duration, easing: ease, css: (t: number, u: number) => `opacity: ${t}; transform: perspective(2000px) rotateX(${-10 * u}deg) scale(${0.95 + 0.05 * t})` };
}
/** Content opens and folds by its height. */
export function fold(node: Element) {
  return svelteSlide(node, { duration: reduced() ? 0 : 300, easing: easeFold });
}
