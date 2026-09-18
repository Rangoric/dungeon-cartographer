import { describe, it, expect } from "vitest";
import {
  cubesToFeet,
  roomColorKind,
  doorFillColor,
  doorStrokeColor,
  floorTo2DSpecs,
  WALL_COLOR,
  FLOOR_COLORS,
  MIN_CORRIDOR_LABEL_AREA,
} from "../src/floor2d";
import type { DungeonDoor, DungeonFloorData, DungeonRoom, DungeonCorridor, DungeonRegion, DungeonStair } from "../src/dungeonData";

function emptyFloor(overrides: Partial<DungeonFloorData> = {}): DungeonFloorData {
  return {
    grid: { width: 10, depth: 10, height: 6 },
    rooms: [],
    corridors: [],
    doors: [],
    stairs: [],
    regions: [],
    finalized: false,
    ...overrides,
  };
}

function plainDoor(overrides: Partial<DungeonDoor> = {}): DungeonDoor {
  return {
    id: 0,
    connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
    cellA: [1, 1, 0],
    cellB: [3, 1, 0],
    material: "wood",
    secret: false,
    width: 1,
    locked: false,
    trapped: false,
    stuck: false,
    ...overrides,
  };
}

describe("cubesToFeet", () => {
  it("converts the three confirmed ceiling heights", () => {
    expect(cubesToFeet(2)).toBe(10);
    expect(cubesToFeet(4)).toBe(20);
    expect(cubesToFeet(6)).toBe(30);
  });

  it("is a flat x5 conversion for any cube height, not a lookup table", () => {
    expect(cubesToFeet(1)).toBe(5);
    expect(cubesToFeet(3)).toBe(15);
  });
});

describe("roomColorKind", () => {
  it("buckets entrance and plain rooms separately", () => {
    expect(roomColorKind("entrance")).toBe("entrance");
    expect(roomColorKind("room")).toBe("room");
  });

  it("treats any other kind as special", () => {
    expect(roomColorKind("boss")).toBe("special");
  });
});

describe("doorFillColor / doorStrokeColor", () => {
  it("differentiates known materials", () => {
    expect(doorFillColor("wood")).not.toBe(doorFillColor("metal"));
    expect(doorFillColor("wood")).not.toBe(doorFillColor("stone"));
    expect(doorStrokeColor("wood")).not.toBe(doorStrokeColor("metal"));
  });

  it("falls back to a default color for an unrecognized material", () => {
    expect(() => doorFillColor("mystery-material")).not.toThrow();
    expect(() => doorStrokeColor("mystery-material")).not.toThrow();
  });
});

describe("floorTo2DSpecs - wallRects (mirrors floorToRenderSpecs's wall derivation)", () => {
  it("gives an isolated room a full-block ring around its perimeter, including the 4 diagonal corners", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 2, y: 3, z: 0, w: 3, d: 2, h: 2 };
    const { wallRects } = floorTo2DSpecs(emptyFloor({ rooms: [room] }));

    expect(wallRects).toHaveLength(2 * room.w + 2 * room.d + 4);
    for (const w of wallRects) {
      expect(w.w).toBe(1);
      expect(w.d).toBe(1);
      expect(w.color).toBe(WALL_COLOR);
    }
  });

  it("leaves a gap (no wall rect) at a door's gap cell, with real wall rects elsewhere along that same boundary", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door = plainDoor({ cellA: [1, 1, 0], cellB: [3, 1, 0] });
    const { wallRects, doorGapRects } = floorTo2DSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    expect(wallRects.some((w) => w.x === 2 && w.y === 1)).toBe(false);
    expect(wallRects.some((w) => w.x === 2 && w.y === 0)).toBe(true);
    expect(wallRects.some((w) => w.x === 2 && w.y === 2)).toBe(true);
    expect(doorGapRects).toEqual([{ x: 2, y: 1, w: 1, d: 1, color: WALL_COLOR }]);
  });

  it("puts no wall rect at the seam between a room and its own flush extension region, but still walls the region's other exposed faces", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 2, y: 2, z: 0, w: 2, d: 2, h: 2 };
    const extension: DungeonRegion = {
      id: 0,
      roomId: 0,
      extension: true,
      box: { x: 4, y: 2, z: 0, w: 1, d: 1, h: 2, kind: "room" },
    };
    const { wallRects } = floorTo2DSpecs(emptyFloor({ rooms: [room], regions: [extension] }));
    // Same hand-counted shape as renderFloor.test.ts's equivalent case: a
    // 5-cell combined footprint's ring is 9 orthogonal + 5 diagonal = 14.
    expect(wallRects).toHaveLength(14);
  });
});

describe("floorTo2DSpecs - boundaryLines (the donjon-informed crisp-stroke fix)", () => {
  it("draws exactly one line per exposed side of a single-cell room", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 1, d: 1, h: 2 };
    const { boundaryLines } = floorTo2DSpecs(emptyFloor({ rooms: [room] }));
    expect(boundaryLines).toHaveLength(4);
    for (const line of boundaryLines) expect(line.color).toBe(WALL_COLOR);
  });

  it("skips the edge at a door's gap cell, but still strokes the rest of that boundary", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door = plainDoor({ cellA: [1, 1, 0], cellB: [3, 1, 0] });
    const { boundaryLines } = floorTo2DSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    // The door-gap edge itself: room0's rightmost interior cell (1,1) to
    // the gap cell (2,1) - no boundary line should cross it.
    const doorEdgeCrossed = boundaryLines.some((l) => l.x1 === 2 && l.x2 === 2 && l.y1 === 1 && l.y2 === 2);
    expect(doorEdgeCrossed).toBe(false);
    // The rest of room0's right-hand boundary (y=0 and y=2 rows) is still a
    // real stroked edge.
    expect(boundaryLines.some((l) => l.x1 === 2 && l.x2 === 2 && l.y1 === 0 && l.y2 === 1)).toBe(true);
    expect(boundaryLines.some((l) => l.x1 === 2 && l.x2 === 2 && l.y1 === 2 && l.y2 === 3)).toBe(true);
  });
});

describe("floorTo2DSpecs - floorRects ownership (for view-layer click-through)", () => {
  it("tags a room's own floor rect with its room id", () => {
    const room: DungeonRoom = { id: 7, kind: "room", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
    const { floorRects } = floorTo2DSpecs(emptyFloor({ rooms: [room] }));
    expect(floorRects).toHaveLength(1);
    expect(floorRects[0].owner).toEqual({ kind: "room", id: 7 });
  });

  it("tags an extension region's floor rect with its PARENT room's id and color, not its own", () => {
    const room: DungeonRoom = { id: 3, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
    const extension: DungeonRegion = { id: 0, roomId: 3, extension: true, box: { x: 2, y: 0, z: 0, w: 1, d: 1, h: 2, kind: "room" } };
    const { floorRects } = floorTo2DSpecs(emptyFloor({ rooms: [room], regions: [extension] }));
    const regionRect = floorRects.find((r) => r.x === 2 && r.y === 0);
    expect(regionRect?.owner).toEqual({ kind: "room", id: 3 });
    expect(regionRect?.color).toBe(FLOOR_COLORS.entrance);
  });

  it("tags a corridor segment's floor rect with its corridor id", () => {
    const corridor: DungeonCorridor = { id: 5, connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }], width: 1, segments: [{ x: 0, y: 0, z: 0, w: 2, d: 1, h: 1 }] };
    const { floorRects } = floorTo2DSpecs(emptyFloor({ corridors: [corridor] }));
    expect(floorRects[0].owner).toEqual({ kind: "corridor", id: 5 });
    expect(floorRects[0].color).toBe(FLOOR_COLORS.corridor);
  });

  it("gives a freestanding stair's floor rect no owner (nothing to click through to)", () => {
    const stair: DungeonStair = { id: 0, roomId: 0, embedded: false, style: "regular", floorsDown: 1, box: { x: 0, y: 0, z: 0, w: 1, d: 1, h: 2 } };
    const { floorRects } = floorTo2DSpecs(emptyFloor({ stairs: [stair] }));
    expect(floorRects).toHaveLength(1);
    expect(floorRects[0].owner).toBeUndefined();
  });

  it("gives an embedded stair no separate floor rect at all - its footprint is already its room's", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
    const stair: DungeonStair = { id: 0, roomId: 0, embedded: true, style: "regular", floorsDown: 1, box: { x: 0, y: 0, z: 0, w: 1, d: 1, h: 2 } };
    const { floorRects } = floorTo2DSpecs(emptyFloor({ rooms: [room], stairs: [stair] }));
    expect(floorRects).toHaveLength(1); // just the room, not a second rect for the stair
  });
});

describe("floorTo2DSpecs - door icons", () => {
  it("carries material/secret/locked/trapped/stuck straight through, independent of each other", () => {
    const door = plainDoor({ material: "metal", secret: false, locked: true, trapped: true, stuck: true });
    const { doors } = floorTo2DSpecs(emptyFloor({ doors: [door] }));
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ material: "metal", secret: false, locked: true, trapped: true, stuck: true });
  });

  it("derives the gap span and crossesX the same way doorGapSpan/doorGapCell do", () => {
    // cellA/cellB differ on x (1 vs 3) -> crossesX true, gap cell (2,1).
    const door = plainDoor({ cellA: [1, 1, 0], cellB: [3, 1, 0], width: 1 });
    const { doors } = floorTo2DSpecs(emptyFloor({ doors: [door] }));
    expect(doors[0].crossesX).toBe(true);
    expect(doors[0].span).toEqual({ x0: 2, y0: 1, x1: 3, y1: 2 });
  });

  it("widens the span for a width-2 door along the correct axis", () => {
    const door = plainDoor({ cellA: [1, 1, 0], cellB: [3, 1, 0], width: 2 });
    const { doors } = floorTo2DSpecs(emptyFloor({ doors: [door] }));
    // crossesX true -> widens along y.
    expect(doors[0].span).toEqual({ x0: 2, y0: 1, x1: 3, y1: 3 });
  });
});

describe("floorTo2DSpecs - stairs", () => {
  it("computes heightFt from the stair's own box height for both embedded and freestanding stairs", () => {
    const embedded: DungeonStair = { id: 0, roomId: 0, embedded: true, style: "spiral", floorsDown: 1, box: { x: 0, y: 0, z: 0, w: 1, d: 1, h: 2 } };
    const freestanding: DungeonStair = { id: 1, roomId: 0, embedded: false, style: "regular", floorsDown: 2, box: { x: 5, y: 5, z: 0, w: 1, d: 1, h: 2 } };
    const { stairs } = floorTo2DSpecs(emptyFloor({ stairs: [embedded, freestanding] }));
    expect(stairs.find((s) => s.id === 0)).toMatchObject({ embedded: true, heightFt: 10 });
    expect(stairs.find((s) => s.id === 1)).toMatchObject({ embedded: false, floorsDown: 2, heightFt: 10 });
  });
});

describe("floorTo2DSpecs - roomLabels", () => {
  it("centers a room label on its footprint and converts its height to feet", () => {
    const room: DungeonRoom = { id: 4, kind: "room", x: 2, y: 2, z: 0, w: 4, d: 2, h: 4 };
    const { roomLabels } = floorTo2DSpecs(emptyFloor({ rooms: [room] }));
    expect(roomLabels).toEqual([{ id: 4, cx: 4, cy: 3, heightFt: 20 }]);
  });
});

describe("floorTo2DSpecs - corridorHeightLabels (ceiling-height policy, 2D Rendering Plan.md)", () => {
  it("skips a segment smaller than MIN_CORRIDOR_LABEL_AREA", () => {
    const corridor: DungeonCorridor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      width: 1,
      segments: [{ x: 0, y: 0, z: 0, w: 1, d: 1, h: 1 }], // area 1 < MIN_CORRIDOR_LABEL_AREA
    };
    expect(1 * 1).toBeLessThan(MIN_CORRIDOR_LABEL_AREA);
    const { corridorHeightLabels } = floorTo2DSpecs(emptyFloor({ corridors: [corridor] }));
    expect(corridorHeightLabels).toHaveLength(0);
  });

  it("labels a sizeable segment and rotates only when taller than wide", () => {
    const corridor: DungeonCorridor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      width: 1,
      segments: [
        { x: 0, y: 0, z: 0, w: 1, d: 3, h: 2 }, // narrow/tall -> rotated
        { x: 5, y: 0, z: 0, w: 3, d: 1, h: 2 }, // wide/short -> not rotated
      ],
    };
    const { corridorHeightLabels } = floorTo2DSpecs(emptyFloor({ corridors: [corridor] }));
    expect(corridorHeightLabels).toHaveLength(2);
    expect(corridorHeightLabels.find((l) => l.cx === 0.5)).toMatchObject({ heightFt: 10, rotated: true });
    expect(corridorHeightLabels.find((l) => l.cx === 6.5)).toMatchObject({ heightFt: 10, rotated: false });
  });
});
