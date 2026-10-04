import { describe, it, expect } from "vitest";
import { Rng } from "../src/generate";
import {
  buildEncounterNoteMarkdown,
  crForOffset,
  encounterLevel,
  formatCR,
  generateEncounters,
  groupSizeForOffset,
  multipliedEL,
  multiplyFactionRow,
  offsetForCR,
  parseCR,
  parseEncounterSetup,
  parseFactionFile,
  parseGroupCell,
  parseTrapsByCR,
  type EncounterGenInput,
  type PoolMonster,
} from "../src/encounters";

const FACTION_TEXT = `---
name: Modron
---

## Members

| Monster | CR | Used in encounters |
| ------- | :-: | :-: |
| [[Modron, duodrone]] | 1 | Yes |

## Encounters

| CR | # | Encounter | Monsters | EL |
| :-: | :-: | --------- | -------- | :-: |
| 1 | 1 | Lone duodrone | 1× [[Modron, duodrone]] | 1.0 |
| 2 | 1 | Lone tridrone | 1× [[Modron, tridrone]] | 2.0 |
| 3 | 1 | Duodrone pair | 2× [[Modron, duodrone]] | 3.0 |
| 4 | 1 | Lone pentadrone | 1× [[Modron, pentadrone]] | 4.0 |
| 5 | 1 | Quadrone pair | 2× [[Modron, quadrone]] | 5.0 |
| 6 | 2 | Pentadrone patrol | 1× [[Modron, pentadrone]], 2× [[Modron, tridrone]] | 6.0 |
`;

const TRAPS_TEXT = `## CR 4 Traps

**Collapsing Column**: CR 4; mechanical; touch trigger; no reset; Atk +15 melee (6d6); Search DC 20; Disable Device DC 24. Market Price: 8,800 gp.

**Lightning Bolt Trap**: CR 4; magic device; proximity trigger; automatic reset; spell effect (lightning bolt, 5th-level wizard, 5d6 electricity, DC 14 Reflex save half damage); Search DC 28; Disable Device DC 28. Cost: 7,500 gp, 600 XP.

## CR 5 Traps

**Wall Scythe Trap**: CR 5; mechanical; location trigger; automatic reset; Atk +20 melee (2d4+8/x4); Search DC 21; Disable Device DC 18. Market Price: 17,200 gp.
`;

function pool(level: number): PoolMonster[] {
  const out: PoolMonster[] = [];
  for (let cr = 1; cr <= level + 2; cr++) {
    for (let i = 0; i < 4; i++) out.push({ name: `Monster CR${cr} #${i}`, cr });
  }
  for (const cr of [1 / 2, 1 / 3, 1 / 4]) out.push({ name: `Monster CR ${formatCR(cr)}`, cr });
  return out;
}

function input(seed: number, overrides: Partial<EncounterGenInput> = {}): EncounterGenInput {
  return {
    level: 4,
    factions: [parseFactionFile("Modron", FACTION_TEXT)],
    preselected: [],
    pool: pool(4),
    traps: parseTrapsByCR(TRAPS_TEXT),
    rng: new Rng(seed),
    ...overrides,
  };
}

describe("CR helpers", () => {
  it("parses whole and fractional CRs and rejects the rest", () => {
    expect(parseCR("4")).toBe(4);
    expect(parseCR("1/2")).toBe(0.5);
    expect(parseCR(3)).toBe(3);
    expect(parseCR("-")).toBeNull();
    expect(parseCR("9 (class level + 4)")).toBeNull();
    expect(parseCR(undefined)).toBeNull();
  });

  it("maps offsets below CR 1 to fractional CRs", () => {
    expect(crForOffset(4, -3)).toBe(1);
    expect(crForOffset(1, 0)).toBe(1);
    expect(crForOffset(1, -1)).toBe(1 / 2);
    expect(crForOffset(1, -2)).toBe(1 / 3);
    expect(crForOffset(1, -3)).toBe(1 / 4);
    expect(offsetForCR(1, 1 / 2)).toBe(-1);
    expect(offsetForCR(4, 6)).toBe(2);
  });

  it("multiplies group ELs", () => {
    expect(multipliedEL(2, 1)).toBe(2);
    expect(multipliedEL(2, 2)).toBeCloseTo(4);
    expect(multipliedEL(2, 4)).toBeCloseTo(6);
    expect(multipliedEL(2, 3)).toBeCloseTo(encounterLevel([{ count: 3, cr: 2 }]));
  });

  it("sizes groups below Level", () => {
    expect([-3, -2, -1, 0, 1, 2].map(groupSizeForOffset)).toEqual([4, 3, 2, 1, 1, 1]);
  });

  it("computes 3.5e encounter levels", () => {
    expect(encounterLevel([{ count: 1, cr: 4 }])).toBeCloseTo(4);
    expect(encounterLevel([{ count: 2, cr: 4 }])).toBeCloseTo(6);
    expect(encounterLevel([{ count: 4, cr: 1 }])).toBeCloseTo(5);
    expect(encounterLevel([{ count: 2, cr: 1 / 2 }])).toBeCloseTo(1);
  });
});

describe("parseEncounterSetup", () => {
  it("reads comma-separated factions, linked preselected monsters and a seed", () => {
    const text = `| Setting | Value |\n| --- | --- |\n| Level | 4 |\n| Factions | Modron, Angels, Devils |\n| Preselected Monsters | [[Modron, duodrone]], [[Imp]] |\n| Seed | 1234 |\n`;
    expect(parseEncounterSetup(text)).toEqual({
      factions: ["Modron", "Angels", "Devils"],
      preselected: ["Modron, duodrone", "Imp"],
      seed: 1234,
    });
  });

  it("accepts linked factions and treats empty rows as none", () => {
    const text = `| Factions | [[Modron]], [[Angels]] |\n| Preselected Monsters | (none) |\n`;
    expect(parseEncounterSetup(text)).toEqual({ factions: ["Modron", "Angels"], preselected: [], seed: null });
  });

  it("returns nothing for a Setup file without those rows", () => {
    expect(parseEncounterSetup(`| Grid Size | 34 × 34 |`)).toEqual({ factions: [], preselected: [], seed: null });
  });
});

describe("faction and trap files", () => {
  it("parses group cells", () => {
    expect(parseGroupCell("1× [[Modron, pentadrone]], 2× [[Modron, tridrone]]")).toEqual([
      { count: 1, name: "Modron, pentadrone" },
      { count: 2, name: "Modron, tridrone" },
    ]);
  });

  it("reads (leader) marks and the Members table CRs", () => {
    expect(parseGroupCell("1× [[Modron, duodrone]] (leader), 2× [[Modron, monodrone]]")).toEqual([
      { count: 1, name: "Modron, duodrone", leader: true },
      { count: 2, name: "Modron, monodrone" },
    ]);
    const faction = parseFactionFile("Modron", FACTION_TEXT + "\n| [[Modron, monodrone]] | 1/2 | Yes |\n");
    expect(faction.memberCRs).toEqual({ "Modron, duodrone": 1, "Modron, monodrone": 0.5 });
  });

  it("parses only the Encounters table rows", () => {
    const faction = parseFactionFile("Modron", FACTION_TEXT);
    expect(faction.encounters).toHaveLength(6);
    expect(faction.encounters[5]).toEqual({
      cr: 6,
      name: "Pentadrone patrol",
      monsters: [
        { count: 1, name: "Modron, pentadrone" },
        { count: 2, name: "Modron, tridrone" },
      ],
      el: 6,
    });
  });

  it("parses traps with their CR and drops the price", () => {
    const traps = parseTrapsByCR(TRAPS_TEXT);
    expect(traps.map((t) => [t.name, t.cr])).toEqual([
      ["Collapsing Column", 4],
      ["Lightning Bolt Trap", 4],
      ["Wall Scythe Trap", 5],
    ]);
    expect(traps[0].description).toBe(
      "mechanical; touch trigger; no reset; Atk +15 melee (6d6); Search DC 20; Disable Device DC 24"
    );
    expect(traps[1].description).not.toMatch(/Cost/);
  });
});

describe("generateEncounters", () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  it("always builds an 8-entry Monster List inside Level-3..Level+2", () => {
    for (const seed of seeds) {
      const { list } = generateEncounters(input(seed));
      expect(list).toHaveLength(8);
      for (const e of list) {
        expect(e.offset).not.toBeNull();
        expect(e.offset!).toBeGreaterThanOrEqual(-3);
        expect(e.offset!).toBeLessThanOrEqual(2);
      }
    }
  });

  it("has 1 or 2 above-Level entries, never two at the same offset", () => {
    for (const seed of seeds) {
      const above = generateEncounters(input(seed)).list.filter((e) => e.offset! > 0);
      expect(above.length).toBeGreaterThanOrEqual(1);
      expect(above.length).toBeLessThanOrEqual(2);
      expect(new Set(above.map((e) => e.offset)).size).toBe(above.length);
    }
  });

  it("gives each faction one slot, filled from its Encounters table", () => {
    for (const seed of seeds) {
      const { list } = generateEncounters(input(seed));
      const faction = list.filter((e) => e.source.kind === "faction");
      expect(faction).toHaveLength(1);
      expect(faction[0].placeholder).toBe(false);
    }
  });

  it("multiplies faction rows below Level like random monsters, landing at the same EL", () => {
    const rows = parseFactionFile("Modron", FACTION_TEXT).encounters;
    let sawBelow = false;
    for (const seed of seeds) {
      const entry = generateEncounters(input(seed)).list.find((e) => e.source.kind === "faction")!;
      const n = groupSizeForOffset(entry.offset!);
      const candidates = rows.filter((r) => r.cr === entry.cr);
      const row = candidates.find((r) => entry.label === (n > 1 ? `${r.name} ×${n}` : r.name))!;
      expect(row).toBeDefined();
      expect(entry.group).toEqual(row.monsters.map((m) => ({ count: m.count * n, name: m.name })));
      if (n > 1) {
        sawBelow = true;
        // Same EL a random monster of that CR would get at this offset (these rows are EL = CR).
        expect(entry.el).toBeCloseTo(encounterLevel([{ count: n, cr: entry.cr }]));
      } else {
        expect(entry.el).toBe(row.el);
      }
    }
    expect(sawBelow).toBe(true);
  });

  it("flags a placeholder when a faction has no row at the rolled CR", () => {
    const sparse = parseFactionFile("Sparse", "| 1 | 1 | Lone duodrone | 1× [[Modron, duodrone]] | 1.0 |");
    let sawPlaceholder = false;
    for (const seed of seeds) {
      const result = generateEncounters(input(seed, { factions: [sparse] }));
      const slot = result.list.find((e) => e.source.kind === "faction")!;
      if (slot.placeholder) {
        sawPlaceholder = true;
        expect(result.flags.some((f) => f.startsWith("Sparse has no encounter"))).toBe(true);
      }
    }
    expect(sawPlaceholder).toBe(true);
  });

  it("applies the below-Level group multiplier to random monsters", () => {
    for (const seed of seeds) {
      for (const e of generateEncounters(input(seed)).list) {
        if (e.source.kind !== "random" || e.placeholder) continue;
        expect(e.group[0].count).toBe(groupSizeForOffset(e.offset!));
      }
    }
  });

  it("never picks the same monster twice for the list", () => {
    for (const seed of seeds) {
      const names = generateEncounters(input(seed))
        .list.filter((e) => e.source.kind === "random" && !e.placeholder)
        .map((e) => e.label);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("puts preselected monsters first and fills the rest", () => {
    const result = generateEncounters(
      input(7, { preselected: [{ name: "Big Boss", cr: 6 }, { name: "Unknown", cr: null }] })
    );
    expect(result.list).toHaveLength(8);
    expect(result.list[0]).toMatchObject({ label: "Big Boss", offset: 2, source: { kind: "preselected" } });
    expect(result.list[1]).toMatchObject({ label: "Unknown", offset: null });
    expect(result.flags.some((f) => f.includes('"Unknown"'))).toBe(true);
    expect(result.list.filter((e) => e.offset !== null && e.offset > 0).every((e) => e.offset! <= 2)).toBe(true);
  });

  it("uses the 6 lowest CRs as the wandering table", () => {
    for (const seed of seeds.slice(0, 50)) {
      const { list, wandering } = generateEncounters(input(seed));
      expect(wandering).toHaveLength(6);
      const maxWandering = Math.max(...wandering.map((e) => e.cr));
      const excluded = list.filter((e) => !wandering.includes(e));
      for (const e of excluded) expect(e.cr).toBeGreaterThanOrEqual(maxWandering);
    }
  });

  it("rolls 9-11 encounters with 2-3 traps, starting with an above-Level monster seen only once", () => {
    for (const seed of seeds) {
      const { list, encounters } = generateEncounters(input(seed));
      expect(encounters.length).toBeGreaterThanOrEqual(9);
      expect(encounters.length).toBeLessThanOrEqual(11);
      const traps = encounters.filter((e) => e.kind === "trap");
      expect(traps.length).toBeGreaterThanOrEqual(2);
      expect(traps.length).toBeLessThanOrEqual(3);

      const monsters = encounters.filter((e) => e.kind === "monster");
      const first = list.find((e) => e.slot === monsters[0].slot)!;
      expect(first.offset!).toBeGreaterThan(0);
      for (const above of list.filter((e) => e.offset! > 0)) {
        expect(monsters.filter((m) => m.slot === above.slot).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("picks traps from Level to Level+2, falling back to the nearest lower CR", () => {
    for (const seed of seeds) {
      const result = generateEncounters(input(seed));
      for (const t of result.encounters.filter((e) => e.kind === "trap")) {
        expect([4, 5]).toContain(t.trap!.cr);
      }
    }
    // Level 6 wants CR 6-8 traps; this file tops out at CR 5, so each trap is flagged.
    const result = generateEncounters(input(3, { level: 6, pool: pool(6) }));
    expect(result.flags.some((f) => f.includes("uses a CR 5 trap"))).toBe(true);
  });

  it("works at Level 1 with fractional CRs", () => {
    for (const seed of seeds.slice(0, 50)) {
      const result = generateEncounters(input(seed, { level: 1, pool: pool(1) }));
      expect(result.list).toHaveLength(8);
      for (const e of result.list.filter((x) => x.source.kind === "faction")) expect(e.cr).toBeGreaterThanOrEqual(1);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(generateEncounters(input(42))).toEqual(generateEncounters(input(42)));
  });
});

describe("multiplyFactionRow", () => {
  const leaderRow = {
    cr: 3,
    name: "Duodrone with its monodrones",
    monsters: [
      { count: 1, name: "Modron, duodrone", leader: true },
      { count: 2, name: "Modron, monodrone" },
    ],
    el: 3,
  };

  it("multiplies every count, leaders included", () => {
    const { group, el } = multiplyFactionRow(leaderRow, 2);
    expect(group).toEqual([
      { count: 2, name: "Modron, duodrone", leader: true },
      { count: 4, name: "Modron, monodrone" },
    ]);
    expect(el).toBeCloseTo(5);
    expect(multiplyFactionRow(leaderRow, 4).group.map((m) => m.count)).toEqual([4, 8]);
  });

  it("leaves the row alone at multiplier 1", () => {
    expect(multiplyFactionRow(leaderRow, 1)).toEqual({ group: leaderRow.monsters, el: 3 });
  });
});

describe("buildEncounterNoteMarkdown", () => {
  it("renders the settings, list, wandering and encounter tables", () => {
    const result = generateEncounters(input(5));
    const md = buildEncounterNoteMarkdown({
      floorBasename: "Floor 1",
      level: 4,
      factionNames: ["Modron"],
      seed: 5,
      generatedOn: "2026-09-30",
      result,
    });
    expect(md).toContain("[[Floor 1 Setup]]");
    expect(md).toContain("| Seed | 5 |");
    expect(md).toContain("## Monster List");
    expect(md).toContain("## Wandering Monsters");
    expect(md).toContain("## Encounters");
    expect(md).toContain("Faction: [[Modron]]");
    expect(md.match(/^\| E\d+ \|/gm)!.length + md.match(/^\| T\d+ \|/gm)!.length).toBe(result.encounters.length);
  });
});
