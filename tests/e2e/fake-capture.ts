/**
 * Replaces getDisplayMedia with a canvas stream (plan section 9). With `scene`, the canvas plays the
 * synthetic shot from the moment the capture starts. It shows the background, two vertical edges, the
 * shell and the impact flash. Without `scene`, it shows a moving bar.
 */
import type { Page } from '@playwright/test';
import { frameAt, type Truth } from '../synthetic/scene.ts';

export interface SceneFrames {
  W: number; H: number; dt: number; duration: number;
  edges: [number, number, number, number][];
  frames: ([number, number] | null)[]; // shell px every dt
  flashes: ([number, number, number] | null)[]; // flash x, y, r every dt
}

export function sceneFrames(tr: Truth, dt = 1 / 240): SceneFrames {
  const frames: SceneFrames['frames'] = [], flashes: SceneFrames['flashes'] = [];
  for (let t = 0; t <= tr.duration; t += dt) {
    const f = frameAt(tr, t);
    frames.push(f.shell ? [f.shell.x, f.shell.y] : null);
    flashes.push(f.flash ? [f.flash.at.x, f.flash.at.y, f.flash.r] : null);
  }
  return {
    W: tr.W, H: tr.H, dt, duration: tr.duration,
    edges: tr.edges.map(([a, b]) => [a.x, a.y, b.x, b.y]),
    frames, flashes,
  };
}

export async function fakeCapture(page: Page, scene?: SceneFrames) {
  await page.addInitScript((sc: SceneFrames | undefined) => {
    const W = sc?.W ?? 640, H = sc?.H ?? 360;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d')!;
    let t0 = 0;
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = 'rgb(40,48,52)';
      g.fillRect(0, 0, W, H);
      if (!sc) {
        g.fillStyle = '#9c9';
        g.fillRect(((t * 200) % W), 0, 40, H);
      } else {
        const i = Math.min(sc.frames.length - 1, Math.floor(Math.min(t, sc.duration) / sc.dt));
        g.strokeStyle = 'rgb(200,200,190)'; g.lineWidth = 3;
        for (const [ax, ay, bx, by] of sc.edges) { g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); }
        const fl = sc.flashes[i];
        if (fl) { g.fillStyle = 'rgb(255,160,60)'; g.beginPath(); g.arc(fl[0], fl[1], fl[2], 0, 7); g.fill(); }
        const s = sc.frames[i];
        if (s) { g.fillStyle = 'rgb(255,230,120)'; g.beginPath(); g.arc(s[0], s[1], 3, 0, 7); g.fill(); }
      }
      requestAnimationFrame(draw);
    };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: async () => {
        t0 = performance.now();
        draw();
        return canvas.captureStream(60);
      },
      configurable: true,
    });
  }, scene);
}
