// @ts-nocheck
import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { DungeonFloorData, DungeonRoom, DungeonCorridor, DungeonDoor, DungeonStairs, DEFAULT_FLOOR_DATA } from './types';
import { buildCorridorPolygon, applyPolygonPath } from './geometry';

export const VIEW_TYPE = 'dungeon-cartographer';

// Colors
const BG_COLOR         = '#111';
const GRID_COLOR       = '#333';
const ROOM_FILL        = '#1a1a2e';
const ROOM_FILL_HOVER  = '#2a2a4e';
const ROOM_STROKE      = '#7a6f5a';
const ROOM_STROKE_HOV  = '#c8b89a';
const CORRIDOR_FILL    = '#1a1a2e';
const CORRIDOR_STROKE  = '#7a6f5a';
const LABEL_COLOR      = '#c8b89a';
const STAIRS_UP_COLOR  = '#a0d0ff';
const STAIRS_DN_COLOR  = '#ffb080';

const DOOR_COLORS: Record<string, string> = {
	open:   '#c8b89a',
	locked: '#e08030',
	secret: '#6a6a8a',
	barred: '#c04040',
};

const ROOM_STROKE_W    = 2;
const CLICK_THRESHOLD  = 5; // px

// What the mouse is hovering — unified so we can open notes for any element
type HoveredElement =
	| { kind: 'room';     item: DungeonRoom }
	| { kind: 'corridor'; item: DungeonCorridor }
	| { kind: 'door';     item: DungeonDoor }
	| { kind: 'stairs';   item: DungeonStairs }
	| null;

export class DungeonCartographerView extends ItemView {
	file: TFile | null;
	data: DungeonFloorData;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;

	isPanning: boolean;
	panStart: { x: number; y: number };
	mouseDownPos: { x: number; y: number };
	hovered: HoveredElement;
	saveTimeout: ReturnType<typeof setTimeout> | null;
	resizeObserver: ResizeObserver | null;
	noteLeaf: any;

	constructor(leaf: WorkspaceLeaf, plugin: any) {
		super(leaf);
		this.plugin = plugin;
		this.file = null;
		this.data = { ...DEFAULT_FLOOR_DATA };
		this.isPanning = false;
		this.panStart = { x: 0, y: 0 };
		this.mouseDownPos = { x: 0, y: 0 };
		this.hovered = null;
		this.saveTimeout = null;
		this.resizeObserver = null;
		this.noteLeaf = null;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return this.file ? this.file.basename : 'Dungeon'; }
	getIcon() { return 'map'; }

	async onload() {
		this.contentEl.style.cssText = 'padding:0;overflow:hidden;background:#111;';

		this.canvas = this.contentEl.createEl('canvas');
		this.canvas.style.cssText = 'display:block;cursor:grab;';
		this.ctx = this.canvas.getContext('2d')!;

		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this.contentEl);

		this.registerDomEvent(this.canvas, 'mousedown', (e: MouseEvent) => {
			if (e.button === 0) {
				this.isPanning = true;
				this.mouseDownPos = { x: e.clientX, y: e.clientY };
				this.panStart = { x: e.clientX - this.data.offX, y: e.clientY - this.data.offY };
				this.canvas.style.cursor = 'grabbing';
				e.preventDefault();
			}
		});

		this.registerDomEvent(this.canvas, 'mousemove', (e: MouseEvent) => {
			if (this.isPanning) {
				this.data.offX = e.clientX - this.panStart.x;
				this.data.offY = e.clientY - this.panStart.y;
				this.render();
				return;
			}
			const gp = this.canvasToGrid(this.clientToCanvas(e.clientX, e.clientY));
			const hit = this.hitTest(gp.x, gp.y);
			const hitItem = hit?.item ?? null;
			const prevItem = this.hovered?.item ?? null;
			if (hitItem !== prevItem) {
				this.hovered = hit;
				this.canvas.style.cursor = hit ? 'pointer' : 'grab';
				this.render();
			}
		});

		this.registerDomEvent(this.canvas, 'mouseup', (e: MouseEvent) => {
			if (!this.isPanning) return;
			this.isPanning = false;
			this.canvas.style.cursor = this.hovered ? 'pointer' : 'grab';

			const dx = e.clientX - this.mouseDownPos.x;
			const dy = e.clientY - this.mouseDownPos.y;
			if (Math.sqrt(dx * dx + dy * dy) < CLICK_THRESHOLD) {
				const gp = this.canvasToGrid(this.clientToCanvas(e.clientX, e.clientY));
				const hit = this.hitTest(gp.x, gp.y);
				if (hit) this.openNoteFor(hit);
			}
		});

		this.registerDomEvent(this.canvas, 'mouseleave', () => {
			this.isPanning = false;
			this.hovered = null;
			this.canvas.style.cursor = 'grab';
			this.render();
		});

		this.registerDomEvent(this.canvas, 'wheel', (e: WheelEvent) => {
			e.preventDefault();
			const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
			const rect = this.canvas.getBoundingClientRect();
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;
			this.data.offX = mouseX - (mouseX - this.data.offX) * zoomFactor;
			this.data.offY = mouseY - (mouseY - this.data.offY) * zoomFactor;
			this.data.zoom = Math.max(0.2, Math.min(5, this.data.zoom * zoomFactor));
			this.render();
		}, { passive: false });

		this.registerDomEvent(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
		this.registerDomEvent(this.canvas, 'dblclick', () => this.centerGrid());

		await this.loadFile();
		this.resizeCanvas();
	}

	// ── Coordinate helpers ──────────────────────────────────────────────────

	clientToCanvas(cx: number, cy: number) {
		const r = this.canvas.getBoundingClientRect();
		return { x: cx - r.left, y: cy - r.top };
	}

	canvasToGrid(p: { x: number; y: number }) {
		const cs = this.data.cellSize * this.data.zoom;
		return { x: (p.x - this.data.offX) / cs, y: (p.y - this.data.offY) / cs };
	}

	// ── Hit testing ─────────────────────────────────────────────────────────

	hitTest(gx: number, gy: number): HoveredElement {
		// Doors first — they're small and sit on top
		for (const door of this.data.doors) {
			if (this.doorHit(door, gx, gy)) return { kind: 'door', item: door };
		}
		// Stairs
		for (const s of this.data.stairs) {
			const isNS = s.orientation === 'n' || s.orientation === 's';
			const bw = isNS ? (s.width ?? 2) : (s.depth ?? 2);
			const bh = isNS ? (s.depth ?? 2) : (s.width ?? 2);
			if (gx >= s.x && gx < s.x + bw && gy >= s.y && gy < s.y + bh)
				return { kind: 'stairs', item: s };
		}
		// Rooms
		for (const room of this.data.rooms) {
			if (gx >= room.x && gx < room.x + room.w && gy >= room.y && gy < room.y + room.h)
				return { kind: 'room', item: room };
		}
		// Corridors — point-in-polygon using the same polygon we render
		for (const corridor of this.data.corridors) {
			if (corridor.waypoints.length < 2) continue;
			const cs = this.data.cellSize * this.data.zoom;
			const poly = buildCorridorPolygon(corridor.waypoints, corridor.width / 2, cs, this.data.offX, this.data.offY);
			const px = this.data.offX + gx * cs;
			const py = this.data.offY + gy * cs;
			if (pointInPolygon(px, py, poly)) return { kind: 'corridor', item: corridor };
		}
		return null;
	}

	doorHit(door: DungeonDoor, gx: number, gy: number): boolean {
		const halfSpan  = (door.width * 0.8) / 2;
		const halfThick = 0.3;
		const hw = door.orientation === 'h' ? halfSpan  : halfThick;
		const hh = door.orientation === 'h' ? halfThick : halfSpan;
		return gx >= door.x - hw && gx <= door.x + hw && gy >= door.y - hh && gy <= door.y + hh;
	}

	// ── Note opening ────────────────────────────────────────────────────────

	async openNoteFor(hit: NonNullable<HoveredElement>) {
		switch (hit.kind) {
			case 'room':     return this.openNote(hit.item, 'room',     this.defaultRoomContent(hit.item));
			case 'corridor': return this.openNote(hit.item, 'corridor', this.defaultCorridorContent(hit.item));
			case 'door':     return this.openNote(hit.item, 'door',     this.defaultDoorContent(hit.item));
			case 'stairs':   return this.openLinkedFloor(hit.item);
		}
	}

	async openLinkedFloor(s: DungeonStairs) {
		if (!this.file) return;

		// Floors live in the same folder as the current floor file
		const folderPath = this.file.parent?.path ?? '';
		let floorPath = s.linkedFloor
			? (s.linkedFloor.endsWith('.dungeon.md') ? s.linkedFloor : `${s.linkedFloor}.dungeon.md`)
			: null;

		// Resolve relative paths to the dungeon folder
		if (floorPath && !floorPath.contains('/')) {
			floorPath = folderPath ? `${folderPath}/${floorPath}` : floorPath;
		}

		let file = floorPath ? this.app.vault.getAbstractFileByPath(floorPath) : null;

		if (!file) {
			// Create a new floor file named after the stair id, in the same folder
			const newName = s.linkedFloor ?? `${this.file.basename.replace(/\.dungeon$/, '')} - ${s.id}`;
			const newPath = folderPath ? `${folderPath}/${newName}.dungeon.md` : `${newName}.dungeon.md`;
			file = await this.app.vault.create(newPath, JSON.stringify({ ...DEFAULT_FLOOR_DATA }, null, 2));
			// Store the link back into the stair data and save
			s.linkedFloor = newPath;
			this.scheduleSave();
		}

		if (file instanceof TFile) {
			// Open in this same pane — replaces the current floor view
			await this.leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
		}
	}

	async openNote(item: { id: string; label?: string; linkedNote?: string }, kind: string, defaultContent: string) {
		if (!this.file) return;
		const floorBase = this.file.path.replace(/\.dungeon\.md$/, '');
		const noteName = item.linkedNote ?? (item.label ?? item.id);
		const notePath = `${floorBase}/${noteName}.md`;

		let file = this.app.vault.getAbstractFileByPath(notePath);
		if (!file) {
			if (!this.app.vault.getAbstractFileByPath(floorBase))
				await this.app.vault.createFolder(floorBase);
			file = await this.app.vault.create(notePath, defaultContent);
			item.linkedNote = noteName;
			this.scheduleSave();
		}

		if (file instanceof TFile) {
			const isAlive = this.noteLeaf &&
				this.app.workspace.getLeavesOfType('markdown').includes(this.noteLeaf);
			if (!isAlive)
				this.noteLeaf = this.app.workspace.getLeaf('split', 'vertical');
			await this.noteLeaf.openFile(file);
		}
	}

	// ── Default note templates ───────────────────────────────────────────────

	defaultRoomContent(room: DungeonRoom): string {
		return [
			'---', `room_id: ${room.id}`, `type: ""`, '---', '',
			`# ${room.label ?? room.id}`, '',
			'## Description', '',
			'## Encounters', '',
			'## Treasure', '',
			'## DM Notes', '',
		].join('\n');
	}

	defaultCorridorContent(c: DungeonCorridor): string {
		return [
			'---', `corridor_id: ${c.id}`, `width: ${c.width}`, '---', '',
			`# ${c.label ?? c.id}`, '',
			'## Description', '',
			'## Encounters', '',
			'## DM Notes', '',
		].join('\n');
	}

	defaultDoorContent(d: DungeonDoor): string {
		return [
			'---', `door_id: ${d.id}`, `type: ${d.type}`, '---', '',
			`# ${d.label ?? d.id}`, '',
			'## Description', '',
			'## DM Notes', '',
		].join('\n');
	}

	// ── Obsidian state ───────────────────────────────────────────────────────

	async setState(state: any, result: any) {
		if (state?.file) {
			const file = this.app.vault.getAbstractFileByPath(state.file);
			if (file instanceof TFile) {
				this.file = file;
				await this.loadFile();
				this.resizeCanvas();
			}
		}
		return super.setState(state, result);
	}

	getState() { return { file: this.file?.path ?? '' }; }

	async loadFile() {
		if (!this.file) return;
		try {
			const raw = await this.app.vault.read(this.file);
			const parsed = JSON.parse(raw);
			this.data = Object.assign({}, DEFAULT_FLOOR_DATA, parsed);
			// Ensure arrays exist for files created before these fields existed
			this.data.doors  = this.data.doors  ?? [];
			this.data.stairs = this.data.stairs ?? [];
		} catch (e) {
			// Parse failed — use defaults in memory but do NOT overwrite the file.
			// The file may be mid-edit or temporarily malformed.
			console.warn('[DungeonCartographer] Could not parse floor file, using defaults in memory:', e);
			this.data = { ...DEFAULT_FLOOR_DATA };
		}
	}

	async saveFile() {
		if (!this.file) return;
		await this.app.vault.modify(this.file, JSON.stringify(this.data, null, 2));
	}

	scheduleSave() {
		if (this.saveTimeout) clearTimeout(this.saveTimeout);
		this.saveTimeout = setTimeout(() => this.saveFile(), 1000);
	}

	// ── Canvas sizing ────────────────────────────────────────────────────────

	resizeCanvas() {
		const rect = this.contentEl.getBoundingClientRect();
		this.canvas.width  = rect.width  || 800;
		this.canvas.height = rect.height || 600;
		this.centerGrid();
	}

	centerGrid() {
		const { gridW, gridH, cellSize, zoom } = this.data;
		const cs = cellSize * zoom;
		this.data.offX = (this.canvas.width  - gridW * cs) / 2;
		this.data.offY = (this.canvas.height - gridH * cs) / 2;
		this.render();
	}

	// ── Render ───────────────────────────────────────────────────────────────

	render() {
		try {
			this._render();
		} catch (e) {
			console.error('[DungeonCartographer] render error:', e);
		}
	}

	_render() {
		const { ctx, canvas, data } = this;
		const { zoom, offX, offY, cellSize, gridW, gridH } = data;
		const cs = cellSize * zoom;

		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = BG_COLOR;
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// Grid
		ctx.strokeStyle = GRID_COLOR;
		ctx.lineWidth = 0.5;
		for (let col = 0; col <= gridW; col++) {
			const x = offX + col * cs;
			if (x < -cs || x > canvas.width + cs) continue;
			ctx.beginPath(); ctx.moveTo(x, offY); ctx.lineTo(x, offY + gridH * cs); ctx.stroke();
		}
		for (let row = 0; row <= gridH; row++) {
			const y = offY + row * cs;
			if (y < -cs || y > canvas.height + cs) continue;
			ctx.beginPath(); ctx.moveTo(offX, y); ctx.lineTo(offX + gridW * cs, y); ctx.stroke();
		}

		// Corridors — drawn under rooms
		for (const corridor of data.corridors)
			this.renderCorridor(corridor, cs);

		// Rooms
		for (const room of data.rooms)
			this.renderRoom(room, cs);

		// Doors — drawn on top of rooms/corridors
		for (const door of data.doors)
			this.renderDoor(door, cs);

		// Stairs — drawn on top of everything
		for (const s of data.stairs)
			this.renderStairs(s, cs);
	}  // end _render

	renderCorridor(corridor: DungeonCorridor, cs: number) {
		if (corridor.waypoints.length < 2) return;
		const { ctx, data, hovered } = this;
		const isHovered = hovered?.kind === 'corridor' && hovered.item === corridor;

		const poly = buildCorridorPolygon(
			corridor.waypoints, corridor.width / 2, cs, data.offX, data.offY
		);
		applyPolygonPath(ctx, poly);
		ctx.fillStyle = isHovered ? '#2a2a4e' : CORRIDOR_FILL;
		ctx.fill();
		ctx.strokeStyle = isHovered ? ROOM_STROKE_HOV : CORRIDOR_STROKE;
		ctx.lineWidth = ROOM_STROKE_W;
		ctx.stroke();
	}

	renderRoom(room: DungeonRoom, cs: number) {
		const { ctx, data, hovered } = this;
		const { offX, offY } = data;
		const x = offX + room.x * cs;
		const y = offY + room.y * cs;
		const w = room.w * cs;
		const h = room.h * cs;
		const isHovered = hovered?.kind === 'room' && hovered.item === room;

		ctx.fillStyle = isHovered ? ROOM_FILL_HOVER : ROOM_FILL;
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = isHovered ? ROOM_STROKE_HOV : ROOM_STROKE;
		ctx.lineWidth = ROOM_STROKE_W;
		ctx.strokeRect(x, y, w, h);

		if (room.label && cs >= 8) {
			ctx.fillStyle = LABEL_COLOR;
			ctx.font = `${Math.max(9, Math.min(cs * 0.7, 14))}px sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(room.label, x + w / 2, y + h / 2, w - 4);
		}
	}

	renderDoor(door: DungeonDoor, cs: number) {
		const { ctx, data, hovered } = this;
		const isHovered = hovered?.kind === 'door' && hovered.item === door;
		const px = data.offX + door.x * cs;
		const py = data.offY + door.y * cs;
		const color = DOOR_COLORS[door.type] ?? DOOR_COLORS.open;

		// Door drawn as a rectangle across the wall.
		// Span = door.width cells × (4/5) to match 4ft out of 5ft per square.
		// Thickness is intentionally thin — just enough to see it clearly.
		const spanPx  = Math.max((door.width ?? 1) * cs * 0.8, 4);
		const thickPx = Math.max(cs * 0.6, 2);

		const halfSpan  = spanPx  / 2;
		const halfThick = thickPx / 2;

		const [hw, hh] = door.orientation === 'h'
			? [halfSpan,  halfThick]  // horizontal wall (runs east-west): wide east-west, thin north-south
			: [halfThick, halfSpan];  // vertical wall   (runs north-south): thin east-west, tall north-south

		ctx.fillStyle = color;
		ctx.fillRect(px - hw, py - hh, hw * 2, hh * 2);

		if (isHovered) {
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 1;
			ctx.strokeRect(px - hw, py - hh, hw * 2, hh * 2);
		}

		// Secret doors get an 'S' overlay
		if (door.type === 'secret' && cs >= 12) {
			ctx.fillStyle = '#aaa';
			ctx.font = `bold ${Math.max(8, cs * 0.4)}px sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText('S', px, py);
		}
	}

	renderStairs(s: DungeonStairs, cs: number) {
		const { ctx, data } = this;
		const w  = (s.width ?? 2) * cs;
		const d  = (s.depth ?? 2) * cs;
		const px = data.offX + s.x * cs;
		const py = data.offY + s.y * cs;
		const color = s.direction === 'up' ? STAIRS_UP_COLOR : STAIRS_DN_COLOR;

		// Map orientation to pixel coords.
		// nearX/Y = pixel origin of the near (entry) edge centre
		// axis = which pixel dimension is "depth" (direction of travel)
		// We'll work in a normalised space then rotate via transform.
		//
		// Strategy: translate/rotate canvas so stairs always render as if
		// the player walks in the +Y direction (south). Then un-transform.

		const orientAngles: Record<string, number> = { s: 0, w: 90, n: 180, e: 270 };
		const angleDeg = orientAngles[s.orientation ?? 's'] ?? 0;
		const angleRad = (angleDeg * Math.PI) / 180;

		// Centre of the stair block in pixel space
		let cx: number, cy: number;
		// The stair block occupies width × depth cells.
		// x,y is always top-left. Width is always the grid-x dimension, depth is grid-y.
		// We rotate around the block centre so we need to account for which dim is which.
		const isNS = angleDeg === 0 || angleDeg === 180; // depth runs vertically
		const blockPxW = isNS ? w : d;
		const blockPxH = isNS ? d : w;
		cx = px + blockPxW / 2;
		cy = py + blockPxH / 2;

		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(angleRad);
		// Now render centred at origin, near edge at +halfD (bottom), far edge at -halfD (top)
		const halfW = w / 2;
		const halfD = d / 2;

		// Background: same as rooms
		ctx.fillStyle = ROOM_FILL;
		ctx.fillRect(-halfW, -halfD, w, d);
		// Border on 3 sides only — leave the near/entry edge (bottom) open
		ctx.strokeStyle = ROOM_STROKE;
		ctx.lineWidth = ROOM_STROKE_W;
		ctx.beginPath();
		ctx.moveTo(-halfW,  halfD);   // bottom-left (entry edge — start here but don't close back)
		ctx.lineTo(-halfW, -halfD);   // up left side
		ctx.lineTo( halfW, -halfD);   // across far/top edge
		ctx.lineTo( halfW,  halfD);   // down right side
		ctx.stroke();                  // leaves bottom open

		// Subtle gradient overlay: near end (bottom, entry) slightly lighter,
		// fading to transparent at the far/top end — reinforces the "going up" perspective
		const grad = ctx.createLinearGradient(0, halfD, 0, -halfD);
		grad.addColorStop(0, 'rgba(200,184,154,0.18)');
		grad.addColorStop(1, 'rgba(200,184,154,0.0)');
		ctx.fillStyle = grad;
		ctx.fillRect(-halfW, -halfD, w, d);

		// Tread lines: run horizontally (perpendicular to travel), spaced along depth.
		// Near treads are wider and brighter; far treads are narrower and dimmer.
		const numTreads = Math.max(2, Math.round((s.depth ?? 2) * 2)); // ~2 per square
		const treadSpacing = d / (numTreads + 1);

		for (let i = 1; i <= numTreads; i++) {
			const t = i / (numTreads + 1);           // 0 = near, 1 = far
			const yPos = halfD - t * d;               // near=bottom, far=top
			const indent = t * halfW * 0.45;          // perspective: treads narrow toward far end
			const alpha = 1 - t * 0.75;

			ctx.strokeStyle = `rgba(200,184,154,${alpha.toFixed(2)})`;
			ctx.lineWidth = Math.max(0.5, (1 - t * 0.6) * cs * 0.1);
			ctx.beginPath();
			ctx.moveTo(-halfW + indent, yPos);
			ctx.lineTo( halfW - indent, yPos);
			ctx.stroke();
		}


		ctx.restore();
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
			await this.saveFile();
		}
	}
}

// ── Utility: point-in-polygon (ray casting) ──────────────────────────────────

function pointInPolygon(px: number, py: number, poly: { x: number; y: number }[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x, yi = poly[i].y;
		const xj = poly[j].x, yj = poly[j].y;
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
}
