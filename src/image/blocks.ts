// Blocks mode: a word becomes one keycap-style block per character (plus optional
// symbol blocks) on a shared base. This module turns the text + symbol slots into
// per-cell glyph inlays in mm for the geometry worker; buildClicker does the solids.
import { FONT_OPTIONS } from './letter';
import { LUCIDE_ICONS, buildSvg } from './lucideIcons';
import { parseSvg } from './logo';
import { processImage } from './pipeline';
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

/** What a symbol block shows: a Lucide icon by name, or an emoji character. */
export type SymbolSpec = { icon: string; emoji?: undefined } | { emoji: string; icon?: undefined };

/** A symbol block inserted before letter `index` (0 = first, text.length = at the end).
 *  Several symbols may share a slot; they keep their array order. */
export type BlockSymbol = { index: number } & SymbolSpec;

/** Colours an emoji is quantized to (each becomes a filament slot in the palette). */
export const EMOJI_COLORS = 4;

/** Emoji are drawn with the device's own emoji font (Apple / Segoe / Noto Color Emoji),
 *  so they look like the ones the user picks. Different systems draw them differently. */
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", "EmojiOne Color", sans-serif';

const emojiCache = new Map<string, RegionSet | null>();

/** True when the string is (mostly) an emoji / pictograph rather than plain text. */
export function looksLikeEmoji(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  try {
    return /\p{Extended_Pictographic}/u.test(t);
  } catch {
    return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t);
  }
}

/**
 * Rasterize an emoji with the system emoji font and run it through the image pipeline
 * (matte → quantize → trace), giving a multi-colour RegionSet normalized to a unit box.
 * Returns null when nothing was drawn (no emoji font, or an unsupported character).
 */
export function traceEmoji(emoji: string, px = 320, colors = EMOJI_COLORS): RegionSet | null {
  const key = `${emoji.trim()}@${colors}`;
  if (emojiCache.has(key)) return emojiCache.get(key)!;
  let result: RegionSet | null = null;
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.clearRect(0, 0, px, px);
        ctx.font = `${Math.round(px * 0.66)}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000';
        ctx.fillText(emoji.trim(), px / 2, px / 2 + px * 0.04);
        const img = ctx.getImageData(0, 0, px, px);
        let inked = 0;
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 40) inked++;
        // A real glyph covers a good part of the box; a missing-glyph box or nothing at all
        // does not qualify.
        if (inked > px * px * 0.02) {
          const rs = processImage({ data: img.data, width: px, height: px }, colors, {
            removeBg: true,
            smoothing: 0.15,
          });
          if (rs.regions.length && rs.outline.length) result = rs;
        }
      }
    }
  } catch {
    result = null;
  }
  emojiCache.set(key, result);
  return result;
}

/** Number of characters that become blocks (single line, capped). */
export function blockChars(text: string): string[] {
  return Array.from(text.replace(/[\r\n]+/g, ' ')).slice(0, MAX_BLOCKS);
}

/** Keep every symbol attached to a valid slot after the text changed: a symbol that
 *  pointed past the (now shorter) end moves to the end instead of vanishing. */
export function normalizeSymbols(symbols: BlockSymbol[], text: string): BlockSymbol[] {
  const n = blockChars(text).length;
  return symbols
    .filter((s) => s && Number.isFinite(s.index) && (!!s.icon || !!s.emoji))
    .map((s) => ({
      ...(s.emoji ? { emoji: s.emoji } : { icon: s.icon! }),
      index: Math.max(0, Math.min(n, Math.round(s.index))),
    }) as BlockSymbol);
}

/** Array position of the `pos`-th symbol in `slot`, or where a new one would go
 *  (after the slot's existing symbols, keeping slots in ascending order). */
function symbolArrayIndex(symbols: BlockSymbol[], slot: number, pos: number): { found: number; insertAt: number } {
  let seen = 0;
  let insertAt = symbols.length;
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i].index === slot) {
      if (seen === pos) return { found: i, insertAt: i };
      seen++;
      insertAt = i + 1;
    } else if (symbols[i].index > slot && seen === 0 && insertAt === symbols.length) {
      insertAt = i;
    }
  }
  return { found: -1, insertAt };
}

/** Insert a symbol in `slot` at position `pos` among that slot's symbols. */
export function insertSymbol(symbols: BlockSymbol[], slot: number, pos: number, sym: SymbolSpec): BlockSymbol[] {
  const next = symbols.slice();
  const { insertAt } = symbolArrayIndex(symbols, slot, pos);
  next.splice(insertAt, 0, { index: slot, ...sym } as BlockSymbol);
  return next;
}

/** Replace (icon) or remove (null) the `pos`-th symbol in `slot`. */
export function replaceSymbol(symbols: BlockSymbol[], slot: number, pos: number, sym: SymbolSpec | null): BlockSymbol[] {
  const { found } = symbolArrayIndex(symbols, slot, pos);
  if (found < 0) return sym ? insertSymbol(symbols, slot, pos, sym) : symbols;
  const next = symbols.slice();
  if (sym) next[found] = { index: slot, ...sym } as BlockSymbol;
  else next.splice(found, 1);
  return next;
}

export type BlockItem =
  | { kind: 'char'; ch: string }
  | { kind: 'symbol'; icon: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'blank' };

const symbolItem = (s: SymbolSpec): BlockItem =>
  s.emoji ? { kind: 'emoji', emoji: s.emoji } : { kind: 'symbol', icon: s.icon ?? '' };

/** Default letter colour: a dark ink so the caps are derived light (black on white). */
export const BLOCK_INK: RGB = [22, 22, 22];

/** Characters of the text (single line; spaces become blank blocks) with the symbol
 *  slots interleaved. Symbols pointing past the end of a shortened text are dropped. */
export function blockItems(text: string, symbols: BlockSymbol[]): BlockItem[] {
  const chars = blockChars(text);
  const items: BlockItem[] = [];
  for (let i = 0; i <= chars.length; i++) {
    for (const s of symbols) {
      // Symbols past the end (text got shorter) show at the end rather than vanish.
      if ((s.icon || s.emoji) && Math.min(chars.length, Math.max(0, s.index)) === i) items.push(symbolItem(s));
    }
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
  // Palette region 0 is the letter/symbol ink; every emoji colour gets its own region
  // after it (so each can be mapped to a filament), with the emoji's cell as component.
  const regions: RegionSet['regions'] = [{ quantRgb: BLOCK_INK, components: [], coverage: 1 }];
  for (let i = 0; i < n; i++) {
    const it = items[i];
    let rings: Ring[] = [];
    const cellRegions: BuildCell['regions'] = [];
    if (it.kind === 'char') {
      const g = glyphs[i];
      if (g) rings = scaleRings(g.rings, k, (g.minX + g.maxX) / 2, yMid);
    } else if (it.kind === 'symbol') {
      rings = scaleRings(symbolRings(it.icon), usable * 0.8);
    } else if (it.kind === 'emoji') {
      const rs = traceEmoji(it.emoji);
      for (const r of rs?.regions ?? []) {
        const rr = scaleRings(r.components.flatMap((c) => c.rings), usable * 0.9);
        if (!rr.length) continue;
        const j = regions.length;
        const partName = `top-color-${j}-${i}`;
        // Low coverage keeps the letters the "dominant ink" that the cap colour contrasts.
        regions.push({ quantRgb: r.quantRgb, components: [{ rings: rr, coverage: r.coverage }], coverage: r.coverage * 0.5 });
        cellRegions.push({ filamentRgb: r.quantRgb, coverage: r.coverage, rings: rr, partName });
      }
    }
    if (rings.length) cellRegions.push({ filamentRgb: BLOCK_INK, coverage: 1, rings, partName: `top-color-0-${i}` });
    cells.push({ x: 0, y: 0, regions: cellRegions });
    regions[0].components.push({ rings, coverage: rings.length ? 1 : 0 });
  }

  const regionSet: RegionSet = { regions, outline: [], aspect: 1 };
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
