// Pure geometry + color logic for turning parsed floor data into flat 2D
// draw primitives - the SVG-based successor to renderFloor.ts's 3D specs.
// See "2D Rendering Plan.md" (rollout step 2) and "2d map.md" in the
// Dungeon Generation vault folder for why: the 3D orbit view doesn't match
// how a physical dungeon reads at the table, so the whole presentation
// layer is being replaced with flat top-down SVG, one floor at a time.
//
// Deliberately free of Obsidian/DOM/SVG-string-building imports, same
// reasoning as renderFloor.ts and rooms.ts before it - this stays
// unit-testable without a browser. Units throughout are grid cells (1
// cube = 5' - see Dungeon Data Format.md), NOT pixels; the view layer
// (not yet built - see 2D Rendering Plan.md's rollout step 4) picks a
// cell-to-pixel scale and turns these into actual <rect>/<line>/<text>
// elements, including all pixel-level padding and icon-glyph drawing (a
// door leaf's inset, an icon's exact stroke shape, etc.) - this module
// only derives grid geometry and physical metadata (material, secret/
// locked/trapped/stuck, height), mirroring what renderFloor.ts derived
// for the 3D view.
//
// Visual style ported from "2D Rendering Plan.md"'s "Visual Style,
// Resolved (2026-09-05)" section, validated against a real donjon (d20
// Random Dungeon Generator) reference PDF and the comparison artifact
// shown to the user before this was written:
// - Walls are filled 1-cell blocks (`wallRects`) PLUS a crisp boundary
//   stroke right at the wall/interior edge (`boundaryLines`) - donjon does
//   both; the earlier mockup was missing the stroke.
// - Rooms/corridors share one floor color (donjon-style undifferentiated
//   floor), except entrance (light green tint) and a special room kind
//   (light red tint), which keep a subtle distinguishing tint.
// - Doors get a leaf colored by material, with locked/trapped/stuck marks
//   carried as independent flags (all three are physical fields now - see
//   Physical vs Content Split.md's 2026-09-05 amendment). A `secret` door
//   draws the same material leaf (plus any locked/trapped/stuck marks) with
//   an 'S' glyph on top - changed 2026-09-06 from an earlier all-black
//   blend-into-the-wall treatment, which hid a secret door's other physical
//   state along with the secret flag itself.
// - Every room prints its ceiling height under its id; every sizeable
//   corridor segment (and every freestanding stair) prints its height too
//   - a room/corridor/stair-height labeling policy resolved 2026-09-05,
//   also in "2D Rendering Plan.md".

import type { DungeonBox, DungeonDoor, DungeonFloorData, DungeonStair } from "./dungeonData";
import { doorGapCell, doorGapCells } from "./dungeonData";

/** 1 grid cube = 5' - see Dungeon Data Format.md's header comment. */
export function cubesToFeet(h: number): number {
  return h * 5;
}

/** A filled grid-cell-aligned rectangle, in grid-cell units (NOT pixels) - top-left corner (x, y) + size (w, d). */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  d: number;
  color: string;
}

/** A single edge segment, in grid-cell units - endpoints, not pixel coordinates. Used for the crisp wall/interior boundary stroke. */
export interface GridLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

/** Uniform fill for every wall-block cell - same "no side owns a shared wall" reasoning as `renderFloor.ts`'s `WALL_COLOR`. */
export const WALL_COLOR = "#111111";

/** Floor tint by room-kind bucket ("special" = any kind other than "room"/"entrance", e.g. a boss room). Corridors and plain rooms intentionally share one color (donjon-style undifferentiated floor) - only entrance/special keep a distinguishing tint. */
export const FLOOR_COLORS = {
  entrance: "#eaf7ee",
  room: "#ffffff",
  special: "#ffe1e1",
  corridor: "#ffffff",
} as const;

export type FloorColorKind = keyof typeof FLOOR_COLORS;

export function roomColorKind(kind: string): FloorColorKind {
  if (kind === "entrance") return "entrance";
  if (kind === "room") return "room";
  return "special";
}

/** Door leaf fill/stroke by material - the same three materials `generate.ts`'s default `doorMaterials` rolls from. An unrecognized material falls back to a neutral grey, same spirit as `renderFloor.ts`'s `doorColor()` fallback. */
export const DOOR_FILL_COLORS: Record<string, string> = {
  wood: "#c9a876",
  metal: "#7f8e99",
  stone: "#d8d3c8",
};
export const DOOR_STROKE_COLORS: Record<string, string> = {
  wood: "#6b4a24",
  metal: "#333d43",
  stone: "#6b6558",
};
const DEFAULT_DOOR_FILL = "#cccccc";
const DEFAULT_DOOR_STROKE = "#333333";

export function doorFillColor(material: string): string {
  return DOOR_FILL_COLORS[material] ?? DEFAULT_DOOR_FILL;
}
export function doorStrokeColor(material: string): string {
  return DOOR_STROKE_COLORS[material] ?? DEFAULT_DOOR_STROKE;
}

/** 2026-09-06 iteration: a secret door draws its normal material leaf (locked/trapped/stuck marks included) with an 'S' glyph in this color layered on top - replaces an earlier all-black+dashed "blend into the wall" treatment, which hid a secret door's material/locked/trapped/stuck state along with the secret flag itself. The view layer reads `DoorIcon2D.secret` and draws the glyph, rotated for a north-south-opening door - see `drawDoorIcon` in floor2dView.ts. */
export const SECRET_DOOR_LABEL_COLOR = "#1c1c1c";

/** 2026-09-05 iteration: a trapped door's leaf outline draws in this color instead of its material's normal stroke (material fill stays, so you can still tell what the door is made of) - replaces an earlier red-triangle "!" icon, which the material fill/leaf shape already made cramped. The view layer reads `DoorIcon2D.trapped`. */
export const TRAPPED_DOOR_STROKE = "#b23b2e";

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Every interior (x, y) cell on the floor, mapped to the color-kind bucket
 * its owning box renders in. Mirrors `renderFloor.ts`'s `buildInteriorMap`,
 * but keyed on color-kind instead of height - 2D has no need for per-cell
 * height merging, since every wall cell renders the one uniform
 * `WALL_COLOR` regardless of which neighbor it's tallest against. A
 * freestanding stair's footprint gets the plain "corridor" bucket, same as
 * `renderFloor.ts` treats it as ordinary open floor before its own stair
 * icon draws on top (see `stairIcon` below).
 */
function buildInteriorColorMap(data: DungeonFloorData): Map<string, FloorColorKind> {
  const interior = new Map<string, FloorColorKind>();
  const addBox = (box: DungeonBox, kind: FloorColorKind) => {
    for (let yy = box.y; yy < box.y + box.d; yy++) {
      for (let xx = box.x; xx < box.x + box.w; xx++) {
        interior.set(cellKey(xx, yy), kind);
      }
    }
  };
  for (const room of data.rooms) addBox(room, roomColorKind(room.kind));
  for (const region of data.regions) {
    const room = data.rooms.find((r) => r.id === region.roomId);
    addBox(region.box, room ? roomColorKind(room.kind) : "room");
  }
  for (const corridor of data.corridors) for (const seg of corridor.segments) addBox(seg, "corridor");
  for (const stair of data.stairs) if (!stair.embedded) addBox(stair.box, "corridor");
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
 * Every wall-block cell on the floor - same two-pass derivation as
 * `renderFloor.ts`'s `wallCells()` (orthogonal ring around every interior
 * cell, then a diagonal corner fill so two perpendicular wall runs don't
 * leave a one-cell notch at a room's corner), minus the per-cell height
 * tracking 2D doesn't need.
 */
function wallCellSet(interior: Map<string, FloorColorKind>): Set<string> {
  const walls = new Set<string>();
  for (const key of interior.keys()) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nkey = cellKey(x + dx, y + dy);
      if (!interior.has(nkey)) walls.add(nkey);
    }
  }
  for (const key of interior.keys()) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    for (const [dx, dy] of DIAGONAL_OFFSETS) {
      const diagKey = cellKey(x + dx, y + dy);
      if (interior.has(diagKey)) continue;
      const orthoAKey = cellKey(x + dx, y);
      const orthoBKey = cellKey(x, y + dy);
      if (interior.has(orthoAKey) || interior.has(orthoBKey)) continue;
      walls.add(diagKey);
    }
  }
  return walls;
}

/** Every door-gap cell across the floor (one per unit of `door.width` - see `doorGapCells()`, dungeonData.ts), mapped back to the door that opens it. A door's gap cell is carved out of what would otherwise be a wall-block cell. */
function doorGapCellMap(doors: DungeonDoor[]): Map<string, DungeonDoor> {
  const map = new Map<string, DungeonDoor>();
  for (const door of doors) {
    for (const [gx, gy] of doorGapCells(door)) map.set(cellKey(gx, gy), door);
  }
  return map;
}

/**
 * The crisp line drawn right at the edge between an interior cell and a
 * wall cell - the fix a real donjon-generator reference PDF pointed at
 * (see "2D Rendering Plan.md"'s "Visual Style, Resolved"): donjon draws
 * real thick walls but still strokes a clean boundary on top, which an
 * earlier mockup here was missing. Skipped at a door-gap edge - the door
 * icon itself marks that boundary, so a boundary line there would just be
 * visual noise crossing the doorway.
 */
function boundaryLinesFor(interior: Map<string, FloorColorKind>, doorGaps: Map<string, DungeonDoor>, color: string): GridLine[] {
  const lines: GridLine[] = [];
  const isOpen = (x: number, y: number) => interior.has(cellKey(x, y)) || doorGaps.has(cellKey(x, y));
  for (const key of interior.keys()) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!isOpen(x + 1, y)) lines.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1, color });
    if (!isOpen(x - 1, y)) lines.push({ x1: x, y1: y, x2: x, y2: y + 1, color });
    if (!isOpen(x, y + 1)) lines.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1, color });
    if (!isOpen(x, y - 1)) lines.push({ x1: x, y1: y, x2: x + 1, y2: y, color });
  }
  return lines;
}

/** Same span derivation as `renderFloor.ts`'s `doorGapSpan()`, minus the z component 2D has no use for. */
function doorSpan(door: DungeonDoor): { x0: number; y0: number; x1: number; y1: number; crossesX: boolean } {
  const [gx, gy] = doorGapCell(door);
  const width = Math.max(1, door.width ?? 1);
  const crossesX = door.cellA[0] !== door.cellB[0];
  return crossesX ? { x0: gx, y0: gy, x1: gx + 1, y1: gy + width, crossesX } : { x0: gx, y0: gy, x1: gx + width, y1: gy + 1, crossesX };
}

export interface DoorIcon2D {
  id: number;
  /** The grid-cell rectangle the door's leaf occupies - `doorGapCell()` widened by `door.width` along whichever axis the shared wall runs (see dungeonData.ts's `DungeonDoor` doc comment). */
  span: { x0: number; y0: number; x1: number; y1: number };
  /** true: the door's shared wall runs north-south (the gap widens along y, `cellA`/`cellB` differ on x). false: shared wall runs east-west. Tells the view layer which axis to draw the leaf thin along. */
  crossesX: boolean;
  material: string;
  secret: boolean;
  locked: boolean;
  trapped: boolean;
  stuck: boolean;
}

function doorIcon(door: DungeonDoor): DoorIcon2D {
  const { crossesX, ...span } = doorSpan(door);
  return {
    id: door.id,
    span,
    crossesX,
    material: door.material,
    secret: door.secret,
    locked: door.locked,
    trapped: door.trapped,
    stuck: door.stuck,
  };
}

export interface StairIcon2D {
  id: number;
  box: DungeonBox;
  embedded: boolean;
  style: "spiral" | "regular";
  floorsDown: number;
  /**
   * Only meant to be printed next to a FREESTANDING stair (`embedded ===
   * false`) - an embedded stair's height is already covered by its room's
   * own `RoomLabel2D`, so the view layer shouldn't repeat it there (see
   * "2D Rendering Plan.md"'s ceiling-height policy). Still computed for
   * embedded stairs too, so the field is never undefined.
   */
  heightFt: number;
}

function stairIcon(stair: DungeonStair): StairIcon2D {
  return {
    id: stair.id,
    box: stair.box,
    embedded: stair.embedded,
    style: stair.style,
    floorsDown: stair.floorsDown,
    heightFt: cubesToFeet(stair.box.h),
  };
}

export interface RoomLabel2D {
  id: number;
  cx: number;
  cy: number;
  heightFt: number;
}

function buildRoomLabels(data: DungeonFloorData): RoomLabel2D[] {
  return data.rooms.map((room) => ({
    id: room.id,
    cx: room.x + room.w / 2,
    cy: room.y + room.d / 2,
    heightFt: cubesToFeet(room.h),
  }));
}

export interface HeightLabel2D {
  cx: number;
  cy: number;
  heightFt: number;
  /** true: rotate the label 90 degrees (segment taller than wide) so it fits inside a narrow 5'-wide corridor run instead of overflowing into the walls. */
  rotated: boolean;
}

/** Skip corridor segments smaller than this (grid-cell area) - a 1x1 stub would just repeat a neighboring segment's number in a space too small to hold it legibly. See "2D Rendering Plan.md"'s ceiling-height policy. */
export const MIN_CORRIDOR_LABEL_AREA = 2;

function buildCorridorHeightLabels(data: DungeonFloorData): HeightLabel2D[] {
  const labels: HeightLabel2D[] = [];
  for (const corridor of data.corridors) {
    for (const seg of corridor.segments) {
      if (seg.w * seg.d < MIN_CORRIDOR_LABEL_AREA) continue;
      labels.push({
        cx: seg.x + seg.w / 2,
        cy: seg.y + seg.d / 2,
        heightFt: cubesToFeet(seg.h),
        rotated: seg.d > seg.w,
      });
    }
  }
  return labels;
}

/** A floor rect that also carries what it belongs to, so the view layer can wire up the existing vault-link click-through (rooms/corridors only - see "What Doesn't Change" in 2D Rendering Plan.md). Undefined for a floor rect that isn't inside any room/corridor (a freestanding stair's own footprint, or a door's gap cell). */
export interface FloorRect extends GridRect {
  owner?: { kind: "room" | "corridor"; id: number };
}

/**
 * Every room/region/corridor-segment box, each carrying the floor color it
 * should render in and (for click-through) the room/corridor it belongs
 * to - mirrors `renderFloor.ts`'s `coloredBoxesFromFloor`. A region always
 * shares its parent room's color and click target, same as every region
 * being a plain extension (lobe) of its room (see Room Floor Regions.md
 * and Simplification Plan.md - platform/recess regions are gone).
 */
function buildFloorRects(data: DungeonFloorData): FloorRect[] {
  const rects: FloorRect[] = [];
  for (const room of data.rooms) {
    rects.push({ x: room.x, y: room.y, w: room.w, d: room.d, color: FLOOR_COLORS[roomColorKind(room.kind)], owner: { kind: "room", id: room.id } });
  }
  for (const region of data.regions) {
    const room = data.rooms.find((r) => r.id === region.roomId);
    const kind = room ? roomColorKind(room.kind) : "room";
    rects.push({ x: region.box.x, y: region.box.y, w: region.box.w, d: region.box.d, color: FLOOR_COLORS[kind], owner: { kind: "room", id: region.roomId } });
  }
  for (const corridor of data.corridors) {
    for (const seg of corridor.segments) {
      rects.push({ x: seg.x, y: seg.y, w: seg.w, d: seg.d, color: FLOOR_COLORS.corridor, owner: { kind: "corridor", id: corridor.id } });
    }
  }
  for (const stair of data.stairs) {
    if (!stair.embedded) {
      rects.push({ x: stair.box.x, y: stair.box.y, w: stair.box.w, d: stair.box.d, color: FLOOR_COLORS.corridor });
    }
  }
  return rects;
}

export interface Floor2DSpecs {
  /** One rect per wall-block cell (door-gap cells excluded - see `doorGapRects` instead). */
  wallRects: GridRect[];
  /** One rect per room/region/corridor-segment/freestanding-stair box. */
  floorRects: FloorRect[];
  /**
   * The patch under each door's gap cell(s) - a door's gap belongs to no
   * room/corridor/region box (it's carved out of what would otherwise be a
   * wall-block cell - see `cutDoorGaps`-equivalent handling above), so
   * without this it has nothing drawn there at all beyond the door leaf
   * itself. `WALL_COLOR` (changed back 2026-09-06 - briefly flat white
   * during the 2D rollout, which showed as a distracting white outline
   * around the leaf's inset margin against the actual wall), regardless of
   * which two entities the door actually connects - same "no obviously
   * correct side to inherit from" reasoning as `renderFloor.ts`'s
   * `doorGapFloorSpec`.
   */
  doorGapRects: GridRect[];
  /** The crisp wall/interior boundary stroke - see `boundaryLinesFor`. */
  boundaryLines: GridLine[];
  doors: DoorIcon2D[];
  stairs: StairIcon2D[];
  roomLabels: RoomLabel2D[];
  corridorHeightLabels: HeightLabel2D[];
}

/**
 * Every physical thing on the floor, ready for an SVG view layer to draw
 * as-is: filled wall/floor rects (with a gap-patch at each door), the
 * crisp boundary stroke, and door/stair icon + height-label metadata. See
 * the module header for the full visual-style mapping this was ported
 * from, and "2D Rendering Plan.md"'s rollout order for what's still ahead
 * (the actual SVG-drawing view layer, step 4).
 */
export function floorTo2DSpecs(data: DungeonFloorData): Floor2DSpecs {
  const interior = buildInteriorColorMap(data);
  const walls = wallCellSet(interior);
  const doorGaps = doorGapCellMap(data.doors);
  for (const key of doorGaps.keys()) walls.delete(key);

  const wallRects: GridRect[] = [];
  for (const key of walls) {
    const [xs, ys] = key.split(",");
    wallRects.push({ x: Number(xs), y: Number(ys), w: 1, d: 1, color: WALL_COLOR });
  }

  const doorGapRects: GridRect[] = [];
  for (const key of doorGaps.keys()) {
    const [xs, ys] = key.split(",");
    doorGapRects.push({ x: Number(xs), y: Number(ys), w: 1, d: 1, color: WALL_COLOR });
  }

  return {
    wallRects,
    floorRects: buildFloorRects(data),
    doorGapRects,
    boundaryLines: boundaryLinesFor(interior, doorGaps, WALL_COLOR),
    doors: data.doors.map(doorIcon),
    stairs: data.stairs.map(stairIcon),
    roomLabels: buildRoomLabels(data),
    corridorHeightLabels: buildCorridorHeightLabels(data),
  };
}
