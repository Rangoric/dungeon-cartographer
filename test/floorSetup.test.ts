import { describe, it, expect } from "vitest";
import { parseFloorSetup, DEFAULT_FLOOR_SETUP } from "../src/floorSetup";

describe("parseFloorSetup", () => {
  it("parses a Grid Size row with a × separator", () => {
    const text = `| Setting     | Value   |\n| ----------- | ------- |\n| Grid Size   | 36 × 36 |\n`;
    expect(parseFloorSetup(text)).toEqual({ gridWidth: 36, gridDepth: 36 });
  });

  it("accepts a lowercase x separator and asymmetric dimensions", () => {
    const text = `| Grid Size | 24 x 32 |`;
    expect(parseFloorSetup(text)).toEqual({ gridWidth: 24, gridDepth: 32 });
  });

  it("is case- and spacing-insensitive on the setting name", () => {
    const text = `|   grid size   |   20×28   |`;
    expect(parseFloorSetup(text)).toEqual({ gridWidth: 20, gridDepth: 28 });
  });

  it("falls back to the default generated-area size when there's no Grid Size row at all", () => {
    const text = `# Floor 1 Setup\n\nJust some notes, no table yet.`;
    expect(parseFloorSetup(text)).toEqual(DEFAULT_FLOOR_SETUP);
  });

  it("falls back to the default rather than throwing on a malformed value", () => {
    const text = `| Grid Size | not a size |`;
    expect(parseFloorSetup(text)).toEqual(DEFAULT_FLOOR_SETUP);
  });

  it("falls back per-axis when only one dimension parses", () => {
    const text = `| Grid Size | 20 × ??? |`;
    expect(parseFloorSetup(text)).toEqual({ gridWidth: 20, gridDepth: DEFAULT_FLOOR_SETUP.gridDepth });
  });

  it("never throws on completely empty input", () => {
    expect(() => parseFloorSetup("")).not.toThrow();
    expect(parseFloorSetup("")).toEqual(DEFAULT_FLOOR_SETUP);
  });
});

describe("DEFAULT_FLOOR_SETUP", () => {
  it("is the standard 34×34 generated area (36×36 once the outer wall ring is built - see generate.ts's WALL_EXPORT_MARGIN)", () => {
    expect(DEFAULT_FLOOR_SETUP).toEqual({ gridWidth: 34, gridDepth: 34 });
  });
});
