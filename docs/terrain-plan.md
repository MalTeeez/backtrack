# Terrain heights

This document describes terrain heights for the solver. The user never enters a height. With a map picked in
Coordinates, the solver worker takes the ground heights from the terrain data (`src/lib/terrain/terrain.ts`,
`heights.ts`). Without a map, or outside the data, the ground is flat at height 0, and the camera sits
`EYE_HEIGHT_M` (1.7 m) above the ground (`src/lib/solver/sightings.ts`). The Tests section says which parts have
tests.

## Why

A height difference moves the result. The ballistic model lands the flight at the crater height, so a gun 30 m above
the crater changes the range and the flight time. A position on a hill changes every ray. The flat-ground error has
not been measured yet (see Tests).

## Data source

The Terrain3D datasets of [apollyon-sys/wardogs-calculator](https://github.com/apollyon-sys/wardogs-calculator)
(MIT license), in `data/terrain/<map-id>/`. That repository documents them in `docs/terrain.md`.

- **Maps:** Bakurani, Ozeti and Zestafona.
- **Files:** `manifest.json` describes the grid and the coordinate mapping. `chunks/<x>_<y>.bin` holds the heights.
  A map has 256 chunks of about 510 KB, about 129 MB in all.
- **Samples:** each chunk is 511 x 511 little-endian unsigned 16-bit samples with 2 m spacing.
- **Decode:** local z = minLocalZ + raw / 65535 * (maxLocalZ - minLocalZ), from the chunk entry in the manifest.
  The height is worldZOffsetMeters + local z * worldZScaleMetersPerLocalUnit.
- **Game coordinates to samples:** quad = globalQuadOffset + game * gameUnitsToLandscapeQuads, per axis. The Y factor
  is negative (-50), because the landscape rows run opposite to the map Y.
- **Sampling:** bilinear interpolation over the 4 samples around the point, as `terrainHeightAtPointSync` in
  `js/features/terrain-ballistics.js` does.
- **Datum:** the heights have an unknown offset of roughly 900 m. The solver uses only height differences, so the
  offset does not matter.

## Solver changes

1. The solver reads the map from `settings.map` (absent means flat ground). The map cannot come from the coordinates
   alone, because the maps share one coordinate range.
2. `src/lib/terrain/terrain.ts` loads the manifest of the map, fetches a chunk the first time a point needs it, keeps
   it in memory, and samples heights. It runs in the solver worker.
3. The crater height is the terrain height at the crater. The camera sits `EYE_HEIGHT_M` above the crater, because
   the user stands near it.
4. The gun height depends on the gun position, which the solver finds. The solver starts with the crater height,
   solves, samples the terrain at the gun, and solves again with that height. It stops when the gun height changes by
   less than 0.5 m, or after 4 rounds. Each round only moves the gun along its track, so 2 or 3 rounds should do.
5. The Monte Carlo runs reuse the heights of the exact solve, so the chunks load once.

## Hosting

Backtrack is for personal use. `tools/fetch-map-data.ts` downloads the manifests and the chunks under each playable
area (about 260 MB for the three maps) into `local-data/terrain/<map-id>/`, from the calculator's hosting under
`https://assets.wardogs-artillery.com/releases/assets-v1/data/terrain/`. The dev and preview servers serve
`local-data/` at `/local-data/`, and the build leaves it out. The map picker in Coordinates (`settings.map`) already
exists for the map imagery, so the solver can use the same setting.

## Tests

`tests/unit/terrain.test.ts` covers these points:

1. The synthetic scene takes a ground function (`makeScene({ ground })`) for the gun, the crater and the camera.
2. A 3 x 3 chunk decodes to meters and interpolates between samples.
3. On a slope of 5 m per 100 m, the solve with terrain heights puts the gun within 2 m, and flat ground misses by more
   than 20 m (a scratch run: 73 m for the L52, 39 m for the L81).

Open: a benchmark row that measures the flat-ground error on real map terrain.

## Open questions

- Whether the datasets cover the whole playable area of each map. The manifests list their coverage.
- Whether WARDOGS has more maps, which would need datasets the calculator does not have yet.
