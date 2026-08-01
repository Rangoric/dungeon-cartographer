export interface DungeonRoom {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	label?: string;
	linkedNote?: string;
	type?: string;
}

export interface DungeonCorridor {
	id: string;
	width: number;                       // 1–4 squares
	waypoints: { x: number; y: number }[];
	label?: string;
	linkedNote?: string;
}

export type DoorType = 'open' | 'locked' | 'secret' | 'barred';
export type DoorOrientation = 'h' | 'v';  // h blocks east-west movement, v blocks north-south

export interface DungeonDoor {
	id: string;
	x: number;                           // fractional grid coords — integer = on gridline, n.5 = cell center
	y: number;
	orientation: DoorOrientation;
	type: DoorType;
	width: number;                       // span in grid squares — should match the corridor/opening width
	label?: string;
	linkedNote?: string;
}

export type StairOrientation = 'n' | 's' | 'e' | 'w'; // direction you walk to ascend/descend

export interface DungeonStairs {
	id: string;
	x: number;                           // grid cell (top-left corner of the stair block)
	y: number;
	width: number;                       // grid squares perpendicular to travel (default 2 = 10')
	depth: number;                       // grid squares along direction of travel (default 2 = 10')
	direction: 'up' | 'down';
	orientation: StairOrientation;       // which way you walk to use the stairs
	linkedFloor?: string;                // path to adjacent floor file — wired up later
}

export interface DungeonFloorData {
	gridW: number;
	gridH: number;
	cellSize: number;
	zoom: number;
	offX: number;
	offY: number;
	rooms: DungeonRoom[];
	corridors: DungeonCorridor[];
	doors: DungeonDoor[];
	stairs: DungeonStairs[];
}

export const DEFAULT_FLOOR_DATA: DungeonFloorData = {
	gridW: 48,
	gridH: 36,
	cellSize: 16,
	zoom: 1,
	offX: 0,
	offY: 0,
	rooms: [],
	corridors: [],
	doors: [],
	stairs: [],
};
