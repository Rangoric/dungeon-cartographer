// Pure geometry + color logic for turning parsed floor data into things a
// renderer can draw. Deliberately free of Three.js/Obsidian imports, same
// reasoning as rooms.ts - this is the seam that's unit-testable without a
// WebGL context; main.ts is the thin Three.js-consuming layer on top.
//
// Coordinate mapping (see Dungeon Data Format.md): the dungeon grid's
// vertical axis is `z`; Three.js is Y-up. So dungeon (x, y, z) -> world
// (x, z, y).
//
// v2 (2026-07-07, see Renderer Visual Issues.md): rooms/corridors used to
// render as solid filled blocks, which hid adjacency between rooms and
// made doors invisible. Now each room/corridor is a thin floor, a thin
// ceiling, and thin wall panels - with gaps left wherever a door sits, or
// wherever two boxes belong to the same "entity" (a room and its own
// regions, or a corridor's own segments) at the SAME z, since there's no
// real wall there.
//
// v3 (2026-07-30, see Room Floor Regions.md): the old `lobes`/`platforms`
// fields are gone, replaced by a unified `regions` list. An extension
// region (footprint pokes outside its room, same z/h) joins its room's
// entity exactly like the old lobes did. A level-change region (footprint
// sits inside its room, different z/h - a platform or recess) also joins
// its room's entity, but where it meets a same-entity neighbor at a
// DIFFERENT z, the seam is no longer a flat-out gap - it's a riser wall
// spanning just the height difference between the two floor levels (see
// `unitWallSpan` below), per the "connecting wall between differing floor
// heights" decision.
//
// v4 (2026-07-30): the render-only vertical offset that used to shift all
// content up by 10' (reserving room below y=0 "for a future sunken/lower
// area") is gone. `growth.py` now gives the floor's own baseline a real
// `z` above the grid's true floor (`GrowthConfig.baseline_z`, see Room
// Floor Regions.md), so a recess can already dip toward z=0 in the actual
// data - the render-layer fudge that used to stand in for this is no
// longer needed. World Y now equals dungeon z directly; the y=0
// GridHelper (the tabletop reference) is the grid's own true floor, and a
// deep-enough recess renders flush with it.
//
// v5 (2026-07-31, see Simplification Plan.md): platform/recess (level-
// change) regions are gone from generation entirely - too hard to notice
// at the table for what they cost. A region is now always an extension
// (a lobe, same z/h as its room), so the v3 riser-wall mechanic and the
// per-box wallColor/floorColor split (added the same day, to stop a
// level-change region's own color from fighting with its room's wall)
// both became dead code and are removed here rather than left dormant -
// every box in an entity always shares one color and one z now, so a
// same-entity seam is unconditionally a flush, open seam again (back to
// the simpler v2 behavior). `PLATFORM_COLOR`/`RECESS_COLOR`/`regionColor()`
// are gone too, since there's no longer a distinct kind of region to color.
//
// v6 (2026-07-31, see Block Walls Plan.md step 4): walls stop being thin
// per-entity panels and become full grid-cube blocks, Minecraft-style -
// generate.ts now leaves a mandatory 1-cell gap between any two different
// entities' interiors (the future wall cell), so walls are derived here as
// a genuinely GLOBAL, floor-wide computation rather than a per-entity one:
// any (x, y) cell that isn't part of any room/corridor/region/freestanding-
// stair interior, but sits 4-adjacent to one, is a wall-block cell - full
// height matches the tallest interior it touches (so it fully encloses
// whichever neighbor is taller, even if the cell also borders a shorter
// one or open space), except a door's gap cell (`doorGapCell()`), which is
// left out entirely - an open passage. Since a wall cell can legitimately
// border two *different* entities at once (that's the point - a single
// shared wall, not two stacked ones), it can't sensibly be colored to
// "belong" to either side anymore, so walls are now a uniform neutral
// `WALL_COLOR` instead of inheriting their owning entity's color. The old
// per-entity `wallsForBox`/`unitWallSpan`/side-run-merging machinery, the
// `Entity`/`EntityBox` grouping it needed, and `WALL_THICKNESS` are all
// gone - floor/ceiling planes are still emitted per box (unchanged), just
// no longer via an `Entity` wrapper, since nothing about them needed the
// grouping in the first place.
//
// v6.1 (2026-07-31, same-day follow-up after seeing a real render): two
// fixes to `wallCells()`. First, dropped the grid-bounds check - a room
// flush against the map's true edge now gets a real wall block there too
// (extending one cell past the nominal grid), instead of leaving that side
// open on the theory that "the map boundary is the wall" - looked like a
// gap once actually on screen, not like an edge of the buildable area.
// Second, added a diagonal corner-fill pass - the cell diagonal from a
// room's corner, where the two wall runs meeting there left a one-cell
// notch unfilled. Both changes mirrored into `generate.ts`'s
// `wallRingCells()` too, to keep the "same derivation" claim true.
//
// v6.2 (2026-07-31): a door's gap cell had no floor at all - it belongs to
// no room/corridor/region box, so `coloredBoxesFromFloor` never covered
// it, leaving a literal hole under every door. `doorGapFloorSpec()` now
// patches that cell in with a `WALL_COLOR` floor tile (see its own doc
// comment for why that color, for now). Also added `DOOR_LEGEND`, the
// single source of truth for the on-screen door-color legend in main.ts.
// Same-day follow-up: `doorGapCeilingSpec()` does the equivalent patch for
// the ceiling-grid overlay (main.ts's buildCeilingGridMesh reads the
// `ceilings` list for position/size, same as it does for rooms/corridors)
// - a door was otherwise the one gap in that grid too. Height matches the
// taller of the door's two interior-facing cells, same rule an ordinary
// wall block uses.
//
// Same-day follow-up #2: `doorBoxSpec()` now uses that same height (via
// the shared `doorNeighborHeight()` helper) instead of a fixed 0.8-unit
// slab, so the door marker itself spans floor to ceiling - against a full
// grid-cube wall (2-4 units tall), a fixed-height door read as a small
// square lost partway up a much taller gap. `doorBoxSpec()` now takes the
// `interior` map as a parameter to look this up (a small API break from
// its original single-argument form, but it has no external callers).
//
// Same-day follow-up #3: doors can now be wider than one cell
// (`DungeonDoor.width`, set by `generate.ts`'s `pickDoorWidth()`).
// `doorGapSpan()` computes the door's full grid-cell rectangle from
// `doorGapCell()` + `width`; `doorGapFloorSpec()`/`doorGapCeilingSpec()`/
// `doorBoxSpec()` all use it instead of assuming a single cell.
// `cutDoorGaps()` uses `dungeonData.ts`'s `doorGapCells()` (the per-cell
// list, not the merged span) since wall removal is keyed per-cell.

import type {
  DungeonBox,
  DungeonDoor,
  DungeonFloorData,
} from "./dungeonData";
import { doorGapCell, doorGapCells } from "./dungeonData";

export type BoxKind = "stairEmbedded" | "stairFreestanding" | "door";

export interface BoxSpec {
  kind: BoxKind;
  /** World position: [x, y (up), z]. */
  center: [number, number, number];
  /** World size: [width, height (up), depth]. */
  size: [number, number, number];
  /** Mesh colour as a 0xRRGGBB integer. */
  color: number;
  /** Defaults to fully opaque when omitted. */
  opacity?: number;
}

export interface WallSpec {
  kind: "wall";
  center: [number, number, number];
  size: [number, number, number];
  color: number;
}

export interface PlaneSpec {
  kind: "floor" | "ceiling";
  center: [number, number, number];
  /** World size along the two horizontal axes: [width (x), depth (z)]. */
  size: [number, number];
  /**
   * Which vertical side the plane should be visible from. A floor is
   * visible from above (facing "up") and disappears in a bottom-up view;
   * a ceiling is visible from below (facing "down") and disappears in a
   * top-down view - so a top-down camera can see straight through a
   * room's ceiling to its floor. See Renderer Visual Issues.md for the
   * reasoning (and the alternate reading, if this turns out backwards).
   */
  facing: "up" | "down";
  color: number;
}

export interface FloorRenderSpecs {
  walls: WallSpec[];
  floors: PlaneSpec[];
  ceilings: PlaneSpec[];
  /** Stairs and doors - small supplementary features still rendered as
   * simple marker boxes rather than wall/floor/ceiling shells. Regions
   * (extensions) get real floor/ceiling/wall treatment instead of a
   * marker box - see `coloredBoxesFromFloor`. */
  markers: BoxSpec[];
}

const ROOM_COLOR = 0x4a6fa5; // blue
const ENTRANCE_COLOR = 0x4caf6e; // green
const SPECIAL_ROOM_COLOR = 0xd94a4a; // red - anything that isn't plain "room"/"entrance" (e.g. a boss room)
const CORRIDOR_COLOR = 0x8a8a8a; // grey
const STAIR_COLOR = 0x9b59b6; // purple

const DOOR_MATERIAL_COLORS: Record<string, number> = {
  wood: 0x8b5a2b,
  metal: 0xaaaaaa,
  stone: 0x777777,
};
const SECRET_DOOR_COLOR = 0xff44ff; // always stands out - this is a DM tool, secrets should be visible here

/** Uniform color for every wall block - see the v6 module-header note for why walls can no longer inherit an owning entity's color. Exported so tests can assert against it directly, same spirit as `roomColor()`/`doorColor()`. */
export const WALL_COLOR = 0x5a5a5a;

/** Door-color legend entries, in display order - drives the on-screen legend (added 2026-07-31) so the door colors set by `doorColor()` above are actually explained somewhere instead of just memorized. Kept as a single source of truth here rather than hand-duplicated in main.ts. */
export const DOOR_LEGEND: { label: string; color: number }[] = [
  { label: "Wood door", color: DOOR_MATERIAL_COLORS.wood },
  { label: "Metal door", color: DOOR_MATERIAL_COLORS.metal },
  { label: "Stone door", color: DOOR_MATERIAL_COLORS.stone },
  { label: "Secret door", color: SECRET_DOOR_COLOR },
];

/** Box world-space center + size, given a grid-cube box (see mapping above). */
export function boxToWorld(box: DungeonBox): { center: [number, number, number]; size: [number, number, number] } {
  return {
    center: [box.x + box.w / 2, box.z + box.h / 2, box.y + box.d / 2],
    size: [box.w, box.h, box.d],
  };
}

export function roomColor(kind: string): number {
  if (kind === "entrance") return ENTRANCE_COLOR;
  if (kind === "room") return ROOM_COLOR;
  return SPECIAL_ROOM_COLOR;
}

export function doorColor(material: string, secret: boolean): number {
  if (secret) return SECRET_DOOR_COLOR;
  return DOOR_MATERIAL_COLORS[material] ?? 0xffffff;
}

/**
 * A door doesn't carry its own height in the data - it's just two grid
 * cells framing a gap. Height is instead borrowed from whichever of the
 * door's two interior-facing cells is taller, read from the same
 * `interior` map `wallCells()` builds - same rule an ordinary wall block
 * uses when it separates two differently-tall neighbors. The `?? 2`
 * fallback (10') should be unreachable - a door's cellA/cellB always sit
 * inside a real room/corridor interior - but keeps this from producing
 * NaN geometry if that's ever not true.
 */
function doorNeighborHeight(door: DungeonDoor, interior: Map<string, number>): number {
  const [ax, ay] = door.cellA;
  const [bx, by] = door.cellB;
  return Math.max(interior.get(cellKey(ax, ay)) ?? 2, interior.get(cellKey(bx, by)) ?? 2);
}

/**
 * The grid-cell rectangle a door's gap occupies - `doorGapCell()`'s single
 * cell, widened by `door.width` along whichever axis the shared wall runs
 * (perpendicular to the axis `cellA`/`cellB` differ on). A width-1 door is
 * a 1x1 rectangle, same as before 2026-07-31. Used by the floor/ceiling
 * patches and the door marker box below, all of which need the same
 * bounding rectangle rather than the individual cell list `doorGapCells()`
 * (dungeonData.ts) provides for wall-cutting.
 */
function doorGapSpan(door: DungeonDoor): { x0: number; y0: number; x1: number; y1: number; z: number } {
  const [gx, gy, gz] = doorGapCell(door);
  const width = Math.max(1, door.width ?? 1);
  const crossesX = door.cellA[0] !== door.cellB[0];
  return crossesX
    ? { x0: gx, y0: gy, x1: gx + 1, y1: gy + width, z: gz } // wall runs north-south - widens along y
    : { x0: gx, y0: gy, x1: gx + width, y1: gy + 1, z: gz }; // wall runs east-west - widens along x
}

/**
 * A door doesn't carry its own footprint size either - render it as a
 * flattened box straddling the shared wall gap, thin along whichever
 * dungeon axis the two cells differ on, but now (2026-07-31) full-height -
 * floor to ceiling, using `doorNeighborHeight` above - instead of a fixed
 * 0.8-unit-tall slab. Against a full grid-cube wall (which can be 2-4
 * units tall), a fixed-height door read as a small square lost partway up
 * a much taller wall gap; spanning the whole gap makes it obvious at a
 * glance where every passage actually is. Same-day follow-up: also spans
 * `door.width` cells across (via `doorGapSpan()`) instead of a fixed 0.8
 * units, for the 10' double doors `pickDoorWidth()` can now produce - a
 * small fixed 0.1-unit margin off the wall on each side keeps a visible
 * gap regardless of how wide the door itself is.
 */
export function doorBoxSpec(door: DungeonDoor, interior: Map<string, number>): BoxSpec {
  const span = doorGapSpan(door);
  const height = doorNeighborHeight(door, interior);
  const center: [number, number, number] = [(span.x0 + span.x1) / 2, span.z + height / 2, (span.y0 + span.y1) / 2];
  const spanWidth = Math.max(span.x1 - span.x0, span.y1 - span.y0) - 0.2;

  const dx = Math.abs(door.cellA[0] - door.cellB[0]);
  const dy = Math.abs(door.cellA[1] - door.cellB[1]);
  // dz (vertical) is the remaining case - doors don't currently occur on a
  // vertical face, but fall back sensibly if one ever does (no ceiling to
  // reach for a horizontal hatch, so it keeps its old flattened shape).
  let size: [number, number, number];
  if (dx > 0) {
    size = [0.15, height, spanWidth]; // wall runs north-south (dungeon y) - thin along world x
  } else if (dy > 0) {
    size = [spanWidth, height, 0.15]; // wall runs east-west (dungeon x) - thin along world z
  } else {
    size = [0.8, 0.15, 0.8]; // thin along vertical
  }

  return { kind: "door", center, size, color: doorColor(door.material, door.secret) };
}

// --- Walls: full grid-cube blocks, derived globally across the whole
// floor (not per-entity) - see the v6 module-header note. -----------------

interface FootprintBox {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/** A box plus the single color it renders in (floor/ceiling only now - see the v6 module-header note on why walls dropped their own color field). */
interface ColoredBox extends FootprintBox {
  color: number;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Every interior (x, y) cell on the whole floor, mapped to the height of
 * whichever box occupies it - a room, an extension region, a corridor
 * segment, or a freestanding stair (embedded stairs sit inside their own
 * room's footprint, not a separate interior). Every box here is flush at
 * z=0 in the current flat generator, so height alone is enough to size a
 * wall block later; if a future generator ever stacks boxes at different
 * z within one floor, this would need to carry z too.
 */
function buildInteriorMap(data: DungeonFloorData): Map<string, number> {
  const interior = new Map<string, number>();
  const addBox = (box: DungeonBox) => {
    for (let yy = box.y; yy < box.y + box.d; yy++) {
      for (let xx = box.x; xx < box.x + box.w; xx++) {
        interior.set(cellKey(xx, yy), box.h);
      }
    }
  };
  for (const room of data.rooms) addBox(room);
  for (const region of data.regions) addBox(region.box);
  for (const corridor of data.corridors) for (const seg of corridor.segments) addBox(seg);
  for (const stair of data.stairs) if (!stair.embedded) addBox(stair.box);
  return interior;
}

const NEIGHBOR_OFFSETS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONAL_OFFSETS: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Every wall-block cell, mapped to the height it should render at (the
 * *tallest* interior cell it touches, so it fully encloses whichever
 * neighbor is taller even where the other side is shorter or absent). Two
 * passes:
 *
 * - **Orthogonal ring** - any cell 4-adjacent to an interior cell, itself
 *   not interior. **No grid-bounds check** (2026-07-31 follow-up to Block
 *   Walls Plan.md) - a room flush against the map's true edge still gets a
 *   real wall block there, extending one cell past the nominal grid rather
 *   than leaving that side open ("off the table" - the original call to
 *   let the map boundary itself stand in for a wall read as a gap once a
 *   real floor was on screen, not as "the edge of the built area").
 * - **Diagonal corner fill** - the cell diagonal from an interior cell,
 *   where both orthogonal cells between them are real walls (not
 *   interior) - without this, two perpendicular wall runs meeting at a
 *   room's corner leave a one-cell notch at the true corner point. Skipped
 *   where either orthogonal neighbor IS interior, so this only closes
 *   genuine convex corners, not concave ones or places where the diagonal
 *   cell is itself part of some other box's interior.
 *
 * Same derivation `generate.ts`'s `wallRingCells()` uses for density
 * accounting, kept independent here since this module stays free of any
 * dependency on `generate.ts`.
 */
function wallCells(interior: Map<string, number>): Map<string, number> {
  const walls = new Map<string, number>();

  for (const [key, h] of interior) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nkey = cellKey(x + dx, y + dy);
      if (interior.has(nkey)) continue;
      walls.set(nkey, Math.max(walls.get(nkey) ?? 0, h));
    }
  }

  for (const [key, h] of interior) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of DIAGONAL_OFFSETS) {
      const diagKey = cellKey(x + dx, y + dy);
      if (interior.has(diagKey)) continue;
      const orthoAKey = cellKey(x + dx, y);
      const orthoBKey = cellKey(x, y + dy);
      if (interior.has(orthoAKey) || interior.has(orthoBKey)) continue;
      walls.set(diagKey, Math.max(walls.get(diagKey) ?? 0, h));
    }
  }

  return walls;
}

/**
 * The floor patch under a door's gap. A door's gap belongs to no room/
 * corridor/region box - it's carved out of what would otherwise be wall
 * blocks (see `cutDoorGaps`) - so without this it has no floor at all, a
 * literal hole under every door. Colored `WALL_COLOR` for now rather than
 * picking a side's room/corridor color, since a door can straddle two
 * differently-colored entities and there's no obviously "correct" side to
 * inherit from yet. Revisit if that starts to look wrong at the table.
 * Spans the door's full `width` (via `doorGapSpan()`) as one merged plane
 * rather than one tile per cell, so the grid texture tiles across it
 * cleanly instead of showing a seam down the middle of a wide door.
 */
function doorGapFloorSpec(door: DungeonDoor): PlaneSpec {
  const span = doorGapSpan(door);
  const center: [number, number] = [(span.x0 + span.x1) / 2, (span.y0 + span.y1) / 2];
  return {
    kind: "floor",
    center: [center[0], span.z, center[1]],
    size: [span.x1 - span.x0, span.y1 - span.y0],
    facing: "up",
    color: WALL_COLOR,
  };
}

/**
 * The ceiling-grid patch above a door's gap, same idea as
 * `doorGapFloorSpec` above but for the ceiling grid overlay - without this
 * a door was the one spot on the map with no grid line marking overhead,
 * same "literal hole" problem the floor had. Height via `doorNeighborHeight`
 * - same rule `doorBoxSpec()` uses to size the door itself, and an ordinary
 * wall block uses against differing neighbor heights. Spans the door's full
 * `width`, same reasoning as `doorGapFloorSpec()`.
 */
function doorGapCeilingSpec(door: DungeonDoor, interior: Map<string, number>): PlaneSpec {
  const span = doorGapSpan(door);
  const center: [number, number] = [(span.x0 + span.x1) / 2, (span.y0 + span.y1) / 2];
  const h = doorNeighborHeight(door, interior);
  return {
    kind: "ceiling",
    center: [center[0], span.z + h, center[1]],
    size: [span.x1 - span.x0, span.y1 - span.y0],
    facing: "down",
    color: WALL_COLOR,
  };
}

/** Removes every one of a door's gap cells from the wall map in place (see `doorGapCells()`, dungeonData.ts - one per unit of `door.width`) - the wall blocks they'd otherwise occupy are an open passage instead. */
function cutDoorGaps(walls: Map<string, number>, doors: DungeonDoor[]): void {
  for (const door of doors) {
    for (const [gx, gy] of doorGapCells(door)) {
      walls.delete(cellKey(gx, gy));
    }
  }
}

function wallSpecsFromCells(walls: Map<string, number>): WallSpec[] {
  const specs: WallSpec[] = [];
  for (const [key, h] of walls) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    specs.push({
      kind: "wall",
      center: [x + 0.5, h / 2, y + 0.5],
      size: [1, h, 1],
      color: WALL_COLOR,
    });
  }
  return specs;
}

function floorCeilingForBox(box: ColoredBox): { floor: PlaneSpec; ceiling: PlaneSpec } {
  const floorY = box.z;
  const ceilingY = box.z + box.h;
  const center: [number, number] = [box.x + box.w / 2, box.y + box.d / 2];
  return {
    floor: { kind: "floor", center: [center[0], floorY, center[1]], size: [box.w, box.d], facing: "up", color: box.color },
    ceiling: { kind: "ceiling", center: [center[0], ceilingY, center[1]], size: [box.w, box.d], facing: "down", color: box.color },
  };
}

function regionsForRoom(data: DungeonFloorData, roomId: number): { box: DungeonBox & { kind: string } }[] {
  return data.regions.filter((r) => r.roomId === roomId);
}

/** Every room/region/corridor-segment box, each carrying the color it should render its floor+ceiling in. */
function coloredBoxesFromFloor(data: DungeonFloorData): ColoredBox[] {
  const boxes: ColoredBox[] = [];
  for (const room of data.rooms) {
    const rc = roomColor(room.kind);
    boxes.push({ ...room, color: rc });
    // Every region is an extension now (v5, see the module header), so it
    // always shares its parent room's color - no per-region color lookup
    // needed anymore.
    for (const region of regionsForRoom(data, room.id)) boxes.push({ ...region.box, color: rc });
  }
  for (const corridor of data.corridors) {
    for (const seg of corridor.segments) boxes.push({ ...seg, color: CORRIDOR_COLOR });
  }
  return boxes;
}

/** Every physical thing on the floor, ready for a renderer to draw as-is:
 * full-block walls (with a gap at each door), floor+ceiling planes per
 * room/region/corridor box, and marker boxes for stairs/doors. */
export function floorToRenderSpecs(data: DungeonFloorData): FloorRenderSpecs {
  const interior = buildInteriorMap(data);
  const walls = wallCells(interior);
  cutDoorGaps(walls, data.doors);

  const floors: PlaneSpec[] = [];
  const ceilings: PlaneSpec[] = [];
  for (const box of coloredBoxesFromFloor(data)) {
    const { floor, ceiling } = floorCeilingForBox(box);
    floors.push(floor);
    ceilings.push(ceiling);
  }
  for (const door of data.doors) {
    floors.push(doorGapFloorSpec(door));
    ceilings.push(doorGapCeilingSpec(door, interior));
  }

  const markers: BoxSpec[] = [];
  for (const stair of data.stairs) {
    const { center, size } = boxToWorld(stair.box);
    markers.push({
      kind: stair.embedded ? "stairEmbedded" : "stairFreestanding",
      center,
      size,
      color: STAIR_COLOR,
      opacity: stair.embedded ? 0.85 : 1,
    });
  }
  for (const door of data.doors) {
    markers.push(doorBoxSpec(door, interior));
  }

  return { walls: wallSpecsFromCells(walls), floors, ceilings, markers };
}
