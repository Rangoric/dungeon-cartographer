// Flat-floor generation algorithm.
//
// 2026-08-01 (Room Corridor Rework Plan.md): full rewrite of the Shape/
// Layout part of generation, replacing the old "grow one room at a time
// off an existing room's face" accretion loop. Informed by donjon's
// dungeon generator (https://donjon.bin.sh/code/dungeon/dungeon.pl), not a
// port of it - three confirmed departures from donjon: (1) rooms are
// placed against a footprint BUDGET, corridors are generated afterward and
// aren't measured against any target; (2) corridors are discrete objects
// that can branch/meet at junctions (not one big undifferentiated maze
// grid); (3) connectivity is guaranteed by construction (a grid pathfind,
// not a carve-and-hope). See the plan doc for the full decision record.
//
// Pipeline: place rooms (+lobes) against a footprint budget -> grow
// corridor branches connecting every room (mandatory) -> grow some extra
// loop/spur branches for richness (optional) -> prune most dead-end spurs
// -> place stairs -> rank special kinds / extra entrances by real
// navigable distance.
//
// This file is deliberately free of Three.js/Obsidian imports - pure data
// generation, unit-testable without a WebGL context, same spirit as
// `renderFloor.ts`/`dungeonData.ts`. It's the one generation module allowed
// to depend on `dungeonData.ts` (a one-way dependency - `renderFloor.ts`
// never depends back on this file), reusing `doorGapCells()` for
// connectivity/BFS rather than re-deriving the same door-gap math twice.

import type {
  DungeonBox,
  DungeonConnection,
  DungeonCorridor,
  DungeonCorridorEndpoint,
  DungeonDoor,
  DungeonFloorData,
  DungeonRegion,
  DungeonRoom,
  DungeonStair,
} from "./dungeonData";
import { doorGapCells } from "./dungeonData";
import type { FloorSetup } from "./floorSetup";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

/**
 * A small seeded PRNG (mulberry32) with the handful of `random.Random`-style
 * methods generation needs. Doesn't need to be cryptographically strong or
 * match any other RNG's sequence bit-for-bit - only needs to be
 * deterministic for a given seed within this module, so the same seed
 * always produces the same floor and tests can assert on specific seeds.
 */
export class Rng {
  private state: number;

  constructor(seed?: number) {
    const s = seed ?? Date.now();
    // Avoid the degenerate all-zero state mulberry32 can't escape from.
    this.state = (s >>> 0) || 0x9e3779b9;
  }

  /** A float in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [a, b], inclusive on both ends. */
  randint(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }

  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }

  /** A single weighted pick from `items`, matching `weights` by index. */
  choices<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.random() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GenerateConfig {
  // The *generated* placement area, not the final exported footprint - the
  // outer wall ring adds WALL_EXPORT_MARGIN cells on every side on export,
  // so a 34x34 generated area becomes a 36x36 DungeonFloorData.grid. See
  // `toDungeonFloorData`.
  gridWidth: number;
  gridDepth: number;
  gridHeight: number; // vertical band, in cubes - stays 30'/6 cubes
  minRoomSize: [number, number]; // [w, d] - height comes from the ceiling-height weight table, not a range
  maxRoomSize: [number, number]; // [w, d]
  maxAttempts: number;
  shrinkAfter: number; // consecutive room-placement failures before trimming candidate w/d by 1

  // Room-only footprint budget (rooms + their lobes, NOT corridors/walls) -
  // 2026-08-01, see Room Corridor Rework Plan.md. Each generation run rolls
  // an actual target uniformly within +/- footprintTargetVariance (relative)
  // of footprintTarget, so repeated runs don't all converge on an identical
  // room count.
  footprintTarget: number;
  footprintTargetVariance: number;

  // Corridor width - 2026-08-01. Each corridor branch independently rolls
  // 5'/10' once for its whole length; the odds jump when the branch is
  // attached to a 10' door on at least one end.
  corridorWidthBaseChance: number;
  corridorWidthDoorChance: number;
  // Chance a given branch is "windy" (meandering) rather than "direct"
  // (short, few turns) - rolled once per branch.
  corridorWindyChance: number;
  // Safety cap on pathfinding search cost, so a branch search can't run
  // away on a large/dense grid.
  corridorMaxSearchCost: number;

  // Non-mandatory extra connections (loops) and dead-end spurs, added after
  // every room is connected, purely for richness - see Room Corridor
  // Rework Plan.md.
  loopCountRange: [number, number];
  spurCountRange: [number, number];
  spurLengthRange: [number, number];
  // Fraction of generated spurs pruned back to their nearest junction/room,
  // skewed toward pruning the SHORT ones first and keeping long ones (a
  // long dead end can hold something interesting; a short one can't).
  deadEndPruneFraction: number;

  specialKinds: string[]; // optional per-dungeon special rooms, e.g. ["boss"]
  doorMaterials: string[];
  secretDoorChance: number;
  stairCountRange: [number, number];
  stairEmbeddedChance: number; // embedded in a room vs. freestanding terminus
  spiralStairChance: number; // spiral vs. regular/straight
  // Extension regions only (lobes). Index i is the probability of i
  // regions (0-4); typically 1-3, occasionally 4.
  regionCountWeights: number[];
  extraEntranceCountRange: [number, number];
  seed?: number;
}

/** Confirmed defaults - see Room Corridor Rework Plan.md and Simplification Plan.md. */
export const DEFAULT_GENERATE_CONFIG: Omit<GenerateConfig, "gridWidth" | "gridDepth"> = {
  gridHeight: 6,
  minRoomSize: [2, 2],
  maxRoomSize: [6, 6],
  maxAttempts: 4000,
  shrinkAfter: 150,
  footprintTarget: 0.4,
  footprintTargetVariance: 0.1,
  corridorWidthBaseChance: 0.2,
  corridorWidthDoorChance: 0.8,
  corridorWindyChance: 0.4,
  corridorMaxSearchCost: 6000,
  loopCountRange: [1, 3],
  spurCountRange: [2, 6],
  spurLengthRange: [2, 9],
  deadEndPruneFraction: 0.5,
  specialKinds: [],
  doorMaterials: ["wood", "metal", "stone"],
  secretDoorChance: 0.05,
  stairCountRange: [1, 2],
  stairEmbeddedChance: 0.5,
  spiralStairChance: 0.4,
  regionCountWeights: [0.55, 0.25, 0.12, 0.06, 0.02],
  extraEntranceCountRange: [0, 0],
};

/** Builds a full `GenerateConfig` from a floor's parsed Setup file (grid size), filling in every other confirmed default. */
export function configFromFloorSetup(setup: FloorSetup, overrides: Partial<GenerateConfig> = {}): GenerateConfig {
  return {
    ...DEFAULT_GENERATE_CONFIG,
    gridWidth: setup.gridWidth,
    gridDepth: setup.gridDepth,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ceiling-height weighting - confirmed 2026-07-31, see Simplification Plan.md
// ---------------------------------------------------------------------------

const CEILING_HEIGHTS = [2, 4, 6] as const; // cubes: 10' / 20' / 30'

/**
 * Room ceiling-height weights, keyed by room footprint area (w * d, in grid
 * squares). Linearly interpolated between these breakpoints; area outside
 * the range clamps to the nearest row.
 */
const ROOM_HEIGHT_BREAKPOINTS: { area: number; weights: [number, number, number] }[] = [
  { area: 16, weights: [75, 25, 0] },
  { area: 36, weights: [40, 55, 5] },
  { area: 64, weights: [20, 65, 15] },
  { area: 100, weights: [15, 70, 15] },
];

/** A flat 3:1 weight, 10' vs. 20' - 30' is never an option for a corridor. */
const CORRIDOR_HEIGHTS = [2, 4] as const;
const CORRIDOR_HEIGHT_WEIGHTS = [75, 25];

function pickRoomHeight(area: number, rng: Rng): number {
  const points = ROOM_HEIGHT_BREAKPOINTS;
  let weights: [number, number, number];

  if (area <= points[0].area) {
    weights = points[0].weights;
  } else if (area >= points[points.length - 1].area) {
    weights = points[points.length - 1].weights;
  } else {
    let lo = points[0];
    let hi = points[points.length - 1];
    for (let i = 0; i < points.length - 1; i++) {
      if (area >= points[i].area && area <= points[i + 1].area) {
        lo = points[i];
        hi = points[i + 1];
        break;
      }
    }
    const t = (area - lo.area) / (hi.area - lo.area);
    weights = [0, 1, 2].map((i) => lo.weights[i] + (hi.weights[i] - lo.weights[i]) * t) as [
      number,
      number,
      number,
    ];
  }

  return rng.choices(CEILING_HEIGHTS, weights);
}

function pickCorridorHeight(rng: Rng): number {
  return rng.choices(CORRIDOR_HEIGHTS, CORRIDOR_HEIGHT_WEIGHTS);
}

// ---------------------------------------------------------------------------
// Door-width weighting - confirmed 2026-07-31, see Block Walls Plan.md
// ---------------------------------------------------------------------------

const DOOR_WIDTHS = [1, 2] as const; // cells: a normal 5' door / a 10' double door

/**
 * Door-width weights, keyed by a room's own footprint area (w * d, in grid
 * squares). Ramps from "never" at a small footprint to a flat 10% once the
 * room hits ~1000 sqft (area 40) and stays there.
 */
const DOOR_WIDTH_BREAKPOINTS: { area: number; weights: [number, number] }[] = [
  { area: 16, weights: [100, 0] },
  { area: 40, weights: [90, 10] },
];

function pickDoorWidth(area: number, rng: Rng): number {
  const points = DOOR_WIDTH_BREAKPOINTS;
  let weights: [number, number];

  if (area <= points[0].area) {
    weights = points[0].weights;
  } else if (area >= points[points.length - 1].area) {
    weights = points[points.length - 1].weights;
  } else {
    const lo = points[0];
    const hi = points[points.length - 1];
    const t = (area - lo.area) / (hi.area - lo.area);
    weights = [0, 1].map((i) => lo.weights[i] + (hi.weights[i] - lo.weights[i]) * t) as [number, number];
  }

  return rng.choices(DOOR_WIDTHS, weights);
}

/**
 * Corridor-width weighting - 2026-08-01, see Room Corridor Rework Plan.md.
 * Flat (not area-scaled, unlike doors/ceilings): ~20% baseline chance of a
 * 10' corridor, jumping to ~80% when the branch is attached to a 10' door
 * on at least one end.
 */
function pickCorridorWidth(attachedToWideDoor: boolean, config: GenerateConfig, rng: Rng): number {
  const chance = attachedToWideDoor ? config.corridorWidthDoorChance : config.corridorWidthBaseChance;
  return rng.random() < chance ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Internal geometry
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

interface GridSize {
  width: number;
  depth: number;
  height: number;
}

const DIRECTIONS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function x2(b: Box): number {
  return b.x + b.w;
}
function y2(b: Box): number {
  return b.y + b.d;
}
function z2(b: Box): number {
  return b.z + b.h;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < x2(b) && b.x < x2(a) && a.y < y2(b) && b.y < y2(a) && a.z < z2(b) && b.z < z2(a);
}

/**
 * Cells of mandatory x/y separation between two *different* entities'
 * interiors - the full-block wall (see Block Walls Plan.md). Not a z-axis
 * concern: floors/ceilings are a separate abstraction, unaffected by this.
 * Same-entity attachments (a room's own extension regions, a corridor
 * joining another corridor flush at a junction) are exempt and stay flush.
 */
const WALL_GAP = 1;

/** Like `overlaps`, but `a` is inflated by `margin` cells in x/y first - used to enforce `WALL_GAP` between unrelated interiors during placement validation. */
function marginOverlaps(a: Box, margin: number, b: Box): boolean {
  return (
    a.x - margin < x2(b) &&
    b.x < x2(a) + margin &&
    a.y - margin < y2(b) &&
    b.y < y2(a) + margin &&
    a.z < z2(b) &&
    b.z < z2(a)
  );
}

function isWithin(b: Box, grid: GridSize): boolean {
  return b.x >= 0 && b.y >= 0 && b.z >= 0 && x2(b) <= grid.width && y2(b) <= grid.depth && z2(b) <= grid.height;
}

function toBox(b: Box): DungeonBox {
  return { x: b.x, y: b.y, z: b.z, w: b.w, d: b.d, h: b.h };
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function forEachCell(b: Box, fn: (x: number, y: number) => void): void {
  for (let yy = b.y; yy < y2(b); yy++) {
    for (let xx = b.x; xx < x2(b); xx++) fn(xx, yy);
  }
}

// ---------------------------------------------------------------------------
// Internal graph state
// ---------------------------------------------------------------------------

interface GenRoom extends Box {
  id: number;
  kind: string;
}

interface GenCorridor {
  id: number;
  connects: [DungeonCorridorEndpoint, DungeonCorridorEndpoint];
  width: number;
  segments: Box[];
  /** Every cell this corridor occupies - kept alongside `segments` since junction/spur bookkeeping needs fast cell membership checks. */
  cells: Set<string>;
}

interface GenDoor {
  id: number;
  connects: [DungeonConnection, DungeonConnection];
  cellA: [number, number, number];
  cellB: [number, number, number];
  material: string;
  secret: boolean;
  width: number;
}

interface GenStair {
  id: number;
  roomId: number;
  embedded: boolean;
  style: "spiral" | "regular";
  floorsDown: number;
  box: Box;
}

/** Always `extension: true` in this flattened generator - see module header. */
interface GenRegion {
  id: number;
  roomId: number;
  box: Box;
  kind: string;
  extension: true;
}

interface Graph {
  grid: GridSize;
  rooms: GenRoom[];
  corridors: GenCorridor[];
  regions: GenRegion[];
  doors: GenDoor[];
  stairs: GenStair[];
}

function regionsFor(graph: Graph, roomId: number): GenRegion[] {
  return graph.regions.filter((r) => r.roomId === roomId);
}

function allSegments(graph: Graph): Box[] {
  const segments: Box[] = [];
  for (const room of graph.rooms) {
    segments.push(room);
    for (const region of regionsFor(graph, room.id)) segments.push(region.box);
  }
  for (const corridor of graph.corridors) segments.push(...corridor.segments);
  for (const stair of graph.stairs) if (!stair.embedded) segments.push(stair.box);
  return segments;
}

/** WALL_GAP-aware collision against every ROOM/region/freestanding-stair (not corridors - corridors are allowed, even meant, to sit flush against each other at a junction). Used for room+lobe+stair placement. */
function collidesWithRoomsAndStairs(graph: Graph, candidates: Box[]): boolean {
  const existing: Box[] = [];
  for (const room of graph.rooms) {
    existing.push(room);
    for (const region of regionsFor(graph, room.id)) existing.push(region.box);
  }
  for (const stair of graph.stairs) if (!stair.embedded) existing.push(stair.box);
  return candidates.some((cand) => existing.some((seg) => marginOverlaps(cand, WALL_GAP, seg)));
}

// ---------------------------------------------------------------------------
// Room placement against a footprint budget - 2026-08-01
// ---------------------------------------------------------------------------

function shrinkMaxSize(config: GenerateConfig, consecutiveFailures: number): [number, number] {
  const steps = Math.floor(consecutiveFailures / config.shrinkAfter);
  const maxW = Math.max(config.minRoomSize[0], config.maxRoomSize[0] - steps);
  const maxD = Math.max(config.minRoomSize[1], config.maxRoomSize[1] - steps);
  return [maxW, maxD];
}

function roomFootprintCells(graph: Graph): Set<string> {
  const cells = new Set<string>();
  for (const room of graph.rooms) forEachCell(room, (x, y) => cells.add(cellKey(x, y)));
  for (const region of graph.regions) forEachCell(region.box, (x, y) => cells.add(cellKey(x, y)));
  return cells;
}

/** Extension regions (lobes) - the only FloorRegion kind this generator produces. */
function tryExtensionRegion(room: GenRoom, graph: Graph, grid: GridSize, rng: Rng, siblingBoxes: Box[]): Box | null {
  const [dx, dy] = rng.choice(DIRECTIONS);
  const maxW = Math.max(1, Math.min(room.w - 1, 3));
  const maxD = Math.max(1, Math.min(room.d - 1, 3));
  const w = rng.randint(1, maxW);
  const d = rng.randint(1, maxD);

  const faceOffset = (baseSpan: number, newSpan: number): number => {
    if (newSpan <= baseSpan) return rng.randint(0, baseSpan - newSpan);
    return -rng.randint(0, newSpan - baseSpan);
  };

  let candidate: Box;
  if (dx !== 0) {
    const x = dx > 0 ? x2(room) : room.x - w;
    const y = room.y + faceOffset(room.d, d);
    candidate = { x, y, z: room.z, w, d, h: room.h };
  } else {
    const y = dy > 0 ? y2(room) : room.y - d;
    const x = room.x + faceOffset(room.w, w);
    candidate = { x, y, z: room.z, w, d, h: room.h };
  }

  if (!isWithin(candidate, grid)) return null;
  if (collidesWithRoomsAndStairs(graph, [candidate]) || siblingBoxes.some((existing) => overlaps(candidate, existing))) {
    return null;
  }
  return candidate;
}

function tryAddRegions(
  room: GenRoom,
  graph: Graph,
  grid: GridSize,
  config: GenerateConfig,
  rng: Rng,
  nextRegionId: number
): { regions: GenRegion[]; nextRegionId: number } {
  const countIndex = rng.choices(
    Array.from({ length: config.regionCountWeights.length }, (_, i) => i),
    config.regionCountWeights
  );

  const regions: GenRegion[] = [];
  const acceptedBoxes: Box[] = [];

  for (let i = 0; i < countIndex; i++) {
    const box = tryExtensionRegion(room, graph, grid, rng, acceptedBoxes);
    if (!box) continue;
    acceptedBoxes.push(box);
    regions.push({ id: nextRegionId, roomId: room.id, box, kind: room.kind, extension: true });
    nextRegionId++;
  }

  return { regions, nextRegionId };
}

function randomBoundaryRoom(grid: GridSize, w: number, d: number, h: number, z: number, rng: Rng): GenRoom {
  const edge = rng.choice(["north", "south", "east", "west"] as const);
  let x: number;
  let y: number;
  if (edge === "north") {
    x = rng.randint(0, grid.width - w);
    y = 0;
  } else if (edge === "south") {
    x = rng.randint(0, grid.width - w);
    y = grid.depth - d;
  } else if (edge === "west") {
    x = 0;
    y = rng.randint(0, grid.depth - d);
  } else {
    x = grid.width - w;
    y = rng.randint(0, grid.depth - d);
  }
  return { id: 0, x, y, z, w, d, h, kind: "entrance" };
}

/**
 * Places rooms (+ their lobes) by random scatter until total footprint
 * lands in the rolled target band, rather than growing each room off an
 * existing one's face. The entrance is placed first (boundary-pinned, as
 * before) and everything after is placed anywhere in bounds, subject only
 * to the usual WALL_GAP separation from every other room.
 */
function placeRooms(graph: Graph, grid: GridSize, config: GenerateConfig, rng: Rng): void {
  const gridArea = grid.width * grid.depth;
  const variance = (rng.random() * 2 - 1) * config.footprintTargetVariance;
  const targetFraction = config.footprintTarget * (1 + variance);

  const entrance = randomBoundaryRoom(grid, 2, 2, 2, 0, rng);
  graph.rooms.push(entrance);
  let nextRegionId = 0;
  const entranceRegions = tryAddRegions(entrance, graph, grid, config, rng, nextRegionId);
  nextRegionId = entranceRegions.nextRegionId;
  for (const region of entranceRegions.regions) graph.regions.push(region);

  let nextRoomId = 1;
  let attempts = 0;
  let consecutiveFailures = 0;

  while (roomFootprintCells(graph).size / gridArea < targetFraction && attempts < config.maxAttempts) {
    attempts++;
    const [maxW, maxD] = shrinkMaxSize(config, consecutiveFailures);
    const w = rng.randint(config.minRoomSize[0], maxW);
    const d = rng.randint(config.minRoomSize[1], maxD);
    const h = pickRoomHeight(w * d, rng);
    const x = rng.randint(0, Math.max(0, grid.width - w));
    const y = rng.randint(0, Math.max(0, grid.depth - d));
    const candidate: Box = { x, y, z: 0, w, d, h };

    if (!isWithin(candidate, grid) || collidesWithRoomsAndStairs(graph, [candidate])) {
      consecutiveFailures++;
      continue;
    }
    consecutiveFailures = 0;

    const room: GenRoom = { id: nextRoomId, kind: "room", ...candidate };
    const added = tryAddRegions(room, graph, grid, config, rng, nextRegionId);
    graph.rooms.push(room);
    for (const region of added.regions) graph.regions.push(region);

    // Reject a placement that would cut off this room (or, more subtly,
    // an ALREADY-placed one) from the entrance's open floor space - not
    // just "this room individually has a free cell nearby" but "the free
    // space it can reach is the SAME connected region the entrance sits
    // in." Pure random room+margin scatter can and does fragment the
    // grid's open space into separate pockets even when every room still
    // has *some* nearby free cell - no pathfind, however good, can cross
    // a wall that's actually there. Cheaper to refuse the placement here
    // than to discover a permanently-stranded room during corridor
    // growth with no way back.
    if (!allRoomsReachEntranceFreeSpace(graph, grid)) {
      graph.rooms.pop();
      for (let i = 0; i < added.regions.length; i++) graph.regions.pop();
      consecutiveFailures++;
      continue;
    }

    nextRegionId = added.nextRegionId;
    nextRoomId++;
  }
}

/** True if every one of a room's 4 perimeter faces is currently blocked (by some other room's WALL_GAP margin) - meaning no corridor could ever launch from it. */
function hasAnyLaunchPoint(room: GenRoom, grid: GridSize, blocked: ReadonlySet<string>): boolean {
  return roomLaunchPoints(room, grid).some((p) => !blocked.has(cellKey(p.cell[0], p.cell[1])));
}

/**
 * Flood-fills every non-room-blocked cell reachable from `start` - the
 * grid's genuinely open floor space, treated as a graph in its own right
 * (independent of any corridor, which doesn't exist yet at placement
 * time).
 */
function freeSpaceReachableFrom(grid: GridSize, blocked: ReadonlySet<string>, start: [number, number]): Set<string> {
  const startKey = cellKey(start[0], start[1]);
  const seen = new Set<string>();
  if (blocked.has(startKey)) return seen;
  seen.add(startKey);
  const queue = [startKey];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const [xs, ys] = cur.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) continue;
      const nk = cellKey(nx, ny);
      if (blocked.has(nk) || seen.has(nk)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return seen;
}

/**
 * True if EVERY room can still reach the entrance's own free-space region -
 * a stronger check than "this one room individually has a launch point"
 * (`hasAnyLaunchPoint`, superseded by this): random room+margin placement
 * doesn't just risk sealing one room in completely, it can fragment the
 * grid's open floor space into multiple disconnected pockets even while
 * every individual room still has *a* launch cell - each pocket's rooms
 * would only ever be able to route to each other, never to the entrance's
 * pocket, and no pathfinder can fix a wall that's actually there. Found by
 * testing: with per-room-only checking, room counts stalled with barely a
 * dozen of several dozen rooms ever connecting - this flood-fill check
 * (run after every tentative room placement, same rollback-on-failure
 * spot `placeRooms` already had) fixed it outright.
 */
function allRoomsReachEntranceFreeSpace(graph: Graph, grid: GridSize): boolean {
  const blocked = buildRoomBlockedSet(graph);
  const entrance = graph.rooms[0];
  const entranceLaunch = roomLaunchPoints(entrance, grid).find((p) => !blocked.has(cellKey(p.cell[0], p.cell[1])));
  if (!entranceLaunch) return false;
  const reachable = freeSpaceReachableFrom(grid, blocked, entranceLaunch.cell);
  return graph.rooms.every((r) => roomLaunchPoints(r, grid).some((p) => reachable.has(cellKey(p.cell[0], p.cell[1]))));
}

// ---------------------------------------------------------------------------
// Corridor branch growth - 2026-08-01, see Room Corridor Rework Plan.md
// ---------------------------------------------------------------------------

/** Every cell within WALL_GAP of any room's interior OR any of its lobes - a corridor branch can never route through this (guarantees the wall gap by construction, not a later check). Static once rooms are placed (lobes are placed alongside their room, before any corridor growth starts). */
function buildRoomBlockedSet(graph: Graph): Set<string> {
  const blocked = new Set<string>();
  const inflate = (b: Box) => {
    for (let yy = b.y - WALL_GAP; yy <= y2(b); yy++) {
      for (let xx = b.x - WALL_GAP; xx <= x2(b); xx++) {
        blocked.add(cellKey(xx, yy));
      }
    }
  };
  for (const room of graph.rooms) inflate(room);
  for (const region of graph.regions) inflate(region.box);
  return blocked;
}

interface LaunchPoint {
  /** The first cell a corridor branch could occupy - 2 cells beyond the room's own boundary cell (1 cell of WALL_GAP, then the corridor's own interior starts). */
  cell: [number, number];
  /** The room's own interior cell right at this face - where the door's `cellA`/`cellB` on this side lands. */
  boundaryCell: [number, number];
  dir: [number, number];
  z: number;
}

/** Every valid launch/dock point around a room's perimeter, one per boundary cell x outward-facing direction. */
function roomLaunchPoints(room: GenRoom, grid: GridSize): LaunchPoint[] {
  const points: LaunchPoint[] = [];
  for (const [dx, dy] of DIRECTIONS) {
    if (dx !== 0) {
      const bx = dx > 0 ? x2(room) - 1 : room.x;
      const lx = bx + dx * 2;
      if (lx < 0 || lx >= grid.width) continue;
      for (let by = room.y; by < y2(room); by++) {
        points.push({ cell: [lx, by], boundaryCell: [bx, by], dir: [dx, dy], z: room.z });
      }
    } else {
      const by = dy > 0 ? y2(room) - 1 : room.y;
      const ly = by + dy * 2;
      if (ly < 0 || ly >= grid.depth) continue;
      for (let bx = room.x; bx < x2(room); bx++) {
        points.push({ cell: [bx, ly], boundaryCell: [bx, by], dir: [dx, dy], z: room.z });
      }
    }
  }
  return points;
}

type RouteTarget =
  | { kind: "room"; roomId: number; point: LaunchPoint }
  | { kind: "corridor"; corridorId: number };

/** Every cell any already-committed corridor occupies - a fresh union each time it's called since corridors accumulate as generation proceeds. */
function allCorridorCells(corridors: GenCorridor[]): Set<string> {
  const cells = new Set<string>();
  for (const corridor of corridors) for (const key of corridor.cells) cells.add(key);
  return cells;
}

/**
 * The blocked set a new branch's pathfind must respect: room margins PLUS
 * every existing corridor's own interior. Without the corridor half of
 * this, a search could path straight across an already-committed
 * corridor's cells instead of stopping beside it - the corridor-vs-
 * corridor overlap bug caught by the "no overlapping pieces" test during
 * this feature's first pass. Junction *targets* (below) are deliberately
 * the cells just OUTSIDE this set, one step away from an existing
 * corridor, so a branch can still dock flush against one without ever
 * stepping onto its cells.
 */
function routeBlockedSet(roomBlocked: ReadonlySet<string>, corridors: GenCorridor[]): Set<string> {
  const blocked = new Set(roomBlocked);
  for (const key of allCorridorCells(corridors)) blocked.add(key);
  return blocked;
}

/**
 * Junction docking cells - every free cell 4-adjacent to an
 * already-committed corridor's interior, but not itself part of ANY
 * corridor (own or otherwise, even one not eligible as a target) and not
 * room-blocked. `eligibleCorridors` controls which corridors offer up
 * docking cells; `allCorridors` (defaults to the same list) is used only
 * for the "not part of any corridor" exclusion, so a restricted eligible
 * set (see `growConnectingBranch`'s mandatory-connect use) still correctly
 * excludes cells that belong to some OTHER, non-eligible corridor rather
 * than accidentally offering them up as if they were open ground.
 * Recomputed fresh before each search since it grows as corridors are
 * added.
 */
function corridorJunctionTargets(
  eligibleCorridors: GenCorridor[],
  roomBlocked: ReadonlySet<string>,
  grid: GridSize,
  allCorridors: GenCorridor[] = eligibleCorridors
): Map<string, RouteTarget> {
  const occupied = allCorridorCells(allCorridors);
  const targets = new Map<string, RouteTarget>();
  for (const corridor of eligibleCorridors) {
    for (const key of corridor.cells) {
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      for (const [dx, dy] of DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) continue;
        const nkey = cellKey(nx, ny);
        if (occupied.has(nkey) || roomBlocked.has(nkey)) continue;
        if (!targets.has(nkey)) targets.set(nkey, { kind: "corridor", corridorId: corridor.id });
      }
    }
  }
  return targets;
}

interface RouteResult {
  path: [number, number][];
  sourcePoint: LaunchPoint;
  target: RouteTarget;
}

/**
 * Uniform-cost search (Dijkstra) from any of `sources` to the cheapest cell
 * in `targets`. Guarantees a route whenever one physically exists, given
 * `blocked` never changes mid-search - this is the actual "carve so
 * disconnection should be impossible" mechanism (Room Corridor Rework
 * Plan.md decision 2), not a carve-then-hope. `windy` swaps the cost
 * function: a direct branch pays a heavy penalty for turning (prefers
 * straight runs); a windy branch pays a small *deterministic* per-cell
 * jitter cost instead (still seed-reproducible), so it wanders rather than
 * beelining.
 */
function findRoute(
  sources: LaunchPoint[],
  targets: Map<string, RouteTarget>,
  blocked: ReadonlySet<string>,
  grid: GridSize,
  windy: boolean,
  rng: Rng,
  maxCost: number,
  firstStepAwayPenaltyDir?: [number, number]
): RouteResult | null {
  const jitter = new Map<string, number>();
  const jitterFor = (x: number, y: number): number => {
    const k = cellKey(x, y);
    let v = jitter.get(k);
    if (v === undefined) {
      v = rng.random() * 3;
      jitter.set(k, v);
    }
    return v;
  };

  const bestCost = new Map<string, number>();
  const cameFrom = new Map<string, [number, number]>();
  const isSource = new Map<string, LaunchPoint>();
  const frontier: { x: number; y: number; dir: [number, number]; cost: number }[] = [];

  for (const s of sources) {
    const [x, y] = s.cell;
    const key = cellKey(x, y);
    if (blocked.has(key) || bestCost.has(key)) continue;
    bestCost.set(key, 0);
    isSource.set(key, s);
    frontier.push({ x, y, dir: s.dir, cost: 0 });
  }

  let foundKey: string | null = null;

  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const current = frontier.shift()!;
    const key = cellKey(current.x, current.y);
    if (current.cost > (bestCost.get(key) ?? Infinity)) continue;
    if (current.cost > maxCost) break;

    if (targets.has(key)) {
      foundKey = key;
      break;
    }

    for (const [dx, dy] of DIRECTIONS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) continue;
      const nkey = cellKey(nx, ny);
      if (blocked.has(nkey)) continue;

      const turned = current.dir[0] !== dx || current.dir[1] !== dy;
      let stepCost = windy ? 1 + jitterFor(nx, ny) : 1 + (turned ? 4 : 0);
      if (firstStepAwayPenaltyDir && current.cost === 0 && dx === firstStepAwayPenaltyDir[0] && dy === firstStepAwayPenaltyDir[1]) {
        stepCost += 6; // orientation rule: bias a width-1 branch off a 10' door away from running straight out
      }
      const newCost = current.cost + stepCost;
      if (newCost < (bestCost.get(nkey) ?? Infinity)) {
        bestCost.set(nkey, newCost);
        cameFrom.set(nkey, [current.x, current.y]);
        frontier.push({ x: nx, y: ny, dir: [dx, dy], cost: newCost });
      }
    }
  }

  if (!foundKey) return null;

  const path: [number, number][] = [];
  let curKey: string | null = foundKey;
  while (curKey) {
    const [xs, ys] = curKey.split(",");
    const x = Number(xs);
    const y = Number(ys);
    path.unshift([x, y]);
    const prev = cameFrom.get(curKey);
    curKey = prev ? cellKey(prev[0], prev[1]) : null;
  }

  const sourceKey = cellKey(path[0][0], path[0][1]);
  const sourcePoint = isSource.get(sourceKey)!;
  return { path, sourcePoint, target: targets.get(foundKey)! };
}

interface PathSegment {
  box: Box;
  dir: [number, number];
}

function boxFromRun(cells: [number, number][], z: number, height: number): Box {
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: x0, y: y0, z, w: x1 - x0 + 1, d: y1 - y0 + 1, h: height };
}

/**
 * Groups a cell path into straight-run rectangular segments, one per
 * direction change. Each cell belongs to exactly ONE segment - the pivot
 * cell at a bend stays with the run it finished, and the next run starts
 * fresh at the very next cell, so consecutive segments end up adjacent
 * (sharing a face) rather than overlapping (sharing a cell). An earlier
 * version put the pivot cell in BOTH runs (mimicking how the two segments
 * of an old-style single-bend corridor used to touch) which is fine for
 * two segments that never share an axis span, but for an actual cell path
 * it produced a real 1-cell overlap at every bend - caught by the
 * structural "no overlapping pieces" test once corridors started forming
 * multi-bend branches.
 */
function compactPathToSegments(path: [number, number][], z: number, height: number): PathSegment[] {
  if (path.length === 1) {
    const [x, y] = path[0];
    return [{ box: { x, y, z, w: 1, d: 1, h: height }, dir: [0, 0] }];
  }

  const segments: PathSegment[] = [];
  let run: [number, number][] = [path[0]];
  let runDir: [number, number] = [path[1][0] - path[0][0], path[1][1] - path[0][1]];

  for (let i = 1; i < path.length; i++) {
    const dir: [number, number] = [path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]];
    if (dir[0] !== runDir[0] || dir[1] !== runDir[1]) {
      segments.push({ box: boxFromRun(run, z, height), dir: runDir });
      run = [];
      runDir = dir;
    }
    run.push(path[i]);
  }
  segments.push({ box: boxFromRun(run, z, height), dir: runDir });
  return segments;
}

/**
 * Widens every segment by `width - 1` cells perpendicular to its own
 * direction of travel (all toward the same randomly-chosen side, so the
 * corridor reads as one consistent-width hallway). Falls back the WHOLE
 * branch to width 1 if any widened segment would violate WALL_GAP against
 * a room or plainly overlap another corridor's cells - same
 * per-instance-fallback convention `pickDoorWidth` already uses. Width-1
 * segments never need this check: the search itself already guarantees
 * they're valid.
 */
function widenSegments(
  segments: PathSegment[],
  width: number,
  blocked: ReadonlySet<string>,
  otherCorridors: GenCorridor[],
  grid: GridSize,
  rng: Rng
): Box[] {
  if (width <= 1) return segments.map((s) => s.box);

  const side = rng.random() < 0.5 ? 1 : -1;
  const widened: Box[] = [];
  for (const { box, dir } of segments) {
    let candidate: Box;
    if (dir[0] !== 0) {
      // travel along x - widen along y
      const extra = (width - 1) * side;
      const y0 = extra >= 0 ? box.y : box.y + extra;
      candidate = { ...box, y: y0, d: box.d + Math.abs(extra) };
    } else if (dir[1] !== 0) {
      const extra = (width - 1) * side;
      const x0 = extra >= 0 ? box.x : box.x + extra;
      candidate = { ...box, x: x0, w: box.w + Math.abs(extra) };
    } else {
      // Single-cell branch (source and target launch cells coincide) - widen along x by convention.
      candidate = { ...box, w: box.w + (width - 1) };
    }

    if (!isWithin(candidate, grid)) return segments.map((s) => s.box);
    let bad = false;
    forEachCell(candidate, (x, y) => {
      if (blocked.has(cellKey(x, y))) bad = true;
    });
    if (bad) return segments.map((s) => s.box);
    for (const other of otherCorridors) {
      for (const seg of other.segments) {
        if (overlaps(candidate, seg)) return segments.map((s) => s.box);
      }
    }
    widened.push(candidate);
  }
  return widened;
}

/** True if `widened` is actually the widened geometry (not the width-1 fallback `widenSegments` returns on failure) - compares footprint since `widenSegments` always returns a fresh array either way. */
function widthActuallyApplied(raw: PathSegment[], widened: Box[], requestedWidth: number): boolean {
  if (requestedWidth <= 1) return true;
  return widened.some((b, i) => b.w !== raw[i].box.w || b.d !== raw[i].box.d);
}

function cellsOf(segments: Box[]): Set<string> {
  const cells = new Set<string>();
  for (const seg of segments) forEachCell(seg, (x, y) => cells.add(cellKey(x, y)));
  return cells;
}

/** Picks the door's width + cellA/cellB for a branch's end that lands on a room, anchored at the launch point's boundary cell (the door sits exactly where the corridor meets the room - no independent repositioning). */
function doorAtLaunchPoint(point: LaunchPoint, room: GenRoom, rng: Rng): { width: number; cellA: [number, number, number]; cellB: [number, number, number] } {
  const area = room.w * room.d;
  const crossesX = point.dir[0] !== 0;
  const available = crossesX ? y2(room) - point.boundaryCell[1] : x2(room) - point.boundaryCell[0];
  let width = Math.min(pickDoorWidth(area, rng), Math.max(1, available));

  const [bx, by] = point.boundaryCell;
  const corridorCell: [number, number] = [bx + point.dir[0] * 2, by + point.dir[1] * 2];
  return {
    width,
    cellA: [bx, by, point.z],
    cellB: [corridorCell[0], corridorCell[1], point.z],
  };
}

interface CommittedBranch {
  corridor: GenCorridor;
  door: GenDoor | null;
}

/**
 * Grows and commits one corridor branch from `sourceRoomId` to whatever
 * `findRoute` reaches first (a room via a door, or an existing corridor
 * flush at a junction) - restricted to `targetRoomIds`/`targetCorridorIds`
 * when given (`null` means "every other room"/"every existing corridor" is
 * eligible). The mandatory connect pass restricts targets to the
 * already-entrance-connected network specifically, so every successful
 * branch grows that ONE network monotonically (Prim's-style) instead of
 * potentially linking two not-yet-connected rooms into their own isolated
 * pocket that never joins the main graph - see `growMandatoryConnections`.
 * Returns null if no route exists at all (see the module-level
 * connectivity note on why this should be exceedingly rare for the
 * unrestricted case; expected/normal for a restricted search that simply
 * hasn't got a target reachable yet).
 */
function growConnectingBranch(
  graph: Graph,
  grid: GridSize,
  config: GenerateConfig,
  rng: Rng,
  sourceRoomId: number,
  roomBlocked: ReadonlySet<string>,
  nextCorridorId: number,
  nextDoorId: number,
  targetRoomIds: ReadonlySet<number> | null = null,
  targetCorridorIds: ReadonlySet<number> | null = null
): { branch: CommittedBranch; nextCorridorId: number; nextDoorId: number } | null {
  const sourceRoom = graph.rooms.find((r) => r.id === sourceRoomId)!;
  const sources = roomLaunchPoints(sourceRoom, grid);

  const targets = new Map<string, RouteTarget>();
  for (const room of graph.rooms) {
    if (room.id === sourceRoomId) continue;
    if (targetRoomIds && !targetRoomIds.has(room.id)) continue;
    for (const point of roomLaunchPoints(room, grid)) {
      targets.set(cellKey(point.cell[0], point.cell[1]), { kind: "room", roomId: room.id, point });
    }
  }
  const eligibleCorridors = targetCorridorIds ? graph.corridors.filter((c) => targetCorridorIds.has(c.id)) : graph.corridors;
  for (const [key, target] of corridorJunctionTargets(eligibleCorridors, roomBlocked, grid, graph.corridors)) {
    if (!targets.has(key)) targets.set(key, target);
  }
  if (!targets.size) return null;

  const windy = rng.random() < config.corridorWindyChance;
  const blocked = routeBlockedSet(roomBlocked, graph.corridors);
  const route = findRoute(sources, targets, blocked, grid, windy, rng, config.corridorMaxSearchCost);
  if (!route) return null;

  const corridorsBefore = graph.corridors.length;
  const doorsBefore = graph.doors.length;
  const result = commitRoute(graph, grid, config, rng, route, sourceRoom, nextCorridorId, nextDoorId, "connect");

  // A corridor is itself just more blocked space for the NEXT search - it
  // can accidentally wall off some other not-yet-connected room the same
  // way a badly-placed room's margin can (see `placeRooms`'s
  // `allRoomsReachEntranceFreeSpace` guard for the room-placement half of
  // this). Found by testing: `placeRooms`'s guard alone still let roughly
  // one room per generated floor end up permanently unreachable, always
  // because a LATER corridor (for some other room entirely) happened to
  // claim its last remaining launch cell. Roll back and report failure
  // (the caller retries a different room/order) rather than silently
  // accepting a connection that strands someone else.
  if (strandsAnUnconnectedRoom(graph, grid, sourceRoomId)) {
    graph.corridors.length = corridorsBefore;
    graph.doors.length = doorsBefore;
    return null;
  }

  return result;
}

/**
 * True if, given the graph's CURRENT committed corridors (including one
 * just tentatively added), some room that doesn't yet have any door at
 * all has also lost every one of its launch cells - i.e. this specific
 * commit would make that room permanently unreachable, not just
 * temporarily inconvenient. `justConnectedRoomId` is exempt since it's
 * about to get its first door as part of THIS same commit.
 */
function strandsAnUnconnectedRoom(graph: Graph, grid: GridSize, justConnectedRoomId: number): boolean {
  const blocked = routeBlockedSet(buildRoomBlockedSet(graph), graph.corridors);
  const roomsWithDoors = new Set<number>([justConnectedRoomId]);
  for (const d of graph.doors) {
    for (const end of d.connects) if (end.kind === "room") roomsWithDoors.add(end.id);
  }
  for (const room of graph.rooms) {
    if (roomsWithDoors.has(room.id)) continue;
    const hasFree = roomLaunchPoints(room, grid).some((p) => !blocked.has(cellKey(p.cell[0], p.cell[1])));
    if (!hasFree) return true;
  }
  return false;
}

function commitRoute(
  graph: Graph,
  grid: GridSize,
  config: GenerateConfig,
  rng: Rng,
  route: RouteResult,
  sourceRoom: GenRoom,
  nextCorridorId: number,
  nextDoorId: number,
  originKind: "connect" | "spur"
): { branch: CommittedBranch; nextCorridorId: number; nextDoorId: number } {
  const height = pickCorridorHeight(rng);

  // Roll the start door (if the source is a room) BEFORE the width roll, since
  // corridor width is biased by whether either attached door is 10' wide.
  const startDoorPick = doorAtLaunchPoint(route.sourcePoint, sourceRoom, rng);
  let endDoorPick: ReturnType<typeof doorAtLaunchPoint> | null = null;
  let endRoom: GenRoom | null = null;
  if (route.target.kind === "room") {
    const targetRoomId = route.target.roomId;
    endRoom = graph.rooms.find((r) => r.id === targetRoomId) ?? null;
  }

  const attachedToWideDoor = startDoorPick.width === 2;
  const width = pickCorridorWidth(attachedToWideDoor, config, rng);

  if (route.target.kind === "room" && endRoom) {
    // Re-derive with knowledge that this end also needs a door - reuse the
    // route's OTHER launch point (the target room's own launch point at
    // the docking cell), rolled independently.
    const targetPoint = (route.target as { kind: "room"; roomId: number; point: LaunchPoint }).point;
    endDoorPick = doorAtLaunchPoint(targetPoint, endRoom, rng);
  }

  const rawSegments = compactPathToSegments(route.path, sourceRoom.z, height);
  const segmentsBoxes = widenSegments(rawSegments, width, buildRoomBlockedSet(graph), graph.corridors, grid, rng);
  const widthUsed = widthActuallyApplied(rawSegments, segmentsBoxes, width) ? width : 1;

  const startEndpoint: DungeonCorridorEndpoint = { kind: "room", id: sourceRoom.id };
  const endEndpoint: DungeonCorridorEndpoint =
    route.target.kind === "room" ? { kind: "room", id: route.target.roomId } : { kind: "corridor", id: route.target.corridorId };

  const corridor: GenCorridor = {
    id: nextCorridorId,
    connects: [startEndpoint, endEndpoint],
    width: widthUsed,
    segments: segmentsBoxes,
    cells: cellsOf(segmentsBoxes),
  };
  graph.corridors.push(corridor);
  nextCorridorId++;

  let door: GenDoor | null = null;
  const startDoor: GenDoor = {
    id: nextDoorId,
    connects: [{ kind: "room", id: sourceRoom.id }, { kind: "corridor", id: corridor.id }],
    cellA: startDoorPick.cellA,
    cellB: startDoorPick.cellB,
    material: rng.choice(config.doorMaterials),
    secret: rng.random() < config.secretDoorChance,
    width: startDoorPick.width,
  };
  graph.doors.push(startDoor);
  door = startDoor;
  nextDoorId++;

  if (endDoorPick && endRoom) {
    const endDoor: GenDoor = {
      id: nextDoorId,
      connects: [{ kind: "corridor", id: corridor.id }, { kind: "room", id: endRoom.id }],
      cellA: endDoorPick.cellB, // corridor-side cell first, mirroring the start door's own room->corridor order flipped
      cellB: endDoorPick.cellA,
      material: rng.choice(config.doorMaterials),
      secret: rng.random() < config.secretDoorChance,
      width: endDoorPick.width,
    };
    graph.doors.push(endDoor);
    nextDoorId++;
  }

  void originKind;
  return { branch: { corridor, door }, nextCorridorId, nextDoorId };
}

/**
 * Mandatory connection pass: every room ends up reachable from the
 * entrance. Grows the entrance's network Prim's-MST-style: each attempt
 * routes a not-yet-connected room specifically at the network built so
 * far (`connectedRoomIds`/`connectedCorridorIds`), so every SUCCESSFUL
 * branch immediately joins the one true network - never two not-yet-
 * connected rooms pairing off into their own isolated pocket that has to
 * be linked in later. (An earlier version let a room target *any* other
 * room/junction, cheapest-first, without regard to whether that target
 * was actually connected to the entrance yet - it reliably produced
 * several permanently-disconnected pockets, caught by the
 * "produces a connected graph" test across essentially every seed.)
 * `findRoute` guarantees a branch is found whenever a physical path to
 * the CURRENT network exists, so a room only stays unconnected if it's
 * architecturally sealed off by other rooms' WALL_GAP margins - loops
 * until a full pass makes zero further progress, rather than a fixed
 * pass count, so it keeps trying as long as anything is still moving.
 *
 * **Scarcest-launch-point-first, re-evaluated before every single
 * attempt.** `placeRooms` refuses any room placement that would strand a
 * room from the entrance's free-space region, but that only accounts for
 * ROOM margins - a corridor committed for some OTHER room's connection
 * can still eat a room's last remaining free cell, since nothing marks a
 * cell as "reserved" for whichever room might need it later. An earlier
 * version re-ranked rooms only once per pass (a stale batch), which
 * wasn't reactive enough - a room ranked "safe enough" at the start of a
 * pass could still lose its only remaining option to another room
 * processed earlier in that SAME pass. Fixed by picking the single
 * globally-worst-off remaining room fresh before every attempt (not a
 * pre-sorted batch) - cheap at this scale (dozens of rooms), and it
 * actually converges to full connectivity where the batched version
 * stalled with several rooms permanently stranded.
 */
function growMandatoryConnections(
  graph: Graph,
  grid: GridSize,
  config: GenerateConfig,
  rng: Rng
): void {
  const roomBlocked = buildRoomBlockedSet(graph);
  let nextCorridorId = 0;
  let nextDoorId = 0;

  const entranceId = graph.rooms[0].id;
  const connectedRoomIds = new Set<number>([entranceId]);
  const connectedCorridorIds = new Set<number>();

  let remaining = graph.rooms.filter((r) => r.id !== entranceId).map((r) => r.id);
  rng.shuffle(remaining); // tie-break order only - selection itself is by current scarcity, not this order

  let progressedThisCycle = true;
  while (remaining.length && progressedThisCycle) {
    progressedThisCycle = false;
    const stillRemaining: number[] = [];

    while (remaining.length) {
      const currentBlocked = routeBlockedSet(roomBlocked, graph.corridors);
      let bestIdx = 0;
      let bestCount = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const room = graph.rooms.find((r) => r.id === remaining[i])!;
        const count = roomLaunchPoints(room, grid).filter((p) => !currentBlocked.has(cellKey(p.cell[0], p.cell[1]))).length;
        if (count < bestCount) {
          bestCount = count;
          bestIdx = i;
        }
      }
      const roomId = remaining[bestIdx];
      remaining.splice(bestIdx, 1);

      const result = growConnectingBranch(
        graph,
        grid,
        config,
        rng,
        roomId,
        roomBlocked,
        nextCorridorId,
        nextDoorId,
        connectedRoomIds,
        connectedCorridorIds
      );
      if (!result) {
        stillRemaining.push(roomId);
        continue;
      }
      nextCorridorId = result.nextCorridorId;
      nextDoorId = result.nextDoorId;
      connectedRoomIds.add(roomId);
      connectedCorridorIds.add(result.branch.corridor.id);
      progressedThisCycle = true;
    }

    // A room that failed might still succeed once a later success this
    // cycle opened a new connected-network target for it - give it
    // another whole cycle rather than declaring it permanently stuck the
    // moment any single attempt fails.
    remaining = stillRemaining;
  }
  // Anything left in `remaining` after a full cycle makes zero progress is
  // left disconnected - `isConnected()` will catch this in tests/spot-
  // checks rather than this function silently declaring success it can't
  // back up.
  // Any ids still in `unresolved` after 3 passes are left disconnected -
  // `isConnected()` will catch this in tests/spot-checks rather than this
  // function silently declaring success it can't back up.
}

/** Non-mandatory extra connections between already-placed rooms, purely for loop/richness variety. Failures are fine - just skipped. */
function growLoops(graph: Graph, grid: GridSize, config: GenerateConfig, rng: Rng): void {
  const count = rng.randint(config.loopCountRange[0], config.loopCountRange[1]);
  if (count <= 0 || graph.rooms.length < 2) return;

  const roomBlocked = buildRoomBlockedSet(graph);
  let nextCorridorId = graph.corridors.length ? Math.max(...graph.corridors.map((c) => c.id)) + 1 : 0;
  let nextDoorId = graph.doors.length ? Math.max(...graph.doors.map((d) => d.id)) + 1 : 0;

  for (let i = 0; i < count; i++) {
    const room = rng.choice(graph.rooms);
    const result = growConnectingBranch(graph, grid, config, rng, room.id, roomBlocked, nextCorridorId, nextDoorId);
    if (!result) continue;
    nextCorridorId = result.nextCorridorId;
    nextDoorId = result.nextDoorId;
  }
}

/** A dead-end spur: starts at a room (via a door) or an existing corridor (flush), wanders for a rolled length, and never docks anywhere - a genuine dead end, subject to pruning afterward. */
function growSpur(
  graph: Graph,
  grid: GridSize,
  config: GenerateConfig,
  rng: Rng,
  roomBlocked: ReadonlySet<string>,
  nextCorridorId: number,
  nextDoorId: number
): { branch: CommittedBranch; nextCorridorId: number; nextDoorId: number } | null {
  const fromRoom = rng.random() < 0.6 || !graph.corridors.length;
  const maxLength = rng.randint(config.spurLengthRange[0], config.spurLengthRange[1]);
  const windy = rng.random() < config.corridorWindyChance;
  const occupied = new Set<string>();
  for (const c of graph.corridors) for (const key of c.cells) occupied.add(key);

  let start: LaunchPoint;
  let sourceRoom: GenRoom | null = null;
  let sourceCorridorId: number | null = null;

  if (fromRoom) {
    sourceRoom = rng.choice(graph.rooms);
    const points = roomLaunchPoints(sourceRoom, grid).filter((p) => !roomBlocked.has(cellKey(p.cell[0], p.cell[1])) && !occupied.has(cellKey(p.cell[0], p.cell[1])));
    if (!points.length) return null;
    start = rng.choice(points);
  } else {
    const junctions = [...corridorJunctionTargets(graph.corridors, roomBlocked, grid).entries()];
    if (!junctions.length) return null;
    const [key, target] = rng.choice(junctions);
    if (target.kind !== "corridor") return null; // corridorJunctionTargets never actually produces a "room" target - defensive only
    sourceCorridorId = target.corridorId;
    const [xs, ys] = key.split(",");
    start = { cell: [Number(xs), Number(ys)], boundaryCell: [Number(xs), Number(ys)], dir: [0, 0], z: 0 };
  }

  const path: [number, number][] = [start.cell];
  let dir = start.dir[0] !== 0 || start.dir[1] !== 0 ? start.dir : rng.choice(DIRECTIONS);
  const visited = new Set([cellKey(start.cell[0], start.cell[1])]);

  for (let i = 1; i < maxLength; i++) {
    const [cx, cy] = path[path.length - 1];
    const options = DIRECTIONS.filter(([dx, dy]) => {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.depth) return false;
      const k = cellKey(nx, ny);
      return !roomBlocked.has(k) && !occupied.has(k) && !visited.has(k);
    });
    if (!options.length) break;

    let next: [number, number];
    const keepGoing = options.some(([dx, dy]) => dx === dir[0] && dy === dir[1]);
    if (!windy && keepGoing && rng.random() < 0.75) {
      next = dir;
    } else {
      next = rng.choice(options);
    }
    dir = next;
    const nx = cx + next[0];
    const ny = cy + next[1];
    path.push([nx, ny]);
    visited.add(cellKey(nx, ny));
  }

  if (path.length < 2) return null;

  const height = pickCorridorHeight(rng);
  let width = 1;
  let doorPick: ReturnType<typeof doorAtLaunchPoint> | null = null;
  if (sourceRoom) {
    doorPick = doorAtLaunchPoint(start, sourceRoom, rng);
    width = pickCorridorWidth(doorPick.width === 2, config, rng);
  } else {
    width = pickCorridorWidth(false, config, rng);
  }

  const rawSegments = compactPathToSegments(path, start.z, height);
  const widened = widenSegments(rawSegments, width, roomBlocked, graph.corridors, grid, rng);
  const widthUsed = widthActuallyApplied(rawSegments, widened, width) ? width : 1;

  const startEndpoint: DungeonCorridorEndpoint = sourceRoom
    ? { kind: "room", id: sourceRoom.id }
    : { kind: "corridor", id: sourceCorridorId! };
  const corridor: GenCorridor = {
    id: nextCorridorId,
    connects: [startEndpoint, { kind: "open" }],
    width: widthUsed,
    segments: widened,
    cells: cellsOf(widened),
  };
  graph.corridors.push(corridor);
  nextCorridorId++;

  let door: GenDoor | null = null;
  if (sourceRoom && doorPick) {
    door = {
      id: nextDoorId,
      connects: [{ kind: "room", id: sourceRoom.id }, { kind: "corridor", id: corridor.id }],
      cellA: doorPick.cellA,
      cellB: doorPick.cellB,
      material: rng.choice(config.doorMaterials),
      secret: rng.random() < config.secretDoorChance,
      width: doorPick.width,
    };
    graph.doors.push(door);
    nextDoorId++;
  }

  return { branch: { corridor, door }, nextCorridorId, nextDoorId };
}

function growSpurs(graph: Graph, grid: GridSize, config: GenerateConfig, rng: Rng): GenCorridor[] {
  const count = rng.randint(config.spurCountRange[0], config.spurCountRange[1]);
  if (count <= 0) return [];

  const roomBlocked = buildRoomBlockedSet(graph);
  let nextCorridorId = graph.corridors.length ? Math.max(...graph.corridors.map((c) => c.id)) + 1 : 0;
  let nextDoorId = graph.doors.length ? Math.max(...graph.doors.map((d) => d.id)) + 1 : 0;

  const spurs: GenCorridor[] = [];
  for (let i = 0; i < count; i++) {
    const result = growSpur(graph, grid, config, rng, roomBlocked, nextCorridorId, nextDoorId);
    if (!result) continue;
    nextCorridorId = result.nextCorridorId;
    nextDoorId = result.nextDoorId;
    spurs.push(result.branch.corridor);
  }
  return spurs;
}

/**
 * Prunes `deadEndPruneFraction` of the generated spurs, preferring to
 * remove the SHORT ones first and keep the long ones (Room Corridor Rework
 * Plan.md decision 6: "nothing interesting fits" describes the problem
 * with short dead ends, not a rule that survivors must be short). Removes
 * each pruned spur's own door too, since a door leading to deleted floor
 * would otherwise open onto nothing.
 */
function pruneDeadEnds(graph: Graph, spurs: GenCorridor[], config: GenerateConfig): void {
  if (!spurs.length) return;
  const bySize = [...spurs].sort((a, b) => a.cells.size - b.cells.size);
  const pruneCount = Math.round(bySize.length * config.deadEndPruneFraction);
  const toPrune = new Set(bySize.slice(0, pruneCount).map((c) => c.id));
  if (!toPrune.size) return;

  graph.corridors = graph.corridors.filter((c) => !toPrune.has(c.id));
  graph.doors = graph.doors.filter((d) => {
    for (const end of d.connects) {
      if (end.kind === "corridor" && toPrune.has(end.id)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

function pickFloorsDown(rng: Rng): number {
  return rng.choices([1, 2, 3], [0.8, 0.15, 0.05]);
}

function stairBoxSize(style: string, rng: Rng): [number, number] {
  if (style === "spiral") return [2, 2];
  return rng.random() < 0.5 ? [1, rng.randint(2, 3)] : [rng.randint(2, 3), 1];
}

function pickEmbeddedStairRoom(graph: Graph, rng: Rng): GenRoom | null {
  const already = new Set(graph.stairs.filter((s) => s.embedded).map((s) => s.roomId));
  const eligible = graph.rooms.filter((r) => r.w >= 2 && r.d >= 2 && !already.has(r.id));
  if (!eligible.length) return null;
  return rng.choice(eligible);
}

function placeEmbeddedStair(room: GenRoom, existingRegions: GenRegion[], style: string, rng: Rng): Box | null {
  let [w, d] = stairBoxSize(style, rng);
  w = Math.min(w, room.w);
  d = Math.min(d, room.d);
  if (w >= room.w && d >= room.d) {
    if (room.w <= 1 || room.d <= 1) return null;
    w = Math.max(1, room.w - 1);
    d = Math.max(1, room.d - 1);
  }

  for (let i = 0; i < 10; i++) {
    const x = room.x + rng.randint(0, room.w - w);
    const y = room.y + rng.randint(0, room.d - d);
    const box: Box = { x, y, z: room.z, w, d, h: Math.min(2, room.h) };
    if (existingRegions.every((r) => !overlaps(box, r.box))) return box;
  }
  return null;
}

/** Freestanding stairs use a fixed 10' ceiling, like corridors - utility space, not subject to the room ceiling-variety weighting. */
const FREESTANDING_STAIR_HEIGHT = 2;

function addStairs(graph: Graph, grid: GridSize, config: GenerateConfig, rng: Rng): void {
  const count = rng.randint(config.stairCountRange[0], config.stairCountRange[1]);
  if (count <= 0 || !graph.rooms.length) return;

  const roomBlocked = buildRoomBlockedSet(graph);
  let nextStairId = 0;
  let nextCorridorId = graph.corridors.length ? Math.max(...graph.corridors.map((c) => c.id)) + 1 : 0;
  let nextDoorId = graph.doors.length ? Math.max(...graph.doors.map((d) => d.id)) + 1 : 0;

  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < config.maxAttempts) {
    attempts++;
    const style: "spiral" | "regular" = rng.random() < config.spiralStairChance ? "spiral" : "regular";
    const floorsDown = pickFloorsDown(rng);

    if (rng.random() < config.stairEmbeddedChance) {
      const room = pickEmbeddedStairRoom(graph, rng);
      if (!room) continue;
      const box = placeEmbeddedStair(room, regionsFor(graph, room.id), style, rng);
      if (!box) continue;
      graph.stairs.push({ id: nextStairId, box, style, floorsDown, roomId: room.id, embedded: true });
      nextStairId++;
      placed++;
      continue;
    }

    // Freestanding: pick a random face off a random room and drop the
    // stair right at that launch point (same WALL_GAP + door mechanism
    // every other room-to-corridor attach uses), oriented so its long axis
    // runs away from the room rather than along the wall.
    const base = rng.choice(graph.rooms);
    const sources = roomLaunchPoints(base, grid).filter((p) => !roomBlocked.has(cellKey(p.cell[0], p.cell[1])));
    if (!sources.length) continue;
    const source = rng.choice(sources);

    let [w, d] = stairBoxSize(style, rng);
    if (source.dir[0] !== 0 && w < d) [w, d] = [d, w]; // horizontal face - run lengthwise away from the room
    if (source.dir[1] !== 0 && d < w) [w, d] = [d, w]; // vertical face - same, other axis

    const stairX = source.dir[0] > 0 ? source.cell[0] : source.dir[0] < 0 ? source.cell[0] - w + 1 : source.cell[0];
    const stairY = source.dir[1] > 0 ? source.cell[1] : source.dir[1] < 0 ? source.cell[1] - d + 1 : source.cell[1];
    const stairBox: Box = { x: stairX, y: stairY, z: source.z, w, d, h: FREESTANDING_STAIR_HEIGHT };
    const collidesWithCorridors = graph.corridors.some((c) => c.segments.some((seg) => marginOverlaps(stairBox, WALL_GAP, seg)));
    if (!isWithin(stairBox, grid) || collidesWithRoomsAndStairs(graph, [stairBox]) || collidesWithCorridors) continue;

    const doorPick = doorAtLaunchPoint(source, base, rng);
    graph.stairs.push({ id: nextStairId, box: stairBox, style, floorsDown, roomId: base.id, embedded: false });
    // A freestanding stair has no `DungeonConnection` kind of its own (only
    // "room"/"corridor" exist) - the door's far side is documented as
    // leading to the stair via its own `roomId`/`box`, not a real second
    // room, so both ends reuse `base.id` here rather than inventing a
    // misleading id.
    const door: GenDoor = {
      id: nextDoorId,
      connects: [{ kind: "room", id: base.id }, { kind: "room", id: base.id }],
      cellA: doorPick.cellA,
      cellB: doorPick.cellB,
      material: rng.choice(config.doorMaterials),
      secret: rng.random() < config.secretDoorChance,
      width: 1,
    };
    graph.doors.push(door);
    nextDoorId++;
    nextStairId++;
    placed++;
  }
}

// ---------------------------------------------------------------------------
// Connectivity + distance (shared by isConnected and special-kind ranking)
// ---------------------------------------------------------------------------

function buildWalkableCells(data: DungeonFloorData): { cells: Set<string>; roomOwner: Map<string, number> } {
  const cells = new Set<string>();
  const roomOwner = new Map<string, number>();

  const addBox = (box: DungeonBox, ownerRoomId?: number) => {
    for (let yy = box.y; yy < box.y + box.d; yy++) {
      for (let xx = box.x; xx < box.x + box.w; xx++) {
        const key = cellKey(xx, yy);
        cells.add(key);
        if (ownerRoomId !== undefined && !roomOwner.has(key)) roomOwner.set(key, ownerRoomId);
      }
    }
  };

  for (const room of data.rooms) addBox(room, room.id);
  for (const region of data.regions) addBox(region.box, region.roomId);
  for (const corridor of data.corridors) for (const seg of corridor.segments) addBox(seg);
  for (const stair of data.stairs) if (!stair.embedded) addBox(stair.box);
  for (const door of data.doors) {
    for (const [gx, gy] of doorGapCells(door)) cells.add(cellKey(gx, gy));
  }

  return { cells, roomOwner };
}

function bfsCellDistances(cells: ReadonlySet<string>, starts: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const c of starts) {
    if (cells.has(c) && !dist.has(c)) {
      dist.set(c, 0);
      queue.push(c);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const [xs, ys] = cur.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of DIRECTIONS) {
      const nk = cellKey(x + dx, y + dy);
      if (!cells.has(nk) || dist.has(nk)) continue;
      dist.set(nk, dist.get(cur)! + 1);
      queue.push(nk);
    }
  }
  return dist;
}

/**
 * True if every placed room is reachable from the first room - exported
 * for tests. Works from the exported `DungeonFloorData` shape via real
 * cell-level reachability (every room/region/corridor-segment/freestanding-
 * stair interior cell, plus every door's gap cells), not a `connects`-graph
 * traversal - this is what actually changed under the 2026-08-01 rework
 * (see Room Corridor Rework Plan.md decision 2): corridor-to-corridor
 * junctions have no door and no `connects` edge a graph walk could follow,
 * but they ARE flush-adjacent cells, so cell-level BFS sees straight
 * through them for free.
 */
export function isConnected(data: DungeonFloorData): boolean {
  if (!data.rooms.length) return true;
  const { cells, roomOwner } = buildWalkableCells(data);
  const start = cellKey(data.rooms[0].x, data.rooms[0].y);
  const dist = bfsCellDistances(cells, [start]);

  const reached = new Set<number>();
  for (const key of dist.keys()) {
    const owner = roomOwner.get(key);
    if (owner !== undefined) reached.add(owner);
  }
  return data.rooms.every((r) => reached.has(r.id));
}

function roomDistancesFromEntrance(data: DungeonFloorData, entranceId: number): Map<number, number> {
  const { cells, roomOwner } = buildWalkableCells(data);
  const entrance = data.rooms.find((r) => r.id === entranceId);
  if (!entrance) return new Map();
  const dist = bfsCellDistances(cells, [cellKey(entrance.x, entrance.y)]);

  const perRoom = new Map<number, number>();
  for (const [key, d] of dist) {
    const owner = roomOwner.get(key);
    if (owner === undefined) continue;
    if (!perRoom.has(owner) || perRoom.get(owner)! > d) perRoom.set(owner, d);
  }
  return perRoom;
}

function assignSpecialKindsOnData(data: DungeonFloorData, specialKinds: string[], entranceId = 0): DungeonFloorData {
  if (!specialKinds.length) return data;
  const distances = roomDistancesFromEntrance(data, entranceId);
  const candidates = data.rooms.filter((r) => r.id !== entranceId);
  candidates.sort((a, b) => (distances.get(b.id) ?? -1) - (distances.get(a.id) ?? -1));

  const kindById = new Map<number, string>();
  specialKinds.forEach((kind, i) => {
    const room = candidates[i];
    if (room) kindById.set(room.id, kind);
  });
  if (!kindById.size) return data;

  return { ...data, rooms: data.rooms.map((r) => (kindById.has(r.id) ? { ...r, kind: kindById.get(r.id)! } : r)) };
}

function markExtraEntrancesOnData(data: DungeonFloorData, grid: { width: number; depth: number }, config: GenerateConfig, rng: Rng): DungeonFloorData {
  const count = rng.randint(config.extraEntranceCountRange[0], config.extraEntranceCountRange[1]);
  if (count <= 0) return data;

  const candidates = data.rooms.filter(
    (r) => r.kind !== "entrance" && (r.x === 0 || r.x + r.w === grid.width || r.y === 0 || r.y + r.d === grid.depth)
  );
  rng.shuffle(candidates);
  const idsToMark = new Set(candidates.slice(0, count).map((r) => r.id));
  if (!idsToMark.size) return data;

  return { ...data, rooms: data.rooms.map((r) => (idsToMark.has(r.id) ? { ...r, kind: "entrance" } : r)) };
}

// ---------------------------------------------------------------------------
// Export to DungeonFloorData
// ---------------------------------------------------------------------------

/**
 * Cells of clearance left around the whole generated area on export, so
 * the outer wall ring (which extends 1 cell past any edge-touching room)
 * lands inside the exported `grid` bounds instead of spilling past them.
 */
const WALL_EXPORT_MARGIN = 1;

function shiftBox(b: Box, margin: number): Box {
  return { ...b, x: b.x + margin, y: b.y + margin };
}

function shiftCell(cell: [number, number, number], margin: number): [number, number, number] {
  return [cell[0] + margin, cell[1] + margin, cell[2]];
}

function toDungeonFloorData(graph: Graph): DungeonFloorData {
  const m = WALL_EXPORT_MARGIN;
  const rooms: DungeonRoom[] = graph.rooms.map((r) => ({ id: r.id, kind: r.kind, ...toBox(shiftBox(r, m)) }));
  const corridors: DungeonCorridor[] = graph.corridors.map((c) => ({
    id: c.id,
    connects: c.connects,
    width: c.width,
    segments: c.segments.map((s) => toBox(shiftBox(s, m))),
  }));
  const doors: DungeonDoor[] = graph.doors.map((d) => ({
    id: d.id,
    connects: d.connects,
    cellA: shiftCell(d.cellA, m),
    cellB: shiftCell(d.cellB, m),
    material: d.material,
    secret: d.secret,
    width: d.width,
  }));
  const stairs: DungeonStair[] = graph.stairs.map((s) => ({
    id: s.id,
    roomId: s.roomId,
    embedded: s.embedded,
    style: s.style,
    floorsDown: s.floorsDown,
    box: toBox(shiftBox(s.box, m)),
  }));
  const regions: DungeonRegion[] = graph.regions.map((r) => ({
    id: r.id,
    roomId: r.roomId,
    box: { ...toBox(shiftBox(r.box, m)), kind: r.kind },
    extension: r.extension,
  }));

  return {
    grid: { width: graph.grid.width + 2 * m, depth: graph.grid.depth + 2 * m, height: graph.grid.height },
    rooms,
    corridors,
    doors,
    stairs,
    regions,
    finalized: false,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a fresh flat floor. This is the whole "Generate Random Map"
 * button, minus the Obsidian file I/O (see main.ts) - pure function in,
 * `DungeonFloorData` out, so it's fully unit-testable without a vault or a
 * WebGL context.
 */
export function generateFloor(config: GenerateConfig): DungeonFloorData {
  const rng = new Rng(config.seed);
  const grid: GridSize = { width: config.gridWidth, depth: config.gridDepth, height: config.gridHeight };
  const graph: Graph = { grid, rooms: [], corridors: [], regions: [], doors: [], stairs: [] };

  placeRooms(graph, grid, config, rng);
  growMandatoryConnections(graph, grid, config, rng);
  growLoops(graph, grid, config, rng);
  const spurs = growSpurs(graph, grid, config, rng);
  pruneDeadEnds(graph, spurs, config);
  addStairs(graph, grid, config, rng);

  let data = toDungeonFloorData(graph);
  data = assignSpecialKindsOnData(data, config.specialKinds);
  data = markExtraEntrancesOnData(data, grid, config, rng);
  return data;
}
