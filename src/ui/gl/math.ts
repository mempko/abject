/**
 * Minimal column-major matrix/vector math for the WebGL2 compositor.
 *
 * Conventions match OpenGL: column-major Float32Array(16) matrices,
 * right-handed clip space. The desktop world is x-right, y-DOWN (matching
 * every rect in the system); the projection matrix bakes in the y flip, so
 * face culling is disabled in the renderer rather than fighting winding.
 */

export type Mat4 = Float32Array; // length 16, column-major
export type Mat3 = Float32Array; // length 9, column-major
export type Vec3 = { x: number; y: number; z: number };

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function mat4Identity(out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  // m = a * b (apply b first, then a)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    m[c * 4]     = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    m[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    m[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    m[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return m;
}

/**
 * Perspective projection with y flipped so +y points DOWN on screen,
 * matching the 2D rect coordinate system used everywhere else.
 */
export function mat4PerspectiveYDown(fovY: number, aspect: number, near: number, far: number, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  const f = 1 / Math.tan(fovY / 2);
  m[0] = f / aspect;
  m[5] = -f; // y flip: world y-down → clip y-up
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** Translation matrix. */
export function mat4Translation(x: number, y: number, z: number, out?: Mat4): Mat4 {
  const m = mat4Identity(out);
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

/**
 * Compose a model matrix from translate · rotateX · rotateY · rotateZ · scale.
 * Euler angles in radians. Enough expressiveness for slabs and scene nodes;
 * quaternions can come later if anything needs interpolation.
 */
export function mat4TRS(
  tx: number, ty: number, tz: number,
  rx: number, ry: number, rz: number,
  sx: number, sy: number, sz: number,
  out?: Mat4,
): Mat4 {
  const m = out ?? new Float32Array(16);
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);

  // R = Rx * Ry * Rz
  const r00 = cy * cz;
  const r01 = -cy * szr;
  const r02 = syr;
  const r10 = cx * szr + sxr * syr * cz;
  const r11 = cx * cz - sxr * syr * szr;
  const r12 = -sxr * cy;
  const r20 = sxr * szr - cx * syr * cz;
  const r21 = sxr * cz + cx * syr * szr;
  const r22 = cx * cy;

  m[0] = r00 * sx; m[1] = r10 * sx; m[2] = r20 * sx; m[3] = 0;
  m[4] = r01 * sy; m[5] = r11 * sy; m[6] = r21 * sy; m[7] = 0;
  m[8] = r02 * sz; m[9] = r12 * sz; m[10] = r22 * sz; m[11] = 0;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

/** General 4x4 inverse (Cramer/cofactor). Returns identity for singular input. */
export function mat4Invert(a: Mat4, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return mat4Identity(m);
  det = 1.0 / det;

  m[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  m[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  m[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  m[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  m[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  m[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  m[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  m[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  m[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  m[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  m[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  m[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  m[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  m[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  m[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  m[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return m;
}

/** Transform a point (w=1) by a matrix, with perspective divide. */
export function mat4TransformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  const inv = w !== 0 ? 1 / w : 1;
  return { x: x * inv, y: y * inv, z: z * inv };
}

/**
 * Normal matrix: transpose(inverse(upper-left 3x3 of model)). Lets normals
 * stay perpendicular to the surface under non-uniform scale (ellipsoids,
 * stretched water grids), which a bare mat3(model) gets wrong.
 */
export function mat3NormalMatrix(m: Mat4): Mat3 {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  let det = a * A + b * B + c * C;
  const out = new Float32Array(9);
  if (!det) { out[0] = out[4] = out[8] = 1; return out; }
  det = 1 / det;
  // inverse(M3)^T, column-major
  out[0] = A * det;            out[1] = B * det;            out[2] = C * det;
  out[3] = (c * h - b * i) * det; out[4] = (a * i - c * g) * det; out[5] = (b * g - a * h) * det;
  out[6] = (b * f - c * e) * det; out[7] = (c * d - a * f) * det; out[8] = (a * e - b * d) * det;
  return out;
}

/** Transform a direction (w=0) by a matrix (no translation, no divide). */
export function mat4TransformDir(m: Mat4, d: Vec3): Vec3 {
  return {
    x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
    y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
    z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
  };
}

/** Normal matrix is fine as the upper 3x3 of the model matrix for uniform scale; we pass the model matrix and renormalize in-shader. */

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
