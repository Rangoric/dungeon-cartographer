// The faction files (Modron, Angels, Devils, Demons - see "Dungeon
// Generation/Dungeon Setup.md"), bundled into main.js as raw text the same
// way treasureDefaults.ts bundles the treasure tables. They ship to the
// vault's `Dungeon Cartographer Settings/Factions/` folder via "Reset
// Settings to Defaults", and stand in for any faction a floor's Setup file
// names that the vault has no file for. Edit the files in the repo's
// "Dungeon Cartographer Settings/Factions/" folder, not here.

import angels from "../Dungeon Cartographer Settings/Factions/Angels.md";
import demons from "../Dungeon Cartographer Settings/Factions/Demons.md";
import devils from "../Dungeon Cartographer Settings/Factions/Devils.md";
import modron from "../Dungeon Cartographer Settings/Factions/Modron.md";

/** Subfolder of the settings folder the faction files live in. */
export const FACTIONS_FOLDER_NAME = "Factions";

/** File name -> contents. The file name (minus `.md`) is the faction's name in a Setup file's Factions row. */
export const FACTION_DEFAULT_FILES: Record<string, string> = {
  "Angels.md": angels,
  "Demons.md": demons,
  "Devils.md": devils,
  "Modron.md": modron,
};
