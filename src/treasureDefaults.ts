// The treasure tables (SRD Open Game Content, converted to markdown - see
// "Dungeon Generation/Treasure Generation Plan.md"), bundled into main.js as
// raw text the same way settingsDefaults.ts bundles the other settings
// files. They ship to the vault's `Dungeon Cartographer Settings/Treasure/`
// folder via "Reset Settings to Defaults", and are also the fallback the
// encounter generator uses for any table file the vault doesn't have.
// Edit the files in the repo's "Dungeon Cartographer Settings/Treasure/"
// folder, not here.

import t0 from "../Dungeon Cartographer Settings/Treasure/Armor and Shields.md";
import t1 from "../Dungeon Cartographer Settings/Treasure/Gems and Art.md";
import t2 from "../Dungeon Cartographer Settings/Treasure/Magic Item Types.md";
import t3 from "../Dungeon Cartographer Settings/Treasure/Mundane Items.md";
import t4 from "../Dungeon Cartographer Settings/Treasure/Potions and Oils.md";
import t5 from "../Dungeon Cartographer Settings/Treasure/Psionic Items.md";
import t6 from "../Dungeon Cartographer Settings/Treasure/Psionic Powers.md";
import t7 from "../Dungeon Cartographer Settings/Treasure/Rings.md";
import t8 from "../Dungeon Cartographer Settings/Treasure/Rods.md";
import t9 from "../Dungeon Cartographer Settings/Treasure/Scroll Spells, Arcane.md";
import t10 from "../Dungeon Cartographer Settings/Treasure/Scroll Spells, Divine.md";
import t11 from "../Dungeon Cartographer Settings/Treasure/Scrolls.md";
import t12 from "../Dungeon Cartographer Settings/Treasure/Staffs.md";
import t13 from "../Dungeon Cartographer Settings/Treasure/Treasure Settings.md";
import t14 from "../Dungeon Cartographer Settings/Treasure/Treasure by Encounter Level.md";
import t15 from "../Dungeon Cartographer Settings/Treasure/Wands.md";
import t16 from "../Dungeon Cartographer Settings/Treasure/Weapons.md";
import t17 from "../Dungeon Cartographer Settings/Treasure/Wondrous Items.md";

/** Subfolder of the settings folder the treasure tables live in. */
export const TREASURE_FOLDER_NAME = "Treasure";

/** File name -> contents. */
export const TREASURE_DEFAULT_FILES: Record<string, string> = {
  "Armor and Shields.md": t0,
  "Gems and Art.md": t1,
  "Magic Item Types.md": t2,
  "Mundane Items.md": t3,
  "Potions and Oils.md": t4,
  "Psionic Items.md": t5,
  "Psionic Powers.md": t6,
  "Rings.md": t7,
  "Rods.md": t8,
  "Scroll Spells, Arcane.md": t9,
  "Scroll Spells, Divine.md": t10,
  "Scrolls.md": t11,
  "Staffs.md": t12,
  "Treasure Settings.md": t13,
  "Treasure by Encounter Level.md": t14,
  "Wands.md": t15,
  "Weapons.md": t16,
  "Wondrous Items.md": t17,
};
