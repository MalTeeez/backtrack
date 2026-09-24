/**
 * Undo and redo for the project data: marks, shots, craters and settings. The clips are not part of it, because a
 * deleted video cannot come back. Changes that follow each other within GROUP_MS (typing, a drag) make one step.
 */
import { fixShot, project } from './project.svelte.ts';
import type { ProjectData } from '../solver/types.ts';

const GROUP_MS = 600, MAX = 100;

let current = '', last = 0;
const undos: string[] = [], redos: string[] = [];
/** How many steps each way, for the buttons. */
export const history = $state({ undo: 0, redo: 0 });

/** Records the project as it is now. The first call only takes the starting point. */
export function record(data: ProjectData) {
  const s = JSON.stringify(data);
  // an undo or redo sets `current` first, so its own snapshot ends here
  if (s === current) return;
  if (!current) { current = s; return; }
  const now = performance.now();
  if (now - last > GROUP_MS) {
    undos.push(current);
    if (undos.length > MAX) undos.shift();
  }
  last = now;
  current = s;
  redos.length = 0;
  sync();
}

function restore(s: string) {
  current = s;
  last = 0;
  Object.assign(project, JSON.parse(s));
  fixShot(); // the step may take away the selected shot
  // a shot fixShot adds belongs to this step, so the history does not take it for a new change
  current = JSON.stringify($state.snapshot(project));
  sync();
}
const sync = () => Object.assign(history, { undo: undos.length, redo: redos.length });

/**
 * Forgets every step, for example after a clip was deleted: an undo past that point would bring back sightings of a
 * video that is gone.
 */
export function clearHistory() {
  undos.length = 0;
  redos.length = 0;
  current = '';
  sync();
}

export function undo() {
  const s = undos.pop();
  if (s == null) return;
  redos.push(current);
  restore(s);
}
export function redo() {
  const s = redos.pop();
  if (s == null) return;
  undos.push(current);
  restore(s);
}
