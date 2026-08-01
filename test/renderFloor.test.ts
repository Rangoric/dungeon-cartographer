import { describe, it, expect } from "vitest";
import {
  boxToWorld,
  roomColor,
  doorColor,
  doorBoxSpec,
  floorToRenderSpecs,
  WALL_COLOR,
  DOOR_LEGEND,
} from "../src/renderFloor";
import type { DungeonDoor, DungeonFloorData, DungeonRoom, DungeonCorridor, DungeonRegion } from "../src/dungeonData";

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

describe("boxToWorld", () => {
  it("maps dungeon (x, y, z) to world (x, z, y) directly - no render-layer vertical offset", () => {
    const { center, size } = boxToWorld({ x: 2, y: 3, z: 1, w: 4, d: 2, h: 2 });
    expect(center).toEqual([4, 1 + 1, 4]);
    expect(size).toEqual([4, 2, 2]);
  });

  it("rests a ground-floor box's world Y at half its height", () => {
    const { center } = boxToWorld({ x: 0, y: 0, z: 0, w: 1, d: 1, h: 3 });
    expect(center[1]).toBe(1.5);
  });
});

describe("roomColor", () => {
  it("gives entrance and plain rooms their own colours", () => {
    expect(roomColor("entrance")).not.toBe(roomColor("room"));
  });

  it("treats any other kind as a special/highlighted room", () => {
    expect(roomColor("boss")).not.toBe(roomColor("room"));
    expect(roomColor("boss")).not.toBe(roomColor("entrance"));
  });
});

describe("doorColor", () => {
  it("always flags secret doors the same way regardless of material", () => {
    expect(doorColor("wood", true)).toBe(doorColor("stone", true));
  });

  it("differentiates known materials when not secret", () => {
    expect(doorColor("wood", false)).not.toBe(doorColor("metal", false));
    expect(doorColor("wood", false)).not.toBe(doorColor("stone", false));
  });

  it("falls back to a default colour for an unknown material", () => {
    expect(() => doorColor("mystery-material", false)).not.toThrow();
  });
});

describe("doorBoxSpec", () => {
  it("centers on the gap cell, spans full height to the taller neighbor, and stays thin along the differing axis", () => {
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 1,
    };
    // cellA's room is 10' (h=2), cellB's is 20' (h=4) - the door should
    // reach the taller one, not split the difference.
    const interior = new Map<string, number>([
      ["1,1", 2],
      ["3,1", 4],
    ]);
    const spec = doorBoxSpec(door, interior);
    expect(spec.center).toEqual([2.5, 2, 1.5]); // gap cell (2,1), vertically centered in a 4-tall span
    expect(spec.size[1]).toBe(4);
    expect(spec.size[0]).toBeLessThan(spec.size[1]);
    expect(spec.size[0]).toBeLessThan(spec.size[2]);
  });

  it("spans the full width across the wall (not the old fixed 0.8 units) for a 10' double door", () => {
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 2,
    };
    const interior = new Map<string, number>([
      ["1,1", 2],
      ["3,1", 2],
    ]);
    const spec = doorBoxSpec(door, interior);
    // Gap cells are (2,1) and (2,2) - the span runs from y=1 to y=3, so its
    // midpoint (world Z) is 2, not the width-1 door's 1.5.
    expect(spec.center).toEqual([2.5, 1, 2]);
    expect(spec.size[2]).toBeCloseTo(1.8); // 2 cells wide, minus the same 0.2 total margin a width-1 door gets
  });
});

describe("floorToRenderSpecs - walls (Block Walls Plan.md step 4)", () => {
  it("gives an isolated room a full-block ring around its perimeter, including the 4 diagonal corners", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 2, y: 3, z: 0, w: 3, d: 2, h: 2 };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room] }));

    // Orthogonal 4-adjacent ring of a w x d rectangle = 2w + 2d, plus the 4
    // diagonal corner cells (v6.1 follow-up - a simple rectangle's corners
    // are always genuine convex corners, so all 4 get filled).
    expect(walls).toHaveLength(2 * room.w + 2 * room.d + 4);
    for (const w of walls) {
      expect(w.size).toEqual([1, room.h, 1]);
      expect(w.color).toBe(WALL_COLOR);
    }
  });

  it("leaves a gap (no wall block) at a door's gap cell, with real wall blocks elsewhere along that same boundary", () => {
    // Rooms placed with the mandatory 1-cell WALL_GAP a real generator
    // leaves between different entities (Block Walls Plan.md step 1) - the
    // gap column sits at x=2. Door cells frame that gap, 2 apart on x (the
    // real generator's convention - see generate.ts's doorCells).
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 1,
    };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    // The gap cell itself (x=2, y=1 -> world center [2.5, _, 1.5]) is an
    // open doorway - no wall block there.
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 1.5)).toBe(false);
    // The rest of that same gap column (y=0 and y=2) is a real, solid wall.
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 0.5)).toBe(true);
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 2.5)).toBe(true);
  });

  it("puts no wall block at the seam between a room and its own flush extension region, but still walls the region's other exposed faces", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 2, y: 2, z: 0, w: 2, d: 2, h: 2 };
    const extension: DungeonRegion = {
      id: 0,
      roomId: 0,
      extension: true,
      box: { x: 4, y: 2, z: 0, w: 1, d: 1, h: 2, kind: "room" },
    };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room], regions: [extension] }));

    // Combined room+extension footprint is a 5-cell shape; hand-counted
    // ring around it is 9 orthogonal cells + 5 diagonal corner cells = 14
    // (see Block Walls Plan.md rollout notes) - proves no extra/missing
    // wall at the flush seam, without needing an entity concept in the
    // renderer at all: a flush (gap: 0) boundary is just two interior
    // cells touching, and walls only ever occupy non-interior cells.
    expect(walls).toHaveLength(14);
    for (const w of walls) expect(w.size).toEqual([1, 2, 1]);
  });

  it("puts no wall block at the internal seam of a bending corridor, but walls the rest of its perimeter", () => {
    const seg0 = { x: 2, y: 2, z: 0, w: 1, d: 2, h: 1 }; // cells (2,2),(2,3)
    const seg1 = { x: 3, y: 3, z: 0, w: 2, d: 1, h: 1 }; // cells (3,3),(4,3) - flush against seg0 at (2,3)-(3,3)
    const corridor: DungeonCorridor = { id: 0, connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }], width: 1, segments: [seg0, seg1] };
    const { walls } = floorToRenderSpecs(emptyFloor({ corridors: [corridor] }));

    // Same reasoning as the extension-region test above: hand-counted ring
    // around this 4-cell L-shaped footprint is 9 orthogonal + 5 diagonal
    // corner cells = 14.
    expect(walls).toHaveLength(14);
    for (const w of walls) expect(w.size).toEqual([1, 1, 1]);
  });

  it("sizes a wall block to the taller of the two interiors it separates", () => {
    // A 10' room (h=2) next to a 20' corridor segment (h=4), 1 cell of
    // WALL_GAP apart (x=2 is the gap column).
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
    const corridor: DungeonCorridor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      width: 1,
      segments: [{ x: 3, y: 0, z: 0, w: 2, d: 2, h: 4 }],
    };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room], corridors: [corridor] }));

    // The gap-column wall cells (x=2) border both the short room and the
    // tall corridor - they should stand the full 4 units tall, not 2.
    const gapColumn = walls.filter((w) => w.center[0] === 2.5);
    expect(gapColumn.length).toBeGreaterThan(0);
    for (const w of gapColumn) expect(w.size[1]).toBe(4);
  });

  it("leaves a gap at BOTH of a width-2 door's cells, with the rest of the boundary still walled (2026-07-31)", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 2,
    };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    // Gap cells are (2,1) and (2,2) -> world centers [2.5,_,1.5] and [2.5,_,2.5].
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 1.5)).toBe(false);
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 2.5)).toBe(false);
    // Row y=0 in that same column wasn't claimed by the door - still a wall.
    expect(walls.some((w) => w.center[0] === 2.5 && w.center[2] === 0.5)).toBe(true);
  });

  it("draws a real wall block along the true grid boundary, past the nominal grid edge (v6.1 follow-up)", () => {
    // A room flush against the grid's own x=0 edge still gets a wall block
    // at x=-1 - dropping the map boundary as an implicit substitute for a
    // wall was the whole point of the follow-up (Block Walls Plan.md): it
    // read as a gap once actually on screen, not like an edge of the
    // buildable area.
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 2, z: 0, w: 2, d: 2, h: 2 };
    const { walls } = floorToRenderSpecs(emptyFloor({ rooms: [room] }));
    expect(walls.some((w) => w.center[0] === -0.5 && w.center[2] === 2.5)).toBe(true);
    expect(walls.some((w) => w.center[0] === -0.5 && w.center[2] === 3.5)).toBe(true);
  });
});

describe("floorToRenderSpecs - floors and ceilings", () => {
  it("emits one floor/ceiling pair per box (room, each region, each corridor segment)", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 };
    const extension: DungeonRegion = {
      id: 0,
      roomId: 0,
      extension: true,
      box: { x: 2, y: 0, z: 0, w: 1, d: 1, h: 2, kind: "room" },
    };
    const corridor: DungeonCorridor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      width: 1,
      segments: [
        { x: 0, y: 2, z: 0, w: 1, d: 2, h: 1 },
        { x: 1, y: 3, z: 0, w: 2, d: 1, h: 1 },
      ],
    };
    const { floors, ceilings } = floorToRenderSpecs(
      emptyFloor({ rooms: [room], regions: [extension], corridors: [corridor] })
    );

    // 1 room box + 1 extension region + 2 corridor segments = 4 boxes total.
    expect(floors).toHaveLength(4);
    expect(ceilings).toHaveLength(4);
    expect(floors.every((f) => f.facing === "up")).toBe(true);
    expect(ceilings.every((c) => c.facing === "down")).toBe(true);
  });

  it("positions floor at the box's own z and ceiling a further `h` above it", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 1, w: 2, d: 2, h: 2 };
    const { floors, ceilings } = floorToRenderSpecs(emptyFloor({ rooms: [room] }));
    expect(floors[0].center[1]).toBe(1);
    expect(ceilings[0].center[1]).toBe(1 + 2);
  });

  it("gives an extension region its own floor/ceiling pair, positioned at its own box", () => {
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 4, d: 4, h: 2 };
    const region: DungeonRegion = {
      id: 0,
      roomId: 0,
      extension: true,
      box: { x: 4, y: 1, z: 0, w: 1, d: 2, h: 2, kind: "room" },
    };
    const { floors } = floorToRenderSpecs(emptyFloor({ rooms: [room], regions: [region] }));
    // One floor for the room's own box, one for the region's - both at the
    // shared z=0, since a region always shares its room's z/h now.
    expect(floors).toHaveLength(2);
    expect(floors.every((f) => f.center[1] === 0)).toBe(true);
  });

  it("colors every wall block uniformly, but floors/ceilings still match the room's own color", () => {
    // Block Walls Plan.md step 4: walls are now shared, global structure -
    // a wall cell can legitimately border two differently-colored entities
    // at once, so it can't sensibly "belong" to either anymore. Floors and
    // ceilings are unaffected - still per-box, still colored per entity.
    const room: DungeonRoom = { id: 0, kind: "room", x: 0, y: 0, z: 0, w: 4, d: 4, h: 2 };
    const extension: DungeonRegion = {
      id: 0,
      roomId: 0,
      extension: true,
      box: { x: 4, y: 0, z: 0, w: 2, d: 4, h: 2, kind: "room" },
    };
    const { walls, floors, ceilings } = floorToRenderSpecs(emptyFloor({ rooms: [room], regions: [extension] }));

    const roomColorValue = roomColor("room");
    expect(walls.length).toBeGreaterThan(0);
    expect(walls.every((w) => w.color === WALL_COLOR)).toBe(true);
    expect(floors.every((f) => f.color === roomColorValue)).toBe(true);
    expect(ceilings.every((c) => c.color === roomColorValue)).toBe(true);
  });

  it("patches in a wall-colored floor tile under a door's gap cell (2026-07-31 - it used to be a hole)", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 1,
    };
    const { floors } = floorToRenderSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    // Gap cell is (2, 1) -> world center [2.5, _, 1.5], same convention as
    // the wall-gap test above.
    const gapFloor = floors.find((f) => f.center[0] === 2.5 && f.center[2] === 1.5);
    expect(gapFloor).toBeDefined();
    expect(gapFloor?.color).toBe(WALL_COLOR);
    expect(gapFloor?.facing).toBe("up");
    // Plus the 2 rooms' own floors.
    expect(floors).toHaveLength(3);
  });

  it("patches in a ceiling-grid tile above a door's gap cell, sized to the taller of its two neighbors", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    // Taller neighbor (h=4) on the other side of the door.
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 4 };
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 1,
    };
    const { ceilings } = floorToRenderSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    const gapCeiling = ceilings.find((c) => c.center[0] === 2.5 && c.center[2] === 1.5);
    expect(gapCeiling).toBeDefined();
    expect(gapCeiling?.center[1]).toBe(4); // gz (0) + taller neighbor's h (4), not the shorter room's 2.
    expect(gapCeiling?.facing).toBe("down");
    // Plus the 2 rooms' own ceilings.
    expect(ceilings).toHaveLength(3);
  });

  it("merges a width-2 door's floor/ceiling patch into one wider plane instead of two 1x1 tiles (2026-07-31)", () => {
    const room0: DungeonRoom = { id: 0, kind: "entrance", x: 0, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const room1: DungeonRoom = { id: 1, kind: "room", x: 3, y: 0, z: 0, w: 2, d: 3, h: 2 };
    const door: DungeonDoor = {
      id: 0,
      connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }],
      cellA: [1, 1, 0],
      cellB: [3, 1, 0],
      material: "wood",
      secret: false,
      width: 2,
    };
    const { floors, ceilings } = floorToRenderSpecs(emptyFloor({ rooms: [room0, room1], doors: [door] }));

    // Gap cells (2,1) and (2,2) span y=1..3, so the merged patch centers at
    // world Z=2 (not 1.5, the width-1 case) and is 2 cells deep, not 1.
    const gapFloor = floors.find((f) => f.center[0] === 2.5 && f.center[2] === 2);
    expect(gapFloor).toBeDefined();
    expect(gapFloor?.size).toEqual([1, 2]);
    const gapCeiling = ceilings.find((c) => c.center[0] === 2.5 && c.center[2] === 2);
    expect(gapCeiling).toBeDefined();
    expect(gapCeiling?.size).toEqual([1, 2]);
    // Still exactly one patch each, not one per cell.
    expect(floors).toHaveLength(3);
    expect(ceilings).toHaveLength(3);
  });
});

describe("DOOR_LEGEND", () => {
  it("has one entry per color doorColor() can actually produce, and the colors match", () => {
    const materials = ["wood", "metal", "stone"];
    for (const material of materials) {
      const entry = DOOR_LEGEND.find((e) => e.label.toLowerCase().startsWith(material));
      expect(entry).toBeDefined();
      expect(entry?.color).toBe(doorColor(material, false));
    }
    const secretEntry = DOOR_LEGEND.find((e) => e.label.toLowerCase().includes("secret"));
    expect(secretEntry).toBeDefined();
    expect(secretEntry?.color).toBe(doorColor("wood", true));
  });
});

describe("floorToRenderSpecs - markers", () => {
  it("emits one marker per stair and door, and none for regions (they get real geometry instead)", () => {
    const data = emptyFloor({
      rooms: [{ id: 0, kind: "room", x: 0, y: 0, z: 0, w: 2, d: 2, h: 2 }],
      regions: [
        { id: 0, roomId: 0, extension: true, box: { x: 2, y: 0, z: 0, w: 1, d: 1, h: 2, kind: "room" } },
      ],
      stairs: [
        { id: 0, roomId: 0, embedded: true, style: "spiral", floorsDown: 1, box: { x: 0, y: 0, z: 0, w: 1, d: 1, h: 2 } },
      ],
      doors: [
        { id: 0, connects: [{ kind: "room", id: 0 }, { kind: "room", id: 1 }], cellA: [0, 0, 0], cellB: [1, 0, 0], material: "wood", secret: false, width: 1 },
      ],
    });
    const { markers } = floorToRenderSpecs(data);
    expect(markers.filter((m) => m.kind === "stairEmbedded")).toHaveLength(1);
    expect(markers.filter((m) => m.kind === "door")).toHaveLength(1);
    expect(markers).toHaveLength(2); // nothing extra for the region
  });

  it("gives an empty floor no walls, floors, ceilings, or markers", () => {
    const specs = floorToRenderSpecs(emptyFloor());
    expect(specs.walls).toEqual([]);
    expect(specs.floors).toEqual([]);
    expect(specs.ceilings).toEqual([]);
    expect(specs.markers).toEqual([]);
  });
});
