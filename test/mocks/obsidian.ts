// Minimal stand-in for the `obsidian` runtime module.
//
// Obsidian injects the real module at runtime and it isn't installable as a
// normal package, so tests alias `obsidian` to this file (see vitest.config.mts).
// Only the surface our plugin actually touches is stubbed; extend as needed.

export class Plugin {
  app: unknown;
  constructor(app?: unknown) {
    this.app = app;
  }
  registerView(): void {}
  registerExtensions(): void {}
  registerEvent(): void {}
  addCommand(): void {}
  addRibbonIcon(): HTMLElement {
    return {} as HTMLElement;
  }
}

export class ItemView {
  app: unknown;
  leaf: WorkspaceLeaf;
  contentEl: HTMLElement = {} as HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
  }
  setState(_state: unknown, _result: unknown): Promise<void> {
    return Promise.resolve();
  }
}

export class WorkspaceLeaf {}

/** Minimal stand-in - real TFile carries much more, we only need `path`/`basename`. */
export class TFile {
  path = "";
  basename = "";
}
