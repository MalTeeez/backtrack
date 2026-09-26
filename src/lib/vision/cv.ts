/**
 * Loads OpenCV.js (WASM, about 10 MB) once per worker. The build of @techstark/opencv-js has ORB, AKAZE, pyramidal
 * Lucas-Kanade, Canny, HoughLinesP and matchTemplate, but no SIFT and no LSD (plan section 5.1 allows ORB). It is one
 * file of the build that each worker fetches and runs, so the browser downloads it once and the page never loads it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let ready: Promise<{ cv: CV }> | null = null;
/**
 * Loads OpenCV and returns it as `{ cv }`. The module object has a `then` of its own, so it always travels in a
 * wrapper. A promise (or an async function) that resolves to the module itself waits on it forever.
 */
export function loadCv(): Promise<{ cv: CV }> {
  ready ??= (async () => {
    const g = globalThis as unknown as { cv?: CV; module?: unknown; exports?: unknown };
    if (!g.cv) {
      const { default: url } = await import('@techstark/opencv-js/dist/opencv.js?url');
      // the UMD script sets the global cv when there is no module system
      (0, eval)(await (await fetch(url)).text());
    }
    const m = g.cv as CV;
    return new Promise<{ cv: CV }>((resolve) => {
      if (m.Mat) resolve({ cv: m });
      else m.onRuntimeInitialized = () => resolve({ cv: m });
    });
  })();
  return ready;
}

/** Runs f with OpenCV objects that are deleted afterwards, as WASM memory is not garbage collected. */
export function using<T>(f: (keep: <O extends { delete(): void }>(o: O) => O) => T): T {
  const made: { delete(): void }[] = [];
  try {
    return f((o) => { made.push(o); return o; });
  } finally {
    for (const o of made) o.delete();
  }
}
