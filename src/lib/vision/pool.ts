/**
 * A pool of vision workers (vision.worker.ts), one per spare CPU core, each with its own OpenCV: the work per frame of
 * the detection runs on all cores (automation plan section 14). Data that many jobs share (the reference frame and its
 * features) goes to each worker once and stays there under a key.
 */
import type { Gray8 } from './image.ts';
import type { Intrinsics } from './rotation.ts';
import type { Feats, Relative, StabRunner } from './stabilize.ts';
import { seedOf } from './stabilize.ts';

interface Job { task: string; args: Record<string, unknown>; need: Record<string, () => unknown>; ok: (v: unknown) => void; fail: (e: Error) => void }
interface Slot { w: Worker; busy: boolean; has: Set<string> }

export class Pool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, Job & { slot: Slot }>();
  private next = 0;

  constructor(readonly size = Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))) {
    for (let k = 0; k < size; k++) {
      const w = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { w, busy: false, has: new Set() };
      w.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        slot.busy = false;
        if (data.error) job.fail(new Error(data.error));
        else job.ok(data.result);
        this.pump();
      };
      w.onerror = (e) => { for (const [id, job] of this.pending) if (job.slot === slot) { this.pending.delete(id); job.fail(new Error(e.message || 'A vision worker failed.')); } };
      this.slots.push(slot);
    }
  }

  /** Runs a task on the next free worker. `need` gives shared data by key: a worker that lacks a key gets it first. */
  run<T>(task: string, args: Record<string, unknown>, need: Record<string, () => unknown> = {}): Promise<T> {
    return new Promise<T>((ok, fail) => {
      this.queue.push({ task, args, need, ok: ok as (v: unknown) => void, fail });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      // a job whose shared data this worker has already goes first
      let k = this.queue.findIndex((j) => Object.keys(j.need).every((key) => slot.has.has(key)));
      if (k < 0) k = 0;
      const job = this.queue.splice(k, 1)[0], id = this.next++;
      const put: Record<string, unknown> = {};
      for (const [key, get] of Object.entries(job.need)) if (!slot.has.has(key)) { put[key] = get(); slot.has.add(key); }
      slot.busy = true;
      this.pending.set(id, { ...job, slot });
      slot.w.postMessage({ id, task: job.task, args: job.args, put });
    }
  }

  /** Forgets the shared data of a run in every worker. */
  drop(prefix: string) {
    for (const slot of this.slots) {
      const gone = [...slot.has].filter((k) => k.startsWith(prefix));
      if (!gone.length) continue;
      for (const k of gone) slot.has.delete(k);
      slot.w.postMessage({ id: -1, task: 'drop', args: { keys: gone }, put: {} });
    }
  }

  terminate() {
    for (const s of this.slots) s.w.terminate();
    for (const job of this.pending.values()) job.fail(new Error('Stopped.'));
    this.pending.clear();
    this.queue = [];
  }
}

let runs = 0;
/** The stabilization spread over the pool: a job per frame, the frame it is compared with sent once per worker. */
export function poolRunner(pool: Pool): StabRunner {
  const run = `stab${runs++}:`;
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const id = (o: object) => { if (!ids.has(o)) ids.set(o, nextId++); return ids.get(o)!; };
  return {
    features: (halves) => Promise.all(halves.map((g) => pool.run<Feats>('features', { g }))),
    relative: (jobs, feats, halves, Kh: Intrinsics, f: number) => Promise.all(jobs.map(({ i, j }) => {
      const fk = `${run}f${id(feats[j])}`, gk = `${run}g${id(halves[j])}`;
      return pool.run<Relative | null>('relative', { fj: fk, gj: gk, fi: feats[i], gi: halves[i], Kh, f, seed: seedOf(i, j) }, { [fk]: () => feats[j], [gk]: () => halves[j] as Gray8 });
    })),
  };
}
