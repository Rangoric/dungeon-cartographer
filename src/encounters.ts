// Encounter & trap generation for a floor - "Dungeon Generation/Dungeon
// Setup.md" is the design this implements. Given a floor's Level, its
// chosen factions (each a `Dungeon Cartographer Settings/Factions/<Name>.md`
// file with an Encounters table), any preselected monsters, the vault's
// monster pool and `Sample Traps.md`, it rolls:
//
//   1. The floor's 8-entry Monster List (CR from Level-3 to Level+2, at
//      most 2 above Level, 1 per faction, the rest random).
//   2. The Wandering Monsters table (the 6 lowest-CR entries, as a d6).
//   3. 9-11 floor encounters, 2-3 of which are traps.
//
// Deliberately free of Obsidian imports, same as generate.ts/doorNotes.ts -
// main.ts does the vault I/O (reading the Setup/faction/monster/trap files
// and writing `Floor N Encounters.md`) and calls the pure functions here.
//
// Defaults chosen for the still-open questions in Dungeon Setup.md (v1,
// 2026-09-30) - each is a single constant or branch below, easy to change:
//   - Preselected monsters take Monster List slots first; the faction slots
//     come next in priority, and whatever is left is split 3 random first,
//     then the rest random (8 total).
//   - If nothing is above Level yet, the first random slot is forced to +1
//     or +2, guaranteeing at least one above-Level monster.
//   - CR offsets -3..+2 are equally likely. Above-Level offsets can't
//     repeat, so at most 2 entries (+1 and +2) are above Level.
//   - No monster is picked twice for the Monster List.
//   - Below CR 1: Level+0 -> 1/2, Level-1 -> 1/3, Level-2 -> 1/4.
//   - A faction slot picks a whole row from the faction's Encounters table
//     at the rolled CR. Below Level, that row gets the same x2-x4
//     multiplier as a random monster - every count in the row is
//     multiplied (a "Duodrone pair" at -2 becomes 6 duodrones) - so faction
//     encounters land at the same EL as random ones, as bigger groups.
//     Faction tables start at CR 1, so a faction slot rerolls anything
//     below CR 1.
//   - Random monsters come from terrain_hex Underground or Any (the same
//     filter as `Dungeon Monsters.base`).
//   - Encounters are fully random after the first (an above-Level entry);
//     an above-Level entry appears at most once per floor.
//   - Traps: CR Level to Level+2, a random `Sample Traps.md` entry of that CR.

import type { Rng } from "./generate";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MONSTER_LIST_SIZE = 8;
export const FIRST_RANDOM_COUNT = 3;
export const MAX_FACTIONS = 3;
export const MIN_OFFSET = -3;
export const MAX_OFFSET = 2;
export const MAX_ABOVE_LEVEL = 2;
export const WANDERING_COUNT = 6;
export const ENCOUNTER_TOTAL_RANGE: [number, number] = [9, 11];
export const TRAP_COUNT_RANGE: [number, number] = [2, 3];
export const TRAP_OFFSET_RANGE: [number, number] = [0, 2];

/** CR for a Level+offset below 1 - see the module header. */
const FRACTIONAL_CRS: Record<number, number> = { 0: 1 / 2, [-1]: 1 / 3, [-2]: 1 / 4 };

// ---------------------------------------------------------------------------
// CR helpers
// ---------------------------------------------------------------------------

/** `"4"` -> 4, `"1/2"` -> 0.5; anything else (`"-"`, `"9 (class level + 4)"`, blank) -> null. */
export function parseCR(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const whole = text.match(/^(\d+)$/);
  if (whole) {
    const n = Number(whole[1]);
    return n > 0 ? n : null;
  }
  const frac = text.match(/^1\s*\/\s*(\d+)$/);
  if (frac) {
    const d = Number(frac[1]);
    return d > 0 ? 1 / d : null;
  }
  return null;
}

/** 0.5 -> `"1/2"`, 4 -> `"4"`. */
export function formatCR(cr: number): string {
  if (cr >= 1) return String(Math.round(cr));
  return `1/${Math.round(1 / cr)}`;
}

/** Same CR within float noise (1/3 vs 0.3333...). */
function sameCR(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/** The CR a Level+offset roll lands on - fractional below 1, null below the lowest fractional step. */
export function crForOffset(level: number, offset: number): number | null {
  const raw = level + offset;
  if (raw >= 1) return raw;
  return FRACTIONAL_CRS[raw] ?? null;
}

/** Inverse of `crForOffset`: CR 5 on Level 4 -> +1, CR 1/2 on Level 1 -> 0. Fractional CRs below 1/4 count as 1/4's step. */
export function offsetForCR(level: number, cr: number): number {
  if (cr >= 1) return Math.round(cr) - level;
  const steps = Object.entries(FRACTIONAL_CRS)
    .map(([raw, value]) => ({ raw: Number(raw), value }))
    .sort((a, b) => b.value - a.value);
  const step = steps.find((s) => cr >= s.value - 1e-6) ?? steps[steps.length - 1];
  return step.raw - level;
}

/** Group size for a random monster at `offset` below Level: -3 -> 4, -2 -> 3, -1 -> 2, else 1. */
export function groupSizeForOffset(offset: number): number {
  return offset < 0 ? 1 - offset : 1;
}

/** EL of `multiplier` copies of an EL-`el` group: each doubling adds 2 (x2 -> +2, x3 -> +3.2, x4 -> +4). */
export function multipliedEL(el: number, multiplier: number): number {
  return multiplier > 1 ? el + 2 * Math.log2(multiplier) : el;
}

/**
 * Grows a faction row by `multiplier` (the below-Level x2-x4): every count
 * in the row is multiplied, leaders included - "1 duodrone (leader), 2
 * monodrones" x2 becomes 2 duodrones + 4 monodrones, i.e. two copies of the
 * squad. The `(leader)` mark is kept for display only.
 */
export function multiplyFactionRow(row: FactionEncounter, multiplier: number): { group: GroupMember[]; el: number } {
  if (multiplier <= 1) return { group: row.monsters.map((m) => ({ ...m })), el: row.el };
  return {
    group: row.monsters.map((m) => ({ ...m, count: m.count * multiplier })),
    el: multipliedEL(row.el, multiplier),
  };
}

/** Relative "power" of one creature of `cr`, such that 2 of CR N = CR N+2 and 2 of CR 1/2 = CR 1. */
function crPower(cr: number): number {
  return cr >= 1 ? 2 ** (cr / 2) : cr * Math.SQRT2;
}

/** 3.5e Encounter Level of a group, unrounded. */
export function encounterLevel(group: { count: number; cr: number }[]): number {
  const total = group.reduce((sum, g) => sum + g.count * crPower(g.cr), 0);
  if (total <= 0) return 0;
  if (total < Math.SQRT2) return total / Math.SQRT2; // below EL 1 - same linear rule as fractional CRs
  return 2 * Math.log2(total);
}

// ---------------------------------------------------------------------------
// Setup file (encounter-specific rows)
// ---------------------------------------------------------------------------

export interface EncounterSetup {
  /** Faction names, as written - each should match a `Factions/<Name>.md` file. */
  factions: string[];
  /** Preselected monster names (file basenames). */
  preselected: string[];
  /** A fixed seed from a `Seed` row, or null to roll a fresh one. */
  seed: number | null;
}

function findSettingRow(fileText: string, settingName: string): string | null {
  const escaped = settingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*\\|\\s*${escaped}\\s*\\|(.*)\\|\\s*$`, "im");
  const match = fileText.match(pattern);
  return match ? match[1].trim() : null;
}

/** `[[Name]]`/`[[Name|alias]]` link targets in `text`, in order. */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
}

function isEmptyValue(text: string): boolean {
  return /^(|-+|—|none|\(none\))$/i.test(text.trim());
}

/**
 * Reads the `Factions`, `Preselected Monsters` and `Seed` rows of a floor
 * Setup file. Factions may be links or a comma-separated list of names.
 * Preselected monsters may be links or a `;`-separated list (monster names
 * contain commas, e.g. "Modron, tridrone", so commas can't separate them).
 * Missing or empty rows just mean "none" - never throws.
 */
export function parseEncounterSetup(fileText: string): EncounterSetup {
  const factionsRow = findSettingRow(fileText, "Factions") ?? "";
  let factions: string[] = [];
  if (!isEmptyValue(factionsRow)) {
    const links = linkTargets(factionsRow);
    factions = links.length > 0 ? links : factionsRow.split(",").map(cleanName).filter(Boolean);
  }

  const preselectedRow = findSettingRow(fileText, "Preselected Monsters") ?? "";
  let preselected: string[] = [];
  if (!isEmptyValue(preselectedRow)) {
    const links = linkTargets(preselectedRow);
    preselected = links.length > 0 ? links : preselectedRow.split(";").map(cleanName).filter(Boolean);
  }

  const seedRow = findSettingRow(fileText, "Seed");
  const seed = seedRow && /^\d+$/.test(seedRow) ? Number(seedRow) : null;

  return { factions, preselected, seed };
}

function cleanName(text: string): string {
  return text.trim().replace(/^['"`]+|['"`]+$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Faction files
// ---------------------------------------------------------------------------

export interface GroupMember {
  count: number;
  name: string;
  /** Marked `(leader)` in the faction file - who commands the group (display only; multiplied like everyone else). */
  leader?: boolean;
}

export interface FactionEncounter {
  cr: number;
  name: string;
  monsters: GroupMember[];
  /** The row's EL column, if present - otherwise its CR. */
  el: number;
}

export interface Faction {
  name: string;
  encounters: FactionEncounter[];
  /** Member name -> CR, from the faction file's Members table. */
  memberCRs: Record<string, number>;
}

/** `1× [[Modron, pentadrone]] (leader), 2× [[Modron, tridrone]]` -> members. Accepts `×`, `x` or `*`. */
export function parseGroupCell(cell: string): GroupMember[] {
  const members: GroupMember[] = [];
  for (const m of cell.matchAll(/(\d+)\s*[×xX*]\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\](\s*\(leader\))?/gi)) {
    const member: GroupMember = { count: Number(m[1]), name: m[2].trim() };
    if (m[3]) member.leader = true;
    members.push(member);
  }
  return members;
}

/**
 * Parses a faction file's Encounters table: rows shaped
 * `| CR | # | Encounter | Monsters | EL |`. Rows whose Monsters cell has no
 * `N× [[Monster]]` entries (the Members table, headers) are skipped.
 */
export function parseFactionFile(name: string, fileText: string): Faction {
  const encounters: FactionEncounter[] = [];
  const memberCRs: Record<string, number> = {};
  for (const line of fileText.split(/\r?\n/)) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const memberLink = cells[0]?.match(/^\[\[([^\]|#]+)\]\]$/);
    if (memberLink && cells.length >= 2) {
      const cr = parseCR(cells[1]);
      if (cr !== null) memberCRs[memberLink[1].trim()] = cr;
      continue;
    }
    if (cells.length < 4) continue;
    const cr = /^\d+$/.test(cells[0]) ? Number(cells[0]) : null;
    if (cr === null || !/^\d+$/.test(cells[1])) continue;
    const monsters = parseGroupCell(cells[3]);
    if (monsters.length === 0) continue;
    const elCell = cells[4] !== undefined ? Number.parseFloat(cells[4]) : NaN;
    encounters.push({ cr, name: cells[2], monsters, el: Number.isFinite(elCell) ? elCell : cr });
  }
  return { name, encounters, memberCRs };
}

// ---------------------------------------------------------------------------
// Traps
// ---------------------------------------------------------------------------

export interface TrapEntry {
  name: string;
  cr: number;
  /** Stat line without the leading CR and the trailing market price/cost. */
  description: string;
}

/** Every `**Name**: CR N; ...` entry in Sample Traps.md, with its CR. */
export function parseTrapsByCR(fileText: string): TrapEntry[] {
  const entries: TrapEntry[] = [];
  for (const m of fileText.matchAll(/^\*\*(.+?)\*\*:\s*CR\s*(\d+)\s*;\s*(.+)$/gm)) {
    const description = m[3]
      .split(/\.?\s*(?:Market Price|Cost)\s*:/i)[0]
      .trim()
      .replace(/[.;,\s]+$/, "");
    entries.push({ name: m[1].trim(), cr: Number(m[2]), description });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface PoolMonster {
  name: string;
  cr: number;
}

export interface EncounterGenInput {
  level: number;
  /** Factions actually found, in Setup order (already capped at MAX_FACTIONS by the caller or here). */
  factions: Faction[];
  /** Preselected monsters with their CR (null when the monster file or its CR wasn't found). */
  preselected: { name: string; cr: number | null }[];
  /** The random-pick pool (already filtered to dungeon-suitable monsters). */
  pool: PoolMonster[];
  traps: TrapEntry[];
  rng: Rng;
}

export type ListSource = { kind: "preselected" } | { kind: "random" } | { kind: "faction"; faction: string };

export interface ListEntry {
  /** 1-based slot number in the Monster List. */
  slot: number;
  source: ListSource;
  cr: number;
  /** CR relative to the floor's Level (null for a preselected monster with no known CR). */
  offset: number | null;
  /** Display name - the monster, the faction encounter's name, or a placeholder label. */
  label: string;
  group: GroupMember[];
  el: number;
  /** True when nothing matched and this is a stand-in that needs a hand-pick. */
  placeholder: boolean;
}

export interface FloorEncounter {
  id: string;
  kind: "monster" | "trap";
  /** For monsters: the Monster List slot it came from. */
  slot?: number;
  label: string;
  group: GroupMember[];
  el: number;
  trap?: TrapEntry;
}

export interface EncounterGenResult {
  list: ListEntry[];
  wandering: ListEntry[];
  encounters: FloorEncounter[];
  flags: string[];
}

function isAbove(entry: ListEntry): boolean {
  return entry.offset !== null && entry.offset > 0;
}

export function generateEncounters(input: EncounterGenInput): EncounterGenResult {
  const { level, rng } = input;
  const flags: string[] = [];
  const list: ListEntry[] = [];
  const usedAbove = new Set<number>();
  const usedNames = new Set<string>();

  const aboveAllowed = (offset: number) =>
    offset <= 0 || (!usedAbove.has(offset) && usedAbove.size < MAX_ABOVE_LEVEL);

  /** Rolls Level-3..Level+2, rerolling above-Level repeats and (when `minCR` is set) CRs below it. */
  const rollOffset = (minCR = 0): number => {
    for (let i = 0; i < 200; i++) {
      const offset = rng.randint(MIN_OFFSET, MAX_OFFSET);
      const cr = crForOffset(level, offset);
      if (cr === null || cr < minCR) continue;
      if (!aboveAllowed(offset)) continue;
      return offset;
    }
    return 0;
  };

  const pushRandom = (offset: number) => {
    const cr = crForOffset(level, offset)!;
    if (offset > 0) usedAbove.add(offset);
    const candidates = input.pool.filter((m) => sameCR(m.cr, cr) && !usedNames.has(m.name));
    const size = groupSizeForOffset(offset);
    if (candidates.length === 0) {
      flags.push(`No unused dungeon monster at CR ${formatCR(cr)} - slot ${list.length + 1} is a placeholder.`);
      list.push({
        slot: list.length + 1,
        source: { kind: "random" },
        cr,
        offset,
        label: `Placeholder: CR ${formatCR(cr)} monster`,
        group: [],
        el: encounterLevel([{ count: size, cr }]),
        placeholder: true,
      });
      return;
    }
    const pick = rng.choice(candidates);
    usedNames.add(pick.name);
    list.push({
      slot: list.length + 1,
      source: { kind: "random" },
      cr,
      offset,
      label: pick.name,
      group: [{ count: size, name: pick.name }],
      el: encounterLevel([{ count: size, cr }]),
      placeholder: false,
    });
  };

  // 1. Preselected monsters.
  const preselected = input.preselected.slice(0, MONSTER_LIST_SIZE);
  if (input.preselected.length > MONSTER_LIST_SIZE) {
    flags.push(`More than ${MONSTER_LIST_SIZE} preselected monsters - only the first ${MONSTER_LIST_SIZE} were used.`);
  }
  for (const p of preselected) {
    usedNames.add(p.name);
    if (p.cr === null) {
      flags.push(`Preselected monster "${p.name}" has no usable CR (or wasn't found) - listed once, CR unknown.`);
      list.push({
        slot: list.length + 1,
        source: { kind: "preselected" },
        cr: level,
        offset: null,
        label: p.name,
        group: [{ count: 1, name: p.name }],
        el: level,
        placeholder: false,
      });
      continue;
    }
    const offset = offsetForCR(level, p.cr);
    if (offset > 0) usedAbove.add(offset);
    const size = offset >= MIN_OFFSET ? groupSizeForOffset(offset) : 1;
    list.push({
      slot: list.length + 1,
      source: { kind: "preselected" },
      cr: p.cr,
      offset,
      label: p.name,
      group: [{ count: size, name: p.name }],
      el: encounterLevel([{ count: size, cr: p.cr }]),
      placeholder: false,
    });
  }

  let open = MONSTER_LIST_SIZE - list.length;
  const factions = input.factions.slice(0, Math.min(MAX_FACTIONS, open));
  const randomSlots = open - factions.length;
  const firstRandom = Math.min(FIRST_RANDOM_COUNT, randomSlots);

  // 2. The first random monsters - the first one forced above Level if nothing is yet.
  for (let i = 0; i < firstRandom; i++) {
    if (i === 0 && usedAbove.size === 0) {
      const options = [1, 2].filter((o) => crForOffset(level, o) !== null && o <= MAX_OFFSET);
      pushRandom(rng.choice(options));
    } else {
      pushRandom(rollOffset());
    }
  }

  // 3. One encounter per faction.
  for (const faction of factions) {
    const offset = rollOffset(1);
    const cr = crForOffset(level, offset)!;
    if (offset > 0) usedAbove.add(offset);
    const rows = faction.encounters.filter((e) => e.cr === cr);
    if (rows.length === 0) {
      flags.push(`${faction.name} has no encounter at CR ${formatCR(cr)} - slot ${list.length + 1} is a placeholder.`);
      list.push({
        slot: list.length + 1,
        source: { kind: "faction", faction: faction.name },
        cr,
        offset,
        label: `Placeholder: CR ${formatCR(cr)} ${faction.name} encounter${groupSizeForOffset(offset) > 1 ? ` ×${groupSizeForOffset(offset)}` : ""}`,
        group: [],
        el: multipliedEL(cr, groupSizeForOffset(offset)),
        placeholder: true,
      });
      continue;
    }
    const row = rng.choice(rows);
    const multiplier = groupSizeForOffset(offset);
    const scaled = multiplyFactionRow(row, multiplier);
    list.push({
      slot: list.length + 1,
      source: { kind: "faction", faction: faction.name },
      cr,
      offset,
      label: multiplier > 1 ? `${row.name} ×${multiplier}` : row.name,
      group: scaled.group,
      el: scaled.el,
      placeholder: false,
    });
  }

  // 4. The rest random.
  open = MONSTER_LIST_SIZE - list.length;
  for (let i = 0; i < open; i++) pushRandom(rollOffset());

  // Wandering monsters: the 6 lowest CRs (stable on ties - Monster List order).
  const wandering = [...list]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.cr - b.e.cr || a.i - b.i)
    .slice(0, WANDERING_COUNT)
    .map((x) => x.e);

  // Floor encounters.
  const total = rng.randint(...ENCOUNTER_TOTAL_RANGE);
  const trapCount = rng.randint(...TRAP_COUNT_RANGE);
  const monsterCount = total - trapCount;
  const encounters: FloorEncounter[] = [];
  const aboveSeen = new Set<number>();

  const toEncounter = (entry: ListEntry): FloorEncounter => ({
    id: `E${encounters.length + 1}`,
    kind: "monster",
    slot: entry.slot,
    label: entry.label,
    group: entry.group,
    el: entry.el,
  });

  const aboveEntries = list.filter(isAbove);
  if (aboveEntries.length > 0 && monsterCount > 0) {
    const first = rng.choice(aboveEntries);
    aboveSeen.add(first.slot);
    encounters.push(toEncounter(first));
  }
  while (encounters.length < monsterCount) {
    const options = list.filter((e) => !isAbove(e) || !aboveSeen.has(e.slot));
    if (options.length === 0) break;
    const pick = rng.choice(options);
    if (isAbove(pick)) aboveSeen.add(pick.slot);
    encounters.push(toEncounter(pick));
  }

  // Traps.
  const trapCRs = [...new Set(input.traps.map((t) => t.cr))].sort((a, b) => a - b);
  const usedTraps = new Set<string>();
  for (let i = 0; i < trapCount; i++) {
    const id = `T${i + 1}`;
    const wanted = level + rng.randint(...TRAP_OFFSET_RANGE);
    if (trapCRs.length === 0) {
      flags.push(`Sample Traps.md has no traps - ${id} is a placeholder.`);
      encounters.push({ id, kind: "trap", label: `Placeholder: CR ${wanted} trap`, group: [], el: wanted });
      continue;
    }
    const lower = trapCRs.filter((c) => c <= wanted);
    const cr = lower.length > 0 ? lower[lower.length - 1] : trapCRs[0];
    if (cr !== wanted) flags.push(`No sample trap at CR ${wanted} - ${id} uses a CR ${cr} trap instead.`);
    let options = input.traps.filter((t) => t.cr === cr && !usedTraps.has(t.name));
    if (options.length === 0) options = input.traps.filter((t) => t.cr === cr);
    const trap = rng.choice(options);
    usedTraps.add(trap.name);
    encounters.push({ id, kind: "trap", label: trap.name, group: [], el: trap.cr, trap });
  }

  return { list, wandering, encounters, flags };
}

// ---------------------------------------------------------------------------
// Output note
// ---------------------------------------------------------------------------

export interface EncounterNoteParams {
  floorBasename: string;
  level: number;
  factionNames: string[];
  seed: number;
  generatedOn: string;
  result: EncounterGenResult;
  /** Extra markdown lines appended after the Encounters table (the Treasure section). */
  extraSections?: string[];
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatGroup(group: GroupMember[]): string {
  return group.map((g) => `${g.count}× [[${g.name}]]${g.leader ? " (leader)" : ""}`).join(", ");
}

function formatOffset(offset: number | null): string {
  if (offset === null) return "?";
  if (offset === 0) return "±0";
  return offset > 0 ? `+${offset}` : `−${-offset}`;
}

function sourceLabel(source: ListSource): string {
  if (source.kind === "faction") return `Faction: [[${source.faction}]]`;
  return source.kind === "preselected" ? "Preselected" : "Random";
}

function entryText(entry: { label: string; group: GroupMember[]; placeholder?: boolean }, factionRow: boolean): string {
  if (entry.group.length === 0) return `**${entry.label}**`;
  if (factionRow) return `${entry.label}: ${formatGroup(entry.group)}`;
  return formatGroup(entry.group);
}

export function buildEncounterNoteMarkdown(params: EncounterNoteParams): string {
  const { floorBasename, level, factionNames, seed, generatedOn, result, extraSections } = params;
  const lines: string[] = [];
  const bySlot = new Map(result.list.map((e) => [e.slot, e]));

  lines.push(
    `Generated by Dungeon Cartographer's "Generate Encounters & Traps" command from [[${floorBasename} Setup]]. ` +
      `Running it again rerolls everything in this note. To get this exact result back, add \`| Seed | ${seed} |\` to the Setup file.`,
    "",
    "| Setting | Value |",
    "| ------- | ----- |",
    `| Level | ${level} |`,
    `| Factions | ${factionNames.length > 0 ? factionNames.map((f) => `[[${f}]]`).join(", ") : "(none)"} |`,
    `| Seed | ${seed} |`,
    `| Generated | ${generatedOn} |`,
    ""
  );

  if (result.flags.length > 0) {
    lines.push("## Flags", "", ...result.flags.map((f) => `- ${f}`), "");
  }

  lines.push(
    "## Monster List",
    "",
    "Random monsters below Level come in groups: −1 ×2, −2 ×3, −3 ×4. Faction entries are rows from the faction's Encounters table, multiplied the same way below Level: every count in the row, leaders included (×2 = two copies of the squad).",
    "",
    "| # | Source | CR | vs Level | Encounter | EL |",
    "| :-: | ------ | :-: | :-: | --------- | :-: |"
  );
  for (const e of result.list) {
    lines.push(
      `| ${e.slot} | ${sourceLabel(e.source)} | ${formatCR(e.cr)} | ${formatOffset(e.offset)} | ${cell(entryText(e, e.source.kind === "faction"))} | ${e.el.toFixed(1)} |`
    );
  }

  lines.push("", "## Wandering Monsters", "", "| d6 | Encounter | EL |", "| :-: | --------- | :-: |");
  result.wandering.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${cell(entryText(e, e.source.kind === "faction"))} | ${e.el.toFixed(1)} |`);
  });

  const monsterCount = result.encounters.filter((e) => e.kind === "monster").length;
  const trapCount = result.encounters.length - monsterCount;
  lines.push(
    "",
    "## Encounters",
    "",
    `${result.encounters.length} encounters: ${monsterCount} monster, ${trapCount} trap. E1 is an above-Level monster. Not placed in rooms yet.`,
    "",
    "| ID | Type | Encounter | EL |",
    "| -- | ---- | --------- | :-: |"
  );
  for (const e of result.encounters) {
    if (e.kind === "trap") {
      const text = e.trap ? `**${e.trap.name}** (CR ${e.trap.cr}): ${e.trap.description}` : `**${e.label}**`;
      lines.push(`| ${e.id} | Trap | ${cell(text)} | ${e.el} |`);
    } else {
      const entry = e.slot !== undefined ? bySlot.get(e.slot) : undefined;
      const text = entry ? entryText(entry, entry.source.kind === "faction") : e.label;
      lines.push(`| ${e.id} | Monster (#${e.slot}) | ${cell(text)} | ${e.el.toFixed(1)} |`);
    }
  }

  lines.push("");
  if (extraSections && extraSections.length > 0) lines.push(...extraSections);
  return lines.join("\n");
}
