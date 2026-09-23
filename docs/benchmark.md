# Accuracy benchmark

`bun run bench` (tests/synthetic/benchmark.ts) generates this file. The camera has a 90 deg FOV, 1280x720 pixels and
60 fps. Each cell summarizes 20 runs with random errors. It shows the **median / 90th percentile** gun error in
meters, over the runs that gave a result.

## L52

The gun is 2000 m from the crater and fires at 300 m/s with drag (low arc). The observer stands 40 m from the crater, and the solver finds where.

| Errors | 2 sightings | 5 sightings | 15 sightings | 40 sightings |
|---|---|---|---|---|
| Shell marks +/-1 px | 5 / 10 | 3 / 5 | 1 / 3 | 1 / 1 |
| Shell and edge marks +/-1 px | 24 / 48 | 11 / 20 | 4 / 16 | 4 / 14 |
| Shell and edge marks +/-1 px, impact +/-0.5 frame | 27 / 55 | 11 / 23 | 5 / 11 | 5 / 11 |
| Compass +/-0.5 deg per sighting | 14 / 28 | 7 / 24 | 5 / 15 | 4 / 7 |
| Compass +/-0.5 deg, same error for all | 10 / 28 | 16 / 29 | 8 / 33 | 14 / 36 |

## L81

The mortar is 400 m from the crater and fires at 96.6 m/s with drag (high arc). The observer stands 30 m from the crater, and the solver finds where.

| Errors | 2 sightings | 5 sightings | 15 sightings | 40 sightings |
|---|---|---|---|---|
| Shell marks +/-1 px | 1 / 1 | 1 / 1 | 1 / 1 | 0 / 1 |
| Shell and edge marks +/-1 px | 3 / 8 | 3 / 7 | 3 / 5 | 1 / 3 |
| Shell and edge marks +/-1 px, impact +/-0.5 frame | 3 / 8 | 3 / 7 | 2 / 4 | 2 / 3 |
| Compass +/-0.5 deg per sighting | 2 / 5 | 2 / 4 | 1 / 3 | 1 / 2 |
| Compass +/-0.5 deg, same error for all | 2 / 5 | 3 / 8 | 2 / 7 | 2 / 8 |
