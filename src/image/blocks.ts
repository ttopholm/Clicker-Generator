// Blocks mode: a word becomes one keycap-style block per character (plus optional
// symbol blocks) on a shared base. This module turns the text + symbol slots into
// per-cell glyph inlays in mm for the geometry worker; buildClicker does the solids.
import { FONT_OPTIONS } from './letter';
import { LUCIDE_ICONS, buildSvg } from './lucideIcons';
import { parseSvg } from './logo';
import type { BlocksLayout, BuildCell, RegionSet, RGB, Ring } from '../types';

/** Longest word Blocks mode lays out (each block adds a switch and ~25 mm of base). */
export const MAX_BLOCKS = 12;
/** Body wall between neighbouring wells and around the outside, mm (= borderWidth). */
export const BLOCKS_WALL_MM = 2.6;
/** Flat frame between a block's glyph box and its cap edge, mm (= imageMargin). */
export const BLOCKS_MARGIN_MM = 1.5;

/** Centre-to-centre block distance for a cap size and top↔base tolerance. */
export const blocksPitch = (sizeMm: number, toleranceMm: number): number =>
  sizeMm + 2 * toleranceMm + BLOCKS_WALL_MM;

/** A symbol block inserted before letter `index` (0 = first, text.length = last). */
export interface BlockSymbol {
  index: number;
  icon: string;
}

export type BlockItem =
  | { kind: 'char'; ch: string }
  | { kind: 'symbol'; icon: string }
  | { kind: 'blank' };

/** Default letter colour: a dark ink so the caps are derived light (black on white). */
export const BLOCK_INK: RGB = [22, 22, 22];

/** Characters of the text (single line; spaces become blank blocks) with the symbol
 *  slots interleaved. Symbols pointing past the end of a shortened text are dropped. */
export function blockItems(text: string, symbols: BlockSymbol[]): BlockItem[] {
  const chars = Array.from(text.replace(/[\r\n]+/g, ' ')).slice(0, MAX_BLOCKS);
  const bySlot = new Map<number, string>();
  for (const s of symbols) {
    if (Number.isInteger(s.index) && s.index >= 0 && s.index <= chars.length && s.icon) bySlot.set(s.index, s.icon);
  }
  const items: BlockItem[] = [];
  for (let i = 0; i <= chars.length; i++) {
    const icon = bySlot.get(i);
    if (icon) items.push({ kind: 'symbol', icon });
    if (i < chars.length) items.push(chars[i].trim() ? { kind: 'char', ch: chars[i] } : { kind: 'blank' });
  }
  return items.slice(0, MAX_BLOCKS);
}

export interface BlocksGlyphOptions {
  fontId: string;
  /** Cap side length, mm. */
  size: number;
  /** Glyph box as a fraction of the cap's usable (inside-margin) square. 1 = fill it. */
  letterScale: number;
  /** Flat frame between the glyph box and the cap edge, mm (= BuildParams.imageMargin). */
  margin: number;
}

export interface BlocksGlyphResult {
  /** One cell per item, all at the origin — see `placeBlocks` for positions. */
  cells: BuildCell[];
  /** Palette source: one region (the ink) with one component per cell, so the existing
   *  colour UI and `top-color-0-{cell}` part names line up with the blocks. */
  regionSet: RegionSet;
}

interface Glyph {
  rings: Ring[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Outline + hole rings of one character in font units (size 100, baseline at y = 0). */
function charGlyph(fontId: string, ch: string): Glyph | null {
  const option = FONT_OPTIONS.find((f) => f.id === fontId) || FONT_OPTIONS[0];
  if (!option) return null;
  const rings: Ring[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (pts: { x: number; y: number }[]) => {
    if (pts.length < 3) return;
    const ring: Ring = [];
    for (const p of pts) {
      ring.push([p.x, p.y]);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    rings.push(ring);
  };
  for (const shape of option.font.generateShapes(ch, 100)) {
    const extracted = shape.extractPoints(16);
    add(extracted.shape);
    for (const hole of extracted.holes) add(hole);
  }
  if (!rings.length || !isFinite(minX)) return null;
  return { rings, minX, maxX, minY, maxY };
}

/** A Lucide icon traced to fill rings, normalized to a unit box centred on the origin. */
function symbolRings(icon: string): Ring[] {
  const info = LUCIDE_ICONS.find((ic) => ic.name === icon);
  if (!info) return [];
  try {
    const rs = parseSvg(buildSvg(info.node));
    return rs.regions.flatMap((r) => r.components.flatMap((c) => c.rings));
  } catch {
    return [];
  }
}

const scaleRings = (rings: Ring[], k: number, cx = 0, cy = 0): Ring[] =>
  rings.map((r) => r.map(([x, y]) => [(x - cx) * k, (y - cy) * k] as [number, number]));

/**
 * Trace the items into per-block glyph inlays (mm, centred on each block). Letters share
 * one scale and baseline — the tallest ascender-to-descender span of the word fills the
 * glyph box — so "Name" reads as one typeset word rather than four individually
 * stretched glyphs. Symbols get a slightly smaller box so they visually match cap height.
 */
export function traceBlocks(items: BlockItem[], opts: BlocksGlyphOptions): BlocksGlyphResult {
  const n = items.length;
  const usable = Math.max(1, opts.size - 2 * opts.margin) * Math.max(0.1, opts.letterScale);

  const glyphs = items.map((it) => (it.kind === 'char' ? charGlyph(opts.fontId, it.ch) : null));
  let yMin = Infinity, yMax = -Infinity, wMax = 0;
  for (const g of glyphs) {
    if (!g) continue;
    yMin = Math.min(yMin, g.minY);
    yMax = Math.max(yMax, g.maxY);
    wMax = Math.max(wMax, g.maxX - g.minX);
  }
  const unit = Math.max(yMax - yMin, wMax) || 1;
  const k = usable / unit; // mm per font unit
  const yMid = isFinite(yMin) ? (yMin + yMax) / 2 : 0;

  const cells: BuildCell[] = [];
  const components: RegionSet['regions'][number]['components'] = [];
  for (let i = 0; i < n; i++) {
    const it = items[i];
    let rings: Ring[] = [];
    if (it.kind === 'char') {
      const g = glyphs[i];
      if (g) rings = scaleRings(g.rings, k, (g.minX + g.maxX) / 2, yMid);
    } else if (it.kind === 'symbol') {
      rings = scaleRings(symbolRings(it.icon), usable * 0.8);
    }
    const partName = `top-color-0-${i}`;
    cells.push({
      x: 0,
      y: 0,
      regions: rings.length ? [{ filamentRgb: BLOCK_INK, coverage: 1, rings, partName }] : [],
    });
    components.push({ rings, coverage: rings.length ? 1 : 0 });
  }

  const regionSet: RegionSet = {
    regions: [{ quantRgb: BLOCK_INK, components, coverage: 1 }],
    outline: [],
    aspect: 1,
  };
  return { cells, regionSet };
}

/** Position traced cells in a centred row (first block left) or column (first block top). */
export function placeBlocks(cells: BuildCell[], layout: BlocksLayout, pitch: number): BuildCell[] {
  const n = cells.length;
  return cells.map((c, i) => ({
    ...c,
    x: layout === 'horizontal' ? (i - (n - 1) / 2) * pitch : 0,
    y: layout === 'horizontal' ? 0 : ((n - 1) / 2 - i) * pitch,
  }));
}
