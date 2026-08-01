// Pure data + geometry helpers for the dungeon view.
//
// Deliberately free of Three.js and Obsidian imports: this is the seam the
// real dungeon parser will grow into, and keeping it dependency-free is what
// makes it unit-testable without a WebGL context.

/** A box stand-in for a room, in grid (x, z) coordinates. */
export interface RoomSpec {
  /** Floor-plane position: [x, z]. */
  pos: [number, number];
  /** Box dimensions: [width (x), height (y), depth (z)]. */
  size: [number, number, number];
  /** Mesh colour as a 0xRRGGBB integer. */
  color: number;
}

/** Placeholder rooms shown until real dungeon data is wired in. */
export const PLACEHOLDER_ROOMS: RoomSpec[] = [
  { pos: [-4, -3], size: [3, 2, 3], color: 0xcc4040 },
  { pos: [2, -2], size: [4, 1.5, 2], color: 0x40b04c },
  { pos: [-1, 3], size: [2, 3, 2], color: 0x4070d8 },
  { pos: [5, 4], size: [2.5, 2, 4], color: 0xd8c030 },
  { pos: [4, -5], size: [2, 1, 2], color: 0xb04ccc },
];

/**
 * Centre position for a room's box mesh so the box rests on the y = 0 floor
 * plane (rather than being half-buried in it). Returns [x, y, z].
 */
export function roomCenter(room: RoomSpec): [number, number, number] {
  return [room.pos[0], room.size[1] / 2, room.pos[1]];
}
