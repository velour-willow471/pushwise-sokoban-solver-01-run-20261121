# Pushwise — Sokoban solver

Entry for make.fun's **sokoban-solver-01-run-20261121**: one program
(`main.ts`, Node 22) that answers all 5 instances of a set in one run.

## How it works

Levels are a hallway with independent rooms off it — a box pushed into the
hallway can never return — so the level is split into its rooms and every
room is solved push-optimally on its own; the room optima add up to the
level optimum. Rooms are found by cutting the dead squares of the player's
(hallway) row out of the floor and taking the connected parts that hold
boxes.

Each room is solved with A* over pushes. A state is the sorted box squares
plus the player's reachable region (named by its lowest square). The
heuristic is the minimum-cost assignment of boxes to goals, where the cost
of one box to one goal is its push distance ignoring other boxes (reverse
pull BFS); a single push moves one box one square, so the assignment sum can
drop by at most one per push and is admissible — the first solved state A*
pops is push-optimal.

Two sound prunings: a box may only be pushed onto a live square (one from
which a pull-back from the goals can reach it), and a push that leaves a
frozen 2×2 block of walls and boxes with a box off its goal is refused.

Everything is budgeted by work (state counts), never by the wall clock, so
two runs write the same bytes. If a room's search gives up, the level is
answered with an empty (valid, zero-point) solution rather than an illegal
one.

## Results (practice set, kit scorer)

| instance | pushes | P\* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

Score **1,000,000** (house baseline plain-astar 1.0.0 scores 200,000 on the
same set). Full 5-instance run takes ~0.2 s on one CPU, far inside the
60 s wall budget. Also verified at 1,000,000 on 12 further sets drawn with
the kit's own generator across different seeds.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see LICENSE.
