/**
 * The result of the project, shared by the Result phase and the split view. It solves in a worker (40 Monte Carlo
 * runs per shot take a moment) and only when the inputs of the solver changed, so opening the result again or an
 * edit that does not matter to the solver (the recording settings, the UI) costs nothing.
 */
import { solveProject, type ProjectResult } from '../solver/result.ts';
import type { ProjectData } from '../solver/types.ts';

export const solved: { result: ProjectResult | null; solving: boolean; error: string } = $state({ result: null, solving: false, error: '' });

/** Everything the solver reads, as a string. Equal strings give equal results. */
function inputsKey(p: ProjectData) {
  const { bufferS: _b, bitrateMbps: _r, ...settings } = p.settings;
  return JSON.stringify([settings, p.shots, p.sightings]);
}

let key = '', token = 0, timer: ReturnType<typeof setTimeout> | undefined;
let worker: Worker | null = null;
function solver(data: ProjectData) {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/solver.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.token !== token) return; // an answer to an older question
    // the safe zones come after the result, in a second message
    if (m.safe) { if (solved.result) solved.result = { ...solved.result, safe: m.safe }; return; }
    solved.solving = false;
    if (m.error) solved.error = m.error;
    else { solved.result = m.result; solved.error = ''; }
  };
  worker.onerror = () => { // without a worker, solve on the main thread
    worker = null;
    solved.result = solveProject(data);
    solved.solving = false;
  };
  return worker;
}

/** Solves the project a moment after the last change, unless its inputs are the ones of the last solve. */
export function solve(data: ProjectData) {
  const k = inputsKey(data);
  if (k === key) return;
  key = k;
  const t = ++token;
  solved.solving = true;
  clearTimeout(timer);
  timer = setTimeout(() => solver(data).postMessage({ token: t, project: data }), 150);
}
