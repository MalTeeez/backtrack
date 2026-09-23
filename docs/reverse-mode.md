# Reverse mode (plan)

This document plans a secondary mode that predicts where the user's own shell lands. The user knows the gun position
and marks the flight in a video, and the app gives the impact point. The gun finder stays the main mode. Nothing here
is built yet. The weapon ballistics and the search it reuses are in `docs/conventions.md` (Weapon ballistics).

## Why

The mode tests the solver without an enemy. The user fires at a spot, records the flight, and compares the predicted
impact with the crater on the map. It also helps when the crater is hard to find on the map.

## Terms

- An *enemy shot* is a shot of the main mode. The crater is known, and the app finds the gun.
- An *own shot* is a shot of the reverse mode. The gun is known, and the app finds the impact point.
- The *launch frame* is the video frame in which the gun fires. The user marks it like the impact frame.

## User flow

The four phases stay the same. Each shot gets a kind, and an enemy shot is the default.

1. Record: nothing changes.
2. Mark: the user sets the shot kind to "own shot" next to the shot picker. The tool panel then offers "Launch frame"
   (key F) next to "Impact frame". The Shell and Vertical edge tools and the compass heading work as before.
3. Coordinates: an own shot asks for the gun X and Y instead of the crater. Heights come from the ground model: flat
   ground today, terrain data later (`docs/terrain-plan.md`).
4. Result: the result shows the predicted impact point, its likely error, the direction and range from the gun, the
   launch elevation and the flight time. The map shows the gun, the track and the Monte Carlo impact points. An
   optional "actual impact" X and Y shows the distance between prediction and crater, so a test needs no arithmetic.

## Data model

The changes extend the types in `src/lib/solver/types.ts`. Old projects load unchanged, because every new field is
optional.

```ts
interface Shot {
  // existing fields
  kind?: 'enemy' | 'own';                        // absent means 'enemy'
  gun?: { x?: number; y?: number };              // own shots only
  launchTimeS?: Record<Id, number>;              // clipId -> seconds. Absent means no launch frame.
  actualImpact?: { x?: number; y?: number };     // own shots only, for the comparison
}
interface Ray {
  // existing fields
  sinceLaunch: number | null;                    // seconds after the launch frame, or null without one
}
```

## Solver

`fitBallisticFromGun` goes next to `fitBallistic` in `src/lib/solver/ballisticFit.ts`. Its unknowns are the
direction from the gun (th) and the launch elevation (e), as in the main mode. The gun position is the fixed end
instead of the crater. It reuses the flight table, the landing cache and the coarse-to-fine search.

For each candidate flight, the shell at time t after launch is at G + x(t) * d, at height zG + z(t), with d the unit
vector along th. The residual of a sighting is the angle between its ray and the direction to that point. Each
sighting needs t, and the cases below say where t comes from. The fit uses only these time residuals. The plane
intersection of the main mode fails here, because a camera at the gun looks along the flight plane.

### Cases

Each row is one combination of the two frame marks. The ground height at the landing point comes from the ground
model: 0 on flat ground, or the terrain height with the iteration of `docs/terrain-plan.md`.

| Launch frame | Impact frame | Time of a sighting | Impact point | Minimum sightings |
|---|---|---|---|---|
| yes | yes | t = time - launch | the flight position at T = impact - launch | 2 |
| yes | no | t = time - launch | where the flight comes down to the ground | 2 |
| no | yes | t = T(e) - (impact - time), with T(e) the landing time on the ground | where the flight comes down to the ground | 2 |
| no | no | - | none. A missing item asks for the launch frame. | - |

The first row needs no ground height, so the Mark phase recommends marking both frames.

### Accuracy

The Monte Carlo runs of `montecarlo.ts` also jitter the launch time by half a frame, once per clip, as they do for the
impact time. A compass error turns the whole track. At 2000 m, 0.5 deg of heading moves the impact about 17 m to the
side. The range comes mostly from the elevation fit, and the elevation depends on the edge marks.

## Tests

1. Extend the synthetic scene (`tests/synthetic/scene.ts`) with a camera near the gun, 5 m to the side and 2 m up,
   and with the launch time in the truth.
2. Add unit tests for the first, second and fourth row of the case table, with exact data for the L52 and the L81.
   Each test expects the impact within 2 m.
3. Add a benchmark section "Own shot from the gun" with the error rows of the main sections.
4. Add an e2e test that records the synthetic own shot, marks the launch and impact frames and 5 sightings, enters
   the gun position, and checks the predicted impact against the truth within 30 m.
5. In the game, fire the L81 at a known map point, record from the gun, and compare the prediction with the crater.

## Open questions

- Where the shot kind lives in the UI: a switch next to the shot picker, or a choice when the user makes a shot.
- A camera at the mortar often shows the zoomed mortar sight. The FOV is one setting for the whole project, so these
  clips need a FOV per clip or per sighting. This question is also open for the main mode.
- Whether the app should find the launch frame from the muzzle flash, or the user always marks it.
