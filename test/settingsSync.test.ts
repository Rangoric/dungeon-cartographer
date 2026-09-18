import { describe, it, expect } from "vitest";
import { copySettingsDefaults, SETTINGS_FOLDER_NAME, type SettingsAdapter } from "../src/settingsSync";

/** In-memory stand-in for `Vault.adapter`, keyed by full vault-relative path. */
function fakeAdapter(initialFiles: Record<string, string>): SettingsAdapter {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();

  return {
    async exists(path) {
      return folders.has(path) || files.has(path);
    },
    async mkdir(path) {
      folders.add(path);
    },
    async list(path) {
      const prefix = `${path}/`;
      const matched = [...files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/"));
      return { files: matched, folders: [] };
    },
    async read(path) {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`no such file: ${path}`);
      return contents;
    },
    async write(path, data) {
      files.set(path, data);
    },
    // Test-only escape hatch to inspect final state.
    _files: files,
  } as SettingsAdapter & { _files: Map<string, string> };
}

const PLUGIN_DIR = ".obsidian/plugins/dungeon-cartographer";

describe("copySettingsDefaults", () => {
  it("creates the destination folder and copies every default file into it", async () => {
    const adapter = fakeAdapter({
      [`${PLUGIN_DIR}/${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`]: "chances",
      [`${PLUGIN_DIR}/${SETTINGS_FOLDER_NAME}/Other Generation Settings.md`]: "other",
    }) as SettingsAdapter & { _files: Map<string, string> };

    const copied = await copySettingsDefaults(adapter, PLUGIN_DIR);

    expect(copied.sort()).toEqual(["Other Generation Settings.md", "Physical Generation Chances.md"]);
    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`)).toBe("chances");
    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Other Generation Settings.md`)).toBe("other");
  });

  it("overwrites an existing vault copy rather than skipping it", async () => {
    const adapter = fakeAdapter({
      [`${PLUGIN_DIR}/${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`]: "new default",
      [`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`]: "hand-edited value",
    }) as SettingsAdapter & { _files: Map<string, string> };

    await copySettingsDefaults(adapter, PLUGIN_DIR);

    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`)).toBe("new default");
  });

  it("does not recreate the destination folder if it already exists", async () => {
    const adapter = fakeAdapter({
      [`${PLUGIN_DIR}/${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`]: "chances",
    }) as SettingsAdapter & { _files: Map<string, string> };
    let mkdirCalls = 0;
    const originalMkdir = adapter.mkdir.bind(adapter);
    adapter.mkdir = async (path) => {
      mkdirCalls++;
      await originalMkdir(path);
    };
    await adapter.mkdir(SETTINGS_FOLDER_NAME); // Pre-create it.
    mkdirCalls = 0;

    await copySettingsDefaults(adapter, PLUGIN_DIR);

    expect(mkdirCalls).toBe(0);
  });
});
