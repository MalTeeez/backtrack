/**
 * A rolling buffer from two staggered MediaRecorders (plan section 7).
 *
 * Each recorder emits a chunk every second, and these chunks are the clock. Timers slow down in a
 * background tab, but `dataavailable` does not. The second recorder starts N s after the first. A
 * recorder restarts when it is older than 2N s and the other one is older than N s, so one of them
 * always holds at least the last N s. "Save" hands over the video of the older recorder and then ends the
 * screen share, like "Stop".
 */

export const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export const canCapture = () =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';

interface Slot { r: MediaRecorder; chunks: Blob[]; mode: 'run' | 'save' | 'discard' }

export interface RecorderOptions {
  bufferS: number;
  bitrateMbps: number;
  onClip: (blob: Blob, seconds: number) => void;
  /** Called when the recording state or the seconds in the buffer change. */
  onStatus: () => void;
  onError: (message: string) => void;
}

export class RollingRecorder {
  private stream: MediaStream | null = null;
  private slots: [Slot | null, Slot | null] = [null, null];
  private mime = '';

  constructor(private o: RecorderOptions) {}

  get active() { return !!this.stream; }

  /** The seconds of video that the next save would contain, at most N. */
  get seconds() {
    const ages = this.slots.filter((s): s is Slot => !!s && s.mode === 'run').map((s) => s.chunks.length);
    return Math.min(Math.max(0, ...ages), this.o.bufferS);
  }

  set bufferS(n: number) { this.o.bufferS = n; }
  /** The next recorder start uses the new value. */
  set bitrateMbps(n: number) { this.o.bitrateMbps = n; }

  /** `mime`, the size and `hint` are for the capture test (docs/capture-test-plan.md). */
  async start(fps: number, test: { mime?: string; width?: number; height?: number; hint?: string } = {}) {
    if (!canCapture()) throw new Error('This browser cannot record the screen. Upload a clip instead.');
    if (test.mime && !MediaRecorder.isTypeSupported(test.mime)) throw new Error(`This browser cannot record ${test.mime}.`);
    const size = test.width ? { width: { ideal: test.width }, height: { ideal: test.height } } : {};
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps }, displaySurface: 'monitor', ...size } as MediaTrackConstraints, audio: false });
    this.stream = stream;
    this.mime = test.mime || pickMime();
    const track = stream.getVideoTracks()[0];
    if (track && test.hint) track.contentHint = test.hint;
    track?.addEventListener('ended', () => this.stop());
    this.startSlot(0);
    this.o.onStatus();
  }

  /** Ends the screen share and drops the buffer. A recorder that is saving still hands over its clip. */
  stop() {
    const stream = this.stream;
    this.stream = null;
    for (const s of this.slots) if (s && s.r.state !== 'inactive' && s.mode !== 'save') { s.mode = 'discard'; s.r.stop(); }
    this.slots = [null, null];
    stream?.getTracks().forEach((t) => t.stop());
    this.o.onStatus();
  }

  /** Keeps the buffer as a clip and ends the screen share. Returns false when there is nothing to save yet. */
  save(): boolean {
    const run = this.slots.filter((s): s is Slot => !!s && s.mode === 'run' && s.chunks.length > 0);
    if (!run.length) return false;
    const oldest = run.reduce((a, b) => (a.chunks.length >= b.chunks.length ? a : b));
    oldest.mode = 'save';
    oldest.r.stop();
    this.stop();
    return true;
  }

  private startSlot(i: 0 | 1) {
    if (!this.stream) { this.slots[i] = null; return; }
    let r: MediaRecorder;
    try {
      // a keyframe every second keeps seeks short. Chrome knows this option, and other browsers ignore it.
      const keyframes = { videoKeyFrameIntervalDuration: 1000 } as MediaRecorderOptions;
      r = new MediaRecorder(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), videoBitsPerSecond: this.o.bitrateMbps * 1e6, ...keyframes });
    } catch (e) {
      this.o.onError(`The recorder could not start: ${(e as Error).message}`);
      this.stop();
      return;
    }
    const slot: Slot = { r, chunks: [], mode: 'run' };
    r.ondataavailable = (e) => {
      if (e.data?.size) slot.chunks.push(e.data);
      if (slot.mode === 'run') this.tick();
    };
    r.onstop = () => {
      if (slot.mode === 'save') this.o.onClip(new Blob(slot.chunks, { type: r.mimeType || this.mime || 'video/webm' }), slot.chunks.length);
      slot.chunks = [];
      if (this.slots[i] === slot) this.startSlot(i); // restart in the same place
    };
    this.slots[i] = slot;
    r.start(1000);
  }

  private tick() {
    const N = this.o.bufferS;
    const [a, b] = this.slots;
    if (!b && a && a.mode === 'run' && a.chunks.length >= N) this.startSlot(1);
    for (const i of [0, 1] as const) {
      const s = this.slots[i], other = this.slots[1 - i];
      if (!s || s.mode !== 'run' || !other || other.mode !== 'run') continue;
      if (s.chunks.length >= 2 * N && other.chunks.length >= N) { s.mode = 'discard'; s.r.stop(); }
    }
    this.o.onStatus();
  }
}
