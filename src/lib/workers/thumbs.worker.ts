/**
 * Makes small pictures of the frames of a clip off the page, for the film strip, the clip list and the previews of
 * the player (src/lib/video/frameCache.svelte.ts). mediabunny decodes the frames with WebCodecs and draws them small.
 * - `plan` gives the start of every keyframe. A frame decodes from the keyframe before it, so the stretches between
 *   keyframes can decode apart, one per worker.
 * - `frames` decodes every frame of some stretches. Each frame goes back as a small ImageBitmap for the strip, which the
 *   page draws at once without decoding, and a larger JPEG for the preview of the player.
 * - `thumbs` gives the frames at some times as JPEG data URLs, for the clip list. A data URL costs the page nothing,
 *   where an object URL of a blob takes a call to the browser each.
 * The worker keeps the file it opened last.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack } from 'mediabunny';

type Job =
  | { job: number; kind: 'plan'; url: string }
  | { job: number; kind: 'frames'; url: string; ranges: [number, number][]; thumbH: number; proxyW: number; proxyH: number }
  | { job: number; kind: 'thumbs'; url: string; times: number[]; height: number }
  | { cancel: number };

let open: { url: string; track: InputVideoTrack; t0: number; w: number; h: number; sinks: Map<string, CanvasSink> } | null = null;
const cancelled = new Set<number>();
let queue = Promise.resolve();

async function clip(url: string) {
  if (open?.url === url) return open;
  const blob = await (await fetch(url)).blob();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video');
  // The app counts the time from the first frame, and the file may start later.
  open = { url, track, t0: await track.getFirstTimestamp(), w: await track.getDisplayWidth(), h: await track.getDisplayHeight(), sinks: new Map() };
  return open;
}
function sink(c: NonNullable<typeof open>, width: number, height: number) {
  const key = `${width}x${height}`;
  let s = c.sinks.get(key);
  if (!s) c.sinks.set(key, (s = new CanvasSink(c.track, { width, height, fit: 'fill', poolSize: 3 })));
  return s;
}
const jpeg = (canvas: OffscreenCanvas, quality: number) => canvas.convertToBlob({ type: 'image/jpeg', quality });
const dataUrl = (b: Blob) => new FileReaderSync().readAsDataURL(b);

async function run(q: Exclude<Job, { cancel: number }>) {
  try {
    const c = await clip(q.url);
    if (q.kind === 'plan') {
      const keys: number[] = [];
      for await (const p of new EncodedPacketSink(c.track).packets(undefined, undefined, { metadataOnly: true })) if (p.type === 'key') keys.push(p.timestamp - c.t0);
      postMessage({ job: q.job, keys: keys.sort((a, b) => a - b) });
    } else if (q.kind === 'frames') {
      // Each frame shrinks once to the size of the preview (createImageBitmap, which is quicker than a draw of the
      // whole frame on a canvas), and the thumbnail comes from that.
      const thumbW = Math.round((q.thumbH * c.w) / c.h), big = new OffscreenCanvas(q.proxyW, q.proxyH), small = new OffscreenCanvas(thumbW, q.thumbH);
      const G = big.getContext('2d')!, g = small.getContext('2d')!, samples = new VideoSampleSink(c.track);
      for (const [a, b] of q.ranges) {
        for await (const sample of samples.samples(a + c.t0, b + c.t0)) {
          const t = sample.timestamp - c.t0, frame = sample.toVideoFrame();
          const bmp = await createImageBitmap(frame, { resizeWidth: q.proxyW, resizeHeight: q.proxyH, resizeQuality: 'low' });
          frame.close();
          sample.close();
          if (cancelled.has(q.job)) { bmp.close(); break; }
          G.drawImage(bmp, 0, 0);
          g.drawImage(bmp, 0, 0, thumbW, q.thumbH);
          bmp.close();
          const thumb = small.transferToImageBitmap(), proxy = await (await jpeg(big, 0.72)).arrayBuffer();
          postMessage({ job: q.job, t, thumb, proxy }, [thumb, proxy]);
        }
        if (cancelled.has(q.job)) break;
      }
    } else {
      const s = sink(c, Math.round((q.height * c.w) / c.h), q.height);
      let i = 0;
      for await (const f of s.canvasesAtTimestamps(q.times.map((t) => t + c.t0))) {
        if (cancelled.has(q.job)) break;
        if (f) postMessage({ job: q.job, i, src: dataUrl(await jpeg(f.canvas as OffscreenCanvas, 0.7)) });
        i++;
      }
    }
    postMessage({ job: q.job, done: true });
  } catch (e) {
    postMessage({ job: q.job, error: String(e) });
  } finally {
    cancelled.delete(q.job);
  }
}

self.onmessage = ({ data: q }: MessageEvent<Job>) => {
  if ('cancel' in q) { cancelled.add(q.cancel); return; }
  queue = queue.then(() => run(q));
};
