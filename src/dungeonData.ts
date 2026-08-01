// Types + parser for the generated-floor data format.
//
// See "Dungeon Data Format.md" in the Dungeon Generation vault folder for
// the full schema and rationale. This file is deliberately free of
// Three.js/Obsidian imports, same as rooms.ts - pure data shape + parsing,
// unit-testable without a WebGL context.
//
// A `.dungeon` file is pure JSON (no markdown wrapper) - see main.ts for
// why (compound `.dungeon.md` extensions don't register with Obsidian,
// and a huge fenced code block chokes the markdown editor).

/** A plain axis-aligned box in grid-cube units (1 cube = 5' in-game). */
export interface DungeonBox {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface DungeonRoom extends DungeonBox {
  id: number;
  kind: string; // "room", "entrance", or an optional per-dungeon special kind (e.g. "boss")
}

/**
 * What one end of a corridor or door actually connects to - added
 * 2026-08-01 (see Room Corridor Rework Plan.md) when corridors stopped
 * being one-edge-between-two-rooms and started meeting each other at
 * junctions. A `"room"` end sits behind a real door (a mandatory
 * `WALL_GAP` wall cell in between); a `"corridor"` end joins another
 * corridor object flush, no wall, no door - a physical T/X junction. Only
 * `DungeonCorridor.connects` can be `"open"` - a deliberate dead end (see
 * `deadEndPruneFraction`); a door never terminates in open space.
 */
export type DungeonConnection = { kind: "room"; id: number } | { kind: "corridor"; id: number };
export type DungeonCorridorEndpoint = DungeonConnection | { kind: "open" };

export interface DungeonCorridor {
  id: number;
  connects: [DungeonCorridorEndpoint, DungeonCorridorEndpoint];
  width: number;
  segments: DungeonBox[];
}

/**
 * `cellA`/`cellB` are the interior-facing cell on each side of the door -
 * the last occupied cell of one space and the first occupied cell of the
 * other, along the axis they connect on. As of the block-wall pass (Block
 * Walls Plan.md, 2026-07-31), cross-entity attachments leave a mandatory
 * 1-cell wall gap, so `cellA`/`cellB` are always exactly 2 apart on that
 * axis (not touching) - the cell exactly between them is the wall-block
 * cell this door punches open. Use `doorGapCell()` below to get it.
 *
 * `width` (added 2026-07-31, see Block Walls Plan.md) - how many
 * consecutive wall-block cells wide the doorway is, extending from
 * `doorGapCell()`'s cell along whichever axis the shared wall runs (the
 * opposite of the axis `cellA`/`cellB` differ on). `1` = a normal 5' door
 * (the only option before 2026-07-31); `2` = a 10' double door. Use
 * `doorGapCells()` below to get every cell it occupies, not just the
 * first. A missing `width` (an older file) is treated as `1` - see
 * `normalizeDungeonFloor`.
 */
export interface DungeonDoor {
  id: number;
  connects: [DungeonConnection, DungeonConnection];
  cellA: [number, number, number];
  cellB: [number, number, number];
  material: string;
  secret: boolean;
  width: number;
}

/**
 * The first (and, for a width-1 door, only) wall-block cell a door
 * replaces with open floor - the midpoint between `cellA` and `cellB`.
 * Valid for any door produced by the current generator (they're always
 * exactly 2 apart on one axis, 0 on the other, same z - see `DungeonDoor`'s
 * doc comment). For a wider door, use `doorGapCells()` to get every cell.
 */
export function doorGapCell(door: Pick<DungeonDoor, "cellA" | "cellB">): [number, number, number] {
  const [ax, ay, az] = door.cellA;
  const [bx, by] = door.cellB;
  return [(ax + bx) / 2, (ay + by) / 2, az];
}

/**
 * Every wall-block cell a door replaces with open floor - `width`
 * consecutive cells starting at `doorGapCell()`, extending along whichever
 * axis the door's shared wall runs (perpendicular to the axis `cellA`/
 * `cellB` differ on). A width-1 door is just the one cell.
 */
export function doorGapCells(
  door: Pick<DungeonDoor, "cellA" | "cellB" | "width">
): [number, number, number][] {
  const [gx, gy, gz] = doorGapCell(door);
  const width = Math.max(1, Math.round(door.width ?? 1));
  const crossesX = door.cellA[0] !== door.cellB[0];
  const cells: [number, number, number][] = [];
  for (let i = 0; i < width; i++) {
    cells.push(crossesX ? [gx, gy + i, gz] : [gx + i, gy, gz]);
  }
  return cells;
}

export interface DungeonStair {
  id: number;
  roomId: number;
  embedded: boolean;
  style: "spiral" | "regular";
  floorsDown: number;
  box: DungeonBox;
}

/**
 * A sub-area belonging to a room - replaces the old `DungeonRoom.lobes`
 * and `DungeonPlatform` (see Room Floor Regions.md). `extension: true`
 * means the box's footprint pokes outside its room (a lobe-like bump,
 * same z/h as the room); `extension: false` means the box's footprint
 * sits inside its room at a different z/h (`box.kind` is `"platform"` for
 * a raised floor or `"recess"` for a lowered one - for an extension,
 * `box.kind` is just the parent room's own kind, for color-matching).
 */
export interface DungeonRegion {
  id: number;
  roomId: number;
  box: DungeonBox & { kind: string };
  extension: boolean;
}

export interface DungeonGridSize {
  width: number;
  depth: number;
  height: number;
}

export interface DungeonFloorData {
  grid: DungeonGridSize;
  rooms: DungeonRoom[];
  corridors: DungeonCorridor[];
  doors: DungeonDoor[];
  stairs: DungeonStair[];
  regions: DungeonRegion[];
  /**
   * "I've looked at this generated map and I'm happy with it - don't touch
   * it again." Gates the plugin's "Generate Random Map"/"Finalize" buttons
   * (see Dungeon Generation Notes.md's Dungeon Folder Structure section,
   * 2026-07-31): both show while `false`, neither shows once `true`. A file
   * with no `finalized` key at all is treated as `false` - see
   * `normalizeDungeonFloor` below - so older/incomplete files default to
   * editable rather than silently locked.
   */
  finalized: boolean;
}

/** Shown before any real floor file has been loaded. */
export const EMPTY_FLOOR_DATA: DungeonFloorData = {
  grid: { width: 0, depth: 0, height: 0 },
  rooms: [],
  corridors: [],
  doors: [],
  stairs: [],
  regions: [],
  finalized: false,
};

/**
 * Parse a `.dungeon` file's raw text - the whole file is JSON, nothing
 * else, so this is just `JSON.parse` plus filling in any missing arrays
 * so callers never have to guard against `undefined`.
 *
 * Throws if the text isn't valid JSON - the caller (main.ts) is
 * responsible for catching this and falling back gracefully.
 */
export function parseDungeonFloor(fileText: string): DungeonFloorData {
  const raw = JSON.parse(fileText);
  return normalizeDungeonFloor(raw);
}

function normalizeDungeonFloor(raw: unknown): DungeonFloorData {
  const r = (raw ?? {}) as Partial<DungeonFloorData>;
  return {
    grid: r.grid ?? { width: 0, depth: 0, height: 0 },
    rooms: r.rooms ?? [],
    corridors: r.corridors ?? [],
    // A missing `width` (any file written before 2026-07-31) defaults to a
    // normal 5' door, same "editable by default"-style leniency as
    // `finalized` below - older data shouldn't need a manual upgrade.
    doors: (r.doors ?? []).map((d) => ({ ...d, width: normalizeDoorWidth(d.width) })),
    stairs: r.stairs ?? [],
    regions: r.regions ?? [],
    // Missing key => not finalized, per the "editable by default" decision
    // above - only an explicit `true` locks a floor.
    finalized: r.finalized === true,
  };
}

function normalizeDoorWidth(width: unknown): number {
  return typeof width === "number" && Number.isFinite(width) && width >= 1 ? Math.round(width) : 1;
}
