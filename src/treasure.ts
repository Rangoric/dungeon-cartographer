// Treasure rolling for a floor's encounters - "Dungeon Generation/Treasure
// Generation Plan.md" is the design. Every encounter (traps included) rolls
// once on the SRD's Treasure table at its own Encounter Level: Coins, Goods
// and Items, each followed all the way down to a specific gem, art object,
// mundane item or magic item with a gp value.
//
// Decisions baked in (Wilson, 2026-10-02):
//   - Actual EL, no party-size scaling: treasure is per encounter.
//   - Pure rolls. The floor total must land within the settings' minimum and
//     maximum share (75%-150%) of the sum of each encounter's treasure value;
//     if not, every treasure on the floor is rerolled, up to the settings'
//     number of tries, then flagged.
//   - Cursed items are never rolled. Intelligent items are flagged only.
//   - A share of magic item results (25%) become psionic items of the same
//     grade. Epic items are out.
//   - Wands, staffs and dorjes are priced fully charged.
//   - EL is rounded; below 1 uses the EL 1 rows, above 20 the EL 20 rows.
//
// The tables themselves are data (treasureTables.ts reads them from the
// vault's `Dungeon Cartographer Settings/Treasure/` folder); the chains
// between them (weapon -> bonus -> special abilities -> base weapon, scroll
// -> type -> count -> level -> spell, ...) are the code below.
//
// Free of Obsidian imports, same as the other content modules.

import type { Rng } from "./generate";
import {
  coinValue,
  parseGp,
  parseSettingNumber,
  rollDice,
  rollRow,
  rowsOf,
  tableKey,
  type Row,
  type TreasureTable,
  type TreasureTables,
} from "./treasureTables";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Grade = "Minor" | "Medium" | "Major";

export interface TreasureLine {
  text: string;
  gp: number;
  /** Book the entry comes from - items only; coins, gems and art have none. */
  source: string | null;
}

export interface Hoard {
  /** The encounter's EL as given. */
  el: number;
  /** The Treasure table level used (EL rounded and clamped to 1-20). */
  level: number;
  /** Treasure Value per Encounter for that level. */
  target: number;
  lines: TreasureLine[];
  total: number;
}

export interface TreasureSettings {
  psionicChance: number;
  intelligentChance: number;
  floorMin: number;
  floorMax: number;
  rerollTries: number;
}

export const DEFAULT_TREASURE_SETTINGS: TreasureSettings = {
  psionicChance: 0.25,
  intelligentChance: 0.01,
  floorMin: 0.75,
  floorMax: 1.5,
  rerollTries: 20,
};

export interface FloorTreasure {
  hoards: Hoard[];
  total: number;
  target: number;
  /** How many times the whole floor was rolled (1 = first roll was in range). */
  tries: number;
  inRange: boolean;
  flags: string[];
}

const SOURCE = "SRD";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Reads `Treasure Settings.md`'s table; anything missing or unreadable keeps its default. */
export function readTreasureSettings(tables: TreasureTables): TreasureSettings {
  const settings = { ...DEFAULT_TREASURE_SETTINGS };
  const table = tables.get(tableKey("Treasure Settings", "Treasure Settings"));
  if (!table) return settings;
  const names: Record<string, keyof TreasureSettings> = {
    "psionic item chance": "psionicChance",
    "intelligent item chance": "intelligentChance",
    "floor total minimum": "floorMin",
    "floor total maximum": "floorMax",
    "floor reroll tries": "rerollTries",
  };
  for (const row of rowsOf(table)) {
    const key = names[(row["Setting"] ?? "").toLowerCase()];
    const value = parseSettingNumber(row["Value"] ?? "");
    if (key && value !== null) settings[key] = value;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

/**
 * Table names to how they read in a sentence, lowercased: "Sword, bastard"
 * -> "bastard sword"; "Shield, light, wooden" -> "light wooden shield";
 * "Fortification, light" -> "light fortification"; "Bolts, crossbow (50)" ->
 * "crossbow bolts (50)". A trailing parenthetical keeps its own case
 * ("(+4 Str bonus)").
 */
export function naturalName(name: string): string {
  const paren = name.match(/^(.*?)(\s*\([^)]*\))$/);
  const core = paren ? paren[1] : name;
  const tail = paren ? paren[2] : "";
  const parts = core.split(/,\s*/);
  const natural = parts.length > 1 ? `${parts.slice(1).join(" ")} ${parts[0]}` : core;
  return `${natural.toLowerCase()}${tail}`;
}

/** "+1 longsword (flaming, frost)" / "+2 heavy steel shield (psionic: manifester)" / "+1 dagger". */
function enhancedName(bonus: number, base: string, abilities: string[], psionic: boolean): string {
  if (abilities.length === 0) return `+${bonus} ${base}`;
  return `+${bonus} ${base} (${psionic ? "psionic: " : ""}${abilities.join(", ")})`;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Special abilities that are steps of one ability: only the best one counts. */
function abilityFamily(name: string): string {
  return name
    .replace(/,\s*(light|moderate|heavy|improved|greater|lesser|minor|major)$/i, "")
    .replace(/\s*\(\d+\)$/, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// The roller
// ---------------------------------------------------------------------------

interface Ability {
  name: string;
  bonus: number;
  flat: number;
}

const MAX_TOTAL_BONUS = 10;
const LOOP_GUARD = 60;

export class TreasureRoller {
  /** Messages for the note's Flags section (missing tables, intelligent items). */
  readonly flags: string[] = [];
  private readonly missing = new Set<string>();

  constructor(
    private readonly tables: TreasureTables,
    private readonly settings: TreasureSettings,
    private readonly rng: Rng
  ) {}

  // --- table access -----------------------------------------------------------

  private table(file: string, section: string): TreasureTable | null {
    const table = this.tables.get(tableKey(file, section));
    if (!table) {
      const label = `${file} / ${section}`;
      if (!this.missing.has(label)) {
        this.missing.add(label);
        this.flags.push(`Treasure table "${label}" wasn't found - anything that needed it is a placeholder.`);
      }
      return null;
    }
    return table;
  }

  private roll(file: string, section: string, column: string, filter?: (row: Row) => boolean): Row | null {
    const table = this.table(file, section);
    return table ? rollRow(table, column, this.rng, filter) : null;
  }

  private line(text: string, gp: number, source: string | null = SOURCE): TreasureLine {
    return { text, gp, source };
  }

  private placeholder(what: string): TreasureLine {
    return this.line(`Placeholder: ${what}`, 0);
  }

  // --- the top-level roll -----------------------------------------------------

  targetFor(level: number): number {
    const table = this.table("Treasure by Encounter Level", "Treasure Value per Encounter");
    const row = table ? rowsOf(table).find((r) => Number(r["EL"]) === level) : undefined;
    return row ? parseGp(row["Value"]) : 0;
  }

  rollHoard(el: number): Hoard {
    const level = Math.min(20, Math.max(1, Math.round(el)));
    const lines: TreasureLine[] = [];
    for (const type of ["Coins", "Goods", "Items"]) {
      const row = this.roll(
        "Treasure by Encounter Level",
        "Treasure",
        "d%",
        (r) => Number(r["Level"]) === level && r["Type"] === type
      );
      const result = row?.["Result"] ?? "—";
      if (result === "—" || result === "") continue;
      if (type === "Coins") lines.push(...this.coins(result));
      else if (type === "Goods") lines.push(...this.goods(result));
      else lines.push(...this.items(result));
    }
    const total = lines.reduce((sum, l) => sum + l.gp, 0);
    return { el, level, target: this.targetFor(level), lines, total };
  }

  private coins(result: string): TreasureLine[] {
    const unit = result.match(/\b(cp|sp|gp|pp)\b/)?.[1];
    if (!unit) return [this.placeholder(`coins (${result})`)];
    const amount = rollDice(result, this.rng);
    return [this.line(`${amount.toLocaleString("en-US")} ${unit}`, coinValue(amount, unit), null)];
  }

  private goods(result: string): TreasureLine[] {
    const count = rollDice(result, this.rng);
    const isGem = /gem/i.test(result);
    const lines: TreasureLine[] = [];
    for (let i = 0; i < count; i++) {
      const row = this.roll("Gems and Art", isGem ? "Gems" : "Art Objects", "d%");
      if (!row) {
        lines.push(this.placeholder(isGem ? "gem" : "art object"));
        continue;
      }
      const value = rollDice(row["Value"], this.rng);
      const examples = row["Examples"].split(";").map((e) => e.trim()).filter(Boolean);
      const example = examples.length > 0 ? lowerFirst(this.rng.choice(examples)) : isGem ? "gem" : "art object";
      lines.push(this.line(`${isGem ? "Gem" : "Art"}: ${example}`, value, null));
    }
    return lines;
  }

  private items(result: string): TreasureLine[] {
    const count = rollDice(result, this.rng);
    const kind = result.match(/mundane|minor|medium|major/i)?.[0].toLowerCase();
    const lines: TreasureLine[] = [];
    for (let i = 0; i < count; i++) {
      if (kind === "mundane") lines.push(this.mundane());
      else if (kind === "minor") lines.push(this.magic("Minor"));
      else if (kind === "medium") lines.push(this.magic("Medium"));
      else if (kind === "major") lines.push(this.magic("Major"));
      else lines.push(this.placeholder(`item (${result})`));
    }
    return lines;
  }

  // --- mundane items ----------------------------------------------------------

  mundane(): TreasureLine {
    const category = this.roll("Mundane Items", "Mundane Item Category", "d%")?.["Result"] ?? "";
    if (category === "Alchemical item") return this.pricedItem("Alchemical Items");
    if (category === "Tools and gear") return this.pricedItem("Tools and Gear");
    if (category === "Armor") {
      let row = this.roll("Mundane Items", "Mundane Armor", "d%");
      if (!row) return this.placeholder("mundane armor");
      let name = row["Item"];
      if (/^Darkwood shield/i.test(name)) {
        row = this.roll("Mundane Items", "Darkwood Shields", "d%");
        if (!row) return this.placeholder("darkwood shield");
        name = `Darkwood ${row["Item"].toLowerCase()}`;
      } else if (/^Masterwork shield/i.test(name)) {
        row = this.roll("Mundane Items", "Masterwork Shields", "d%");
        if (!row) return this.placeholder("masterwork shield");
        name = `Masterwork ${row["Item"].toLowerCase()}`;
      }
      const small = this.rng.randint(1, 100) <= 10;
      return this.line(`${name}${small ? " (Small)" : ""}`, parseGp(row["Price Each"]));
    }
    if (category === "Weapons") {
      const which = this.roll("Mundane Items", "Mundane Weapons", "d%")?.["Result"] ?? "";
      const section = /uncommon/i.test(which)
        ? "Uncommon Weapons"
        : /ranged/i.test(which)
          ? "Common Ranged Weapons"
          : "Common Melee Weapons";
      const weapon = this.baseWeapon(section);
      if (!weapon) return this.placeholder("masterwork weapon");
      return this.line(`Masterwork ${naturalName(weapon.name)}`, weapon.cost);
    }
    return this.placeholder("mundane item");
  }

  private pricedItem(section: string): TreasureLine {
    const row = this.roll("Mundane Items", section, "d%");
    if (!row) return this.placeholder(section.toLowerCase());
    const quantity = Math.max(1, rollDice(row["Quantity"], this.rng));
    const each = parseGp(row["Price Each"]);
    const name = quantity > 1 ? `${quantity}× ${lowerFirst(row["Item"])}` : row["Item"];
    return this.line(name, quantity * each);
  }

  // --- magic items ------------------------------------------------------------

  magic(grade: Grade): TreasureLine {
    if (this.rng.random() < this.settings.psionicChance) return this.psionic(grade);
    for (let i = 0; i < LOOP_GUARD; i++) {
      const type = this.roll("Magic Item Types", "Magic Item Type", grade)?.["Item"] ?? "";
      switch (type.toLowerCase()) {
        case "armor and shields":
          return this.intelligent(this.armor(grade, false, null));
        case "weapons":
          return this.intelligent(this.weapon(grade, false, null), (l) => !/\(50\)/.test(l.text));
        case "potions": {
          const row = this.roll("Potions and Oils", "Potions and Oils", grade);
          if (!row) continue;
          const m = row["Item"].match(/^(.*?)\s*\((potion or oil|potion|oil)\)$/i);
          const label = m ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}: ${m[1]}` : `Potion: ${row["Item"]}`;
          return this.line(label, parseGp(row["Price"]));
        }
        case "rings":
          return this.intelligent(this.simple("Rings", "Rings", grade, "Ring"));
        case "rods":
          return this.intelligent(this.simple("Rods", "Rods", grade, "Rod"));
        case "staffs":
          return this.intelligent(this.simple("Staffs", "Staffs", grade, "Staff"));
        case "wands":
          return this.simple("Wands", "Wands", grade, "Wand");
        case "scrolls":
          return this.scroll(grade);
        case "wondrous items": {
          const row = this.roll("Wondrous Items", `${grade} Wondrous Items`, "d%");
          if (!row) continue;
          return this.intelligent(this.line(`Wondrous item: ${row["Item"]}`, parseGp(row["Price"])));
        }
        default:
          return this.placeholder(`${grade.toLowerCase()} magic item`);
      }
    }
    return this.placeholder(`${grade.toLowerCase()} magic item`);
  }

  /** A table whose rows are just Item + Price, in a grade column. */
  private simple(file: string, section: string, grade: Grade, label: string): TreasureLine {
    const row = this.roll(file, section, grade);
    if (!row) return this.placeholder(`${grade.toLowerCase()} ${label.toLowerCase()}`);
    return this.line(`${label}: ${row["Item"]}`, parseGp(row["Price"]));
  }

  /** Flags a permanent item as intelligent on the settings' chance. Details are left to the DM. */
  private intelligent(line: TreasureLine, eligible: (line: TreasureLine) => boolean = () => true): TreasureLine {
    if (line.text.startsWith("Placeholder") || !eligible(line)) return line;
    if (this.rng.random() >= this.settings.intelligentChance) return line;
    this.flags.push(`Intelligent item: "${line.text}" - roll its alignment, abilities and Ego by hand (its price doesn't include them).`);
    return { ...line, text: `${line.text} — INTELLIGENT` };
  }

  // --- armor and shields ------------------------------------------------------

  /** `forced` pins the result to armor or a shield (psionic item types name which one). */
  armor(grade: Grade, psionic: boolean, forced: "armor" | "shield" | null): TreasureLine {
    let bonus = 0;
    let kind: "armor" | "shield" | null = null;
    let pending = 0;
    for (let i = 0; i < LOOP_GUARD && kind === null; i++) {
      const row = this.roll("Armor and Shields", "Armor and Shields", grade);
      if (!row) return this.placeholder("magic armor");
      const item = row["Item"];
      const plus = item.match(/^\+(\d+) (shield|armor)$/i);
      if (plus) {
        if (forced && plus[2].toLowerCase() !== forced) continue;
        bonus = Number(plus[1]);
        kind = plus[2].toLowerCase() as "armor" | "shield";
      } else if (/^Special ability/i.test(item)) {
        pending++;
      } else if (/^Specific (armor|shield)/i.test(item)) {
        // Specific items have no psionic versions and can't take an extra ability.
        if (psionic || pending > 0) continue;
        const isShield = /shield/i.test(item);
        if (forced && (forced === "shield") !== isShield) continue;
        const specific = this.roll("Armor and Shields", isShield ? "Specific Shields" : "Specific Armors", grade);
        if (!specific) continue;
        return this.line(`${isShield ? "Shield" : "Armor"}: ${specific["Item"]}`, parseGp(specific["Price"]));
      }
    }
    if (kind === null) return this.placeholder("magic armor");

    const base = this.roll("Armor and Shields", kind === "armor" ? "Armor Types" : "Shield Types", "d%");
    if (!base) return this.placeholder(`magic ${kind}`);
    const baseName = naturalName(base[kind === "armor" ? "Armor" : "Shield"]);

    const abilitySection = psionic
      ? ["Psionic Items", kind === "armor" ? "Psionic Armor Special Abilities" : "Psionic Shield Special Abilities"]
      : ["Armor and Shields", kind === "armor" ? "Armor Special Abilities" : "Shield Special Abilities"];
    const abilities = this.abilities(abilitySection[0], abilitySection[1], grade, pending, bonus);
    const totalBonus = bonus + abilities.reduce((sum, a) => sum + a.bonus, 0);
    const gp = totalBonus * totalBonus * 1000 + abilities.reduce((sum, a) => sum + a.flat, 0) + parseGp(base["Cost"]);
    return this.line(enhancedName(bonus, baseName, abilities.map((a) => naturalName(a.name)), psionic), gp);
  }

  /**
   * Rolls `count` special abilities (a "roll twice" result adds two more).
   * Duplicates are rerolled, only the best step of one ability is kept, and
   * abilities that would push the total bonus past +10 are dropped.
   */
  private abilities(file: string, section: string, grade: Grade, count: number, baseBonus: number): Ability[] {
    const picked: Ability[] = [];
    let remaining = count;
    for (let i = 0; i < LOOP_GUARD && remaining > 0; i++) {
      const row = this.roll(file, section, grade);
      if (!row) break;
      let name = row["Special Ability"];
      if (/^Roll (twice again|again twice)/i.test(name)) {
        remaining += 1; // this roll is replaced by two
        continue;
      }
      const price = row["Price"];
      const bonusMatch = price.match(/^\+(\d+) bonus/i);
      const ability: Ability = { name, bonus: bonusMatch ? Number(bonusMatch[1]) : 0, flat: bonusMatch ? 0 : parseGp(price) };
      if (/^Bane$/i.test(name)) {
        const foe = this.roll("Weapons", "Bane Designated Foe", "d%")?.["Foe"];
        if (foe) ability.name = name = `Bane vs. ${naturalName(foe)}`;
      }
      const family = abilityFamily(ability.name);
      const same = picked.findIndex((a) => abilityFamily(a.name) === family);
      if (same >= 0) {
        const worth = (a: Ability) => a.bonus * 1_000_000 + a.flat;
        if (worth(ability) > worth(picked[same])) picked[same] = ability;
        else continue; // duplicate or weaker step: roll again
      } else {
        picked.push(ability);
      }
      remaining--;
    }
    while (picked.length > 0 && baseBonus + picked.reduce((sum, a) => sum + a.bonus, 0) > MAX_TOTAL_BONUS) picked.pop();
    return picked;
  }

  // --- weapons ----------------------------------------------------------------

  private baseWeapon(section: string): { name: string; cost: number; kind: "melee" | "ranged" } | null {
    let row = this.roll("Weapons", section, "d%");
    if (row && /^Ammunition/i.test(row["Weapon"])) row = this.roll("Weapons", "Ammunition", "d%");
    if (!row) return null;
    return { name: row["Weapon"], cost: parseGp(row["Cost"]), kind: row["Kind"] === "ranged" ? "ranged" : "melee" };
  }

  private randomWeapon(forced: "melee" | "ranged" | null): { name: string; cost: number; kind: "melee" | "ranged" } | null {
    for (let i = 0; i < LOOP_GUARD; i++) {
      const type = this.roll("Weapons", "Weapon Type", "d%")?.["Result"] ?? "";
      const section = /uncommon/i.test(type) ? "Uncommon Weapons" : /ranged/i.test(type) ? "Common Ranged Weapons" : "Common Melee Weapons";
      const weapon = this.baseWeapon(section);
      if (!weapon) return null;
      if (!forced || weapon.kind === forced) return weapon;
    }
    return null;
  }

  weapon(grade: Grade, psionic: boolean, forced: "melee" | "ranged" | null): TreasureLine {
    let bonus = 0;
    let pending = 0;
    for (let i = 0; i < LOOP_GUARD && bonus === 0; i++) {
      const row = this.roll("Weapons", "Weapon Bonus", grade);
      if (!row) return this.placeholder("magic weapon");
      const item = row["Item"];
      const plus = item.match(/^\+(\d+)$/);
      if (plus) {
        bonus = Number(plus[1]);
      } else if (/^Special ability/i.test(item)) {
        pending++;
      } else if (/^Specific weapon/i.test(item)) {
        if (psionic || pending > 0 || forced) continue;
        const specific = this.roll("Weapons", "Specific Weapons", grade);
        if (!specific) continue;
        let name = specific["Item"];
        if (/^Slaying arrow/i.test(name)) {
          const foe = this.roll("Weapons", "Bane Designated Foe", "d%")?.["Foe"];
          if (foe) name = `${name} vs. ${naturalName(foe)}`;
        }
        return this.line(`Weapon: ${name}`, parseGp(specific["Price"]));
      }
    }
    if (bonus === 0) return this.placeholder("magic weapon");

    const base = this.randomWeapon(forced);
    if (!base) return this.placeholder("magic weapon");
    const section = psionic
      ? ["Psionic Items", base.kind === "melee" ? "Psionic Melee Weapon Special Abilities" : "Psionic Ranged Weapon Special Abilities"]
      : ["Weapons", base.kind === "melee" ? "Melee Special Abilities" : "Ranged Special Abilities"];
    const abilities = this.abilities(section[0], section[1], grade, pending, bonus);
    const totalBonus = bonus + abilities.reduce((sum, a) => sum + a.bonus, 0);
    const gp = totalBonus * totalBonus * 2000 + abilities.reduce((sum, a) => sum + a.flat, 0) + base.cost;
    return this.line(enhancedName(bonus, naturalName(base.name), abilities.map((a) => naturalName(a.name)), psionic), gp);
  }

  // --- scrolls ----------------------------------------------------------------

  scroll(grade: Grade): TreasureLine {
    const type = /divine/i.test(this.roll("Scrolls", "Scroll Type", "d%")?.["Type"] ?? "") ? "Divine" : "Arcane";
    const countTable = this.table("Scrolls", "Number of Spells");
    const countExpr = countTable ? rowsOf(countTable).find((r) => r["Grade"] === grade)?.["Spells"] : undefined;
    const count = Math.max(1, rollDice(countExpr ?? "1", this.rng));
    const spells: string[] = [];
    let gp = 0;
    for (let i = 0; i < count; i++) {
      const level = this.roll("Scrolls", "Spell Level", grade)?.["Spell Level"];
      const spell = level !== undefined ? this.roll(`Scroll Spells, ${type}`, `Level ${level}`, "d%") : null;
      if (!spell) {
        spells.push("(placeholder spell)");
        continue;
      }
      spells.push(`${spell["Spell"]} (${level})`);
      gp += parseGp(spell["Price"]);
    }
    return this.line(`Scroll, ${type.toLowerCase()}: ${spells.join(", ")}`, gp);
  }

  // --- psionic items ----------------------------------------------------------

  private power(list: "Psion/Wilder" | "Psychic Warrior", level: number): string {
    const table = this.table("Psionic Powers", `${list} Level ${level}`);
    if (!table || table.rows.length === 0) return "(placeholder power)";
    return naturalName(this.rng.choice(table.rows)[0]);
  }

  psionic(grade: Grade): TreasureLine {
    for (let i = 0; i < LOOP_GUARD; i++) {
      const type = (this.roll("Psionic Items", "Psionic Item Type", grade)?.["Item"] ?? "").toLowerCase();
      if (type === "armor") return this.intelligent(this.armor(grade, true, "armor"));
      if (type === "shield") return this.intelligent(this.armor(grade, true, "shield"));
      if (type === "melee weapon") return this.intelligent(this.weapon(grade, true, "melee"));
      if (type === "ranged weapon") return this.intelligent(this.weapon(grade, true, "ranged"), (l) => !/\(50\)/.test(l.text));
      if (type === "cognizance crystal") {
        const row = this.roll("Psionic Items", "Cognizance Crystals", grade);
        if (!row) continue;
        const points = row["Power Points"];
        return this.line(`Cognizance crystal (${points} power point${points === "1" ? "" : "s"})`, parseGp(row["Price"]));
      }
      if (type === "dorje" || type === "psionic tattoo") {
        const row = this.roll("Psionic Items", type === "dorje" ? "Dorjes" : "Psionic Tattoos", grade);
        if (!row) continue;
        const level = Number(row["Power Level"]);
        const label = type === "dorje" ? "Dorje" : "Psionic tattoo";
        return this.line(`${label}: ${this.power("Psion/Wilder", level)} (${level})`, parseGp(row["Price"]));
      }
      if (type === "power stone") {
        const warrior = /warrior/i.test(this.roll("Psionic Items", "Power Stone Type", "d%")?.["Type"] ?? "");
        const countTable = this.table("Psionic Items", "Power Stone Number of Powers");
        const countExpr = countTable ? rowsOf(countTable).find((r) => r["Grade"] === grade)?.["Powers"] : undefined;
        const count = Math.max(1, rollDice(countExpr ?? "1", this.rng));
        const powers: string[] = [];
        let gp = 0;
        for (let p = 0; p < count; p++) {
          let row: Row | null = null;
          for (let t = 0; t < LOOP_GUARD; t++) {
            row = this.roll("Psionic Items", "Power Stone Power Level", grade);
            if (!row || !warrior || Number(row["Power Level"]) <= 6) break;
          }
          if (!row) {
            powers.push("(placeholder power)");
            continue;
          }
          const level = Math.min(Number(row["Power Level"]), warrior ? 6 : 9);
          powers.push(`${this.power(warrior ? "Psychic Warrior" : "Psion/Wilder", level)} (${level})`);
          gp += parseGp(row["Price"]);
        }
        return this.line(`Power stone, ${warrior ? "psychic warrior" : "psion/wilder"}: ${powers.join(", ")}`, gp);
      }
      if (type === "psicrown") {
        const row = this.roll("Psionic Items", "Psicrowns", grade);
        if (!row) continue; // no minor psicrowns: roll the type again
        return this.intelligent(this.line(`Psicrown: ${row["Item"]}`, parseGp(row["Price"])));
      }
      if (/universal item$/.test(type)) {
        const row = this.roll("Psionic Items", `${grade} Universal Items`, "d%");
        if (!row) continue;
        return this.intelligent(this.line(`Universal psionic item: ${row["Item"]}`, parseGp(row["Price"])));
      }
      if (type === "") break;
    }
    return this.placeholder(`${grade.toLowerCase()} psionic item`);
  }
}

// ---------------------------------------------------------------------------
// A whole floor
// ---------------------------------------------------------------------------

/**
 * Rolls a hoard for each encounter EL, then checks the floor total against
 * the sum of the encounters' treasure values. Outside the settings' range,
 * every hoard is rolled again, up to `rerollTries` times in all.
 */
export function rollFloorTreasure(tables: TreasureTables, els: number[], rng: Rng): FloorTreasure {
  const settings = readTreasureSettings(tables);
  const maxTries = Math.max(1, Math.round(settings.rerollTries));
  let best: FloorTreasure | null = null;
  for (let tries = 1; tries <= maxTries; tries++) {
    const roller = new TreasureRoller(tables, settings, rng);
    const hoards = els.map((el) => roller.rollHoard(el));
    const total = hoards.reduce((sum, h) => sum + h.total, 0);
    const target = hoards.reduce((sum, h) => sum + h.target, 0);
    const inRange = target > 0 && total >= settings.floorMin * target && total <= settings.floorMax * target;
    best = { hoards, total, target, tries, inRange, flags: roller.flags };
    if (inRange || target === 0) break;
  }
  const result = best!;
  if (!result.inRange && result.target > 0) {
    result.flags.push(
      `Treasure total ${formatGp(result.total)} is outside ${Math.round(settings.floorMin * 100)}%–${Math.round(settings.floorMax * 100)}% of the ${formatGp(result.target)} target after ${result.tries} tries - kept the last roll.`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function formatGp(gp: number): string {
  return `${gp.toLocaleString("en-US", { maximumFractionDigits: 2 })} gp`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** "Ring: Protection +1 (2,000 gp, SRD)"; "800 sp (80 gp)"; gold coins are just "500 gp". */
function lineText(line: TreasureLine): string {
  if (line.source === null && line.text === formatGp(line.gp)) return line.text;
  return `${cell(line.text)} (${formatGp(line.gp)}${line.source ? `, ${line.source}` : ""})`;
}

/** The `## Treasure` section of `Floor N Encounters.md`. `ids` are the encounter IDs, in the same order as the hoards. */
export function buildTreasureMarkdown(treasure: FloorTreasure, ids: string[], settings: TreasureSettings): string[] {
  const pct = treasure.target > 0 ? Math.round((treasure.total / treasure.target) * 100) : 0;
  const lines: string[] = [
    "## Treasure",
    "",
    `One roll per encounter on the SRD Treasure table at the encounter's EL. Floor total ${formatGp(treasure.total)} against a target of ${formatGp(treasure.target)} (${pct}%; allowed ${Math.round(settings.floorMin * 100)}%–${Math.round(settings.floorMax * 100)}%)` +
      (treasure.tries > 1 ? `, after ${treasure.tries} rolls of the whole floor.` : "."),
    "",
    "| ID | EL | Target | Rolled | Treasure |",
    "| -- | :-: | --: | --: | -------- |",
  ];
  treasure.hoards.forEach((hoard, i) => {
    const items =
      hoard.lines.length > 0 ? hoard.lines.map(lineText).join("<br>") : "—";
    lines.push(`| ${ids[i] ?? i + 1} | ${hoard.level} | ${formatGp(hoard.target)} | ${formatGp(hoard.total)} | ${items} |`);
  });
  lines.push("");
  return lines;
}
