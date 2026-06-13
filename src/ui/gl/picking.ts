/**
 * CPU ray picking for the 3D desktop. Surfaces remain the input targets:
 * a screen point becomes a world ray, the ray intersects each slab's plane
 * in its local space, and the hit converts to surface-local pixels — which
 * feeds the existing per-surface alpha test, preserving pixel-precise
 * click-through even when slabs are tilted or lifted.
 */

import { Mat4, Vec3, mat4Invert, mat4TransformDir, mat4TransformPoint, vec3Normalize, vec3Sub } from './math.js';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Build a world-space ray through a CSS-pixel screen point. */
export function rayFromScreen(
  x: number, y: number,
  viewportWidth: number, viewportHeight: number,
  invViewProj: Mat4,
): Ray {
  const nx = (x / viewportWidth) * 2 - 1;
  const ny = 1 - (y / viewportHeight) * 2; // clip space is y-up
  const near = mat4TransformPoint(invViewProj, { x: nx, y: ny, z: -1 });
  const far = mat4TransformPoint(invViewProj, { x: nx, y: ny, z: 1 });
  return { origin: near, dir: vec3Normalize(vec3Sub(far, near)) };
}

/**
 * Intersect a ray with a scene-vocabulary mesh primitive under `model`.
 * The ray is transformed into the primitive's unit-sized local space
 * (box/plane span -0.5..0.5, sphere/cylinder have radius 0.5). Returns the
 * world-space distance `t` along the ray to the nearest hit, or null.
 */
export function rayMeshHit(
  ray: Ray,
  model: Mat4,
  primitive: 'plane' | 'box' | 'sphere' | 'cylinder',
): number | null {
  const inv = mat4Invert(model);
  const o = mat4TransformPoint(inv, ray.origin);
  const d = mat4TransformDir(inv, ray.dir);

  let tLocal: number | null = null;
  if (primitive === 'plane') {
    if (Math.abs(d.z) < 1e-8) return null;
    const t = -o.z / d.z;
    if (t < 0) return null;
    const lx = o.x + d.x * t;
    const ly = o.y + d.y * t;
    if (lx < -0.5 || lx > 0.5 || ly < -0.5 || ly > 0.5) return null;
    tLocal = t;
  } else if (primitive === 'sphere') {
    // |o + t d|^2 = 0.25
    const a = d.x * d.x + d.y * d.y + d.z * d.z;
    const b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
    const c = o.x * o.x + o.y * o.y + o.z * o.z - 0.25;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a);
    const t1 = (-b + sq) / (2 * a);
    const t = t0 >= 0 ? t0 : t1;
    if (t < 0) return null;
    tLocal = t;
  } else {
    // box and (approximated) cylinder: unit AABB slab test
    let tMin = -Infinity;
    let tMax = Infinity;
    const oArr = [o.x, o.y, o.z];
    const dArr = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dArr[i]) < 1e-9) {
        if (oArr[i] < -0.5 || oArr[i] > 0.5) return null;
        continue;
      }
      const inv1 = 1 / dArr[i];
      let t0 = (-0.5 - oArr[i]) * inv1;
      let t1 = (0.5 - oArr[i]) * inv1;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      if (t0 > tMin) tMin = t0;
      if (t1 < tMax) tMax = t1;
      if (tMin > tMax) return null;
    }
    const t = tMin >= 0 ? tMin : tMax;
    if (t < 0) return null;
    tLocal = t;
  }

  // Convert local t to world-space distance: transform the local hit point
  // back to world and measure along the original ray.
  const hitLocal = { x: o.x + d.x * tLocal, y: o.y + d.y * tLocal, z: o.z + d.z * tLocal };
  const hitWorld = mat4TransformPoint(model, hitLocal);
  const dx = hitWorld.x - ray.origin.x;
  const dy = hitWorld.y - ray.origin.y;
  const dz = hitWorld.z - ray.origin.z;
  return Math.hypot(dx, dy, dz);
}

/**
 * Intersect a ray with a slab's local z=0 plane. The slab is a unit quad
 * (-0.5..0.5) under `model` (which bakes in its px size). Returns
 * surface-local pixel coordinates, or null when the ray misses the quad.
 */
export function raySurfaceHit(
  ray: Ray,
  model: Mat4,
  widthPx: number,
  heightPx: number,
): { x: number; y: number } | null {
  const inv = mat4Invert(model);
  const o = mat4TransformPoint(inv, ray.origin);
  const d = mat4TransformDir(inv, ray.dir);
  if (Math.abs(d.z) < 1e-8) return null;
  const t = -o.z / d.z;
  if (t < 0) return null;
  const lx = o.x + d.x * t;
  const ly = o.y + d.y * t;
  if (lx < -0.5 || lx > 0.5 || ly < -0.5 || ly > 0.5) return null;
  return { x: (lx + 0.5) * widthPx, y: (ly + 0.5) * heightPx };
}
