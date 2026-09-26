/**
 * What the file of a clip says about its media, for the Clip details window: the container, the codec of the video
 * with its full codec string, and whether it is HDR. mediabunny reads it from the stored video.
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

export interface MediaInfo {
  container: string;
  video: { codec: string | null; codecString: string | null; hdr: boolean } | null;
}

export async function mediaInfo(blob: Blob): Promise<MediaInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const [format, v] = await Promise.all([input.getFormat(), input.getPrimaryVideoTrack()]);
  return {
    container: format.name,
    video: v && { codec: await v.getCodec(), codecString: await v.getCodecParameterString(), hdr: await v.hasHighDynamicRange() },
  };
}

/**
 * The timing of the frames of a clip (s): the typical frame rate from the median gap, the longest gap, and how many
 * gaps are more than half again as long as the median, which is where the recording skipped frames.
 */
export function frameTiming(frames: number[]) {
  const gaps = frames.slice(1).map((t, i) => t - frames[i]).filter((g) => g > 0);
  if (!gaps.length) return null;
  const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
  return { fps: 1 / median, longest: Math.max(...gaps), skips: gaps.filter((g) => g > 1.5 * median).length };
}
