import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { hoverIcons } from './lib/hoverIcons.ts';
import { tooltips } from './lib/tooltips.ts';

// The moving icons animate when the pointer is over their button, everywhere.
hoverIcons();
// Every title shows in the tooltip of the app.
tooltips();
// A button clicked with the pointer gives up the focus, so the keys of the page work right after the click. Space
// then plays the video. A button pressed from the keyboard (detail 0) keeps the focus.
document.addEventListener('click', (e) => {
  if (e.detail > 0) (e.target as Element | null)?.closest?.<HTMLElement>('button, [role="button"]')?.blur();
});

export default mount(App, { target: document.getElementById('app')! });
