/**
 * Rotation math for the stabilization (automation plan section 5 and Appendix A.1). The camera axes are x right,
 * y down and z forward. A frame's rotation R maps bearings of the reference camera to its own, as b_frame = R * b_ref.
 * Matrices are row-major arrays of 9. Deterministic, without I/O.
 */
import { cameraAxes, D2R, R2D, wrap360 } from '../solver/camera.ts';

export type Mat3 = number[]; // row-major 3x3
export type V3 = [number, number, number];

/** The pinhole camera of a frame, with the focal length and principal point in pixels. */
export interface Intrinsics { f: number; cx: number; cy: number }

export const bearing = (K: Intrinsics, x: number, y: number): V3 => {
  const a = (x - K.cx) / K.f, b = (y - K.cy) / K.f, n = Math.hypot(a, b, 1);
  return [a / n, b / n, 1 / n];
};
/** The pixel of a bearing, or null behind the camera. */
export const pixel = (K: Intrinsics, v: V3): { x: number; y: number } | null =>
  v[2] <= 1e-9 ? null : { x: K.cx + (K.f * v[0]) / v[2], y: K.cy + (K.f * v[1]) / v[2] };

export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mul = (A: Mat3, B: Mat3): Mat3 => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};
export const T = (A: Mat3): Mat3 => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
export const apply = (A: Mat3, v: V3): V3 => [
  A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
/** The angle (deg) between two unit vectors. */
export const angleBetween = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
/** The rotation angle (deg) of a rotation matrix. */
export const rotationAngle = (R: Mat3) => Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * R2D;

/** Eigenvalues and eigenvectors (columns of `vectors`, row-major n x n) of a symmetric matrix, by Jacobi rotations. */
export function eigenSym(A: number[], n: number): { values: number[]; vectors: number[] } {
  const a = [...A], v: number[] = Array.from({ length: n * n }, (_, i) => (i % (n + 1) === 0 ? 1 : 0));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p * n + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k * n + p], vkq = v[k * n + q];
        v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: v };
}

/**
 * The rotation R that best maps the bearings a onto b (b = R a), by weighted least squares. It uses Horn's closed form
 * with quaternions, which gives the same result as Kabsch.
 */
export function fitRotation(a: V3[], b: V3[], w?: number[]): Mat3 {
  const S = new Array(9).fill(0);
  a.forEach((p, k) => { const q = b[k], wk = w?.[k] ?? 1; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += wk * p[i] * q[j]; });
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const N = [
    xx + yy + zz, yz - zy, zx - xz, xy - yx,
    yz - zy, xx - yy - zz, xy + yx, zx + xz,
    zx - xz, xy + yx, -xx + yy - zz, yz + zy,
    xy - yx, zx + xz, yz + zy, -xx - yy + zz,
  ];
  const { values, vectors } = eigenSym(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const [q0, qx, qy, qz] = [0, 1, 2, 3].map((r) => vectors[r * 4 + best]);
  return [
    q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy),
    2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx),
    2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz,
  ];
}

/** A rotation about an axis (unit) by an angle in degrees, for tests and the synthetic scenes. */
export function axisAngle(axis: V3, deg: number): Mat3 {
  const [x, y, z] = norm(axis), t = deg * D2R, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/**
 * The world orientation of a camera, with the columns right, down and forward in world coordinates (X east, Y north,
 * Z up), as rayWorld in camera.ts.
 */
export function cameraToWorld(headingDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
  const { R, U, F } = cameraAxes(headingDeg, pitchDeg, rollDeg);
  return [R[0], -U[0], F[0], R[1], -U[1], F[1], R[2], -U[2], F[2]];
}

/** The heading, pitch and roll (deg) of a camera from its world orientation (the inverse of cameraToWorld). */
export function anglesOf(M: Mat3): { h: number; p: number; r: number } {
  const F: V3 = [M[2], M[5], M[8]], Rt: V3 = [M[0], M[3], M[6]];
  const h = wrap360(Math.atan2(F[0], F[1]) * R2D), p = Math.asin(Math.max(-1, Math.min(1, F[2]))) * R2D;
  const { R: R0, U: U0 } = cameraAxes(h, p, 0);
  const r = Math.atan2(dot(Rt, U0 as V3), dot(Rt, R0 as V3)) * R2D;
  return { h, p, r };
}

/** The camera of frame i, which is the reference camera turned by the frame's rotation (A.1, M_ref * R_i^T). */
export const frameCamera = (Mref: Mat3, Ri: Mat3) => anglesOf(mul(Mref, T(Ri)));

/** The homography K R^T K^-1, which maps frame pixels to the reference camera. */
export function toRef(K: Intrinsics, R: Mat3): number[] {
  const Km = [K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1], Ki = [1 / K.f, 0, -K.cx / K.f, 0, 1 / K.f, -K.cy / K.f, 0, 0, 1];
  return mul(mul(Km, T(R)), Ki);
}
/** Maps a pixel p of the reference camera into frame i, as K R K^-1 p. */
export function refToFrame(K: Intrinsics, R: Mat3, p: { x: number; y: number }) {
  const v = apply(R, bearing(K, p.x, p.y));
  return { x: K.cx + (K.f * v[0]) / v[2], y: K.cy + (K.f * v[1]) / v[2] };
}
