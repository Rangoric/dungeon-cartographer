// Types + parser for a floor's Setup file - the per-floor, name-matched
// markdown config that drives "Generate Random Map" (`Floor 1.dungeon` is
// paired with `Floor 1 Setup.md`; see Dungeon Generation Notes.md's Dungeon
// Folder Structure section and Simplification Plan.md, 2026-07-31).
//
// Unlike a `.dungeon` file, a Setup file is a normal human-editable Obsidian
// note: a markdown table, not JSON. Schema was grid-size-only at first (see
// Simplification Plan.md's "Per-floor Setup file schema" decision); `Level`
// was added 2026-09-14 (see Dungeon Generator Architecture.md's Physical
// Constraints section - "Dungeon level: each floor has a level (baseline
// encounter CR)" - this is that field finally getting parsed). More fields
// (flair, must-includes, rule overrides) can still be added later if
// actually needed.
//
// Example file contents:
//
//   | Setting     | Value   |
//   | ----------- | ------- |
//   | Grid Size   | 34 × 34 |
//   | Level       | 1       |
//
// Parsing is deliberately forgiving rather than throwing: this is a file a
// person hand-edits, so a missing/malformed row falls back to the standard
// default instead of blocking the generate button on a typo.
//
// Grid Size here is the *generated* area, not the final built footprint -
// confirmed 2026-07-31 (see Block Walls Plan.md): the outer wall ring now
// draws a real block past any edge-touching room, so generation runs 1
// cell inset from the true edges on every side and the exported `.dungeon`
// file's `grid` ends up 2 cells larger (34 generated -> 36 actual), landing
// back on the standing 36x36 total-footprint standard.

export interface FloorSetup {
  gridWidth: number;
  gridDepth: number;
  /**
   * The floor's baseline encounter CR / party level, 1-20 (see Dungeon
   * Generator Architecture.md's Physical Constraints: "each floor has a
   * level"). Added 2026-09-14 alongside `Dungeon Generation/Rules/Lock,
   * Trap & Stuck Door DCs.md`, which keys its DC tables off this number
   * during the Room Content pass. Not currently read by generation itself
   * - `configFromFloorSetup` in generate.ts only maps gridWidth/gridDepth
   * - this is content-layer input, not a physical-layout knob.
   */
  level: number;
}

/** The standard *generated-area* size - see Dungeon Generation Notes.md's "The Basics". Exported `.dungeon` grid ends up 2 cells larger on each axis once the outer wall ring is accounted for (see the module header). Level defaults to 1 (the lowest baseline encounter CR). */
export const DEFAULT_FLOOR_SETUP: FloorSetup = {
  gridWidth: 34,
  gridDepth: 34,
  level: 1,
};

/** Lowest/highest accepted `Level` value - matches the character-level range the Rules folder's DC tables are tiered across. */
const MIN_LEVEL = 1;
const MAX_LEVEL = 20;

/**
 * Parse a floor Setup file's raw markdown text. Looks for a "Grid Size" row
 * in any markdown table (`| Grid Size | 36 × 36 |`, case/spacing-insensitive)
 * and splits its value on `×`/`x`/`X` into width/depth, and a "Level" row
 * (`| Level | 1 |`) parsed as a plain integer, clamped to 1-20. Falls back
 * to `DEFAULT_FLOOR_SETUP` (whole or per-field) whenever a row is missing,
 * unparsable, or the file doesn't look like a settings table at all - never
 * throws, since a hand-edited note is expected to occasionally be malformed
 * mid-edit.
 */
export function parseFloorSetup(fileText: string): FloorSetup {
  return {
    ...parseGridSize(fileText),
    level: parseLevel(fileText),
  };
}

function parseGridSize(fileText: string): Pick<FloorSetup, "gridWidth" | "gridDepth"> {
  const row = findSettingRow(fileText, "grid size");
  if (!row) return { gridWidth: DEFAULT_FLOOR_SETUP.gridWidth, gridDepth: DEFAULT_FLOOR_SETUP.gridDepth };

  const dimensions = row.split(/[×xX]/).map((part) => Number.parseInt(part.trim(), 10));
  const [width, depth] = dimensions;

  return {
    gridWidth: Number.isFinite(width) && width > 0 ? width : DEFAULT_FLOOR_SETUP.gridWidth,
    gridDepth: Number.isFinite(depth) && depth > 0 ? depth : DEFAULT_FLOOR_SETUP.gridDepth,
  };
}

function parseLevel(fileText: string): number {
  const row = findSettingRow(fileText, "level");
  if (!row) return DEFAULT_FLOOR_SETUP.level;

  const parsed = Number.parseInt(row.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FLOOR_SETUP.level;

  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, parsed));
}

/**
 * Finds a markdown table row like `| <name> | <value> |` (case-insensitive,
 * whitespace-tolerant) and returns the trimmed value cell, or `null` if no
 * such row exists. Ignores the table's own header/separator rows implicitly,
 * since those never match a real setting name.
 */
function findSettingRow(fileText: string, settingName: string): string | null {
  const pattern = new RegExp(
    `^\\s*\\|\\s*${escapeRegExp(settingName)}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`,
    "im"
  );
  const match = fileText.match(pattern);
  return match ? match[1].trim() : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
