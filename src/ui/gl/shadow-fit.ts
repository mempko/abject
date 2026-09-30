/**
 * Shadow frustum fitting: light view-projection matrices sized to the
 * casters' world bounds, so a shadow map adapts to any scene with no magic
 * constants. Pure math, shared by the compositor and offline harnesses.
 */

import {
  Mat4, mat4LookAt, mat4Multiply, mat4Ortho, mat4PerspectiveYDown, mat4TransformPoint, vec3,
} from './math.js';
import type { ShadowOpts } from './renderer.js';

export type Vec3Tuple = [number, number, number];

/** The shadow maps rendered for one subtree: one directional, one spot. */
export interface ShadowSet {
  dir?: ShadowOpts;
  spot?: ShadowOpts;
}

/** A fitted shadow camera. `texelWorld` is world px per texel for a 1-texel map (divide by the map size). */
export interface ShadowFit {
  lightVP: Mat4;
  texelWorld: number;
}

function corners(min: Vec3Tuple, max: Vec3Tuple): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  }
  return out;
}

/**
 * Orthographic light camera for a directional light travelling along `dir`,
 * tight around the casters' world AABB.
 */
export function fitDirectionalShadow(min: Vec3Tuple, max: Vec3Tuple, dir: Vec3Tuple): ShadowFit {
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  const radius = Math.max(1, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d: Vec3Tuple = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  const up = Math.abs(d[1]) > 0.99 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  const dist = radius * 2 + 50;
  const eye = vec3(cx - d[0] * dist, cy - d[1] * dist, cz - d[2] * dist);
  const view = mat4LookAt(eye, vec3(cx, cy, cz), up);
  let lminX = Infinity, lminY = Infinity, lminZ = Infinity, lmaxX = -Infinity, lmaxY = -Infinity, lmaxZ = -Infinity;
  for (const c of corners(min, max)) {
    const p = mat4TransformPoint(view, vec3(c[0], c[1], c[2]));
    lminX = Math.min(lminX, p.x); lmaxX = Math.max(lmaxX, p.x);
    lminY = Math.min(lminY, p.y); lmaxY = Math.max(lmaxY, p.y);
    lminZ = Math.min(lminZ, p.z); lmaxZ = Math.max(lmaxZ, p.z);
  }
  const pad = radius * 0.05 + 1;
  const ortho = mat4Ortho(lminX - pad, lmaxX + pad, lminY - pad, lmaxY + pad, -(lmaxZ + dist), -(lminZ - pad));
  return {
    lightVP: mat4Multiply(ortho, view),
    texelWorld: Math.max(lmaxX - lminX, lmaxY - lminY) + 2 * pad,
  };
}

/**
 * Perspective light camera for a spot light at `pos` aiming along `dir` with
 * cone half-angle `angle`, its near/far planes fitted to the casters.
 * Undefined when every caster is behind the light.
 */
export function fitSpotShadow(min: Vec3Tuple, max: Vec3Tuple, pos: Vec3Tuple, dir: Vec3Tuple, angle: number): ShadowFit | undefined {
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d: Vec3Tuple = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  const up = Math.abs(d[1]) > 0.99 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  const view = mat4LookAt(vec3(pos[0], pos[1], pos[2]), vec3(pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]), up);
  let near = Infinity, far = 0;
  for (const c of corners(min, max)) {
    const z = -mat4TransformPoint(view, vec3(c[0], c[1], c[2])).z;   // distance in front of the light
    near = Math.min(near, z);
    far = Math.max(far, z);
  }
  if (far <= 0) return undefined;
  far += 2;
  near = Math.max(far / 2000, near - 2, 1);
  const fov = Math.min(Math.PI * 0.94, 2 * angle * 1.1 + 0.05);
  const proj = mat4PerspectiveYDown(fov, 1, near, far);
  return { lightVP: mat4Multiply(proj, view), texelWorld: 2 * Math.tan(fov / 2) };
}
