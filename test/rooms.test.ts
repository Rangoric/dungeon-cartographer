import { describe, it, expect } from "vitest";
import { PLACEHOLDER_ROOMS, roomCenter, type RoomSpec } from "../src/rooms";

describe("roomCenter", () => {
  it("rests the box on the y = 0 floor (y = half the box height)", () => {
    const room: RoomSpec = { pos: [3, -5], size: [2, 4, 6], color: 0xffffff };
    expect(roomCenter(room)).toEqual([3, 2, -5]);
  });

  it("maps grid [x, z] straight to world x and z", () => {
    const room: RoomSpec = { pos: [-7, 9], size: [1, 1, 1], color: 0 };
    const [x, , z] = roomCenter(room);
    expect(x).toBe(-7);
    expect(z).toBe(9);
  });

  it("never sinks a placeholder room below the floor", () => {
    for (const room of PLACEHOLDER_ROOMS) {
      const [, y] = roomCenter(room);
      // Box bottom = centre y minus half-height; should sit exactly at 0.
      expect(y - room.size[1] / 2).toBeCloseTo(0);
    }
  });
});

describe("PLACEHOLDER_ROOMS", () => {
  it("has well-formed specs", () => {
    expect(PLACEHOLDER_ROOMS.length).toBeGreaterThan(0);
    for (const room of PLACEHOLDER_ROOMS) {
      expect(room.pos).toHaveLength(2);
      expect(room.size).toHaveLength(3);
      expect(room.size.every((d) => d > 0)).toBe(true);
    }
  });
});
