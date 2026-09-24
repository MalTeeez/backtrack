# Accuracy benchmark

`bun run bench` (tests/synthetic/benchmark.ts) generates this file. The camera has a 90 deg FOV, 1280x720 pixels and
60 fps. Each cell summarizes 20 runs with random errors. It shows the **median / 90th percentile** gun error in
meters, over the runs that gave a result.

## L52

The gun is 2000 m from the crater and fires at 300 m/s with drag (low arc). The observer stands 40 m from the crater, and the solver finds where.

| Errors | 2 sightings | 5 sightings | 15 sightings | 40 sightings |
|---|---|---|---|---|
| Shell marks +/-1 px | 5 / 10 | 3 / 5 | 1 / 3 | 1 / 1 |
| Shell and edge marks +/-1 px | 24 / 48 | 9 / 22 | 5 / 16 | 4 / 16 |
| Shell and edge marks +/-1 px, impact +/-0.5 frame | 27 / 55 | 11 / 32 | 6 / 10 | 5 / 10 |
| Compass +/-0.5 deg per sighting | 14 / 28 | 7 / 24 | 6 / 15 | 4 / 9 |
| Compass +/-0.5 deg, same error for all | 10 / 28 | 16 / 29 | 8 / 33 | 14 / 36 |
| Last 2 s, marks +/-1 px, frame times +/-10 ms | 128 / 823 | 6 / 18 | 3 / 10 | 5 / 10 |
| Last 2 s, marks +/-1 px, frame times +/-30 ms | 153 / 1533 | 33 / 73 | 14 / 24 | 9 / 25 |
| Last 3 s, walking 1.5 m/s, path not known | 13 / 16 | 10 / 14 | 11 / 12 | 10 / 11 |
| Last 3 s, walking 1.5 m/s, path +/-1 m | 17 / 55 | 14 / 23 | 7 / 17 | 4 / 9 |

## L81

The mortar is 400 m from the crater and fires at 96.6 m/s with drag (high arc). The observer stands 30 m from the crater, and the solver finds where.

| Errors | 2 sightings | 5 sightings | 15 sightings | 40 sightings |
|---|---|---|---|---|
| Shell marks +/-1 px | 1 / 2 | 1 / 1 | 0 / 1 | 0 / 1 |
| Shell and edge marks +/-1 px | 5 / 10 | 3 / 8 | 2 / 5 | 1 / 3 |
| Shell and edge marks +/-1 px, impact +/-0.5 frame | 6 / 13 | 3 / 7 | 3 / 6 | 2 / 4 |
| Compass +/-0.5 deg per sighting | 3 / 10 | 1 / 3 | 1 / 2 | 1 / 2 |
| Compass +/-0.5 deg, same error for all | 2 / 7 | 3 / 6 | 3 / 8 | 3 / 7 |
| Last 2 s, marks +/-1 px, frame times +/-10 ms | 392 / 642 | 7 / 17 | 3 / 8 | 2 / 7 |
| Last 2 s, marks +/-1 px, frame times +/-30 ms | 307 / 640 | 17 / 48 | 15 / 40 | 7 / 11 |
| Last 3 s, walking 1.5 m/s, path not known | 648 / 663 | 26 / 28 | 26 / 27 | 26 / 26 |
| Last 3 s, walking 1.5 m/s, path +/-1 m | 609 / 650 | 13 / 29 | 11 / 16 | 7 / 15 |
