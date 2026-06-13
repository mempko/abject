/**
 * Geometry generators for scene-vocabulary mesh nodes. Each returns
 * positions + normals + indices in a unit footprint, scaled by node
 * transforms. Generated once and cached by the renderer per Geometry object.
 */

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  /** 16-bit for the static unit primitives; 32-bit for large custom meshes. */
  indices: Uint16Array | Uint32Array;
}

/** Unit plane in xy, centered, facing +z. */
export function planeGeometry(): Geometry {
  return {
    positions: new Float32Array([
      -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
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
    }
  }
  const stride = widthSegments + 1;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * stride + x;
      idx.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
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
  return { positions, normals, indices };
}

const cache = new Map<string, Geometry>();

/** Shared geometry instances by primitive name (renderer caches VAOs per instance). */
export function getGeometry(kind: 'plane' | 'box' | 'sphere' | 'cylinder'): Geometry {
  let g = cache.get(kind);
  if (!g) {
    g = kind === 'plane' ? planeGeometry()
      : kind === 'box' ? boxGeometry()
      : kind === 'sphere' ? sphereGeometry()
      : cylinderGeometry();
    cache.set(kind, g);
  }
  return g;
}
