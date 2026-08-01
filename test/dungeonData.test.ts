import { describe, it, expect } from "vitest";
import { parseDungeonFloor, EMPTY_FLOOR_DATA, doorGapCell, doorGapCells } from "../src/dungeonData";

const SAMPLE_JSON = `{
  "grid": { "width": 10, "depth": 10, "height": 6 },
  "rooms": [
    { "id": 0, "kind": "entrance", "x": 1, "y": 2, "z": 0, "w": 2, "d": 2, "h": 2 }
  ],
  "corridors": [],
  "doors": [],
  "stairs": [],
  "regions": []
}
`;

describe("parseDungeonFloor", () => {
  it("parses a plain-JSON .dungeon file", () => {
    const data = parseDungeonFloor(SAMPLE_JSON);
    expect(data.grid).toEqual({ width: 10, depth: 10, height: 6 });
    expect(data.rooms).toHaveLength(1);
    expect(data.rooms[0].kind).toBe("entrance");
  });

  it("throws on text that isn't JSON at all", () => {
    expect(() => parseDungeonFloor("# Floor 1\n\nNo data here.")).toThrow();
  });

  it("throws on malformed JSON rather than silently guessing", () => {
    const broken = "{ not valid json";
    expect(() => parseDungeonFloor(broken)).toThrow();
  });

  it("fills in missing arrays so callers never see undefined", () => {
    const minimal = `{ "grid": { "width": 1, "depth": 1, "height": 1 } }`;
    const data = parseDungeonFloor(minimal);
    expect(data.rooms).toEqual([]);
    expect(data.corridors).toEqual([]);
    expect(data.doors).toEqual([]);
    expect(data.stairs).toEqual([]);
    expect(data.regions).toEqual([]);
  });

  it("treats a missing `finalized` key as not finalized", () => {
    const minimal = `{ "grid": { "width": 1, "depth": 1, "height": 1 } }`;
    const data = parseDungeonFloor(minimal);
    expect(data.finalized).toBe(false);
  });

  it("respects an explicit `finalized: true`", () => {
    const done = `{ "grid": { "width": 1, "depth": 1, "height": 1 }, "finalized": true }`;
    const data = parseDungeonFloor(done);
    expect(data.finalized).toBe(true);
  });

  it("treats a non-boolean `finalized` value as not finalized rather than throwing", () => {
    const weird = `{ "grid": { "width": 1, "depth": 1, "height": 1 }, "finalized": "yes" }`;
    const data = parseDungeonFloor(weird);
    expect(data.finalized).toBe(false);
  });
});

describe("doorGapCell", () => {
  it("returns the midpoint cell between cellA and cellB", () => {
    expect(doorGapCell({ cellA: [3, 5, 0], cellB: [5, 5, 0] })).toEqual([4, 5, 0]);
    expect(doorGapCell({ cellA: [2, 4, 2], cellB: [2, 2, 2] })).toEqual([2, 3, 2]);
  });
});

describe("doorGapCells", () => {
  it("returns just the one midpoint cell for a width-1 door", () => {
    expect(doorGapCells({ cellA: [3, 5, 0], cellB: [5, 5, 0], width: 1 })).toEqual([[4, 5, 0]]);
  });

  it("treats a missing width the same as width 1", () => {
    expect(doorGapCells({ cellA: [3, 5, 0], cellB: [5, 5, 0] } as never)).toEqual([[4, 5, 0]]);
  });

  it("widens along y (not the crossing axis) for a door whose cells differ in x", () => {
    expect(doorGapCells({ cellA: [3, 5, 0], cellB: [5, 5, 0], width: 2 })).toEqual([
      [4, 5, 0],
      [4, 6, 0],
    ]);
  });

  it("widens along x (not the crossing axis) for a door whose cells differ in y", () => {
    expect(doorGapCells({ cellA: [2, 4, 2], cellB: [2, 2, 2], width: 2 })).toEqual([
      [2, 3, 2],
      [3, 3, 2],
    ]);
  });
});

describe("parseDungeonFloor - door width defaulting", () => {
  it("defaults a missing door width to 1 (an older file, written before 2026-07-31)", () => {
    const json = `{
      "grid": { "width": 10, "depth": 10, "height": 6 },
      "doors": [{ "id": 0, "connects": [0, 1], "cellA": [1, 1, 0], "cellB": [3, 1, 0], "material": "wood", "secret": false }]
    }`;
    const data = parseDungeonFloor(json);
    expect(data.doors[0].width).toBe(1);
  });

  it("preserves an explicit width", () => {
    const json = `{
      "grid": { "width": 10, "depth": 10, "height": 6 },
      "doors": [{ "id": 0, "connects": [0, 1], "cellA": [1, 1, 0], "cellB": [3, 1, 0], "material": "wood", "secret": false, "width": 2 }]
    }`;
    const data = parseDungeonFloor(json);
    expect(data.doors[0].width).toBe(2);
  });

  it("treats an invalid width (non-number, zero, negative) as 1 rather than throwing", () => {
    for (const badWidth of [`"two"`, "0", "-1"]) {
      const json = `{
        "grid": { "width": 10, "depth": 10, "height": 6 },
        "doors": [{ "id": 0, "connects": [0, 1], "cellA": [1, 1, 0], "cellB": [3, 1, 0], "material": "wood", "secret": false, "width": ${badWidth} }]
      }`;
      const data = parseDungeonFloor(json);
      expect(data.doors[0].width).toBe(1);
    }
  });
});

describe("EMPTY_FLOOR_DATA", () => {
  it("is a valid, empty floor", () => {
    expect(EMPTY_FLOOR_DATA.rooms).toEqual([]);
    expect(EMPTY_FLOOR_DATA.grid).toEqual({ width: 0, depth: 0, height: 0 });
    expect(EMPTY_FLOOR_DATA.finalized).toBe(false);
  });
});
