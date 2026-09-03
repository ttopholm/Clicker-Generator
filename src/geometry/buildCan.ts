// Soda-can body: the design wraps around the SIDE of a bundled can model instead of
// sitting on a cap. The can (public/assets/shapes/can-body.3mf) already carries a
// 14 × 14 mm pocket for the MX switch — its top face is the switch plate (Z = 0 in the
// assembly frame), so the switch drops in and a lid inside the can's collar presses it.
//
// Colours are carved into the wall as curved inlays: each region is extruded flat in a
// (u = arc length, v = height) label frame, refined, then warped onto the cylinder.
import type { BuildParams, BuildRegion, ClickerPart, PartGroup, Ring, RGB, SwitchPlacement } from '../types';

type Wasm = any;
type Solid = any;
type Section = any;

/** Can dimensions in the assembly frame (the can's top face = switch plate = Z 0). */
export const CAN = {
  /** Radius of the straight wall the label lives on. */
  radius: 15.8,
  /** Where the asset's switch plate sits in its own frame (subtract to normalise). */
  plateZInAsset: 37.1,
  bottomZ: -37.1,
  /** The lid slides inside this collar (radius) and must not exceed its top. */
  collarInnerR: 12.3,
  collarTopZ: 10.75,
  /** Straight-wall band the label may use. */
  labelLoZ: -32.0,
  labelHiZ: 3.5,
  /** Never wrap the label fully around — its ends would meet. */
  labelMaxFraction: 0.9,
  /** Flat part of the bottom (radius) for magnet pockets. */
  bottomFlatR: 13.9,
  /** In the lid asset: Z of the underside that rides on the switch (its stem bars hang below). */
  lidUndersideZInAsset: 3.4,
  /** In the foot asset: Z of the flat top that glues to the can's bottom. */
  footTopZInAsset: 2.5,
};

export function buildCan(
  wasm: Wasm,
  canBody: Solid,
  stem: Solid,
  regions: BuildRegion[],
  outline: Ring[],
  params: BuildParams,
  canLid: Solid | null = null,
  canFoot: Solid | null = null,
): { parts: ClickerPart[]; switchPlacements: SwitchPlacement[]; warnings: string[] } {
  const { Manifold, CrossSection } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(o: T): T => {
    trash.push(o);
    return o;
  };
  const warnings: string[] = [];
  const parts: ClickerPart[] = [];

  const isEmpty = (cs: Section): boolean => {
    try {
      return typeof cs.isEmpty === 'function' ? cs.isEmpty() : false;
    } catch {
      return false;
    }
  };
  const simp = (s: Section, eps = 0.04): Section => {
    try {
      return typeof s.simplify === 'function' ? track(s.simplify(eps)) : s;
    } catch {
      return s;
    }
  };
  const ringArea = (ring: Ring): number => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(a / 2);
  };
  const toPart = (solid: Solid, kind: 'cap' | 'body', group: PartGroup, colorRgb: RGB, name: string): ClickerPart => {
    const mesh = solid.getMesh();
    let volumeMm3: number | undefined;
    let areaMm2: number | undefined;
    try {
      volumeMm3 = solid.volume();
      areaMm2 = solid.surfaceArea();
    } catch {
      /* no estimate */
    }
    return {
      kind, group, colorRgb, name, volumeMm3, areaMm2,
      numProp: mesh.numProp,
      vertProperties: new Float32Array(mesh.vertProperties),
      triVerts: new Uint32Array(mesh.triVerts),
    };
  };

  // --- Label size: the design's longest side = Size (mm), shrunk if it would not fit
  //     the straight wall band or wrap too far around. ---
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of outline) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) { minX = -0.5; maxX = 0.5; minY = -0.5; maxY = 0.5; }
  const nW = maxX - minX || 1;
  const nH = maxY - minY || 1;
  const R = CAN.radius;
  const maxW = 2 * Math.PI * R * CAN.labelMaxFraction;
  const maxH = CAN.labelHiZ - CAN.labelLoZ - 2;
  let scale = Math.max(2, params.capWidthMm);
  const fit = Math.min(1, maxW / (nW * scale), maxH / (nH * scale));
  if (fit < 1) {
    scale *= fit;
    // The default 35 mm just brushes the band limit; only mention a real shrink.
    if (fit < 0.95) warnings.push('Design scaled down to fit around the can.');
  }
  const imgW = nW * scale;
  const imgH = nH * scale;
  const zc = (CAN.labelLoZ + CAN.labelHiZ) / 2;
  const depth = Math.max(0.2, params.imageDepth);
  const labelArea = track(CrossSection.square([imgW + 0.6, imgH + 0.6], true));

  // Flat (u, v, z) prism → curved inlay: z runs from the inlay floor (R − depth) outwards
  // to R + 0.4 so the cutter clears the surface; the inlay part is clipped back to the
  // can so it ends flush with the wall. θ grows with u so text reads left-to-right when
  // viewed from outside (the label faces −Y, towards the default camera).
  const wrap = (prism: Solid): Solid => {
    const refined = track(prism.refineToLength(1.0));
    return track(
      refined.warp((v: [number, number, number]) => {
        const r = R - depth + v[2];
        const th = -Math.PI / 2 + v[0] / R;
        const h = v[1] + zc;
        v[0] = r * Math.cos(th);
        v[1] = r * Math.sin(th);
        v[2] = h;
      }),
    );
  };

  let body: Solid = canBody;
  const ordered = regions.slice().sort((a, b) => (a.coverage ?? 1) - (b.coverage ?? 1));
  let placed2D: Section | null = null;
  for (const r of ordered) {
    const rings = r.rings
      .map((ring) => ring.map(([x, y]) => [x * scale, y * scale] as [number, number]))
      .filter((ring) => ring.length >= 3 && ringArea(ring) > 0.001);
    if (!rings.length) continue;
    let cs: Section = simp(track(new CrossSection(rings, 'NonZero')), 0.03);
    if (params.colorBleed > 0.001) cs = track(cs.offset(params.colorBleed, 'Round', 2.0, 32));
    cs = track(cs.intersect(labelArea));
    if (placed2D) cs = track(cs.subtract(placed2D));
    if (isEmpty(cs)) continue;
    placed2D = placed2D ? track(placed2D.add(cs)) : cs;
    const prism = track(Manifold.extrude(cs, depth + 0.4));
    const cutter = wrap(prism);
    const inlay = track(cutter.intersect(canBody));
    if (inlay.isEmpty()) continue;
    body = track(body.subtract(cutter));
    parts.push(toPart(inlay, 'body', 'base', r.filamentRgb, r.partName));
  }

  // --- Lid: a disc that slides inside the collar, riding on the MX stem, standing a
  //     little proud of the collar so it can be pressed. ---
  const stemBB = stem.boundingBox();
  let stemSized: Solid = stem;
  const stemTol = params.stemTolerance ?? 0;
  if (Math.abs(stemTol) > 0.001) {
    const stemDim = Math.max(stemBB.max[0] - stemBB.min[0], stemBB.max[1] - stemBB.min[1]);
    if (stemDim > 0.1) stemSized = track(stem.scale([Math.max(0.5, (stemDim + stemTol) / stemDim), Math.max(0.5, (stemDim + stemTol) / stemDim), 1]));
  }
  const tol = Math.max(0.05, params.tolerance);
  const lidZ = stemBB.max[2]; // cap underside = stem top
  let lid: Solid;
  if (canLid) {
    // The real can lid (pull tab and all) brings its own stem bars: seat its underside
    // where the app's cap underside would be.
    lid = track(canLid.translate([0, 0, lidZ - CAN.lidUndersideZInAsset]));
  } else {
    const lidR = CAN.collarInnerR - tol;
    const lidH = 3.0;
    lid = track(Manifold.cylinder(lidH, lidR, lidR, 96).translate([0, 0, lidZ]));
    // Soften the top rim a touch (a 0.6 mm chamfer) so it feels like a can lid.
    const chamfer = track(
      track(Manifold.cylinder(0.62, lidR + 1, lidR + 1, 96).translate([0, 0, lidZ + lidH - 0.6]))
        .subtract(track(Manifold.cylinder(0.62, lidR + 1, lidR - 0.6, 96).translate([0, 0, lidZ + lidH - 0.6]))),
    );
    lid = track(lid.subtract(chamfer));
    lid = track(lid.add(stemSized));
  }
  parts.unshift(toPart(lid, 'cap', 'top', params.bodyColorRgb, 'top-base'));

  // --- Foot: the can's concave bottom, glued under the body after printing. It is its
  //     own print object (group 'foot') so it prints flat side down. ---
  if (canFoot) {
    const foot = track(canFoot.translate([0, 0, CAN.bottomZ - CAN.footTopZInAsset]));
    parts.push(toPart(foot, 'body', 'foot', params.baseFilamentRgb, 'base-foot'));
  }

  // --- Magnet pockets in the flat bottom, on a ring clear of the edge chamfer. ---
  const mg = params.magnets;
  if (mg && mg.enabled && mg.count > 0) {
    const pr = Math.max(1.5, (mg.diameterMm + 0.2) / 2);
    const pd = Math.max(0.5, mg.depthMm);
    const n = Math.max(1, Math.min(8, Math.round(mg.count)));
    const ringR = Math.min(10.5, CAN.bottomFlatR - pr - 0.8);
    const gapOk = n === 1 || 2 * ringR * Math.sin(Math.PI / n) >= 2 * pr + 1.0;
    if (ringR < pr + 1 || !gapOk) {
      warnings.push('No room for that many magnets in the can bottom — try fewer or smaller magnets.');
    } else {
      for (let i = 0; i < n; i++) {
        const a = (Math.PI / 2) + (2 * Math.PI * i) / n;
        const pocket = track(
          Manifold.cylinder(pd + 0.02, pr, pr, 48).translate([ringR * Math.cos(a), ringR * Math.sin(a), CAN.bottomZ - 0.01]),
        );
        body = track(body.subtract(pocket));
      }
    }
  }

  parts.push(toPart(body, 'body', 'base', params.baseFilamentRgb, 'base-body'));

  for (const o of trash) {
    try {
      o.delete();
    } catch {
      /* already freed */
    }
  }
  return { parts, switchPlacements: [{ x: 0, y: 0, rotation: 0 }], warnings };
}
