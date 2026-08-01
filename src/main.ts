import { ItemView, Notice, Plugin, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLACEHOLDER_ROOMS, roomCenter } from "./rooms";
import { parseDungeonFloor, type DungeonFloorData } from "./dungeonData";
import { floorToRenderSpecs, DOOR_LEGEND, type PlaneSpec, type WallSpec } from "./renderFloor";
import { generateFloor, configFromFloorSetup } from "./generate";
import { parseFloorSetup, DEFAULT_FLOOR_SETUP, type FloorSetup } from "./floorSetup";

/**
 * Style for the "Generate Random Map"/"Finalize" overlay buttons - see
 * Dungeon Generation Notes.md's Dungeon Folder Structure section and
 * Simplification Plan.md (2026-07-31).
 */
const ACTION_BUTTON_STYLE =
  "padding:4px 10px;font:12px sans-serif;border-radius:4px;border:1px solid #444466;" +
  "background:#2a2a3a;color:#e0e0f0;cursor:pointer;";

/** Line color for the top-down ceiling grid overlay - see buildCeilingGridMesh(). */
const CEILING_WIRE_COLOR = 0x8888aa;
/** Vertical offset (grid units) of the ceiling grid overlay above the solid ceiling plane - see buildCeilingGridMesh(). */
const CEILING_GRID_EPSILON = 0.01;

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

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

class DungeonView extends ItemView {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frameHandle = 0;

  private file: TFile | null = null;
  private floorGroup: THREE.Group | null = null;
  private gridHelper: THREE.GridHelper | null = null;
  private statusEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private gridTexture: THREE.CanvasTexture | null = null;
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
        if (this.scene) await this.loadAndRender();
      }
    }
    return super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.style.cssText =
      "padding:0;margin:0;width:100%;height:100%;overflow:hidden;position:relative;";

    const width = host.clientWidth || 800;
    const height = host.clientHeight || 600;

    // --- Renderer ---------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, false);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%;";
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    // --- Scene ------------------------------------------------------------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a24);
    this.scene = scene;

    // --- Camera -----------------------------------------------------------
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(8, 8, 12);
    camera.lookAt(0, 0, 0);
    this.camera = camera;

    // --- Controls ---------------------------------------------------------
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    this.controls = controls;

    // --- Lighting ---------------------------------------------------------
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const directional = new THREE.DirectionalLight(0xffffff, 0.9);
    directional.position.set(5, 10, 7);
    scene.add(directional);

    // --- Status overlay -----------------------------------------------------
    const statusEl = host.createDiv();
    statusEl.style.cssText =
      "position:absolute;left:8px;bottom:6px;color:#9a9aad;font:11px sans-serif;" +
      "background:rgba(20,20,30,0.6);padding:2px 6px;border-radius:3px;pointer-events:none;";
    host.appendChild(statusEl);
    this.statusEl = statusEl;

    // --- Door-color legend --------------------------------------------------
    // Static - doesn't depend on the loaded floor's data, so built once
    // here rather than rebuilt per render like statusEl/actionsEl. Sits
    // across the bottom next to the room/corridor/door/stair counts.
    this.buildDoorLegend(host);

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

    // --- Resize handling --------------------------------------------------
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(host);

    // --- Render loop ------------------------------------------------------
    const animate = () => {
      this.frameHandle = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
  }

  // --- Data loading ---------------------------------------------------------

  private async loadAndRender(): Promise<void> {
    if (!this.scene) return;

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
    if (!this.scene) return;
    this.disposeFloorGroup();
    this.data = null;
    this.updateActionButtons();

    const group = new THREE.Group();
    for (const room of PLACEHOLDER_ROOMS) {
      const geometry = new THREE.BoxGeometry(...room.size);
      const material = new THREE.MeshStandardMaterial({
        color: room.color,
        roughness: 0.7,
        metalness: 0.05,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...roomCenter(room));
      group.add(mesh);
    }
    this.scene.add(group);
    this.floorGroup = group;

    this.setGridHelper(20);
    this.frameCamera(20, 20, 6);
    this.setStatus("Placeholder rooms - open a .dungeon file to see real data");
  }

  private renderFloor(data: DungeonFloorData): void {
    if (!this.scene) return;
    this.disposeFloorGroup();
    this.data = data;
    this.updateActionButtons();
    if (!this.gridTexture) this.gridTexture = createGridTexture();

    const { walls, floors, ceilings, markers } = floorToRenderSpecs(data);
    const group = new THREE.Group();

    for (const wall of walls) {
      group.add(this.buildWallMesh(wall));
    }

    for (const floor of floors) {
      group.add(this.buildPlaneMesh(floor, this.gridTexture));
    }
    for (const ceiling of ceilings) {
      group.add(this.buildCeilingGridMesh(ceiling));
    }

    for (const marker of markers) {
      const geometry = new THREE.BoxGeometry(...marker.size);
      const material = new THREE.MeshStandardMaterial({
        color: marker.color,
        roughness: 0.7,
        metalness: 0.05,
        transparent: marker.opacity !== undefined && marker.opacity < 1,
        opacity: marker.opacity ?? 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...marker.center);
      group.add(mesh);
    }

    this.scene.add(group);
    this.floorGroup = group;

    const gridW = data.grid.width || 20;
    const gridD = data.grid.depth || 20;
    const gridH = data.grid.height || 6;
    this.setGridHelper(Math.max(gridW, gridD));
    this.frameCamera(gridW, gridD, gridH);
    this.setStatus(
      `${data.rooms.length} rooms · ${data.corridors.length} corridors · ` +
        `${data.doors.length} doors · ${data.stairs.length} stairs · ${data.regions.length} regions`
    );
  }

  /**
   * A full grid-cube wall block (Block Walls Plan.md step 4, 2026-07-31 -
   * was a thin 0.15-unit panel before), grid-textured like the floor/
   * ceiling so distances read consistently everywhere. BoxGeometry shares
   * one material across all 6 faces; the repeat below is scaled for the
   * two faces that actually face into a room (the wall's footprint side x
   * height) - the other 1x1 side/top faces get the same repeat, which
   * won't always tile perfectly against a neighboring block's texture, but
   * isn't worth a second material just for that.
   */
  private buildWallMesh(spec: WallSpec): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...spec.size);

    let map: THREE.Texture | undefined;
    if (this.gridTexture) {
      const length = Math.max(spec.size[0], spec.size[2]);
      const height = spec.size[1];
      map = this.gridTexture.clone();
      map.repeat.set(length, height);
      map.needsUpdate = true;
    }

    const material = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.8,
      metalness: 0.05,
      map,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...spec.center);
    return mesh;
  }

  /**
   * A floor plane. Only floors call this now - as of 2026-07-31, ceilings
   * no longer get a solid plane at all (see buildCeilingGridMesh() below),
   * so the one-sided/backface-culling trick this used to need (visible
   * from one direction only, so a top-down camera could see through
   * ceilings and an under-the-map camera couldn't see floors from behind)
   * is gone too - the floor is just always visible, from any angle.
   */
  private buildPlaneMesh(spec: PlaneSpec, gridTexture: THREE.CanvasTexture | null): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(spec.size[0], spec.size[1]);
    // Default plane normal is +Z; rotating -90 deg around X points it +Y (up).
    geometry.rotateX(spec.facing === "up" ? -Math.PI / 2 : Math.PI / 2);

    let map: THREE.Texture | null = null;
    if (gridTexture) {
      map = gridTexture.clone();
      map.repeat.set(spec.size[0], spec.size[1]);
      map.needsUpdate = true;
    }

    const material = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.85,
      metalness: 0.02,
      map: map ?? undefined,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...spec.center);
    return mesh;
  }

  /**
   * A unit-grid line overlay marking where a ceiling is, so a top-down
   * view shows room outlines instead of nothing at all - added
   * 2026-07-31. As of the same day, this is the *only* ceiling geometry -
   * no solid plane is drawn any more (see buildPlaneMesh() above, and its
   * dropped `kind === "ceiling"` branch), so the grid is visible from
   * both above and below alike; there's nothing left to occlude it from
   * underneath, and nothing left to hide it from above either.
   *
   * Built from real horizontal/vertical unit lines only (no diagonals)
   * via `LineSegments`, matching the floor's grid texture - an earlier
   * cut used a wireframed `PlaneGeometry`, whose 1-segment wireframe
   * includes its diagonal, drawing one big distracting X across every
   * room instead of a grid. `CEILING_GRID_EPSILON` nudges this mesh
   * slightly off the room's true ceiling height purely to avoid
   * coplanar z-fighting with any other geometry that might sit at
   * exactly that height; `depthWrite: false` keeps neighboring rooms'
   * grid lines from fighting each other in the depth buffer.
   */
  private buildCeilingGridMesh(spec: PlaneSpec): THREE.LineSegments {
    const [width, depth] = spec.size;
    const halfW = width / 2;
    const halfD = depth / 2;
    const stepsW = Math.max(1, Math.round(width));
    const stepsD = Math.max(1, Math.round(depth));

    const points: number[] = [];
    for (let i = 0; i <= stepsW; i++) {
      const x = -halfW + i;
      points.push(x, 0, -halfD, x, 0, halfD);
    }
    for (let j = 0; j <= stepsD; j++) {
      const z = -halfD + j;
      points.push(-halfW, 0, z, halfW, 0, z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));

    const material = new THREE.LineBasicMaterial({
      color: CEILING_WIRE_COLOR,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const mesh = new THREE.LineSegments(geometry, material);
    mesh.position.set(spec.center[0], spec.center[1] + CEILING_GRID_EPSILON, spec.center[2]);
    return mesh;
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /**
   * Bottom-right legend explaining `DOOR_LEGEND`'s colors (wood/metal/
   * stone/secret) - added 2026-07-31 so the door coloring in
   * `doorColor()` is actually explained on screen instead of memorized.
   * Sits at the opposite corner from the room/corridor/door/stair counts
   * (bottom-left, via statusEl) so both read as one bottom status bar.
   */
  private buildDoorLegend(host: HTMLElement): void {
    const legendEl = host.createDiv();
    legendEl.style.cssText =
      "position:absolute;right:8px;bottom:6px;display:flex;gap:10px;align-items:center;" +
      "color:#c8c8da;font:11px sans-serif;background:rgba(20,20,30,0.6);padding:2px 6px;" +
      "border-radius:3px;pointer-events:none;";
    for (const entry of DOOR_LEGEND) {
      const item = legendEl.createDiv();
      item.style.cssText = "display:flex;align-items:center;gap:4px;";
      const swatch = item.createDiv();
      const hex = "#" + entry.color.toString(16).padStart(6, "0");
      swatch.style.cssText = `width:10px;height:10px;border-radius:2px;background:${hex};`;
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
    if (!this.file || !this.data || this.data.finalized) return;

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
      const setup = await this.loadFloorSetup();
      const config = configFromFloorSetup(setup, { seed: Date.now() });
      const data = generateFloor(config);
      await this.writeFloorData(data);
      new Notice(`Generated a new random map for "${this.file.basename}".`);
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

  // --- Scene bookkeeping ------------------------------------------------

  private disposeFloorGroup(): void {
    if (!this.floorGroup || !this.scene) return;
    this.floorGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        disposeMaterial(obj.material);
      }
    });
    this.scene.remove(this.floorGroup);
    this.floorGroup = null;
  }

  private setGridHelper(span: number): void {
    if (!this.scene) return;
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.dispose();
      this.gridHelper = null;
    }
    const divisions = Math.max(1, Math.round(span));
    const helper = new THREE.GridHelper(span, divisions, 0x444466, 0x2a2a3a);
    helper.position.set(span / 2, 0, span / 2);
    this.scene.add(helper);
    this.gridHelper = helper;
  }

  /**
   * Point the camera at the footprint's centre, backed off enough to see
   * it all. World Y now equals dungeon z directly (no render-only vertical
   * offset - see renderFloor.ts) - the grid helper (the tabletop
   * reference) at y=0 IS the grid's own true floor, so framing just needs
   * the real grid height, no extra shift.
   */
  private frameCamera(gridW: number, gridD: number, gridH: number): void {
    if (!this.camera || !this.controls) return;
    const maxSpan = Math.max(gridW, gridD, 1);
    const target = new THREE.Vector3(gridW / 2, gridH / 2, gridD / 2);
    this.camera.position.set(
      gridW / 2 + maxSpan * 0.6,
      gridH * 1.5 + maxSpan * 0.5,
      gridD / 2 + maxSpan * 0.9
    );
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    this.controls.update();
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) return;
    const host = this.contentEl;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  async onClose(): Promise<void> {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;

    this.disposeFloorGroup();
    this.gridHelper?.dispose();
    this.gridHelper = null;
    this.gridTexture?.dispose();
    this.gridTexture = null;

    // Release GPU resources for anything else left in the scene.
    this.scene?.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        disposeMaterial(obj.material);
      }
    });
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}

/** Disposes a mesh's material(s) and any texture maps on them (grid
 * texture clones), so repeated re-renders don't leak GPU resources. */
function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material];
  for (const m of materials) {
    if (m instanceof THREE.MeshStandardMaterial) {
      m.map?.dispose();
    }
    m.dispose();
  }
}

/** A simple 1-unit grid-line tile, cloned and repeat-scaled per plane so
 * each square lines up exactly with a 5' grid cube. White background lets
 * the plane's own material colour multiply through unaffected; the border
 * shows as a slightly darker line. */
function createGridTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "#00000055";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
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

    this.addRibbonIcon("map", "Open Dungeon Cartographer", () => this.activateView());
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
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
