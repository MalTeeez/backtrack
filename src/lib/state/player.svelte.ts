/**
 * The video of the selected clip, shared by every window of a page (Mark, Review). It holds the loaded clip, the start
 * time of each of its frames, the frame on screen, playback and seeking. A page calls `usePlayer` once. The video loads
 * the selected clip while that page is open.
 */
import { untrack } from 'svelte';
import { clipFrames, clipUrl } from './persistence.ts';
import { clipView, clips, ui } from './project.svelte.ts';
import { frameIndexAt, frameTimeAt, sameFrame, seekTimeFor } from '../video/frames.ts';
import { cacheFrames, previewAt } from '../video/frameCache.svelte.ts';
import { prefetch, stepFrame } from '../video/stepCache.ts';
import { seek, stepFrames } from '../video/frameStepper.ts';
import { fixDuration } from '../video/webmDuration.ts';
import type { Id } from '../solver/types.ts';

export const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.preload = 'auto';

export const player = $state({
  loaded: null as Id | null,
  loadError: '',
  /** The start time of the frame on screen. */
  frameTime: 0,
  /** Where a running seek goes, so a playhead follows the pointer at once. */
  scrub: null as number | null,
  /** Goes up by one for every new picture on the screen. */
  frame: 0,
  playing: false,
  /**
   * A picture of the frame a seek or a step goes to, which the viewer shows over the video until the video shows that
   * frame itself. It is a small preview (frameCache.svelte.ts), or for an exact seek the frame at the size of the viewer
   * (stepCache.ts). `own` says whether the player closes the picture when it goes, which a picture of the step cache
   * does not.
   */
  preview: null as { t: number; bmp: ImageBitmap; own: boolean } | null,
  /** The width of the viewer in pixels of the screen, for the size of the frames of the step cache. */
  viewPx: 1920,
});
// The start time of every frame of the loaded clip. The list is raw, because it is long and never changes in place.
let frames = $state.raw<number[] | undefined>();
export const playerFrames = () => frames;
/** The time the page shows, which is where a seek goes or else the frame on screen. */
export const playerTime = () => player.scrub ?? player.frameTime;
export const playerDuration = () => clips.list.find((c) => c.id === player.loaded)?.durationS ?? 0;
/** The section of the timeline that playback repeats, for the loaded clip. */
export const playerSection = () => (player.loaded && ui.clipViews[player.loaded]?.loop) || null;

const shown = () => {
  player.frameTime = frameTimeAt(frames, video.currentTime);
  player.frame++;
  if (player.preview && (player.playing || sameFrame(player.preview.t, player.frameTime))) dropPreview();
};
const dropPreview = () => { if (player.preview?.own) player.preview.bmp.close(); player.preview = null; };
/**
 * Shows the preview of the frame at t, if the frame cache has one, until the video shows that frame. A later seek
 * replaces it, and a preview that comes in after its frame is on screen goes away.
 */
let previewFor = -1;
function showPreview(t: number) {
  const id = player.loaded, blob = id ? previewAt(id, t) : undefined;
  previewFor = t;
  if (!blob) return;
  createImageBitmap(blob).then((bmp) => {
    if (previewFor !== t || (sameFrame(player.frameTime, t) && !video.seeking)) { bmp.close(); return; }
    dropPreview();
    player.preview = { t, bmp, own: true };
  }, () => {});
}
video.addEventListener('seeked', shown);
video.addEventListener('loadeddata', shown);
video.addEventListener('pause', () => { player.playing = false; shown(); });
video.addEventListener('play', () => {
  player.playing = true;
  // playback starts inside the section, and goes back to its start at its end
  const s = playerSection();
  if (s && (video.currentTime < s.a || video.currentTime >= s.b)) video.currentTime = seekTimeFor(s.a);
  const tick = () => {
    if (!player.playing) return;
    const sec = playerSection();
    if (sec && video.currentTime >= sec.b) video.currentTime = seekTimeFor(sec.a);
    shown();
    requestAnimationFrame(tick);
  };
  tick();
});

// A seek takes a moment, and a drag on a timeline asks for many. Only the newest target counts, so the queue skips
// targets that a later one replaced. A playing video keeps playing from the new place. The target is the start of the
// frame at t, because the video shows only whole frames. Otherwise a small drag inside one frame would show the time
// under the pointer first and then jump back to the start of the frame.
let target: number | null = null;
let seeking = false;
/**
 * `exact` seeks show no small preview, for the moves where the picture of the frame matters: a step of the keys, a jump
 * to a sighting, and the edge of a section or the loop. They show the frame at the size of the viewer from the step
 * cache when it has the frame, and else wait for the video.
 */
export async function seekTo(t: number, exact = false) {
  player.scrub = target = frameTimeAt(frames, Math.max(0, t));
  if (exact) {
    previewFor = -1;
    const bmp = player.loaded && frames ? stepFrame(player.loaded, frameIndexAt(frames, target)) : undefined;
    dropPreview();
    if (bmp) player.preview = { t: target, bmp, own: false };
    keepNear(target);
  } else showPreview(target);
  if (seeking) return;
  seeking = true;
  while (target != null) {
    const next: number = target;
    target = null;
    await seek(video, seekTimeFor(next));
  }
  seeking = false;
  player.scrub = null;
  keepNear(player.frameTime);
}
/** Keeps the frames next to the one at t decoded, for the next steps (stepCache.ts). */
let loadedUrl = '';
function keepNear(t: number) {
  const id = player.loaded, vw = video.videoWidth, vh = video.videoHeight;
  if (!id || !frames?.length || !vw || !vh || !loadedUrl) return;
  const w = Math.min(vw, Math.max(640, Math.round(player.viewPx / 2) * 2)), h = Math.round((w * vh) / vw / 2) * 2;
  prefetch(id, loadedUrl, frames, frameIndexAt(frames, t), w, h);
}

let wanted: { t: number; sightingId?: Id; play: boolean } | null = null;
/** Goes to a time of a clip, loading that clip first when it is another one. An `exact` seek shows no preview (seekTo). */
export function go(clipId: Id, t: number, sightingId?: Id, exact = false) {
  if (sightingId) ui.sightingId = sightingId;
  if (clipId !== player.loaded) { wanted = { t, sightingId, play: player.playing }; ui.clipId = clipId; return; }
  seekTo(t, exact);
}

export function togglePlay() {
  if (!player.loaded) return;
  if (video.paused) video.play();
  else video.pause();
}

let stepping = false;
/**
 * Pauses and steps n frames. A negative n steps back. A step goes from the frame a running seek goes to, so steps in a
 * fast row add up without waiting for the video, and each shows its frame from the step cache when it has it.
 */
export async function stepBy(n: number) {
  if (!player.loaded) return;
  video.pause();
  if (frames?.length) {
    const i = Math.max(0, Math.min(frames.length - 1, frameIndexAt(frames, player.scrub ?? player.frameTime) + n));
    seekTo(frames[i], true);
    return;
  }
  // without a frame list, a step is 1/60 s
  if (stepping || seeking) return;
  stepping = true;
  dropPreview();
  try {
    player.frameTime = await stepFrames(video, frames, n, player.frameTime);
  } finally {
    stepping = false;
  }
}

// The count of pages that use the player. A page that slides out during a phase change still holds it while the next
// one starts.
let users = 0;

/** Loads the selected clip while the calling component lives, and keeps the frame on screen for the next visit. */
export function usePlayer() {
  users++;
  $effect(() => { video.defaultPlaybackRate = video.playbackRate = ui.speed; });
  // the frame on screen, kept while paused, so the clip opens on it again (after a phase change or a reload)
  $effect(() => {
    const t = player.frameTime, id = player.loaded;
    if (id && !player.playing) untrack(() => clipView(id)).t = t;
  });
  $effect(() => {
    const id = ui.clipId;
    if (!id || id === untrack(() => player.loaded)) return;
    let stale = false;
    player.loadError = '';
    (async () => {
      // The frame list comes first, because the preparation of an older clip replaces its video.
      const list = await clipFrames(id);
      const url = await clipUrl(id);
      loadedUrl = url ?? '';
      if (stale) return;
      frames = list;
      if (!url) { player.loadError = 'The video of this clip is missing.'; return; }
      video.src = url;
      await new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error('This browser cannot play this video.')); });
      await fixDuration(video);
      if (stale) return;
      player.loaded = id;
      dropPreview();
      await seek(video, seekTimeFor(wanted?.t ?? ui.clipViews[id]?.t ?? 0));
      player.frameTime = frameTimeAt(frames, video.currentTime);
      // the small pictures of every frame, for the strip and the previews, from the frame on screen out
      if (list?.length) cacheFrames(id, url, list, { w: video.videoWidth, h: video.videoHeight }, () => (player.loaded === id ? player.frameTime : 0));
      keepNear(player.frameTime);
      if (wanted?.sightingId) ui.sightingId = wanted.sightingId;
      if (wanted?.play) video.play();
      wanted = null;
    })().catch((e) => (player.loadError = e.message));
    return () => { stale = true; };
  });
  // When the last page leaves, the frame stays for the next visit, and the video releases its clip.
  $effect(() => () => {
    if (--users > 0) return;
    if (player.loaded) clipView(player.loaded).t = player.frameTime;
    video.pause();
    video.removeAttribute('src');
    player.loaded = null;
  });
}
