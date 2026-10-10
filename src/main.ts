import { ItemView, Notice, Plugin, TFile, TFolder, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { parseDungeonFloor, type DungeonDoor, type DungeonFloorData } from "./dungeonData";
import { createFloor2DView, renderFloorToSvgString, type Floor2DView } from "./floor2dView";
import { generateFloor, configFromFloorSetup, Rng } from "./generate";
import { parseFloorSetup, DEFAULT_FLOOR_SETUP, type FloorSetup } from "./floorSetup";
import { copySettingsDefaults, SETTINGS_FOLDER_NAME } from "./settingsSync";
import { SETTINGS_DEFAULT_FILES } from "./settingsDefaults";
import { parseLockTrapRules, rollLockedDoorDC, DEFAULT_LOCK_TRAP_RULES, type LockTrapRules } from "./lockTrapRules";
import {
  buildDoorNoteMarkdown,
  doorNeedsNote,
  doorNotePathFor,
  doorsFolderPathFor,
  pickTrapFlavor,
  rollDoorChallengeLevel,
} from "./doorNotes";
import { buildCorridorStubMarkdown, corridorNotePathFor, noteHoverExcerpt } from "./entityNotes";
import {
  buildEncounterNoteMarkdown,
  generateEncounters,
  MAX_FACTIONS,
  parseCR,
  parseEncounterSetup,
  parseFactionFile,
  parseTrapsByCR,
  type Faction,
  type PoolMonster,
} from "./encounters";

import { buildTreasureMarkdown, readTreasureSettings, rollFloorTreasure } from "./treasure";
import { parseTreasureFile, type TreasureTables } from "./treasureTables";
import { TREASURE_DEFAULT_FILES, TREASURE_FOLDER_NAME } from "./treasureDefaults";
import { FACTION_DEFAULT_FILES, FACTIONS_FOLDER_NAME } from "./factionDefaults";

/** Where the vault's monster stat-block notes live - the random-pick pool for encounter generation. */
const MONSTER_FOLDER = "Source Data/Monsters";
/** Faction files: `Dungeon Cartographer Settings/Factions/<Name>.md`, name-matched to the Setup file's Factions row. */
const FACTIONS_FOLDER = `${SETTINGS_FOLDER_NAME}/${FACTIONS_FOLDER_NAME}`;
/** Same filter as `Dungeon Monsters.base`: a monster belongs in dungeons if its terrain_hex includes Underground or Any. */
const DUNGEON_TERRAINS = ["underground", "any"];

// 2026-09-05: the 3D Three.js viewer (OrbitControls, WebGLRenderer, the
// whole scene-graph approach) is retired in favor of a flat top-down SVG
// view - see "2d map.md"/"2D Rendering Plan.md" in the Dungeon Generation
// vault folder for why (the 3D angled view never matched how a physical
// dungeon reads at the table) and for the full rollout order this is
// steps 4 (the view itself) and 5 (the export/print action below) of.
// `floor2d.ts`/`floor2dView.ts` are the 3D scene's replacement. The
// `three`/`OrbitControls` npm dependency is dropped as of step 6
// (package.json/esbuild.config.mjs), and the old 3D-only source files
// (`renderFloor.ts`, `rooms.ts`, and their tests) are deleted outright -
// nothing referenced them once step 6 confirmed that.

/**
 * Style for the "Generate Random Map"/"Finalize" overlay buttons - see
 * Dungeon Generation Notes.md's Dungeon Folder Structure section and
 * Simplification Plan.md (2026-07-31). Restyled 2026-09-05 for the new
 * light (Field Print) background - the old dark-panel styling read as
 * illegible/inverted against a white map.
 */
const ACTION_BUTTON_STYLE =
  "padding:4px 10px;font:12px sans-serif;border-radius:4px;border:1px solid #cccccc;" +
  "background:#f5f5f5;color:#222222;cursor:pointer;";

const OVERLAY_STYLE =
  "color:#333333;font:11px sans-serif;background:rgba(255,255,255,0.88);padding:2px 6px;" +
  "border-radius:3px;pointer-events:none;border:1px solid #dddddd;";

const VIEW_TYPE = "dungeon-cartographer";
// A real, single-segment extension - NOT "dungeon.md". Obsidian keys a
// file's extension off the last dot only, so a compound "dungeon.md"
// extension never actually registers with registerExtensions() below;
// the file falls back to the normal markdown editor, which chokes trying
// to syntax-highlight a huge fenced JSON block. A plain ".dungeon" file
// (mirroring how Obsidian's own native Canvas feature uses plain-JSON
// ".canvas" files) fixes this at the root - see dungeonData.ts and
// Dungeon Data Format.md.
const FLOOR_EXTENSION = "dungeon";

/**
 * Door/stair icon legend - the on-screen key for `floor2dView.ts`'s icon
 * language (material/locked/trapped/stuck/secret/stairs). Always shown
 * (resolved 2026-09-05, see "2d map.md") rather than a first-look-only
 * aid, since actual usage is infrequent enough over time that details are
 * easy to forget between sessions. Markup matches the validated
 * comparison-artifact legend exactly (see the session's Cartographer
 * Style Study), just inlined here instead of hand-duplicated.
 */
const LEGEND_ITEMS: { svg: string; label: string }[] = [
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#c9a876" stroke="#6b4a24" stroke-width="1.4"/></svg>',
    label: "Wood door",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#7f8e99" stroke="#333d43" stroke-width="1.4"/></svg>',
    label: "Metal door",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#d8d3c8" stroke="#6b6558" stroke-width="1.4"/></svg>',
    label: "Stone door",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#ffffff" stroke="#cccccc" stroke-width="1.4"/></svg>',
    label: "Archway",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#5f6b74" stroke="#2e363c" stroke-width="1.4"/><line x1="8" y1="7" x2="8" y2="15" stroke="#c9d3da" stroke-width="1"/><line x1="14" y1="7" x2="14" y2="15" stroke="#c9d3da" stroke-width="1"/></svg>',
    label: "Portcullis",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#c9a876" stroke="#6b4a24" stroke-width="1.4"/><circle cx="11" cy="11" r="2.6" fill="#1c1c1c"/></svg>',
    label: "Locked",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#c9a876" stroke="#b23b2e" stroke-width="2.2"/></svg>',
    label: "Trapped",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#c9a876" stroke="#6b4a24" stroke-width="1.4"/><line x1="3" y1="7" x2="19" y2="15" stroke="#4a4a4a" stroke-width="1.3" stroke-linecap="round"/><line x1="19" y1="7" x2="3" y2="15" stroke="#4a4a4a" stroke-width="1.3" stroke-linecap="round"/></svg>',
    label: "Stuck",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111"/><rect x="3" y="7" width="16" height="8" fill="#c9a876" stroke="#6b4a24" stroke-width="1.4"/><text x="11" y="11" font-size="8" font-weight="bold" font-family="sans-serif" text-anchor="middle" dominant-baseline="central" fill="#1c1c1c">S</text></svg>',
    label: "Secret",
  },
  {
    svg: '<svg width="18" height="18" viewBox="0 0 22 22"><rect width="22" height="22" fill="#111111" stroke="#111111"/><line x1="4" y1="6" x2="18" y2="6" stroke="#ffffff" stroke-width="1.6"/><line x1="4" y1="10" x2="18" y2="10" stroke="#ffffff" stroke-width="1.6"/><line x1="4" y1="14" x2="18" y2="14" stroke="#ffffff" stroke-width="1.6"/><line x1="4" y1="18" x2="18" y2="18" stroke="#ffffff" stroke-width="1.6"/></svg>',
    label: "Stairs down",
  },
];

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

class DungeonView extends ItemView {
  private mapView: Floor2DView | null = null;

  private file: TFile | null = null;
  private statusEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  /** The currently displayed floor's parsed data - null while showing the placeholder. */
  private data: DungeonFloorData | null = null;
  /** Guards against overlapping generate/finalize clicks (both are async). */
  private busy = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  /** The `.dungeon` file this pane is showing, if any. */
  floorFile(): TFile | null {
    return this.file;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Dungeon Cartographer";
  }

  getIcon(): string {
    return "map";
  }

  // --- Obsidian state (which file this pane is showing) -------------------

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? "" };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const filePath = (state as { file?: string } | null)?.file;
    if (filePath) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        this.file = file;
        if (this.mapView) await this.loadAndRender();
      }
    }
    return super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.style.cssText = "padding:0;margin:0;width:100%;height:100%;overflow:hidden;position:relative;";

    // --- The SVG map itself, filling the pane ------------------------------
    const mapHost = host.createDiv();
    mapHost.style.cssText = "position:absolute;inset:0;";
    this.mapView = createFloor2DView(mapHost, {
      onOpenEntity: (owner) => void this.openEntityNote(owner),
      onHoverEntity: (owner) => void this.handleHoverEntity(owner),
    });

    // --- Status overlay (room/corridor/door/stair/region counts) ---------
    const statusEl = host.createDiv();
    statusEl.style.cssText = `position:absolute;left:8px;bottom:6px;${OVERLAY_STYLE}`;
    host.appendChild(statusEl);
    this.statusEl = statusEl;

    // --- Door/stair icon legend --------------------------------------------
    // Static - doesn't depend on the loaded floor's data, so built once
    // here rather than rebuilt per render like statusEl/actionsEl. Always
    // shown (see LEGEND_ITEMS' doc comment).
    this.buildLegend(host);

    // --- Action buttons ("Generate Random Map" / "Finalize") --------------
    // Populated per-render by updateActionButtons() - empty (and both
    // buttons hidden) whenever there's no file, or the loaded floor is
    // already finalized.
    const actionsEl = host.createDiv();
    actionsEl.style.cssText = "position:absolute;right:8px;top:8px;display:flex;gap:6px;";
    host.appendChild(actionsEl);
    this.actionsEl = actionsEl;

    // --- Initial content: real floor data if we have a file, else placeholder
    await this.loadAndRender();
  }

  // --- Data loading ---------------------------------------------------------

  private async loadAndRender(): Promise<void> {
    if (!this.mapView) return;

    if (!this.file) {
      this.renderPlaceholder();
      return;
    }

    try {
      const raw = await this.app.vault.read(this.file);
      const data = parseDungeonFloor(raw);
      this.renderFloor(data);
    } catch (e) {
      // Malformed or unreadable file - fall back to the placeholder rather
      // than leaving the view blank, and say so instead of failing silently.
      console.warn("[DungeonCartographer] Could not load floor data, showing placeholder:", e);
      this.renderPlaceholder();
      this.setStatus(`Could not read ${this.file.basename} - showing placeholder`);
    }
  }

  private renderPlaceholder(): void {
    if (!this.mapView) return;
    this.data = null;
    this.updateActionButtons();
    this.mapView.renderPlaceholder("Open a .dungeon file to see its map");
    this.setStatus("No floor loaded");
  }

  private renderFloor(data: DungeonFloorData): void {
    if (!this.mapView) return;
    this.data = data;
    this.updateActionButtons();
    this.mapView.render(data);
    this.setStatus(
      `${data.rooms.length} rooms · ${data.corridors.length} corridors · ` +
        `${data.doors.length} doors · ${data.stairs.length} stairs · ${data.regions.length} regions`
    );
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /**
   * Bottom-right legend explaining `floor2dView.ts`'s door/stair icon
   * language - always visible (see LEGEND_ITEMS' doc comment). Sits at
   * the opposite corner from the room/corridor/door/stair counts
   * (bottom-left, via statusEl) so both read as one bottom status bar.
   */
  private buildLegend(host: HTMLElement): void {
    const legendEl = host.createDiv();
    legendEl.style.cssText =
      `position:absolute;right:8px;bottom:6px;display:flex;gap:8px;align-items:center;` +
      `flex-wrap:wrap;max-width:75%;justify-content:flex-end;${OVERLAY_STYLE}`;
    host.appendChild(legendEl);
    for (const entry of LEGEND_ITEMS) {
      const item = legendEl.createDiv();
      item.style.cssText = "display:flex;align-items:center;gap:3px;";
      const swatch = item.createDiv();
      swatch.innerHTML = entry.svg;
      item.createSpan({ text: entry.label });
    }
  }

  // --- Generate / Finalize -------------------------------------------------
  //
  // A floor's `finalized` flag (see Dungeon Data Format.md) gates these two
  // buttons: both show while `false`, neither shows once `true` - the floor
  // is protected from accidental regeneration through the UI once you're
  // happy with it. Un-finalizing has no UI on purpose; it's a manual edit
  // of the `.dungeon` file's JSON. See Simplification Plan.md (2026-07-31).

  /** Rebuilds the action-button overlay to match the current file/data - empty (both buttons hidden) with no file, or once `finalized` is true. */
  private updateActionButtons(): void {
    if (!this.actionsEl) return;
    this.actionsEl.empty();
    if (!this.file || !this.data) return;

    // Export has no finalized-gate - a draft floor is just as worth
    // printing/sharing as a finished one, unlike Generate (destructive)
    // and Finalize (a one-way lock), which only make sense pre-finalize.
    const exportBtn = this.actionsEl.createEl("button", { text: "Export SVG" });
    exportBtn.style.cssText = ACTION_BUTTON_STYLE;
    exportBtn.disabled = this.busy;
    exportBtn.onclick = () => void this.exportFloorSvg();

    if (this.data.finalized) return;

    const genBtn = this.actionsEl.createEl("button", { text: "Generate Random Map" });
    genBtn.style.cssText = ACTION_BUTTON_STYLE;
    genBtn.disabled = this.busy;
    genBtn.onclick = () => void this.generateRandomMap();

    const finalizeBtn = this.actionsEl.createEl("button", { text: "Finalize" });
    finalizeBtn.style.cssText = ACTION_BUTTON_STYLE;
    finalizeBtn.disabled = this.busy;
    finalizeBtn.onclick = () => void this.finalizeFloor();
  }

  /**
   * The per-floor Setup file's path, name-matched to `file` - `Floor
   * 1.dungeon` pairs with `Floor 1 Setup.md` in the same folder. See
   * Dungeon Generation Notes.md's Dungeon Folder Structure section.
   */
  private setupFilePathFor(file: TFile): string {
    const folder = file.parent && file.parent.path ? `${file.parent.path}/` : "";
    return `${folder}${file.basename} Setup.md`;
  }

  // --- Click-to-open-note & note-backed hover ("Door Notes and Map Hover
  // Plan.md" Part B3, B1.2) -------------------------------------------
  //
  // One resolver, reused by both the `onOpenEntity` click handler and the
  // `onHoverEntity` stage-2 hover handler below - Part B3's whole point.
  // Rooms are the one asymmetry: their notes predate this plan and are
  // name-based (`Room <NN> - <Name>.md`), not id-keyed, so they need a
  // prefix-match against real files rather than a path this can build
  // outright the way `doorNotePathFor`/`corridorNotePathFor` can. Stairs
  // are out of scope for both - `floor2dView.ts`'s `drawStairIcon` has no
  // interactive hit-area yet, so neither callback ever fires with
  // `kind: "stair"` today.

  /**
   * Resolves an entity to its existing note file, or `null` if it doesn't
   * have one yet - never creates anything (compare `openEntityNote`'s
   * corridor branch, the one case that does). Doors/corridors use their
   * deterministic id-keyed path (A2/B3); rooms prefix-match `Room <id>`
   * (zero-padded or not) against real files directly inside the floor's
   * own folder, since room notes live alongside the `.dungeon` file
   * itself, not in an id-keyed subfolder like `Doors/`/`Corridors/`.
   */
  private resolveExistingNoteFile(
    file: TFile,
    owner: { kind: "room" | "corridor" | "door"; id: number }
  ): TFile | null {
    const folder = file.parent && file.parent.path ? `${file.parent.path}/` : "";

    if (owner.kind === "door") {
      const noteFile = this.app.vault.getAbstractFileByPath(doorNotePathFor(folder, file.basename, owner.id));
      return noteFile instanceof TFile ? noteFile : null;
    }

    if (owner.kind === "corridor") {
      const noteFile = this.app.vault.getAbstractFileByPath(corridorNotePathFor(folder, file.basename, owner.id));
      return noteFile instanceof TFile ? noteFile : null;
    }

    // owner.kind === "room"
    if (!(file.parent instanceof TFolder)) return null;
    const pattern = new RegExp(`^Room\s+0*${owner.id}(?:\s|$)`, "i");
    for (const child of file.parent.children) {
      if (child instanceof TFile && pattern.test(child.basename)) return child;
    }
    return null;
  }

  /**
   * Handles a click on a room/door/corridor SVG element (`onOpenEntity`,
   * wired in `onOpen()`). Rooms and doors only ever open an *existing*
   * note - a plain, unflagged door has nothing content-layer to say (Plan
   * A1), and a room with no note yet just means the Room Content pass
   * hasn't reached it, not something this click should paper over.
   * Corridors are the one on-demand case: they have no physical flag to
   * drive automatic generation the way doors do, so the first click both
   * creates a minimal stub note and opens it (Plan B3's "on-demand, not
   * auto-generated" framing).
   */
  private async openEntityNote(owner: { kind: "room" | "corridor" | "door"; id: number }): Promise<void> {
    if (!this.file) return;
    const file = this.file;

    try {
      let noteFile = this.resolveExistingNoteFile(file, owner);

      if (!noteFile && owner.kind === "corridor") {
        const folder = file.parent && file.parent.path ? `${file.parent.path}/` : "";
        const corridorsFolderPath = `${folder}${file.basename}/Corridors`;
        if (!(this.app.vault.getAbstractFileByPath(corridorsFolderPath) instanceof TFolder)) {
          await this.app.vault.createFolder(corridorsFolderPath);
        }
        noteFile = await this.app.vault.create(
          corridorNotePathFor(folder, file.basename, owner.id),
          buildCorridorStubMarkdown(owner.id)
        );
      }

      if (!noteFile) {
        const message =
          owner.kind === "door"
            ? `Door ${owner.id} isn't locked, trapped, or stuck - it has no note.`
            : `No note found for Room ${owner.id} yet - the Room Content pass hasn't reached it.`;
        new Notice(message);
        return;
      }

      await this.app.workspace.getLeaf(true).openFile(noteFile);
    } catch (e) {
      console.error("[DungeonCartographer] Failed to open/create a note for", owner, e);
      new Notice("Couldn't open that note - see console for details.");
    }
  }

  /**
   * Stage-2 hover (Part B1.2): on `onHoverEntity`, resolves whatever note
   * the hovered entity already has (never creates one - hover must stay
   * side-effect-free) and, if it exists, reads it, extracts a short
   * excerpt (`noteHoverExcerpt`), and feeds it to the view so it can
   * append it to the still-showing tooltip - `setHoverNoteExcerpt` itself
   * guards against a stale result arriving after the pointer's moved on.
   * A `null` owner (pointerleave) is a no-op here; the view already hid
   * its own tooltip.
   */
  private async handleHoverEntity(owner: { kind: "room" | "corridor" | "door"; id: number } | null): Promise<void> {
    if (!owner || !this.file || !this.mapView) return;
    const noteFile = this.resolveExistingNoteFile(this.file, owner);
    if (!noteFile) return;

    try {
      const content = await this.app.vault.cachedRead(noteFile);
      this.mapView?.setHoverNoteExcerpt(owner, noteHoverExcerpt(content));
    } catch (e) {
      console.warn("[DungeonCartographer] Could not read note for hover excerpt:", e);
    }
  }

  /** Reads and parses the open file's paired Setup file, falling back to the standard 36x36 default if it's missing or unreadable. */
  private async loadFloorSetup(): Promise<FloorSetup> {
    if (!this.file) return { ...DEFAULT_FLOOR_SETUP };
    const setupFile = this.app.vault.getAbstractFileByPath(this.setupFilePathFor(this.file));
    if (!(setupFile instanceof TFile)) return { ...DEFAULT_FLOOR_SETUP };
    try {
      return parseFloorSetup(await this.app.vault.read(setupFile));
    } catch (e) {
      console.warn("[DungeonCartographer] Could not read floor Setup file, using defaults:", e);
      return { ...DEFAULT_FLOOR_SETUP };
    }
  }

  // --- Door content notes (Locks & Traps Content Plan, Plan step 3) -------
  //
  // Turns a freshly generated floor's flagged (locked/trapped/stuck) doors
  // into real content: a rolled challenge level, DC(s) looked up against
  // the vault's `Lock, Trap & Stuck Door DCs.md` settings file, and a
  // random trap flavor from `Sample Traps.md` - written one note per
  // flagged door to `Floor N/Doors/Door <id>.md`. See "Dungeon Generation/
  // Locks & Traps Content Plan.md" and "Door Notes and Map Hover Plan.md"
  // Part A. The pure roll/lookup/markdown-building logic lives in
  // `doorNotes.ts`; this is just the vault I/O around it.

  /** Reads and parses the vault's live `Lock, Trap & Stuck Door DCs.md` settings file, falling back to `DEFAULT_LOCK_TRAP_RULES` if it's missing or unreadable - same leniency as `loadFloorSetup`. */
  private async loadLockTrapRules(): Promise<LockTrapRules> {
    const file = this.app.vault.getAbstractFileByPath(`${SETTINGS_FOLDER_NAME}/Lock, Trap & Stuck Door DCs.md`);
    if (!(file instanceof TFile)) return DEFAULT_LOCK_TRAP_RULES;
    try {
      return parseLockTrapRules(await this.app.vault.read(file));
    } catch (e) {
      console.warn("[DungeonCartographer] Could not read Lock, Trap & Stuck Door DCs settings file, using defaults:", e);
      return DEFAULT_LOCK_TRAP_RULES;
    }
  }

  /** Reads the vault's live `Sample Traps.md` settings file's raw text - `""` if it's missing or unreadable, which `pickTrapFlavor` treats the same as "no entries" (its own fallback flavor, not a thrown error). */
  private async loadSampleTrapsText(): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(`${SETTINGS_FOLDER_NAME}/Sample Traps.md`);
    if (!(file instanceof TFile)) return "";
    try {
      return await this.app.vault.read(file);
    } catch (e) {
      console.warn("[DungeonCartographer] Could not read Sample Traps settings file:", e);
      return "";
    }
  }

  /**
   * Wipes and rebuilds `Floor N/Doors/` for the just-generated `doors`,
   * writing one note per flagged (locked/trapped/stuck) door - the
   * regeneration story resolved in Plan A4: full wipe/rebuild every time
   * this runs, since it's only ever called from `generateRandomMap()`,
   * itself only reachable while the floor isn't finalized. A floor with no
   * flagged doors at all just ends up with no `Doors/` folder.
   */
  private async syncDoorNotes(file: TFile, floorLevel: number, doors: DungeonDoor[]): Promise<void> {
    const folder = file.parent && file.parent.path ? `${file.parent.path}/` : "";
    const doorsFolderPath = doorsFolderPathFor(folder, file.basename);

    const existingFolder = this.app.vault.getAbstractFileByPath(doorsFolderPath);
    if (existingFolder instanceof TFolder) {
      await this.app.vault.delete(existingFolder, true);
    }

    const flaggedDoors = doors.filter(doorNeedsNote);
    if (flaggedDoors.length === 0) return;

    await this.app.vault.createFolder(doorsFolderPath);

    const rules = await this.loadLockTrapRules();
    const sampleTrapsText = await this.loadSampleTrapsText();
    // A fresh RNG, not the floor's own generation seed - this roll's
    // result is content (Plan A3), not persisted to the `.dungeon` schema,
    // so it has no determinism requirement to share a seed with the
    // physical layout roll (see Locks & Traps Content Plan's Plan step 3
    // open implementation question - resolved here as "separate roll").
    const rng = new Rng(Date.now());

    for (const door of flaggedDoors) {
      const challengeLevel = rollDoorChallengeLevel(rng, floorLevel);
      const trapFlavor = door.trapped ? pickTrapFlavor(rng, sampleTrapsText) : null;
      const lockRoll = door.locked ? rollLockedDoorDC(rules, floorLevel, rng) : null;
      const content = buildDoorNoteMarkdown({
        door,
        floorBasename: file.basename,
        challengeLevel,
        floorLevel,
        rules,
        trapFlavor,
        lockRoll,
      });
      await this.app.vault.create(doorNotePathFor(folder, file.basename, door.id), content);
    }
  }

  /**
   * "Generate Random Map": confirms, then erases the currently open floor
   * and generates a fresh one in its place - same file, same schema. Only
   * ever called while `updateActionButtons()` would show the button, i.e.
   * the floor isn't finalized, but re-checked here too since a click can
   * be in flight when state changes underneath it.
   */
  private async generateRandomMap(): Promise<void> {
    if (!this.file || this.busy || this.data?.finalized) return;

    const confirmed = window.confirm(
      `Generate a new random map for "${this.file.basename}"? This replaces the current map and can't be undone.`
    );
    if (!confirmed) return;

    this.busy = true;
    try {
      const file = this.file;
      const setup = await this.loadFloorSetup();
      const config = configFromFloorSetup(setup, { seed: Date.now() });
      const data = generateFloor(config);
      await this.writeFloorData(data);
      try {
        await this.syncDoorNotes(file, setup.level, data.doors);
      } catch (e) {
        console.error("[DungeonCartographer] Failed to generate door notes:", e);
        new Notice("Map generated, but door notes failed - see console for details.");
      }
      new Notice(`Generated a new random map for "${file.basename}".`);
    } catch (e) {
      console.error("[DungeonCartographer] Failed to generate a random map:", e);
      new Notice("Failed to generate a random map - see console for details.");
    } finally {
      this.busy = false;
      // `writeFloorData()` above already rebuilt the buttons once (via
      // `loadAndRender()` -> `renderFloor()`), but that happened while
      // `busy` was still `true`, so they were (re)created with
      // `disabled = true` and stayed that way forever - the whole reason
      // "Generate Random Map" only ever worked once per view instance
      // (2026-07-31 bugfix). Rebuild them again now that `busy` is back
      // to `false` so they're actually clickable again.
      this.updateActionButtons();
    }
  }

  /** "Finalize": flips `finalized` to `true` and saves - no regeneration, just locks the floor in. */
  private async finalizeFloor(): Promise<void> {
    if (!this.file || !this.data || this.busy || this.data.finalized) return;

    this.busy = true;
    try {
      await this.writeFloorData({ ...this.data, finalized: true });
      new Notice(`"${this.file.basename}" marked finalized.`);
    } catch (e) {
      console.error("[DungeonCartographer] Failed to finalize floor:", e);
      new Notice("Failed to finalize - see console for details.");
    } finally {
      this.busy = false;
      // Same reasoning as generateRandomMap() above - re-sync the button
      // disabled state now that `busy` is false again. Usually a no-op
      // here since finalizing hides both buttons for good, but if the
      // write itself failed (finalized never actually flipped), this is
      // what lets the buttons become clickable again instead of staying
      // stuck disabled.
      this.updateActionButtons();
    }
  }

  /** Writes `data` to the open file as the standard pretty-printed `.dungeon` JSON, then reloads/re-renders from it. */
  private async writeFloorData(data: DungeonFloorData): Promise<void> {
    if (!this.file) return;
    const json = JSON.stringify(data, null, 2) + "\n";
    await this.app.vault.modify(this.file, json);
    await this.loadAndRender();
  }

  // --- Export/print (rollout step 5) ---------------------------------------
  //
  // "2D Rendering Plan.md" left the export *file format* an open,
  // non-blocking question: raw SVG (print straight from a browser, or let
  // the OS turn it into a PDF) versus the plugin also rendering a PNG/PDF
  // directly. Raw SVG is what's implemented - it's the format the in-app
  // view already draws, so exporting it needs no rasterizer of its own,
  // and it opens directly in Obsidian's own SVG viewer too. A PNG/PDF
  // export can be layered on top of `renderFloorToSvgString()` later if
  // it turns out to be needed.

  /** The export SVG's file path, name-matched to `file` - `Floor 1.dungeon` exports to `Floor 1.svg` in the same folder. */
  private exportFilePathFor(file: TFile): string {
    const folder = file.parent && file.parent.path ? `${file.parent.path}/` : "";
    return `${folder}${file.basename}.svg`;
  }

  /** "Export SVG": serializes the currently loaded floor to a standalone SVG file (map + always-on legend + status line), writing over any previous export at the same path. */
  private async exportFloorSvg(): Promise<void> {
    if (!this.file || !this.data || this.busy) return;

    this.busy = true;
    this.updateActionButtons();
    try {
      const statusText =
        `${this.data.rooms.length} rooms \u00b7 ${this.data.corridors.length} corridors \u00b7 ` +
        `${this.data.doors.length} doors \u00b7 ${this.data.stairs.length} stairs \u00b7 ${this.data.regions.length} regions`;
      const svgMarkup = renderFloorToSvgString(this.data, {
        legend: LEGEND_ITEMS,
        statusText,
        title: this.file.basename,
      });
      const exportPath = this.exportFilePathFor(this.file);
      const existing = this.app.vault.getAbstractFileByPath(exportPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, svgMarkup);
      } else {
        await this.app.vault.create(exportPath, svgMarkup);
      }
      new Notice(`Exported map to "${exportPath}".`);
    } catch (e) {
      console.error("[DungeonCartographer] Failed to export map:", e);
      new Notice("Failed to export map - see console for details.");
    } finally {
      this.busy = false;
      this.updateActionButtons();
    }
  }

  async onClose(): Promise<void> {
    this.mapView?.destroy();
    this.mapView = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class DungeonCartographerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new DungeonView(leaf));
    // Because FLOOR_EXTENSION is a real, single-segment extension, this
    // actually works: Obsidian opens .dungeon files directly in this view
    // and never runs the markdown editor on them. (No file-open listener
    // needed as a workaround, unlike the old .dungeon.md attempt.)
    this.registerExtensions([FLOOR_EXTENSION], VIEW_TYPE);

    this.addCommand({
      id: "open-dungeon-cartographer",
      name: "Open Dungeon Cartographer",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "reset-settings-to-defaults",
      name: "Reset Settings to Defaults",
      callback: () => this.resetSettingsToDefaults(),
    });

    this.addCommand({
      id: "generate-encounters-and-traps",
      name: "Generate Encounters & Traps (for the open floor or Setup file)",
      checkCallback: (checking: boolean) => {
        const setupPath = this.activeSetupPath();
        if (!setupPath) return false;
        if (!checking) void this.generateEncountersAndTraps(setupPath);
        return true;
      },
    });

    this.addRibbonIcon("map", "Open Dungeon Cartographer", () => this.activateView());
  }

  // --- Encounters & traps (Dungeon Setup.md) -------------------------------
  //
  // Works off whichever floor is active: a `Floor N Setup.md` note, a
  // `Floor N.dungeon` file, or an open Dungeon Cartographer view. Writes
  // `Floor N Encounters.md` next to the Setup file, overwriting any earlier
  // run - see encounters.ts for the rules and the defaults chosen for the
  // design's open questions.

  /** The Setup file path for the active floor, or null when nothing floor-like is active. */
  private activeSetupPath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(DungeonView);
    const file = view?.floorFile() ?? this.app.workspace.getActiveFile();
    if (!file) return null;
    const folder = file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    if (file.extension === FLOOR_EXTENSION) return `${folder}${file.basename} Setup.md`;
    if (file.extension === "md" && / Setup$/.test(file.basename)) return file.path;
    return null;
  }

  private async readVaultText(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
      return await this.app.vault.read(file);
    } catch (e) {
      console.warn(`[DungeonCartographer] Could not read ${path}:`, e);
      return null;
    }
  }

  /** name -> CR for every monster note, and the dungeon-suitable subset used for random picks. */
  private loadMonsters(): { crByName: Map<string, number | null>; pool: PoolMonster[] } {
    const crByName = new Map<string, number | null>();
    const pool: PoolMonster[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${MONSTER_FOLDER}/`)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const cr = parseCR(fm["Challenge_Rating"]);
      crByName.set(file.basename, cr);
      if (cr === null) continue;
      const terrain = fm["terrain_hex"];
      const terrains = (Array.isArray(terrain) ? terrain : [terrain]).map((t) => String(t ?? "").toLowerCase().trim());
      if (terrains.some((t) => DUNGEON_TERRAINS.includes(t))) pool.push({ name: file.basename, cr });
    }
    return { crByName, pool };
  }

  /**
   * The treasure tables: every `Dungeon Cartographer Settings/Treasure/*.md`
   * in the vault, with the plugin's bundled copy standing in for any file
   * the vault doesn't have (so treasure works before "Reset Settings to
   * Defaults" has ever been run).
   */
  private async loadTreasureTables(): Promise<TreasureTables> {
    const tables: TreasureTables = new Map();
    for (const [fileName, bundled] of Object.entries(TREASURE_DEFAULT_FILES)) {
      const text = await this.readVaultText(`${SETTINGS_FOLDER_NAME}/${TREASURE_FOLDER_NAME}/${fileName}`);
      parseTreasureFile(fileName.replace(/\.md$/, ""), text ?? bundled, tables);
    }
    return tables;
  }

  private async generateEncountersAndTraps(setupPath: string): Promise<void> {
    try {
      const setupText = await this.readVaultText(setupPath);
      if (setupText === null) {
        new Notice(`No Setup file at "${setupPath}" - create it first (Grid Size, Level, Factions).`);
        return;
      }
      const floorSetup = parseFloorSetup(setupText);
      const encounterSetup = parseEncounterSetup(setupText);
      const extraFlags: string[] = [];

      let factionNames = encounterSetup.factions;
      if (factionNames.length > MAX_FACTIONS) {
        extraFlags.push(`More than ${MAX_FACTIONS} factions listed - only the first ${MAX_FACTIONS} were used.`);
        factionNames = factionNames.slice(0, MAX_FACTIONS);
      }
      const factions: Faction[] = [];
      for (const name of factionNames) {
        // The vault's copy wins; the plugin's bundled copy stands in for a
        // shipped faction the vault doesn't have (before "Reset Settings to
        // Defaults" has ever been run).
        const text = (await this.readVaultText(`${FACTIONS_FOLDER}/${name}.md`)) ?? FACTION_DEFAULT_FILES[`${name}.md`] ?? null;
        if (text === null) {
          extraFlags.push(`No faction file "${FACTIONS_FOLDER}/${name}.md" - its slot went to a random monster.`);
          continue;
        }
        const faction = parseFactionFile(name, text);
        if (faction.encounters.length === 0) {
          extraFlags.push(`"${name}" has no Encounters table rows - its slot went to a random monster.`);
          continue;
        }
        factions.push(faction);
      }

      const { crByName, pool } = this.loadMonsters();
      if (pool.length === 0) extraFlags.push(`No monsters found under "${MONSTER_FOLDER}" - every random slot is a placeholder.`);
      const preselected = encounterSetup.preselected.map((name) => ({ name, cr: crByName.get(name) ?? null }));
      const traps = parseTrapsByCR((await this.readVaultText(`${SETTINGS_FOLDER_NAME}/Sample Traps.md`)) ?? "");

      const seed = encounterSetup.seed ?? Date.now() % 1_000_000_000;
      const rng = new Rng(seed);
      const result = generateEncounters({
        level: floorSetup.level,
        factions,
        preselected,
        pool,
        traps,
        rng,
      });
      result.flags.unshift(...extraFlags);

      // One treasure per encounter (traps included), at the encounter's own EL.
      const treasureTables = await this.loadTreasureTables();
      const treasure = rollFloorTreasure(treasureTables, result.encounters.map((e) => e.el), rng);
      result.flags.push(...treasure.flags);
      const treasureSection = buildTreasureMarkdown(
        treasure,
        result.encounters.map((e) => e.id),
        readTreasureSettings(treasureTables)
      );

      const floorBasename = setupPath.replace(/^.*\//, "").replace(/ Setup\.md$/, "");
      const folder = setupPath.includes("/") ? setupPath.slice(0, setupPath.lastIndexOf("/") + 1) : "";
      const outPath = `${folder}${floorBasename} Encounters.md`;
      const markdown = buildEncounterNoteMarkdown({
        floorBasename,
        level: floorSetup.level,
        factionNames: factions.map((f) => f.name),
        seed,
        generatedOn: new Date().toISOString().slice(0, 10),
        result,
        extraSections: treasureSection,
      });

      const existing = this.app.vault.getAbstractFileByPath(outPath);
      if (existing instanceof TFile) await this.app.vault.modify(existing, markdown);
      else await this.app.vault.create(outPath, markdown);
      await this.app.workspace.openLinkText(outPath, "", true);
      new Notice(
        `Generated encounters for "${floorBasename}"` +
          (result.flags.length > 0 ? ` - ${result.flags.length} flag${result.flags.length === 1 ? "" : "s"} to review.` : ".")
      );
    } catch (e) {
      console.error("[DungeonCartographer] Failed to generate encounters:", e);
      new Notice("Failed to generate encounters - see console for details.");
    }
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /**
   * Overwrites every file in the vault's `Dungeon Cartographer Settings/`
   * folder with the plugin's shipped default, creating the folder first
   * if needed - see `settingsSync.ts` and "Dungeon Cartographer Settings
   * Plan.md". No confirmation prompt and no backup by design (decided
   * 2026-09-18): this is the "start over" command, and anything hand-
   * edited there needs to be backed up (git/sync history) beforehand.
   */
  private async resetSettingsToDefaults(): Promise<void> {
    try {
      const copied = await copySettingsDefaults(this.app.vault.adapter, SETTINGS_DEFAULT_FILES);
      new Notice(`Dungeon Cartographer: reset ${copied.length} settings file${copied.length === 1 ? "" : "s"} to defaults.`);
    } catch (err) {
      console.error(err);
      new Notice("Dungeon Cartographer: failed to reset settings - see console for details.");
    }
  }

  /**
   * Opens (or reveals) the Dungeon Cartographer view. If a .dungeon file
   * is currently active elsewhere in the workspace, show that file's data
   * instead of an empty placeholder - this is what makes the ribbon
   * icon/command useful when you already have a floor open.
   */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const activeFile = workspace.getActiveFile();
    const activeIsDungeonFile = activeFile?.path.endsWith(`.${FLOOR_EXTENSION}`) ?? false;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    const isNewLeaf = !leaf;
    if (!leaf) leaf = workspace.getLeaf("split");

    // Only touch view state if this is a fresh leaf, or the active file is
    // actually a dungeon floor - otherwise just reveal whatever the
    // existing pane was already showing rather than clobbering it.
    if (isNewLeaf || activeIsDungeonFile) {
      await leaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state: activeIsDungeonFile ? { file: activeFile!.path } : undefined,
      });
    }
    workspace.revealLeaf(leaf);
  }
}
