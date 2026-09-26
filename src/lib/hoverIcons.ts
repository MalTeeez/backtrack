/**
 * The moving icons (@jis3r/icons) animate on the hover of the icon itself. Across the app they animate on the hover
 * of the control that holds them. When the pointer enters a button, a link, a tab or a label, every moving icon in it
 * plays. When the pointer leaves, the icons that animate for as long as they are hovered stop. One listener on the
 * document does this for every control, present and future.
 */
const HOSTS = 'button, a, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"]';
const ICONS = 'div[role="img"]';

function relay(e: PointerEvent, type: 'mouseenter' | 'mouseleave') {
  const host = (e.target as Element | null)?.closest?.(HOSTS);
  // only when the pointer crosses the edge of the control, not when it moves between its children
  if (!host || (e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) return;
  for (const icon of host.querySelectorAll(ICONS)) {
    // the icon's own hover already reached it
    if (icon.contains(e.target as Node)) continue;
    icon.dispatchEvent(new MouseEvent(type));
  }
}

export function hoverIcons(root: Document = document) {
  root.addEventListener('pointerover', (e) => relay(e, 'mouseenter'));
  root.addEventListener('pointerout', (e) => relay(e, 'mouseleave'));
}
