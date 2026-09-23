/**
 * Prepares a video for marking with mediabunny, which reads containers in plain JavaScript:
 * - It lists the presentation time of every frame. Recordings have no fixed frame rate, and frame stepping and
 *   thumbnails use this list (frames.ts).
 * - It remuxes WebM and Matroska without re-encoding. A MediaRecorder WebM has no seek index, and Firefox then
 *   reports a wrong duration and stalls about 2 s before playing after a seek. The remuxed file has an index and a
 *   duration. MP4 files keep their bytes, because MP4 already has an index.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, EncodedPacketSink, Input, MATROSKA, Output, WEBM, WebMOutputFormat } from 'mediabunny';

export interface Prepared { blob: Blob; frames: number[]; durationS: number; width: number; height: number }

export async function prepareClip(blob: Blob, name: string): Promise<Prepared> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const format = await input.getFormat().catch(() => null);
  const track = format && (await input.getPrimaryVideoTrack());
  if (!track) throw new Error(`${name} has no video that this app can read. Use WebM or MP4.`);

  const frames: number[] = [];
  for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) frames.push(p.timestamp);
  // packets come in decode order, and an MP4 with B-frames shows them in another order
  frames.sort((a, b) => a - b);
  // the timeline starts at the first frame
  const t0 = frames[0] ?? 0;
  if (t0 !== 0) for (let i = 0; i < frames.length; i++) frames[i] -= t0;

  let out = blob;
  if (format === WEBM || format === MATROSKA) {
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({ input, output, audio: { discard: true } });
    if (!conversion.isValid) throw new Error(`${name} could not be prepared: ${conversion.discardedTracks.map((t) => t.reason).join(', ')}.`);
    await conversion.execute();
    out = new Blob([output.target.buffer!], { type: 'video/webm' });
  }
  const durationS = await input.computeDuration();
  return { blob: out, frames, durationS, width: track.displayWidth, height: track.displayHeight };
}
