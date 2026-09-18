// Copy routine for the Dungeon Cartographer Settings system - see
// "Dungeon Generation/Dungeon Cartographer Settings Plan.md". Always
// overwrites every file in the vault's live settings folder with the
// plugin's shipped default (decided 2026-09-18: no per-file confirmation,
// no backup - the vault's own sync/version history is the only
// protection). Manual-only - this only ever runs via the "Reset Settings
// to Defaults" command (`main.ts`), never automatically on load.
//
// Originally read the plugin's own installed folder at runtime
// (`adapter.list`/`adapter.read` on a sibling "Dungeon Cartographer
// Settings/" directory) - dropped 2026-09-18 after confirming BRAT and
// Obsidian's own plugin installer only ever fetch main.js/manifest.json/
// styles.css from a release, never any other file. A plain on-disk
// defaults folder only ever worked in the dev vault, where this repo
// happens to be checked out directly into the installed plugin's own
// folder - anywhere else (BRAT, manual install, the community store) that
// folder simply never arrives, and `adapter.list` on it threw ENOENT. The
// defaults now travel as bundled text inside main.js instead (see
// settingsDefaults.ts) - install-method-agnostic by construction.
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
  write(path: string, data: string): Promise<void>;
}

/**
 * Writes every file in `defaults` (file name -> contents) into `Dungeon
 * Cartographer Settings/` at the vault root, creating that folder first
 * if it doesn't exist yet. Always overwrites. Returns the list of file
 * names written, for the confirmation Notice.
 */
export async function copySettingsDefaults(
  adapter: SettingsAdapter,
  defaults: Record<string, string>
): Promise<string[]> {
  if (!(await adapter.exists(SETTINGS_FOLDER_NAME))) {
    await adapter.mkdir(SETTINGS_FOLDER_NAME);
  }

  const copied: string[] = [];
  for (const [fileName, contents] of Object.entries(defaults)) {
    await adapter.write(`${SETTINGS_FOLDER_NAME}/${fileName}`, contents);
    copied.push(fileName);
  }

  return copied;
}
