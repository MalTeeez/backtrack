/**
 * The shell candidates on the GPU (WebGPU compute). It runs the same steps as bandCandidates in shell.ts, over the
 * whole frame at once. It follows OpenCV where the result depends on it: the Gaussian kernel sizes (8 sigma + 1 for
 * floats), the reflect-101 border of the blurs and the Sobel, block means for the 1/8 size, OpenCV's bilinear
 * upsampling, and a dilation that ignores pixels outside the frame. The frames stay on the GPU, and only the
 * candidates come back. shellCandidates falls back to the CPU when there is no GPU.
 */
import type { Candidate } from './shell.ts';
import { toRef } from './rotation.ts';
import type { Gray8 } from './image.ts';
import type { Intrinsics, Mat3 } from './rotation.ts';

let device: Promise<GPUDevice | null> | null = null;
/** The GPU device, created once, or null without WebGPU. */
export function gpuDevice(): Promise<GPUDevice | null> {
  device ??= (async () => {
    const gpu = (globalThis.navigator as Navigator & { gpu?: GPU })?.gpu;
    const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) return null;
    return adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
      },
    }).catch(() => null);
  })();
  return device;
}

/** A normalized OpenCV Gaussian kernel for float images, of size 8 sigma + 1 (odd). */
export function gaussKernel(sigma: number): Float32Array {
  const n = Math.round(sigma * 8 + 1) | 1, r = (n - 1) / 2, k = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { k[i] = Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)); sum += k[i]; }
  for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}

const COMMON = /* wgsl */ `
struct Dims { w: u32, h: u32, n: u32, layer: u32 }
fn r101(i: i32, n: i32) -> i32 { if (i < 0) { return -i; } if (i >= n) { return 2 * n - 2 - i; } return i; }
`;

/** The bilinear warped value of frame `layer` at a reference pixel, 0 outside the frame, rounded as an 8-bit warp. */
const WARP = /* wgsl */ `
@group(0) @binding(0) var frames: texture_2d_array<f32>;
@group(0) @binding(1) var<uniform> dims: Dims;
@group(0) @binding(2) var<storage, read> homs: array<mat3x3<f32>>; // per frame, from reference pixel to frame pixel
fn px(x: i32, y: i32, l: u32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(dims.w) || y >= i32(dims.h)) { return 0.0; }
  return textureLoad(frames, vec2<i32>(x, y), i32(l), 0).r * 255.0;
}
fn warped(x: u32, y: u32, l: u32) -> f32 {
  let p = homs[l] * vec3<f32>(f32(x), f32(y), 1.0);
  let u = p.x / p.z; let v = p.y / p.z;
  let x0 = i32(floor(u)); let y0 = i32(floor(v)); let fx = u - f32(x0); let fy = v - f32(y0);
  let a = px(x0, y0, l) * (1.0 - fx) + px(x0 + 1, y0, l) * fx;
  let b = px(x0, y0 + 1, l) * (1.0 - fx) + px(x0 + 1, y0 + 1, l) * fx;
  return round(a * (1.0 - fy) + b * fy);
}
`;

const MEDIAN = COMMON + WARP + /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> bg: array<f32>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= dims.w || g.y >= dims.h) { return; }
  var v: array<f32, 96>;
  var k = 0u;
  for (var l = 0u; l < dims.n; l++) {
    let s = warped(g.x, g.y, l);
    if (s == 0.0) { continue; }
    // insertion into the sorted values
    var j = k;
    while (j > 0u && v[j - 1u] > s) { v[j] = v[j - 1u]; j--; }
    v[j] = s; k++;
  }
  bg[g.y * dims.w + g.x] = select(0.0, v[k / 2u], k > 0u);
}`;

const WARP_ONE = COMMON + WARP + /* wgsl */ `
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= dims.w || g.y >= dims.h) { return; }
  out[g.y * dims.w + g.x] = warped(g.x, g.y, dims.layer);
}`;

/** A separable Gaussian (weights) or max filter along x or y. Mode 0 blurs src, 1 blurs bg - src, and 2 takes the max. */
const LINE = COMMON + /* wgsl */ `
struct Line { w: u32, h: u32, axis: u32, mode: u32, r: i32 }
@group(0) @binding(0) var<uniform> P: Line;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> bg: array<f32>;
@group(0) @binding(3) var<storage, read> k: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let w = i32(P.w); let h = i32(P.h);
  var acc = select(0.0, -3.4e38, P.mode == 2u);
  for (var i = -P.r; i <= P.r; i++) {
    var x = i32(g.x); var y = i32(g.y);
    if (P.axis == 0u) { x += i; } else { y += i; }
    if (P.mode == 2u) {
      // a dilation leaves out what lies outside the frame
      if (x < 0 || y < 0 || x >= w || y >= h) { continue; }
      acc = max(acc, src[u32(y * w + x)]);
    } else {
      x = r101(x, w); y = r101(y, h);
      let j = u32(y * w + x);
      let v = select(src[j], bg[j] - src[j], P.mode == 1u);
      acc += k[u32(i + P.r)] * v;
    }
  }
  dst[g.y * P.w + g.x] = acc;
}`;

/** |bg - w| as block means of 8 x 8 (INTER_AREA at 1/8). */
const AREA = /* wgsl */ `
struct Area { w: u32, h: u32, sw: u32, sh: u32 }
@group(0) @binding(0) var<uniform> P: Area;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> bg: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.sw || g.y >= P.sh) { return; }
  var s = 0.0;
  for (var y = 0u; y < 8u; y++) { for (var x = 0u; x < 8u; x++) { let j = (g.y * 8u + y) * P.w + g.x * 8u + x; s += abs(bg[j] - src[j]); } }
  dst[g.y * P.sw + g.x] = s / 64.0;
}`;

/** The Sobel magnitude of the background (reflect-101). */
const SOBEL = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> bg: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
fn at(x: i32, y: i32) -> f32 { return bg[u32(r101(y, i32(dims.h)) * i32(dims.w) + r101(x, i32(dims.w)))]; }
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= dims.w || g.y >= dims.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let gx = (at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2.0 * at(x - 1, y) + at(x - 1, y + 1));
  let gy = (at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2.0 * at(x, y - 1) + at(x + 1, y - 1));
  dst[g.y * dims.w + g.x] = sqrt(gx * gx + gy * gy);
}`;

/** score = d - 1.5 big - 0.25 tex, with big the 1/8 blur upsampled as OpenCV does (INTER_LINEAR). */
const SCORE = /* wgsl */ `
struct Sc { w: u32, h: u32, sw: u32, sh: u32 }
@group(0) @binding(0) var<uniform> P: Sc;
@group(0) @binding(1) var<storage, read> d: array<f32>;
@group(0) @binding(2) var<storage, read> small: array<f32>;
@group(0) @binding(3) var<storage, read> tex: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;
fn lin(o: f32, n: u32) -> vec3<f32> {
  var f = o; var i0 = i32(floor(f)); var a = f - f32(i0);
  if (i0 < 0) { i0 = 0; a = 0.0; }
  if (i0 >= i32(n) - 1) { i0 = i32(n) - 1; a = 0.0; }
  return vec3<f32>(f32(i0), f32(min(i0 + 1, i32(n) - 1)), a);
}
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let lx = lin((f32(g.x) + 0.5) / 8.0 - 0.5, P.sw); let ly = lin((f32(g.y) + 0.5) / 8.0 - 0.5, P.sh);
  let s00 = small[u32(ly.x) * P.sw + u32(lx.x)]; let s01 = small[u32(ly.x) * P.sw + u32(lx.y)];
  let s10 = small[u32(ly.y) * P.sw + u32(lx.x)]; let s11 = small[u32(ly.y) * P.sw + u32(lx.y)];
  let big = (s00 * (1.0 - lx.z) + s01 * lx.z) * (1.0 - ly.z) + (s10 * (1.0 - lx.z) + s11 * lx.z) * ly.z;
  let j = g.y * P.w + g.x;
  dst[j] = d[j] - 1.5 * big - 0.25 * tex[j];
}`;

/** Local maxima above the least score, inside the mask, on a pixel with a picture, away from the border. */
const PEAKS = /* wgsl */ `
struct Pk { w: u32, h: u32, border: u32, cap: u32, minScore: f32 }
struct Cand { x: f32, y: f32, score: f32, pad: u32 }
fn off(l: f32, m: f32, r: f32) -> f32 { let den = l - 2.0 * m + r; if (den >= 0.0) { return 0.0; } return clamp(0.5 * (l - r) / den, -0.5, 0.5); }
@group(0) @binding(0) var<uniform> P: Pk;
@group(0) @binding(1) var<storage, read> score: array<f32>;
@group(0) @binding(2) var<storage, read> peak: array<f32>;
@group(0) @binding(3) var<storage, read> w: array<f32>;
@group(0) @binding(4) var<storage, read> mask: array<u32>;
@group(0) @binding(5) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> out: array<Cand>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < P.border || g.y < P.border || g.x >= P.w - P.border || g.y >= P.h - P.border) { return; }
  let j = g.y * P.w + g.x;
  let v = score[j];
  if (v <= P.minScore || v != peak[j] || w[j] == 0.0) { return; }
  if (((mask[j / 4u] >> ((j % 4u) * 8u)) & 255u) == 0u) { return; }
  let k = atomicAdd(&count[0], 1u);
  // the subpixel peak, as off() of the CPU (peakOffset in shell.ts)
  if (k < P.cap) { out[k] = Cand(f32(g.x) + off(score[j - 1u], v, score[j + 1u]), f32(g.y) + off(score[j - P.w], v, score[j + P.w]), v, 0u); }
}`;

/**
 * Finds the candidates of every frame on the GPU. It takes the frames as a texture array (the caller already set the HUD
 * pixels to 0), the homographies from the reference camera into each frame, the mask of the fixed HUD, and the
 * thresholds of A.3.
 */
export async function gpuCandidates(dev: GPUDevice, frames: (Gray8 | null)[], Rs: (Mat3 | null)[], K: Intrinsics, mask: Gray8, o: { minScore: number; border: number; window: number }): Promise<Candidate[]> {
  const idx = frames.map((f, i) => (f && Rs[i] ? i : -1)).filter((i) => i >= 0);
  const { w: W, h: H } = frames[idx[0]]!, N = idx.length, px = W * H;
  if (N > 96) throw new Error('A section of more than 96 frames is too long for the GPU median.');
  const SW = Math.round(W / 8), SH = Math.round(H / 8);
  const S = GPUBufferUsage.STORAGE, U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
  const made: GPUBuffer[] = [];
  const buf = (size: number, usage: number) => { const b = dev.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage }); made.push(b); return b; };
  const upload = (data: ArrayBufferView, usage = S | GPUBufferUsage.COPY_DST) => { const b = buf(data.byteLength, usage); dev.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength); return b; };
  const uniform = (u32s: number[], f32s: number[] = []) => {
    const a = new ArrayBuffer(Math.max(16, Math.ceil((u32s.length + f32s.length) * 4 / 16) * 16));
    new Uint32Array(a, 0, u32s.length).set(u32s);
    if (f32s.length) new Float32Array(a, u32s.length * 4, f32s.length).set(f32s);
    const b = buf(a.byteLength, U); dev.queue.writeBuffer(b, 0, a); return b;
  };
  try {
    // each frame gets one layer. The rows of a texture upload are multiples of 256 bytes.
    const tex = dev.createTexture({ size: [W, H, N], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const row = Math.ceil(W / 256) * 256;
    idx.forEach((i, l) => {
      let data = frames[i]!.data;
      if (row !== W) { const p = new Uint8Array(row * H); for (let y = 0; y < H; y++) p.set(data.subarray(y * W, y * W + W), y * row); data = p; }
      dev.queue.writeTexture({ texture: tex, origin: [0, 0, l] }, data.buffer as ArrayBuffer, { offset: data.byteOffset, bytesPerRow: row, rowsPerImage: H }, [W, H, 1]);
    });
    // the map from reference pixel to frame pixel is the inverse of toRef, column-major for WGSL
    const homs = new Float32Array(N * 12);
    idx.forEach((i, l) => {
      const M = invert3(toRef(K, Rs[i]!));
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) homs[l * 12 + c * 4 + r] = M[r * 3 + c];
    });
    const homBuf = upload(homs);
    const f32 = (n: number) => buf(n * 4, S | GPUBufferUsage.COPY_SRC);
    const bg = f32(px), w = f32(px), a = f32(px), b = f32(px), score = f32(px), texF = f32(px), small = f32(SW * SH), small2 = f32(SW * SH), small3 = f32(SW * SH);
    const maskBuf = upload(new Uint8Array(mask.data.buffer, mask.data.byteOffset, mask.data.byteLength).slice(0, Math.ceil(px / 4) * 4));
    const pipe = (code: string) => dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code }), entryPoint: 'main' } });
    const pMedian = pipe(MEDIAN), pWarp = pipe(WARP_ONE), pLine = pipe(LINE), pArea = pipe(AREA), pSobel = pipe(SOBEL), pScore = pipe(SCORE), pPeaks = pipe(PEAKS);
    const view = tex.createView({ dimension: '2d-array' });
    const enc = dev.createCommandEncoder();
    const run = (p: GPUComputePipeline, entries: GPUBuffer[], gx: number, gy: number, first?: GPUTextureView) => {
      const pass = enc.beginComputePass();
      pass.setPipeline(p);
      const e: GPUBindGroupEntry[] = [];
      let k = 0;
      if (first) e.push({ binding: k++, resource: first });
      for (const bb of entries) e.push({ binding: k++, resource: { buffer: bb } });
      pass.setBindGroup(0, dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: e }));
      pass.dispatchWorkgroups(Math.ceil(gx / 16), Math.ceil(gy / 16));
      pass.end();
    };
    const kern = new Map<number, GPUBuffer>();
    const kOf = (sigma: number) => { if (!kern.has(sigma)) kern.set(sigma, upload(gaussKernel(sigma))); return kern.get(sigma)!; };
    const none = upload(new Float32Array(4));
    /** A separable filter, a Gaussian of src (mode 0) or of bg - src (mode 1), or a max (mode 2) of half size r. */
    const sep = (src: GPUBuffer, dst: GPUBuffer, tmp: GPUBuffer, w: number, h: number, mode: 0 | 1 | 2, sigmaOrR: number) => {
      const k = mode === 2 ? none : kOf(sigmaOrR), r = mode === 2 ? sigmaOrR : (gaussKernel(sigmaOrR).length - 1) / 2;
      run(pLine, [uniform([w, h, 0, mode, r]), src, bg, k, tmp], w, h);
      // the second direction blurs the first result as it is
      run(pLine, [uniform([w, h, 1, mode === 1 ? 0 : mode, r]), tmp, bg, k, dst], w, h);
    };
    const dims = (layer = 0) => uniform([W, H, N, layer]);

    run(pMedian, [dims(), homBuf, bg], W, H, view);
    // the texture is the Sobel magnitude, blurred with sigma 2 and dilated 9 x 9
    run(pSobel, [dims(), bg, a], W, H);
    sep(a, b, texF, W, H, 0, 2);
    sep(b, texF, a, W, H, 2, 4);
    const CAP = 4096;
    const counts = buf(N * 256, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const cands = buf(N * CAP * 16, S | GPUBufferUsage.COPY_SRC);
    const R = (o.window - 1) / 2;
    for (let l = 0; l < N; l++) {
      run(pWarp, [dims(l), homBuf, w], W, H, view);
      sep(w, b, a, W, H, 1, 1.5); // d = blur(bg - w) in b
      run(pArea, [uniform([W, H, SW, SH]), w, bg, small], SW, SH);
      sep(small, small2, small3, SW, SH, 0, 25 / 8); // the 1/8 blur in small2
      run(pScore, [uniform([W, H, SW, SH]), b, small2, texF, score], W, H);
      sep(score, a, b, W, H, 2, R); // the peaks in a
      const pass = enc.beginComputePass();
      pass.setPipeline(pPeaks);
      pass.setBindGroup(0, dev.createBindGroup({
        layout: pPeaks.getBindGroupLayout(0),
        entries: [
          ...[uniform([W, H, o.border, CAP], [o.minScore]), score, a, w, maskBuf].map((bb, k): GPUBindGroupEntry => ({ binding: k, resource: { buffer: bb } })),
          { binding: 5, resource: { buffer: counts, offset: l * 256, size: 4 } }, { binding: 6, resource: { buffer: cands, offset: l * CAP * 16, size: CAP * 16 } },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(W / 16), Math.ceil(H / 16));
      pass.end();
    }
    const readC = buf(N * 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST), readK = buf(N * CAP * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    enc.copyBufferToBuffer(counts, 0, readC, 0, N * 256);
    enc.copyBufferToBuffer(cands, 0, readK, 0, N * CAP * 16);
    dev.queue.submit([enc.finish()]);
    await Promise.all([readC.mapAsync(GPUMapMode.READ), readK.mapAsync(GPUMapMode.READ)]);
    const cnt = new Uint32Array(readC.getMappedRange().slice(0)), raw = readK.getMappedRange().slice(0);
    const f = new Float32Array(raw), out: Candidate[] = [];
    idx.forEach((i, l) => {
      for (let k = 0; k < Math.min(cnt[l * 64], CAP); k++) { const o4 = (l * CAP + k) * 4; out.push({ i, x: f[o4], y: f[o4 + 1], score: f[o4 + 2] }); }
    });
    tex.destroy();
    return out;
  } finally {
    for (const b of made) b.destroy();
  }
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
