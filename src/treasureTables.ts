// Parser + lookup helpers for the treasure tables in `Dungeon Cartographer
// Settings/Treasure/` - plain markdown files, one `## Section` per table,
// converted from the SRD's treasure and magic item pages (see "Dungeon
// Generation/Treasure Generation Plan.md"). treasure.ts does the rolling;
// this file only knows how to read a table and find the row a d% lands on.
//
// Free of Obsidian imports, same as the other content modules.

import type { Rng } from "./generate";

export interface TreasureTable {
  header: string[];
  rows: string[][];
}

/** `"<file name without .md>/<section heading>"`, lowercased -> table. */
export type TreasureTables = Map<string, TreasureTable>;

export function tableKey(file: string, section: string): string {
  return `${file}/${section}`.toLowerCase();
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Parses one treasure file's markdown into its tables, keyed by section heading. */
export function parseTreasureFile(fileName: string, text: string, into: TreasureTables = new Map()): TreasureTables {
  let section: string | null = null;
  let table: TreasureTable | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      table = null;
      continue;
    }
    if (!line.trim().startsWith("|") || section === null) {
      // Any other text ends the current table; a later table in the same section replaces it.
      if (line.trim() !== "") table = null;
      continue;
    }
    const cells = splitRow(line);
    if (!table) {
      table = { header: cells, rows: [] };
      into.set(tableKey(fileName, section), table);
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    table.rows.push(cells);
  }
  return into;
}

/** `"01–04"`, `"17"`, `"100"` -> [lo, hi]; `"—"` or anything else -> null. */
export function parseRange(cell: string): [number, number] | null {
  const m = cell.trim().match(/^(\d+)(?:\s*[–-]\s*(\d+))?$/);
  if (!m) return null;
  const lo = Number(m[1]);
  return [lo, m[2] !== undefined ? Number(m[2]) : lo];
}

/** A row as `{column name -> cell}`. */
export type Row = Record<string, string>;

function toRow(table: TreasureTable, cells: string[]): Row {
  const row: Row = {};
  table.header.forEach((h, i) => (row[h] = cells[i] ?? ""));
  return row;
}

/** Every row of a table as objects. */
export function rowsOf(table: TreasureTable): Row[] {
  return table.rows.map((cells) => toRow(table, cells));
}

/**
 * Rolls d% against `rangeColumn` and returns the row it lands on, or null
 * when that column has no ranges at all (e.g. the Minor column of a table
 * that only has Medium and Major entries). `filter` narrows the rows first
 * (the by-level Treasure table).
 */
export function rollRow(table: TreasureTable, rangeColumn: string, rng: Rng, filter?: (row: Row) => boolean): Row | null {
  const col = table.header.indexOf(rangeColumn);
  if (col < 0) return null;
  const candidates = table.rows
    .map((cells) => ({ cells, range: parseRange(cells[col] ?? "") }))
    .filter((r) => r.range !== null && (!filter || filter(toRow(table, r.cells))));
  if (candidates.length === 0) return null;
  const roll = rng.randint(1, 100);
  const hit = candidates.find((r) => roll >= r.range![0] && roll <= r.range![1]);
  // A gap in a hand-edited table shouldn't throw: fall back to the nearest row.
  const chosen = hit ?? candidates.reduce((best, r) => (Math.abs(r.range![0] - roll) < Math.abs(best.range![0] - roll) ? r : best));
  return toRow(table, chosen.cells);
}

/** `"1d6 × 1,000"`, `"2d4 x 10 gp"`, `"4d4"`, `"3"` -> a rolled total. Unparseable text rolls 0. */
export function rollDice(expr: string, rng: Rng): number {
  const text = expr.replace(/,/g, "");
  const dice = text.match(/(\d+)d(\d+)(?:\s*[×xX*]\s*(\d+))?/);
  if (dice) {
    let total = 0;
    for (let i = 0; i < Number(dice[1]); i++) total += rng.randint(1, Number(dice[2]));
    return total * (dice[3] ? Number(dice[3]) : 1);
  }
  const plain = text.match(/\d+/);
  return plain ? Number(plain[0]) : 0;
}

const COIN_GP: Record<string, number> = { cp: 0.01, sp: 0.1, gp: 1, pp: 10 };

/** `"1,000 gp"`, `"+350 gp"`, `"12 gp 5 sp"` -> gp value; no coin amounts -> 0. */
export function parseGp(text: string): number {
  let total = 0;
  for (const m of text.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*(cp|sp|gp|pp)\b/g)) {
    total += Number(m[1]) * COIN_GP[m[2]];
  }
  return total;
}

export function coinValue(amount: number, unit: string): number {
  return amount * (COIN_GP[unit] ?? 0);
}

/** `"25%"` -> 0.25, `"20"` -> 20. */
export function parseSettingNumber(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(%?)$/);
  if (!m) return null;
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}
