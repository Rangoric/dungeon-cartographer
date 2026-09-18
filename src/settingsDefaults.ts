// The Dungeon Cartographer Settings defaults, bundled into main.js as raw
// text at build time (see esbuild.config.mjs's `loader` config and
// text-modules.d.ts) rather than read off disk at runtime - see
// settingsSync.ts's module header for why. The "Dungeon Cartographer
// Settings/" folder at the plugin repo root stays the human-editable
// source of truth; edit the files there, not here.

import physicalGenerationChances from "../Dungeon Cartographer Settings/Physical Generation Chances.md";
import otherGenerationSettings from "../Dungeon Cartographer Settings/Other Generation Settings.md";
import dungeonMonstersBase from "../Dungeon Cartographer Settings/Dungeon Monsters.base";
import lockTrapStuckDoorDCs from "../Dungeon Cartographer Settings/Lock, Trap & Stuck Door DCs.md";

/** File name (as it should land in the vault's settings folder) -> contents. */
export const SETTINGS_DEFAULT_FILES: Record<string, string> = {
  "Physical Generation Chances.md": physicalGenerationChances,
  "Other Generation Settings.md": otherGenerationSettings,
  "Dungeon Monsters.base": dungeonMonstersBase,
  "Lock, Trap & Stuck Door DCs.md": lockTrapStuckDoorDCs,
};
