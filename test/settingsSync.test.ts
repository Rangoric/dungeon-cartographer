import { describe, it, expect } from "vitest";
import { copySettingsDefaults, SETTINGS_FOLDER_NAME, type SettingsAdapter } from "../src/settingsSync";

/** In-memory stand-in for `Vault.adapter`, keyed by full vault-relative path. */
function fakeAdapter(initialFiles: Record<string, string> = {}): SettingsAdapter & { _files: Map<string, string> } {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();

  return {
    async exists(path) {
      return folders.has(path) || files.has(path);
    },
    async mkdir(path) {
      folders.add(path);
    },
    async write(path, data) {
      files.set(path, data);
    },
    _files: files,
  };
}

describe("copySettingsDefaults", () => {
  it("creates the destination folder and writes every default file into it", async () => {
    const adapter = fakeAdapter();
    const defaults = {
      "Physical Generation Chances.md": "chances",
      "Other Generation Settings.md": "other",
    };

    const copied = await copySettingsDefaults(adapter, defaults);

    expect(copied.sort()).toEqual(["Other Generation Settings.md", "Physical Generation Chances.md"]);
    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`)).toBe("chances");
    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Other Generation Settings.md`)).toBe("other");
  });

  it("overwrites an existing vault copy rather than skipping it", async () => {
    const adapter = fakeAdapter({
      [`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`]: "hand-edited value",
    });

    await copySettingsDefaults(adapter, { "Physical Generation Chances.md": "new default" });

    expect(adapter._files.get(`${SETTINGS_FOLDER_NAME}/Physical Generation Chances.md`)).toBe("new default");
  });

  it("does not recreate the destination folder if it already exists", async () => {
    const adapter = fakeAdapter();
    let mkdirCalls = 0;
    const originalMkdir = adapter.mkdir.bind(adapter);
    adapter.mkdir = async (path) => {
      mkdirCalls++;
      await originalMkdir(path);
    };
    await adapter.mkdir(SETTINGS_FOLDER_NAME); // Pre-create it.
    mkdirCalls = 0;

    await copySettingsDefaults(adapter, { "Physical Generation Chances.md": "chances" });

    expect(mkdirCalls).toBe(0);
  });

  it("never touches the filesystem outside the destination folder (no plugin-directory read side anymore)", async () => {
    const adapter = fakeAdapter();

    const copied = await copySettingsDefaults(adapter, {});

    expect(copied).toEqual([]);
  });
});
