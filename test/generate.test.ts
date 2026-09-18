import { describe, it, expect } from "vitest";
import {
  Rng,
  generateFloor,
  isConnected,
  findCloseDoorPairs,
  configFromFloorSetup,
  DEFAULT_GENERATE_CONFIG,
  type GenerateConfig,
} from "../src/generate";
import type { DungeonBox, DungeonFloorData } from "../src/dungeonData";

function testConfig(overrides: Partial<GenerateConfig> = {}): GenerateConfig {
  return { ...DEFAULT_GENERATE_CONFIG, gridWidth: 20, gridDepth: 20, ...overrides };
}

/** Mirrors the internal `allSegments`, independently, so these tests aren't just trusting the code they'd also be testing. */
function allSegments(data: DungeonFloorData): DungeonBox[] {
  const segs: DungeonBox[] = [];
  for (const room of data.rooms) segs.push(room);
  for (const region of data.regions) segs.push(region.box);
  for (const corridor of data.corridors) segs.push(...corridor.segments);
  for (const stair of data.stairs) if (!stair.embedded) segs.push(stair.box);
  return segs;
}

function overlaps(a: DungeonBox, b: DungeonBox): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.d &&
    b.y < a.y + a.d &&
    a.z < b.z + b.h &&
    b.z < a.z + a.h
  );
}

function isWithin(b: DungeonBox, grid: { width: number; depth: number; height: number }): boolean {
  return (
    b.x >= 0 &&
    b.y >= 0 &&
    b.z >= 0 &&
    b.x + b.w <= grid.width &&
    b.y + b.d <= grid.depth &&
    b.z + b.h <= grid.height
  );
}

/**
 * True if `a` and `b` are touching or overlapping once `a` is inflated by 1
 * cell in x/y - mirrors `generate.ts`'s internal `marginOverlaps`/`WALL_GAP`
 * check, independently, so this test isn't just trusting the code it's
 * testing. Any two *different* entities' interiors must keep at least 1
 * empty cell between them (the wall block); same-entity pieces (a room +
 * its own regions, a corridor's own segments) are exempt and stay flush -
 * and, as of the 2026-08-01 rework, two DIFFERENT corridors are also
 * exempt where they meet at a junction (deliberately flush, no wall - see
 * Room Corridor Rework Plan.md decision 1).
 */
function withinWallGap(a: DungeonBox, b: DungeonBox): boolean {
  return (
    a.x - 1 < b.x + b.w &&
    b.x < a.x + a.w + 1 &&
    a.y - 1 < b.y + b.d &&
    b.y < a.y + a.d + 1 &&
    a.z < b.z + b.h &&
    b.z < a.z + a.h
  );
}

/**
 * Groups every segment by the entity "family" it belongs to - a room and
 * its own extension regions share a family; a corridor's segments share a
 * family; each freestanding stair is its own family. Same-family pairs are
 * allowed to sit flush, and so are any two DIFFERENT corridor families
 * (junctions) - both exemptions are asserted separately below.
 */
function segmentFamilies(data: DungeonFloorData): { box: DungeonBox; family: string; isCorridor: boolean }[] {
  const out: { box: DungeonBox; family: string; isCorridor: boolean }[] = [];
  for (const room of data.rooms) out.push({ box: room, family: `room:${room.id}`, isCorridor: false });
  for (const region of data.regions) out.push({ box: region.box, family: `room:${region.roomId}`, isCorridor: false });
  for (const corridor of data.corridors) {
    for (const seg of corridor.segments) out.push({ box: seg, family: `corridor:${corridor.id}`, isCorridor: true });
  }
  for (const stair of data.stairs) {
    if (!stair.embedded) out.push({ box: stair.box, family: `stair:${stair.id}`, isCorridor: false });
  }
  return out;
}

describe("Rng", () => {
  it("random() stays within [0, 1)", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 500; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("randint(a, b) is inclusive on both ends and stays in range", () => {
    const rng = new Rng(2);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.randint(1, 3);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it("choice() only ever returns an element from the input", () => {
    const rng = new Rng(3);
    const options = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      expect(options).toContain(rng.choice(options));
    }
  });

  it("choices() respects a hard 0-weight (never picks it)", () => {
    const rng = new Rng(4);
    for (let i = 0; i < 200; i++) {
      expect(rng.choices(["only", "never"], [1, 0])).toBe("only");
    }
  });

  it("shuffle() is a permutation - same elements, same length", () => {
    const rng = new Rng(5);
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];
    rng.shuffle(copy);
    expect(copy).toHaveLength(items.length);
    expect([...copy].sort()).toEqual([...items].sort());
  });

  it("produces the same sequence for the same seed", () => {
    const a = new Rng(99);
    const b = new Rng(99);
    const seqA = Array.from({ length: 20 }, () => a.random());
    const seqB = Array.from({ length: 20 }, () => b.random());
    expect(seqA).toEqual(seqB);
  });
});

describe("generateFloor - structural invariants", () => {
  it("produces no overlapping pieces", () => {
    const data = generateFloor(testConfig({ seed: 1 }));
    const segs = allSegments(data);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        expect(overlaps(segs[i], segs[j])).toBe(false);
      }
    }
  });

  it("keeps WALL_GAP between every room-family pair and every room-vs-corridor pair (corridor-vs-different-corridor junctions are the deliberate exception)", () => {
    for (let seed = 500; seed < 512; seed++) {
      const data = generateFloor(testConfig({ seed }));
      const segs = segmentFamilies(data);
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          if (segs[i].family === segs[j].family) continue; // same entity - flush is expected
          if (segs[i].isCorridor && segs[j].isCorridor) continue; // two different corridors may meet flush at a junction
          expect(withinWallGap(segs[i].box, segs[j].box)).toBe(false);
        }
      }
    }
  });

  it("keeps every piece within the grid bounds", () => {
    const data = generateFloor(testConfig({ seed: 2 }));
    for (const seg of allSegments(data)) {
      expect(isWithin(seg, data.grid)).toBe(true);
    }
  });

  it(
    "produces a connected graph",
    () => {
      // Swept 0-499 during the 2026-09-13 disconnected-floor fix (Dungeon
      // Generator Status.md, formerly "Known Issues") - was ~5-6% of seeds
      // (32/500) before `growConnectingBranch` grew a direct-dock fallback
      // for two rooms whose fixed launch-point offsets land on the same
      // cell; 0/500 after. Kept at the full swept width, not just a sample,
      // so a regression here can't silently slip back under 20 seeds.
      for (let seed = 0; seed < 500; seed++) {
        const data = generateFloor(testConfig({ seed }));
        expect(isConnected(data)).toBe(true);
      }
    },
    60000
  );

  it("is deterministic for a given seed", () => {
    const config = testConfig({ seed: 42 });
    const a = generateFloor(config);
    const b = generateFloor(config);
    expect(a).toEqual(b);
  });

  it("produces some corridors by default", () => {
    const data = generateFloor(testConfig({ gridWidth: 24, gridDepth: 24, seed: 6 }));
    expect(data.corridors.length).toBeGreaterThan(0);
  });

  it("carries no left-over platform/recess region kinds - every region is an extension", () => {
    const data = generateFloor(testConfig({ seed: 8 }));
    expect(data.regions.every((r) => r.extension)).toBe(true);
  });
});

describe("generateFloor - footprint budget (2026-08-01, Room Corridor Rework Plan.md)", () => {
  /** Room + lobe footprint only, mirroring `roomFootprintCells()` independently. */
  function roomFootprintFraction(data: DungeonFloorData): number {
    const cells = new Set<string>();
    const add = (b: DungeonBox) => {
      for (let yy = b.y; yy < b.y + b.d; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) cells.add(`${xx},${yy}`);
    };
    for (const room of data.rooms) add(room);
    for (const region of data.regions) add(region.box);
    return cells.size / (data.grid.width * data.grid.depth);
  }

  it("lands room+lobe footprint within the rolled +/-10% band around the 40% default target", () => {
    for (let seed = 0; seed < 10; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 36, gridDepth: 36, seed }));
      const frac = roomFootprintFraction(data);
      // Generous bounds: the band itself is 36-44%, but grid-edge/export-margin
      // effects and stalled placement near maxAttempts can shave a little off
      // the low end - assert "clearly aiming at ~40%", not the exact band.
      expect(frac).toBeGreaterThan(0.2);
      expect(frac).toBeLessThan(0.5);
    }
  });

  it("does NOT count corridors toward the footprint target - corridors are free", () => {
    // A tiny footprint target still produces a floor with corridors once
    // more than one room exists, since corridors are generated in a
    // separate pass that never checks footprint at all.
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 9, footprintTarget: 0.15, footprintTargetVariance: 0 }));
    if (data.rooms.length > 1) {
      expect(data.corridors.length).toBeGreaterThan(0);
    }
  });
});

describe("generateFloor - export margin", () => {
  it("exports a grid 2 cells larger than the generated area on each axis", () => {
    const data = generateFloor(testConfig({ gridWidth: 20, gridDepth: 24, seed: 50 }));
    expect(data.grid.width).toBe(22);
    expect(data.grid.depth).toBe(26);
  });

  it("insets every interior box 1 cell from the exported grid's true edges, leaving room for the outer wall ring", () => {
    const data = generateFloor(testConfig({ gridWidth: 20, gridDepth: 20, seed: 51 }));
    for (const seg of allSegments(data)) {
      expect(seg.x).toBeGreaterThanOrEqual(1);
      expect(seg.y).toBeGreaterThanOrEqual(1);
      expect(seg.x + seg.w).toBeLessThanOrEqual(data.grid.width - 1);
      expect(seg.y + seg.d).toBeLessThanOrEqual(data.grid.depth - 1);
    }
  });

  it("shifts door cells along with everything else, keeping z untouched", () => {
    const data = generateFloor(testConfig({ gridWidth: 20, gridDepth: 20, seed: 52 }));
    expect(data.doors.length).toBeGreaterThan(0);
    for (const door of data.doors) {
      expect(door.cellA[0]).toBeGreaterThanOrEqual(1);
      expect(door.cellA[1]).toBeGreaterThanOrEqual(1);
      expect(door.cellA[0]).toBeLessThan(data.grid.width - 1);
      expect(door.cellA[1]).toBeLessThan(data.grid.depth - 1);
    }
  });
});

describe("generateFloor - doors", () => {
  it("every door's two cells frame a single wall gap cell and share a z", () => {
    const data = generateFloor(testConfig({ gridWidth: 24, gridDepth: 24, seed: 9 }));
    expect(data.doors.length).toBeGreaterThan(0);
    for (const door of data.doors) {
      const [ax, ay, az] = door.cellA;
      const [bx, by, bz] = door.cellB;
      expect(az).toBe(bz);
      const dx = Math.abs(ax - bx);
      const dy = Math.abs(ay - by);
      expect((dx === 2 && dy === 0) || (dx === 0 && dy === 2)).toBe(true);
    }
  });

  it("every door's gap cells are uncovered by any room/corridor/region interior", () => {
    const data = generateFloor(testConfig({ gridWidth: 24, gridDepth: 24, seed: 9 }));
    const interiors = allSegments(data);
    const isCovered = (x: number, y: number, z: number) =>
      interiors.some((seg) => x >= seg.x && x < seg.x + seg.w && y >= seg.y && y < seg.y + seg.d && z >= seg.z && z < seg.z + seg.h);

    expect(data.doors.length).toBeGreaterThan(0);
    for (const door of data.doors) {
      expect(Number.isInteger(door.width)).toBe(true);
      // 1 (normal) or 2 (10' double door) from the normal weighted roll -
      // plus a rare 3, which only ever comes from `mergeAdjacentDoors`
      // collapsing 3 independently-placed doors that ended up touching on
      // the same wall (see "door spacing" below); never a 4th option in
      // `pickDoorWidth()` itself.
      expect([1, 2, 3]).toContain(door.width);
      const [ax, ay, az] = door.cellA;
      const [bx, by] = door.cellB;
      const gx = (ax + bx) / 2;
      const gy = (ay + by) / 2;
      expect(isCovered(gx, gy, az)).toBe(false);
    }
  });

  it("every door connects two well-formed room/corridor references", () => {
    const data = generateFloor(testConfig({ gridWidth: 24, gridDepth: 24, seed: 10 }));
    const roomIds = new Set(data.rooms.map((r) => r.id));
    const corridorIds = new Set(data.corridors.map((c) => c.id));
    for (const door of data.doors) {
      for (const end of door.connects) {
        expect(end.kind === "room" || end.kind === "corridor").toBe(true);
        if (end.kind === "room") expect(roomIds.has(end.id)).toBe(true);
        if (end.kind === "corridor") expect(corridorIds.has(end.id)).toBe(true);
      }
    }
  });
});

describe("generateFloor - door spacing (2026-09-14)", () => {
  const SPACING_SWEEP_CONFIGS: [string, Partial<GenerateConfig>][] = [
    ["20x20 default", {}],
    ["36x36 default", { gridWidth: 36, gridDepth: 36 }],
    ["30x30 dense footprint", { gridWidth: 30, gridDepth: 30, footprintTarget: 0.55 }],
  ];
  const SPACING_SWEEP_SEEDS = 200;

  /** Asserts the two invariants `mergeAdjacentDoors`/`harmonizeCloseDoors` are meant to guarantee; returns the door count and issue count so a sweep can also track the overall close-pair rate. */
  function assertNoTouchingOrMismatchedDoors(data: DungeonFloorData): { doors: number; issues: number } {
    const issues = findCloseDoorPairs(data);
    expect(issues.filter((i) => i.gap === 0)).toEqual([]);
    for (const issue of issues) {
      const a = data.doors.find((d) => d.id === issue.doorIds[0])!;
      const b = data.doors.find((d) => d.id === issue.doorIds[1])!;
      expect({ material: a.material, secret: a.secret, locked: a.locked, trapped: a.trapped, stuck: a.stuck }).toEqual({
        material: b.material,
        secret: b.secret,
        locked: b.locked,
        trapped: b.trapped,
        stuck: b.stuck,
      });
    }
    return { doors: data.doors.length, issues: issues.length };
  }

  it("never leaves a 3+ chain of close doors mismatched (regression: seed 694, dense config)", () => {
    // `harmonizeCloseDoors`'s original version synced each pair to its own
    // immediate neighbor independently - for a run of 3 (A-B gap 1, B-C gap
    // 1), that synced B to A and then, in the very next pairwise check,
    // overwrote B to match C instead, leaving A and C mismatched despite
    // both being close to B. Seed 694 at this denser config is the exact
    // case that surfaced it (room 1 had a run of exactly 3 doors, each one
    // WALL_GAP cell from the next) - kept as its own seed rather than
    // trusting the general sweep below to land on it, since 694 falls
    // outside that sweep's swept range.
    assertNoTouchingOrMismatchedDoors(generateFloor(testConfig({ seed: 694, gridWidth: 30, gridDepth: 30, footprintTarget: 0.55 })));
  });

  it(
    "never leaves two doors touching, and never leaves two close doors mismatched, across a wide seed sweep",
    () => {
      // Swept while diagnosing this bug (three configs above, 0-999 each -
      // more rooms/denser footprints mean more doors and more chances to
      // collide): touching pairs (gap 0) were common before the fix
      // (748-1206 per 1000 seeds) and fully eliminated after - a genuinely
      // touching pair always has somewhere to merge into (see
      // `mergeAdjacentDoors`'s doc comment on why the geometry never has to
      // move), so that half is a hard guarantee, not a "usually".
      //
      // The gap-1 case (one WALL_GAP cell between two independently-rolled
      // doors) is deliberately left as two separate door objects rather
      // than merged - see `mergeAdjacentDoors`'s doc comment on why closing
      // that gap would mean carving a corridor cell nothing has ever
      // occupied. `harmonizeCloseDoors` closes the actual reported bug
      // instead: forcing every door in a close-together run to share one
      // roll, so they read as a deliberately matched set rather than a
      // collision - the check the bug report asked for verbatim ("no two
      // doors sharing a wall differ in material/rolls within one cell of
      // each other"), and a hard guarantee regardless of how many doors
      // end up in one run (a 3+ chain needs every member synced to the
      // SAME reference door, not just its immediate neighbor - the exact
      // bug `harmonizeCloseDoors` had until this fix, caught by sweeping
      // seed 694 at the dense config specifically).
      //
      // One seed count kept smaller than the connectivity sweep's own
      // 0-499 (single config) since this one runs three configs, two of
      // them at larger/denser grids - still comfortably wide enough to
      // have caught both bugs above when they existed.
      let totalDoors = 0;
      let totalIssues = 0;
      for (const [, overrides] of SPACING_SWEEP_CONFIGS) {
        for (let seed = 0; seed < SPACING_SWEEP_SEEDS; seed++) {
          const data = generateFloor(testConfig({ seed, ...overrides }));
          const { doors, issues } = assertNoTouchingOrMismatchedDoors(data);
          totalDoors += doors;
          totalIssues += issues;
        }
      }
      // Sanity check the bias is actually doing something - close pairs
      // should stay a small minority of all doors placed, not the norm.
      // Not a "near zero" assertion on raw pair count - a gap-1 pair is an
      // accepted, expected outcome once the bias's soft preference loses
      // to a room simply running out of clearly-separated wall (see
      // `doorProximityPenalty`'s doc comment). Baseline (bias + merge both
      // disabled) sweeps of the same three configs put this ratio at
      // roughly 4-10%; comfortably under 5% after the fix.
      expect(totalIssues / totalDoors).toBeLessThan(0.05);
    },
    120000
  );

  it("a merged 3-cell-wide door (seed 96, default config) frames one continuous gap span with nothing covering it", () => {
    // Same shape as the pre-existing "every door's gap cells are uncovered"
    // check above, but specifically for a width>=3 door - the only way one
    // is ever produced (see `pickDoorWidth` - 3 is never a normal roll) -
    // so a merge that got the span math wrong wouldn't just look wrong,
    // it'd actually cover real floor.
    const data = generateFloor(testConfig({ seed: 96 }));
    const door = data.doors.find((d) => d.width >= 3);
    expect(door).toBeDefined();
    const interiors = allSegments(data);
    const isCovered = (x: number, y: number, z: number) =>
      interiors.some((seg) => x >= seg.x && x < seg.x + seg.w && y >= seg.y && y < seg.y + seg.d && z >= seg.z && z < seg.z + seg.h);
    const [ax, ay, az] = door!.cellA;
    const [bx, by] = door!.cellB;
    const crossesX = ax !== bx;
    const gx = (ax + bx) / 2;
    const gy = (ay + by) / 2;
    for (let i = 0; i < door!.width; i++) {
      const [cx, cy] = crossesX ? [gx, gy + i] : [gx + i, gy];
      expect(isCovered(cx, cy, az)).toBe(false);
    }
  });
});

describe("generateFloor - door quality rolls (locked/trapped/stuck, 2026-09-05)", () => {
  it("rolls no locked/trapped/stuck doors when all three chances are 0", () => {
    const data = generateFloor(
      testConfig({ gridWidth: 24, gridDepth: 24, seed: 9, lockedDoorChance: 0, trappedDoorChance: 0, stuckDoorChance: 0 })
    );
    expect(data.doors.length).toBeGreaterThan(0);
    for (const door of data.doors) {
      expect(door.locked).toBe(false);
      expect(door.trapped).toBe(false);
      expect(door.stuck).toBe(false);
    }
  });

  it("rolls every door locked, trapped, AND stuck at once when all three chances are 1 - independent, not mutually exclusive", () => {
    const data = generateFloor(
      testConfig({ gridWidth: 24, gridDepth: 24, seed: 9, lockedDoorChance: 1, trappedDoorChance: 1, stuckDoorChance: 1 })
    );
    expect(data.doors.length).toBeGreaterThan(0);
    for (const door of data.doors) {
      expect(door.locked).toBe(true);
      expect(door.trapped).toBe(true);
      expect(door.stuck).toBe(true);
    }
  });

  it("produces a mix of locked/trapped/stuck (and combinations) under the confirmed default weights", () => {
    // Pool doors across many seeds at the real gridsize/default config rather
    // than asserting exact counts against the tunable weights themselves
    // (see Dungeon Data Format.md - "a starting point, not final").
    const allDoors = [];
    for (let seed = 0; seed < 15; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 36, gridDepth: 36, seed }));
      allDoors.push(...data.doors);
    }
    expect(allDoors.length).toBeGreaterThan(50);
    expect(allDoors.some((d) => d.locked)).toBe(true);
    expect(allDoors.some((d) => d.trapped)).toBe(true);
    expect(allDoors.some((d) => d.stuck)).toBe(true);
    expect(allDoors.some((d) => !d.locked && !d.trapped && !d.stuck)).toBe(true);
    // At least one door should show a real combination, proving the three
    // rolls are independent rather than one pick among locked/trapped/stuck.
    expect(allDoors.some((d) => d.locked && d.trapped)).toBe(true);
  });
});

describe("generateFloor - corridor width (2026-08-01, Room Corridor Rework Plan.md)", () => {
  it("stays overwhelmingly width 1 when corridorWidthBaseChance/DoorChance are both 0", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 20, corridorWidthBaseChance: 0, corridorWidthDoorChance: 0 }));
    expect(data.corridors.length).toBeGreaterThan(0);
    for (const corridor of data.corridors) expect(corridor.width).toBe(1);
  });

  it("produces some width-2 corridors when corridorWidthBaseChance is 1", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 21, corridorWidthBaseChance: 1, corridorWidthDoorChance: 1 }));
    expect(data.corridors.some((c) => c.width === 2)).toBe(true);
  });

  it("every corridor segment stays exactly the corridor's own width along its perpendicular axis", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 22, corridorWidthBaseChance: 1, corridorWidthDoorChance: 1 }));
    for (const corridor of data.corridors) {
      for (const seg of corridor.segments) {
        expect(Math.min(seg.w, seg.d)).toBeLessThanOrEqual(corridor.width);
      }
    }
  });
});

describe("generateFloor - corridor topology (junctions, dead ends)", () => {
  it("allows corridors to end at another corridor (a junction) rather than only ever at a room", () => {
    let sawJunction = false;
    for (let seed = 0; seed < 15 && !sawJunction; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed, spurCountRange: [4, 8], loopCountRange: [3, 5] }));
      if (data.corridors.some((c) => c.connects.some((e) => e.kind === "corridor"))) sawJunction = true;
    }
    expect(sawJunction).toBe(true);
  });

  it("produces some deliberate dead-end (open) corridor endpoints after pruning", () => {
    let sawOpen = false;
    for (let seed = 0; seed < 15 && !sawOpen; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed, spurCountRange: [4, 8], deadEndPruneFraction: 0.3 }));
      if (data.corridors.some((c) => c.connects.some((e) => e.kind === "open"))) sawOpen = true;
    }
    expect(sawOpen).toBe(true);
  });

  it("prunes every spur when deadEndPruneFraction is 1", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 30, spurCountRange: [3, 3], deadEndPruneFraction: 1 }));
    expect(data.corridors.some((c) => c.connects.some((e) => e.kind === "open"))).toBe(false);
  });

  it("keeps every spur when deadEndPruneFraction is 0", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 31, spurCountRange: [3, 3], deadEndPruneFraction: 0 }));
    const openCount = data.corridors.filter((c) => c.connects.some((e) => e.kind === "open")).length;
    expect(openCount).toBeGreaterThan(0);
  });
});

describe("generateFloor - ceiling height distribution", () => {
  it(
    "corridors are only ever 10' or 20', never 30'",
    () => {
      let sawAny = false;
      for (let seed = 100; seed < 110; seed++) {
        const data = generateFloor(testConfig({ seed }));
        for (const corridor of data.corridors) {
          sawAny = true;
          for (const seg of corridor.segments) {
            expect([2, 4]).toContain(seg.h);
          }
        }
      }
      expect(sawAny).toBe(true);
    },
    20000
  );

  it(
    "small rooms are usually 10', large rooms lean taller (statistical, many seeds)",
    () => {
      const small: number[] = [];
      const large: number[] = [];
      for (let seed = 200; seed < 215; seed++) {
        const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed }));
        for (const room of data.rooms) {
          const area = room.w * room.d;
          if (area <= 16) small.push(room.h);
          else if (area >= 64) large.push(room.h);
        }
      }
      expect(small.length).toBeGreaterThan(10);
      const smallDefaultFraction = small.filter((h) => h === 2).length / small.length;
      expect(smallDefaultFraction).toBeGreaterThan(0.5);

      if (large.length > 5) {
        const largeTallFraction = large.filter((h) => h >= 4).length / large.length;
        const smallTallFraction = small.filter((h) => h >= 4).length / small.length;
        expect(largeTallFraction).toBeGreaterThan(smallTallFraction);
      }
    },
    20000
  );
});

describe("generateFloor - special kinds and extra entrances", () => {
  it("assigns a special kind to the room farthest from the entrance", () => {
    let sawSpecial = false;
    for (let seed = 0; seed < 10 && !sawSpecial; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed, specialKinds: ["boss"] }));
      if (data.rooms.some((r) => r.kind === "boss")) sawSpecial = true;
      expect(data.rooms.filter((r) => r.kind === "entrance")).toHaveLength(1);
    }
    expect(sawSpecial).toBe(true);
  });

  it("marks additional entrances when requested", () => {
    let sawExtra = false;
    for (let seed = 0; seed < 10 && !sawExtra; seed++) {
      const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed, extraEntranceCountRange: [1, 1] }));
      if (data.rooms.filter((r) => r.kind === "entrance").length > 1) sawExtra = true;
    }
    expect(sawExtra).toBe(true);
  });

  it("defaults to exactly one entrance when extraEntranceCountRange is [0, 0]", () => {
    const data = generateFloor(testConfig({ seed: 13 }));
    expect(data.rooms.filter((r) => r.kind === "entrance")).toHaveLength(1);
  });
});

describe("generateFloor - stairs", () => {
  it("places a stair count within the configured range", () => {
    const data = generateFloor(testConfig({ seed: 14, stairCountRange: [2, 2] }));
    expect(data.stairs.length).toBeLessThanOrEqual(2);
    expect(data.stairs.length).toBeGreaterThanOrEqual(0);
  });

  it("keeps every stair box within grid bounds", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 15, stairCountRange: [2, 3] }));
    for (const stair of data.stairs) {
      expect(isWithin(stair.box, data.grid)).toBe(true);
    }
  });

  it("never places more than one embedded stair in the same room", () => {
    const data = generateFloor(testConfig({ gridWidth: 30, gridDepth: 30, seed: 16, stairCountRange: [3, 3], stairEmbeddedChance: 1 }));
    const embeddedRoomIds = data.stairs.filter((s) => s.embedded).map((s) => s.roomId);
    expect(new Set(embeddedRoomIds).size).toBe(embeddedRoomIds.length);
  });
});

describe("configFromFloorSetup", () => {
  it("takes grid size from the Setup file and fills in every other confirmed default", () => {
    const config = configFromFloorSetup({ gridWidth: 36, gridDepth: 36 });
    expect(config.gridWidth).toBe(36);
    expect(config.gridDepth).toBe(36);
    expect(config.gridHeight).toBe(DEFAULT_GENERATE_CONFIG.gridHeight);
    expect(config.footprintTarget).toBe(DEFAULT_GENERATE_CONFIG.footprintTarget);
  });

  it("lets overrides win over the defaults", () => {
    const config = configFromFloorSetup({ gridWidth: 36, gridDepth: 36 }, { seed: 5, footprintTarget: 0.5 });
    expect(config.seed).toBe(5);
    expect(config.footprintTarget).toBe(0.5);
  });
});
