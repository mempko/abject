/**
 * Geometry generators for scene-vocabulary mesh nodes. Each returns
 * positions + normals + indices in a unit footprint, scaled by node
 * transforms. Generated once and cached by the renderer per Geometry object.
 */

import { PolygonShape, Vec2, cleanRing, ringArea, triangulateShape } from './triangulate.js';

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  /** 16-bit for the static unit primitives; 32-bit for large custom meshes. */
  indices: Uint16Array | Uint32Array;
  /** Optional per-vertex RGB (0..1), 3 per vertex — gradients, heatmaps. */
  colors?: Float32Array;
  /** Optional per-vertex UV, 2 per vertex — albedo texturing. */
  uvs?: Float32Array;
}

/** Unit plane in xy, centered, facing +z. */
export function planeGeometry(): Geometry {
  return {
    positions: new Float32Array([
      -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * Flat ring (annulus) in the xy plane facing +z, like 'plane': outer radius
 * 0.5, inner radius 0.36. HUD rings, sigils, targeting reticles; scale it
 * non-uniformly for ellipses. Double-sided in practice (thin, no depth).
 */
export function ringGeometry(segments = 64, inner = 0.36): Geometry {
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    p.push(c * 0.5, s * 0.5, 0, c * inner, s * inner, 0);
    n.push(0, 0, 1, 0, 0, 1);
    uv.push(i / segments, 0, i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const o = i * 2;
    idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

/** Unit cube, centered. */
export function boxGeometry(): Geometry {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: Array<{ n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }> = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  for (const f of faces) {
    const base = p.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>) {
      p.push(
        f.n[0] * 0.5 + f.u[0] * su * 0.5 + f.v[0] * sv * 0.5,
        f.n[1] * 0.5 + f.u[1] * su * 0.5 + f.v[1] * sv * 0.5,
        f.n[2] * 0.5 + f.u[2] * su * 0.5 + f.v[2] * sv * 0.5,
      );
      n.push(...f.n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint16Array(idx) };
}

/** Unit-diameter UV sphere. */
export function sphereGeometry(widthSegments = 24, heightSegments = 16): Geometry {
  const p: number[] = [];
  const n: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      p.push(nx * 0.5, ny * 0.5, nz * 0.5);
      n.push(nx, ny, nz);
      uv.push(u, v);
    }
  }
  const stride = widthSegments + 1;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * stride + x;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), uvs: new Float32Array(uv), indices: new Uint16Array(idx) };
}

/** Unit-diameter cone along y (apex at +0.5, base circle at -0.5). */
export function coneGeometry(radialSegments = 24): Geometry {
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  const apex = p.length / 3; p.push(0, 0.5, 0); n.push(0, 1, 0);
  for (let i = 0; i <= radialSegments; i++) {
    const th = (i / radialSegments) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    p.push(c * 0.5, -0.5, s * 0.5);
    // side normal tilted up toward the apex
    const ny = 0.4472, nl = 0.8944;
    n.push(c * nl, ny, s * nl);
  }
  for (let i = 0; i < radialSegments; i++) idx.push(apex, apex + 1 + i, apex + 1 + i + 1);
  // base cap
  const center = p.length / 3; p.push(0, -0.5, 0); n.push(0, -1, 0);
  for (let i = 0; i <= radialSegments; i++) {
    const th = (i / radialSegments) * Math.PI * 2;
    p.push(Math.cos(th) * 0.5, -0.5, Math.sin(th) * 0.5); n.push(0, -1, 0);
  }
  for (let i = 0; i < radialSegments; i++) idx.push(center, center + 1 + i, center + 1 + i + 1);
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint16Array(idx) };
}

/** Torus in the xz plane (outer radius 0.5, tube radius 0.18). */
export function torusGeometry(radial = 32, tubular = 18, tube = 0.18): Geometry {
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  const R = 0.5 - tube;
  for (let i = 0; i <= radial; i++) {
    const u = (i / radial) * Math.PI * 2;
    const cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= tubular; j++) {
      const v = (j / tubular) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      p.push((R + tube * cv) * cu, tube * sv, (R + tube * cv) * su);
      n.push(cv * cu, sv, cv * su);
    }
  }
  const stride = tubular + 1;
  for (let i = 0; i < radial; i++) {
    for (let j = 0; j < tubular; j++) {
      const a = i * stride + j;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint16Array(idx) };
}

/** Subdivided icosphere (rounder than the UV sphere, no pole pinch). */
export function icosphereGeometry(subdivisions = 2): Geometry {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map<string, number>();
    const next: number[][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a], vb = verts[b];
      const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
      const l = Math.hypot(m[0], m[1], m[2]);
      const idx = verts.length; verts.push([m[0] / l, m[1] / l, m[2] / l]); mid.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const p: number[] = [], n: number[] = [];
  for (const v of verts) { p.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5); n.push(v[0], v[1], v[2]); }
  const idx: number[] = [];
  for (const f of faces) idx.push(f[0], f[1], f[2]);
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint16Array(idx) };
}

/** Unit cylinder along y (diameter 1, height 1), with caps. */
export function cylinderGeometry(radialSegments = 24): Geometry {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  // side
  for (let i = 0; i <= radialSegments; i++) {
    const theta = (i / radialSegments) * Math.PI * 2;
    const c = Math.cos(theta), s = Math.sin(theta);
    p.push(c * 0.5, 0.5, s * 0.5);
    n.push(c, 0, s);
    p.push(c * 0.5, -0.5, s * 0.5);
    n.push(c, 0, s);
  }
  for (let i = 0; i < radialSegments; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  // caps
  for (const top of [1, -1]) {
    const center = p.length / 3;
    p.push(0, 0.5 * top, 0);
    n.push(0, top, 0);
    for (let i = 0; i <= radialSegments; i++) {
      const theta = (i / radialSegments) * Math.PI * 2;
      p.push(Math.cos(theta) * 0.5, 0.5 * top, Math.sin(theta) * 0.5);
      n.push(0, top, 0);
    }
    for (let i = 0; i < radialSegments; i++) {
      if (top === 1) idx.push(center, center + 1 + i + 1, center + 1 + i);
      else idx.push(center, center + 1 + i, center + 1 + i + 1);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint16Array(idx) };
}

/**
 * Per-vertex smooth normals for an indexed triangle mesh: accumulate each
 * face normal onto its three vertices, then normalize. Used when a custom
 * mesh supplies positions/indices but no normals, so arbitrary surfaces
 * (heightfields, deformable water, generated geometry) light correctly
 * without the author hand-computing normals.
 */
export function computeNormals(positions: Float32Array, indices: Uint16Array | Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    // Cross(e1, e2) — magnitude is proportional to triangle area, so larger
    // faces weight the shared-vertex normal more (area-weighted smoothing).
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i] = x / len; normals[i + 1] = y / len; normals[i + 2] = z / len;
  }
  return normals;
}

/**
 * Build a Geometry from arbitrary polygonal data supplied by a scene node's
 * `params.geometry`. `positions` is a flat [x,y,z,...] array; `indices`
 * (flat triangle list) defaults to a sequential triangle soup; `normals`
 * are computed smooth when absent. Indices are 32-bit so meshes can exceed
 * the 65k-vertex 16-bit ceiling (a 200x200 heightfield is 40k vertices).
 */
export function customGeometry(
  rawPositions: ArrayLike<number>,
  rawIndices?: ArrayLike<number>,
  rawNormals?: ArrayLike<number>,
  rawColors?: ArrayLike<number>,
  rawUvs?: ArrayLike<number>,
): Geometry {
  const positions = rawPositions instanceof Float32Array ? rawPositions : Float32Array.from(rawPositions);
  const vertexCount = Math.floor(positions.length / 3);
  const indices = rawIndices
    ? Uint32Array.from(rawIndices)
    : (() => {
        const seq = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) seq[i] = i;
        return seq;
      })();
  const normals = rawNormals && rawNormals.length === positions.length
    ? (rawNormals instanceof Float32Array ? rawNormals : Float32Array.from(rawNormals))
    : computeNormals(positions, indices);
  const colors = rawColors && rawColors.length === vertexCount * 3
    ? (rawColors instanceof Float32Array ? rawColors : Float32Array.from(rawColors))
    : undefined;
  const uvs = rawUvs && rawUvs.length === vertexCount * 2
    ? (rawUvs instanceof Float32Array ? rawUvs : Float32Array.from(rawUvs))
    : undefined;
  return { positions, normals, indices, colors, uvs };
}

const cache = new Map<string, Geometry>();

export type PrimitiveKind = 'plane' | 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'icosphere' | 'ring';

/** Shared geometry instances by primitive name (renderer caches VAOs per instance). */
export function getGeometry(kind: PrimitiveKind): Geometry {
  let g = cache.get(kind);
  if (!g) {
    g = kind === 'plane' ? planeGeometry()
      : kind === 'box' ? boxGeometry()
      : kind === 'sphere' ? sphereGeometry()
      : kind === 'cone' ? coneGeometry()
      : kind === 'torus' ? torusGeometry()
      : kind === 'icosphere' ? icosphereGeometry()
      : kind === 'ring' ? ringGeometry()
      : cylinderGeometry();
    cache.set(kind, g);
  }
  return g;
}

// ── Parametric primitives (shape params) ─────────────────────────────────
//
// capsule, roundedBox, grid, tube, lathe and extrude take options from a mesh
// node's `params.shape`. Like the named primitives above they are unit-sized
// (scaled to px by the node transform) and carry normals and uvs. Each distinct
// shape is generated once and cached (see getShapeGeometry), so the renderer's
// per-Geometry VAO cache also holds.

/** Primitives whose geometry depends on `params.shape`. */
export const SHAPE_PRIMITIVES = ['capsule', 'roundedBox', 'grid', 'tube', 'lathe', 'extrude'] as const;
export type ShapePrimitive = typeof SHAPE_PRIMITIVES[number];

/** Capsule along y, scaled so its total height is 1; radius and length set its proportions. */
export interface CapsuleShape { radius?: number; length?: number; segments?: number }
/** Unit cube with rounded edges and corners. */
export interface RoundedBoxShape { radius?: number; segments?: number }
/** Unit plane in xy facing +z, subdivided into segments[0] x segments[1] quads. */
export interface GridShape { segments?: [number, number] | number }
/** A round tube swept along a smooth path through `path` (unit space). */
export interface TubeShape {
  path?: Array<[number, number, number]>;
  radius?: number;
  segments?: number;
  radialSegments?: number;
  closed?: boolean;
}
/** A profile of [radius, y] points revolved around the y axis. */
export interface LatheShape { points?: Array<[number, number]>; segments?: number }
/** A 2D outline (with optional holes) extruded along z, centred on z = 0. */
export interface ExtrudeShape {
  outline?: Array<[number, number]>;
  holes?: Array<Array<[number, number]>>;
  depth?: number;
  bevel?: number;
  bevelSegments?: number;
}

// Generation limits: user shapes arrive over the wire, so bound the work.
const MAX_SEGMENTS = 512;
const MAX_RADIAL = 128;
const MAX_PATH_POINTS = 1024;
const MAX_OUTLINE_POINTS = 8192;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function intIn(v: unknown, fallback: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(num(v, fallback))));
}

function finalizeGeometry(p: number[], n: number[], uv: number[], idx: number[]): Geometry {
  const vertexCount = p.length / 3;
  return {
    positions: new Float32Array(p),
    normals: new Float32Array(n),
    uvs: new Float32Array(uv),
    indices: vertexCount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
  };
}

/** One ring of a surface of revolution: radius, height, and the profile normal. */
interface ProfilePoint { r: number; y: number; nr: number; ny: number; v: number }

/**
 * Revolve a profile around the y axis. Consecutive profile points form bands;
 * a sharp corner is expressed by two points at the same place with different
 * normals (the band between them has zero height).
 */
function revolveProfile(profile: ProfilePoint[], segments: number): Geometry {
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  const stride = segments + 1;
  for (const pt of profile) {
    for (let i = 0; i <= segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      p.push(pt.r * c, pt.y, pt.r * s);
      const nl = Math.hypot(pt.nr, pt.ny) || 1;
      n.push((pt.nr * c) / nl, pt.ny / nl, (pt.nr * s) / nl);
      uv.push(i / segments, pt.v);
    }
  }
  for (let j = 0; j < profile.length - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * stride + i;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  return finalizeGeometry(p, n, uv, idx);
}

/**
 * Capsule along y (poles at -0.5 and +0.5). The whole shape is scaled so the
 * total height (length + 2 * radius) is 1: radius and length set proportions.
 */
export function capsuleGeometry(radius = 0.25, length = 0.5, radialSegments = 24, capSegments = 8): Geometry {
  const r0 = Math.max(1e-4, radius), l0 = Math.max(0, length);
  const k = 1 / (l0 + 2 * r0);
  const r = r0 * k, half = (l0 * k) / 2;
  const profile: ProfilePoint[] = [];
  // Top cap (y-down world: the top pole sits at -0.5), pole to equator.
  for (let j = 0; j <= capSegments; j++) {
    const phi = (j / capSegments) * (Math.PI / 2);
    profile.push({ r: r * Math.sin(phi), y: -(half + r * Math.cos(phi)), nr: Math.sin(phi), ny: -Math.cos(phi), v: 0 });
  }
  // Bottom cap, equator to pole; the band between the two equators is the barrel.
  for (let j = capSegments; j >= 0; j--) {
    const phi = (j / capSegments) * (Math.PI / 2);
    profile.push({ r: r * Math.sin(phi), y: half + r * Math.cos(phi), nr: Math.sin(phi), ny: Math.cos(phi), v: 0 });
  }
  for (const pt of profile) pt.v = pt.y + 0.5;
  return revolveProfile(profile, radialSegments);
}

/**
 * Unit cube with rounded edges: each face is a grid whose outer rows are
 * spaced by equal angle, and every vertex is pushed onto the rounded shell
 * (inner core box plus a sphere of `radius`). Normals come from the shell,
 * so edges shade smoothly while the flat faces stay flat.
 */
export function roundedBoxGeometry(radius = 0.1, segments = 4): Geometry {
  const r = Math.max(0, Math.min(0.5, radius));
  const s = Math.max(1, Math.min(16, Math.round(segments)));
  const inner = 0.5 - r;
  const coords: number[] = [];
  for (let j = 0; j <= s; j++) coords.push(-(inner + r * Math.tan(((s - j) / s) * (Math.PI / 4))));
  for (let j = 0; j <= s; j++) coords.push(inner + r * Math.tan((j / s) * (Math.PI / 4)));
  const N = coords.length;
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  const faces: Array<{ n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }> = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  const clamp = (x: number) => Math.max(-inner, Math.min(inner, x));
  for (const f of faces) {
    const base = p.length / 3;
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const cu = coords[a], cv = coords[b];
        const px = f.n[0] * 0.5 + f.u[0] * cu + f.v[0] * cv;
        const py = f.n[1] * 0.5 + f.u[1] * cu + f.v[1] * cv;
        const pz = f.n[2] * 0.5 + f.u[2] * cu + f.v[2] * cv;
        const ix = clamp(px), iy = clamp(py), iz = clamp(pz);
        const dx = px - ix, dy = py - iy, dz = pz - iz;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-9) {
          p.push(px, py, pz);
          n.push(f.n[0], f.n[1], f.n[2]);
        } else {
          const nx = dx / len, ny = dy / len, nz = dz / len;
          p.push(ix + nx * r, iy + ny * r, iz + nz * r);
          n.push(nx, ny, nz);
        }
        uv.push(cu + 0.5, cv + 0.5);
      }
    }
    for (let b = 0; b < N - 1; b++) {
      for (let a = 0; a < N - 1; a++) {
        const i0 = base + b * N + a;
        idx.push(i0, i0 + 1, i0 + N + 1, i0, i0 + N + 1, i0 + N);
      }
    }
  }
  return finalizeGeometry(p, n, uv, idx);
}

/** Unit plane in xy facing +z (like 'plane', same uv orientation), subdivided. */
export function gridGeometry(segX = 16, segY = 16): Geometry {
  const sx = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(segX)));
  const sy = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(segY)));
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= sy; j++) {
    const y = j / sy - 0.5;
    for (let i = 0; i <= sx; i++) {
      const x = i / sx - 0.5;
      p.push(x, y, 0);
      n.push(0, 0, 1);
      uv.push(x + 0.5, 0.5 - y);
    }
  }
  const stride = sx + 1;
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * stride + i;
      idx.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride);
    }
  }
  return finalizeGeometry(p, n, uv, idx);
}

type V3 = [number, number, number];

/** Centripetal Catmull-Rom point between p1 and p2 at t in [0, 1]. */
function catmullRom(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const dt = (a: V3, b: V3) => Math.max(1e-6, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5));
  const d0 = dt(p0, p1), d1 = dt(p1, p2), d2 = dt(p2, p3);
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    // Tangents of the non-uniform Catmull-Rom (Barry-Goldman form).
    let t1 = (p1[k] - p0[k]) / d0 - (p2[k] - p0[k]) / (d0 + d1) + (p2[k] - p1[k]) / d1;
    let t2 = (p2[k] - p1[k]) / d1 - (p3[k] - p1[k]) / (d1 + d2) + (p3[k] - p2[k]) / d2;
    t1 *= d1; t2 *= d1;
    const c0 = p1[k], c1 = t1, c2 = -3 * p1[k] + 3 * p2[k] - 2 * t1 - t2, c3 = 2 * p1[k] - 2 * p2[k] + t1 + t2;
    out[k] = c0 + c1 * t + c2 * t * t + c3 * t * t * t;
  }
  return out;
}

/** Sample a smooth curve through `pts` at `count` points spread by arc length. */
function sampleSmoothPath(pts: V3[], count: number, closed: boolean): V3[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lens.push(l);
    total += l;
  }
  const at = (i: number): V3 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) {
      // Reflect the first point so the end tangent stays natural.
      const a = pts[0], b = pts[1];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    if (i >= n) {
      const a = pts[n - 1], b = pts[n - 2];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return pts[i];
  };
  const out: V3[] = [];
  const samples = closed ? count : count + 1;
  let seg = 0, segStart = 0;
  for (let s = 0; s < samples; s++) {
    const d = total > 0 ? (s / count) * total : 0;
    while (seg < segs - 1 && d > segStart + lens[seg]) { segStart += lens[seg]; seg++; }
    const t = lens[seg] > 0 ? Math.min(1, Math.max(0, (d - segStart) / lens[seg])) : 0;
    out.push(catmullRom(at(seg - 1), at(seg), at(seg + 1), at(seg + 2), t));
  }
  return out;
}

function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/**
 * A round tube along a smooth path through `path`. Frames are parallel
 * transported along the curve (no sudden twists); a closed tube spreads the
 * leftover twist evenly so its seam lines up. Open tubes get flat end caps.
 */
export function tubeGeometry(path: Array<[number, number, number]>, radius = 0.05, segments = 64, radialSegments = 12, closed = false): Geometry {
  const pts = path.filter((q) => Array.isArray(q) && q.length >= 3 && q.every((c) => Number.isFinite(c))).slice(0, MAX_PATH_POINTS);
  if (pts.length < 2) pts.splice(0, pts.length, [0, -0.5, 0], [0, 0.5, 0]);
  const isClosed = closed && pts.length >= 3;
  const segs = Math.max(1, Math.min(MAX_SEGMENTS * 4, Math.round(segments)));
  const radial = Math.max(3, Math.min(MAX_RADIAL, Math.round(radialSegments)));
  const centers = sampleSmoothPath(pts as V3[], segs, isClosed);
  const count = centers.length;
  const tangents: V3[] = [];
  for (let i = 0; i < count; i++) {
    const prev = isClosed ? centers[(i - 1 + count) % count] : centers[Math.max(0, i - 1)];
    const next = isClosed ? centers[(i + 1) % count] : centers[Math.min(count - 1, i + 1)];
    tangents.push(norm3([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]));
  }
  // Initial normal: perpendicular to the first tangent, off its smallest axis.
  const t0 = tangents[0];
  const ax = Math.abs(t0[0]), ay = Math.abs(t0[1]), az = Math.abs(t0[2]);
  const seed: V3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const normals: V3[] = [norm3(cross3(t0, cross3(seed, t0)))];
  for (let i = 1; i < count; i++) {
    const prev = normals[i - 1], t = tangents[i];
    const proj: V3 = [prev[0] - t[0] * dot3(prev, t), prev[1] - t[1] * dot3(prev, t), prev[2] - t[2] * dot3(prev, t)];
    normals.push(Math.hypot(proj[0], proj[1], proj[2]) < 1e-6 ? prev : norm3(proj));
  }
  if (isClosed) {
    // Transport once more around the seam and spread the angular mismatch.
    const t = tangents[0], last = normals[count - 1];
    const wrapped = norm3([last[0] - t[0] * dot3(last, t), last[1] - t[1] * dot3(last, t), last[2] - t[2] * dot3(last, t)]);
    const b0 = cross3(t, normals[0]);
    const twist = Math.atan2(dot3(wrapped, b0), dot3(wrapped, normals[0]));
    for (let i = 1; i < count; i++) {
      const a = -twist * (i / count);
      const nn = normals[i], bb = cross3(tangents[i], nn);
      const c = Math.cos(a), s = Math.sin(a);
      normals[i] = norm3([nn[0] * c + bb[0] * s, nn[1] * c + bb[1] * s, nn[2] * c + bb[2] * s]);
    }
  }
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  const rings = isClosed ? count + 1 : count;
  for (let i = 0; i < rings; i++) {
    const k = i % count;
    const c = centers[k], nn = normals[k], bb = cross3(tangents[k], nn);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = nn[0] * ca + bb[0] * sa, dy = nn[1] * ca + bb[1] * sa, dz = nn[2] * ca + bb[2] * sa;
      p.push(c[0] + dx * radius, c[1] + dy * radius, c[2] + dz * radius);
      n.push(dx, dy, dz);
      uv.push(i / (rings - 1), j / radial);
    }
  }
  const stride = radial + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  if (!isClosed) {
    for (const end of [0, count - 1]) {
      const sgn = end === 0 ? -1 : 1;
      const c = centers[end], t = tangents[end], nn = normals[end], bb = cross3(t, nn);
      const center = p.length / 3;
      p.push(c[0], c[1], c[2]); n.push(t[0] * sgn, t[1] * sgn, t[2] * sgn); uv.push(0.5, 0.5);
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = nn[0] * ca + bb[0] * sa, dy = nn[1] * ca + bb[1] * sa, dz = nn[2] * ca + bb[2] * sa;
        p.push(c[0] + dx * radius, c[1] + dy * radius, c[2] + dz * radius);
        n.push(t[0] * sgn, t[1] * sgn, t[2] * sgn);
        uv.push(0.5 + ca * 0.5, 0.5 + sa * 0.5);
      }
      for (let j = 0; j < radial; j++) idx.push(center, center + 1 + j, center + 2 + j);
    }
  }
  return finalizeGeometry(p, n, uv, idx);
}

/**
 * Surface of revolution: `points` are [radius, y] pairs revolved around the
 * y axis. Normals follow the profile; corners sharper than about 40 degrees
 * stay crisp instead of being smoothed over.
 */
export function latheGeometry(points: Array<[number, number]>, segments = 48): Geometry {
  let pts = points
    .filter((q) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]))
    .map((q) => [Math.max(0, q[0]), q[1]] as [number, number])
    .slice(0, MAX_PATH_POINTS);
  pts = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  if (pts.length < 2) pts = [[0.5, -0.5], [0.5, 0.5]];
  const segs = Math.max(3, Math.min(MAX_SEGMENTS, Math.round(segments)));
  // Segment normals in the (r, y) plane: perpendicular to the segment.
  const segN: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dr = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
  }
  // Orient normals away from the axis (the profile may run either way).
  let outward = 0;
  for (let i = 0; i < segN.length; i++) outward += segN[i][0] * ((pts[i][0] + pts[i + 1][0]) / 2 + 1e-3);
  if (outward < 0) for (const s of segN) { s[0] = -s[0]; s[1] = -s[1]; }
  // Arc length for v.
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  const cosSharp = Math.cos((40 * Math.PI) / 180);
  const profile: ProfilePoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [r, y] = pts[i];
    const v = cum[i] / total;
    const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
    if (i === 0 || i === pts.length - 1) {
      const s = i === 0 ? b : a;
      profile.push({ r, y, nr: s[0], ny: s[1], v });
    } else if (a[0] * b[0] + a[1] * b[1] < cosSharp) {
      profile.push({ r, y, nr: a[0], ny: a[1], v });
      profile.push({ r, y, nr: b[0], ny: b[1], v });
    } else {
      profile.push({ r, y, nr: a[0] + b[0], ny: a[1] + b[1], v });
    }
  }
  return revolveProfile(profile, segs);
}

/** Options for extruding 2D shapes into solids. */
export interface ExtrudeOptions {
  /** Total thickness along z; the solid spans -depth/2 .. +depth/2. */
  depth: number;
  /** Rounded edge size (clamped to depth/2); 0 = sharp edges. */
  bevel?: number;
  /** Steps in each rounded edge [3]. */
  bevelSegments?: number;
  /** Side corners turning less than this (radians) shade smooth [~35 deg]. */
  smoothAngle?: number;
}

interface RingFrame {
  pts: Vec2[];
  /** Outward (away from the solid) normal of edge i -> i+1. */
  edgeN: Vec2[];
  /** Unit miter direction at vertex i and its length factor. */
  miter: Vec2[];
  miterLen: number[];
  smooth: boolean[];
}

function ringFrame(pts: Vec2[], smoothCos: number): RingFrame {
  const n = pts.length;
  const edgeN: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    edgeN.push([dy / l, -dx / l]);
  }
  const miter: Vec2[] = [], miterLen: number[] = [], smooth: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = edgeN[(i - 1 + n) % n], b = edgeN[i];
    let mx = a[0] + b[0], my = a[1] + b[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = b[0]; my = b[1]; } else { mx /= ml; my /= ml; }
    miter.push([mx, my]);
    // Miter length is exact up to right angles; sharper corners are clipped
    // (a narrower bevel at spikes instead of an inset poking through the solid).
    miterLen.push(1 / Math.max(0.7, mx * b[0] + my * b[1]));
    smooth.push(a[0] * b[0] + a[1] * b[1] >= smoothCos);
  }
  return { pts, edgeN, miter, miterLen, smooth };
}

function insetRing(f: RingFrame, inset: number): Vec2[] {
  if (inset === 0) return f.pts;
  return f.pts.map((q, i) => [q[0] - f.miter[i][0] * inset * f.miterLen[i], q[1] - f.miter[i][1] * inset * f.miterLen[i]] as Vec2);
}

/** Do any two non-adjacent edges of these rings cross? (Grid-bucketed segment test.) */
function ringsCross(rings: Vec2[][]): boolean {
  const segs: Array<[number, number, number, number]> = [];
  const owner: number[] = [];
  const order: number[] = [];
  const sizes: number[] = [];
  rings.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      segs.push([a[0], a[1], b[0], b[1]]);
      owner.push(ri);
      order.push(i);
    }
    sizes.push(r.length);
  });
  if (segs.length < 4) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [ax, ay, bx, by] of segs) {
    minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
    minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
  }
  const g = Math.max(1, Math.ceil(Math.sqrt(segs.length) / 2));
  const cw = (maxX - minX) / g || 1, ch = (maxY - minY) / g || 1;
  const cells = new Map<number, number[]>();
  segs.forEach(([ax, ay, bx, by], si) => {
    const x0 = Math.min(g - 1, Math.floor((Math.min(ax, bx) - minX) / cw)), x1 = Math.min(g - 1, Math.floor((Math.max(ax, bx) - minX) / cw));
    const y0 = Math.min(g - 1, Math.floor((Math.min(ay, by) - minY) / ch)), y1 = Math.min(g - 1, Math.floor((Math.max(ay, by) - minY) / ch));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = y * g + x;
      let list = cells.get(key);
      if (!list) { list = []; cells.set(key, list); }
      list.push(si);
    }
  });
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (const list of cells.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const si = list[i], sj = list[j];
        if (owner[si] === owner[sj]) {
          const n = sizes[owner[si]];
          const d = Math.abs(order[si] - order[sj]);
          if (d <= 1 || d === n - 1) continue; // neighbours share a vertex
        }
        const [ax, ay, bx, by] = segs[si], [cx, cy, dx, dy] = segs[sj];
        const o1 = orient(ax, ay, bx, by, cx, cy), o2 = orient(ax, ay, bx, by, dx, dy);
        const o3 = orient(cx, cy, dx, dy, ax, ay), o4 = orient(cx, cy, dx, dy, bx, by);
        if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
      }
    }
  }
  return false;
}

/** Profile rings from the front cap edge to the back cap edge. */
function bevelProfile(hd: number, bevel: number, bevelSegs: number): Array<{ inset: number; z: number; nxy: number; nz: number }> {
  const rings: Array<{ inset: number; z: number; nxy: number; nz: number }> = [];
  if (bevel > 0 && bevelSegs > 0) {
    for (let j = 0; j <= bevelSegs; j++) {
      const th = (j / bevelSegs) * (Math.PI / 2);
      rings.push({ inset: bevel * (1 - Math.sin(th)), z: hd - bevel + bevel * Math.cos(th), nxy: Math.sin(th), nz: Math.cos(th) });
    }
    for (let j = bevelSegs; j >= 0; j--) {
      const th = (j / bevelSegs) * (Math.PI / 2);
      rings.push({ inset: bevel * (1 - Math.sin(th)), z: -(hd - bevel + bevel * Math.cos(th)), nxy: Math.sin(th), nz: -Math.cos(th) });
    }
  } else {
    rings.push({ inset: 0, z: hd, nxy: 1, nz: 0 }, { inset: 0, z: -hd, nxy: 1, nz: 0 });
  }
  return rings;
}

/**
 * Extrude filled 2D shapes (outer ring plus holes) into a solid along z,
 * centred on z = 0: a front cap facing +z, a back cap facing -z, and side
 * walls, with an optional rounded bevel. Shared by the 'extrude' primitive
 * and 3D text. Rings may come in either winding.
 */
export function extrudeShapes(shapes: PolygonShape[], opts: ExtrudeOptions): Geometry {
  const depth = Math.max(0, num(opts.depth, 0.2));
  const bevel = Math.max(0, Math.min(depth / 2, num(opts.bevel, 0)));
  const bevelSegs = bevel > 0 ? Math.max(1, Math.min(16, Math.round(num(opts.bevelSegments, 3)))) : 0;
  const smoothCos = Math.cos(num(opts.smoothAngle, (35 * Math.PI) / 180));
  const hd = depth / 2;

  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  // Planar uv scale from the overall bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const prepared: Array<{ outer: Vec2[]; holes: Vec2[][] }> = [];
  for (const s of shapes) {
    const outer = cleanRing(s.outer).slice(0, MAX_OUTLINE_POINTS);
    if (outer.length < 3 || Math.abs(ringArea(outer)) < 1e-12) continue;
    if (ringArea(outer) < 0) outer.reverse();
    const holes: Vec2[][] = [];
    for (const h of s.holes ?? []) {
      const ring = cleanRing(h).slice(0, MAX_OUTLINE_POINTS);
      if (ring.length < 3 || Math.abs(ringArea(ring)) < 1e-12) continue;
      if (ringArea(ring) > 0) ring.reverse();
      holes.push(ring);
    }
    for (const q of outer) {
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]);
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]);
    }
    prepared.push({ outer, holes });
  }
  if (prepared.length === 0) return finalizeGeometry([], [], [], []);
  const uvSize = Math.max(maxX - minX, maxY - minY) || 1;

  for (const shape of prepared) {
    const frames = [shape.outer, ...shape.holes].map((r) => ringFrame(r, smoothCos));

    // A bevel wider than the shape's thinnest part would make the inset rings
    // cross; shrink it for this shape until they are clean (or drop it).
    let b = bevel;
    const crosses = (inset: number) => {
      const inset2 = frames.map((f) => insetRing(f, inset));
      // An edge that flips direction means the inset overshot a narrow part.
      for (let r = 0; r < frames.length; r++) {
        const a = frames[r].pts, c = inset2[r];
        for (let i = 0; i < a.length; i++) {
          const j = (i + 1) % a.length;
          if ((c[j][0] - c[i][0]) * (a[j][0] - a[i][0]) + (c[j][1] - c[i][1]) * (a[j][1] - a[i][1]) <= 0) return true;
        }
      }
      return ringsCross(inset2);
    };
    if (b > 0 && ringsCross(frames.map((f) => f.pts))) b = 0; // the outline itself crosses: no bevel can help
    for (let tries = 0; b > 0 && tries < 4 && crosses(b); tries++) b *= 0.5;
    if (b > 0 && crosses(b)) b = 0;
    const rings = bevelProfile(hd, b, bevelSegs);

    // Caps: triangulate the (bevel-inset) outline once, emit front and back.
    const capShape: PolygonShape = { outer: insetRing(frames[0], b), holes: frames.slice(1).map((f) => insetRing(f, b)) };
    const tri = triangulateShape(capShape);
    for (const [z, nz] of [[hd, 1], [-hd, -1]] as Array<[number, number]>) {
      const base = p.length / 3;
      for (const q of tri.vertices) {
        p.push(q[0], q[1], z);
        n.push(0, 0, nz);
        uv.push((q[0] - minX) / uvSize, (q[1] - minY) / uvSize);
      }
      for (const i of tri.indices) idx.push(base + i);
    }

    // Side walls (and bevel bands), one quad per edge per ring pair.
    for (const f of frames) {
      const cnt = f.pts.length;
      const ringPts = rings.map((r) => insetRing(f, r.inset));
      let along = 0;
      for (let i = 0; i < cnt; i++) {
        const j = (i + 1) % cnt;
        const e = f.edgeN[i];
        const na = f.smooth[i] ? f.miter[i] : e;
        const nb = f.smooth[j] ? f.miter[j] : e;
        const edgeLen = Math.hypot(f.pts[j][0] - f.pts[i][0], f.pts[j][1] - f.pts[i][1]);
        const u0 = along / uvSize, u1 = (along + edgeLen) / uvSize;
        along += edgeLen;
        for (let k = 0; k < rings.length - 1; k++) {
          const r0 = rings[k], r1 = rings[k + 1];
          const base = p.length / 3;
          const quad: Array<[Vec2, Vec2, { nxy: number; nz: number; z: number }, number]> = [
            [ringPts[k][i], na, r0, u0],
            [ringPts[k][j], nb, r0, u1],
            [ringPts[k + 1][j], nb, r1, u1],
            [ringPts[k + 1][i], na, r1, u0],
          ];
          for (const [q, nn, r, u] of quad) {
            p.push(q[0], q[1], r.z);
            const nx = nn[0] * r.nxy, ny = nn[1] * r.nxy, nz = r.nz;
            const nl = Math.hypot(nx, ny, nz) || 1;
            n.push(nx / nl, ny / nl, nz / nl);
            uv.push(u, (hd - r.z) / uvSize);
          }
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  return finalizeGeometry(p, n, uv, idx);
}

/** The 'extrude' primitive: one outline with optional holes. */
export function extrudeGeometry(outline: Array<[number, number]>, holes: Array<Array<[number, number]>> = [], depth = 0.2, bevel = 0, bevelSegments = 3): Geometry {
  const valid = (r: unknown): r is Vec2[] => Array.isArray(r) && r.every((q) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const outer = valid(outline) && outline.length >= 3 ? outline : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as Vec2[];
  const hs = Array.isArray(holes) ? holes.filter(valid) : [];
  return extrudeShapes([{ outer, holes: hs }], { depth, bevel, bevelSegments });
}

/** Build a shape primitive's geometry from its (unvalidated) shape params. */
function buildShapeGeometry(primitive: ShapePrimitive, shape: Record<string, unknown>): Geometry {
  switch (primitive) {
    case 'capsule':
      return capsuleGeometry(num(shape.radius, 0.25), num(shape.length, 0.5), intIn(shape.segments, 24, 3, MAX_RADIAL), 8);
    case 'roundedBox':
      return roundedBoxGeometry(num(shape.radius, 0.1), intIn(shape.segments, 4, 1, 16));
    case 'grid': {
      const seg = shape.segments;
      const sx = Array.isArray(seg) ? num(seg[0], 16) : num(seg, 16);
      const sy = Array.isArray(seg) ? num(seg[1], sx) : num(seg, 16);
      return gridGeometry(sx, sy);
    }
    case 'tube':
      return tubeGeometry(
        Array.isArray(shape.path) ? (shape.path as V3[]) : [],
        Math.max(1e-4, num(shape.radius, 0.05)),
        intIn(shape.segments, 64, 1, MAX_SEGMENTS * 4),
        intIn(shape.radialSegments, 12, 3, MAX_RADIAL),
        shape.closed === true,
      );
    case 'lathe':
      return latheGeometry(Array.isArray(shape.points) ? (shape.points as Array<[number, number]>) : [], intIn(shape.segments, 48, 3, MAX_SEGMENTS));
    case 'extrude':
      return extrudeGeometry(
        Array.isArray(shape.outline) ? (shape.outline as Array<[number, number]>) : [],
        Array.isArray(shape.holes) ? (shape.holes as Array<Array<[number, number]>>) : [],
        Math.max(0, num(shape.depth, 0.2)),
        Math.max(0, num(shape.bevel, 0)),
        intIn(shape.bevelSegments, 3, 1, 16),
      );
  }
}

/** Stable cache key for a shape: sorted keys, numbers rounded to 6 significant digits. */
export function shapeKey(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : 'null';
  if (Array.isArray(value)) return `[${value.map(shapeKey).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${k}:${shapeKey(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function isShapePrimitive(name: unknown): name is ShapePrimitive {
  return typeof name === 'string' && (SHAPE_PRIMITIVES as readonly string[]).includes(name);
}

const SHAPE_CACHE_LIMIT = 64;
const shapeCache = new Map<string, Geometry>();

/**
 * Geometry for any mesh primitive. The parametric ones are generated from
 * `shape` once per distinct shape (bounded LRU cache, so a node that keeps
 * the same shape keeps the same Geometry instance and its VAO); the named
 * ones ignore `shape` and come from getGeometry.
 */
export function getShapeGeometry(primitive: string, shape?: unknown): Geometry {
  if (!isShapePrimitive(primitive)) return getGeometry(primitive as PrimitiveKind);
  const params = shape && typeof shape === 'object' && !Array.isArray(shape) ? (shape as Record<string, unknown>) : {};
  const key = `${primitive}|${shapeKey(params)}`;
  const hit = shapeCache.get(key);
  if (hit) {
    shapeCache.delete(key);
    shapeCache.set(key, hit);
    return hit;
  }
  const g = buildShapeGeometry(primitive, params);
  shapeCache.set(key, g);
  while (shapeCache.size > SHAPE_CACHE_LIMIT) {
    const oldest = shapeCache.keys().next().value as string;
    shapeCache.delete(oldest);
  }
  return g;
}
