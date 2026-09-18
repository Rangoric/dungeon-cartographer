// Copy routine for the Dungeon Cartographer Settings system - see
// "Dungeon Generation/Dungeon Cartographer Settings Plan.md". Always
// overwrites every file in the vault's live settings folder with the
// plugin's shipped default (decided 2026-09-18: no per-file confirmation,
// no backup - the vault's own sync/version history is the only
// protection). Manual-only - this only ever runs via the "Reset Settings
// to Defaults" command (`main.ts`), never automatically on load.
//
// Takes a plain adapter-shaped interface rather than importing `obsidian`
// so this stays unit-testable without the plugin's minimal obsidian mock
// (`test/mocks/obsidian.ts`) needing to grow adapter methods it doesn't
// otherwise use.

export const SETTINGS_FOLDER_NAME = "Dungeon Cartographer Settings";

/** The slice of `Vault.adapter` this module actually calls. */
export interface SettingsAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/**
 * Walks the plugin-shipped defaults folder (`<pluginDir>/Dungeon
 * Cartographer Settings/`) and writes each file it contains into
 * `Dungeon Cartographer Settings/` at the vault root, creating that
 * folder first if it doesn't exist yet. Flat copy only - the settings
 * folder has no subfolders of its own. Returns the list of file names
 * copied, for the confirmation Notice.
 */
export async function copySettingsDefaults(adapter: SettingsAdapter, pluginDir: string): Promise<string[]> {
  const defaultsPath = `${pluginDir}/${SETTINGS_FOLDER_NAME}`;

  if (!(await adapter.exists(SETTINGS_FOLDER_NAME))) {
    await adapter.mkdir(SETTINGS_FOLDER_NAME);
  }

  const { files } = await adapter.list(defaultsPath);
  const copied: string[] = [];

  for (const filePath of files) {
    const fileName = filePath.slice(defaultsPath.length + 1);
    const contents = await adapter.read(filePath);
    await adapter.write(`${SETTINGS_FOLDER_NAME}/${fileName}`, contents);
    copied.push(fileName);
  }

  return copied;
}
