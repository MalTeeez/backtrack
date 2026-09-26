/**
 * Moves the first element of an anchor to the end of the page while the anchor lives, so a menu or a tooltip inside a
 * window of the dock shows over every window. A window is a layer of its own, and an element inside it stays in that
 * layer, however high its z-index. Svelte keeps the anchor in its place, and the element goes away with it.
 */
export function portal(anchor: HTMLElement) {
  const el = anchor.firstElementChild as HTMLElement;
  document.body.appendChild(el);
  return () => el.remove();
}
