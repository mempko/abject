/**
 * Node cameras and the orbit controller for a window's own 3D view.
 *
 * `buildNodeCamera` turns an eye / target pair into the matrices the
 * compositor draws and picks with (the same shape as its SceneCamera). The
 * projection is OFF-AXIS, the trick `windowCamera` in compositor.ts uses:
 * the principal point (where the view axis lands) is shifted to an anchor
 * in screen px, so a window's scene converges on the window's own centre
 * instead of the middle of the screen, wherever the window sits.
 *
 * `OrbitController` is the client-side interaction for a `camera` node with
 * `orbit` / `zoom`: pointer drags turn the eye around the target, the wheel
 * dollies, releases coast to a stop (damped inertia), and every angle and
 * distance stays within its clamps. Nothing streams per frame over the wire;
 * the compositor reports `cameraChange` to the owner, throttled.
 *
 * Coordinates are the scene's: px, y-down, +z toward the viewer. "Up" for a
 * camera is therefore [0, -1, 0] unless the caller says otherwise.
 */

import {
  Mat4, mat4LookAt, mat4Multiply, mat4PerspectiveYDown, mat4Invert, mat4TransformPoint, vec3,
} from './math.js';
import { CAMERA_FOV_Y, cameraDistance, NEAR_PLANE_FACTOR, FAR_PLANE_FACTOR } from './camera.js';

export type Vec3Tuple = [number, number, number];

export interface NodeCameraOptions {
  /** Eye position (world px). */
  eye: Vec3Tuple;
  /** Point the camera looks at (world px). */
  target: Vec3Tuple;
  /** Screen-up direction in world space [0, -1, 0]. */
  up?: Vec3Tuple;
  /** Vertical field of view, radians [the desktop's CAMERA_FOV_Y]. */
  fovY?: number;
  /** Viewport size in CSS px. */
  screenW: number;
  screenH: number;
  /** Screen px where the view axis (the target) lands. */
  anchorX: number;
  anchorY: number;
  /** Clip planes, px from the eye [the desktop's: cameraDistance(screenH) x NEAR/FAR factors, widened to reach the target]. */
  near?: number;
  far?: number;
  /** Focal-length multiplier on top of fovY [1]: a view zoom the host camera applies (2 = everything twice as large). */
  zoom?: number;
}

/** Matrices for drawing and picking through a node camera. */
export interface NodeCamera {
  viewProj: Mat4;
  invViewProj: Mat4;
  cameraPos: Vec3Tuple;
  view: Mat4;
  proj: Mat4;
  /** World-space unit vectors: screen right, screen up, and the view direction. */
  right: Vec3Tuple;
  up: Vec3Tuple;
  forward: Vec3Tuple;
}

function norm(v: Vec3Tuple): Vec3Tuple {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function finite3(v: readonly number[] | undefined, def: Vec3Tuple): Vec3Tuple {
  if (!v || v.length < 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return def;
  return [v[0], v[1], v[2]];
}

/**
 * Build an off-axis perspective camera looking from `eye` at `target`, with
 * the target projected onto (anchorX, anchorY). With the eye straight over
 * the anchor's world point at the desktop distance, this reproduces the
 * compositor's windowCamera exactly.
 */
export function buildNodeCamera(o: NodeCameraOptions): NodeCamera {
  const W = Math.max(1, o.screenW);
  const H = Math.max(1, o.screenH);
  const eye = finite3(o.eye, [0, 0, cameraDistance(H)]);
  const target = finite3(o.target, [0, 0, 0]);
  let upIn = norm(finite3(o.up, [0, -1, 0]));
  if (upIn[0] === 0 && upIn[1] === 0 && upIn[2] === 0) upIn = [0, -1, 0];

  let fwd = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  if (fwd[0] === 0 && fwd[1] === 0 && fwd[2] === 0) fwd = [0, 0, -1];
  // An up parallel to the view direction has no roll; borrow a perpendicular one.
  if (Math.abs(fwd[0] * upIn[0] + fwd[1] * upIn[1] + fwd[2] * upIn[2]) > 0.9999) {
    upIn = Math.abs(fwd[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0];
  }
  const dist = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const D = cameraDistance(H);
  const near = typeof o.near === 'number' && o.near > 0 ? o.near : Math.max(1, Math.min(D * NEAR_PLANE_FACTOR, dist * 0.25));
  const far = typeof o.far === 'number' && o.far > near ? o.far : Math.max(D * FAR_PLANE_FACTOR, dist * 4, near * 2);
  const fovY = typeof o.fovY === 'number' && o.fovY > 0.01 && o.fovY < Math.PI - 0.01 ? o.fovY : CAMERA_FOV_Y;

  // mat4LookAt maps its `up` argument to view +y, and the y-down projection
  // puts view +y at the BOTTOM of the screen, so hand it the down vector.
  const view = mat4LookAt(vec3(eye[0], eye[1], eye[2]), vec3(target[0], target[1], target[2]), vec3(-upIn[0], -upIn[1], -upIn[2]));
  const proj = mat4PerspectiveYDown(fovY, W / H, near, far);
  const zoom = typeof o.zoom === 'number' && Number.isFinite(o.zoom) && o.zoom > 0 ? o.zoom : 1;
  proj[0] *= zoom;
  proj[5] *= zoom;
  // Off-axis shift: NDC_x = m0*x/w - proj[8], NDC_y = m5*y/w - proj[9].
  // Solve for the view axis (x_view = y_view = 0) landing on the anchor.
  proj[8] = 1 - (2 * o.anchorX) / W;
  proj[9] = (2 * o.anchorY) / H - 1;
  const viewProj = mat4Multiply(proj, view);

  // Camera basis straight from the view matrix rows: row 0 = right, row 1 =
  // view +y (screen down), row 2 = backward.
  const right: Vec3Tuple = [view[0], view[4], view[8]];
  const up: Vec3Tuple = [-view[1], -view[5], -view[9]];
  return { viewProj, invViewProj: mat4Invert(viewProj), cameraPos: eye, view, proj, right, up, forward: fwd };
}

/** Where a world point lands on screen (CSS px, y-down) through a camera. */
export function projectToScreen(viewProj: Mat4, p: Vec3Tuple, screenW: number, screenH: number): [number, number] {
  const n = mat4TransformPoint(viewProj, vec3(p[0], p[1], p[2]));
  return [(n.x + 1) * 0.5 * screenW, (1 - n.y) * 0.5 * screenH];
}

// ── Orbit controller ────────────────────────────────────────────────────

export interface OrbitOptions {
  /** Closest / farthest eye-to-target distance in px [initial / 4, initial x 4]. */
  minDistance?: number;
  maxDistance?: number;
  /** Elevation limits in radians, positive = eye above the target [-85 deg, 85 deg]. */
  minPitch?: number;
  maxPitch?: number;
  /** Fraction of coasting speed lost per 60 fps frame after a release, 0..1 [0.1]; 1 = no coasting. */
  damping?: number;
  /** Radians of turn per px dragged [0.006]. */
  rotateSpeed?: number;
  /** Dolly factor per wheel delta unit, exponential [0.0015]. */
  zoomSpeed?: number;
}

const DEG = Math.PI / 180;

/**
 * Orbit state: the eye sits `distance` px from `target`, turned `yaw`
 * radians around the vertical axis (0 = on the +z side, toward the viewer)
 * and raised `pitch` radians above it. Pointer drags turn it, the wheel
 * dollies, `update` advances coasting and dolly easing.
 */
export class OrbitController {
  target: Vec3Tuple;
  yaw: number;
  pitch: number;
  distance: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly minPitch: number;
  readonly maxPitch: number;
  readonly damping: number;
  readonly rotateSpeed: number;
  readonly zoomSpeed: number;

  /** Fastest coasting turn after a release, rad/s. */
  static readonly MAX_COAST_SPEED = 12;

  private goalDistance: number;
  private velYaw = 0;
  private velPitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;

  constructor(eye: Vec3Tuple, target: Vec3Tuple, opts: OrbitOptions = {}) {
    this.target = finite3(target, [0, 0, 0]);
    const e = finite3(eye, [this.target[0], this.target[1], this.target[2] + 1000]);
    const { yaw, pitch, distance } = OrbitController.anglesOf(e, this.target);
    const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
    const ang = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.minDistance = pos(opts.minDistance, Math.max(1, distance / 4));
    this.maxDistance = Math.max(this.minDistance, pos(opts.maxDistance, Math.max(this.minDistance, distance * 4)));
    this.minPitch = Math.max(-89 * DEG, ang(opts.minPitch, -85 * DEG));
    this.maxPitch = Math.min(89 * DEG, Math.max(this.minPitch, ang(opts.maxPitch, 85 * DEG)));
    const d = ang(opts.damping, 0.1);
    this.damping = Math.min(1, Math.max(0.001, d));
    this.rotateSpeed = pos(opts.rotateSpeed, 0.006);
    this.zoomSpeed = pos(opts.zoomSpeed, 0.0015);
    this.yaw = yaw;
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, distance));
    this.goalDistance = this.distance;
  }

  /** Yaw / pitch / distance of an eye relative to a target. */
  static anglesOf(eye: Vec3Tuple, target: Vec3Tuple): { yaw: number; pitch: number; distance: number } {
    const dx = eye[0] - target[0], dy = eye[1] - target[1], dz = eye[2] - target[2];
    const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
    const pitch = Math.asin(Math.max(-1, Math.min(1, -dy / distance)));
    const yaw = Math.atan2(dx, dz);
    return { yaw, pitch, distance };
  }

  /** The eye position for the current angles and distance. */
  get eye(): Vec3Tuple {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] - this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  get isDragging(): boolean { return this.dragging; }

  /** True while coasting or easing a dolly (the render loop should keep running). */
  get moving(): boolean {
    return this.dragging || this.velYaw !== 0 || this.velPitch !== 0 || this.goalDistance !== this.distance;
  }

  /**
   * Adopt a new eye / target (the owner moved the camera node). Motion stops;
   * the clamps stay. Ignored mid-drag so the user keeps control.
   */
  setView(eye: Vec3Tuple, target: Vec3Tuple): void {
    if (this.dragging) return;
    this.target = finite3(target, this.target);
    const { yaw, pitch, distance } = OrbitController.anglesOf(finite3(eye, this.eye), this.target);
    this.yaw = yaw;
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    this.distance = this.goalDistance = Math.min(this.maxDistance, Math.max(this.minDistance, distance));
    this.velYaw = this.velPitch = 0;
  }

  pointerDown(x: number, y: number, timeMs: number): void {
    this.dragging = true;
    this.lastX = x; this.lastY = y; this.lastT = timeMs;
    this.velYaw = this.velPitch = 0;
  }

  /** Turn by a pointer move. Returns true if the view changed. */
  pointerMove(x: number, y: number, timeMs: number): boolean {
    if (!this.dragging) return false;
    const dYaw = -(x - this.lastX) * this.rotateSpeed;
    const dPitch = (y - this.lastY) * this.rotateSpeed;
    // Coalesced events can share a timestamp; half a frame is the floor.
    const dt = Math.max(8, timeMs - this.lastT) / 1000;
    this.lastX = x; this.lastY = y; this.lastT = timeMs;
    if (dYaw === 0 && dPitch === 0) return false;
    const before = this.pitch;
    this.yaw += dYaw;
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch + dPitch));
    // Smoothed release velocity (rad/s) from the recent moves, capped so a
    // flick coasts briskly without spinning the scene into a blur.
    const cap = OrbitController.MAX_COAST_SPEED;
    this.velYaw = Math.max(-cap, Math.min(cap, this.velYaw * 0.3 + (dYaw / dt) * 0.7));
    this.velPitch = Math.max(-cap, Math.min(cap, this.velPitch * 0.3 + ((this.pitch - before) / dt) * 0.7));
    return true;
  }

  /** End a drag; the view coasts on from the release velocity unless the pointer had paused. */
  pointerUp(timeMs: number): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (timeMs - this.lastT > 80 || this.damping >= 1) { this.velYaw = this.velPitch = 0; }
  }

  /** Dolly by a wheel delta (positive = away from the target). */
  wheel(deltaY: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    this.goalDistance = Math.min(this.maxDistance, Math.max(this.minDistance, this.goalDistance * Math.exp(deltaY * this.zoomSpeed)));
  }

  /** Advance coasting and dolly easing by `dtMs`. Returns true while still moving. */
  update(dtMs: number): boolean {
    const dt = Math.min(0.25, Math.max(0, dtMs / 1000));
    if (!this.dragging && (this.velYaw !== 0 || this.velPitch !== 0)) {
      this.yaw += this.velYaw * dt;
      const p = this.pitch + this.velPitch * dt;
      this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, p));
      if (this.pitch !== p) this.velPitch = 0;
      const keep = Math.pow(1 - this.damping, dt * 60);
      this.velYaw *= keep;
      this.velPitch *= keep;
      if (Math.abs(this.velYaw) < 0.01) this.velYaw = 0;
      if (Math.abs(this.velPitch) < 0.01) this.velPitch = 0;
    }
    if (this.goalDistance !== this.distance) {
      const a = 1 - Math.pow(0.75, dt * 60);
      this.distance += (this.goalDistance - this.distance) * a;
      if (Math.abs(this.goalDistance - this.distance) < Math.max(1e-3, this.goalDistance * 1e-4)) this.distance = this.goalDistance;
    }
    // Keep yaw bounded so long spins never lose float precision.
    if (Math.abs(this.yaw) > 4 * Math.PI) this.yaw = ((this.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return this.moving;
  }
}
