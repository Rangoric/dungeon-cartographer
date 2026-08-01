// Geometry utilities for dungeon rendering

export interface Vec2 { x: number; y: number; }

export function vec2Sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
export function vec2Add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
export function vec2Scale(v: Vec2, s: number): Vec2 { return { x: v.x * s, y: v.y * s }; }
export function vec2Len(v: Vec2): number { return Math.sqrt(v.x * v.x + v.y * v.y); }
export function vec2Norm(v: Vec2): Vec2 { const l = vec2Len(v); return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 }; }
export function vec2Dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
// Left-hand perpendicular (CCW 90°)
export function vec2Perp(v: Vec2): Vec2 { return { x: -v.y, y: v.x }; }

const MAX_MITER = 4; // clamp miter length to 4× half-width to avoid extreme spikes on sharp turns

/**
 * Build a filled polygon for a corridor path.
 * waypoints: grid coordinates of the centerline
 * halfWidth: corridor half-width in grid units
 * Returns an array of {x,y} points forming the outline, in canvas pixel space.
 */
export function buildCorridorPolygon(
	waypoints: Vec2[],
	halfWidth: number,
	cellSize: number,
	offX: number,
	offY: number,
): Vec2[] {
	if (waypoints.length < 2) return [];

	const toPixel = (p: Vec2) => ({
		x: offX + p.x * cellSize,
		y: offY + p.y * cellSize,
	});

	const n = waypoints.length;
	const leftPts: Vec2[] = [];
	const rightPts: Vec2[] = [];

	for (let i = 0; i < n; i++) {
		if (i === 0) {
			// Start cap — flat, perpendicular to first segment
			const dir = vec2Norm(vec2Sub(waypoints[1], waypoints[0]));
			const perp = vec2Perp(dir);
			leftPts.push(vec2Add(waypoints[0], vec2Scale(perp, halfWidth)));
			rightPts.push(vec2Sub(waypoints[0], vec2Scale(perp, halfWidth)));
		} else if (i === n - 1) {
			// End cap — flat, perpendicular to last segment
			const dir = vec2Norm(vec2Sub(waypoints[n - 1], waypoints[n - 2]));
			const perp = vec2Perp(dir);
			leftPts.push(vec2Add(waypoints[n - 1], vec2Scale(perp, halfWidth)));
			rightPts.push(vec2Sub(waypoints[n - 1], vec2Scale(perp, halfWidth)));
		} else {
			// Interior waypoint — compute mitered corner
			const dir1 = vec2Norm(vec2Sub(waypoints[i], waypoints[i - 1]));
			const dir2 = vec2Norm(vec2Sub(waypoints[i + 1], waypoints[i]));
			const perp1 = vec2Perp(dir1);
			const perp2 = vec2Perp(dir2);

			// Miter direction is the bisector of the two perpendiculars
			const miterDir = vec2Norm(vec2Add(perp1, perp2));
			const miterDot = vec2Dot(miterDir, perp1);
			// Clamp to avoid infinite miter on 180° turns
			const miterLen = miterDot !== 0
				? Math.min(halfWidth / miterDot, halfWidth * MAX_MITER)
				: halfWidth;

			leftPts.push(vec2Add(waypoints[i], vec2Scale(miterDir, miterLen)));
			rightPts.push(vec2Sub(waypoints[i], vec2Scale(miterDir, miterLen)));
		}
	}

	// Build polygon: left side forward, right side backward
	const poly: Vec2[] = [
		...leftPts.map(toPixel),
		...rightPts.reverse().map(toPixel),
	];
	return poly;
}

/** Apply a polygon path to a canvas context (does not fill/stroke — caller does that) */
export function applyPolygonPath(ctx: CanvasRenderingContext2D, poly: Vec2[]) {
	if (poly.length === 0) return;
	ctx.beginPath();
	ctx.moveTo(poly[0].x, poly[0].y);
	for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
	ctx.closePath();
}
