# Conventions

This document records the toolchain, folder layout, state pattern and visual style of Backtrack, and
where each one comes from. It covers Phase 0 of `plan.md`. The requirements stay in `plan.md`, and the
accuracy numbers stay in `docs/benchmark.md`.

## Toolchain

Backtrack takes its toolchain from `../terra-lab`. Each row compares the two projects.

| | terra-lab | Backtrack |
|---|---|---|
| Runtime and package manager | Bun 1.3 (`bun install`, `bun run ...`) | Same. Commands use `bunx`, never `npx`. |
| Bundler | Plain Vite 8 with `@sveltejs/vite-plugin-svelte`, without SvelteKit | Same (`vite.config.ts`), with the dev server on port 5175 |
| UI | Svelte 5 with runes | Same, with `<script lang="ts">` |
| Language | JavaScript | TypeScript in `strict` mode (plan section 2). TypeScript stays on version 6, because svelte-check does not run on TypeScript 7 alone yet. |
| CSS | Tailwind 4 through `@tailwindcss/vite`, with tokens in `@theme` in `src/app.css` | Same setup. The style itself comes from pi.dev (see Visual style). |
| Icons | `@lucide/svelte` | Same |
| Fonts | `@fontsource/inter`, `@fontsource/jetbrains-mono` | `@fontsource/commit-mono`, and VG5000 and Archivo Black in `src/fonts/` |
| Unit tests | `bun test` (`bun:test`) | Same, in `tests/unit`. The plan names Vitest, but the terra-lab runner won. The tests use plain `describe`, `test` and `expect`, so a move to Vitest changes only the imports. |
| E2E tests | - | Playwright with Chromium (`bun run e2e`) |
| Lint and format | - | - (`svelte-check` is the static check) |
| CI | `.github/workflows/deploy.yml` runs `bun run check`, then `bun run build` for GitHub Pages with `BASE_PATH` | Same workflow |

### Scripts

```sh
bun run dev        # http://localhost:5175
bun run check      # svelte-check (types) and the unit tests, as in CI
bun run test       # unit tests only
bun run bench      # accuracy benchmark, writes docs/benchmark.md
bun run e2e        # Playwright: the record tests and the full synthetic run (about 1 min)
bun run build      # writes dist/
```

## Folders and names

terra-lab keeps its logic in `src/lib/` (`*.js`, with `*.svelte.js` for rune state), its components flat in
`src/components/` (PascalCase `.svelte`), and its tests in `test/`. Backtrack uses the folder layout of plan
section 4 with the same naming.

```
src/lib/solver/        TypeScript without DOM access: camera, ballistics, solve, montecarlo, tracks,
                       sightings (sighting -> ray and warnings), result (project -> results)
src/lib/capture/       rollingRecorder, importClip, clipFiles (video and .backtrack.json download and import)
src/lib/video/         frameStepper, webmDuration
src/lib/state/         project.svelte.ts (runes), persistence.ts (IndexedDB with idb), missing.ts, theme.svelte.ts
src/lib/workers/       solver.worker.ts
src/components/        shared pieces (NumInput, Info)
src/components/phases/ RecordPhase, MarkPhase, CoordinatesPhase, ResultPhase
src/components/mark/   Viewer, Magnifier, Timeline, MarkToolbar, SightingList, draw.ts
src/components/result/ ResultMap, ShotResult, CopyButton
src/fonts/             VG5000 and Archivo Black, with their license note
tests/unit/            bun test
tests/synthetic/       scene generator and benchmark
tests/e2e/             Playwright
```

- File names are `camelCase.ts` and `PascalCase.svelte`. Rune modules end in `.svelte.ts`.
- Imports include the `.ts` extension. Bun and Vite both resolve it, and `allowImportingTsExtensions` allows it.
- Each module starts with a `/** ... */` header. Comments say why, not what.

## State

terra-lab exports one `$state` object (`ui`) from `lib/state.svelte.js`. Components change it in place, and an
`$effect` in `App.svelte` saves it. Large data that nothing changes field by field goes in `$state.raw`. Worker
messages carry `$state.snapshot` copies, because postMessage cannot clone proxies. A token drops answers to old
questions.

Backtrack uses the same pattern. `lib/state/project.svelte.ts` exports `project`, `ui` and `clips`, and components
change them in place. `App.svelte` saves a snapshot to IndexedDB 250 ms after the last change. The solver result is
`$state.raw`. The solver worker uses the token pattern of terra-lab, and the app solves on the main thread when the
worker fails. The delete functions (`deleteShot`, `forgetClip` and the others) sit next to the state, and each one
also removes the sightings and impact marks that point at the deleted item.

## Visual style

The look follows the model pages of https://pi.dev, not terra-lab. `src/app.css` holds it.

- **Palette.** The pi.dev tokens are runtime CSS variables (`--bg`, `--panel`, `--line`, `--text`, `--muted`,
  `--accent` and others). The dark set is the default, and `[data-theme='light']` holds the light set.
  `@theme inline` maps the variables to Tailwind utilities (`text-muted`, `bg-panel`, `border-line`, `text-accent`),
  so the utilities follow the theme.
- **Theme.** The theme is system, dark or light, and a button in the top bar switches it
  (`lib/state/theme.svelte.ts`). `index.html` applies the saved choice before the first paint. The canvases redraw
  when `theme.current` changes.
- **Type.** Commit Mono sets body text and numbers. VG5000 sets small text: `.label`, buttons, tabs, tags, table
  heads, `dt` and card meta (`font-small` utility). Archivo Black sets big and header text: `.title`, `.card-title`
  and `.big` (`font-display` utility). Both fonts come from the system fonts, the app serves them from
  `src/fonts/`, and both use the SIL OFL 1.1 (`src/fonts/README.md`).
- **Surfaces.** The page background is graph paper. Panels are square with a 1 px border (`.card`, `.card-head`,
  `.card-title`, `.card-body`), without rounded corners or shadows.
- **Controls.** Buttons show `[ BRACKETS ]` (`.btn`, `.btn.primary`, `.btn.icon`, `.btn.sm`). Selectable boxes use
  `.option` with `aria-pressed`. `.control` styles inputs and selects. The phase bar (`.phasebar`, `.tab`) shows the four phases
  with arrows between them. The active tab gets an accent bar, and a locked tab is disabled with a dashed border.
- **Data.** `.dl` is a label and value grid. The other data classes are `.table`, `.tag`, `.note` (a status line
  with a colored left stripe, as `ok`, `warn`, `bad` or `info`), `.disclosure`, and `.info` with `.pop` for popovers.
- **Phase gating.** `openPhases` in `lib/state/missing.ts` decides which phases are open. A phase opens when every
  phase before it has nothing missing, and a step back is always possible. Every clip with sightings needs an impact
  mark, because the solver places each sighting on the flight by its time before impact. A saved project reopens on
  the furthest open phase.
- **Mark phase.** The Shell and Vertical edge tools sit in a large panel above the video, as the main entry
  point of the phase. A press on a mark drags it, in the video and in the magnifier. The timeline works like a video
  editor for the loaded clip: a ruler with ticks (each frame when zoomed in), a film strip with one thumbnail per 2 s,
  and one lane per shot with its sightings as keyframes and its impact. The wheel zooms, Shift and the wheel pan, and
  a drag on the ruler selects a section that playback repeats (cleared by a double click on it, a right click on the
  ruler, its x button or Alt+X, and when another clip loads). A press on a lane picks its shot. Up and Down jump to the previous or next
  sighting of the shot.
  The film strip tiles thumbnails at their own width, so a deep zoom repeats the nearest picture instead of stretching
  it, and a resting view fetches the frames of its tiles. The wheel over the video zooms into it, and a right drag
  pans. A middle click locks the magnifier on a spot, and its arrows move the spot in steps of 0.75 video
  pixels (7.5 with Shift). Labels next to the marks show each edge with its ends, pitch and warnings, and the shell
  with its azimuth, elevation and problems (`markNotes` in `src/components/mark/draw.ts`).
- **Layout.** The app fills the viewport (`h-dvh`) with a thin top bar. Each phase uses the full width and height,
  and the video viewer and the result map fit themselves to their space.
- **Marks.** Marks over the video use fixed bright colors, because they sit on game footage. The map uses
  `--shell`, `--edge`, `--impact` and `--gun` from the theme.

## Writing style

All English text follows `../../rust/horizonslauncher/plan/docs/writing-style.md`. The text is ASCII only, so units
read `deg` and `+/-` instead of the symbols. `plan.md` and `poc/` keep their original text.

## Open questions from plan section 11

- **SvelteKit or plain Vite.** Backtrack uses plain Vite, as terra-lab does.
- **Map.** The map is a plain canvas with a grid in game units. A map image under it is open.
- **Horizontal edges as a heading source.** This is open. The compass heading is the only heading source, and the
  benchmark shows that its errors dominate.

## Camera and minimum sightings

The app has no landmarks. Each sighting gets its camera from vertical edges (pitch) and the typed compass heading
(heading), or copies the camera of an earlier sighting.

## Positions, heights and time

- **Position.** A sighting can take where the user stood from the minimap (`position`, typed or picked on a map); a
  sighting that copies the previous camera copies it too, and its ray starts there. Otherwise the user enters no
  position of their own. They stand near the crater and walk to it after the
  impact. Every ray starts at eye height above the crater, and for each candidate flight `observerShift`
  (`src/lib/solver/ballisticFit.ts`) finds the ground shift of the user in each clip by least squares. A 30 m shift
  that the solver ignored would move an L52 gun by about 100 m. With the shift, exact data gives the gun within 2 m.
  The app assumes that the user did not move during the clip.
- **Crater.** The user gives each crater as X and Y, typed or clicked on a map of game coordinates
  (`CraterMap.svelte`), or as a rangefinder reading: where the user stood then, the compass heading and the distance
  as the game shows it (`craterGame` in `src/lib/solver/sightings.ts`).
- **Zoom.** A sighting of a frame seen through binoculars or a scope has a zoom: its field of view is the game FOV
  divided by the zoom, so the focal length is that many times longer. An optional suspected heading (the compass heading from the crater toward the gun) with a
  tolerance limits the direction search to that window.
- **Clip files.** A clip downloads as its video plus `<video name>.backtrack.json` when it has marks. The upload takes
  both back: an annotation file joins the video of the same file name, or a clip with the name it records
  (`src/lib/capture/annotation.ts`, `clipFiles.ts`).
- **Map data.** `bun tools/fetch-map-data.ts` downloads the color map tiles (zoom 0 to 6) and the terrain chunks of
  Bakurani, Ozeti and Zestafona from the wardogs-calculator hosting into `local-data/` (about 850 MB, personal use).
  `local-data/` is git-ignored, the dev and preview servers serve it at `/local-data/` (`vite.config.ts`), and the
  build leaves it out. `src/lib/map/tiles.svelte.ts` draws the tiles under the crater map and the result map, for the
  map in `settings.map`.
- **Topography.** `bun tools/make-topo.ts [map ...]` renders shaded relief with height tints and contour lines from the
  calculator terrain into `local-data/topo/<id>/<z>/<x>_<y>.png`, zoom 0 to 5 (about 2 m per pixel), in the same
  pyramid as the color tiles. It takes about 12 s and 30 to 60 MB per map. Every map offers Color, Gray and Topo
  imagery and an opacity (35% by default) at its bottom right, kept in this browser (`tiles` in
  `src/lib/map/tiles.svelte.ts`).
- **Terrain analysis.** With terrain data, the worker preloads the chunks around each crater and gives the solver a
  synchronous ground (`Terrain.heightNow`). `fitBallistic` rejects a candidate flight that runs more than 3 m into
  the ground between gun and crater, launched from the ground at that candidate's own gun (launched from the gun
  height of the last round instead, a candidate gun on higher ground started under the ground and the check threw out
  the right flights: on the test clip on Ozeti that put shot 1 1.2 km off and split the shots into two guns). The result map shades
  ground steeper than 15 deg around the possible guns (`slopeGrid`), and shows where the gun can hit
  (`reach` in `src/lib/terrain/analysis.ts`): a fan of flights every 0.4 deg of direction and 0.1 deg of elevation
  over the terrain, which marks ground out of reach and ground that only the high arc reaches. It takes about 1 s and comes
  in a second worker message. The terrain has no buildings or trees.
- **Result.** `src/lib/state/solve.svelte.ts` holds the one result of the app. It solves in the worker only when the
  inputs of the solver change (the settings without the recording ones, the shots, the sightings), so opening the
  result again costs nothing. The Result phase and "Split with result" (next to Mark and Coordinates) read it. An eye
  on a sighting or a shot leaves it out of the calculation (`excluded`), to test what it changes; left out parts do not
  count for the phase gating. The Monte Carlo runs search only within 5 deg of the direction and elevation of the
  exact fit, which makes a solve about 2.5 times faster (about 150 ms per shot without terrain).
  The result map draws the weapon range (the minimum and maximum range of the settings) as two labeled circles around
  the expected gun: the combined gun of all shots, or the gun of the first solved shot. A shot is hard to make when the
  gap between flight and ground, seen from the nearer end, is under 0.3 deg anywhere outside the first and last
  10 percent of the flight (at least 100 m).
- **Shortcuts.** `Key.svelte` shows a shortcut as key caps next to its control (a tint of the text color, so a cap is
  brighter than its ground in dark mode and darker in light mode). Mark: S shell, V edge, I impact, Esc leaves a tool,
  Space plays, Left and Right step a frame (Shift: 10), Up and Down jump between sightings, L locks the magnifier, Z
  changes its zoom, and Ctrl with the arrows moves a locked spot. Everywhere outside a text field: Ctrl+Z undoes and
  Ctrl+Shift+Z or Ctrl+Y redoes (`src/lib/state/history.svelte.ts`, 100 steps of the project data; edits within
  600 ms make one step; deleting a clip clears the history).
- **Shell motion.** `src/lib/solver/motion.ts` measures the angular speed of the shell between consecutive sightings
  of a shot in a clip, and warns where a step is more than 2.2 times faster or slower than its neighbors predict,
  beyond the mark and compass errors. Only steps up to 0.3 s count, because over longer steps the speed changes a lot on
  its own. The trends leave out the steps flagged so far (repeated until the flags settle), so one broken step does not
  get its neighbors flagged, and the warning goes on the sighting the step leads to, the frame that shows the jump.
  Such a jump means the recording skipped or repeated frames, so the frame times are off. On synthetic runs
  of close frames it warned for 1 of 200 clean runs and for every stall of 0.25 s; on the test clip it found the stall
  at 39.8 s.
- **Edge warnings.** `edgeReport` (`src/lib/solver/camera.ts`) gives each edge its pitch and error. An edge only
  counts as wrong when it differs from the mean of the others by more than 3 standard deviations of both errors plus
  0.3 deg for corners that are not quite vertical; the pitch then leaves it out. One warning per sighting says when
  all edges together give the pitch worse than +/-0.3 deg.
- **Compass reader.** `src/lib/video/compass.ts` reads the heading from the compass box at the top middle of a frame
  (180 x 70 px at 2160p, scaled with the frame height). Each digit becomes three grids of 10 x 16 features: its edges,
  its dark ring (how much darker a pixel is than the brightest pixel near it: the outline of the white digits, on sky
  and on dark ground alike, which video compression leaves standing) and its white fill (the other way round, which
  shows the gaps that tell 6, 8, 9 and 0 apart). It compares them with a template per digit and walks from the left
  edge of the number with the width of each digit (the font is proportional), trying small shifts. The direction
  letters after the number (N, NE, ... NW, right-aligned, one per 45 deg sector) have templates too: a reading must lie
  in the sector the letters show, which rules out a reading one digit off (127 for 327 or 299). It only answers when
  it is sure: in `bun tools/make-compass-templates.ts` (templates and digit widths from the 180 frames of
  `tools/compass-labels.json`, tested in 5 folds, each frame by templates made without it) it read 156 right, 2
  wrong and 22 not. The tool also prints how the lead limit trades readings against mistakes: 0.02 read 12 frames
  more than 0.03 with no more mistakes, 0.01 read 5 more with 3 more mistakes. Edges alone gave 93 right and 4 wrong. Reading a frame together with its neighbors (the mean of
  their channels) did not help: the frames the reader misses come from a turning camera, where the heading changes
  from frame to frame, and a mean of 259, 260 and 259 read 259 for the frame that shows 260. A reading takes about 40 ms at 4K, so the toolbar of the Mark
  phase reads the frame on screen only after it is painted, not during playback or a seek, and a new sighting takes
  the reading as its heading once. A failed reading goes to the console with the reader's guess. The app needs no
  ffmpeg: it reads frames with a canvas. The frames ffmpeg cuts at a time can differ by one from the frame the app
  shows at that time, so labels come from crops cut the way the tool cuts them.
- **Robust fit.** `fitBallistic` picks the flight with the least robust cost (Cauchy, scale 0.3 deg): a miss up to
  about 0.3 deg counts like a square, a larger one only with its logarithm, so a sighting whose frame time is off (a
  skipped frame) cannot pull the flight toward itself. On synthetic data with mark and compass errors it is as
  accurate as squares; on the test clip it moved the gun of shot 1 from 88.6, 47.7 to 92.9, 46.7 with all sightings,
  next to the 93.8, 45.6 of shot 2, so the two shots now make one gun. The reported fit error stays the RMS.
- **Fit error.** The result shows the RMS miss of the rays in meters and in degrees. The "fit error is high" note only
  counts the angle beyond what a 10 m miss explains (`MODEL_M` in `ballisticFit.ts`): the shell is only 30 to 200 m
  away in the last frames, so a few meters of position or model error are several degrees there. On the test clip
  (misses of 4 to 5 m, 4.8 and 1.7 deg RMS) this excess is 0. A wrong FOV hardly shows in either number there,
  because the observer shift and the elevation absorb it.
- **Guide text.** Explanations go into tooltips (`title`) or an Info popover, not into the page. Notes in the page are
  for what is missing or wrong, and values show as label and value fields.
- **Heights.** The user enters no heights. With a map picked, the solver worker takes the ground heights of the
  craters and the guns from the terrain (`src/lib/terrain/`, `docs/terrain-plan.md`). Without a map,
  or outside the terrain data, the ground is flat at height 0. The camera sits `EYE_HEIGHT_M` (1.7 m) above the crater.
- **Time.** Recordings have no fixed frame rate. On import, `prepareClip` (`src/lib/video/prepareClip.ts`, with
  mediabunny) lists the presentation time of every frame, and remuxes WebM files so they carry a seek index and a
  duration. Without the index, Firefox reports a wrong duration and stalls about 2 s before playing after a seek.
  Frame steps and thumbnails use the frame list (`src/lib/video/frames.ts`), and sightings store frame start times.
  The solver works with these times, never with frame counts. The timeline shows one thumbnail per 2 s of video.
- **Video.** The Mark phase shows the <video> element itself, with the marks on a transparent canvas above it.
  Chrome stops decoding a playing video that is not on the page.

## Weapon ballistics

`src/lib/solver/ballistics.ts` models a shell with gravity and quadratic drag, a = -k * |v| * v - g, integrated with
RK4 in 0.01 s steps. The parameters are community estimates, not published by Bulkhead.

| Weapon | Launch speed | Drag k | Elevation | Source and check |
|---|---|---|---|---|
| L52 | 300 m/s | 4.807e-4 | -3 to 65 deg | Speed from the WARDOGS wiki. k matches the 2629 m maximum range. The flight times at 2000 m (11.6 s and 33.8 s) match the published 12.3 s and 33 s. |
| L81 | 96.6 m/s | 5.429e-4 | 45 to 85 deg | Speed from the WARDOGS wiki. k matches the 691 m maximum range at 45 deg. The flight time at 400 m (16.9 s) matches the published 17.4 s. |

`fitBallistic` (`src/lib/solver/ballisticFit.ts`) searches two unknowns: the direction from the crater and the launch
elevation. They fix the gun position and the whole flight, and the shift of the user follows from them. The search
runs coarse to fine over a table of flights in 0.5 deg elevation steps. A shot needs 2 sightings, each with the impact
time of its clip.

Shots group into guns in `groupGuns` (`src/lib/solver/result.ts`): a shot joins the gun it agrees with (within 6
standard deviations of their combined Monte Carlo spread, or 300 m without Monte Carlo runs), or starts a new one, so
shots that do not agree count as more than one gun. Each gun gets its own range circles and out-of-reach zones. The
shots of one gun combine as follows. Each gun estimate counts with the
inverse covariance of its Monte Carlo cloud, so a shot adds what it knows well (its direction) more than what it knows
less well (its range). In a synthetic test with 3 shots 40 deg apart, the median error went from 18 m for one shot
to 11 m combined, where the crossing of the tracks alone gave 39 m. Without Monte Carlo runs, it falls back to the
crossing of the tracks.

The app has no custom weapon. Its generic path models intersected the rays with the flight plane, and rays that start
at the crater lie in that plane, so the models had nothing to solve. They also missed flights with drag by 400 to
700 m.
