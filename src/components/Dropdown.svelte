<script lang="ts" generics="T extends string">
  /**
   * A square dropdown. It has a face with the current option and a menu that opens like the navigation menu of
   * oxide.computer (a 30 deg tilt from the middle, at twice its speed). The current option has a check, and an option
   * can lead with an icon. `extra` renders rows under a line. `full` stretches the face over its box, as a form field.
   * It stands in for the select of the browser everywhere.
   */
  import type { Snippet } from 'svelte';
  import { portal } from '../lib/portal.ts';
  import { ICONS, type Icon } from '../lib/icons.ts';
  import { popIn, popOut } from '../lib/motion.ts';

  let { value = $bindable(), options, icon, label, extra, full = false, testid, onchange }: {
    /** Each option is its value, its text, an icon before the text, and a tooltip. */
    value: T; options: [T, string, Icon?, string?][]; icon?: Icon; label: string; extra?: Snippet<[() => void]>; full?: boolean; testid?: string;
    /** Called with the picked option, for a value that is not bound. */
    onchange?: (v: T) => void;
  } = $props();
  const pick = (v: T) => { value = v; onchange?.(v); open = false; };
  let open = $state(false), root: HTMLSpanElement, face: HTMLButtonElement;
  // the menu lies over everything, measured from the face, so a window or a map around it cannot cut it off. It
  // opens upward when the room below is short.
  let at = $state({ left: 0, top: 0, bottom: 0, width: 0, up: false, right: false });
  function place() {
    const r = face.getBoundingClientRect(), up = innerHeight - r.bottom < 260 && r.top > innerHeight - r.bottom;
    at = { left: r.left, top: r.bottom + 4, bottom: innerHeight - r.top + 4, width: r.width, up, right: !full && r.left + 220 > innerWidth };
  }
  const close = () => (open = false);
  // the menu goes to the end of the page while it is open, so no window over the one of the dropdown covers it
  let menu = $state<HTMLElement>();
  const inside = (n: Node | null) => !!n && (root.contains(n) || !!menu?.contains(n));
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!inside(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    // a scroll would leave the menu behind its face
    const scroll = (e: Event) => { if (!(e.target instanceof Node && inside(e.target))) close(); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); window.removeEventListener('scroll', scroll, true); };
  });
  const Face = $derived(icon);
  const current = $derived(options.find(([v]) => v === value));
</script>

<span class="dd" class:full bind:this={root}>
  <button class="face" bind:this={face} onclick={() => { place(); open = !open; }} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={current?.[3] ? `${label}. ${current[3]}.` : label} data-testid={testid}>
    {#if Face}<Face size={12} />{/if}{#if current?.[2]}{@const I = current[2]}<I size={12} />{/if}{current?.[1]}<span class="chev" class:up={open}><ICONS.chevronDown size={12} /></span>
  </button>
  {#if open}
    <span class="anchor" {@attach portal}>
    <span class="menu" bind:this={menu} class:up={at.up} role="menu" in:popIn={{ duration: 100, from: 0.97 }} out:popOut={{ duration: 100 }}
      style="{at.up ? `bottom:${at.bottom}px` : `top:${at.top}px`}; {at.right ? `right:${innerWidth - at.left - at.width}px` : `left:${at.left}px`}; min-width:{Math.max(full ? at.width : 220, 0)}px">
      {#each options as [v, text, I, tip] (v)}
        <button role="menuitemradio" aria-checked={v === value} class:picked={v === value} onclick={() => pick(v)} title={tip}>
          <span class="ck">{#if v === value}<ICONS.check size={12} />{/if}</span><span class="txt">{#if I}<I size={12} />{/if}{text}</span>
        </button>
      {/each}
      {#if extra}<hr />{@render extra(close)}{/if}
    </span>
    </span>
  {/if}
</span>

<style>
  .dd { position: relative; display: inline-flex; }
  .dd.full { display: flex; width: 100%; }
  .dd.full .face { width: 100%; height: 30px; }
  .dd.full .chev { margin-left: auto; }
  .menu.up { transform-origin: bottom center; }
  .txt { display: inline-flex; align-items: center; gap: 6px; }
  .menu { max-height: 320px; overflow-y: auto; }
  .face { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 6px 0 8px; font-size: 11px; color: var(--text); background: var(--panel-solid); border: 1px solid var(--line-strong); }
  .face:hover { border-color: var(--accent-border-active); }
  .chev { display: inline-flex; margin-left: 6px; color: var(--muted); transition: rotate 0.25s cubic-bezier(0, 0, 0.2, 1); }
  .chev.up { rotate: 180deg; }
  .anchor { display: none; }
  .menu { position: fixed; z-index: 2000; display: flex; flex-direction: column; padding: 4px 0; background: var(--panel-solid); border: 1px solid var(--line-strong); box-shadow: 0 1px 1px #00000005, 0 4px 8px -4px #0000001a, 0 16px 24px -8px #00000026; transform-origin: top center; }
  .menu :global(button) { display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 6px; padding: 3px 10px; text-align: left; font-size: 11px; color: var(--copy); }
  .menu :global(button:hover) { background: var(--accent-soft); color: var(--text); }
  .menu button.picked { color: var(--accent); }
  .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
