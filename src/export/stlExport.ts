// STL export: the same print layout as the 3MF (base at the origin, top flipped
// face-down beside it, everything on Z = 0) as plain binary STL. STL carries no
// colour, so the ZIP holds one file per printable object (top / base) plus one per
// coloured part, for slicers without 3MF colour support or manual filament mapping.
import { zipSync } from 'fflate';
import type { ClickerPart, PartGroup } from '../types';
import { arrangeForPrint, placeVertex } from './threemfExport';

interface Tri {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
}

function trianglesOf(parts: ClickerPart[], minZ: number, place: (g: PartGroup, x: number, y: number, z: number) => [number, number, number]): Tri[] {
  const tris: Tri[] = [];
  for (const p of parts) {
    const np = p.numProp;
    const v = p.vertProperties;
    const at = (i: number) => place(p.group, v[i * np], v[i * np + 1], v[i * np + 2] - minZ);
    for (let t = 0; t < p.triVerts.length; t += 3) {
      tris.push({ a: at(p.triVerts[t]), b: at(p.triVerts[t + 1]), c: at(p.triVerts[t + 2]) });
    }
  }
  return tris;
}

/** Binary STL (80-byte header, uint32 count, 50 bytes per triangle). */
export function encodeBinaryStl(tris: Tri[], label = 'Clicker Generator'): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = new TextEncoder().encode(label.slice(0, 79));
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const { a, b, c } of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const val of [nx, ny, nz, ...a, ...b, ...c]) {
      dv.setFloat32(off, val, true);
      off += 4;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

const safeName = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'part';

/** ZIP with clicker-top.stl, clicker-base.stl and parts/NN-<name>.stl, all print-placed. */
export function buildStlZip(parts: ClickerPart[]): Uint8Array {
  const { minZ, placements } = arrangeForPrint(parts);
  const place = (g: PartGroup, x: number, y: number, z: number) => placeVertex(placements[g], x, y, z);
  const files: Record<string, Uint8Array> = {};
  for (const g of ['top', 'base'] as PartGroup[]) {
    const groupParts = parts.filter((p) => p.group === g);
    if (!groupParts.length) continue;
    files[`clicker-${g}.stl`] = encodeBinaryStl(trianglesOf(groupParts, minZ, place), `clicker ${g}`);
  }
  parts.forEach((p, i) => {
    const n = String(i + 1).padStart(2, '0');
    files[`parts/${n}-${safeName(p.name)}.stl`] = encodeBinaryStl(trianglesOf([p], minZ, place), p.name);
  });
  files['README.txt'] = new TextEncoder().encode(
    'Clicker Generator STL export\n\n' +
      'clicker-base.stl  the body, resting on its bottom\n' +
      'clicker-top.stl   the cap(s), flipped so the image face lies on the plate\n' +
      'parts/            every coloured part on its own, in the same placement, for\n' +
      '                  manual filament assignment (STL has no colour)\n\n' +
      'All files share one coordinate system, so they line up when imported together.\n',
  );
  return zipSync(files, { level: 6 });
}

export function downloadStlZip(parts: ClickerPart[], fileName = 'clicker-stl.zip') {
  const bytes = buildStlZip(parts);
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
