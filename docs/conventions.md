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
src/lib/workers/       solver.worker.ts, detect.worker.ts (the detection), vision.worker.ts (its pool)
src/lib/vision/        the automatic detection: decode, stabilize, lines, heading, shell, gpu, impact, minimap,
                       pipeline, pool, profile
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

The app has no landmarks. Each sighting gets its camera from the detection of its section (automatic heading, pitch
and roll), from vertical edges (pitch) and the compass heading, or from values the user types.

## Positions, heights and time

- **Automatic values.** Every value that Backtrack can detect is a `Field` (`src/lib/solver/field.ts`, automation
  plan section 2): the user's value (`manual`), and the detector's value with its sigma and a confidence (`auto`).
  The user's value wins. An automatic value counts when its confidence is at least 50 percent; the confidence is 50
  percent at the sigma limit of its kind. A user's value that differs from a confident automatic one by more than
  3 sigma and a minimum per kind gets a warning. `FieldTag.svelte` shows the state (auto with the percent, required
  with the reason, manual, differs) and a button back to the automatic value; `AutoNum.svelte` is a number field with
  it. The shell mark draws in a color per state (`SHELL_COLORS` in `draw.ts`). Fields: heading, pitch, roll and
  shell of a sighting, the impact and where the user stood of a shot in each clip, the crater, the map of a clip.
  The Monte Carlo runs take the sigma of an automatic value, and the accuracy of the settings for the user's values.
- **Position.** Where the user stood during the flight of a shot comes from the minimap (`observer`, a field per
  clip; typed or picked on a map in Coordinates). Every ray starts at eye height above the crater, and for each
  candidate flight `observerShift` (`src/lib/solver/ballisticFit.ts`) finds the ground shift of the user in each
  clip by least squares on the misses in meters, every ray alike, and less along the path of the shell where its
  frame time error moves it (a weight per ray by its own miss in meters trusted the near rays too much: the gun error
  of the benchmark with 30 ms frame time errors went from 13 to 48 m). The minimap position is not
  fixed: it pulls the shift toward itself with its error (10 m for a typed position, or the sigma of the automatic
  one) plus the error of the crater, and a solved spot more than 3 of those and 10 m away gets a note. A 30 m shift
  that the solver ignored would move an L52 gun by about 100 m. With the shift, exact data gives the gun within 2 m.
  A user who walks during the flight: the detection gives each sighting its offset from where the user was at the
  impact (`walkM`, from the minimap of each frame, see Automatic detection), and each ray starts there. The shift
  is then where the user was at the impact.
- **Crater.** The user gives each crater as X and Y, typed or clicked on a map of game coordinates
  (`CraterMap.svelte`), or as a rangefinder reading: where the user stood then, the compass heading and the distance
  as the game shows it (`craterGame` in `src/lib/solver/sightings.ts`). Without a crater, where the user stood is
  enough: the rays start there, and the crater is that spot minus the solved shift (`crater` of a shot result, with
  the spread of the shift and the minimap error as its error). On exact synthetic data it lands within 3 m.
- **Zoom.** A sighting of a frame seen through binoculars or a scope has a zoom: its field of view is the game FOV
  divided by the zoom, so the focal length is that many times longer. An optional suspected heading (the compass heading from the crater toward the gun) with a
  tolerance limits the direction search to that window. The coarse search keeps the least cost of each direction:
  when a second minimum at least 15 deg away costs less than twice the best one (or than 0.1 deg per ray), the result
  names both directions and the suspected heading becomes required (`secondMinimum`).
- **Camera.** A sighting has a heading, a pitch and a roll. The pitch the user typed wins, then the pitch of the
  marked edges, then the automatic pitch. Without a roll the camera is level. `cameraAxes` in `camera.ts` turns them
  into axes; a positive roll turns the right axis toward up.
- **Impact.** The user marks the first frame that shows the impact. The impact lies between the frame before it and
  that frame, the solver takes the middle, and the Monte Carlo runs draw it anywhere in that interval.
- **Clip files.** A clip downloads as its video plus `<video name>.backtrack.json` when it has marks. The upload takes
  both back: an annotation file joins the video of the same file name, or a clip with the name it records
  (`src/lib/capture/annotation.ts`, `clipFiles.ts`). The file is version 2, with every field as stored, and the map of
  the clip. The app reads only this version, and a saved project of another version (`DATA_VERSION`) does not load:
  Backtrack is still in development. `bun scripts/solve-clip.ts <file>` solves a file as the app does.
- **Map data.** `bun tools/fetch-map-data.ts` downloads the color map tiles (zoom 0 to 6) and the terrain chunks of
  Bakurani, Ozeti and Zestafona from the wardogs-calculator hosting into `local-data/` (about 920 MB).
  `local-data/` is committed, the dev and preview servers serve it at `/local-data/` (`vite.config.ts`), and the
  build leaves it out. `src/lib/map/tiles.svelte.ts` draws the tiles under the crater map and the result map. Each
  clip has its map (`project.clips[id].map`): the Mark phase asks for it when a clip without one opens, the header
  changes it, and the solver takes the terrain of the map of the clip it solves. The select at the bottom left of a map
  panel shows another map in that panel only (`ui.mapShown`).
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
  Each miss counts in units of the error of its ray (automation plan section 12.5), against the median ray, split
  into the part across the path of the shell (the mark and the camera) and the part along it (also the frame time
  error times the speed of the shell in the image): a frame time moves a mark only along the path. The frame time
  error of each clip comes from its marks (`frameTiming` in `result.ts`): the jitter of each mark along the path
  against a quadratic through its 6 neighbors, over the speed, for marks faster than 3 deg/s, as a robust sigma
  (3 to 80 ms; 15 ms, `TIMESTAMP_SIGMA_S`, when a clip has too few). On synthetic runs it reads 13 to 20 ms for a
  true 10 ms and 25 to 62 ms for 30 ms, which is close enough for a weight.
- **Fit error.** The result shows the RMS miss of the rays in meters and in degrees. The "fit error is high" note only
  counts the angle beyond what a 10 m miss explains (`MODEL_M` in `ballisticFit.ts`): the shell is only 30 to 200 m
  away in the last frames, so a few meters of position or model error are several degrees there. On the test clip
  (misses of 4 to 5 m, 4.8 and 1.7 deg RMS) this excess is 0. A wrong FOV hardly shows in either number there,
  because the observer shift and the elevation absorb it.
- **Guide text.** Explanations go into tooltips (`title`) or an Info popover, not into the page. Notes in the page are
  for what is missing or wrong, and values show as label and value fields.
- **Heights.** The user enters no heights. With a map picked, the solver worker takes the ground heights of the
  craters and the guns from the terrain (`src/lib/terrain/`, `docs/terrain-plan.md`). Without a map,
  or outside the terrain data, the ground is flat at height 0. The camera sits `EYE_HEIGHT_M` (1.7 m) above the
  ground where the user stood: at the minimap position, or at the solved spot, refined over the rounds like the gun
  (`terrainHeights`). A user on a 15 m roof taken at the height of the crater put the gun 20 m off on synthetic data.
  Without a minimap position a small roof is not found: at the crater height the solve puts the user 40 m off it.
  The eye height is not solved: the rays hardly tell it apart from the flight.
- **Time.** Recordings have no fixed frame rate. On import, `prepareClip` (`src/lib/video/prepareClip.ts`, with
  mediabunny) lists the presentation time of every frame, and remuxes WebM files so they carry a seek index and a
  duration. Without the index, Firefox reports a wrong duration and stalls about 2 s before playing after a seek.
  Frame steps and thumbnails use the frame list (`src/lib/video/frames.ts`), and sightings store frame start times.
  The solver works with these times, never with frame counts. The timeline shows one thumbnail per 2 s of video.
- **Video.** The Mark phase shows the <video> element itself, with the marks on a transparent canvas above it.
  Chrome stops decoding a playing video that is not on the page.

## Automatic detection

`docs/automation-plan.md` is the specification; this section records how the app does it and what the test clips
gave. The user selects where a shell flies on the ruler of the timeline and presses Detect (D). The detection worker
(`src/lib/workers/detect.worker.ts`) decodes the frames from half a second before the section to 1.2 s after it
(`src/lib/vision/decode.ts`, mediabunny and WebCodecs), runs `detectSection` (`src/lib/vision/pipeline.ts`) and
answers with a `Section`. `applySection` (`src/lib/state/sections.ts`) writes it into the project: a sighting per
shell mark with automatic fields, the camera of every sighting of the shot in the section (the reference camera
turned by the rotation of the frame, with the section as the error group of the Monte Carlo runs), the impact, where
the user stood and the map. A new run keeps what the user did and drops the automatic sightings it no longer finds.
The Mark phase shows the section in the Detection card (its camera can be overridden there for all frames at once),
the section and its left-out frames in the lane of the shot, and the stabilized view (Video, Stabilized, Both: a
WebGL warp of the video into the reference camera with the shell track, the pitch lines and the impact point). The
pitch lines also show dashed in the video.

- **Frames.** The gray of a frame is the luma of the video in full range: the Y plane where the decoder gives I420
  (Chrome), else the RGB of the browser (Firefox gives BGRX) with the luma weights of the color matrix of the video
  (BT.709 for the test clips), which gives the same Y back. With the BT.601 weights, Firefox lost the far part of a
  shell track. The compass and minimap crops go through a canvas, as `compassRead.ts` does.
- **Stabilization** (`stabilize.ts`). OpenCV.js has no SIFT, so ORB (4000 features at half size) finds the matches,
  a RANSAC over rotations finds up to three models, and the world is the model highest in the frame among those with
  at least 30 percent of the matches (the prototype rule; "closest to the neighbor frame" picked the hands during a
  fast turn). Lucas-Kanade moves the world points to subpixel positions for the final fit. HUD points (still in frames
  where the world turns) leave the features for a second pass. A frame with fewer than 150 direct inliers also chains
  through its nearest good neighbor. A frame is good with 50 inliers and a rotation known to 0.1 px (fit over the root
  of the inliers): the 1 px fit error of the plan dropped good 4K frames of 300 inliers and 1.2 px. The reference is
  the frame of the section (not of the frames around it) with the most features. Results: clip 2 static at a fit of
  0.1 px; clip 1 shot 2 up to 0.9 deg during the flight at 0.5 to 0.7 px; clip 1 shot 1 the 17.6 deg tilt before the
  flight, static during it.
- **Pitch and roll** (`lines.ts`). OpenCV.js has no LSD. The peaks of the horizontal gradient at half size link from
  row to row into near-vertical chains (a line detector for vertical lines only), and each chain is refined at full
  size from the subpixel gradient peaks along it. The game camera does not roll: the fit without roll (each line gives
  a pitch, tan p = n_y / n_z, and the pitch most line length agrees with wins) comes first, and the fit with a roll
  only wins with 30 percent more line length. With a free roll, crane arms and train sides pulled clip 2 to 17.9 deg
  and 1 deg of roll. Results: clip 2 16.73 +/-0.02 deg (plan 16.45, user edges 15.89); clip 1 shot 2 24.00 +/-0.07
  (plan 24.77, user edges 23.65 to 24.31); clip 1 shot 1 20.90 +/-0.33, too unsure to count, as the plan expects.
- **Heading** (`heading.ts`). The compass readings of all frames with a good camera, each with the yaw of its frame,
  give intervals for the reference heading; the band most readings cover wins. The game truncates the heading
  (`ROUNDING`): the label strip reads 0.27 to 0.29 deg above the truncated fusion on clip 2 and clip 1 shot 2, and
  0.77 to 0.79 above the rounded one. Clip 1 shot 2 196.63 +/-0.06 deg; clip 1 shot 1 136.74 +/-0.09; clip 2
  208.50 +/-0.29 (one display value in the whole section, so 53 percent sure).
- **Shell** (`shell.ts`, `gpu.ts`). A.3 at full size: the median background of all warped frames, the dark blobs
  with the penalties for large moving areas and texture, candidates with a subpixel peak, linking frame by frame.
  Changes to A.3: HUD and screen overlays (an FPS counter) that stand still while the camera turns are masked (they
  move in the warp); candidates within 12 px of a point of the viewmodel model of the stabilization drop out; a step
  of less than 4 px has no direction, and a short step gets room for its half pixel of position error (whole pixels
  broke the track in Firefox); the first and last two steps of a track are checked against the speed trend of their
  neighbors, and the marks past a jump stay in the track (for the impact) but give no sighting ("the frame time is
  probably off", the plan's dropped frames); a faint mark (score below 15) and a frame without a good camera give no
  sighting either. The marks are stored in the pixels of the app (centers at .5). Results against the user's marks:
  clip 2 13 marks, 0.8 px mean; clip 1 shot 2 22 marks, 1.0 px; clip 1 shot 1 7 marks, 5 of 7 within 5 px (the frame
  timing problem). A search at half size was 4 times faster but lost the far shell of clip 1 shot 2.
- **Impact** (`impact.ts`). From the track, not the crater (the crater is often hidden): a parabola through the last
  three marks, and the first frame after the last mark in which more than 5 percent of a square of +/-250 px (2160p)
  around that path changed by more than 25 gray values, with the frame before it below 2 percent. Clip 1 shot 1
  39.977 to 40.064 s and shot 2 26.026 to 26.112 s (both as the plan); clip 2 lands out of view, so the impact is
  required there.
- **Minimap** (`minimap.ts`). As A.6, with the measured zoom levels (`MINIMAP_LEVELS`: Bakurani 0.196, 0.349, 0.782 and
  2.64 m/px from `recording-test-clips/minimap/`, Ozeti 0.505 from clip 1): every map at zoom 4 over the levels, a
  wide range when none matches (not when a clip opens), then zoom 6 near the best. An earlier position of the clip is
  searched first. Clip 2 Bakurani 79.86, 72.99 (0.78 m/px); clip 1 Ozeti 97.48, 65.69 and 97.28, 65.60. When a clip
  without a map opens, the worker looks at half a second from its middle and the question for the map shows the
  result first; the question stays until the user answers.
- **Walking** (`walkPath` in `pipeline.ts`). After the minimap search, up to 16 frames from the section to the impact
  each match their own minimap at the found scale near the found spot (zoom 6, with a subpixel peak), matches that
  stand out less than 2 times are dropped, and a quadratic in time per axis (`smoothPath`, twice, without matches
  3 robust sigmas off) gives the path. A user who moved less than 3 m stood still; otherwise the section keeps the
  path (`walk`), the position becomes the one at the impact, and each sighting gets its offset (`walkM`). The three
  test sections read within 0.3 m of standing; in clip 2 the minimap of one frame does not stand out (1.1 times), so
  it counts as standing. The stabilization models a pure rotation: a walk moves near features (parallax), and 4 m
  moves a feature 500 m away by 0.5 deg against the reference. The model of the highest features and the chains of
  neighbor frames (a few centimeters apart) should carry a slow walk, but no walking clip has checked this or the path.
- **Pictures.** The video in Mark has a Detection overlay (`detectionView` and `drawDetection` in `draw.ts`): the
  horizon of the frame camera with a tick per degree of heading (to hold against the compass of the game), the shell
  track of the section and the impact turned into the frame, the compass and minimap boxes the detection reads with
  what it found, and the rotation of the frame (matches, fit) with what became of its shell mark. The result map has a
  Sightings layer: the line of sight of each sighting from where the user was on its frame to the shell on the fitted
  flight, colored by its miss, the walk, and the minimap position (a hollow triangle). Each shot result charts the miss
  of each sighting along the path of the shell and across it over the time before the impact (`MissChart.svelte`,
  from `ShotResult.sightings`), with the frame time error of the clip: misses along the path that swing together
  mean frame times, a single one far out a bad mark. The Coordinates map shows the walk too.
- **Speed** (plan section 14). The work per frame runs on a pool of workers (`pool.ts`, one per spare core, each
  with its own OpenCV): features, the rotation against the reference, the chains, compass readings, minimap scales,
  and the shell in bands of rows when there is no GPU. With WebGPU the shell runs in compute shaders that follow
  OpenCV (kernel sizes, borders, block means, upsampling); the GPU and the CPU give the same marks on all three test
  shots, in Chrome and in Firefox. `profile.ts` times every part. A section of about 50 4K frames: 36.6 s on one
  thread at first, 8.3 s now with the GPU (11 s on the CPU pool), of which about 3 s find the map when none is known.
  OpenCV is one file of the build that each worker fetches; the page never loads it.
- **FOV.** The FOV of the game is a setting of the user, not of a project (`src/lib/state/prefs.svelte.ts`, kept in
  localStorage): the Settings dialog (the FOV button in the header, a modal `<dialog>`) sets it once for every
  project, and the header marks it with a "?" until then. The project copies it (App.svelte), so the solver and the
  annotation files still carry it; an imported file with another FOV earns a note and changes nothing. The detection
  needs it before any mark: with 90 deg instead of 100, the stabilization of clip 1 shot 2 failed (a pure rotation does
  not fit a wrong focal length). An estimate of the FOV from the turns of the camera depended on the FOV it started
  from, so the app has none.
- **Checks.** `node scripts/vision/run.ts "<clip in test-data>" <a> <b> sec=<a>,<b> [map=] [fov=] [gpu=0] [pool=0]
  [pitch=] [v=1] [probe=x,y,r]` runs the pipeline in headless Chromium (the full build, which has WebGPU; `BROWSER=
  firefox` for Firefox) on the dev server, and prints the results, the profile, the marks against the user's, and
  the solve with the crater of the annotation file. `node scripts/vision/app-check.ts` does it through the app.
  `tests/e2e/detect.spec.ts` runs the detection on clip 1 in both browsers (on the CPU: the headless browsers of the
  tests have no WebGPU).
- **Independent model** (`independent.ts`, section 12.6). A straight flight with gravity over the last second, fitted
  with Levenberg-Marquardt from 4 start distances, gives a second direction in the result: clip 2 176.3 deg against
  175.2 of the solver (plan 176 to 177), clip 1 shot 2 188.9 against 190.4. The result also shows how far the solved
  spot of the user lies from the minimap position (section 13): 21 m on clip 1 shot 2.

## Weapon ballistics

`src/lib/solver/ballistics.ts` models a shell with gravity and quadratic drag, a = -k * |v| * v - g, integrated with
RK4 in 0.01 s steps. The parameters are community estimates, not published by Bulkhead.

| Weapon | Launch speed | Drag k | Elevation | Source and check |
|---|---|---|---|---|
| L52 | 300 m/s | 4.807e-4 | -3 to 65 deg | Speed from the WARDOGS wiki. k matches the 2629 m maximum range. The flight times at 2000 m (11.6 s and 33.8 s) match the published 12.3 s and 33 s. |
| L81 | 96.6 m/s | 5.429e-4 | 45 to 85 deg | Speed from the WARDOGS wiki. k matches the 691 m maximum range at 45 deg. The flight time at 400 m (16.9 s) matches the published 17.4 s. |

Without a weapon picked, the solver solves every shot with each weapon table and takes the weapon whose RMS fit error
is clearly lower (`pickWeapon` in `result.ts`, 50 percent sure at twice the error of the other weapon; errors below
0.02 deg count as 0.02). The test clips: clip 2 L52 0.08 deg against L81 1.2 deg; clip 1 4.6 against 7.3 deg, unsure,
because shot 1 has the frame timing problem. The user's pick wins, with a warning when it differs from a sure one.

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
