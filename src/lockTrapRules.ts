// Types + parser for the Lock, Trap & Stuck Door DCs settings file - the
// content-layer DC lookup table for `locked`/`trapped`/`stuck` doors (see
// "Dungeon Generation/Locks & Traps Content Plan.md", Plan step 2). Reads
// from the live vault copy at `Dungeon Cartographer Settings/Lock, Trap &
// Stuck Door DCs.md` (moved there 2026-09-18 - see settingsSync.ts/
// settingsDefaults.ts; not `Dungeon Generation/Rules/`, which is now empty).
//
// Same "data, not code" reasoning as floorSetup.ts's Grid Size/Level rows:
// the table is a normal Obsidian note a person retunes by hand, so parsing
// is deliberately forgiving - a missing/malformed row falls back to
// DEFAULT_LOCK_TRAP_RULES (whole or per-table) rather than throwing or
// blocking generation. The trapped-door table's `19 + Level` formula is
// stated as prose in the file, but this parser never hardcodes that
// constant: it derives DCs between/beyond the table's own level points by
// linear interpolation of whatever rows are actually present, so a
// hand-edited table (different intercept, different slope, more or fewer
// points) still works without a matching code change.
//
// This module only parses the table into a typed lookup - it does not read
// the file off disk or roll a door's challenge level. That's Plan step 3
// ("wire the generation step"), which will read the settings file the same
// way `main.ts` already reads a floor's Setup file for `parseFloorSetup()`
// (`vault.read` an abstract file, then hand the text to a pure parser).
//
// Example file contents (see the live file for the real prose around each
// table):
//
//   | Floor Level | Lock Quality | Open Lock DC |
//   | --- | --- | --- |
//   | 1–5   | Very simple | 20 |
//   | 6–10  | Average     | 25 |
//   | 11–15 | Good        | 30 |
//   | 16–20 | Superior    | 40 |
//
//   | Floor Level | Search / Disable Device DC |
//   | --- | --- |
//   | 1  | 20 |
//   | 5  | 24 |
//   | 10 | 29 |
//   | 15 | 34 |
//   | 20 | 39 |
//
//   | Condition | Break DC |
//   | --- | --- |
//   | Stuck only | 15 |
//   | Stuck + Locked | 20 |
//   | Stuck + Trapped | 20 |
//   | Stuck + Locked + Trapped | 25 |

/** One row of the locked-door table: a floor-level band mapped to a lock quality and its Open Lock DC. */
export interface LockedDoorTier {
  minLevel: number;
  maxLevel: number;
  quality: string;
  dc: number;
}

/** One row of the trapped-door table: a floor level mapped to its Search/Disable Device DC. */
export interface TrappedDoorPoint {
  level: number;
  dc: number;
}

/** The four stuck-door break DCs, keyed by which other conditions stack with `stuck`. */
export interface StuckDoorBreakDC {
  stuckOnly: number;
  stuckLocked: number;
  stuckTrapped: number;
  stuckLockedTrapped: number;
}

export interface LockTrapRules {
  lockedDoorDC: LockedDoorTier[];
  trappedDoorDC: TrappedDoorPoint[];
  stuckDoorBreakDC: StuckDoorBreakDC;
}

/** The table values as they stand in the live vault file as of 2026-09-25 - see the module header for the file path. */
export const DEFAULT_LOCK_TRAP_RULES: LockTrapRules = {
  lockedDoorDC: [
    { minLevel: 1, maxLevel: 5, quality: "Very simple", dc: 20 },
    { minLevel: 6, maxLevel: 10, quality: "Average", dc: 25 },
    { minLevel: 11, maxLevel: 15, quality: "Good", dc: 30 },
    { minLevel: 16, maxLevel: 20, quality: "Superior", dc: 40 },
  ],
  trappedDoorDC: [
    { level: 1, dc: 20 },
    { level: 5, dc: 24 },
    { level: 10, dc: 29 },
    { level: 15, dc: 34 },
    { level: 20, dc: 39 },
  ],
  stuckDoorBreakDC: {
    stuckOnly: 15,
    stuckLocked: 20,
    stuckTrapped: 20,
    stuckLockedTrapped: 25,
  },
};

/**
 * Parse the Lock, Trap & Stuck Door DCs settings file's raw markdown text
 * into a typed `LockTrapRules`. Each of the three tables is parsed
 * independently and falls back to `DEFAULT_LOCK_TRAP_RULES`'s matching
 * table when its own rows are missing or entirely unparsable - never
 * throws, same as `parseFloorSetup`.
 */
export function parseLockTrapRules(fileText: string): LockTrapRules {
  return {
    lockedDoorDC: parseLockedDoorTable(fileText),
    trappedDoorDC: parseTrappedDoorTable(fileText),
    stuckDoorBreakDC: parseStuckDoorTable(fileText),
  };
}

const EN_DASH_RANGE = /^(\d+)\s*[–-]\s*(\d+)$/;

function parseLockedDoorTable(fileText: string): LockedDoorTier[] {
  const tiers: LockedDoorTier[] = [];

  for (const row of findTableRows(fileText, 3)) {
    const [levelBand, quality, dcCell] = row;
    const range = levelBand.trim().match(EN_DASH_RANGE);
    const dc = Number.parseInt(dcCell.trim(), 10);
    if (!range || !quality.trim() || !Number.isFinite(dc)) continue;

    const minLevel = Number.parseInt(range[1], 10);
    const maxLevel = Number.parseInt(range[2], 10);
    if (!Number.isFinite(minLevel) || !Number.isFinite(maxLevel) || minLevel > maxLevel) continue;

    tiers.push({ minLevel, maxLevel, quality: quality.trim(), dc });
  }

  tiers.sort((a, b) => a.minLevel - b.minLevel);
  return tiers.length > 0 ? tiers : DEFAULT_LOCK_TRAP_RULES.lockedDoorDC;
}

function parseTrappedDoorTable(fileText: string): TrappedDoorPoint[] {
  const points: TrappedDoorPoint[] = [];

  for (const row of findTableRows(fileText, 2)) {
    const [levelCell, dcCell] = row;
    const level = Number.parseInt(levelCell.trim(), 10);
    const dc = Number.parseInt(dcCell.trim(), 10);
    if (!Number.isFinite(level) || !Number.isFinite(dc)) continue;

    points.push({ level, dc });
  }

  points.sort((a, b) => a.level - b.level);
  return points.length > 0 ? points : DEFAULT_LOCK_TRAP_RULES.trappedDoorDC;
}

function parseStuckDoorTable(fileText: string): StuckDoorBreakDC {
  const result: Partial<StuckDoorBreakDC> = {};
  const conditionKeys: Record<string, keyof StuckDoorBreakDC> = {
    "stuck only": "stuckOnly",
    "stuck + locked": "stuckLocked",
    "stuck + trapped": "stuckTrapped",
    "stuck + locked + trapped": "stuckLockedTrapped",
  };

  for (const row of findTableRows(fileText, 2)) {
    const [conditionCell, dcCell] = row;
    const key = conditionKeys[conditionCell.trim().toLowerCase()];
    const dc = Number.parseInt(dcCell.trim(), 10);
    if (!key || !Number.isFinite(dc)) continue;

    result[key] = dc;
  }

  return {
    stuckOnly: result.stuckOnly ?? DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckOnly,
    stuckLocked: result.stuckLocked ?? DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckLocked,
    stuckTrapped: result.stuckTrapped ?? DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckTrapped,
    stuckLockedTrapped: result.stuckLockedTrapped ?? DEFAULT_LOCK_TRAP_RULES.stuckDoorBreakDC.stuckLockedTrapped,
  };
}

/**
 * Finds every markdown table row with exactly `columnCount` cells
 * (`| a | b | c |`), skipping the header/separator rows (a cell that's
 * entirely `-`/`:` is a separator; a row matching a known column-header
 * label is a header) and returning each row's cells as trimmed strings.
 * Table-format-agnostic on purpose - doesn't care which of the file's three
 * tables a row came from, since column count plus per-table validation in
 * the caller (a parseable range, a known condition name, etc.) is enough to
 * tell them apart.
 */
function findTableRows(fileText: string, columnCount: number): string[][] {
  const rowPattern = /^\s*\|(.+)\|\s*$/gm;
  const rows: string[][] = [];

  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(fileText)) !== null) {
    const cells = match[1].split("|").map((cell) => cell.trim());
    if (cells.length !== columnCount) continue;
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue; // separator row
    if (isHeaderRow(cells)) continue;

    rows.push(cells);
  }

  return rows;
}

const HEADER_CELLS = new Set([
  "floor level",
  "lock quality",
  "open lock dc",
  "search / disable device dc",
  "condition",
  "break dc",
]);

function isHeaderRow(cells: string[]): boolean {
  return cells.some((cell) => HEADER_CELLS.has(cell.toLowerCase()));
}

/**
 * Look up the Open Lock DC for a door's challenge level, clamped to the
 * table's own min/max tier so an out-of-range level (shouldn't happen once
 * levels are clamped 1-20 upstream, same as `floorSetup.ts`'s Level field)
 * still resolves rather than returning `undefined`.
 */
export function lookupLockedDoorDC(rules: LockTrapRules, level: number): LockedDoorTier {
  const tiers = rules.lockedDoorDC.length > 0 ? rules.lockedDoorDC : DEFAULT_LOCK_TRAP_RULES.lockedDoorDC;

  const tier = tiers.find((t) => level >= t.minLevel && level <= t.maxLevel);
  if (tier) return tier;

  return level < tiers[0].minLevel ? tiers[0] : tiers[tiers.length - 1];
}

/**
 * Look up the Search/Disable Device DC for a door's challenge level.
 * Linearly interpolates between the two nearest known points when `level`
 * falls between them, and extrapolates along the nearest two points' slope
 * when it falls outside the table's range - this is what lets the table
 * stay data (see the module header) instead of hardcoding the `19 + Level`
 * formula stated in the file's prose.
 */
export function lookupTrappedDoorDC(rules: LockTrapRules, level: number): number {
  const points = rules.trappedDoorDC.length > 0 ? rules.trappedDoorDC : DEFAULT_LOCK_TRAP_RULES.trappedDoorDC;

  if (points.length === 1) return points[0].dc;

  const exact = points.find((p) => p.level === level);
  if (exact) return exact.dc;

  let lower = points[0];
  let upper = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (level >= points[i].level && level <= points[i + 1].level) {
      lower = points[i];
      upper = points[i + 1];
      break;
    }
  }
  if (level < points[0].level) {
    lower = points[0];
    upper = points[1];
  } else if (level > points[points.length - 1].level) {
    lower = points[points.length - 2];
    upper = points[points.length - 1];
  }

  const slope = (upper.dc - lower.dc) / (upper.level - lower.level);
  return Math.round(lower.dc + slope * (level - lower.level));
}

/**
 * Look up the Strength-check break DC to force a stuck door, given whether
 * it's also locked and/or trapped. Only meaningful when the door is
 * actually `stuck` - callers should guard on that themselves, same as this
 * whole module never sees a door's physical flags directly (see
 * generate.ts's `doors[]` for those).
 */
export function lookupStuckDoorBreakDC(
  rules: LockTrapRules,
  conditions: { locked: boolean; trapped: boolean }
): number {
  const dcs = rules.stuckDoorBreakDC;
  if (conditions.locked && conditions.trapped) return dcs.stuckLockedTrapped;
  if (conditions.locked) return dcs.stuckLocked;
  if (conditions.trapped) return dcs.stuckTrapped;
  return dcs.stuckOnly;
}
