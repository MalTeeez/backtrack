/**
 * Decodes the frames around the playhead at the size of the viewer, for the frame steps of the player
 * (src/lib/video/stepCache.ts). A seek of the video decodes from the keyframe before the frame, which takes a few
 * hundred ms with a keyframe every few seconds. This worker keeps its decoder where it stopped, so the next frames
 * forward cost one decode each. A frame before that point decodes again from its keyframe.
 * A request asks for the frames that start at `times` (s of the app, sorted), and each comes back as an ImageBitmap.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';

type Ask = { job: number; url: string; times: number[]; w: number; h: number };

let open: { url: string; track: InputVideoTrack; t0: number; sink: VideoSampleSink } | null = null;
// The running decode: the samples to come, and the one it read last but did not use yet.
let run: { it: AsyncGenerator<VideoSample, void, unknown>; held: VideoSample | null; at: number } | null = null;
let queue = Promise.resolve();

async function clip(url: string) {
  if (open?.url === url) return open;
  run?.held?.close();
  run = null;
  const blob = await (await fetch(url)).blob();
  const track = await new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) }).getPrimaryVideoTrack();
  if (!track) throw new Error('no video');
  open = { url, track, t0: await track.getFirstTimestamp(), sink: new VideoSampleSink(track) };
  return open;
}

async function serve(q: Ask) {
  try {
    const c = await clip(q.url);
    if (!q.times.length) { postMessage({ job: q.job, done: true }); return; }
    const first = q.times[0], last = q.times[q.times.length - 1];
    // A decoder may give a time a little off the one of the frame list, so a frame counts within 1 ms.
    const wanted = (t: number) => q.times.some((x) => Math.abs(x - t) < 1e-3);
    // A decode that stopped before the first frame, and not far before, goes on. Otherwise one starts at the keyframe.
    if (!run || run.at > first + 1e-3 || first - run.at > 3) {
      run?.held?.close();
      run = { it: c.sink.samples(first + c.t0), held: null, at: first };
    }
    for (;;) {
      const s = run.held ?? (await run.it.next()).value;
      run.held = null;
      if (!s) { run = null; break; }
      const t = s.timestamp - c.t0;
      if (t > last + 1e-3) { run.held = s; run.at = t; break; }
      run.at = t;
      if (wanted(t)) {
        const frame = s.toVideoFrame();
        const bmp = await createImageBitmap(frame, { resizeWidth: q.w, resizeHeight: q.h, resizeQuality: 'high' });
        frame.close();
        postMessage({ job: q.job, t, bmp }, [bmp]);
      }
      s.close();
    }
    postMessage({ job: q.job, done: true });
  } catch (e) {
    run = null;
    postMessage({ job: q.job, error: String(e) });
  }
}

self.onmessage = ({ data: q }: MessageEvent<Ask>) => { queue = queue.then(() => serve(q)); };
