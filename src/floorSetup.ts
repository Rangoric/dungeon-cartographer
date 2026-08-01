// Types + parser for a floor's Setup file - the per-floor, name-matched
// markdown config that drives "Generate Random Map" (`Floor 1.dungeon` is
// paired with `Floor 1 Setup.md`; see Dungeon Generation Notes.md's Dungeon
// Folder Structure section and Simplification Plan.md, 2026-07-31).
//
// Unlike a `.dungeon` file, a Setup file is a normal human-editable Obsidian
// note: a markdown table, not JSON. Schema is deliberately minimal for now -
// grid size only (see Simplification Plan.md's "Per-floor Setup file schema"
// decision) - more fields (flair, must-includes, rule overrides) can be
// added later if actually needed.
//
// Example file contents:
//
//   | Setting     | Value   |
//   | ----------- | ------- |
//   | Grid Size   | 34 × 34 |
//
// Parsing is deliberately forgiving rather than throwing: this is a file a
// person hand-edits, so a missing/malformed row falls back to the standard
// 34×34 default instead of blocking the generate button on a typo.
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
}

/** The standard *generated-area* size - see Dungeon Generation Notes.md's "The Basics". Exported `.dungeon` grid ends up 2 cells larger on each axis once the outer wall ring is accounted for (see the module header). */
export const DEFAULT_FLOOR_SETUP: FloorSetup = {
  gridWidth: 34,
  gridDepth: 34,
};

/**
 * Parse a floor Setup file's raw markdown text. Looks for a "Grid Size" row
 * in any markdown table (`| Grid Size | 36 × 36 |`, case/spacing-insensitive)
 * and splits its value on `×`/`x`/`X` into width/depth. Falls back to
 * `DEFAULT_FLOOR_SETUP` (whole or per-axis) whenever a row is missing,
 * unparsable, or the file doesn't look like a settings table at all - never
 * throws, since a hand-edited note is expected to occasionally be malformed
 * mid-edit.
 */
export function parseFloorSetup(fileText: string): FloorSetup {
  const row = findSettingRow(fileText, "grid size");
  if (!row) return { ...DEFAULT_FLOOR_SETUP };

  const dimensions = row.split(/[×xX]/).map((part) => Number.parseInt(part.trim(), 10));
  const [width, depth] = dimensions;

  return {
    gridWidth: Number.isFinite(width) && width > 0 ? width : DEFAULT_FLOOR_SETUP.gridWidth,
    gridDepth: Number.isFinite(depth) && depth > 0 ? depth : DEFAULT_FLOOR_SETUP.gridDepth,
  };
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
