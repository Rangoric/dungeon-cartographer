// Locks & Traps Content Plan, Plan step 3: "wire the generation step" - the
// piece that actually turns a door's physical `locked`/`trapped`/`stuck`
// flags into real content (a challenge level, a DC, a trap's flavor text)
// and a note to write it to. See "Dungeon Generation/Locks & Traps Content
// Plan.md" and "Dungeon Generation/Door Notes and Map Hover Plan.md" Part A
// for the full design this implements.
//
// Deliberately free of Obsidian imports, same reasoning as generate.ts/
// floorSetup.ts/lockTrapRules.ts - the actual vault I/O (reading the
// settings files, wiping/recreating the `Doors/` folder, writing each
// note) lives in main.ts, which calls the pure functions here. This stays
// unit-testable without a vault.

import type { DungeonConnection, DungeonDoor } from "./dungeonData";
import { doorMaterialLabel } from "./floor2d";
import type { Rng } from "./generate";
import {
  lockDiceLabel,
  lookupStuckDoorBreakDC,
  lookupTrappedDoorDC,
  type LockRoll,
  type LockTrapRules,
} from "./lockTrapRules";

// ---------------------------------------------------------------------------
// Challenge level
// ---------------------------------------------------------------------------

/**
 * How far above the floor's own `Level` a flagged door's challenge can
 * land, weighted so +0 is the common case and +3 is rare - per "Door Notes
 * and Map Hover Plan.md" Part A3 ("the floor's own level up to 3 higher
 * (rarely the full +3)"). A starting point, not tuned against real play,
 * same status as `generate.ts`'s own door-roll weights.
 */
const CHALLENGE_LEVEL_BUMPS = [0, 1, 2, 3] as const;
const CHALLENGE_LEVEL_BUMP_WEIGHTS = [50, 25, 15, 10] as const;

/**
 * Rolls a flagged door's own challenge level - NOT the floor's `Level`
 * field directly (see Plan A3: this is content, generated alongside the
 * physical locked/trapped/stuck rolls but stored in the door's note, not
 * the `.dungeon` schema). Clamped to 20, the Rules tables' own max - a
 * Level-19/20 floor's +3 roll would otherwise overshoot what
 * `lockupLockedDoorDC`/`lookupTrappedDoorDC` are tiered across.
 */
export function rollDoorChallengeLevel(rng: Rng, floorLevel: number): number {
  const bump = rng.choices(CHALLENGE_LEVEL_BUMPS, CHALLENGE_LEVEL_BUMP_WEIGHTS);
  return Math.min(20, floorLevel + bump);
}

// ---------------------------------------------------------------------------
// Trap flavor (Sample Traps.md)
// ---------------------------------------------------------------------------

export interface TrapFlavor {
  name: string;
  /**
   * Mechanism/effect description only - the CR prefix and everything from
   * "Search DC" onward (Search/Disable Device DC, Market Price/Cost) are
   * stripped, since only the door's own rolled DC (from
   * `Lock, Trap & Stuck Door DCs.md`) is ever actually used - see
   * "Sample Traps.md"'s own header paragraph.
   */
  description: string;
}

/** Matches one `**Trap Name**: CR N; mechanical; ...; Search DC X; ...` entry line in Sample Traps.md. */
const TRAP_ENTRY_PATTERN = /^\*\*(.+?)\*\*:\s*(.+)$/gm;

/**
 * Parses every trap stat-block entry out of the Sample Traps.md settings
 * file's raw text. Same forgiving-parser spirit as `lockTrapRules.ts` -
 * an entry with no name or no usable description after stripping is
 * simply skipped rather than throwing, and a file with no matching
 * entries at all just yields an empty list (handled by `pickTrapFlavor`'s
 * fallback), never blocking generation.
 */
export function parseTrapEntries(fileText: string): TrapFlavor[] {
  const entries: TrapFlavor[] = [];
  const pattern = new RegExp(TRAP_ENTRY_PATTERN.source, TRAP_ENTRY_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fileText)) !== null) {
    const name = match[1].trim();
    let description = match[2].trim();
    description = description.replace(/^CR\s*\d+;\s*/i, "");
    description = description.split(/;\s*Search DC/i)[0].trim().replace(/[.;,]+$/, "");
    if (name && description) entries.push({ name, description });
  }

  return entries;
}

/** Used when Sample Traps.md is missing, empty, or entirely unparsable - a trapped door still gets a note, just without a mechanism suggestion, clearly labeled as such rather than silently blank. */
const FALLBACK_TRAP_FLAVOR: TrapFlavor = {
  name: "Unspecified trap",
  description: "mechanism not generated - \"Sample Traps.md\" was missing or unreadable when this note was written",
};

/**
 * Picks one trap entry uniformly at random from Sample Traps.md's parsed
 * entries - no CR/challenge-level matching yet (see that file's own "Open
 * question"; a future pass can bucket these by CR once the settings file
 * itself is reshaped for that). Falls back to `FALLBACK_TRAP_FLAVOR` if
 * the file has no parseable entries, matching this plugin's usual
 * settings-read leniency (never throws, never blocks generation).
 */
export function pickTrapFlavor(rng: Rng, sampleTrapsText: string): TrapFlavor {
  const entries = parseTrapEntries(sampleTrapsText);
  return entries.length > 0 ? rng.choice(entries) : FALLBACK_TRAP_FLAVOR;
}

// ---------------------------------------------------------------------------
// Note content
// ---------------------------------------------------------------------------

/** `{kind: "room", id: 7}` -> `"Room 7"`, `{kind: "corridor", id: 0}` -> `"Corridor 0"` - id-only, same style the by-hand "Floor 1 - Locks & Traps.md" table used before this was automated. */
function connectionLabel(connection: DungeonConnection): string {
  const kindLabel = connection.kind === "room" ? "Room" : "Corridor";
  return `${kindLabel} ${connection.id}`;
}

export interface DoorNoteParams {
  door: DungeonDoor;
  /** The open floor file's basename, e.g. `"Floor 1"` - used in the note's auto-generated-by line and its cross-links. */
  floorBasename: string;
  /** This door's own rolled challenge level (see `rollDoorChallengeLevel`) - not the floor's `Level`. */
  challengeLevel: number;
  /** The floor's own `Level` (from its Setup file) - shown alongside the challenge level so the note reads as "Level + bump" rather than a bare number. */
  floorLevel: number;
  rules: LockTrapRules;
  /** The trap flavor to show if `door.trapped` - `null` when the door isn't trapped, or when the caller chooses not to roll one. */
  trapFlavor: TrapFlavor | null;
  /** The door's rolled Open Lock DC (see `rollLockedDoorDC`) - `null`/omitted when it isn't locked or the caller didn't roll, in which case the note shows the formula's range instead. */
  lockRoll?: LockRoll | null;
}

/**
 * Builds a door's content note as markdown - id/connects/material,
 * challenge level, and a line per flagged condition (locked/trapped/
 * stuck), each with its looked-up DC, plus a free-text section for
 * hand-added detail. See "Door Notes and Map Hover Plan.md" Part A3 for
 * the field list and A4 for the wipe/rebuild-while-not-finalized story
 * this note's own header paragraph documents for whoever's reading it.
 *
 * **Archway guard (Plan step 3):** an archway has no door leaf, so it can
 * never really be locked or stuck (Part C1) even though that eligibility
 * isn't enforced by `generate.ts`'s roll yet - this function defensively
 * skips the Locked/Stuck lines for a `material: "archway"` door regardless
 * of what its flags say, rather than printing a DC for something that
 * can't physically apply. Trapped is unaffected - an archway can be
 * trapped (a pressure plate/tripwire needs no leaf).
 */
export function buildDoorNoteMarkdown(params: DoorNoteParams): string {
  const { door, floorBasename, challengeLevel, floorLevel, rules, trapFlavor, lockRoll } = params;
  const isArchway = door.material === "archway";
  const connects = `${connectionLabel(door.connects[0])} ↔ ${connectionLabel(door.connects[1])}`;
  const material = doorMaterialLabel(door.material);
  const bump = challengeLevel - floorLevel;

  const lines: string[] = [];
  lines.push(`Door ${door.id} — ${connects} — ${material}`);
  lines.push("");
  lines.push(
    `Auto-generated by "Generate Random Map" for \`${floorBasename}.dungeon\` — wiped and rebuilt on every regenerate while this floor isn't finalized; hand-edits below the divider only become durable once it is. See [[Door Notes and Map Hover Plan]] and [[Locks & Traps Content Plan]].`
  );
  // The challenge level only drives a door trap's DC, so it's only shown
  // for a trapped door (doors stopped rolling traps 2026-10-03; one can
  // still be trapped by hand). A lock uses the floor's own Level.
  if (door.trapped) {
    lines.push("");
    lines.push(
      `**Challenge level:** ${challengeLevel} (floor Level ${floorLevel}${bump > 0 ? ` + ${bump}` : ""})`
    );
  }

  if (door.locked && !isArchway) {
    const { base, diceCount, diceSides } = rules.lockedDoorDC;
    const dice = lockDiceLabel(rules);
    lines.push("");
    lines.push(
      lockRoll
        ? `**Locked:** Open Lock DC ${lockRoll.dc} (floor Level ${floorLevel} + ${base} + ${lockRoll.roll} on ${dice})`
        : `**Locked:** Open Lock DC ${floorLevel + base + diceCount}–${floorLevel + base + diceCount * diceSides} (floor Level ${floorLevel} + ${base} + ${dice}, not rolled)`
    );
  }

  if (door.trapped) {
    const dc = lookupTrappedDoorDC(rules, challengeLevel);
    lines.push("");
    lines.push(
      trapFlavor
        ? `**Trapped:** DC ${dc} Search / Disable Device — ${trapFlavor.name}: ${trapFlavor.description}.`
        : `**Trapped:** DC ${dc} Search / Disable Device.`
    );
  }

  if (door.stuck && !isArchway) {
    const breakDC = lookupStuckDoorBreakDC(rules, { locked: door.locked, trapped: door.trapped });
    lines.push("");
    lines.push(`**Stuck:** DC ${breakDC} Strength check to force.`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("_Hand-added detail (key location, why it's locked, a trap flavor override, etc.) goes here._");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
//
// Mirrors `main.ts`'s existing `setupFilePathFor` convention: `folder` is
// the dungeon's own folder path with a trailing slash already applied (or
// `""` at vault root), computed there from `file.parent?.path` - kept a
// plain string in/string out pair here so this stays obsidian-free.

/** A flagged door only ever needs a note if it's `locked`, `trapped`, or `stuck` - see Plan A1. */
export function doorNeedsNote(door: DungeonDoor): boolean {
  return door.locked || door.trapped || door.stuck;
}

/** `Floor N/Doors` - the folder every door note for this floor lives in, alongside the (still unbuilt) room-note convention's bare `Floor N/`. */
export function doorsFolderPathFor(folder: string, floorBasename: string): string {
  return `${folder}${floorBasename}/Doors`;
}

/** `Floor N/Doors/Door <id>.md` - id-keyed, per Plan A2. */
export function doorNotePathFor(folder: string, floorBasename: string, doorId: number): string {
  return `${doorsFolderPathFor(folder, floorBasename)}/Door ${doorId}.md`;
}
