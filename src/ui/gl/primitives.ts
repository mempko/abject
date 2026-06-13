/**
 * Geometry generators for scene-vocabulary mesh nodes. Each returns
 * positions + normals + indices in a unit footprint, scaled by node
 * transforms. Generated once and cached by the renderer per Geometry object.
 */

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
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
