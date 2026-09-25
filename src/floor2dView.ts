// SVG view layer: turns Floor2DSpecs (src/floor2d.ts - grid-cell geometry
// and physical metadata) into real, drawn <svg> content, plus pan/zoom and
// click wiring - the piece "2D Rendering Plan.md"'s pure spec module
// explicitly leaves to "the view layer" (rollout step 4). Uses real DOM
// APIs (createElementNS) so it needs a browser, same reasoning
// `main.ts`'s old Three.js mesh-building code always did - not unit-tested
// directly (this repo's vitest config runs in a Node environment with no
// DOM - see vitest.config.mts), same as the 3D mesh-building code it
// replaces was. Confidence instead comes from floor2d.ts's own thorough
// test coverage (the geometry/metadata this module just draws), plus a
// manual visual check of this exact drawing logic against the real Sample
// Dungeon Floor 1 before this was wired into main.ts.
//
// Visual style: a direct, careful port of the "Field Print" mockup shown
// to and approved by the user (see the comparison artifact and "2D
// Rendering Plan.md"'s "Visual Style, Resolved" section) - every pixel
// constant below (leaf insets, icon sizes, stroke widths) is copied from
// that mockup's SVG-string version, just rebuilt as real DOM nodes. `CS`
// (cell size, in SVG user-units) can be any positive number without
// changing the rendered result - the <svg> scales to whatever size its
// container gives it via `viewBox` + `width/height:100%`, so `CS` only
// fixes the *ratio* between coordinates, never a real screen pixel size.
//
// NOTE on click-to-open-note: "2D Rendering Plan.md"'s "What Doesn't
// Change" section describes clicking a room/corridor opening its note as
// existing 3D-view behavior being carried over. That's not accurate - the
// current (pre-2D) `main.ts` never actually implemented this, and the
// `.dungeon` schema has no per-room/corridor note-link field to open in
// the first place. `onOpenEntity` below is real, working plumbing - every
// room/corridor floor rect AND every door icon is clickable and reports
// its owner (`"room" | "corridor" | "door"`) - and as of 2026-09-25
// `main.ts` actually wires a handler for it (`openEntityNote`, see "Door
// Notes and Map Hover Plan.md" Part B3): rooms/doors open an existing note
// if one exists (never auto-created - a plain door or a room the Room
// Content pass hasn't touched yet just shows a `Notice`), corridors
// auto-create a minimal stub note on first click since they have no
// physical flag to drive automatic generation. Stairs are deliberately
// out of scope - no interactive hit-area exists on `drawStairIcon` yet.
//
// `renderFloorToSvgString()` near the bottom of this file is rollout step
// 5 (export/print, "2D Rendering Plan.md") - a static, non-interactive
// render of the same specs (no pan/zoom group, no click handlers) plus
// the door/stair legend and a title line baked into one self-contained
// SVG document string, so "export" is close to literally serializing what
// the in-app view already draws, per the plan's own reasoning for picking
// SVG in the first place.

import type { DungeonFloorData } from "./dungeonData";
import {
  floorTo2DSpecs,
  type Floor2DSpecs,
  type DoorIcon2D,
  type StairIcon2D,
  type RoomLabel2D,
  type HeightLabel2D,
  type GridRect,
  type GridLine,
  type FloorRect,
  doorFillColor,
  doorStrokeColor,
  doorTooltipLabel,
  roomTooltipLabel,
  corridorTooltipLabel,
  SECRET_DOOR_LABEL_COLOR,
  TRAPPED_DOOR_STROKE,
  PORTCULLIS_BAR_COLOR,
} from "./floor2d";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Grid-cell size, in SVG user-units - see module header on why the exact value doesn't matter. */
const CS = 18;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

interface BBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

function computeBBox(specs: Floor2DSpecs, grid: { width: number; depth: number }): BBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const consider = (x: number, y: number, w: number, d: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + w);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + d);
  };
  for (const r of specs.wallRects) consider(r.x, r.y, r.w, r.d);
  for (const r of specs.floorRects) consider(r.x, r.y, r.w, r.d);
  for (const r of specs.doorGapRects) consider(r.x, r.y, r.w, r.d);
  if (!Number.isFinite(minX)) {
    // An empty floor (no content at all) - fall back to the grid's own
    // declared size rather than an unbounded/NaN viewBox.
    minX = 0;
    minY = 0;
    maxX = grid.width || 20;
    maxY = grid.depth || 20;
  }
  // Padding so the outermost wall stroke/boundary line isn't clipped.
  minX -= 1;
  minY -= 1;
  maxX += 1;
  maxY += 1;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function drawFineGrid(parent: SVGGElement, bbox: BBox): void {
  const g = svgEl("g", { stroke: "#000000", "stroke-opacity": 0.05, "pointer-events": "none" });
  const x0 = Math.ceil(bbox.minX);
  const x1 = Math.floor(bbox.minX + bbox.w);
  for (let gx = x0; gx <= x1; gx++) {
    g.appendChild(svgEl("line", { x1: gx * CS, y1: bbox.minY * CS, x2: gx * CS, y2: (bbox.minY + bbox.h) * CS }));
  }
  const y0 = Math.ceil(bbox.minY);
  const y1 = Math.floor(bbox.minY + bbox.h);
  for (let gy = y0; gy <= y1; gy++) {
    g.appendChild(svgEl("line", { x1: bbox.minX * CS, y1: gy * CS, x2: (bbox.minX + bbox.w) * CS, y2: gy * CS }));
  }
  parent.appendChild(g);
}

function drawPlainRects(parent: SVGGElement, rects: readonly GridRect[]): void {
  for (const r of rects) {
    parent.appendChild(svgEl("rect", { x: r.x * CS, y: r.y * CS, width: r.w * CS, height: r.d * CS, fill: r.color }));
  }
}

function drawBoundaryLines(parent: SVGGElement, lines: readonly GridLine[]): void {
  const g = svgEl("g", { "stroke-linecap": "square", "pointer-events": "none" });
  for (const line of lines) {
    g.appendChild(
      svgEl("line", { x1: line.x1 * CS, y1: line.y1 * CS, x2: line.x2 * CS, y2: line.y2 * CS, stroke: line.color, "stroke-width": 1.6 })
    );
  }
  parent.appendChild(g);
}

/**
 * Same leaf-geometry/icon-placement math as the approved mockup's
 * `draw_door_icon` (make_svgs2.py). Draws into a fresh `<g>` (appended to
 * `parent`, and returned) rather than appending straight to `parent` -
 * lets the interactive view (`createFloor2DView`) attach hover listeners
 * to one element per door instead of every mark separately. The static
 * export path (`renderFloorToSvgString`) just discards the return value.
 */
function drawDoorIcon(parent: SVGGElement, door: DoorIcon2D): SVGGElement {
  const g = svgEl("g");
  const { x0, y0, x1, y1 } = door.span;
  // Invisible hit-area covering the door's full span (not just the leaf
  // rect) - `pointer-events: all` is needed since a transparent fill is
  // otherwise excluded from hit-testing under the default
  // `pointer-events: visiblePainted`. Keeps hover reliable even over a
  // thin gap between the leaf and a locked/stuck mark, rather than
  // depending on the browser's implicit group-bbox enter/leave behavior.
  const hit = svgEl("rect", { x: x0 * CS, y: y0 * CS, width: (x1 - x0) * CS, height: (y1 - y0) * CS, fill: "transparent" });
  hit.style.pointerEvents = "all";
  g.appendChild(hit);
  let leafX: number, leafY: number, leafW: number, leafH: number, cx: number, cy: number;
  if (door.crossesX) {
    const px0 = x0 * CS + 3;
    const px1 = x1 * CS - 3;
    const py0 = y0 * CS;
    const py1 = y1 * CS;
    cx = (px0 + px1) / 2;
    cy = (py0 + py1) / 2;
    leafX = px0;
    leafY = py0 + 2;
    leafW = px1 - px0;
    leafH = py1 - py0 - 4;
  } else {
    const px0 = x0 * CS;
    const px1 = x1 * CS;
    const py0 = y0 * CS + 3;
    const py1 = y1 * CS - 3;
    cx = (px0 + px1) / 2;
    cy = (py0 + py1) / 2;
    leafX = px0 + 2;
    leafY = py0;
    leafW = px1 - px0 - 4;
    leafH = py1 - py0;
  }

  // 2026-09-06: secret doors no longer blend into the wall - they draw
  // like any other door (material fill/stroke, trapped/locked/stuck marks
  // all still show) with an 'S' glyph layered on top below, so a secret
  // door's other physical state is never hidden along with the fact that
  // it's secret.
  const fill = doorFillColor(door.material);
  const stroke = door.trapped ? TRAPPED_DOOR_STROKE : doorStrokeColor(door.material);
  const strokeWidth = door.trapped ? 2.2 : 1.4;
  g.appendChild(svgEl("rect", { x: leafX, y: leafY, width: leafW, height: leafH, fill, stroke, "stroke-width": strokeWidth }));

  if (door.material === "portcullis") {
    // Lattice/hatch bars across the leaf, perpendicular to the opening's
    // long axis - `doorFillColor`'s distinct slate-blue alone still reads
    // too close to metal's grey at map scale (Door Notes and Map Hover
    // Plan.md Part C6), so this is what actually reads as "gate" rather
    // than "door".
    const barCount = 3;
    for (let i = 1; i <= barCount; i++) {
      if (door.crossesX) {
        const bx = leafX + (leafW * i) / (barCount + 1);
        g.appendChild(svgEl("line", { x1: bx, y1: leafY, x2: bx, y2: leafY + leafH, stroke: PORTCULLIS_BAR_COLOR, "stroke-width": 1 }));
      } else {
        const by = leafY + (leafH * i) / (barCount + 1);
        g.appendChild(svgEl("line", { x1: leafX, y1: by, x2: leafX + leafW, y2: by, stroke: PORTCULLIS_BAR_COLOR, "stroke-width": 1 }));
      }
    }
  }

  if (door.locked) {
    g.appendChild(svgEl("circle", { cx, cy, r: 2.6, fill: "#1c1c1c" }));
  }
  if (door.stuck) {
    // 2026-09-06: a full corner-to-corner X across the leaf ("stuck" reads
    // as this door being X'd out/jammed shut) - replaces an earlier small
    // jammed/zigzag mark. Donjon has no map icon for this state at all
    // (only descriptive text, e.g. "Stuck Simple Wooden Door"). Neutral
    // grey since being stuck is a nuisance, not a danger like a trap.
    g.appendChild(svgEl("line", { x1: leafX, y1: leafY, x2: leafX + leafW, y2: leafY + leafH, stroke: "#4a4a4a", "stroke-width": 1.3, "stroke-linecap": "round" }));
    g.appendChild(svgEl("line", { x1: leafX + leafW, y1: leafY, x2: leafX, y2: leafY + leafH, stroke: "#4a4a4a", "stroke-width": 1.3, "stroke-linecap": "round" }));
  }
  if (door.secret) {
    // 2026-09-06: an 'S' drawn last so it stays legible over the fill/
    // locked dot/stuck X beneath it. Rotated 90 degrees for a door whose
    // opening runs north-south (crossesX false - see DoorIcon2D's doc
    // comment) so the glyph is "on its side"; an east-west-opening door
    // (crossesX true) reads upright.
    const label = svgEl("text", {
      x: cx,
      y: cy,
      "font-size": 8,
      "font-weight": "bold",
      "font-family": "sans-serif",
      "text-anchor": "middle",
      "dominant-baseline": "central",
      fill: SECRET_DOOR_LABEL_COLOR,
      stroke: "#f2ede4",
      "stroke-width": 2.5,
      "paint-order": "stroke",
      "stroke-linejoin": "round",
      transform: door.crossesX ? "" : `rotate(90 ${cx} ${cy})`,
    });
    label.textContent = "S";
    g.appendChild(label);
  }
  parent.appendChild(g);
  return g;
}

/** Donjon-style hatch bar - horizontal stripes = down (matches `floorsDown`; the schema has no "up" stair concept yet, see Dungeon Data Format.md). */
function drawStairIcon(parent: SVGGElement, stair: StairIcon2D): void {
  const { box } = stair;
  const x0 = box.x * CS;
  const y0 = box.y * CS;
  const w = box.w * CS;
  const h = box.d * CS;
  parent.appendChild(svgEl("rect", { x: x0, y: y0, width: w, height: h, fill: "#111111", stroke: "#111111", "stroke-width": 1 }));
  const stripes = 5;
  for (let i = 0; i < stripes; i++) {
    const yy = y0 + (h * (i + 0.5)) / stripes;
    parent.appendChild(svgEl("line", { x1: x0 + 2, y1: yy, x2: x0 + w - 2, y2: yy, stroke: "#ffffff", "stroke-width": 1.6 }));
  }
  // Only a freestanding stair prints its height next to the icon - an
  // embedded one already has its room's own RoomLabel2D nearby (see "2D
  // Rendering Plan.md"'s ceiling-height policy).
  if (!stair.embedded) {
    const label = svgEl("text", {
      x: x0 + w / 2,
      y: y0 + h + 10,
      "font-size": 7.5,
      fill: "#111111",
      "text-anchor": "middle",
      "font-family": "sans-serif",
      "pointer-events": "none",
    });
    label.textContent = `${stair.heightFt}’ · DOWN ${stair.floorsDown}`;
    parent.appendChild(label);
  }
}

function drawRoomLabel(parent: SVGGElement, label: RoomLabel2D): void {
  const cx = label.cx * CS;
  const cy = label.cy * CS;
  const idText = svgEl("text", {
    x: cx,
    y: cy + 3,
    fill: "#111111",
    "font-size": 11,
    "text-anchor": "middle",
    "font-family": "sans-serif",
    "font-weight": 600,
    "pointer-events": "none",
  });
  idText.textContent = String(label.id);
  parent.appendChild(idText);
  const heightText = svgEl("text", {
    x: cx,
    y: cy + 14,
    fill: "#555555",
    "font-size": 8,
    "text-anchor": "middle",
    "font-family": "sans-serif",
    "pointer-events": "none",
  });
  heightText.textContent = `${label.heightFt}’`;
  parent.appendChild(heightText);
}

/** Rotates -90deg on a segment taller than it is wide, so the label fits inside a narrow 5'-wide corridor run instead of overflowing into the walls. */
function drawHeightLabel(parent: SVGGElement, label: HeightLabel2D): void {
  const cx = label.cx * CS;
  const cy = label.cy * CS;
  const attrs: Record<string, string | number> = {
    x: cx,
    y: label.rotated ? cy : cy + 3,
    "font-size": 7.5,
    fill: "#555555",
    "text-anchor": "middle",
    "font-family": "sans-serif",
    "pointer-events": "none",
  };
  if (label.rotated) {
    attrs["dominant-baseline"] = "middle";
    attrs["transform"] = `rotate(-90 ${cx} ${cy})`;
  }
  const text = svgEl("text", attrs);
  text.textContent = `${label.heightFt}’`;
  parent.appendChild(text);
}

// ---------------------------------------------------------------------------
// Export/print (rollout step 5)
// ---------------------------------------------------------------------------

export interface FloorExportOptions {
  /**
   * Icon+label pairs for the always-shown door/stair legend - kept as data
   * owned by `main.ts` (`LEGEND_ITEMS`) rather than duplicated here, so the
   * in-app overlay and this export draw from exactly one source and can
   * never drift out of sync with each other. Each `svg` is expected to be
   * a self-contained `<svg viewBox="0 0 22 22">...</svg>` snippet, same
   * shape `main.ts`'s legend overlay already uses.
   */
  legend: { svg: string; label: string }[];
  /** Room/corridor/door/stair/region count line - same text as the in-app status overlay. */
  statusText: string;
  /** Printed as a small title above the map - typically the floor file's basename. */
  title: string;
}

const EXPORT_PAD = 14;
const EXPORT_TITLE_H = 30;
const EXPORT_LEGEND_ITEM_W = 132;
const EXPORT_LEGEND_ROW_H = 24;
const EXPORT_LEGEND_ICON = 18;
const EXPORT_LEGEND_GAP_ABOVE = 10;

/**
 * Renders `data` to a single, self-contained SVG document string - the
 * export/print action. Reuses every draw-helper and plain-rect function
 * above, so the exported map is pixel-for-pixel the same map geometry as the live view,
 * just laid out on a static canvas (identity transform, no click
 * listeners) with a title/status line above it and the door/stair legend
 * baked in below - "always includes the legend/labels" (2026-09-05)
 * applies to the export the same as it does to the in-app view, not just
 * one of the two.
 *
 * Raw SVG was chosen over a plugin-rendered PNG/PDF (still logged as an
 * open, non-blocking question in "2D Rendering Plan.md") because printing
 * is *why* SVG was picked as the rendering technology in the first place -
 * a browser or the OS can already turn an SVG file into a printout or a
 * PDF without the plugin needing its own rasterizer. Layout constants
 * above are a first pass, not tuned against an actual printed page yet.
 */
export function renderFloorToSvgString(data: DungeonFloorData, options: FloorExportOptions): string {
  const specs = floorTo2DSpecs(data);
  const bbox = computeBBox(specs, data.grid);
  const mapW = bbox.w * CS;
  const mapH = bbox.h * CS;

  const maxItemsThatFit = Math.max(1, Math.floor(mapW / EXPORT_LEGEND_ITEM_W));
  const itemsPerRow = Math.min(options.legend.length, maxItemsThatFit);
  const legendRows = Math.ceil(options.legend.length / itemsPerRow);
  const legendW = itemsPerRow * EXPORT_LEGEND_ITEM_W;
  const legendH = legendRows * EXPORT_LEGEND_ROW_H;

  const innerW = Math.max(mapW, legendW);
  const totalW = innerW + EXPORT_PAD * 2;
  const totalH = EXPORT_PAD + EXPORT_TITLE_H + mapH + EXPORT_LEGEND_GAP_ABOVE + legendH + EXPORT_PAD;

  const svg = svgEl("svg", {
    xmlns: SVG_NS,
    width: totalW,
    height: totalH,
    viewBox: `0 0 ${totalW} ${totalH}`,
  });
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: totalW, height: totalH, fill: "#ffffff" }));

  // --- Title/status line ------------------------------------------------
  const title = svgEl("text", {
    x: EXPORT_PAD,
    y: EXPORT_PAD + 14,
    "font-size": 13,
    "font-family": "sans-serif",
    "font-weight": 700,
    fill: "#111111",
  });
  title.textContent = options.title;
  svg.appendChild(title);
  const status = svgEl("text", {
    x: EXPORT_PAD,
    y: EXPORT_PAD + 27,
    "font-size": 10,
    "font-family": "sans-serif",
    fill: "#555555",
  });
  status.textContent = options.statusText;
  svg.appendChild(status);

  // --- Map, centered under the title, at its natural CS scale ------------
  const mapOffsetX = EXPORT_PAD + (innerW - mapW) / 2 - bbox.minX * CS;
  const mapOffsetY = EXPORT_PAD + EXPORT_TITLE_H - bbox.minY * CS;
  const mapGroup = svgEl("g", { transform: `translate(${mapOffsetX} ${mapOffsetY})` });
  svg.appendChild(mapGroup);
  mapGroup.appendChild(
    svgEl("rect", { x: bbox.minX * CS, y: bbox.minY * CS, width: mapW, height: mapH, fill: "#ffffff", stroke: "#dddddd" })
  );
  drawPlainRects(mapGroup, specs.wallRects);
  drawPlainRects(mapGroup, specs.floorRects);
  drawPlainRects(mapGroup, specs.doorGapRects);
  drawFineGrid(mapGroup, bbox);
  drawBoundaryLines(mapGroup, specs.boundaryLines);
  for (const door of specs.doors) drawDoorIcon(mapGroup, door);
  for (const label of specs.roomLabels) drawRoomLabel(mapGroup, label);
  for (const label of specs.corridorHeightLabels) drawHeightLabel(mapGroup, label);
  for (const stair of specs.stairs) drawStairIcon(mapGroup, stair);

  // --- Legend, wrapped into rows, centered under the map ------------------
  const legendOffsetX = EXPORT_PAD + (innerW - legendW) / 2;
  const legendOffsetY = EXPORT_PAD + EXPORT_TITLE_H + mapH + EXPORT_LEGEND_GAP_ABOVE;
  const legendGroup = svgEl("g", { transform: `translate(${legendOffsetX} ${legendOffsetY})` });
  svg.appendChild(legendGroup);
  options.legend.forEach((entry, i) => {
    const col = i % itemsPerRow;
    const row = Math.floor(i / itemsPerRow);
    const ix = col * EXPORT_LEGEND_ITEM_W;
    const iy = row * EXPORT_LEGEND_ROW_H;
    // Nested <svg> lets each legend snippet's own viewBox/markup be reused
    // verbatim (same technique `main.ts`'s live legend overlay already
    // uses via `swatch.innerHTML = entry.svg`), rather than re-deriving
    // icon-drawing logic a third time.
    const icon = svgEl("svg", { x: ix, y: iy, width: EXPORT_LEGEND_ICON, height: EXPORT_LEGEND_ICON, viewBox: "0 0 22 22" });
    icon.innerHTML = entry.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    legendGroup.appendChild(icon);
    const label = svgEl("text", {
      x: ix + EXPORT_LEGEND_ICON + 6,
      y: iy + EXPORT_LEGEND_ICON / 2 + 4,
      "font-size": 10,
      "font-family": "sans-serif",
      fill: "#333333",
    });
    label.textContent = entry.label;
    legendGroup.appendChild(label);
  });

  return new XMLSerializer().serializeToString(svg);
}

export interface Floor2DViewOptions {
  /**
   * Called when a room/corridor floor rect is clicked - see the module
   * header's note on why `main.ts` doesn't pass this yet.
   */
  onOpenEntity?: (owner: { kind: "room" | "corridor" | "door"; id: number }) => void;
  /**
   * Stage-1/stage-2 map hover ("Door Notes and Map Hover Plan.md" Part B).
   * Fired with the hovered entity on pointerenter, and `null` on
   * pointerleave - `main.ts` uses this to kick off an async vault read for
   * that entity's note (if one exists) and feed the result back through
   * `Floor2DView.setHoverNoteExcerpt`. This view never touches the vault
   * itself (same Obsidian-I/O-stays-in-main.ts split as `onOpenEntity`).
   */
  onHoverEntity?: (owner: { kind: "room" | "corridor" | "door"; id: number } | null) => void;
}

export interface Floor2DView {
  /** Clears and redraws for new floor data, and resets pan/zoom. */
  render(data: DungeonFloorData): void;
  /** Shows a simple centered message instead of floor content (e.g. no file open, or a parse error). */
  renderPlaceholder(message: string): void;
  /**
   * Stage-2 hover (Part B1.2): appends a note-content excerpt to whichever
   * tooltip is currently showing, but only if `owner` still matches the
   * entity actually being hovered right now - by the time `main.ts`'s
   * async vault read resolves, the pointer may have moved to a different
   * entity or off the map entirely, and a stale result must not clobber
   * (or resurrect) the wrong tooltip. A no-op (never hides/replaces the
   * stage-1 physical line) when `owner` doesn't match, or `excerpt` is "".
   */
  setHoverNoteExcerpt(owner: { kind: "room" | "corridor" | "door"; id: number }, excerpt: string): void;
  /** Removes all listeners and the <svg> element itself - call from onClose. */
  destroy(): void;
}

/**
 * Builds the SVG map view inside `host` - a single `<svg>` filling its
 * container, with mouse-drag pan, scroll-wheel zoom (centered on the
 * cursor), double-click-to-reset, and click-to-open-note plumbing on every
 * room/corridor floor rect and every door icon (see
 * `Floor2DViewOptions.onOpenEntity`).
 */
export function createFloor2DView(host: HTMLElement, options: Floor2DViewOptions = {}): Floor2DView {
  const svg = svgEl("svg", { width: "100%", height: "100%" });
  svg.style.cssText = "display:block;background:#000000;cursor:grab;touch-action:none;";
  const content = svgEl("g");
  svg.appendChild(content);
  host.appendChild(svg);

  // --- Hover tooltip (stage 1: physical-only door hover) --------------------
  // Plain fixed-position HTML element, not SVG - `<title>` can't hold
  // structured, styled content. Position follows the pointer via
  // `pointermove`; content comes straight from `doorTooltipLabel()`
  // (floor2d.ts), no note lookup - see "Door Notes and Map Hover Plan.md"
  // Part B1 for the staging (physical-only now, note-backed content is a
  // later stage) and B2 for why this lives outside the SVG tree.
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const tooltip = document.createElement("div");
  tooltip.style.cssText =
    "position:absolute;pointer-events:none;z-index:1000;display:none;" +
    "background:rgba(20,20,20,0.92);color:#f2f2f2;font:11px sans-serif;" +
    "padding:4px 8px;border-radius:4px;white-space:pre-line;max-width:280px;";
  host.appendChild(tooltip);

  // Stage-2 hover state (Part B1.2) - which entity the tooltip is
  // currently showing, and its stage-1 physical-only line on its own, so
  // `setHoverNoteExcerpt` can append to it (or a later re-entry can
  // overwrite it) without losing that base text. `currentHoverOwner` is
  // also what makes a stale async note-read result (main.ts's vault read
  // can easily outlive a quick mouse pass) safely ignorable.
  let currentHoverOwner: { kind: "room" | "corridor" | "door"; id: number } | null = null;
  let currentHoverPhysicalText = "";

  function showTooltip(owner: { kind: "room" | "corridor" | "door"; id: number }, text: string, e: PointerEvent): void {
    currentHoverOwner = owner;
    currentHoverPhysicalText = text;
    tooltip.textContent = text;
    tooltip.style.display = "block";
    moveTooltip(e);
  }
  function moveTooltip(e: PointerEvent): void {
    // `getBoundingClientRect()` returns post-transform screen pixels, but
    // `tooltip.style.left/top` are interpreted in `host`'s own local
    // (pre-transform) coordinate space - if some ancestor applies a CSS
    // scale (Obsidian's UI zoom does exactly this on its app root), a
    // screen-pixel delta has to be divided back down by that scale before
    // it's a valid local-space offset, or the tooltip drifts away from
    // the cursor by however much the zoom differs from 100%. Falls back
    // to 1 (no correction) if `host` has zero layout size.
    const hostRect = host.getBoundingClientRect();
    const scaleX = host.offsetWidth ? hostRect.width / host.offsetWidth : 1;
    const scaleY = host.offsetHeight ? hostRect.height / host.offsetHeight : 1;
    tooltip.style.left = `${(e.clientX - hostRect.left) / scaleX + 14}px`;
    tooltip.style.top = `${(e.clientY - hostRect.top) / scaleY + 14}px`;
  }
  function hideTooltip(): void {
    currentHoverOwner = null;
    currentHoverPhysicalText = "";
    tooltip.style.display = "none";
  }

  function sameOwner(a: { kind: string; id: number } | null, b: { kind: string; id: number }): boolean {
    return a !== null && a.kind === b.kind && a.id === b.id;
  }

  function setHoverNoteExcerpt(owner: { kind: "room" | "corridor" | "door"; id: number }, excerpt: string): void {
    if (!excerpt || !sameOwner(currentHoverOwner, owner)) return;
    tooltip.textContent = `${currentHoverPhysicalText}\n${excerpt}`;
  }

  // --- Pan/zoom -------------------------------------------------------------
  // Deliberately not using `setPointerCapture` - that would retarget the
  // eventual synthetic "click" event to whatever element captured the
  // pointer, which would break per-rect click-to-open-note. Tracking the
  // drag on `window` instead keeps both a reliable drag-end (even if the
  // cursor leaves the SVG mid-drag) and normal click delivery to whichever
  // rect is actually under the cursor on release.
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let dragging = false;
  let dragMoved = false;
  let dragStartClient = { x: 0, y: 0 };
  let panStart = { x: 0, y: 0 };

  function applyTransform(): void {
    content.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
  }

  function resetView(): void {
    panX = 0;
    panY = 0;
    zoom = 1;
    applyTransform();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    panX = panStart.x + dx;
    panY = panStart.y + dy;
    applyTransform();
  }
  function onPointerUp(): void {
    dragging = false;
    svg.style.cursor = "grab";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return; // left-drag only
    dragging = true;
    dragMoved = false;
    svg.style.cursor = "grabbing";
    dragStartClient = { x: e.clientX, y: e.clientY };
    panStart = { x: panX, y: panY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pointX = vb.x + ((e.clientX - rect.left) / rect.width) * vb.width;
    const pointY = vb.y + ((e.clientY - rect.top) / rect.height) * vb.height;
    // Keep the point under the cursor fixed in screen space while zooming:
    // solve for the new pan given the same content-space point.
    const localX = (pointX - panX) / zoom;
    const localY = (pointY - panY) / zoom;
    const factor = Math.exp(-e.deltaY * 0.001);
    zoom = Math.min(8, Math.max(0.2, zoom * factor));
    panX = pointX - localX * zoom;
    panY = pointY - localY * zoom;
    applyTransform();
  }
  function onDoubleClick(): void {
    resetView();
  }

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("dblclick", onDoubleClick);

  function drawFloorRects(
    parent: SVGGElement,
    rects: readonly FloorRect[],
    roomsById: ReadonlyMap<number, DungeonFloorData["rooms"][number]>,
    corridorsById: ReadonlyMap<number, DungeonFloorData["corridors"][number]>
  ): void {
    for (const r of rects) {
      const attrs: Record<string, string | number> = { x: r.x * CS, y: r.y * CS, width: r.w * CS, height: r.d * CS, fill: r.color };
      const el = svgEl("rect", attrs);
      if (r.owner) {
        el.style.cursor = "pointer";
        const owner = r.owner;
        el.addEventListener("click", () => {
          if (dragMoved) return;
          options.onOpenEntity?.(owner);
        });
        // Stage-1 hover - same physical-only tooltip treatment as doors
        // (see doorTooltipLabel above). A room can have several floor
        // rects (its own box plus any lobe regions) that all share one
        // id, so every one of them resolves to the same tooltip text -
        // fine, since they're all "the same room" from the hover's point
        // of view. Freestanding-stair floor rects have no `owner` and so
        // fall through this block entirely - stair hover isn't built yet.
        if (owner.kind === "room") {
          const room = roomsById.get(owner.id);
          if (room) {
            el.addEventListener("pointerenter", (e) => {
              showTooltip(owner, roomTooltipLabel(room), e as PointerEvent);
              options.onHoverEntity?.(owner);
            });
            el.addEventListener("pointermove", (e) => moveTooltip(e as PointerEvent));
            el.addEventListener("pointerleave", () => {
              hideTooltip();
              options.onHoverEntity?.(null);
            });
          }
        } else {
          const corridor = corridorsById.get(owner.id);
          if (corridor) {
            el.addEventListener("pointerenter", (e) => {
              showTooltip(owner, corridorTooltipLabel(corridor), e as PointerEvent);
              options.onHoverEntity?.(owner);
            });
            el.addEventListener("pointermove", (e) => moveTooltip(e as PointerEvent));
            el.addEventListener("pointerleave", () => {
              hideTooltip();
              options.onHoverEntity?.(null);
            });
          }
        }
      }
      parent.appendChild(el);
    }
  }

  function clear(): void {
    while (content.firstChild) content.removeChild(content.firstChild);
  }

  function render(data: DungeonFloorData): void {
    hideTooltip();
    clear();
    resetView();
    const specs = floorTo2DSpecs(data);
    const bbox = computeBBox(specs, data.grid);
    svg.setAttribute("viewBox", `${bbox.minX * CS} ${bbox.minY * CS} ${bbox.w * CS} ${bbox.h * CS}`);

    // A real filled background rect (not just CSS) so it survives export/print.
    content.appendChild(svgEl("rect", { x: bbox.minX * CS, y: bbox.minY * CS, width: bbox.w * CS, height: bbox.h * CS, fill: "#000000" }));
    const roomsById = new Map(data.rooms.map((room) => [room.id, room] as const));
    const corridorsById = new Map(data.corridors.map((corridor) => [corridor.id, corridor] as const));
    drawPlainRects(content, specs.wallRects);
    drawFloorRects(content, specs.floorRects, roomsById, corridorsById);
    drawPlainRects(content, specs.doorGapRects);
    drawFineGrid(content, bbox);
    drawBoundaryLines(content, specs.boundaryLines);
    for (const door of specs.doors) {
      const doorGroup = drawDoorIcon(content, door);
      doorGroup.style.cursor = "pointer";
      const doorOwner = { kind: "door" as const, id: door.id };
      doorGroup.addEventListener("pointerenter", (e) => {
        showTooltip(doorOwner, doorTooltipLabel(door), e as PointerEvent);
        options.onHoverEntity?.(doorOwner);
      });
      doorGroup.addEventListener("pointermove", (e) => moveTooltip(e as PointerEvent));
      doorGroup.addEventListener("pointerleave", () => {
        hideTooltip();
        options.onHoverEntity?.(null);
      });
      doorGroup.addEventListener("click", () => {
        if (dragMoved) return;
        options.onOpenEntity?.(doorOwner);
      });
    }
    for (const label of specs.roomLabels) drawRoomLabel(content, label);
    for (const label of specs.corridorHeightLabels) drawHeightLabel(content, label);
    for (const stair of specs.stairs) drawStairIcon(content, stair);
  }

  function renderPlaceholder(message: string): void {
    hideTooltip();
    clear();
    resetView();
    svg.setAttribute("viewBox", `0 0 ${20 * CS} ${10 * CS}`);
    const text = svgEl("text", {
      x: 10 * CS,
      y: 5 * CS,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": 14,
      "font-family": "sans-serif",
      fill: "#888888",
    });
    text.textContent = message;
    content.appendChild(text);
  }

  function destroy(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    svg.removeEventListener("pointerdown", onPointerDown);
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("dblclick", onDoubleClick);
    host.removeChild(svg);
    host.removeChild(tooltip);
  }

  return { render, renderPlaceholder, setHoverNoteExcerpt, destroy };
}
