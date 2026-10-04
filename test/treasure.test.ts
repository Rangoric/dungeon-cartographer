import { describe, it, expect } from "vitest";
import { Rng } from "../src/generate";
import { TREASURE_DEFAULT_FILES } from "../src/treasureDefaults";
import {
  parseGp,
  parseRange,
  parseSettingNumber,
  parseTreasureFile,
  rollDice,
  rollRow,
  tableKey,
  type TreasureTables,
} from "../src/treasureTables";
import {
  buildTreasureMarkdown,
  DEFAULT_TREASURE_SETTINGS,
  naturalName,
  readTreasureSettings,
  rollFloorTreasure,
  TreasureRoller,
  type Grade,
  type TreasureSettings,
} from "../src/treasure";

function shippedTables(): TreasureTables {
  const tables: TreasureTables = new Map();
  for (const [fileName, text] of Object.entries(TREASURE_DEFAULT_FILES)) {
    parseTreasureFile(fileName.replace(/\.md$/, ""), text, tables);
  }
  return tables;
}

const TABLES = shippedTables();
const NO_EXTRAS: TreasureSettings = { ...DEFAULT_TREASURE_SETTINGS, psionicChance: 0, intelligentChance: 0 };
const GRADES: Grade[] = ["Minor", "Medium", "Major"];

describe("treasureTables helpers", () => {
  it("parses d% ranges", () => {
    expect(parseRange("01–04")).toEqual([1, 4]);
    expect(parseRange("17")).toEqual([17, 17]);
    expect(parseRange("96-100")).toEqual([96, 100]);
    expect(parseRange("—")).toBeNull();
    expect(parseRange("")).toBeNull();
  });

  it("rolls dice expressions with multipliers", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 200; i++) {
      const coins = rollDice("1d6 × 1,000 cp", rng);
      expect(coins % 1000).toBe(0);
      expect(coins).toBeGreaterThanOrEqual(1000);
      expect(coins).toBeLessThanOrEqual(6000);
      const gems = rollDice("2d4 x 10 gp", rng);
      expect(gems).toBeGreaterThanOrEqual(20);
      expect(gems).toBeLessThanOrEqual(80);
    }
    expect(rollDice("1 gem", rng)).toBe(1);
    expect(rollDice("nothing", rng)).toBe(0);
  });

  it("reads gp values and settings numbers", () => {
    expect(parseGp("1,000 gp")).toBe(1000);
    expect(parseGp("+350 gp")).toBe(350);
    expect(parseGp("12 gp 5 sp")).toBe(12.5);
    expect(parseGp("+1 bonus")).toBe(0);
    expect(parseSettingNumber("25%")).toBe(0.25);
    expect(parseSettingNumber("20")).toBe(20);
    expect(parseSettingNumber("lots")).toBeNull();
  });

  it("parses sections into separate tables", () => {
    const tables = parseTreasureFile("Demo", "intro\n\n## One\n\nnote\n\n| d% | Item |\n| --- | --- |\n| 01–50 | A |\n| 51–100 | B |\n\n## Two\n\n| d% | Item |\n| --- | --- |\n| 01–100 | C |\n");
    expect(tables.get(tableKey("Demo", "One"))!.rows).toEqual([["01–50", "A"], ["51–100", "B"]]);
    expect(tables.get(tableKey("Demo", "Two"))!.header).toEqual(["d%", "Item"]);
    const rng = new Rng(3);
    for (let i = 0; i < 50; i++) expect(["A", "B"]).toContain(rollRow(tables.get(tableKey("Demo", "One"))!, "d%", rng)!["Item"]);
    expect(rollRow(tables.get(tableKey("Demo", "One"))!, "Major", rng)).toBeNull();
  });
});

describe("the shipped treasure tables", () => {
  it("has every d% and grade column tile 01–100 with no gaps or overlaps", () => {
    const problems: string[] = [];
    for (const [key, table] of TABLES) {
      table.header.forEach((name, col) => {
        if (!["d%", "Minor", "Medium", "Major"].includes(name)) return;
        // The by-level Treasure table repeats 01–100 per level and type.
        const groups = new Map<string, [number, number][]>();
        for (const cells of table.rows) {
          const range = parseRange(cells[col] ?? "");
          if (!range) continue;
          const group = key.endsWith("/treasure") ? `${cells[0]}/${cells[1]}` : "";
          groups.set(group, [...(groups.get(group) ?? []), range]);
        }
        for (const [group, ranges] of groups) {
          ranges.sort((a, b) => a[0] - b[0]);
          let expected = 1;
          for (const [lo, hi] of ranges) {
            if (lo !== expected) problems.push(`${key} ${name} ${group}: expected ${expected}, found ${lo}-${hi}`);
            expected = hi + 1;
          }
          if (expected !== 101) problems.push(`${key} ${name} ${group}: ends at ${expected - 1}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("includes every table the roller asks for", () => {
    for (const grade of GRADES) {
      const roller = new TreasureRoller(TABLES, { ...DEFAULT_TREASURE_SETTINGS, psionicChance: 0.5 }, new Rng(11));
      for (let i = 0; i < 3000; i++) roller.magic(grade);
      for (let i = 0; i < 300; i++) roller.mundane();
      expect(roller.flags.filter((f) => !f.startsWith("Intelligent item"))).toEqual([]);
    }
  });
});

describe("naturalName", () => {
  it("turns table names into readable ones", () => {
    expect(naturalName("Sword, bastard")).toBe("bastard sword");
    expect(naturalName("Shield, light, wooden")).toBe("light wooden shield");
    expect(naturalName("Bolts, crossbow (50)")).toBe("crossbow bolts (50)");
    expect(naturalName("Longbow, composite (+4 Str bonus)")).toBe("composite longbow (+4 Str bonus)");
    expect(naturalName("Fortification, light")).toBe("light fortification");
    expect(naturalName("Full plate")).toBe("full plate");
  });
});

describe("readTreasureSettings", () => {
  it("reads the shipped settings file", () => {
    expect(readTreasureSettings(TABLES)).toEqual(DEFAULT_TREASURE_SETTINGS);
  });

  it("keeps defaults for missing or unreadable rows", () => {
    const tables = parseTreasureFile(
      "Treasure Settings",
      "## Treasure Settings\n\n| Setting | Value | Notes |\n| --- | --- | --- |\n| Psionic item chance | 10% | |\n| Floor reroll tries | many | |\n"
    );
    expect(readTreasureSettings(tables)).toEqual({ ...DEFAULT_TREASURE_SETTINGS, psionicChance: 0.1 });
    expect(readTreasureSettings(new Map())).toEqual(DEFAULT_TREASURE_SETTINGS);
  });
});

describe("TreasureRoller", () => {
  it("rolls hoards whose total is the sum of their lines, with no placeholders", () => {
    for (let level = 1; level <= 20; level++) {
      const roller = new TreasureRoller(TABLES, DEFAULT_TREASURE_SETTINGS, new Rng(level));
      for (let i = 0; i < 300; i++) {
        const hoard = roller.rollHoard(level);
        expect(hoard.level).toBe(level);
        expect(hoard.total).toBeCloseTo(hoard.lines.reduce((sum, l) => sum + l.gp, 0));
        for (const line of hoard.lines) {
          expect(line.text).not.toMatch(/placeholder/i);
          expect(line.gp).toBeGreaterThan(0);
        }
      }
    }
  });

  it("rounds and clamps the EL to the table's 1-20 rows", () => {
    const roller = new TreasureRoller(TABLES, NO_EXTRAS, new Rng(5));
    expect(roller.rollHoard(0.5).level).toBe(1);
    expect(roller.rollHoard(5.2).level).toBe(5);
    expect(roller.rollHoard(5.5).level).toBe(6);
    expect(roller.rollHoard(27).level).toBe(20);
    expect(roller.targetFor(1)).toBe(300);
    expect(roller.targetFor(20)).toBe(80000);
  });

  it("averages close to the SRD treasure value for the level", () => {
    for (const level of [1, 4, 8, 12]) {
      const roller = new TreasureRoller(TABLES, NO_EXTRAS, new Rng(900 + level));
      let sum = 0;
      const n = 6000;
      for (let i = 0; i < n; i++) sum += roller.rollHoard(level).total;
      const ratio = sum / n / roller.targetFor(level);
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.2);
    }
  });

  it("never rolls a psionic item at 0% and always does at 100%", () => {
    const psionic = /^(Cognizance crystal|Dorje|Power stone|Psicrown|Psionic tattoo|Universal psionic item|\+\d)/;
    const magicOnly = new TreasureRoller(TABLES, NO_EXTRAS, new Rng(21));
    const psionicOnly = new TreasureRoller(TABLES, { ...NO_EXTRAS, psionicChance: 1 }, new Rng(22));
    for (const grade of GRADES) {
      for (let i = 0; i < 400; i++) {
        expect(magicOnly.magic(grade).text).not.toMatch(/^(Cognizance crystal|Dorje|Power stone|Psicrown|Psionic tattoo|Universal psionic item)|psionic:/);
        expect(psionicOnly.magic(grade).text).toMatch(psionic);
      }
    }
  });

  it("prices magic weapons and armor from bonus, abilities and base cost", () => {
    const roller = new TreasureRoller(TABLES, NO_EXTRAS, new Rng(31));
    let plain = 0;
    for (let i = 0; i < 500; i++) {
      const weapon = roller.weapon("Minor", false, null);
      // No abilities: +1 is 2,000 gp and +2 is 8,000 gp, plus a masterwork base cost of 300-800 gp.
      const m = weapon.text.match(/^\+([12]) [a-z' -]+$/);
      if (m) {
        plain++;
        const base = m[1] === "1" ? 2000 : 8000;
        expect(weapon.gp).toBeGreaterThanOrEqual(base + 300);
        expect(weapon.gp).toBeLessThanOrEqual(base + 800);
      }
      const armor = roller.armor("Minor", false, null);
      expect(armor.gp).toBeGreaterThan(0);
      expect(armor.text).toMatch(/^(\+\d |Armor: |Shield: )/);
    }
    expect(plain).toBeGreaterThan(100);
  });

  it("keeps armor or shield and melee or ranged when a psionic type forces it", () => {
    const roller = new TreasureRoller(TABLES, NO_EXTRAS, new Rng(41));
    const ranged = /bow|crossbow|sling|dart|javelin|throwing axe|arrows|bolts|bullets|net|shuriken/;
    for (let i = 0; i < 300; i++) {
      expect(roller.armor("Medium", true, "shield").text).toMatch(/shield|buckler/);
      expect(roller.armor("Medium", true, "armor").text).not.toMatch(/shield|buckler/);
      expect(roller.weapon("Medium", true, "ranged").text).toMatch(ranged);
      expect(roller.weapon("Medium", true, "melee").text).not.toMatch(/arrows|bolts|bullets/);
    }
  });

  it("flags intelligent items instead of rolling their details", () => {
    const roller = new TreasureRoller(TABLES, { ...NO_EXTRAS, intelligentChance: 1 }, new Rng(51));
    const ring = roller.magic("Major");
    let sawIntelligent = /INTELLIGENT/.test(ring.text);
    for (let i = 0; i < 200; i++) {
      const line = roller.magic("Major");
      if (/INTELLIGENT/.test(line.text)) sawIntelligent = true;
      // Single-use and charged items never are.
      if (/^(Potion|Oil|Scroll|Wand)/.test(line.text)) expect(line.text).not.toMatch(/INTELLIGENT/);
    }
    expect(sawIntelligent).toBe(true);
    expect(roller.flags.some((f) => f.startsWith("Intelligent item"))).toBe(true);
  });

  it("flags a missing table once and uses a placeholder", () => {
    const tables = new Map(TABLES);
    tables.delete(tableKey("Rings", "Rings"));
    const roller = new TreasureRoller(tables, NO_EXTRAS, new Rng(61));
    const texts = Array.from({ length: 600 }, () => roller.magic("Medium").text);
    expect(texts.some((t) => t.startsWith("Placeholder"))).toBe(true);
    expect(roller.flags.filter((f) => f.includes("Rings / Rings"))).toHaveLength(1);
  });
});

describe("rollFloorTreasure", () => {
  const els = [5, 4, 2, 6, 4, 4, 5, 4, 6, 6];

  it("lands the floor total inside the allowed range, rerolling the whole floor when it has to", () => {
    let rerolled = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const result = rollFloorTreasure(TABLES, els, new Rng(seed));
      expect(result.hoards).toHaveLength(els.length);
      expect(result.target).toBe(1600 + 1200 + 600 + 2000 + 1200 + 1200 + 1600 + 1200 + 2000 + 2000);
      expect(result.inRange).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(0.75 * result.target);
      expect(result.total).toBeLessThanOrEqual(1.5 * result.target);
      expect(result.total).toBeCloseTo(result.hoards.reduce((sum, h) => sum + h.total, 0));
      if (result.tries > 1) rerolled++;
    }
    expect(rerolled).toBeGreaterThan(0);
  });

  it("gives up after the settings' tries and flags it", () => {
    const tables = new Map(TABLES);
    parseTreasureFile(
      "Treasure Settings",
      "## Treasure Settings\n\n| Setting | Value |\n| --- | --- |\n| Floor total minimum | 5000% |\n| Floor total maximum | 6000% |\n| Floor reroll tries | 4 |\n",
      tables
    );
    const result = rollFloorTreasure(tables, [1, 1, 1], new Rng(9));
    expect(result.inRange).toBe(false);
    expect(result.tries).toBe(4);
    expect(result.flags.some((f) => f.includes("outside 5000%–6000%"))).toBe(true);
  });

  it("is deterministic for a seed", () => {
    expect(rollFloorTreasure(TABLES, els, new Rng(77))).toEqual(rollFloorTreasure(TABLES, els, new Rng(77)));
  });

  it("renders one row per encounter", () => {
    const result = rollFloorTreasure(TABLES, els, new Rng(3));
    const ids = els.map((_, i) => (i < 8 ? `E${i + 1}` : `T${i - 7}`));
    const md = buildTreasureMarkdown(result, ids, DEFAULT_TREASURE_SETTINGS).join("\n");
    expect(md).toContain("## Treasure");
    expect(md).toContain("allowed 75%–150%");
    expect(md.match(/^\| (E|T)\d+ \|/gm)).toHaveLength(els.length);
    expect(md).toContain("| T2 |");
  });
});
