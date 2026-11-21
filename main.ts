// Pushwise — a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// Approach (written from scratch for this entry):
//  * Levels are a hallway with independent rooms off it (a box pushed into the
//    hallway can never return), so each level is split into its rooms and every
//    room is solved push-optimally on its own; the room optima add up to the
//    level optimum. Rooms are found by cutting the dead squares of the
//    player's (hallway) row out of the floor and taking the connected parts
//    that hold boxes.
//  * Each room is solved with A* over pushes. A state is the sorted box
//    squares plus the player's reachable region (named by its lowest square).
//    The heuristic is the minimum-cost assignment of boxes to goals where the
//    cost of one box to one goal is its push distance ignoring other boxes
//    (reverse pull BFS); a single push moves one box one square, so the
//    assignment sum can drop by at most one per push and is admissible, hence
//    the first solved state A* pops is push-optimal.
//  * Two sound prunings: a box may only be pushed onto a live square (one
//    from which a pull-back from the goals can reach it), and a push that
//    leaves a frozen 2x2 block of walls and boxes with a box off its goal is
//    refused. Both prune only states no solution can pass through.
//  * Everything is budgeted by work (state counts), never by the wall clock,
//    so two runs of the program write the same bytes. If a room's search
//    gives up, the level is answered with an empty (valid, zero-point)
//    solution rather than an illegal one, and the other instances still run.
//
// Node 22 runs this file as it is (erasable TypeScript only: no enums, no
// parameter properties, no non-erasable syntax).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The most states one room search may generate before it gives up. The
// generator keeps a room only when a plain push BFS solves it inside 250k
// states, and A* with an admissible heuristic expands a subset of those, so
// this cap is generous headroom, not a hope.
const MAX_STATES = 600_000;

const DIRS: Array<[number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse an XSB level: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can be pulled back onto some goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Push distance from every square to one goal, ignoring other boxes: a box at
 * x can have come from x - d when both x - d and x - 2d are floor (the player
 * stood at x - 2d to push it). -1 where no push sequence reaches the goal.
 */
function pushDistTo(level: Level, goal: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && dist[y] < 0) {
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/** The squares the player reaches from `from` around walls and `occupied` boxes; returns the lowest such square. */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Neighbours, in fixed order so the walk is deterministic.
    if (wall[p - w] === 0 && occupied[p - w] === 0 && seen[p - w] !== stamp) {
      seen[p - w] = stamp;
      stack[n++] = p - w;
    }
    if (wall[p + w] === 0 && occupied[p + w] === 0 && seen[p + w] !== stamp) {
      seen[p + w] = stamp;
      stack[n++] = p + w;
    }
    if (wall[p - 1] === 0 && occupied[p - 1] === 0 && seen[p - 1] !== stamp) {
      seen[p - 1] = stamp;
      stack[n++] = p - 1;
    }
    if (wall[p + 1] === 0 && occupied[p + 1] === 0 && seen[p + 1] !== stamp) {
      seen[p + 1] = stamp;
      stack[n++] = p + 1;
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** All orderings of the goal indices, for the assignment heuristic. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/**
 * Push-optimal solution of `sub` ({pushes, moves}), or null when the search
 * gives up. A* over pushes when `heuristic` is true, plain uniform-cost
 * search (BFS over pushes) when false; both return the optimum when they
 * find one.
 */
function solvePushOptimal(
  sub: Level,
  heuristic: boolean,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const n = sub.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(sub);
  if (sub.boxes.some((b) => !live[b])) return null;
  const dists = goals.map((g) => pushDistTo(sub, g));
  const perms = heuristic ? permutations(n) : [];
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // Minimum assignment cost of the boxes to the goals (Infinity: no box can
  // reach its assigned goal even alone, so the state is unsolvable).
  const estimate = (boxes: number[]): number => {
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[perm[i]!]![boxes[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;

  // States: boxes (sorted), the player's square, the region's lowest square,
  // parent, and the push that made the state (from square, to square,
  // direction letter). The key of a state is its region's lowest square plus
  // its boxes, as digits in base `size` — exact while size ** (n + 1) stays
  // under 2 ** 53.
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const statesBoxes: number[][] = [sub.boxes.slice()];
  const statesPlayer: number[] = [sub.player];
  const statesLow: number[] = [0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: string[] = [''];
  const gScore: number[] = [0];
  const best = new Map<number, number>();
  for (const b of sub.boxes) occupied[b] = 1;
  const rootLow = reachLow(sub, occupied, sub.player, seen, ++stamp, stack);
  for (const b of sub.boxes) occupied[b] = 0;
  statesLow[0] = rootLow;
  best.set(keyOf(sub.boxes, rootLow), 0);
  if (solved(sub.boxes)) return { pushes: 0, moves: '' };

  // Binary heap on [f, -g, sequence]: lowest f first, deeper g first on a
  // tie, then earliest generated — fully deterministic.
  const heap: Array<[number, number, number, number]> = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let seq = 0;
  heapPush([heuristic ? estimate(sub.boxes) : 0, 0, seq++, 0]);
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = statesBoxes[s]!;
    const g = gScore[s]!;
    // Stale heap entry (a cheaper route to this state was found since).
    if (best.get(keyOf(boxes, statesLow[s]!)) !== s) continue;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(sub, occupied, statesPlayer[s]!, seen, here, stack);
    // Expand every push from this state, in fixed order.
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy, , up] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(sub, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let h = 0;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          // The child's region is marked on its own array: marking it on
          // `seen` would clobber this state's region marks mid-expansion.
          low = reachLow(sub, occupied, b, mark, ++markStamp, stack);
          key = keyOf(next, low);
          h = heuristic ? estimate(next) : 0;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h === Infinity) continue;
        const prevBest = best.get(key);
        if (prevBest !== undefined && gScore[prevBest]! <= g + 1) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const idx = statesBoxes.length;
        best.set(key, idx);
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesLow.push(low);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(up);
        gScore.push(g + 1);
        if (solved(next)) {
          found = idx;
          break;
        }
        heapPush([g + 1 + h, -(g + 1), seq++, idx]);
      }
      if (found >= 0) break;
    }
    for (const x of boxes) occupied[x] = 0;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += pushDir[s]!;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one room's sub-level: A* first, plain push BFS if A* gives up. */
function solveRoom(sub: Level): { pushes: number; moves: string } | null {
  return solvePushOptimal(sub, true, MAX_STATES) ?? solvePushOptimal(sub, false, MAX_STATES);
}

/** The moves solving a whole level, or '' when no solution was found. */
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      // The other rooms' boxes stand as walls (on their goals once done),
      // so this room is solved on its own board.
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solveRoom(sub);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }
  // No room split: one push search over the whole level.
  const solved = solveRoom(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
