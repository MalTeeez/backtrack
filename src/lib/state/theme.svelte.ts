/** The theme is light, dark or the system setting. index.html applies the saved choice before the first paint. */
export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'backtrack:theme';
const media = matchMedia('(prefers-color-scheme: dark)');

function saved(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The canvases redraw when `current` changes. */
export const theme = $state({ mode: saved(), current: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' });

function apply() {
  theme.current = theme.mode === 'system' ? (media.matches ? 'dark' : 'light') : theme.mode;
  document.documentElement.dataset.theme = theme.current;
}
media.addEventListener('change', apply);

export function cycleTheme() {
  theme.mode = theme.mode === 'system' ? 'dark' : theme.mode === 'dark' ? 'light' : 'system';
  try { localStorage.setItem(KEY, theme.mode); } catch { /* storage unavailable */ }
  apply();
}
