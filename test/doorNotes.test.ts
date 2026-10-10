import { describe, it, expect } from "vitest";
import { Rng } from "../src/generate";
import type { DungeonDoor } from "../src/dungeonData";
import { DEFAULT_LOCK_TRAP_RULES } from "../src/lockTrapRules";
import {
  rollDoorChallengeLevel,
  parseTrapEntries,
  pickTrapFlavor,
  buildDoorNoteMarkdown,
  doorNeedsNote,
  doorsFolderPathFor,
  doorNotePathFor,
} from "../src/doorNotes";

const SAMPLE_TRAPS_TEXT = `##### SAMPLE TRAPS

Some intro prose about market prices and caster levels.

###### CR 1 Traps

**Basic Arrow Trap**: CR 1; mechanical; proximity trigger; manual reset; Atk +10 ranged (1d6/x3, arrow); Search DC 20; Disable Device DC 20. Market Price: 2,000 gp.

**Poison Dart Trap**: CR 1; mechanical; location trigger; manual reset; Atk +8 ranged (1d4 plus poison, dart); poison (bloodroot, DC 12 Fortitude save resists, 0/1d4 Con plus 1d3 Wis); Search DC 20; Disable Device DC 18. Market Price: 700 gp.

###### CR 2 Traps

**Fire Trap**: CR 2; spell; spell trigger; no reset; spell effect (fire trap, 3rd-level druid, 1d4+3 fire, DC 13 Reflex save half damage); Search DC 27; Disable Device DC 27. Cost: 85 gp to hire NPC spellcaster.
`;

function makeDoor(overrides: Partial<DungeonDoor> = {}): DungeonDoor {
  return {
    id: 3,
    connects: [
      { kind: "room", id: 7 },
      { kind: "corridor", id: 0 },
    ],
    cellA: [1, 5, 0],
    cellB: [1, 7, 0],
    material: "wood",
    secret: false,
    width: 1,
    locked: false,
    trapped: false,
    stuck: false,
    ...overrides,
  };
}

describe("rollDoorChallengeLevel", () => {
  it("never rolls below the floor level", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      expect(rollDoorChallengeLevel(rng, 5)).toBeGreaterThanOrEqual(5);
    }
  });

  it("never exceeds 20, even at a high floor level with a +3 bump", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      expect(rollDoorChallengeLevel(rng, 19)).toBeLessThanOrEqual(20);
    }
  });

  it("only ever bumps by 0-3 over the floor level", () => {
    const rng = new Rng(42);
    for (let i = 0; i < 500; i++) {
      const level = rollDoorChallengeLevel(rng, 4);
      expect(level - 4).toBeGreaterThanOrEqual(0);
      expect(level - 4).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic for a given Rng sequence", () => {
    const a = rollDoorChallengeLevel(new Rng(7), 3);
    const b = rollDoorChallengeLevel(new Rng(7), 3);
    expect(a).toBe(b);
  });
});

describe("parseTrapEntries", () => {
  it("parses every trap entry's name and strips CR/Search DC/price from the description", () => {
    const entries = parseTrapEntries(SAMPLE_TRAPS_TEXT);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      name: "Basic Arrow Trap",
      description: "mechanical; proximity trigger; manual reset; Atk +10 ranged (1d6/x3, arrow)",
    });
  });

  it("strips a poison clause entry down to just the mechanism text", () => {
    const entries = parseTrapEntries(SAMPLE_TRAPS_TEXT);
    const dart = entries.find((e) => e.name === "Poison Dart Trap");
    expect(dart?.description).toBe(
      "mechanical; location trigger; manual reset; Atk +8 ranged (1d4 plus poison, dart); poison (bloodroot, DC 12 Fortitude save resists, 0/1d4 Con plus 1d3 Wis)"
    );
  });

  it("returns an empty list for text with no entries", () => {
    expect(parseTrapEntries("Just some prose, no bolded traps here.")).toEqual([]);
  });
});

describe("pickTrapFlavor", () => {
  it("picks one of the parsed entries when the file has content", () => {
    const rng = new Rng(1);
    const flavor = pickTrapFlavor(rng, SAMPLE_TRAPS_TEXT);
    const names = parseTrapEntries(SAMPLE_TRAPS_TEXT).map((e) => e.name);
    expect(names).toContain(flavor.name);
  });

  it("falls back to a clearly-labeled placeholder when the file is empty", () => {
    const rng = new Rng(1);
    const flavor = pickTrapFlavor(rng, "");
    expect(flavor.name).toBe("Unspecified trap");
  });
});

describe("doorNeedsNote", () => {
  it("is false for a plain door", () => {
    expect(doorNeedsNote(makeDoor())).toBe(false);
  });

  it("is true if any of locked/trapped/stuck is set", () => {
    expect(doorNeedsNote(makeDoor({ locked: true }))).toBe(true);
    expect(doorNeedsNote(makeDoor({ trapped: true }))).toBe(true);
    expect(doorNeedsNote(makeDoor({ stuck: true }))).toBe(true);
  });
});

describe("buildDoorNoteMarkdown", () => {
  it("includes id/connects/material, and the challenge level with its bump for a trapped door", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ trapped: true }),
      floorBasename: "Floor 1",
      challengeLevel: 3,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: null,
    });
    expect(md).toContain("Door 3 — Room 7 ↔ Corridor 0 — Wood");
    expect(md).toContain("**Challenge level:** 3 (floor Level 1 + 2)");
  });

  it("omits the bump suffix when the challenge level equals the floor level", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ trapped: true }),
      floorBasename: "Floor 1",
      challengeLevel: 1,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: null,
    });
    expect(md).toContain("**Challenge level:** 1 (floor Level 1)");
    expect(md).not.toContain("+ 0");
  });

  it("shows a Locked line with the rolled Open Lock DC and how it was reached", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ locked: true }),
      floorBasename: "Floor 1",
      challengeLevel: 6,
      floorLevel: 4,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: null,
      lockRoll: { dc: 31, roll: 7 },
    });
    expect(md).toContain("**Locked:** Open Lock DC 31 (floor Level 4 + 20 + 7 on 1d10)");
    expect(md).not.toContain("**Trapped:**");
    expect(md).not.toContain("**Stuck:**");
    // The challenge level only matters for a trap, so a lock-only door doesn't show it.
    expect(md).not.toContain("**Challenge level:**");
  });

  it("shows the formula's range when no lock roll was passed", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ locked: true }),
      floorBasename: "Floor 1",
      challengeLevel: 4,
      floorLevel: 4,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: null,
    });
    expect(md).toContain("**Locked:** Open Lock DC 25–34 (floor Level 4 + 20 + 1d10, not rolled)");
  });

  it("shows a Trapped line with the trap flavor's name/description when trapped", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ trapped: true }),
      floorBasename: "Floor 1",
      challengeLevel: 1,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: { name: "Poison Dart Trap", description: "a dart fires from the wall" },
    });
    expect(md).toContain("**Trapped:** DC 20 Search / Disable Device — Poison Dart Trap: a dart fires from the wall.");
  });

  it("shows a Stuck line whose break DC accounts for locked/trapped stacking", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ stuck: true, locked: true, trapped: true }),
      floorBasename: "Floor 1",
      challengeLevel: 1,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: { name: "X", description: "y" },
    });
    expect(md).toContain("**Stuck:** DC 25 Strength check to force.");
  });

  it("guards archways: omits Locked/Stuck even if those flags are somehow set, but keeps Trapped", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ material: "archway", locked: true, stuck: true, trapped: true }),
      floorBasename: "Floor 1",
      challengeLevel: 1,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: { name: "X", description: "y" },
    });
    expect(md).not.toContain("**Locked:**");
    expect(md).not.toContain("**Stuck:**");
    expect(md).toContain("**Trapped:**");
  });

  it("always ends with a free-text Notes section", () => {
    const md = buildDoorNoteMarkdown({
      door: makeDoor({ locked: true }),
      floorBasename: "Floor 1",
      challengeLevel: 1,
      floorLevel: 1,
      rules: DEFAULT_LOCK_TRAP_RULES,
      trapFlavor: null,
    });
    expect(md).toContain("## Notes");
  });
});

describe("path helpers", () => {
  it("builds the Doors folder path under the floor's own folder", () => {
    expect(doorsFolderPathFor("Dungeons/My Dungeon/", "Floor 1")).toBe("Dungeons/My Dungeon/Floor 1/Doors");
  });

  it("builds an id-keyed door note path", () => {
    expect(doorNotePathFor("Dungeons/My Dungeon/", "Floor 1", 3)).toBe("Dungeons/My Dungeon/Floor 1/Doors/Door 3.md");
  });

  it("works at vault root (empty folder prefix)", () => {
    expect(doorNotePathFor("", "Floor 1", 0)).toBe("Floor 1/Doors/Door 0.md");
  });
});
