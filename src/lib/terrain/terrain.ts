/**
 * Terrain heights from the wardogs-calculator Terrain3D data (docs/terrain-plan.md): a manifest and chunks of
 * little-endian 16-bit samples. A chunk sample decodes to meters as
 * worldZOffsetMeters + (minLocalZ + raw / 65535 * (maxLocalZ - minLocalZ)) * worldZScaleMetersPerLocalUnit.
 * The heights share one unknown datum, so only their differences mean something.
 */

export interface Manifest {
  chunkXMin: number; chunkXMax: number; chunkYMin: number; chunkYMax: number;
  chunkQuads: number; verticesPerSide: number;
  globalQuadOffsetX: number; globalQuadOffsetY: number;
  gameUnitsToLandscapeQuadsX: number; gameUnitsToLandscapeQuadsY: number;
  worldZOffsetMeters: number; worldZScaleMetersPerLocalUnit: number;
  coverage: { gameXMin: number; gameXMax: number; gameYMin: number; gameYMax: number };
  chunks: Record<string, { file: string; minLocalZ: number; maxLocalZ: number }>;
}

/** Loads one file of the dataset (a path relative to the manifest), or null when it is missing. */
export type Loader = (path: string) => Promise<ArrayBuffer | null>;

export class Terrain {
  private chunks = new Map<string, Promise<DataView | null>>();
  /** The chunks that finished loading, for `heightNow`. */
  private loaded = new Map<string, DataView | null>();

  constructor(readonly manifest: Manifest, private load: Loader) {}

  /** Opens the dataset at `base` (a URL ending in /) over HTTP. Null when it was not downloaded. */
  static async open(base: string): Promise<Terrain | null> {
    const load: Loader = async (path) => {
      const r = await fetch(base + path).catch(() => null);
      return r?.ok ? r.arrayBuffer() : null;
    };
    const m = await load('manifest.json');
    return m ? new Terrain(JSON.parse(new TextDecoder().decode(m)), load) : null;
  }

  /** The chunk and the position inside it (in samples) of a game point, or null outside the covered area. */
  private locate(x: number, y: number) {
    const m = this.manifest, c = m.coverage;
    if (x < c.gameXMin || x > c.gameXMax || y < c.gameYMin || y > c.gameYMax) return null;
    const qx = m.globalQuadOffsetX + x * m.gameUnitsToLandscapeQuadsX;
    const qy = m.globalQuadOffsetY + y * m.gameUnitsToLandscapeQuadsY;
    const cx = Math.max(m.chunkXMin, Math.min(m.chunkXMax, Math.floor(qx / m.chunkQuads)));
    const cy = Math.max(m.chunkYMin, Math.min(m.chunkYMax, Math.floor(qy / m.chunkQuads)));
    const key = `${cx},${cy}`;
    return m.chunks[key] ? { key, lx: qx - cx * m.chunkQuads, ly: qy - cy * m.chunkQuads } : null;
  }

  private chunk(key: string): Promise<DataView | null> {
    let p = this.chunks.get(key);
    if (!p) {
      p = this.load(this.manifest.chunks[key].file).then((b) => (b ? new DataView(b) : null)).catch(() => null);
      p.then((v) => this.loaded.set(key, v));
      this.chunks.set(key, p);
    }
    return p;
  }

  /** Loads every chunk that overlaps the game rectangle, so `heightNow` can read it without waiting. */
  async preload(x0: number, y0: number, x1: number, y1: number) {
    // steps of 5 game units (500 m) are finer than a chunk (about 1 km), so no chunk is missed
    const keys = new Set<string>();
    for (let x = x0; x < x1 + 5; x += 5) for (let y = y0; y < y1 + 5; y += 5) {
      const at = this.locate(Math.min(x, x1), Math.min(y, y1));
      if (at) keys.add(at.key);
    }
    await Promise.all([...keys].map((k) => this.chunk(k)));
  }

  /** The ground height (m) at a game point, interpolated between the 4 samples around it. Null without data there. */
  async height(x: number, y: number): Promise<number | null> {
    const at = this.locate(x, y);
    if (!at) return null;
    const view = await this.chunk(at.key);
    return view ? this.sample(view, at) : null;
  }

  /** Like `height`, from the chunks loaded so far (see `preload`). Null outside them. */
  heightNow(x: number, y: number): number | null {
    const at = this.locate(x, y);
    const view = at && this.loaded.get(at.key);
    return view ? this.sample(view, at) : null;
  }

  private sample(view: DataView, at: { key: string; lx: number; ly: number }): number {
    const m = this.manifest, e = m.chunks[at.key], side = m.verticesPerSide, max = side - 1;
    const x0 = Math.max(0, Math.min(max, Math.floor(at.lx))), y0 = Math.max(0, Math.min(max, Math.floor(at.ly)));
    const x1 = Math.min(max, x0 + 1), y1 = Math.min(max, y0 + 1);
    const fx = at.lx - x0, fy = at.ly - y0;
    const z = (sx: number, sy: number) => {
      const raw = view.getUint16((sy * side + sx) * 2, true);
      return m.worldZOffsetMeters + (e.minLocalZ + (raw / 65535) * (e.maxLocalZ - e.minLocalZ)) * m.worldZScaleMetersPerLocalUnit;
    };
    const top = z(x0, y0) + (z(x1, y0) - z(x0, y0)) * fx;
    const bottom = z(x0, y1) + (z(x1, y1) - z(x0, y1)) * fx;
    return top + (bottom - top) * fy;
  }
}
