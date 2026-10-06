/**
 * 3D compositor for rendering object surfaces.
 *
 * Every window surface is a slab in a WebGL2 scene: its content is still an
 * OffscreenCanvas painted by the 2D draw-command vocabulary, uploaded as a
 * texture onto rounded slab geometry rendered with a perspective camera.
 * Scene-vocabulary nodes (meshes, lights) attach to a window's subtree and
 * travel with it. The compositor stays behaviorally dumb — it renders state
 * and resolves picking; decisions stay server-side.
 */

import { AbjectId } from '../core/types.js';
import { require, ensure } from '../core/contracts.js';
import { Tween, DECELERATE, ACCELERATE } from './motion.js';
import type { DrawCommandType } from '../objects/widgets/widget-types.js';
import { CANVAS_CTX_METHODS, CANVAS_CTX_PROPERTIES, TITLE_BAR_HEIGHT } from '../objects/widgets/widget-types.js';
import { GlRenderer, parseCssColor, RGBA, MeshLight, DynamicMesh, InstancedMesh, MeshInstance, FogOpts, DrawMode, ShadowOpts } from './gl/renderer.js';
import { srgbToLinear, linearToSrgb } from './gl/renderer.js';
import { MAX_MESH_LIGHTS } from './gl/shaders.js';
import { CAMERA_FOV_Y, cameraDistance, NEAR_PLANE_FACTOR, FAR_PLANE_FACTOR } from './gl/camera.js';

/**
 * A camera the scene is drawn (and picked) through. The desktop has one; each
 * window's own 3D subtree gets another, whose eye sits over that window so its
 * depth converges into the window instead of toward the middle of the screen.
 * See Compositor.windowCamera.
 */
interface SceneCamera {
  viewProj: Mat4;
  invViewProj: Mat4;
  cameraPos: [number, number, number];
}
import { Overlay2D } from './gl/overlay-2d.js';
import { SceneStore, VocabNode } from './gl/scene.js';
import { SceneOp, SceneTheme, MeshPrimitive, CustomGeometryParam, resolveSceneColor, hasCustomGeometry } from './gl/scene-types.js';
import { getGeometry, getShapeGeometry, customGeometry, Geometry, isShapePrimitive, shapeKey } from './gl/primitives.js';
// Content kinds: models, 3D text, labels, lines, trails, sky.
import {
  parseGltf, decodeDataUri, flattenScene, drawItemsBounds, primitiveGeometry, sampleAnimation, animationTime,
  findAnimation, isTrianglePrimitive, GLTF_MODE, GltfDocument, GltfDrawItem, GltfPrimitive,
} from './gl/gltf.js';
import { getTextGeometry, clearTextGeometryCache, ensureTextFont } from './gl/text-geometry.js';
import { renderLabel, labelKey, cssFont, LabelOptions } from './gl/label-texture.js';
import { LineRenderer, LineHandle, Trail } from './gl/line-renderer.js';
import { SkyRenderer } from './gl/sky-renderer.js';
import { contextGeneration, programError } from './gl/program-cache.js';
import { cubicBezier, STANDARD, LINEAR, EMPHASIZE } from './motion.js';
import {
  SlabEffectSpec, SlabMotionConfig, MotionTrack, BUILTIN_SLAB_EFFECTS, DEFAULT_SLAB_MOTION,
  sampleTrack, channelNeutral,
} from './gl/slab-motion.js';
import { SceneLibraryConfig, BUILTIN_SCENE_LIBRARY } from './gl/scene-presets.js';
import {
  resolveMaterial, materialDrawOpts, resolveLight, resolveEnvironment, defaultKeyLight, surfaceWorldY, resolveSky,
  withMaterialPreset, withLookPreset, ResolvedEnvironment, ResolvedLight,
} from './gl/material.js';
import { fitDirectionalShadow, fitSpotShadow, ShadowFit, ShadowSet, Vec3Tuple } from './gl/shadow-fit.js';
import { PostEffects, PostPass, hasPostEffects } from './gl/post-effects.js';
import type { MeshMaterialOpts } from './gl/renderer.js';
import { EasingCurve } from '../core/theme-data.js';
import { Mat4, mat4Identity, mat4Multiply, mat4PerspectiveYDown, mat4Translation, mat4TRS, mat4Invert, mat4LookAt, mat4Ortho, mat4TransformPoint, vec3 } from './gl/math.js';
import { rayFromScreen, raySurfaceHit, rayMeshHit, rayCustomMeshHit, Ray } from './gl/picking.js';
// Interaction: dragging, stacking, clip modes, windows riding nodes.
import { mat4StripScale, mat4TransformDir, vec3Add, vec3Scale, vec3Sub, vec3Dot, vec3Cross, vec3Normalize, vec3Length, Vec3 } from './gl/math.js';
import { rayPlaneT, projectToScreen, raySurfacePlane } from './gl/picking.js';
import { ClipMode, clipModeOf, parseDraggable, DragSpec, RAIL_Z_THRESHOLD, isScreenAnchor, type ScreenAnchor } from './gl/scene-types.js';
// Motion: GPU particles, keyframe / spring tracks, constraints, node cameras.
import { GpuParticles, billboardBasis } from './gl/gpu-particles.js';
import {
  KeyframeTrack, Spring, buildKeyframeTrack, sampleKeyframes, createSpring, retargetSpring, stepSpring,
  lookAtEuler, followStep, MOTION_PRESETS, expandMotionPreset,
} from './gl/anim-tracks.js';
import { buildNodeCamera, OrbitController } from './gl/orbit-camera.js';
import { bytesToBase64 } from '../core/encoding.js';

/** A picked interactive scene node (what input routing needs to reach its owner). */
export interface NodeHit {
  scope: 'window' | 'world';
  surfaceId?: string;
  ownerId?: string;
  nodeId: string;
}

/**
 * A drag of a `draggable` node, reported through Compositor.onNodeDrag.
 * `position` is the dragged node's transform.position in its parent space.
 */
export interface NodeDragEvent extends NodeHit {
  phase: 'start' | 'move' | 'end';
  /** The node the pointer pressed (the dragged node or a descendant). */
  hitNodeId: string;
  position: [number, number, number];
}

/**
 * A window's camera node moved under the user's hand (orbit drag, wheel
 * dolly, or the coast after a release). `position` (the eye) and `target`
 * are in the camera node's parent space, like its transform.position and
 * params.target. 'start' is the press, 'end' the moment it comes to rest.
 */
export interface CameraChangeEvent {
  phase: 'start' | 'move' | 'end';
  surfaceId: string;
  nodeId: string;
  position: [number, number, number];
  target: [number, number, number];
}

/** A scene node a window slab rides (see Compositor.setSurfaceAttachment). */
export interface SurfaceAttachment {
  scope: 'world' | 'window';
  ownerId?: string;
  surfaceId?: string;
  nodeId: string;
  offset?: [number, number, number];
}

/** Internal pick result: the public hit plus the ray geometry drags need. */
interface NodePick extends NodeHit {
  key: string;
  ray: Ray;
  t: number;
  cam: SceneCamera;
  frame: Mat4;
}

/** Client-side orbit state for one camera node (see Compositor.cameraFor). */
interface OrbitCam {
  surfaceId: string;
  nodeId: string;
  ctl: OrbitController;
  /** The orbit options the controller was built with (rebuilt when they change). */
  sig: string;
  /** The pose last written into the node, to tell the owner's own moves apart. */
  eye: [number, number, number];
  target: [number, number, number];
  lastT: number;
  /** Whether the last step moved (an 'end' follows when it stops). */
  active: boolean;
}

/** One entry of the desktop depth order: a window, or a stacked world root. */
type DesktopItem =
  | { kind: 'surface'; surface: Surface; z: number }
  | { kind: 'stack'; key: string; rootId: string; z: number };

/**
 * How a window is placed for picking: its unscaled frame (what its subtree
 * hangs from), its slab model, the camera both render through, and whether
 * it is transformed beyond an upright screen rect (tilted or riding a node),
 * which switches clip tests from rects to projected quads.
 */
interface WindowView {
  frame: Mat4;
  slab: Mat4;
  cam: SceneCamera;
  free: boolean;
  /** The camera the window's 3D subtree renders through when a `camera` node replaces `cam` (see cameraFor). */
  sceneCam?: SceneCamera;
}

/**
 * A camera view of the desktop: a workspace point on the z=0 plane lands at
 * screen = (workspace - scroll) * zoom. The phone's camera is one; a window
 * pinned to the screen (screenAnchor) is drawn through its own (see pinView).
 */
interface ScreenView {
  zoom: number;
  scrollX: number;
  scrollY: number;
}

/** A drag of a `draggable` node in progress (pointer held, or gliding on inertia). */
interface NodeDragSession {
  hit: NodeHit;
  key: string;
  nodeId: string;
  hitNodeId: string;
  spec: DragSpec;
  /** Viewport px of the press (the drag starts past a small threshold). */
  startX: number;
  startY: number;
  /** The node's position at the press, in its parent space. */
  startPos: [number, number, number];
  /** The pressed point, in the parent space. */
  anchor: Vec3;
  /** Drag plane normal and in-plane axes, in the parent space. */
  normal: Vec3;
  basis: [Vec3, Vec3];
  /** Single-axis constraint (parent space). */
  axis?: Vec3;
  /**
   * Screen px per parent unit along basis[0] / basis[1] (or along `axis`
   * in j1). Set for axis drags and for planes seen nearly edge-on, where a
   * ray-plane hit would run away; the pointer delta is solved on screen.
   */
  screen?: { j1: { x: number; y: number }; j2: { x: number; y: number } };
  started: boolean;
  /** Released with speed: gliding on inertia until it settles. */
  released: boolean;
  pos: [number, number, number];
  /** Parent units per second (EMA of the last moves). */
  vel: [number, number, number];
  lastT: number;
}

/**
 * What the phone shows. The phone is a camera on the real desktop (the same
 * scene renderDesktop draws), so every state is a camera pose or a pose of
 * the slabs; nothing reflows and no backend rect changes.
 * - DESKTOP: the whole desktop through a zoomable, pannable camera.
 * - FOCUS: the camera has flown in on one window (or 3D object); one finger
 *   scrolls the content under it.
 * - EXPOSE: the visible windows spread into a grid to pick or close one.
 */
export enum MobileViewState {
  DESKTOP = 'desktop',
  FOCUS = 'focus',
  EXPOSE = 'expose',
}

/** One window's place in the Exposé grid (workspace centre and scale), and its glide after a re-layout. */
interface ExposeSlot {
  cx: number;
  cy: number;
  s: number;
  title: string;
  /** Reading-order position (the desktop staggers flights by it). */
  index: number;
  /** Where it glides from after a re-layout, since moveStart (performance.now ms). */
  from?: { cx: number; cy: number; s: number };
  moveStart?: number;
  /** A window that joined the open grid (it flies in from its own rect). */
  joining?: boolean;
}

/** A phone camera pose: the workspace point at the viewport's top-left, and the zoom. */
interface MobileCam {
  x: number;
  y: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screen-space bounding rect (CSS px, y-down) of a slab's unit quad
 * (local [-0.5, 0.5]) under `model` and `viewProj`, grown by `pad`. Returns
 * undefined when any corner is behind the camera or the rect is empty.
 *
 * Exported so the projection can be checked without a GL context.
 */
export function projectUnitQuadToCss(
  model: ArrayLike<number>, viewProj: ArrayLike<number>,
  cssWidth: number, cssHeight: number, pad = 0,
): Rect | undefined {
  // mvp = viewProj × model, but only the columns a z=0 quad needs.
  const col = (m: ArrayLike<number>, c: number) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]];
  const mul = (v: number[]) => [
    viewProj[0] * v[0] + viewProj[4] * v[1] + viewProj[8] * v[2] + viewProj[12] * v[3],
    viewProj[1] * v[0] + viewProj[5] * v[1] + viewProj[9] * v[2] + viewProj[13] * v[3],
    viewProj[2] * v[0] + viewProj[6] * v[1] + viewProj[10] * v[2] + viewProj[14] * v[3],
    viewProj[3] * v[0] + viewProj[7] * v[1] + viewProj[11] * v[2] + viewProj[15] * v[3],
  ];
  const mx = mul(col(model, 0)), my = mul(col(model, 1)), mt = mul(col(model, 3));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
    const cx = mx[0] * x + my[0] * y + mt[0];
    const cy = mx[1] * x + my[1] * y + mt[1];
    const cw = mx[3] * x + my[3] * y + mt[3];
    if (cw <= 0) return undefined;
    const sx = (cx / cw * 0.5 + 0.5) * cssWidth;
    const sy = (0.5 - cy / cw * 0.5) * cssHeight;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  }
  // Snap away float noise before widening: the matrices are Float32Arrays,
  // so an edge at 700 arrives as 700.00003 and Math.ceil would make it 701.
  // A thousandth of a CSS pixel is far above float32 error at screen scale
  // and far below anything a scissor can see.
  const EPS = 1e-3;
  const x0 = Math.max(0, Math.floor(minX - pad + EPS)), y0 = Math.max(0, Math.floor(minY - pad + EPS));
  const x1 = Math.min(cssWidth, Math.ceil(maxX + pad - EPS)), y1 = Math.min(cssHeight, Math.ceil(maxY + pad - EPS));
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** How far (CSS px) a window's glow may extend past its own edge. */
const BLOOM_SPILL_PX = 24;

export interface Surface {
  id: string;
  objectId: AbjectId;
  rect: Rect;
  zIndex: number;
  visible: boolean;
  inputPassthrough: boolean;
  inputMonitor: boolean;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  dirty: boolean;
  tainted: boolean;      // canvas tainted by a cross-origin image; texture upload is unsafe, render the last-good texture
  drawn: boolean;        // false until first draw batch; prevents rendering empty surfaces
  transparent: boolean;  // window paints no background; skip the focus-glow halo (it would bleed through)
  closable: boolean;     // the phone's Exposé may flick this closed (false for system rails)
  chromeless: boolean;   // no title bar: window 3D clipped to the content uses the whole rect
  /** Pinned to this spot of the screen on the phone's zoomable camera (see pinPlacement). */
  screenAnchor?: ScreenAnchor;
  workspaceId?: string;  // undefined = always visible (global objects)
  title?: string;        // window title (the phone's Exposé labels)
}

export interface DrawCommand {
  type: DrawCommandType;
  surfaceId: string;
  params: unknown;
  /**
   * Target a canvas-layer scene node (kind:'canvas') on the surface instead
   * of the surface's own texture. Layer painting is incremental: commands
   * accumulate on the layer's pixels; 'clear' restarts it.
   */
  nodeId?: string;
}

export interface RectParams {
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  radius?: number;
}

export interface TextParams {
  x: number;
  y: number;
  text: string;
  font?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  maxWidth?: number;
}

export interface LineParams {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: string;
  lineWidth?: number;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export interface ImageParams {
  x: number;
  y: number;
  width?: number;
  height?: number;
  // Optional source rectangle (drawImage 9-arg form)
  sx?: number;
  sy?: number;
  sWidth?: number;
  sHeight?: number;
  data: ImageBitmap | HTMLImageElement | ImageData;
}

export interface ImageUrlParams {
  x: number;
  y: number;
  width?: number;
  height?: number;
  // Optional source rectangle (drawImage 9-arg form)
  sx?: number;
  sy?: number;
  sWidth?: number;
  sHeight?: number;
  url: string;
}

/**
 * Marks a surface rect as a live video region. The named client-side video
 * element (registered via registerVideoElement) composites into this rect on
 * every animation frame while it plays; the command itself paints nothing.
 * Regions go stale when a later full surface redraw (a bare `clear`) arrives
 * without re-emitting them, which stops the per-frame blit for widgets that
 * scrolled off-screen or were removed.
 */
export interface VideoFrameParams {
  videoId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Scroll-viewport clip in surface coordinates (from ScrollableVBox). */
  clipTop?: number;
  clipBottom?: number;
  hidden?: boolean;
}

export interface PathParams {
  path: Path2D | string;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export interface CircleParams {
  cx: number;
  cy: number;
  // Canvas-API dialect aliases for cx/cy
  x?: number;
  y?: number;
  radius: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface ArcParams {
  cx: number;
  cy: number;
  // Canvas-API dialect aliases for cx/cy (ctx.arc takes x, y)
  x?: number;
  y?: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  counterclockwise?: boolean;
}

export interface EllipseParams {
  cx: number;
  cy: number;
  // Canvas-API dialect aliases for cx/cy (ctx.ellipse takes x, y)
  x?: number;
  y?: number;
  radiusX: number;
  radiusY: number;
  rotation?: number;
  startAngle?: number;
  endAngle?: number;
  counterclockwise?: boolean;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface PolygonParams {
  points: Array<{ x: number; y: number }>;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  closePath?: boolean;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export interface BezierCurveParams {
  x0: number;
  y0: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  x1: number;
  y1: number;
  stroke?: string;
  lineWidth?: number;
  fill?: string;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export interface QuadraticCurveParams {
  x0: number;
  y0: number;
  cpx: number;
  cpy: number;
  x1: number;
  y1: number;
  stroke?: string;
  lineWidth?: number;
  fill?: string;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export interface ShadowParams {
  color: string;
  blur: number;
  offsetX?: number;
  offsetY?: number;
}

export interface GradientStop {
  offset: number;
  color: string;
}

export interface LinearGradientParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: GradientStop[];
}

export interface RadialGradientParams {
  cx0: number;
  cy0: number;
  r0: number;
  cx1: number;
  cy1: number;
  r1: number;
  stops: GradientStop[];
}

/**
 * Conic gradient descriptor (createConicGradient has no high-level command
 * interface of its own beyond this).
 */
export interface ConicGradientParams {
  startAngle: number;
  cx: number;
  cy: number;
  stops: GradientStop[];
}

/**
 * Draw an image honoring the optional dest size and source rectangle
 * (the drawImage 3/5/9-argument forms).
 */
function blitImage(
  ctx: OffscreenCanvasRenderingContext2D,
  img: CanvasImageSource,
  p: ImageParams | ImageUrlParams,
): void {
  if (p.sx !== undefined && p.sy !== undefined && p.sWidth !== undefined && p.sHeight !== undefined) {
    ctx.drawImage(img, p.sx, p.sy, p.sWidth, p.sHeight, p.x, p.y, p.width ?? p.sWidth, p.height ?? p.sHeight);
  } else if (p.width && p.height) {
    ctx.drawImage(img, p.x, p.y, p.width, p.height);
  } else {
    ctx.drawImage(img, p.x, p.y);
  }
}

/**
 * The compositor manages surfaces and renders them to a canvas.
 */
/** Per-surface GPU + animation state managed by the compositor. */
interface SurfaceGlState {
  texture?: WebGLTexture;
  /** Model matrix from the last sync (used for ray picking). */
  model: Mat4;
  /** Drag tilt (radians), spring-settled toward the decaying target. */
  tiltX: number;
  tiltY: number;
  tiltTargetX: number;
  tiltTargetY: number;
  /** Focus lift toward the camera (px), eased toward its target. */
  lift: number;
  /** Abject-requested slab transform (setSurfaceTransform). */
  userRotation?: [number, number, number];
  userZ?: number;
  lastMoveX?: number;
  lastMoveY?: number;
  // ── Motion (client-side, visual only; see "Motion" in Compositor) ──
  /** True once the slab has been on screen (its first appearance plays the open transition). */
  seen?: boolean;
  /** Running slab effects (lifecycle transitions and owner-played effects). */
  effects?: SlabEffectRun[];
  /** Surface is a modal: while it shows, every other slab recedes. */
  modal?: boolean;
  /** Eased 0..1 recede amount (other windows while a modal shows). */
  recede?: number;
  /** Frame (unscaled window matrix) and camera the window drew with this frame. */
  frame?: Mat4;
  cam?: SceneCamera;
  // ── Riding a scene node (setSurfaceAttachment) ──
  /** The node this slab rides; undefined for an ordinary window. */
  attach?: SurfaceAttachment;
  /** Surface rect position when attached: later drags move it relative to the anchor. */
  attachOrigin?: { x: number; y: number };
  /** Anchor frame and camera from the last draw (ghosts of closed attached windows reuse them). */
  attachFrame?: Mat4;
  attachCam?: SceneCamera;
  /** Pinned to the screen (screenAnchor): the view it drew through last frame (its ghost reuses it). */
  pinView?: ScreenView;
  /** Phone camera zoomed out: the slab texture carries a mip chain for its current pixels. */
  slabMips?: boolean;
}

/** One playing slab effect: its spec, clock, resolved colours and particles. */
interface SlabEffectRun {
  spec: SlabEffectSpec;
  /** performance.now() it starts (may lie ahead: staggered transitions hold their first frame). */
  start: number;
  curve: EasingCurve;
  rim: RGBA;
  aura: RGBA;
  scan: RGBA;
  particle: RGBA;
  /** Particles seeded at play time, px from the slab centre (velocities px/s). */
  particles?: Array<{ x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; square: boolean }>;
}

/** A slab still animating after its surface went away (closed) or hid (minimized). */
interface SlabGhost {
  surface: Surface;
  state: SurfaceGlState;
  run: SlabEffectRun;
  kind: 'close' | 'minimize';
}

/** The composite of every effect running on a slab this frame. */
interface SlabPose {
  dx: number; dy: number; dz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number;
  opacity: number; dim: number;
  rim?: RGBA;
  auras: Array<{ color: RGBA; spread: number }>;
  scans: Array<{ color: RGBA; pos: number }>;
  bursts: SlabEffectRun[];
  moving: boolean;
}

/**
 * One running declarative animation channel on a scene node. Evaluated each
 * frame against performance.now(); writes straight into the node's retained
 * transform/params so rendering and picking see the animated values.
 */
interface NodeAnim {
  channel: 'position' | 'rotation' | 'scale' | 'color' | 'emissive' | 'opacity' | 'orbit';
  from: number[];
  to: number[];
  start: number;          // performance.now() of channel start (delay already applied)
  duration: number;
  curve: EasingCurve;
  loop: boolean;
  yoyo: boolean;
  /** Orbit: circle center, radius, and plane. */
  center?: [number, number, number];
  radius?: number;
  plane?: 'xy' | 'xz' | 'yz';
  /** Position path: piecewise-linear waypoints traversed over duration. */
  path?: number[][];
  /** Keyframes (op keyframes, or a data preset like wobble): sampled instead of from/to. */
  track?: KeyframeTrack;
  /** Spring physics toward `to` (op spring): stepped per frame, retargetable. */
  spring?: Spring;
  /** performance.now() of the spring's last step. */
  lastT?: number;
}

export class Compositor {
  private canvas: HTMLCanvasElement;
  private renderer: GlRenderer;
  private overlay: Overlay2D;
  private sceneStore = new SceneStore();
  /**
   * GPU buffers for mesh nodes carrying custom `params.geometry`, keyed by
   * full node key (`<surfaceKey>/<nodeId>`). Rebuilt only when the node's
   * geometry revision changes; entries not drawn in a frame are pruned (and
   * their GL buffers freed) at frame end, which covers node removal, surface
   * destruction, and minimized windows in one place.
   */
  private customMeshes = new Map<string, { rev: number; geom: Geometry; handle: DynamicMesh }>();
  /**
   * Instanced meshes (one geometry, many copies) keyed by full node key. Base
   * geometry rebuilds when its signature changes; the instance buffer
   * re-uploads when the params.instances array reference changes.
   */
  private instancedMeshes = new Map<string, { baseSig: string; instRef: unknown; handle: InstancedMesh }>();
  /** Node keys whose custom/instanced mesh was drawn this frame; drives pruning. */
  private touchedCustomMeshes = new Set<string>();
  private touchedInstanced = new Set<string>();
  /** Mesh albedo textures loaded from URL/data-URI, cached by source string. */
  private meshTextures = new Map<string, { tex: WebGLTexture; loaded: boolean }>();
  /**
   * Active declarative animations, keyed by full node key. Driven entirely
   * client-side off the render loop, so a spinning cube or rippling pulse is
   * ONE 'animate' scene op instead of a transform message every frame.
   */
  private nodeAnims = new Map<string, { surfaceKey: string; id: string; anims: NodeAnim[] }>();
  /**
   * Bloom post-effect config per surface key, set by that surface's
   * 'environment' node. A window's bloom is applied to that window's screen
   * rect only; a world-scene (`world:<owner>`) environment blooms the whole
   * desktop, since the world scene IS the desktop. It used to be one global
   * field: a single game enabling bloom for its own neon put a halo on every
   * bright pixel of every window on screen, screenshots included.
   */
  private bloomBySurface = new Map<string, { nodeId: string; threshold: number; intensity: number; levels: number; radius: number }>();
  /**
   * Surfaces whose model matrix was set THIS frame. `SurfaceGlState.model` is
   * kept between frames for picking, so on a phone — where only the focused
   * window is drawn — an unfocused window still carries the matrix from the
   * last time it was on screen. Bloom must key off what was drawn, not what
   * has a matrix, or an unfocused neon window glows a rect that now shows
   * something else.
   */
  private drawnThisFrame = new Set<string>();
  private sceneTheme?: SceneTheme;
  private surfaceGl: Map<string, SurfaceGlState> = new Map();
  /** Owners with world-scope scene nodes (keys into sceneStore: `world:<ownerId>`). */
  private worldKeys: Set<string> = new Set();
  private viewProj: Mat4 = mat4Identity();
  private invViewProj: Mat4 = mat4Identity();
  private cameraPos: [number, number, number] = [0, 0, 1];
  private surfaces: Map<string, Surface> = new Map();
  private sortedSurfaces: Surface[] = [];
  private animationFrameId?: number;
  private needsRender = false;
  private activeWorkspaceId?: string;
  // Focused window gets an accent rim + bloom and lifts toward the camera.
  private focusedSurfaceId?: string;
  private focusGlowColor = 'rgba(91, 229, 160, 0.45)'; // Red Sigil living light
  private focusGlowRadius = 7; // window corner radius, so the halo matches the window
  private imageCache: Map<string, { img: HTMLImageElement; loaded: boolean }> = new Map();
  private static IMAGE_CACHE_MAX = 100;
  private liveDataImages: Map<string, { img: HTMLImageElement; width: number; height: number }> = new Map();
  /** videoId → client video element (lifecycle owned by FrontendClient). */
  private videoElements: Map<string, HTMLVideoElement> = new Map();
  /** videoId → live surface region the element composites into per frame. */
  private videoRegions: Map<string, {
    surfaceId: string;
    x: number; y: number; width: number; height: number;
    clipTop?: number; clipBottom?: number;
    hidden: boolean;
    /** Must match the surface's stamp to stay live (see surfaceVideoStamps). */
    stamp: number;
    /** currentTime at last paint; repaint only when it moves (or first paint). */
    lastTime: number;
  }> = new Map();
  /** Per-surface full-redraw counter, bumped by each bare `clear` command. */
  private surfaceVideoStamps: Map<string, number> = new Map();
  /** Camera field of view; distance derives so the z=0 plane is ~1:1 px. */
  /** Defined in ./gl/camera.js so WidgetManager can report the same projection
   *  to scene authors (getSceneParams) instead of a prompt guessing at it. */
  private static readonly CAMERA_FOV = CAMERA_FOV_Y;
  /** Focus lift in px toward the camera — subtle enough that server-side
   * rect math (resize edges) stays within a few px of the projection. */
  private static readonly FOCUS_LIFT = 14;
  private static readonly TILT_MAX = 0.05; // radians

  // ── Desktop scroll state ──
  /**
   * Viewport scroll offset in workspace coords. Workspace content is drawn
   * translated by (-scrollX, -scrollY); mouse events are translated the
   * opposite way before hit-testing. Workspace size = max(viewport, bbox of
   * all surfaces). Users pan via wheel (over empty area), middle-click drag,
   * or the scrollbar thumbs.
   */
  private scrollX = 0;
  private scrollY = 0;
  private static readonly SCROLLBAR_SIZE = 10;
  private static readonly SCROLLBAR_MARGIN = 2;
  private scrollbarDrag?: {
    axis: 'x' | 'y';
    startMouse: number;
    startScroll: number;
  };
  private panDrag?: { startX: number; startY: number; startScrollX: number; startScrollY: number };

  // ── Interaction: node drags, stacking, pop-out depth ──
  /**
   * Receives node drags: 'start' once the pointer moves past a small
   * threshold, 'move' on every pointer move and inertia frame (callers
   * throttle what they send), and 'end' when released or when inertia
   * settles. Mouse and touch paths drive the same begin/update/end calls.
   */
  onNodeDrag?: (e: NodeDragEvent) => void;
  private nodeDrag?: NodeDragSession;
  /**
   * Receives camera-node changes made by the user (orbit, dolly, coast):
   * 'start' on the press, 'move' as the view changes (callers throttle what
   * they send), 'end' once it rests.
   */
  onCameraChange?: (e: CameraChangeEvent) => void;
  /** The camera node of each window subtree that has one, by surface key. */
  private cameraNodeIds = new Map<string, string>();
  /** Orbit controllers for camera nodes the user has touched, keyed `${surfaceId}/${nodeId}`. */
  private orbitCams = new Map<string, OrbitCam>();
  /** The camera being orbited by a held pointer. */
  private orbitGrab?: string;
  /** Nodes carrying a lookAt / follow constraint, keyed `${surfaceKey}/${nodeId}`. */
  private constrainedNodes = new Map<string, { surfaceKey: string; id: string; lastT?: number }>();
  /** Pointer travel (px) before a press on a draggable node becomes a drag. */
  private static readonly DRAG_THRESHOLD_PX = 3;
  /** Inertia friction (1/s): velocity decays by e^(-k t). */
  private static readonly DRAG_FRICTION = 5;
  /** Depth-only quad program for the deferred pop-out pass (null = unavailable). */
  private depthQuad?: { program: WebGLProgram; uModel: WebGLUniformLocation | null; uViewProj: WebGLUniformLocation | null; vao: WebGLVertexArrayObject } | null;

  // ── Mobile mode state ──
  // The phone is a camera on the real desktop: it renders through
  // renderDesktop like the desktop does, with a view scale. A workspace point
  // lands at screen = (workspace - scroll) * viewZoom, where scrollX/scrollY
  // is the workspace point at the viewport's top-left. The desktop keeps
  // viewZoom at 1, where every mapping reduces exactly to the unzoomed one.
  private mobileMode = false;
  private viewZoom = 1;
  private mobileView = MobileViewState.DESKTOP;
  /** The window the camera last flew in on (FOCUS framing, neighbour swipes). */
  private mobileFocusedSurfaceId?: string;
  /** Slim bottom band that hints the swipe-up gesture (the "home" affordance). */
  private static readonly MOBILE_GESTURE_HANDLE_HEIGHT = 28;
  /** Optional hook: relay client-side compositor diagnostics to the backend
   *  (clientDiagnostic path — the browser console never reaches the log). */
  onDiagnostic?: (gate: string, detail: string) => void;
  /** A camera flight in progress (focus, fly out, keyboard pan). */
  private mobileFlight?: { from: MobileCam; to: MobileCam; start: number; duration: number };
  /** A one-finger pan released with speed: the camera glides (screen px/s). */
  private mobileGlide?: { vx: number; vy: number; last: number };
  /** Until the user moves the camera, the desktop stays fitted as windows arrive. */
  private mobileAutoFit = true;
  private static readonly MOBILE_MAX_ZOOM = 4;
  /** Focus mode never magnifies a window past this. */
  private static readonly MOBILE_FOCUS_MAX_ZOOM = 2;
  private static readonly MOBILE_FLIGHT_MS = 350;
  /** Glide friction (1/s): velocity decays by e^(-k t). */
  private static readonly MOBILE_GLIDE_FRICTION = 4;
  /** Screen px kept around a framed window or the fitted desktop. */
  private static readonly MOBILE_MARGIN = 8;
  /** What the phone's 2D overlay last drew; it redraws only when this changes. */
  private mobileOverlaySig = '';
  /** The framed window closed: fly out unless its object reappears (churn) first. */
  private mobileFocusLost?: { objectId: AbjectId; at: number };
  /** Screen px a virtual keyboard covers at the bottom (see setMobileBottomInset). */
  private mobileBottomInset = 0;

  // ── Exposé (MobileViewState.EXPOSE, on the phone and the desktop) ──
  // Visual only: slabs fly to grid slots and back; backend rects never
  // change. The phone picks with taps and flicks. The desktop picks with the
  // mouse (hover selects, click picks) and the keyboard (arrows and Tab move
  // the selection, Enter picks, Escape leaves); its system rails (dock,
  // toolbars, toasts) stay put and live over the scrim.
  /** Grid slot per window (workspace centre and scale, reading-order index), laid out on entry. */
  private exposeSlots = new Map<string, ExposeSlot>();
  /** Windows the grid was laid out for (the stagger spreads start times across them). */
  private exposeCount = 0;
  /** Their ids: when the open grid's windows change (one opens, closes, hides), it lays out again. */
  private exposeMembers = new Set<string>();
  /** 0 = windows at their rects, 1 = spread in the grid (eased; the scrim and titles follow it). */
  private exposeT = 0;
  /** Linear progress of the same spread (the desktop staggers each window's flight along it). */
  private exposeP = 0;
  private exposeAnim?: { from: number; to: number; pFrom: number; start: number; duration: number; done?: () => void };
  /** Vertical screen offset of a slot the finger is lifting (negative = up). */
  private exposeLift = new Map<string, number>();
  /** Slots flicked away: they fly off the top from their lift offset. */
  private exposeFlyOff = new Map<string, { from: number; start: number }>();
  /** Desktop: the window the pointer or the keys selected (it lifts and wears the accent). */
  private exposeSelected?: string;
  /** Desktop: eased selection highlight per slot, 0..1. */
  private exposeHot = new Map<string, number>();
  /** Desktop: one window's flight (ms); start times spread over this fraction of a flight across the grid. */
  private static readonly EXPOSE_FLIGHT_MS = 380;
  private static readonly EXPOSE_STAGGER = 0.3;
  /** Desktop: px a window arcs toward the viewer mid-flight. */
  private static readonly EXPOSE_ARC = 56;
  /** Desktop: scale the selected window gains over its slot. */
  private static readonly EXPOSE_HOT_SCALE = 0.05;

  constructor(canvas: HTMLCanvasElement) {
    require(canvas !== null, 'canvas is required');

    this.canvas = canvas;
    this.renderer = new GlRenderer(canvas);
    this.overlay = new Overlay2D(this.renderer);
    this.renderer.onContextRestored = () => {
      // GPU state is gone; OffscreenCanvases retain content, so re-upload all.
      for (const state of this.surfaceGl.values()) state.texture = undefined;
      for (const surface of this.surfaces.values()) surface.dirty = true;
      // Canvas-layer node textures are also gone; force re-upload from the
      // retained OffscreenCanvases.
      for (const entry of this.canvasLayers.values()) entry.texture = undefined;
      // Custom-mesh GPU handles are now invalid; drop them so they rebuild
      // from the retained scene store on the next frame (no deleteDynamicMesh
      // — the underlying GL objects no longer exist).
      this.customMeshes.clear();
      this.instancedMeshes.clear();
      // Mesh textures are gone too; drop the cache so resolveTexture reloads.
      this.meshTextures.clear();
      // So are the post-effect targets.
      this.postFxInstance?.reset();
      // The pop-out depth program rebuilds on first use.
      this.depthQuad = undefined;
      this.overlay.invalidate();
      this.contentContextRestored();
      this.needsRender = true;
    };

    // Handle resize
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());

    // Start render loop
    this.startRenderLoop();
  }

  /**
   * Handle canvas resize.
   */
  private handleResize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.renderer.setSize(rect.width, rect.height, dpr);
    this.renderer.cssWidth = rect.width;
    this.renderer.cssHeight = rect.height;
    this.overlay.resize(rect.width, rect.height, dpr);
    // A desktop Exposé grid is laid out in screen space: lay it out again.
    if (!this.mobileMode && this.mobileView === MobileViewState.EXPOSE) this.relayoutExpose();

    this.needsRender = true;
  }

  /**
   * Create a new surface for an object.
   */
  createSurface(
    objectId: AbjectId,
    rect: Rect,
    zIndex = 0,
    surfaceId?: string,
    inputPassthrough = false,
    inputMonitor = false,
    title?: string,
    transparent = false,
    closable = true,
    opts: { chromeless?: boolean; screenAnchor?: ScreenAnchor } = {},
  ): string {
    require(objectId !== '', 'objectId is required');
    require(opts.screenAnchor === undefined || isScreenAnchor(opts.screenAnchor), 'screenAnchor must name a screen anchor');
    require(rect.width > 0 && rect.height > 0, 'Surface must have positive dimensions');

    const id = surfaceId ?? `surface-${objectId}-${Date.now()}`;

    const offscreen = new OffscreenCanvas(rect.width, rect.height);
    const ctx = offscreen.getContext('2d');
    require(ctx !== null, 'Failed to get offscreen 2D context');

    const surface: Surface = {
      id,
      objectId,
      rect,
      zIndex,
      visible: true,
      inputPassthrough,
      inputMonitor,
      canvas: offscreen,
      ctx: ctx!,
      dirty: true,
      tainted: false,
      drawn: false,
      transparent,
      closable,
      chromeless: opts.chromeless ?? false,
      screenAnchor: opts.screenAnchor,
      title,
    };

    this.surfaces.set(id, surface);
    this.sortSurfaces();
    this.needsRender = true;
    // A phone framed on a window whose surface was just reminted stays on it.
    if (this.mobileFocusLost && this.mobileFocusLost.objectId === objectId) {
      this.mobileFocusLost = undefined;
      this.mobileFocusedSurfaceId = id;
    }

    ensure(this.surfaces.has(id), 'Surface must be registered');
    return id;
  }

  /**
   * Destroy a surface.
   */
  destroySurface(surfaceId: string): boolean {
    this.lastDestroyed = this.surfaces.get(surfaceId);
    // A sink still in flight shares this surface's texture, which is about to go.
    this.ghosts = this.ghosts.filter((g) => !(g.kind === 'minimize' && g.surface.id === surfaceId));
    const deleted = this.surfaces.delete(surfaceId);
    // A phone framed on this window flies back out to the desktop, unless the
    // same object reappears under a new surface id right away (window churn):
    // then it stays framed on the replacement (see stepMobileCamera).
    // Mobile-only state; desktop ignores it.
    if (this.mobileFocusedSurfaceId === surfaceId) {
      this.mobileFocusedSurfaceId = undefined;
      if (this.mobileMode && this.mobileView === MobileViewState.FOCUS && this.lastDestroyed) {
        this.mobileFocusLost = { objectId: this.lastDestroyed.objectId, at: performance.now() };
      }
      this.needsRender = true;
    }
    this.exposeSlots.delete(surfaceId);
    this.exposeLift.delete(surfaceId);
    this.exposeFlyOff.delete(surfaceId);
    this.exposeHot.delete(surfaceId);
    if (this.exposeSelected === surfaceId) this.exposeSelected = this.exposeSlots.keys().next().value;
    if (deleted) {
      this.liveDataImages.delete(surfaceId);
      this.surfaceVideoStamps.delete(surfaceId);
      for (const [videoId, region] of this.videoRegions) {
        if (region.surfaceId === surfaceId) this.videoRegions.delete(videoId);
      }
      const glState = this.surfaceGl.get(surfaceId);
      const surface = this.lastDestroyed;
      this.lastDestroyed = undefined;
      // A visible slab dematerializes: its ghost keeps the texture until the
      // fold finishes (drawGhosts frees it). The surface itself is gone, so
      // input and hit-testing no longer see it.
      const close = surface && this.hasMotion(surface)
        ? this.resolveEffect(this.slabMotionConfig.transitions.close) : undefined;
      if (close && glState?.texture && surface && surface.visible && surface.drawn
          && !this.isWorkspaceFiltered(surface)) {
        const run = this.makeRun(close, performance.now(), surface.rect.width, surface.rect.height);
        this.ghosts.push({ surface, state: glState, run, kind: 'close' });
      } else if (glState?.texture) {
        this.renderer.deleteTexture(glState.texture);
      }
      this.surfaceGl.delete(surfaceId);
      this.sceneStore.removeForSurface(surfaceId);
      this.sortSurfaces();
      this.needsRender = true;
    }
    return deleted;
  }

  /**
   * Destroy all surfaces. Used when reconnecting to backend.
   */
  clearAllSurfaces(): void {
    for (const glState of this.surfaceGl.values()) {
      if (glState.texture) this.renderer.deleteTexture(glState.texture);
    }
    for (const entry of this.canvasLayers.values()) {
      if (entry.texture) this.renderer.deleteTexture(entry.texture);
    }
    this.canvasLayers.clear();
    for (const g of this.ghosts) if (g.kind === 'close' && g.state.texture) this.renderer.deleteTexture(g.state.texture);
    this.ghosts = [];
    this.surfaceGl.clear();
    this.sceneStore.clear();
    this.worldKeys.clear();
    this.surfaces.clear();
    this.sortedSurfaces = [];
    this.liveDataImages.clear();
    // Drop client-side animations too: the backend replays retained ones after
    // reconnect, so stale entries would otherwise double up on the re-added nodes.
    this.nodeAnims.clear();
    // A drag in flight belonged to the old connection's scene.
    this.nodeDrag = undefined;
    this.needsRender = true;
  }

  /**
   * Get a surface by ID.
   */
  getSurface(surfaceId: string): Surface | undefined {
    return this.surfaces.get(surfaceId);
  }

  /**
   * Get all surfaces for an object.
   */
  getSurfacesForObject(objectId: AbjectId): Surface[] {
    return Array.from(this.surfaces.values()).filter(
      (s) => s.objectId === objectId
    );
  }

  /**
   * Capture a surface as a base64-encoded PNG.
   *
   * Preferred path: crop the surface's on-screen region out of the composited
   * GL frame. The surface's own 2D canvas holds only widget/canvas content —
   * 3D scene nodes render onto the GL canvas and never touch it — so a GL
   * crop is the only capture that shows what the user actually sees (meshes,
   * lights, bloom, slab chrome). Falls back to the plain 2D surface canvas
   * when the window is off-screen, on another workspace, or in mobile mode.
   */
  async captureSurface(surfaceId: string): Promise<{ imageBase64: string; width: number; height: number } | null> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.drawn) return null;

    const glShot = await this.captureSurfaceFromFrame(surface);
    if (glShot) return glShot;

    try {
      // convertToBlob throws on a canvas tainted by a cross-origin image.
      const blob = await surface.canvas.convertToBlob({ type: 'image/png' });
      const buffer = await blob.arrayBuffer();
      return {
        imageBase64: bytesToBase64(new Uint8Array(buffer)),
        width: surface.rect.width,
        height: surface.rect.height,
      };
    } catch {
      return null;
    }
  }

  /**
   * Crop the surface's projected screen region out of a freshly rendered GL
   * frame. Returns null when no faithful crop is possible — workspace
   * filtered, mobile layout, GL context lost — so the caller can fall back
   * to the 2D surface canvas.
   *
   * The capture frame is rendered with the surface centered in the viewport
   * (when it is mostly off-screen) and raised above its siblings, so an
   * off-screen or occluded window still yields a clean image. Scroll and
   * z-order are restored and re-rendered before returning; both renders
   * happen in this task, so only the restored frame is ever presented.
   */
  private async captureSurfaceFromFrame(surface: Surface): Promise<{ imageBase64: string; width: number; height: number } | null> {
    if (this.renderer.isContextLost || this.mobileMode) return null;
    if (!surface.visible || this.isWorkspaceFiltered(surface)) return null;

    // Mutate → render → crop → restore all happens synchronously: the first
    // await comes only after state is restored, so the capture layout is
    // never presented to the user.
    const savedScrollX = this.scrollX;
    const savedScrollY = this.scrollY;
    const savedZ = surface.zIndex;
    let out: OffscreenCanvas | null = null;
    let cropW = 0;
    let cropH = 0;
    try {
      // Center the surface when the viewport shows less than ~90% of it.
      const { x, y, width, height } = surface.rect;
      const ovW = Math.min(x + width, this.scrollX + this.width) - Math.max(x, this.scrollX);
      const ovH = Math.min(y + height, this.scrollY + this.height) - Math.max(y, this.scrollY);
      const shownFrac = (Math.max(0, ovW) * Math.max(0, ovH)) / Math.max(1, width * height);
      if (shownFrac < 0.9) {
        this.scrollTo(
          Math.round(x + width / 2 - this.width / 2),
          Math.round(y + height / 2 - this.height / 2),
        );
        this.clampScroll();
      }

      // Raise above every sibling so an overlapping window can't bleed into
      // the crop. Overlay-tier surfaces (zIndex >= 999) stay above.
      let maxZ = surface.zIndex;
      for (const s of this.surfaces.values()) {
        if (s !== surface && s.zIndex < 999 && s.zIndex > maxZ) maxZ = s.zIndex;
      }
      surface.zIndex = maxZ + 1;
      this.sortSurfaces();

      // The GL drawing buffer is invalidated after compositing, so render
      // synchronously and read back in the same task (same as captureDesktop).
      this.render();

      // Project the rect's corners (z=0 content plane) to screen px. Slab
      // tilt/lift and popped-out (occlude:false) nodes reach past the flat
      // rect; the pad absorbs the usual amount.
      const corners: Array<[number, number]> = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [cx, cy] of corners) {
        const p = mat4TransformPoint(this.viewProj, vec3(cx, cy, 0));
        const sx = ((p.x + 1) / 2) * this.width;
        const sy = ((1 - p.y) / 2) * this.height;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      const PAD = 12;
      minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;

      const cropX = Math.max(0, minX);
      const cropY = Math.max(0, minY);
      cropW = Math.min(this.width, maxX) - cropX;
      cropH = Math.min(this.height, maxY) - cropY;
      if (cropW >= 8 && cropH >= 8) {
        const dpr = this.canvas.width / Math.max(1, this.width);
        const outW = Math.max(1, Math.round(cropW * dpr));
        const outH = Math.max(1, Math.round(cropH * dpr));
        const candidate = new OffscreenCanvas(outW, outH);
        const ctx = candidate.getContext('2d');
        if (ctx) {
          ctx.drawImage(
            this.canvas,
            cropX * dpr, cropY * dpr, cropW * dpr, cropH * dpr,
            0, 0, outW, outH,
          );
          out = candidate;
        }
      }
    } catch {
      out = null;
    } finally {
      surface.zIndex = savedZ;
      this.sortSurfaces();
      this.scrollTo(savedScrollX, savedScrollY);
      try { this.render(); } catch { /* rAF loop repaints */ }
    }
    if (!out) return null;

    try {
      const blob = await out.convertToBlob({ type: 'image/png' });
      const buffer = await blob.arrayBuffer();
      return {
        imageBase64: bytesToBase64(new Uint8Array(buffer)),
        width: Math.round(cropW),
        height: Math.round(cropH),
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture the entire desktop as a base64-encoded PNG.
   */
  captureDesktop(): { imageBase64: string; width: number; height: number } {
    // The GL drawing buffer is invalidated after compositing, so render
    // synchronously and read back in the same task.
    this.render();
    const dataUrl = this.canvas.toDataURL('image/png');
    const imageBase64 = dataUrl.split(',')[1] ?? '';
    return {
      imageBase64,
      width: this.width,
      height: this.height,
    };
  }

  // ── Scene info (what this GPU can do, how the scene is running) ──────

  /** Rendered frames of the last ~2 s: [timestamp, ms spent in render(), ms since the previous frame or 0]. */
  private frameLog: Array<[number, number, number]> = [];
  /** Live particles at the end of the last rendered frame. */
  private lastParticleCount = 0;
  /** Whether the previous rendered frame asked for another (the loop was running, not resting). */
  private frameWantedNext = false;

  /** Record one rendered frame for sceneInfo (runs before the particle prune). */
  private noteFrame(start: number): void {
    const now = performance.now();
    const prev = this.frameLog.length > 0 ? this.frameLog[this.frameLog.length - 1][0] : 0;
    // Only back-to-back frames measure frame time; a gap after a frame that
    // wanted no successor is the loop resting.
    const running = this.frameWantedNext && prev > 0 && now - prev < 5000;
    this.frameLog.push([now, now - start, running ? now - prev : 0]);
    this.frameWantedNext = this.needsRender;
    while (this.frameLog.length > 0 && (now - this.frameLog[0][0] > 2000 || this.frameLog.length > 720)) this.frameLog.shift();
    let particles = 0;
    for (const id of this.touchedParticles) {
      particles += this.particleStates.get(id)?.ps.length ?? this.gpuParticles?.aliveCount(id) ?? 0;
    }
    this.lastParticleCount = particles;
  }

  /**
   * What this client's GPU offers and how the scene is running, for authors
   * choosing effects (WidgetManager's getSceneParams folds it in). A render
   * module or post effect reads as available until this GPU rejects its
   * program (they build lazily on first use). Stats cover the frames of the
   * last two seconds; draw calls and triangles are the last rendered frame's.
   */
  sceneInfo(): { capabilities: Record<string, unknown>; stats: Record<string, unknown> } {
    const gl = this.renderer.context;
    const lost = this.renderer.isContextLost;
    const param = (p: number): number => (lost ? 0 : Number(gl.getParameter(p)) || 0);
    const ext = (name: string): boolean => !lost && !!gl.getExtension(name);
    const failed = (...names: string[]): boolean => names.some((n) => programError(gl, n) !== undefined);
    const aniso = lost ? null : gl.getExtension('EXT_texture_filter_anisotropic');
    const postBase = !failed('postComposite', 'postCombine');
    const now = performance.now();
    const frames = this.frameLog.filter((f) => now - f[0] <= 2000);
    const stat = (values: number[]): { avg: number; p95: number } => {
      if (values.length === 0) return { avg: 0, p95: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      return { avg: Math.round(avg * 100) / 100, p95: Math.round(p95 * 100) / 100 };
    };
    const intervals = stat(frames.map((f) => f[2]).filter((v) => v > 0));
    const cpu = stat(frames.map((f) => f[1]));
    const last = this.frameLog.length > 0 ? this.frameLog[this.frameLog.length - 1][0] : 0;
    return {
      capabilities: {
        webgl2: !lost,
        gpu: lost ? '' : String(gl.getParameter(gl.RENDERER) ?? ''),
        maxTextureSize: param(gl.MAX_TEXTURE_SIZE),
        maxRenderbufferSize: param(gl.MAX_RENDERBUFFER_SIZE),
        maxSamples: param(gl.MAX_SAMPLES),
        floatRenderTargets: ext('EXT_color_buffer_float'),
        anisotropy: aniso ? param(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 0,
        instancing: !lost,
        gpuParticles: !lost && !failed('gpuParticles'),
        maxLightsPerSubtree: MAX_MESH_LIGHTS,
        shadowMapMax: this.mobileMode ? 1024 : 4096,
        postEffects: {
          bloom: !lost,
          ao: postBase && !failed('postAo12', 'postAo8', 'postAo6'),
          dof: postBase && !failed('postDof16', 'postDof12', 'postDof8'),
          lightShafts: postBase && !failed('postShafts32', 'postShafts24', 'postShafts16', 'postShafts12'),
          outline: postBase,
          fxaa: postBase && !failed('postFxaa'),
          chromaticAberration: postBase,
          vignette: postBase,
          grain: postBase,
        },
        postQuality: this.postQuality,
        devicePixelRatio: window.devicePixelRatio || 1,
        mobile: this.mobileMode,
        viewport: { width: Math.round(this.width), height: Math.round(this.height) },
      },
      stats: {
        windowMs: 2000,
        framesRendered: frames.length,
        fps: intervals.avg > 0 ? Math.round(1000 / intervals.avg) : 0,
        frameMs: intervals,
        renderCpuMs: cpu,
        idleMs: last > 0 ? Math.round(now - last) : null,
        drawCalls: this.renderer.frameStats.drawCalls,
        triangles: Math.round(this.renderer.frameStats.triangles),
        particles: this.lastParticleCount,
        textureMB: Math.round((this.renderer.textureBytes / 1048576) * 10) / 10,
        surfaces: this.surfaces.size,
      },
    };
  }

  /**
   * Check if a surface is filtered out by the active workspace.
   */
  private isWorkspaceFiltered(surface: Surface): boolean {
    return !!(this.activeWorkspaceId && surface.workspaceId &&
      surface.workspaceId !== this.activeWorkspaceId);
  }

  /**
   * Get all visible surfaces with inputMonitor enabled.
   */
  getInputMonitors(): Surface[] {
    return Array.from(this.surfaces.values()).filter(
      (s) => s.visible && s.inputMonitor && !this.isWorkspaceFiltered(s)
    );
  }

  /**
   * Move a surface.
   */
  moveSurface(surfaceId: string, x: number, y: number): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      // Drag tilt: lean the slab a few degrees toward the motion (visual
      // only; spring-settles in syncDesktop as the target decays).
      const glState = this.glState(surfaceId);
      if (glState.lastMoveX !== undefined && glState.lastMoveY !== undefined) {
        const dx = x - glState.lastMoveX;
        const dy = y - glState.lastMoveY;
        const k = 0.004;
        const max = Compositor.TILT_MAX;
        glState.tiltTargetY = Math.max(-max, Math.min(max, dx * k));
        glState.tiltTargetX = Math.max(-max, Math.min(max, -dy * k));
      }
      glState.lastMoveX = x;
      glState.lastMoveY = y;

      surface.rect.x = x;
      surface.rect.y = y;
      this.needsRender = true;
    }
  }

  /** Per-surface GPU/animation state, created on demand. */
  private glState(surfaceId: string): SurfaceGlState {
    let state = this.surfaceGl.get(surfaceId);
    if (!state) {
      state = {
        model: mat4Identity(),
        tiltX: 0, tiltY: 0, tiltTargetX: 0, tiltTargetY: 0,
        lift: 0,
      };
      this.surfaceGl.set(surfaceId, state);
    }
    return state;
  }

  /**
   * Resize a surface.
   */
  resizeSurface(surfaceId: string, width: number, height: number): void {
    require(width > 0 && height > 0, 'Dimensions must be positive');

    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      const oldCanvas = surface.canvas;

      surface.rect.width = width;
      surface.rect.height = height;

      // Recreate offscreen canvas
      const offscreen = new OffscreenCanvas(width, height);
      const ctx = offscreen.getContext('2d');
      require(ctx !== null, 'Failed to get offscreen context');

      // Preserve old content so the surface is never blank between
      // resize and the next draw cycle (avoids flash-of-blank during resize)
      ctx!.drawImage(oldCanvas, 0, 0);

      surface.canvas = offscreen;
      surface.ctx = ctx!;
      surface.dirty = true;
      this.needsRender = true;
    }
  }

  /**
   * Set surface z-index.
   */
  setZIndex(surfaceId: string, zIndex: number): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      surface.zIndex = zIndex;
      this.sortSurfaces();
      this.needsRender = true;
    }
  }

  /** Set which surface is focused (gets the accent glow halo). */
  setFocusedSurface(surfaceId: string | undefined): void {
    if (this.focusedSurfaceId === surfaceId) return;
    this.focusedSurfaceId = surfaceId;
    this.needsRender = true;
  }

  /** Set the focus-glow color (theme accent). */
  setFocusGlowColor(color: string): void {
    if (this.focusGlowColor === color) return;
    this.focusGlowColor = color;
    this.needsRender = true;
  }

  /** Set the focus-glow corner radius to match the focused window's radius. */
  setFocusGlowRadius(radius: number): void {
    if (this.focusGlowRadius === radius || !(radius >= 0)) return;
    this.focusGlowRadius = radius;
    this.needsRender = true;
  }

  // ── Scene vocabulary (retained 3D nodes) ─────────────────────────────

  /**
   * Apply a validated scene-op batch to a surface's subtree. Ops are
   * retained: nodes persist until removed or the surface is destroyed.
   */
  applySceneOps(surfaceId: string, ops: SceneOp[]): void {
    this.applyOps(surfaceId, ops);
  }

  /**
   * Split a batch: 'animate' ops drive the client-side animation engine,
   * 'remove' ops also cancel any animations on that node, and everything else
   * mutates the retained scene store. Animations are intentionally NOT stored
   * in the scene tree — they are transient client state, re-issued by the
   * owner after a reconnect if persistence is wanted.
   */
  /**
   * Whether changes under this scene key can currently reach pixels: world
   * keys always render (desktop-level decor); window subtrees render only
   * when their surface is visible and on the active workspace. Unknown keys
   * count as renderable so we never suppress a legitimate first paint.
   */
  private isSurfaceKeyRenderable(surfaceKey: string): boolean {
    if (surfaceKey.startsWith('world:')) return true;
    const surface = this.surfaces.get(surfaceKey);
    if (!surface) return true;
    return surface.visible && !this.isWorkspaceFiltered(surface);
  }

  private applyOps(surfaceKey: string, ops: SceneOp[]): void {
    const rest: SceneOp[] = [];
    // `animate` resolves against a node that must ALREADY be in the store, so it
    // has to run after the adds in its own batch — otherwise the most natural
    // thing to write, [{op:'add', id:'cube'}, {op:'animate', id:'cube'}], looks
    // up a node that does not exist yet, drops the animation, and still replies
    // success. Collect them and start them once the batch has been applied.
    const anims: SceneOp[] = [];
    // The node under the user's hand keeps following the hand: incoming
    // position updates for it (owner echoes, other clients) wait until the
    // drag ends, or they would yank it back to a stale spot mid-drag.
    const held = this.nodeDrag && this.nodeDrag.key === surfaceKey ? this.nodeDrag.nodeId : undefined;
    for (let op of ops) {
      if (op.op === 'animate') { anims.push(op); continue; }
      if (op.op === 'remove') this.nodeAnims.delete(`${surfaceKey}/${op.id}`);
      if (held !== undefined && op.op === 'update' && op.id === held && op.transform?.position) {
        const { position: _drop, ...keep } = op.transform;
        op = { ...op, transform: keep };
      }
      rest.push(op);
    }
    if (rest.length > 0) this.sceneStore.apply(surfaceKey, rest);
    for (const op of anims) this.startOrStopAnim(surfaceKey, op);
    // Pick up bloom config from this surface's 'environment' node.
    for (const op of rest) this.syncBloomFrom(surfaceKey, op);
    for (const op of rest) this.syncMotionNode(surfaceKey, op);
    // Only wake the render loop for changes that can reach pixels. A 30-60fps
    // animation stream aimed at a hidden window or an inactive workspace
    // still mutates the retained store (so the next reveal is correct) but
    // must not keep every visible workspace rendering at full rate.
    if (this.isSurfaceKeyRenderable(surfaceKey)) this.needsRender = true;
  }

  /** Update this surface's bloom config when its 'environment' node changes. */
  private syncBloomFrom(surfaceKey: string, op: SceneOp): void {
    const current = this.bloomBySurface.get(surfaceKey);
    if (op.op === 'remove') {
      // Removing an ancestor group takes the environment node with it.
      if (current && (current.nodeId === op.id || !this.sceneStore.getNode(surfaceKey, current.nodeId))) {
        this.bloomBySurface.delete(surfaceKey);
      }
      return;
    }
    const node = this.sceneStore.getNode(surfaceKey, op.id);
    if (node?.kind !== 'environment') return;
    // The node's own bloom, or its look's (a look like 'neon' brings its glow).
    const b = withLookPreset(node.params, this.sceneLibrary).bloom as boolean
      | { threshold?: number; intensity?: number; radius?: number; quality?: number | string } | undefined;
    if (b) {
      // quality: the mip-chain depth (how far the glow reaches); radius: its spread.
      const q = b === true ? undefined : b.quality;
      const levels = typeof q === 'number' ? q : q === 'low' ? 2 : q === 'high' ? 5 : 3;
      this.bloomBySurface.set(surfaceKey, b === true
        ? { nodeId: op.id, threshold: 0.6, intensity: 1, levels, radius: 1 }
        : { nodeId: op.id, threshold: b.threshold ?? 0.6, intensity: b.intensity ?? 1, levels, radius: b.radius ?? 1 });
    } else if (current?.nodeId === op.id) {
      this.bloomBySurface.delete(surfaceKey);
    }
  }

  /**
   * One bloom pass per surface that asked for it, each clipped to that
   * surface's projected rect. A surface that has gone away drops its entry
   * here rather than needing a hook in surface removal.
   */
  private applyBloomPasses(): void {
    if (this.bloomBySurface.size === 0) return;
    for (const [surfaceKey, cfg] of this.bloomBySurface) {
      if (surfaceKey.startsWith('world:')) {
        this.renderer.applyBloom(cfg.threshold, cfg.intensity, cfg.levels, undefined, { radius: cfg.radius });
        continue;
      }
      const surface = this.surfaces.get(surfaceKey);
      if (!surface) { this.bloomBySurface.delete(surfaceKey); continue; }
      if (!this.isSurfaceKeyRenderable(surfaceKey)) continue;
      // Drawn this frame, on either the desktop or the phone path — a
      // matrix left over from an earlier frame is not a place on screen.
      if (!this.drawnThisFrame.has(surfaceKey)) continue;
      const st = this.glState(surfaceKey);
      const model = st.model;
      if (!model) continue;
      // A window pinned to the phone's screen drew through its own view.
      const viewProj = st.pinView && st.cam ? st.cam.viewProj : this.viewProj;
      const rect = projectUnitQuadToCss(model, viewProj, this.width, this.height, BLOOM_SPILL_PX);
      if (rect) this.renderer.applyBloom(cfg.threshold, cfg.intensity, cfg.levels, rect, { radius: cfg.radius });
    }
  }

  /**
   * Apply a world-scope scene-op batch: nodes in the global scene graph,
   * positioned in workspace coordinates, namespaced per owning abject.
   */
  applyWorldSceneOps(ownerId: string, ops: SceneOp[]): void {
    const key = `world:${ownerId}`;
    this.worldKeys.add(key);
    this.applyOps(key, ops);
  }

  /**
   * Set the scene theme (active workspace palette subset). Slab chrome,
   * shadows, rim glow, and `$token` material colors all re-resolve against
   * it — the 3D equivalent of widgets re-deriving colors from this.theme.
   */
  setSceneTheme(theme: SceneTheme): void {
    this.sceneTheme = theme;
    this.needsRender = true;
  }

  // ── Motion ─────────────────────────────────────────────────────────────
  //
  // Client-side, visual-only slab motion. Effects are declarative specs
  // (src/ui/gl/slab-motion.ts): tracks for offsets, rotation, scale, opacity
  // and dim, plus rim / aura / scan-line light and particle bursts. The
  // window lifecycle (open, close, minimize, restore, workspace-in) plays
  // whichever effects the motion config names, and owners play effects on
  // demand (surfaceEffect). The config is data pushed by the backend
  // (WidgetManager is its authority), so any Abject can register effects or
  // replace the transitions. Nothing here changes geometry the backend
  // knows: picking follows the animated model matrix, and closed slabs leave
  // the input path at once (their ghosts are drawn, never hit).

  private slabMotionConfig: SlabMotionConfig = DEFAULT_SLAB_MOTION;
  /**
   * GPU particle emitters (one instanced draw each), keyed
   * `${surfaceKey}/${nodeId}`. The CPU simulation below remains only as the
   * fallback for a GPU that rejects the particle program.
   */
  private gpuParticles?: GpuParticles;
  /** Particle emitter simulations (CPU fallback), keyed `${surfaceKey}/${nodeId}`. */
  private particleStates = new Map<string, {
    ps: Array<{ x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; size: number }>;
    acc: number; last: number; burstKey: unknown; burstDone: boolean;
  }>();
  private touchedParticles = new Set<string>();
  private ghosts: SlabGhost[] = [];
  /** The surface being destroyed, handed from destroySurface to its ghost. */
  private lastDestroyed?: Surface;

  /** Replace the motion configuration (named effects, transitions, modal style). */
  setSlabMotion(config: SlabMotionConfig): void {
    this.slabMotionConfig = config;
    this.needsRender = true;
  }

  /**
   * Named material and look presets (SceneLibrary data, relayed by the
   * UIServer). Nodes name them with `material` / `look`; resolution happens
   * at draw time, so a re-registered preset restyles every node using it.
   */
  private sceneLibrary: SceneLibraryConfig = BUILTIN_SCENE_LIBRARY;

  /** Material presets expand before inheritance, so a group can dress its subtree (SceneStore.expandParams). */
  private readonly presetExpander = (this.sceneStore.expandParams = (p) => withMaterialPreset(p, this.sceneLibrary));

  /** Replace the preset library (materials and looks). */
  setSceneLibrary(config: SceneLibraryConfig): void {
    this.sceneLibrary = {
      materials: { ...BUILTIN_SCENE_LIBRARY.materials, ...(config.materials ?? {}) },
      looks: { ...BUILTIN_SCENE_LIBRARY.looks, ...(config.looks ?? {}) },
    };
    // A look can carry bloom: re-read every environment node against the new looks.
    for (const key of [...this.surfaces.keys(), ...this.worldKeys]) {
      for (const node of this.sceneStore.nodesForSurface(key)) {
        if (node.kind === 'environment') this.syncBloomFrom(key, { op: 'update', id: node.id });
      }
    }
    this.needsRender = true;
  }

  /** Slabs that take part in lifecycle motion (tooltips and passthrough layers stay instant). */
  private hasMotion(surface: Surface): boolean {
    return !surface.transparent && !surface.inputPassthrough
      && surface.rect.height >= this.slabMotionConfig.minHeight;
  }

  /** An effect by name (registered, then built-in) or inline spec. */
  private resolveEffect(ref: string | SlabEffectSpec | null | undefined): SlabEffectSpec | undefined {
    if (!ref) return undefined;
    if (typeof ref === 'string') return this.slabMotionConfig.effects[ref] ?? BUILTIN_SLAB_EFFECTS[ref];
    return ref;
  }

  /** Start an effect run: resolve its colours and seed its particles. */
  private makeRun(spec: SlabEffectSpec, start: number, w: number, h: number, color?: string): SlabEffectRun {
    const living = this.sceneTheme?.colors.accentSecondary ?? '#5be5a0';
    const pick = (c?: string) => parseCssColor(resolveSceneColor(color ?? c ?? living, this.sceneTheme));
    const run: SlabEffectRun = {
      spec,
      start,
      curve: this.easingOf(spec.easing ?? 'standard'),
      rim: pick(spec.rim?.color),
      aura: pick(spec.aura?.color),
      scan: pick(spec.scan?.color),
      particle: pick(spec.particles?.color),
    };
    if (spec.particles) run.particles = this.seedParticles(spec.particles, w, h);
    return run;
  }

  private seedParticles(p: NonNullable<SlabEffectSpec['particles']>, w: number, h: number): NonNullable<SlabEffectRun['particles']> {
    const out: NonNullable<SlabEffectRun['particles']> = [];
    const count = Math.max(0, Math.min(400, p.count ?? 48));
    const [smin, smax] = p.speed ?? [70, 270];
    const [zmin, zmax] = p.size ?? [2, 5.5];
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, nx = 0, ny = 0;
      if ((p.from ?? 'edges') === 'edges') {
        const edge = Math.floor(Math.random() * 4);
        const u = Math.random() - 0.5;
        if (edge === 0) { x = u * w; y = -h / 2; ny = -1; }
        else if (edge === 1) { x = w / 2; y = u * h; nx = 1; }
        else if (edge === 2) { x = u * w; y = h / 2; ny = 1; }
        else { x = -w / 2; y = u * h; nx = -1; }
      } else {
        const a = Math.random() * Math.PI * 2;
        nx = Math.cos(a); ny = Math.sin(a);
      }
      const speed = smin + Math.random() * (smax - smin);
      const shape = p.shape ?? 'mixed';
      out.push({
        x, y, z: 0,
        vx: nx * speed + (Math.random() - 0.5) * 60,
        vy: ny * speed + (Math.random() - 0.5) * 60,
        vz: 40 + Math.random() * 160,
        size: zmin + Math.random() * (zmax - zmin),
        square: shape === 'square' || (shape === 'mixed' && Math.random() < 0.5),
      });
    }
    return out;
  }

  /**
   * Play an effect on a surface's slab: a registered or built-in name, or an
   * inline spec. `color` (CSS or $token) overrides the effect's light colours.
   * Unknown names are ignored.
   */
  surfaceEffect(surfaceId: string, effect: string | SlabEffectSpec, color?: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return;
    const spec = this.resolveEffect(effect);
    if (!spec) return;
    const state = this.glState(surfaceId);
    (state.effects ??= []).push(this.makeRun(spec, performance.now(), surface.rect.width, surface.rect.height, color));
    this.needsRender = true;
  }

  /** Mark or unmark a surface as modal (every other slab recedes while it shows). */
  setSurfaceModal(surfaceId: string, modal: boolean): void {
    if (!this.surfaces.has(surfaceId)) return;
    this.glState(surfaceId).modal = modal;
    this.needsRender = true;
  }

  /** Evaluate a set of effect runs into one pose (offsets add, factors multiply). */
  private evalPose(runs: SlabEffectRun[], now: number, cx: number, cy: number): SlabPose {
    const pose: SlabPose = {
      dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, opacity: 1, dim: 1,
      auras: [], scans: [], bursts: [], moving: false,
    };
    for (const run of runs) {
      const spec = run.spec;
      const t = Math.max(0, Math.min(1, (now - run.start) / spec.duration));
      if (t < 1) pose.moving = true;
      const e = cubicBezier(run.curve, t);
      const val = (ch: keyof SlabEffectSpec): number | undefined => {
        const tr = spec[ch] as MotionTrack | undefined;
        return tr === undefined ? undefined : sampleTrack(tr, t, e, channelNeutral(ch));
      };
      pose.dx += val('x') ?? 0;
      pose.dy += val('y') ?? 0;
      pose.dz += val('z') ?? 0;
      pose.rx += val('rotateX') ?? 0;
      pose.ry += val('rotateY') ?? 0;
      pose.rz += val('rotateZ') ?? 0;
      const sc = val('scale') ?? 1;
      pose.sx *= sc * (val('scaleX') ?? 1);
      pose.sy *= sc * (val('scaleY') ?? 1);
      pose.opacity *= val('opacity') ?? 1;
      pose.dim *= val('dim') ?? 1;
      if (spec.toward) {
        const k = sampleTrack(spec.toward.amount, t, e, 0);
        if (spec.toward.x !== undefined) pose.dx += (spec.toward.x - cx) * k;
        if (spec.toward.y !== undefined) pose.dy += (spec.toward.y - cy) * k;
      }
      if (spec.rim) {
        const a = sampleTrack(spec.rim.alpha, t, e, 0);
        if (a > 0 && (!pose.rim || a > pose.rim.a)) pose.rim = { ...run.rim, a: Math.min(1, a) };
      }
      if (spec.aura) {
        const a = sampleTrack(spec.aura.alpha, t, e, 0);
        if (a > 0) pose.auras.push({ color: { ...run.aura, a: Math.min(1, a) }, spread: spec.aura.spread ?? 36 });
      }
      if (spec.scan) {
        const a = sampleTrack(spec.scan.alpha, t, e, 0);
        const from = spec.scan.from ?? 'top';
        const pos = from === 'top' ? e : from === 'bottom' ? 1 - e : 0.5;
        if (a > 0) pose.scans.push({ color: { ...run.scan, a: Math.min(1, a) }, pos });
      }
      if (run.particles && t < 1) pose.bursts.push(run);
    }
    return pose;
  }

  /** Recede toward the modal style while any modal shows (eased per slab). */
  private stepRecede(state: SurfaceGlState, anyModal: boolean, pose: SlabPose): void {
    const target = anyModal && !state.modal ? 1 : 0;
    const r = state.recede ?? 0;
    const next = Math.abs(target - r) < 0.01 ? target : r + (target - r) * 0.2;
    state.recede = next;
    if (next !== target) pose.moving = true;
    const m = this.slabMotionConfig.modal;
    pose.dz -= m.z * next;
    pose.dim *= 1 - (1 - m.dim) * next;
  }

  /** Draw a pose's auras: soft light BEHIND the slab (call before drawing it). */
  private drawPoseAuras(
    pose: SlabPose, cx: number, cy: number, z: number, w: number, h: number,
    rot: number[], viewProj: Mat4,
    /** Frame the pose is expressed in (a window riding a node); omitted = world. */
    parent?: Mat4,
  ): void {
    const place = (m: Mat4): Mat4 => (parent ? mat4Multiply(parent, m) : m);
    for (const aura of pose.auras) {
      const pad = aura.spread;
      this.renderer.drawGlow({
        model: place(mat4TRS(cx, cy, z - 0.4, rot[0], rot[1], rot[2], w + pad * 2, h + pad * 2, 1)),
        viewProj,
        quadWidth: w + pad * 2, quadHeight: h + pad * 2,
        halfWidth: w / 2, halfHeight: h / 2,
        radius: 0,
        color: aura.color,
        a1: 0.9, sigma1: pad / 6,
        a2: 0.5, sigma2: pad / 2.2,
      });
    }
  }

  /** Draw a pose's scan lines and particles IN FRONT of the slab (call after drawing it). */
  private drawPoseLights(
    pose: SlabPose, now: number, cx: number, cy: number, z: number, w: number, h: number,
    rot: number[], viewProj: Mat4,
    /** Frame the pose is expressed in (a window riding a node); omitted = world. */
    parent?: Mat4,
  ): void {
    const place = (m: Mat4): Mat4 => (parent ? mat4Multiply(parent, m) : m);
    for (const scan of pose.scans) {
      const y = cy - h / 2 + h * scan.pos;
      const qw = w + 60;
      const qh = 40;
      this.renderer.drawGlow({
        model: place(mat4TRS(cx, y, z + 1, rot[0], rot[1], rot[2], qw, qh, 1)),
        viewProj,
        quadWidth: qw, quadHeight: qh,
        halfWidth: w / 2, halfHeight: 1,
        radius: 0,
        color: scan.color,
        a1: 1, sigma1: 1.2,
        a2: 0.55, sigma2: 7,
      });
    }
    for (const run of pose.bursts) {
      const t = Math.max(0, Math.min(1, (now - run.start) / run.spec.duration));
      const secs = Math.max(0, (now - run.start) / 1000);
      const gravity = run.spec.particles?.gravity ?? 90;
      const fade = 1 - t;
      for (const p of run.particles ?? []) {
        const px = cx + p.x + p.vx * secs;
        const py = cy + p.y + p.vy * secs + 0.5 * gravity * secs * secs;
        const pz = z + p.z + p.vz * secs;
        const q = p.square ? p.size * 2 + 2 : p.size * 6;
        this.renderer.drawGlow({
          model: place(mat4TRS(px, py, pz, 0, 0, secs * 3, q, q, 1)),
          viewProj,
          quadWidth: q, quadHeight: q,
          halfWidth: p.square ? p.size : 0.5, halfHeight: p.square ? p.size : 0.5,
          radius: p.square ? 0 : 0.5,
          color: run.particle,
          a1: fade, sigma1: p.square ? 0.4 : p.size * 0.9,
        });
      }
    }
  }

  /** Draw slabs that are closing or minimizing; drops the finished ones. */
  private drawGhosts(now: number): boolean {
    if (this.ghosts.length === 0) return false;
    const keep: SlabGhost[] = [];
    for (const g of this.ghosts) {
      const done = now - g.run.start >= g.run.spec.duration;
      if (done || !g.state.texture) {
        if (g.kind === 'close' && g.state.texture) this.renderer.deleteTexture(g.state.texture);
        continue;
      }
      keep.push(g);
      const { rect } = g.surface;
      // A window that rode a node folds away where it last was on screen.
      const parent = g.state.attachFrame;
      const bx = parent ? 0 : rect.x + rect.width / 2;
      const by = parent ? 0 : rect.y + rect.height / 2;
      const pose = this.evalPose([g.run], now, bx, by);
      const cx = bx + pose.dx;
      const cy = by + pose.dy;
      const z = g.state.lift + pose.dz;
      const w = rect.width * pose.sx;
      const h = rect.height * pose.sy;
      const rot = [pose.rx, pose.ry, pose.rz];
      const cam = (parent && g.state.attachCam) ? g.state.attachCam : this.windowCamera(cx, cy, z, g.state.pinView);
      this.drawPoseAuras(pose, cx, cy, z, w, h, rot, cam.viewProj, parent);
      const slab = mat4TRS(cx, cy, z, rot[0], rot[1], rot[2], w, h, 1);
      this.renderer.drawSurface({
        model: parent ? mat4Multiply(parent, slab) : slab,
        viewProj: cam.viewProj, texture: g.state.texture,
        width: rect.width, height: rect.height, radius: 0,
        dim: pose.dim, opacity: pose.opacity,
        rimColor: pose.rim, rimWidth: 2.5,
      });
      this.drawPoseLights(pose, now, cx, cy, z, w, h, rot, cam.viewProj, parent);
    }
    this.ghosts = keep;
    return keep.length > 0;
  }

  /**
   * Abject-requested slab transform: tilt/float a window in the scene.
   * Purely visual; picking follows automatically via the model matrix.
   */
  setSurfaceTransform(surfaceId: string, transform: { rotation?: [number, number, number]; z?: number }): void {
    const state = this.glState(surfaceId);
    state.userRotation = transform.rotation;
    state.userZ = transform.z;
    this.needsRender = true;
  }

  /**
   * Get the maximum z-index among surfaces, optionally only considering
   * surfaces below a given threshold.
   */
  getMaxZIndex(belowThreshold?: number): number {
    let max = 0;
    for (const surface of this.surfaces.values()) {
      if (belowThreshold !== undefined && surface.zIndex >= belowThreshold) continue;
      if (surface.zIndex > max) max = surface.zIndex;
    }
    return max;
  }

  /**
   * Set surface visibility.
   */
  setVisible(surfaceId: string, visible: boolean): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      if (surface.visible !== visible && surface.drawn && this.hasMotion(surface)
          && !this.isWorkspaceFiltered(surface)) {
        const state = this.glState(surfaceId);
        const now = performance.now();
        const { width, height } = surface.rect;
        // Hiding plays the minimize transition on a ghost; showing plays the
        // restore transition (dropping a minimize still in flight).
        this.ghosts = this.ghosts.filter((g) => !(g.kind === 'minimize' && g.surface === surface));
        const minimize = this.resolveEffect(this.slabMotionConfig.transitions.minimize);
        const restore = this.resolveEffect(this.slabMotionConfig.transitions.restore);
        if (!visible && state.texture && minimize) {
          this.ghosts.push({ surface, state, run: this.makeRun(minimize, now, width, height), kind: 'minimize' });
        } else if (visible && restore) {
          (state.effects ??= []).push(this.makeRun(restore, now, width, height));
        }
      }
      surface.visible = visible;
      this.needsRender = true;
    }
  }

  /**
   * Set a surface's title (used for the phone's Exposé labels).
   */
  setSurfaceTitle(surfaceId: string, title: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      surface.title = title;
      this.needsRender = true;
    }
  }

  /**
   * Set the active workspace. Surfaces tagged with a different workspace
   * will be hidden from rendering and hit-testing.
   */
  setActiveWorkspace(workspaceId: string | undefined): void {
    const changed = this.activeWorkspaceId !== workspaceId;
    this.activeWorkspaceId = workspaceId;
    // Exposé spreads one workspace's windows: another workspace closes it at once.
    if (changed && (this.exposeT > 0 || this.mobileView === MobileViewState.EXPOSE)) this.closeExposeNow();
    const enter = changed && workspaceId
      ? this.resolveEffect(this.slabMotionConfig.transitions.workspaceIn) : undefined;
    if (enter) {
      // The incoming workspace's windows play the workspace-in transition
      // one after another, back to front.
      const now = performance.now();
      let i = 0;
      for (const surface of this.sortedSurfaces) {
        if (surface.workspaceId !== workspaceId || !surface.visible || !surface.drawn) continue;
        if (!this.hasMotion(surface)) continue;
        const state = this.glState(surface.id);
        state.effects = [
          ...(state.effects ?? []),
          this.makeRun(enter, now + i * this.slabMotionConfig.stagger, surface.rect.width, surface.rect.height),
        ];
        i++;
      }
    }
    this.needsRender = true;
  }

  /**
   * Tag a surface with a workspace ID. Surfaces without a workspace ID
   * are always visible (global objects like WorkspaceSwitcher).
   */
  setSurfaceWorkspace(surfaceId: string, workspaceId: string): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) {
      surface.workspaceId = workspaceId;
      this.needsRender = true;
    }
  }

  /** Resolve `$token` colors in a draw command's params against the active theme. */
  private resolveCommandColors(command: DrawCommand): void {
    const p = command.params as Record<string, unknown> | undefined;
    if (!p) return;
    const tok = (v: unknown): unknown =>
      (typeof v === 'string' && v.charCodeAt(0) === 36 /* $ */) ? resolveSceneColor(v, this.sceneTheme) : v;
    if (p.fill !== undefined) p.fill = tok(p.fill);
    if (p.stroke !== undefined) p.stroke = tok(p.stroke);
    if (p.color !== undefined) p.color = tok(p.color);
    if (p.shadowColor !== undefined) p.shadowColor = tok(p.shadowColor);
    if (p.value !== undefined) p.value = tok(p.value); // fillStyle/strokeStyle/shadowColor property-commands
    if (Array.isArray(p.stops)) {
      for (const s of p.stops as Array<Record<string, unknown>>) {
        if (s && s.color !== undefined) s.color = tok(s.color);
      }
    }
  }

  /**
   * Execute a draw command on a surface.
   */
  draw(command: DrawCommand): void {
    if (command.nodeId) {
      this.drawToLayer(command.surfaceId, command.nodeId, command);
      return;
    }
    const surface = this.surfaces.get(command.surfaceId);
    if (!surface) {
      return;
    }

    // Resolve `$token` theme colors in any color-bearing param against the
    // active palette, so canvas draw commands can use $accent / $textPrimary /
    // $windowBg etc. and stay cohesive with the desktop theme — the 2D
    // equivalent of the scene's $token material colors. Non-$ strings and
    // gradient descriptor objects pass through untouched.
    this.resolveCommandColors(command);

    const ctx = surface.ctx;

    switch (command.type) {
      case 'clear': {
        this.resetSurfaceState(surface);
        // A bare clear starts a full surface redraw: bump the video stamp so
        // only videoFrame regions re-emitted in this redraw keep compositing.
        this.surfaceVideoStamps.set(
          command.surfaceId,
          (this.surfaceVideoStamps.get(command.surfaceId) ?? 0) + 1,
        );
        const p = command.params as { color?: string };
        if (p?.color) {
          ctx.fillStyle = p.color;
          ctx.fillRect(0, 0, surface.rect.width, surface.rect.height);
        }
        break;
      }

      case 'videoFrame': {
        const p = command.params as VideoFrameParams;
        if (p?.videoId && typeof p.x === 'number' && typeof p.y === 'number') {
          this.videoRegions.set(p.videoId, {
            surfaceId: command.surfaceId,
            x: p.x, y: p.y,
            width: Math.max(0, p.width), height: Math.max(0, p.height),
            clipTop: p.clipTop, clipBottom: p.clipBottom,
            hidden: p.hidden === true,
            stamp: this.surfaceVideoStamps.get(command.surfaceId) ?? 0,
            lastTime: -1, // force a repaint at the new position
          });
        }
        break;
      }

      case 'reset':
        // ctx.reset() semantics: wipe the bitmap and all context state.
        this.resetSurfaceState(surface);
        break;

      default:
        this.execShapeCommand(ctx, command.surfaceId, command);
        break;
    }

    surface.dirty = true;
    surface.drawn = true;
    this.needsRender = true;
  }

  /**
   * Execute one shape/state draw command against a 2D context. Shared by
   * window surfaces (draw) and canvas-layer scene nodes (execLayerCommand) —
   * everything in the vocabulary except the surface-only commands (clear /
   * reset / videoFrame), which the callers handle with their own semantics.
   * `key` identifies the target for the async image caches (a surfaceId or a
   * canvas layer's full key).
   */
  private execShapeCommand(ctx: OffscreenCanvasRenderingContext2D, key: string, command: DrawCommand): void {
    switch (command.type) {
      case 'rect': {
        const p = command.params as RectParams;
        if (!p.fill && !p.stroke && !p.radius) {
          // Canvas-API dialect: style-less rect adds to the current path
          // (beginPath … rect … fill), like ctx.rect().
          ctx.rect(p.x, p.y, p.width, p.height);
          break;
        }
        ctx.beginPath();
        if (p.radius && p.radius > 0) {
          this.roundRect(ctx, p.x, p.y, p.width, p.height, p.radius);
        } else {
          ctx.rect(p.x, p.y, p.width, p.height);
        }
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      }

      case 'text': {
        const p = command.params as TextParams;
        ctx.font = p.font ?? '14px system-ui';
        ctx.textAlign = p.align ?? 'left';
        ctx.textBaseline = p.baseline ?? 'top';
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fillText(p.text, p.x, p.y, p.maxWidth);
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.strokeWidth ?? 1;
          ctx.strokeText(p.text, p.x, p.y, p.maxWidth);
        }
        if (!p.fill && !p.stroke) {
          ctx.fillStyle = '#000';
          ctx.fillText(p.text, p.x, p.y, p.maxWidth);
        }
        break;
      }

      case 'line': {
        const p = command.params as LineParams;
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y1);
        ctx.lineTo(p.x2, p.y2);
        ctx.strokeStyle = p.stroke ?? '#000';
        ctx.lineWidth = p.lineWidth ?? 1;
        if (p.lineCap) ctx.lineCap = p.lineCap;
        if (p.lineJoin) ctx.lineJoin = p.lineJoin;
        ctx.stroke();
        break;
      }

      case 'image': {
        const p = command.params as ImageParams;
        blitImage(ctx, p.data as CanvasImageSource, p);
        break;
      }

      case 'drawImage': {
        // Canvas-API dialect: route to image/imageUrl with the MDN argument
        // names mapped onto the existing async-loading machinery.
        const p = command.params as Record<string, unknown>;
        const params = {
          x: (p.dx ?? p.x) as number,
          y: (p.dy ?? p.y) as number,
          width: (p.dWidth ?? p.width) as number | undefined,
          height: (p.dHeight ?? p.height) as number | undefined,
          sx: p.sx as number | undefined,
          sy: p.sy as number | undefined,
          sWidth: p.sWidth as number | undefined,
          sHeight: p.sHeight as number | undefined,
          url: p.url as string,
          data: (p.data ?? p.image) as ImageParams['data'],
        };
        this.execShapeCommand(ctx, key, {
          type: params.url !== undefined ? 'imageUrl' : 'image',
          surfaceId: command.surfaceId,
          params,
        });
        break;
      }

      case 'imageUrl': {
        const p = command.params as ImageUrlParams;
        const sid = key;

        if (p.url.startsWith('data:')) {
          // Fast path: stable data URIs (e.g. chat messages) hit the cache
          // on every frame after the first decode.
          const cachedData = this.imageCache.get(p.url);
          if (cachedData && cachedData.loaded) {
            blitImage(ctx, cachedData.img, p);
            break;
          }

          // Live-screenshot fallback: show the previous data URI synchronously
          // while the new one decodes. Prevents blank flash on surfaces that
          // continually swap data URIs (remote views, etc.).
          const live = this.liveDataImages.get(sid);
          if (live) {
            blitImage(ctx, live.img, p);
          }

          // Async load: populate both the live (per-surface) cache and the
          // shared imageCache so subsequent renders skip the decode.
          const img = new Image();
          const savedTransform = ctx.getTransform();
          img.onload = () => {
            this.liveDataImages.set(sid, { img, width: img.naturalWidth, height: img.naturalHeight });

            if (this.imageCache.size >= Compositor.IMAGE_CACHE_MAX) {
              const firstKey = this.imageCache.keys().next().value!;
              this.imageCache.delete(firstKey);
            }
            this.imageCache.set(p.url, { img, loaded: true });

            this.lateBlit(sid, savedTransform, img, p);
            this.needsRender = true;
          };
          // On error, keep showing the old image (don't update liveDataImages)
          img.src = p.url;
        } else {
          // Regular URL path: use imageCache with CORS fallback
          const cached = this.imageCache.get(p.url);
          if (cached && cached.loaded) {
            blitImage(ctx, cached.img, p);
          } else {
            // Cache miss (including the not-yet-loaded case): show the previous
            // frame for this surface while the new image decodes, so a surface
            // that continually swaps images never flashes its background. Live
            // screenshots are interned to abx:/blob: URLs and land here (not the
            // data: fast path), so this fallback is what prevents the grey blink
            // between viewer updates.
            const live = this.liveDataImages.get(sid);
            if (live) blitImage(ctx, live.img, p);

            if (!cached) {
              // Evict oldest entries if cache is full
              if (this.imageCache.size >= Compositor.IMAGE_CACHE_MAX) {
                const firstKey = this.imageCache.keys().next().value!;
                this.imageCache.delete(firstKey);
              }
              const entry = { img: new Image(), loaded: false };
              this.imageCache.set(p.url, entry);
              const savedTransform = ctx.getTransform();
              const drawToSurface = (image: HTMLImageElement) => {
                entry.img = image;
                entry.loaded = true;
                // Remember this as the target's live frame so the next swap can
                // fall back to it instead of the background.
                this.liveDataImages.set(sid, { img: image, width: image.naturalWidth, height: image.naturalHeight });
                this.lateBlit(sid, savedTransform, image, p);
                this.needsRender = true;
              };
              // Load with CORS so the decoded pixels can be uploaded to WebGL.
              // We deliberately do NOT retry without crossOrigin on failure: a
              // non-CORS image taints the surface canvas, and a tainted canvas
              // makes texImage2D throw, which would break the whole desktop.
              // Cross-origin images that need to display must be fetched
              // server-side (HttpClient.getBase64) and drawn as data: URIs.
              entry.img.crossOrigin = 'anonymous';
              entry.img.onload = () => drawToSurface(entry.img);
              entry.img.onerror = () => this.imageCache.delete(p.url);
              entry.img.src = p.url;
            }
            // If cached but not yet loaded, the live frame above bridges the gap.
          }
        }
        break;
      }

      case 'path': {
        const p = command.params as PathParams;
        const path =
          typeof p.path === 'string' ? new Path2D(p.path) : p.path;
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fill(path);
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          if (p.lineCap) ctx.lineCap = p.lineCap;
          if (p.lineJoin) ctx.lineJoin = p.lineJoin;
          ctx.stroke(path);
        }
        break;
      }

      case 'save':
        ctx.save();
        break;

      case 'restore':
        ctx.restore();
        break;

      case 'clip': {
        const p = (command.params ?? {}) as Partial<RectParams> & { fillRule?: CanvasFillRule };
        if (p.x !== undefined && p.y !== undefined && p.width !== undefined && p.height !== undefined) {
          // High-level dialect: self-contained rectangular clip.
          ctx.beginPath();
          ctx.rect(p.x, p.y, p.width, p.height);
          ctx.clip();
        } else if (p.fillRule) {
          // Canvas-API dialect: clip to the current path.
          ctx.clip(p.fillRule);
        } else {
          ctx.clip();
        }
        break;
      }

      case 'translate': {
        const p = command.params as { x: number; y: number };
        ctx.translate(p.x ?? 0, p.y ?? 0);
        break;
      }

      case 'circle': {
        const p = command.params as CircleParams;
        const cx = p.cx ?? p.x ?? 0;
        const cy = p.cy ?? p.y ?? 0;
        if (!p.fill && !p.stroke) {
          // Style-less circle adds to the current path for a later fill/stroke.
          ctx.arc(cx, cy, p.radius, 0, Math.PI * 2);
          break;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, p.radius, 0, Math.PI * 2);
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      }

      case 'arc': {
        const p = command.params as ArcParams;
        const cx = p.cx ?? p.x ?? 0;
        const cy = p.cy ?? p.y ?? 0;
        if (!p.fill && !p.stroke) {
          // Canvas-API dialect: ctx.arc() path building, connecting from the
          // current point as in a browser.
          ctx.arc(cx, cy, p.radius, p.startAngle, p.endAngle, p.counterclockwise ?? false);
          break;
        }
        ctx.beginPath();
        if (p.fill) {
          ctx.moveTo(cx, cy);
        }
        ctx.arc(cx, cy, p.radius, p.startAngle, p.endAngle, p.counterclockwise ?? false);
        if (p.fill) {
          ctx.closePath();
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      }

      case 'ellipse': {
        const p = command.params as EllipseParams;
        const cx = p.cx ?? p.x ?? 0;
        const cy = p.cy ?? p.y ?? 0;
        if (!p.fill && !p.stroke) {
          // Canvas-API dialect: ctx.ellipse() path building.
          ctx.ellipse(cx, cy, p.radiusX, p.radiusY, p.rotation ?? 0,
            p.startAngle ?? 0, p.endAngle ?? Math.PI * 2, p.counterclockwise ?? false);
          break;
        }
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.radiusX, p.radiusY, p.rotation ?? 0,
          p.startAngle ?? 0, p.endAngle ?? Math.PI * 2, p.counterclockwise ?? false);
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      }

      case 'polygon': {
        const p = command.params as PolygonParams;
        if (p.points.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) {
          ctx.lineTo(p.points[i].x, p.points[i].y);
        }
        if (p.closePath !== false) {
          ctx.closePath();
        }
        if (p.fill) {
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.lineWidth ?? 1;
          if (p.lineCap) ctx.lineCap = p.lineCap;
          if (p.lineJoin) ctx.lineJoin = p.lineJoin;
          ctx.stroke();
        }
        break;
      }

      case 'rotate': {
        const p = command.params as { angle: number };
        ctx.rotate(p.angle);
        break;
      }

      case 'scale': {
        const p = command.params as { x: number; y: number };
        ctx.scale(p.x, p.y);
        break;
      }

      case 'globalAlpha': {
        const p = command.params as { alpha?: number; value?: number };
        ctx.globalAlpha = p.alpha ?? p.value ?? 1;
        break;
      }

      case 'fill': {
        // Canvas-API dialect: fill the current path (or an SVG path string).
        const p = (command.params ?? {}) as { fillStyle?: string; color?: string; fillRule?: CanvasFillRule; path?: string };
        const style = p.fillStyle ?? p.color;
        if (style) ctx.fillStyle = style;
        if (p.path) {
          const path2d = new Path2D(p.path);
          if (p.fillRule) ctx.fill(path2d, p.fillRule); else ctx.fill(path2d);
        } else {
          if (p.fillRule) ctx.fill(p.fillRule); else ctx.fill();
        }
        break;
      }

      case 'stroke': {
        // Canvas-API dialect: stroke the current path (or an SVG path string).
        const p = (command.params ?? {}) as { strokeStyle?: string; color?: string; lineWidth?: number; path?: string };
        const style = p.strokeStyle ?? p.color;
        if (style) ctx.strokeStyle = style;
        if (p.lineWidth !== undefined) ctx.lineWidth = p.lineWidth;
        if (p.path) {
          ctx.stroke(new Path2D(p.path));
        } else {
          ctx.stroke();
        }
        break;
      }

      case 'shadow': {
        const p = command.params as ShadowParams;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.blur;
        ctx.shadowOffsetX = p.offsetX ?? 0;
        ctx.shadowOffsetY = p.offsetY ?? 0;
        break;
      }

      case 'setLineDash': {
        const p = command.params as { segments?: number[]; value?: number[] };
        ctx.setLineDash(p.segments ?? p.value ?? []);
        break;
      }

      case 'linearGradient': {
        const p = command.params as LinearGradientParams;
        const grad = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
        for (const stop of p.stops) {
          grad.addColorStop(stop.offset, stop.color);
        }
        ctx.fillStyle = grad;
        ctx.strokeStyle = grad;
        break;
      }

      case 'radialGradient': {
        const p = command.params as RadialGradientParams;
        const grad = ctx.createRadialGradient(p.cx0, p.cy0, p.r0, p.cx1, p.cy1, p.r1);
        for (const stop of p.stops) {
          grad.addColorStop(stop.offset, stop.color);
        }
        ctx.fillStyle = grad;
        ctx.strokeStyle = grad;
        break;
      }

      case 'conicGradient': {
        const p = command.params as ConicGradientParams;
        const grad = ctx.createConicGradient(p.startAngle, p.cx, p.cy);
        for (const stop of p.stops) {
          grad.addColorStop(stop.offset, stop.color);
        }
        ctx.fillStyle = grad;
        ctx.strokeStyle = grad;
        break;
      }

      case 'putImageData': {
        const p = command.params as { data: number[] | Uint8ClampedArray; width: number; height: number; dx?: number; dy?: number };
        const pixels = (p.data instanceof Uint8ClampedArray ? p.data : new Uint8ClampedArray(p.data)) as Uint8ClampedArray<ArrayBuffer>;
        ctx.putImageData(new ImageData(pixels, p.width, p.height), p.dx ?? 0, p.dy ?? 0);
        break;
      }

      case 'bezierCurve': {
        const p = command.params as BezierCurveParams;
        ctx.beginPath();
        ctx.moveTo(p.x0, p.y0);
        ctx.bezierCurveTo(p.cp1x, p.cp1y, p.cp2x, p.cp2y, p.x1, p.y1);
        if (p.fill) {
          ctx.closePath();
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke !== undefined || !p.fill) {
          ctx.strokeStyle = p.stroke ?? '#000';
          ctx.lineWidth = p.lineWidth ?? 1;
          if (p.lineCap) ctx.lineCap = p.lineCap;
          if (p.lineJoin) ctx.lineJoin = p.lineJoin;
          ctx.stroke();
        }
        break;
      }

      case 'quadraticCurve': {
        const p = command.params as QuadraticCurveParams;
        ctx.beginPath();
        ctx.moveTo(p.x0, p.y0);
        ctx.quadraticCurveTo(p.cpx, p.cpy, p.x1, p.y1);
        if (p.fill) {
          ctx.closePath();
          ctx.fillStyle = p.fill;
          ctx.fill();
        }
        if (p.stroke !== undefined || !p.fill) {
          ctx.strokeStyle = p.stroke ?? '#000';
          ctx.lineWidth = p.lineWidth ?? 1;
          if (p.lineCap) ctx.lineCap = p.lineCap;
          if (p.lineJoin) ctx.lineJoin = p.lineJoin;
          ctx.stroke();
        }
        break;
      }

      default:
        // Canvas 2D API pass-through: context methods (named args per
        // CANVAS_CTX_METHODS) and settable properties ({ value } commands).
        this.applyContextCommand(ctx, command.type, command.params as Record<string, unknown> | undefined);
        break;
    }
  }

  /**
   * Late async image writes (decode finished after the draw batch) land on
   * whichever target issued the command — a window surface or a canvas-layer
   * scene node.
   */
  private lateBlit(key: string, transform: DOMMatrix, image: CanvasImageSource, p: ImageUrlParams): void {
    const surf = this.surfaces.get(key);
    if (surf) {
      surf.ctx.save();
      surf.ctx.setTransform(transform);
      blitImage(surf.ctx, image, p);
      surf.ctx.restore();
      surf.dirty = true;
      return;
    }
    const layer = this.canvasLayers.get(key);
    if (layer) {
      layer.ctx.save();
      layer.ctx.setTransform(transform);
      blitImage(layer.ctx, image, p);
      layer.ctx.restore();
      layer.needsUpload = true;
    }
  }

  /**
   * Fully reset a surface's context state and wipe its bitmap. Prevents leaks
   * from a previous frame's unbalanced save/restore (e.g. a child render that
   * errored mid-draw, leaving residual translate/clip on the context). Without
   * this, clearRect operates in the wrong coordinate space and fails to clear
   * the full surface.
   */
  private resetSurfaceState(surface: Surface): void {
    this.resetCtxState(surface.ctx, surface.rect.width, surface.rect.height);
  }

  /** Reset one 2D context's state and wipe its bitmap to transparent. */
  private resetCtxState(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): void {
    if (typeof (ctx as unknown as { reset?: () => void }).reset === 'function') {
      (ctx as unknown as { reset: () => void }).reset();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.globalAlpha = 1.0;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.clearRect(0, 0, width, height);
  }

  /**
   * Execute a Canvas 2D API command generically: call the context method with
   * args looked up by name from params, or assign a settable property from
   * params.value. fillStyle/strokeStyle values may be gradient descriptors.
   */
  private applyContextCommand(
    ctx: OffscreenCanvasRenderingContext2D,
    type: DrawCommandType,
    params: Record<string, unknown> | undefined,
  ): void {
    const argNames = CANVAS_CTX_METHODS[type];
    if (argNames) {
      const args = argNames.map((name) => params?.[name]);
      while (args.length > 0 && args[args.length - 1] === undefined) {
        args.pop();
      }
      (ctx as unknown as Record<string, (...a: unknown[]) => void>)[type](...args);
      return;
    }
    if ((CANVAS_CTX_PROPERTIES as readonly string[]).includes(type)) {
      let value = params?.value;
      if ((type === 'fillStyle' || type === 'strokeStyle') && value !== null && typeof value === 'object') {
        value = this.buildGradient(ctx, value as Record<string, unknown>);
      }
      (ctx as unknown as Record<string, unknown>)[type] = value;
    }
  }

  /**
   * Build a CanvasGradient from a descriptor object. The kind is inferred from
   * the coordinates present: radial (cx0/r0), conic (startAngle), else linear.
   */
  private buildGradient(
    ctx: OffscreenCanvasRenderingContext2D,
    d: Record<string, unknown>,
  ): CanvasGradient {
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    let grad: CanvasGradient;
    if (d.r0 !== undefined || d.cx0 !== undefined) {
      grad = ctx.createRadialGradient(n(d.cx0), n(d.cy0), n(d.r0), n(d.cx1), n(d.cy1), n(d.r1));
    } else if (d.startAngle !== undefined) {
      grad = ctx.createConicGradient(n(d.startAngle), n(d.cx), n(d.cy));
    } else {
      grad = ctx.createLinearGradient(n(d.x0), n(d.y0), n(d.x1), n(d.y1));
    }
    for (const stop of (d.stops ?? []) as GradientStop[]) {
      grad.addColorStop(stop.offset, stop.color);
    }
    return grad;
  }

  /**
   * Draw a rounded rectangle.
   */
  private roundRect(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radiusInput: number
  ): void {
    // Clamp to half the smaller dimension so a "pill" radius (e.g. 999) renders
    // as a true pill instead of drawing giant arcs that escape the rect.
    const radius = Math.max(0, Math.min(radiusInput, width / 2, height / 2));
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.arcTo(x + width, y, x + width, y + radius, radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    ctx.lineTo(x + radius, y + height);
    ctx.arcTo(x, y + height, x, y + height - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  }

  /**
   * Sort surfaces by z-index.
   */
  private sortSurfaces(): void {
    this.sortedSurfaces = Array.from(this.surfaces.values()).sort(
      (a, b) => a.zIndex - b.zIndex
    );
  }

  /**
   * Start the render loop.
   */
  private startRenderLoop(): void {
    const render = () => {
      // A single throw inside render() must never permanently stop the loop:
      // the rAF re-arm below has to run even when a frame fails, or one GL error
      // (an oversized/incomplete framebuffer on mobile, a lazy shader compile
      // failure) freezes the whole desktop with only a lone console error. Log
      // once per failure and keep scheduling frames.
      try {
        // Composite playing videos into their surfaces before the render check,
        // so a fresh frame both updates the canvas and schedules the upload.
        if (this.blitVideoFrames()) this.needsRender = true;
        if (this.needsRender) {
          // Clear BEFORE rendering so an animating frame can re-request.
          this.needsRender = false;
          this.render();
        }
      } catch (err) {
        console.error('[Compositor] render frame failed:', err);
      }
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.animationFrameId = requestAnimationFrame(render);
  }

  // ── Video compositing ────────────────────────────────────────────────

  /**
   * Register a client-side video element for videoFrame regions. Element
   * lifecycle (creation, src/srcObject, disposal) belongs to FrontendClient;
   * the compositor only reads frames.
   */
  registerVideoElement(videoId: string, video: HTMLVideoElement): void {
    this.videoElements.set(videoId, video);
    this.needsRender = true;
  }

  unregisterVideoElement(videoId: string): void {
    this.videoElements.delete(videoId);
    this.videoRegions.delete(videoId);
  }

  /**
   * Draw the current frame of every live video region into its surface
   * canvas. Runs every animation frame; cheap when nothing plays because
   * paints are gated on currentTime movement. Returns true when any surface
   * was repainted (its texture re-uploads on the following render).
   */
  private blitVideoFrames(): boolean {
    if (this.videoRegions.size === 0) return false;
    let painted = false;
    for (const [videoId, region] of this.videoRegions) {
      if (region.hidden || region.width <= 0 || region.height <= 0) continue;
      const surface = this.surfaces.get(region.surfaceId);
      if (!surface || surface.tainted) continue;
      const stamp = this.surfaceVideoStamps.get(region.surfaceId) ?? 0;
      if (region.stamp !== stamp) continue; // stale: last full redraw skipped it
      const video = this.videoElements.get(videoId);
      if (!video || video.readyState < 2 || video.videoWidth === 0) continue;
      // Repaint when time moved (playing or a paused seek) or on first paint.
      const t = video.currentTime;
      if (t === region.lastTime && !(!video.paused && !video.ended)) continue;
      region.lastTime = t;
      this.paintVideoRegion(surface, video, region);
      surface.dirty = true;
      painted = true;
    }
    return painted;
  }

  private paintVideoRegion(
    surface: Surface,
    video: HTMLVideoElement,
    region: { x: number; y: number; width: number; height: number; clipTop?: number; clipBottom?: number },
  ): void {
    const ctx = surface.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Clip to the region rect, tightened by any scroll-viewport bounds.
    const top = Math.max(region.y, region.clipTop ?? region.y);
    const bottom = Math.min(region.y + region.height, region.clipBottom ?? region.y + region.height);
    if (bottom <= top) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.rect(region.x, top, region.width, bottom - top);
    ctx.clip();
    // Letterbox background, then contain-fit the frame.
    ctx.fillStyle = '#000';
    ctx.fillRect(region.x, region.y, region.width, region.height);
    const scale = Math.min(region.width / video.videoWidth, region.height / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    ctx.drawImage(
      video,
      region.x + (region.width - dw) / 2,
      region.y + (region.height - dh) / 2,
      dw, dh,
    );
    ctx.restore();
  }

  /**
   * Stop the render loop.
   */
  stop(): void {
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    this.renderer.dispose();
  }

  /**
   * Render the scene.
   */
  private render(): void {
    if (this.renderer.isContextLost) return;
    const frameStart = performance.now();
    this.postFxInstance?.newFrame(performance.now());
    // Advance declarative animations; keep the loop alive while any run.
    if (this.stepAnimations(performance.now())) this.needsRender = true;
    // A released node gliding on inertia moves here, off the render loop.
    if (this.stepNodeDragInertia(performance.now())) this.needsRender = true;
    // Constraints (follow, lookAt) see this frame's positions; released
    // camera orbits coast here too.
    if (this.stepConstraints(performance.now())) this.needsRender = true;
    if (this.stepCameras(performance.now())) this.needsRender = true;
    // Exposé's spread, selection highlight and flicks (phone and desktop).
    if (this.stepExpose(performance.now())) this.needsRender = true;
    // Resolved node params are cached per frame (all passes share them).
    this.frameNodes.clear();
    this.touchedCustomMeshes.clear();
    this.touchedInstanced.clear();
    this.drawnThisFrame.clear();
    this.renderer.beginFrame();
    if (this.mobileMode) {
      this.renderMobile();
    } else {
      this.renderDesktop();
    }
    // Bloom is a post pass over the rendered scene, beneath the 2D chrome,
    // clipped to each window that asked for it.
    this.applyBloomPasses();
    this.overlay.draw();
    this.noteFrame(frameStart);
    this.pruneCustomMeshes();
    this.pruneCanvasLayers();
    this.pruneParticles();
    this.pruneContent();
    this.postFxInstance?.frameEnd(this.needsRender);
  }

  /**
   * Perspective camera whose z=0 plane maps ~1:1 to CSS pixels. The eye sits
   * over the viewport center (plus scroll), so desktop scroll is a camera
   * truck and lifted/tilted slabs gain genuine parallax.
   *
   * The phone's view zoom is a focal-length change: the eye stays at the
   * same distance over the centre of what is shown and the projection's
   * x/y scale grows by viewZoom, so the scene magnifies without changing its
   * perspective (screen = (workspace - scroll) * viewZoom on the z=0 plane).
   */
  private updateCamera(scrollX: number, scrollY: number): void {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const zoom = this.viewZoom;
    const dist = cameraDistance(h);
    const eyeX = w / (2 * zoom) + scrollX;
    const eyeY = h / (2 * zoom) + scrollY;
    this.cameraPos = [eyeX, eyeY, dist];
    const proj = mat4PerspectiveYDown(
      Compositor.CAMERA_FOV, w / h,
      dist * NEAR_PLANE_FACTOR, dist * FAR_PLANE_FACTOR,
    );
    if (zoom !== 1) {
      proj[0] *= zoom;
      proj[5] *= zoom;
    }
    const view = mat4Translation(-eyeX, -eyeY, -dist);
    this.viewProj = mat4Multiply(proj, view);
    this.invViewProj = mat4Invert(this.viewProj);
  }

  /** A scene-theme colour by token name, or the fallback before any theme arrives. */
  private sceneColor(token: string, fallback: string): string {
    return this.sceneTheme?.colors[token] ?? fallback;
  }

  /** Theme-derived chrome values with arcane defaults pre-theme. */
  /**
   * Theme-derived chrome values. The design casts hard print shadows: ink
   * under resting windows (lighter, so stacks stay calm) and the palette's
   * accent under the focused one (with its accent title band, that is the
   * whole focus treatment: no glow). Defaults hold until the first scene
   * theme arrives.
   */
  private chromeColors(): {
    glow: RGBA; radius: number;
    block: { offset: number; rest: RGBA; focus: RGBA };
  } {
    const t = this.sceneTheme;
    const shape = t?.shape;
    const rest = parseCssColor(shape?.blockShadowColor ?? t?.shadow.color ?? 'rgba(0,0,0,0.9)');
    return {
      glow: parseCssColor(t?.glow.focusColor ?? this.focusGlowColor),
      radius: t?.windowRadius ?? 0,
      block: {
        offset: shape?.blockShadowOffset ?? 6,
        rest: { ...rest, a: rest.a * 0.45 },
        focus: parseCssColor(shape?.blockFocusColor ?? t?.colors.accent ?? '#d32f22'),
      },
    };
  }

  private renderDesktop(): void {
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);

    const chrome = this.chromeColors();
    let animating = false;
    const now = performance.now();
    // Any modal up? Everything else recedes behind it (Exposé shows every
    // window it spreads at full depth).
    let anyModal = false;
    for (const s of this.sortedSurfaces) {
      if (this.exposeT > 0) break;
      if (s.visible && s.drawn && !this.isWorkspaceFiltered(s) && this.surfaceGl.get(s.id)?.modal) {
        anyModal = true;
        break;
      }
    }

    // World-scope nodes behind the windows (desktop décor, roaming pets).
    this.drawWorldNodes('back');

    // Windows and stacked world objects (layer 'stack') share one depth
    // order, back to front (see desktopOrder).
    const order = this.desktopOrder();
    // Exposé: the world stays where it is and recedes under the scrim.
    if (this.exposeT > 0) this.drawExposeUnderlay(order);
    const deferred: Array<{ surface: Surface; frame: Mat4; cam: SceneCamera; index: number }> = [];
    for (let oi = 0; oi < order.length; oi++) {
      const item = order[oi];
      // Exposé shows the windows it spread (see exposeView) over the scrim,
      // and on the desktop the system rails, which stay put.
      if (this.exposeT > 0 && (item.kind === 'stack'
          || (!this.exposeSlots.has(item.surface.id) && !this.exposeKeeps(item.surface)))) continue;
      if (item.kind === 'stack') {
        // A stacked world object gets its own depth range, like a window.
        this.renderer.clearDepth();
        this.drawNodeTree(item.key, mat4Identity(), this.globalCamera(), 'stack', undefined, undefined, undefined, { rootId: item.rootId });
        continue;
      }
      const surface = item.surface;
      const state = this.glState(surface.id);
      // A zoomed-in phone skips windows the camera cannot see at all (their
      // resting slab still answers picking).
      if (this.mobileMode && this.mobileOffCamera(surface, state)) {
        const r = surface.rect;
        state.model = mat4TRS(r.x + r.width / 2, r.y + r.height / 2, 0, 0, 0, 0, r.width, r.height, 1);
        continue;
      }
      // A window riding a scene node hangs from the node's (scale-free) frame
      // and renders through the camera that node renders with. Everything
      // below is then placed in that frame, centred on the window.
      // (Exposé carries a window to its grid slot the same way.)
      const anchor = state.attach ? this.anchorView(surface, state, 0) : this.exposeView(surface, state);
      const parent = anchor?.frame;
      const place = (m: Mat4): Mat4 => (parent ? mat4Multiply(parent, m) : m);
      // In the desktop Exposé the selection wears focus: the lift and the accent print shadow.
      const focused = !this.mobileMode && this.exposeT > 0 && this.exposeSlots.has(surface.id)
        ? surface.id === this.exposeSelected
        : surface.id === this.focusedSurfaceId;
      // First appearance plays the open transition.
      if (!state.seen) {
        state.seen = true;
        const open = this.hasMotion(surface) ? this.resolveEffect(this.slabMotionConfig.transitions.open) : undefined;
        if (open && !state.effects?.length) {
          (state.effects ??= []).push(this.makeRun(open, now, surface.rect.width, surface.rect.height));
        }
      }
      const baseCx = parent ? 0 : surface.rect.x + surface.rect.width / 2;
      const baseCy = parent ? 0 : surface.rect.y + surface.rect.height / 2;
      const motion = this.evalPose(state.effects ?? [], now, parent ? parent[12] : baseCx, parent ? parent[13] : baseCy);
      if (state.effects?.length) {
        state.effects = state.effects.filter((r) => now - r.start < r.spec.duration);
      }
      this.stepRecede(state, anyModal, motion);
      if (motion.moving) animating = true;

      // Ease the focus lift and spring-settle the drag tilt.
      const liftTarget = focused ? Compositor.FOCUS_LIFT : 0;
      state.lift += (liftTarget - state.lift) * 0.25;
      if (Math.abs(state.lift - liftTarget) < 0.1) state.lift = liftTarget;
      else animating = true;
      state.tiltTargetX *= 0.82;
      state.tiltTargetY *= 0.82;
      state.tiltX += (state.tiltTargetX - state.tiltX) * 0.3;
      state.tiltY += (state.tiltTargetY - state.tiltY) * 0.3;
      if (Math.abs(state.tiltX) > 0.0005 || Math.abs(state.tiltY) > 0.0005) animating = true;
      else { state.tiltX = 0; state.tiltY = 0; }

      const rect = {
        x: surface.rect.x,
        y: surface.rect.y,
        width: surface.rect.width * motion.sx,
        height: surface.rect.height * motion.sy,
      };
      const cx = baseCx + motion.dx;
      const cy = baseCy + motion.dy;
      const userRot = state.userRotation ?? [0, 0, 0];
      const rot: [number, number, number] = [userRot[0] + motion.rx, userRot[1] + motion.ry, userRot[2] + motion.rz];
      const z = state.lift + (state.userZ ?? 0) + motion.dz;
      const model = place(mat4TRS(
        cx, cy, z,
        state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
        rect.width, rect.height, 1,
      ));
      state.model = model;
      this.drawnThisFrame.add(surface.id);

      // The window's own camera — used for the slab AND its content subtree.
      // For an unrotated slab the off-axis projection renders identically to
      // the desktop camera by construction, but once the slab is rotated
      // (setSlabTransform, drag tilt) the two cameras disagree: the desktop
      // camera shows an oblique view of the frame while the window camera
      // shows the content nearly head-on, so the frame visibly tilted away
      // from its own content. Drawing both through ONE camera keeps a tilted
      // window rigid.
      // A window pinned to the screen (phone) sits at its rect as usual but
      // is seen through its own screen view (see pinView).
      const pin = anchor ? undefined : this.pinView(surface);
      const cam = anchor?.cam ?? this.windowCamera(cx, cy, z, pin);
      state.cam = cam;
      state.attachFrame = parent;
      state.attachCam = anchor ? cam : undefined;
      state.pinView = pin;

      const radius = surface.transparent ? 0 : Math.min(chrome.radius, rect.width / 2, rect.height / 2);

      if (!surface.transparent) {
        // Constructivist print shadow: a solid, unblurred slab offset
        // down-right (red under the focused window, ink under the rest).
        // The sub-pixel sigma turns the glow shader into a hard-edged fill.
        const off = chrome.block.offset;
        const bw = rect.width + 2;
        const bh = rect.height + 2;
        const blockModel = place(mat4TRS(
          cx + off, cy + off, z - 1,
          state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
          bw + 4, bh + 4, 1,
        ));
        this.renderer.drawGlow({
          model: blockModel, viewProj: cam.viewProj,
          quadWidth: bw + 4, quadHeight: bh + 4,
          halfWidth: rect.width / 2, halfHeight: rect.height / 2,
          radius,
          color: focused ? chrome.block.focus : chrome.block.rest,
          a1: motion.opacity, sigma1: 0.4,
        });
      }
      const tilt = [state.tiltX + rot[0], state.tiltY + rot[1], rot[2]];
      this.drawPoseAuras(motion, cx, cy, z, rect.width, rect.height, tilt, cam.viewProj, parent);

      this.drawSurfaceSlab(surface, state, model, {
        radius,
        dim: motion.dim,
        opacity: motion.opacity,
        // Focus is carried by the accent title band and the accent print
        // shadow; a rim only shows while an effect asks for one.
        rim: motion.rim,
        viewProj: cam.viewProj,
      });
      this.drawPoseLights(motion, now, cx, cy, z, rect.width, rect.height, tilt, cam.viewProj, parent);

      // Scene-vocabulary nodes ride the window's UNSCALED frame (the slab
      // model bakes in the window's px size, which would distort meshes).
      const frame = place(mat4TRS(
        cx, cy, z,
        state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
        motion.sx, motion.sy, Math.min(motion.sx, motion.sy),
      ));
      state.frame = frame;
      // The window's subtree is drawn through the same window camera as the
      // slab (see above), so its depth converges into the window rather than
      // toward the middle of the screen (see windowCamera). Without this, a
      // deep scene in an off-centre window slides sideways as it recedes and
      // is scissored away by its own clip rect.

      // The window's own content (chrome + widgets + default canvas) is the
      // BACKMOST 2D layer of its subtree. Scene nodes draw above it; canvas
      // nodes (kind:'canvas') interleave with meshes by camera depth, so
      // 2D and 3D layers stack freely: base 2D → 3D → 2D → 3D → …
      // Occluded children clip to the content rect; occlude:false children
      // draw last, unclipped (pop-out 3D / decorations over the chrome).
      //
      // Isolate this window's 3D depth range. The depth buffer is shared and
      // cleared only once per frame, but window compositing is painter's order
      // (back-to-front) — a window's slab writes no depth. Without a reset, an
      // earlier (further-back) window whose 3D content pops toward the camera
      // leaves near-camera depth values that this window's later depth-tested
      // draws lose against, so the back window's geometry (and its chrome edge)
      // bleeds through the front window. Clearing here gives each window a fresh
      // depth range; painter's order then guarantees a front window's content
      // always composites over a back window's, whatever their world depths.
      this.renderer.clearDepth();
      this.drawVocabNodes(surface, frame, 'occluded', cam);
      // Pop-outs (clip 'none' / occlude:false). With nothing covering the
      // window they draw now, sharing this window's depth range, so stacking
      // between clipped and pop-out content is unchanged. When a higher
      // window covers it they wait until every window is down and are then
      // depth-tested against the covering slabs (drawDeferredPopouts): near
      // parts show over the higher window, far parts hide behind it.
      if (this.passNodes(surface.id, undefined, 'none').length > 0) {
        if (this.popoutsCovered(order, oi, surface)) deferred.push({ surface, frame, cam, index: oi });
        else this.drawVocabNodes(surface, frame, 'overlay', cam);
      }
    }
    for (const d of deferred) this.drawDeferredPopouts(d, order);

    // Closing / minimizing slabs, drawn over the live ones.
    this.renderer.clearDepth();
    if (this.drawGhosts(now)) animating = true;

    // World-scope nodes above the windows sit over every window's 3D content,
    // so give them a fresh depth range rather than testing against the last
    // window's leftover depth.
    this.renderer.clearDepth();
    if (this.exposeT <= 0) this.drawWorldNodes('front');

    // The phone draws its own 2D chrome (renderMobile); the desktop's is the
    // scrollbars, or Exposé's titles while it shows.
    if (!this.mobileMode) {
      if (this.exposeT > 0.02) this.renderExposeOverlay();
      else this.renderScrollbarsOverlay();
    }
    if (animating) this.needsRender = true;
  }

  /** Upload (if dirty) and draw one surface slab. */
  private drawSurfaceSlab(
    surface: Surface,
    state: SurfaceGlState,
    model: Mat4,
    opts: { radius: number; dim: number; opacity: number; rim?: RGBA; scissor?: { x: number; y: number; width: number; height: number }; viewProj?: Mat4 },
  ): void {
    if (!state.texture) {
      state.texture = this.renderer.createTexture();
      surface.dirty = true;
    }
    if (surface.dirty && !surface.tainted) {
      const ok = this.renderer.uploadTexture(state.texture, surface.canvas);
      surface.dirty = false;
      if (!ok) {
        // Cross-origin image tainted this canvas: texImage2D can no longer
        // read it. Stop retrying; the slab keeps its last-good texture (or the
        // 1x1 placeholder) so the rest of the desktop renders normally.
        surface.tainted = true;
        const taintDetail = `surface ${surface.id} tainted by a cross-origin image; freezing its texture`;
        console.warn(`[Compositor] ${taintDetail}`);
        // The browser console never crosses the wire; surface the taint
        // through the clientDiagnostic relay so it lands in abject.log.
        this.onDiagnostic?.('surface-tainted', taintDetail);
      }
      // A fresh upload replaced level 0; any mip chain now describes old pixels.
      if (state.slabMips) this.syncSlabMips(state, true);
    }
    // A phone camera zoomed out minifies slabs: sample a mip chain so window
    // text stays steady instead of shimmering. (The desktop draws at 1:1.)
    if (this.mobileMode && this.viewZoom < 0.999 && !state.slabMips) this.syncSlabMips(state, false);
    this.renderer.drawSurface({
      model,
      viewProj: opts.viewProj ?? this.viewProj,
      texture: state.texture,
      width: surface.rect.width,
      height: surface.rect.height,
      radius: opts.radius,
      dim: opts.dim,
      opacity: opts.opacity,
      rimColor: opts.rim,
      rimWidth: 2.5,
      scissor: opts.scissor,
    });
  }

  /**
   * Match a slab texture's filtering to the phone camera: zoomed out, it
   * samples a freshly generated mip chain (trilinear); otherwise plain
   * linear. Called after every upload of a mipmapped slab, since a stale
   * chain beside a new level 0 would leave the texture incomplete.
   */
  private syncSlabMips(state: SurfaceGlState, _reuploaded: boolean): void {
    const tex = state.texture;
    if (!tex) return;
    const gl = this.renderer.context;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.mobileMode && this.viewZoom < 0.999) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      state.slabMips = true;
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      state.slabMips = false;
    }
  }

  /**
   * Draw a window's scene-vocabulary nodes in one of two passes. The window's
   * own content (chrome + widgets + default canvas) is the BACKMOST 2D layer
   * of its subtree; scene nodes draw above it. Within a pass, canvas nodes
   * (kind:'canvas' — 2D layers as rectangles in 3D space) interleave with
   * meshes by camera depth, so 2D and 3D stack freely.
   * - 'occluded' (default for window children): drawn after the base slab,
   *   clipped to the window's content rect, so nodes sit above the window's
   *   base 2D content but cannot paint over the title bar or spill across
   *   the desktop.
   *   Nodes with `clip: 'window'` draw in the same pass right after, clipped
   *   to the WHOLE window rect (title bar included) and sharing its depth.
   * - 'overlay': pop-out nodes (`clip: 'none'`, or the older `occlude:
   *   false`), unclipped, so they may extend past the window. The desktop
   *   draws these inline when nothing covers the window, and otherwise in a
   *   deferred pass depth-tested against the windows above (see
   *   drawDeferredPopouts).
   * `depthOnly` replays the pass's opaque meshes into the depth buffer only.
   */
  private drawVocabNodes(
    surface: Surface,
    surfaceModel: Mat4,
    pass: 'occluded' | 'overlay',
    cam: SceneCamera,
    // Force the projected-quad clip even when the window itself is untilted:
    // a caller that poses a slab through the model it passes here, rather
    // than through the surface's glState, is invisible to the tilt test
    // below, which would fall back to an upright screen rect.
    forceQuadClip = false,
    depthOnly = false,
    /** Pop-outs drawn in the deferred pass (see drawDeferredPopouts). */
    deferred = false,
  ): void {
    if (pass === 'overlay') {
      // Pop-outs (clip 'none') hang off the window's frame in window px:
      // chrome decorations (the focus sigil), badges, parts reaching past the
      // window. They render through the window camera, like the slab; a
      // camera node frames only the clipped scene inside the window, so an
      // orbiting camera never swings the window's chrome around.
      this.drawNodeTree(surface.id, surfaceModel, cam, undefined, undefined, 'none', undefined, { depthOnly, deferred });
      return;
    }
    // A camera node replaces the window camera for the clipped subtree;
    // clipping (the content quad) stays on the window camera the slab draws with.
    const sceneCam = this.cameraFor(surface, cam, surfaceModel) ?? cam;
    const state = this.glState(surface.id);
    const rot = state.userRotation;
    // A window riding a node is transformed arbitrarily, like a tilted one
    // (so is a window the phone's Exposé carries to a grid slot).
    const tilted = forceQuadClip || !!state.attach || !!state.pinView || (this.exposeT > 0 && this.exposeSlots.has(surface.id))
      || !!(state.tiltX || state.tiltY || (rot && (rot[0] || rot[1] || rot[2])));
    for (const mode of ['content', 'window'] as const) {
      if (this.passNodes(surface.id, undefined, mode).length === 0) continue;
      let clip = mode === 'content' ? this.contentClip(surface) : this.windowClip(surface);
      let clipQuad: { model: Mat4; viewProj: Mat4 } | undefined;
      if (tilted) {
        // A tilted window's content region is a rotated quad on screen; the
        // axis-aligned scissor would crop it with an upright rectangle. Build
        // the clip rect's model under the tilted frame for a stencil clip,
        // and shrink the scissor to the quad's conservative screen bbox (it
        // still bounds the stencil clear + draws cheaply).
        const model = mode === 'content'
          ? this.contentQuadModel(surface, surfaceModel).model
          : mat4Multiply(surfaceModel, mat4TRS(0, 0, 0, 0, 0, 0, surface.rect.width, surface.rect.height, 1));
        clipQuad = { model, viewProj: cam.viewProj };
        clip = this.projectedQuadBounds(model, cam.viewProj) ?? clip;
      }
      this.drawNodeTree(surface.id, surfaceModel, sceneCam, undefined, clip, mode, clipQuad, { depthOnly });
    }
  }

  /**
   * The window's CONTENT rect (title bar + border inset) as a unit-quad
   * model under the window's frame matrix — the tilted-space twin of
   * contentClip().
   */
  private contentQuadModel(surface: Surface, surfaceModel: Mat4): { model: Mat4; cw: number; ch: number } {
    const { titleBar, border } = Compositor.contentInsets(surface);
    const cw = Math.max(1, surface.rect.width - border * 2);
    const ch = Math.max(1, surface.rect.height - titleBar - border);
    // Content center offset from the window center, in window-local px.
    const oy = (titleBar - border) / 2;
    return { model: mat4Multiply(surfaceModel, mat4TRS(0, oy, 0, 0, 0, 0, cw, ch, 1)), cw, ch };
  }

  /**
   * Conservative screen-space bbox of a projected unit quad, clamped to the
   * viewport; undefined when the quad is entirely behind the camera.
   */
  private projectedQuadBounds(model: Mat4, viewProj: Mat4): { x: number; y: number; width: number; height: number } | undefined {
    const m = mat4Multiply(viewProj, model);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [qx, qy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const w = m[3] * qx + m[7] * qy + m[15];
      if (w <= 1e-6) continue;
      const x = (m[0] * qx + m[4] * qy + m[12]) / w;
      const y = (m[1] * qx + m[5] * qy + m[13]) / w;
      const sx = (x + 1) / 2 * this.width;
      const sy = (1 - (y + 1) / 2) * this.height;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    if (!Number.isFinite(minX)) return undefined;
    const pad = 2;
    const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
    return {
      x: x0, y: y0,
      width: Math.min(this.width, maxX + pad) - x0,
      height: Math.min(this.height, maxY + pad) - y0,
    };
  }

  /** The desktop camera: eye over the viewport centre. World-scope nodes use this. */
  private globalCamera(): SceneCamera {
    return { viewProj: this.viewProj, invViewProj: this.invViewProj, cameraPos: this.cameraPos };
  }

  /**
   * The camera for ONE window's 3D subtree.
   *
   * The desktop camera's eye sits over the VIEWPORT centre, so its vanishing
   * point is the middle of the screen. That is right for the slabs themselves
   * (they live at z≈0, where the projection is 1:1 and the eye's position does
   * not matter) and it is what gives lifted/tilted windows their parallax.
   *
   * It is wrong for a window's own 3D content. A scene attached to a window is
   * clipped to that window's content rect, but under the desktop camera its
   * depth converges toward the SCREEN centre — so in any window that is not
   * centred, geometry slides sideways as it recedes and walks out from under
   * its own clip rect. The deeper the scene, the further it walks: at z = -900
   * it is displaced by 31% of the window's offset from the screen centre, which
   * is enough to push a far wall (or a whole AI paddle) outside the window and
   * make it vanish.
   *
   * So a window's subtree gets its own camera: the eye moves over the WINDOW's
   * centre, making the window's own axis the view axis — depth now converges
   * toward the middle of the window, where it belongs. To keep that content
   * glued to the slab the desktop camera drew, the projection is OFF-AXIS: the
   * principal point is shifted (proj[8]/proj[9], a constant NDC offset) so the
   * window's centre still lands exactly where the slab's centre was rendered.
   * Depth, scale, and the 1:1 plane are untouched, so window 2D and window 3D
   * stay in lockstep and depth values remain comparable with every other window.
   */
  private windowCamera(cx: number, cy: number, z: number, screen?: ScreenView): SceneCamera {
    const W = Math.max(1, this.width);
    const H = Math.max(1, this.height);
    const D = cameraDistance(H);

    // Where the desktop camera puts this window's centre on screen (its slab is
    // drawn there, so the subtree must converge on the same point). The
    // phone's view zoom scales screen offsets from the eye (see updateCamera).
    // A window pinned to the screen passes its own view (see pinView): the
    // camera the phone would have if it showed that window at a readable
    // scale, right where the window is pinned.
    const zoom = screen ? screen.zoom : this.viewZoom;
    const scrollX = screen ? screen.scrollX : this.scrollX;
    const scrollY = screen ? screen.scrollY : this.scrollY;
    const s = D / Math.max(1e-3, D - z);
    const ax = W / 2 + ((cx - scrollX) - W / (2 * zoom)) * s * zoom;
    const ay = H / 2 + ((cy - scrollY) - H / (2 * zoom)) * s * zoom;

    const proj = mat4PerspectiveYDown(
      Compositor.CAMERA_FOV, W / H,
      D * NEAR_PLANE_FACTOR, D * FAR_PLANE_FACTOR,
    );
    // Off-axis shift: NDC_x = m0*x/w - proj[8], NDC_y = m5*y/w - proj[9].
    // Solve for the view axis (x_view = y_view = 0) landing on (ax, ay).
    proj[8] = 1 - (2 * ax) / W;
    proj[9] = (2 * ay) / H - 1;
    if (zoom !== 1) {
      proj[0] *= zoom;
      proj[5] *= zoom;
    }

    const view = mat4Translation(-cx, -cy, -D);
    const viewProj = mat4Multiply(proj, view);
    return { viewProj, invViewProj: mat4Invert(viewProj), cameraPos: [cx, cy, D] };
  }

  /**
   * How far a window's CONTENT rect sits inside its slab: the title bar and
   * a thin border on chromed windows. Chromeless and transparent windows
   * have no title bar, so their content is the whole rect.
   */
  private static contentInsets(surface: Surface): { titleBar: number; border: number } {
    return surface.transparent || surface.chromeless
      ? { titleBar: 0, border: 0 }
      : { titleBar: TITLE_BAR_HEIGHT, border: 2 };
  }

  /**
   * The window's CONTENT rect in screen px: inset the title bar + a thin
   * border on chromed windows so occluded 3D and the overlay 2D layer can
   * never paint over the title bar or escape the frame. Chromeless and
   * transparent windows have no title bar, so they clip to the full rect.
   */
  private contentClip(surface: Surface): { x: number; y: number; width: number; height: number } {
    const { titleBar, border } = Compositor.contentInsets(surface);
    return this.zoomViewRect({
      x: surface.rect.x - this.scrollX + border,
      y: surface.rect.y - this.scrollY + titleBar,
      width: Math.max(0, surface.rect.width - border * 2),
      height: Math.max(0, surface.rect.height - titleBar - border),
    });
  }

  /**
   * The WHOLE window rect in screen px (title bar included), for nodes with
   * `clip: 'window'`. Follows the phone's view zoom like contentClip.
   */
  private windowClip(surface: Surface): { x: number; y: number; width: number; height: number } {
    return this.zoomViewRect({
      x: surface.rect.x - this.scrollX,
      y: surface.rect.y - this.scrollY,
      width: surface.rect.width,
      height: surface.rect.height,
    });
  }

  /**
   * A rect in unzoomed viewport px (workspace minus scroll) as the phone's
   * view zoom puts it on screen, clamped to the viewport for the scissor.
   * Identity at zoom 1, so the desktop's clips are exactly what they were.
   */
  private zoomViewRect(r: Rect): Rect {
    const z = this.viewZoom;
    if (z === 1) return r;
    const x0 = Math.max(0, r.x * z);
    const y0 = Math.max(0, r.y * z);
    const x1 = Math.min(this.width, (r.x + r.width) * z);
    const y1 = Math.min(this.height, (r.y + r.height) * z);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  // ── Canvas-layer nodes (kind:'canvas') ────────────────────────────────
  //
  // A canvas node is a 2D drawing layer living IN the scene graph: a
  // width×height px rectangle at its node transform, painted by the standard
  // draw-command vocabulary (params.commands, retained and replaced whole on
  // update), rendered as an unlit alpha-blended quad. Canvas layers
  // interleave with meshes by camera depth (see drawNodeTree), which is what
  // lets 2D and 3D stack arbitrarily: 2D → 3D → 2D → 3D → …

  /**
   * Per canvas-node retained pixels + GPU texture. Entries live exactly as
   * long as their node lives in the SceneStore (NOT as long as they are
   * drawn): incrementally-painted pixels have no client-side command log to
   * rebuild from, so a layer on a hidden workspace must keep its pixels.
   */
  private canvasLayers = new Map<string, {
    surfaceKey: string;
    nodeId: string;
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
    texture?: WebGLTexture;
    rev: number;
    w: number;
    h: number;
    tainted: boolean;
    needsUpload: boolean;
  }>();

  /**
   * Get (repainting when the node's command revision or size changed) the
   * retained layer entry for a canvas node.
   */
  private canvasLayerEntry(key: string, node: VocabNode) {
    const fullKey = `${key}/${node.id}`;
    const { w, h } = Compositor.canvasNodeSize(node);
    let entry = this.canvasLayers.get(fullKey);
    if (!entry || entry.w !== w || entry.h !== h) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      // Preserve pixels across resizes (same policy as window surfaces) so
      // incrementally-drawn content survives a layout change; only a
      // commands revision wipes and repaints.
      if (entry) ctx.drawImage(entry.canvas, 0, 0);
      entry = {
        surfaceKey: key,
        nodeId: node.id,
        canvas, ctx,
        texture: entry?.texture,
        rev: entry?.rev ?? -1,
        w, h,
        tainted: entry?.tainted ?? false,
        needsUpload: true,
      };
      this.canvasLayers.set(fullKey, entry);
    }
    if (entry.rev !== node.canvasRev) {
      // Full repaint. A layer starts transparent each revision — everything
      // left unpainted shows the scene behind it; a 'clear' with a color (or
      // any painted background) opts into opacity.
      this.resetCtxState(entry.ctx, w, h);
      const commands = node.params.commands;
      if (Array.isArray(commands)) {
        for (const raw of commands) {
          const cmd = raw as DrawCommand;
          if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') continue;
          this.resolveCommandColors(cmd);
          if (cmd.type === 'clear') {
            this.resetCtxState(entry.ctx, w, h);
            const p = cmd.params as { color?: string };
            if (p?.color) {
              entry.ctx.fillStyle = p.color;
              entry.ctx.fillRect(0, 0, w, h);
            }
          } else if (cmd.type === 'reset') {
            this.resetCtxState(entry.ctx, w, h);
          } else if (cmd.type !== 'videoFrame') { // videoFrame is surface-only
            this.execShapeCommand(entry.ctx, fullKey, cmd);
          }
        }
      }
      entry.rev = node.canvasRev;
      entry.needsUpload = true;
    }
    return entry;
  }

  /** A canvas node's pixel size: params.rect wins, else width/height. */
  private static canvasNodeSize(node: VocabNode): { w: number; h: number } {
    const rect = node.params.rect as { width?: number; height?: number } | undefined;
    const w = rect?.width ?? (node.params.width as number) ?? 0;
    const h = rect?.height ?? (node.params.height as number) ?? 0;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  /**
   * The quad model matrix for a canvas node. Two placement modes:
   * - params.rect { x, y, width, height }: surface-absolute px from the
   *   window's top-left (how widgets are placed) — used by layout-managed
   *   backdrop layers. transform.position[2] still supplies z.
   * - transform (default): the node's world matrix, centered like a mesh;
   *   the quad is width×height px and transform.scale multiplies.
   */
  private canvasNodeModel(key: string, node: VocabNode, surfaceModel: Mat4): Mat4 | undefined {
    const { w, h } = Compositor.canvasNodeSize(node);
    const rect = node.params.rect as { x: number; y: number; width: number; height: number } | undefined;
    if (rect) {
      const surface = this.surfaces.get(key);
      if (!surface) return undefined; // rect placement needs a window surface
      const ox = rect.x + rect.width / 2 - surface.rect.width / 2;
      const oy = rect.y + rect.height / 2 - surface.rect.height / 2;
      const z = node.transform.position?.[2] ?? 0;
      return mat4Multiply(surfaceModel, mat4TRS(ox, oy, z, 0, 0, 0, w, h, 1));
    }
    const world = this.sceneStore.worldMatrix(node, surfaceModel);
    return mat4Multiply(world, mat4TRS(0, 0, 0, 0, 0, 0, w, h, 1));
  }

  /**
   * Incrementally paint one draw command onto a canvas-layer node
   * (draw-channel commands carrying nodeId). Same vocabulary as surface
   * draws; 'clear'/'reset' wipe to transparent ('clear' then fills when a
   * color is given) — a layer composites over whatever is behind it, so
   * transparent erases are meaningful.
   */
  private drawToLayer(surfaceId: string, nodeId: string, command: DrawCommand): void {
    const node = this.sceneStore.getNode(surfaceId, nodeId);
    if (!node || node.kind !== 'canvas') return;
    const entry = this.canvasLayerEntry(surfaceId, node);
    if (!entry) return;
    this.resolveCommandColors(command);
    if (command.type === 'clear') {
      this.resetCtxState(entry.ctx, entry.w, entry.h);
      const p = command.params as { color?: string };
      if (p?.color) {
        entry.ctx.fillStyle = p.color;
        entry.ctx.fillRect(0, 0, entry.w, entry.h);
      }
    } else if (command.type === 'reset') {
      this.resetCtxState(entry.ctx, entry.w, entry.h);
    } else if (command.type !== 'videoFrame') { // videoFrame is surface-only
      this.execShapeCommand(entry.ctx, `${surfaceId}/${nodeId}`, command);
    }
    entry.needsUpload = true;
    if (this.isSurfaceKeyRenderable(surfaceId)) this.needsRender = true;
  }

  /**
   * Draw a canvas node as an unlit alpha-blended quad (see canvasNodeModel
   * for placement). Clipping rides the pass-wide scissor set by drawNodeTree
   * (passing a per-draw scissor to drawSurface would disable that global
   * scissor).
   */
  private drawCanvasLayerNode(
    key: string,
    node: VocabNode,
    rp: Record<string, unknown>,
    surfaceModel: Mat4,
    cam: SceneCamera,
  ): void {
    const entry = this.canvasLayerEntry(key, node);
    if (!entry) return;
    if (!entry.texture) {
      entry.texture = this.renderer.createTexture();
      entry.needsUpload = true;
    }
    if (entry.needsUpload && !entry.tainted) {
      const ok = this.renderer.uploadTexture(entry.texture, entry.canvas);
      entry.needsUpload = false;
      if (!ok) {
        entry.tainted = true;
        const taintDetail = `canvas layer ${key}/${node.id} tainted by a cross-origin image; freezing its texture`;
        console.warn(`[Compositor] ${taintDetail}`);
        // Same relay as the slab taint: the browser console never crosses the
        // wire, and canvas layers are exactly the content that goes missing on
        // the phone, so a silent taint here is the hardest kind to chase. Its
        // own gate, since sendDiagnostic rate-limits per gate and a chatty
        // surface taint would otherwise mask this one.
        this.onDiagnostic?.('canvas-layer-tainted', taintDetail);
      }
    }
    const model = this.canvasNodeModel(key, node, surfaceModel);
    if (!model) return;
    this.renderer.drawSurface({
      model,
      // The window camera, same as the meshes this layer slices. Drawing the
      // layer through the DESKTOP camera made the two converge on different
      // vanishing points, so a canvas layer at z != 0 drifted away from the
      // meshes it is supposed to interleave with (and from its own hit region)
      // in every window that is not centred on screen.
      viewProj: cam.viewProj,
      texture: entry.texture,
      width: entry.w,
      height: entry.h,
      radius: (rp.radius as number) ?? 0,
      dim: 1,
      opacity: (rp.opacity as number) ?? 1,
    });
  }

  /** Free pixels + GPU textures of canvas layers whose node no longer exists. */
  private pruneCanvasLayers(): void {
    for (const [fullKey, entry] of this.canvasLayers) {
      if (this.sceneStore.getNode(entry.surfaceKey, entry.nodeId)) continue;
      if (entry.texture) this.renderer.deleteTexture(entry.texture);
      this.canvasLayers.delete(fullKey);
    }
  }

  /** Node kinds drawn by drawNodeTree (the rest are lights, groups, environment). */
  private static readonly DRAWABLE_KINDS = new Set<string>(['mesh', 'canvas', 'particles', 'model', 'text', 'label', 'line', 'sky']);

  /**
   * Every drawable node of a subtree with its resolved params, clip mode,
   * layer and root, resolved once per frame (the content, window and
   * pop-out passes all read the same resolution). Cleared in render().
   */
  private frameNodes = new Map<string, Array<{ node: VocabNode; rp: Record<string, unknown>; clip: ClipMode; layer: string; rootId: string }>>();

  private resolvedNodes(key: string): Array<{ node: VocabNode; rp: Record<string, unknown>; clip: ClipMode; layer: string; rootId: string }> {
    let list = this.frameNodes.get(key);
    if (list) return list;
    list = [];
    for (const node of this.sceneStore.nodesForSurface(key)) {
      // A group draws nothing itself, but one carrying its own `trail` leaves
      // a ribbon (the usual way to trail a many-part object as a whole).
      const trailedGroup = node.kind === 'group' && node.params.trail !== undefined && node.params.trail !== false;
      if (!Compositor.DRAWABLE_KINDS.has(node.kind) && !trailedGroup) continue;
      const rp = this.sceneStore.resolveParams(node);
      list.push({
        node, rp,
        clip: clipModeOf(rp),
        layer: (rp.layer as string) ?? 'back',
        rootId: this.sceneStore.rootOf(node).id,
      });
    }
    this.frameNodes.set(key, list);
    return list;
  }

  /**
   * The drawable nodes of one pass: world `layer` (back/front/stack), window
   * clip mode (`content` default, `window`, `none` = pop-out; `occlude:
   * false` means `none`), and optionally one stacked root's subtree.
   */
  private passNodes(key: string, layer: string | undefined, pass: ClipMode | undefined, rootId?: string): Array<{ node: VocabNode; rp: Record<string, unknown> }> {
    return this.resolvedNodes(key).filter((e) =>
      (layer === undefined || e.layer === layer)
      && (pass === undefined || e.clip === pass)
      && (rootId === undefined || e.rootId === rootId));
  }

  /**
   * Draw a retained node tree (a window subtree or a world-scope namespace).
   * `layer` filters world nodes (back/front/stack; `opts.rootId` narrows a
   * stack pass to one stacked root's subtree). `pass` selects a window
   * clip mode (see passNodes): 'content' and 'window' passes are scissored
   * to `clip` (stencilled to `clipQuad` when the window is tilted or rides
   * a node), 'none' draws unclipped. World trees pass no clip mode and draw
   * every node unclipped. `opts.depthOnly` replays the opaque meshes into
   * the depth buffer only (the caller masks colour), and `opts.deferred`
   * draws pop-outs over that depth (see drawDeferredPopouts).
   */
  private drawNodeTree(
    key: string, surfaceModel: Mat4,
    cam: SceneCamera,
    layer?: 'back' | 'front' | 'stack',
    clip?: { x: number; y: number; width: number; height: number },
    pass?: ClipMode,
    clipQuad?: { model: Mat4; viewProj: Mat4 },
    opts?: { rootId?: string; depthOnly?: boolean; deferred?: boolean },
  ): void {
    const nodes = this.sceneStore.nodesForSurface(key);
    if (nodes.length === 0) return;

    // Scene mood (ambient, sky, fog, tone mapping, grading; with its look)
    // from an 'environment' node, if any.
    const env = this.environmentFor(nodes, surfaceModel);

    // Collect lights first (they illuminate every mesh in this subtree). The
    // first shadow-casting directional light and the first shadow-casting
    // spot light each get a shadow map: renderShadowPass reads both from
    // this.shadowPlan, and runs when either exists.
    const lights: MeshLight[] = [];
    this.shadowPlan = {};
    for (const node of nodes) {
      if (node.kind !== 'light' || lights.length >= MAX_MESH_LIGHTS) continue;
      const light = this.buildLight(node, surfaceModel);
      const slot = light.kind === 'directional' ? 'dir' : light.kind === 'spot' ? 'spot' : undefined;
      if (light.castShadow && slot && !this.shadowPlan[slot]) this.shadowPlan[slot] = { index: lights.length, light };
      lights.push(light.light);
    }
    const planned = this.shadowPlan.dir ?? this.shadowPlan.spot;
    const shadowLightIndex = planned ? planned.index : -1;
    const shadowDir: [number, number, number] | undefined = planned?.light.light.dir;
    if (lights.length === 0) {
      // Default key light from the front (directional → dir).
      lights.push(defaultKeyLight());
    }

    // Each drawable node's effective params (inheriting from ancestor groups),
    // resolved once per frame, narrowed to this layer + clip pass (+ root).
    const depthOnly = opts?.depthOnly === true;
    const picked = this.passNodes(key, layer, pass, opts?.rootId);
    let entries = picked.filter((e) => e.node.kind === 'mesh' || Compositor.CONTENT_SOLIDS.has(e.node.kind));
    // Canvas-layer nodes (2D layers living in the scene graph) and particle
    // emitters follow the same layer/pass filters as meshes. A depth-only
    // replay needs neither (they write no depth).
    let canvasEntries = depthOnly ? [] : picked.filter((e) => e.node.kind === 'canvas');
    const particleEntries = depthOnly ? [] : picked.filter((e) => e.node.kind === 'particles');
    // Content kinds (see the content section): a sky first, lines and trails
    // after the solids, labels last. None of them joins a depth-only replay.
    const skyEntries = depthOnly || opts?.deferred ? [] : picked.filter((e) => e.node.kind === 'sky');
    const lineEntries = depthOnly ? [] : picked.filter((e) => e.node.kind === 'line');
    const labelEntries = depthOnly ? [] : picked.filter((e) => e.node.kind === 'label');
    const trailEntries = depthOnly ? [] : picked.filter((e) => e.rp.trail !== undefined && e.rp.trail !== false);
    if (depthOnly) entries = entries.filter(({ rp }) => !this.meshIsTranslucent(rp));

    if (entries.length === 0 && canvasEntries.length === 0 && particleEntries.length === 0
      && skyEntries.length === 0 && lineEntries.length === 0 && labelEntries.length === 0 && trailEntries.length === 0) return;

    // Transparent meshes draw last, back-to-front, so they composite correctly.
    // nodeCameraDepth is -(distance^2) — LARGER means NEARER — so back-to-front
    // is ASCENDING. Sorting the other way drew them nearest-first, which both
    // blends in the wrong order and (since meshes write depth) makes the FARTHER
    // transparent surface fail the depth test and vanish instead of showing through.
    // Translucent: alpha (opacity, textures) or a light-adding material (additive, rim, glass).
    const opaque = entries.filter(({ rp }) => !this.meshIsTranslucent(rp));
    const transparent = entries.filter((e) => !opaque.includes(e));
    transparent.sort((a, b) => this.nodeCameraDepth(a.node, surfaceModel, cam) - this.nodeCameraDepth(b.node, surfaceModel, cam));

    // Opt-in directional shadows: render a depth map from the light's POV,
    // auto-fitting the ortho frustum to the casters' world AABB. Casters are
    // this pass's meshes; skip on the overlay pass (overlay nodes pop out).
    const shadow = shadowLightIndex >= 0 && shadowDir && pass !== 'none' && !depthOnly && entries.length > 0
      ? this.renderShadowPass(key, entries.map((e) => e.node), surfaceModel, shadowDir, shadowLightIndex)
      : undefined;

    // Post effects (environment ao, dof, outline, lightShafts, fxaa,
    // chromaticAberration, grading vignette/grain) draw this pass offscreen
    // and composite it back clipped the same way (see PostEffects). Passes
    // without them take the plain path below untouched.
    const post = !depthOnly && hasPostEffects(env?.post)
      ? this.postFx.begin(clip ?? { x: 0, y: 0, width: this.width, height: this.height })
      : undefined;

    const scissored = clip !== undefined && (pass === 'content' || pass === 'window');
    if (scissored) this.renderer.setScissor(clip);
    // Tilted windows additionally stencil-clip to the PROJECTED content quad
    // (the scissor above is only its conservative bbox, and also bounds the
    // stencil clear).
    const stencilled = scissored && clipQuad !== undefined;
    if (stencilled) this.renderer.beginStencilClip(clipQuad!.model, clipQuad!.viewProj);
    // beginStencilClip re-enables colour writes; a depth-only replay keeps them off.
    if (depthOnly) this.renderer.context.colorMask(false, false, false, false);

    // Deferred pop-outs (drawDeferredPopouts): canvas layers write no depth
    // and cannot be depth-tested, so they stay under the covering windows
    // (the stencil marks their slabs), as pop-outs always did there.
    const gl = this.renderer.context;
    const drawCanvas = (e: { node: VocabNode; rp: Record<string, unknown> }): void => {
      if (opts?.deferred) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }
      this.drawCanvasLayerNode(key, e.node, e.rp, surfaceModel, cam);
      if (opts?.deferred) gl.disable(gl.STENCIL_TEST);
    };

    // Backdrop layers (params.backdrop:true — layout-managed widget canvases
    // and window-glued backgrounds) pin behind ALL meshes regardless of z,
    // like the window's own content plane. Everything else z-slices.
    for (const e of skyEntries) this.drawSkyNode(e.rp, env, cam);

    const backdrops = canvasEntries.filter(({ rp }) => rp.backdrop === true);
    canvasEntries = canvasEntries.filter(({ rp }) => rp.backdrop !== true);
    for (const b of backdrops) drawCanvas(b);

    const meshOrder = [...opaque, ...transparent];
    if (canvasEntries.length === 0) {
      for (const e of meshOrder) this.drawMeshEntry(key, e, surfaceModel, lights, env, shadow, cam);
    } else {
      // Canvas layers are compositing planes: they slice the pass's meshes by
      // camera depth, so 2D and 3D stack freely (2D → 3D → 2D → 3D → …).
      // Back-to-front over the layers; each mesh draws in the slice its
      // origin depth falls in (ties go behind the layer, so a HUD at a
      // mesh's exact z still reads over it). Depth testing still resolves
      // mesh-vs-mesh occlusion across slices.
      canvasEntries.sort((a, b) => this.nodeCameraDepth(a.node, surfaceModel, cam) - this.nodeCameraDepth(b.node, surfaceModel, cam));
      const depths = new Map<VocabNode, number>();
      for (const e of meshOrder) depths.set(e.node, this.nodeCameraDepth(e.node, surfaceModel, cam));
      const drawn = new Set<VocabNode>();
      for (const layerEntry of canvasEntries) {
        const layerDepth = this.nodeCameraDepth(layerEntry.node, surfaceModel, cam);
        for (const e of meshOrder) {
          if (drawn.has(e.node) || depths.get(e.node)! > layerDepth) continue;
          this.drawMeshEntry(key, e, surfaceModel, lights, env, shadow, cam);
          drawn.add(e.node);
        }
        drawCanvas(layerEntry);
      }
      for (const e of meshOrder) {
        if (!drawn.has(e.node)) this.drawMeshEntry(key, e, surfaceModel, lights, env, shadow, cam);
      }
    }

    for (const e of lineEntries) this.drawLineNode(key, e.node, e.rp, surfaceModel, cam);
    for (const e of trailEntries) this.drawNodeTrail(key, e.node, e.rp, surfaceModel, cam);

    // Particles draw last in the pass (glowing light over the solids). As
    // deferred pop-outs they are depth-tested (not written) against the
    // covering slabs, so a stream behind a higher window hides behind it.
    if (opts?.deferred && particleEntries.length > 0) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    for (const p of particleEntries) {
      if (this.drawParticleNode(key, p.node, p.rp, surfaceModel, cam, opts?.deferred === true)) this.needsRender = true;
    }
    if (opts?.deferred && particleEntries.length > 0) {
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
    }

    // Labels are 2D over the pass; as deferred pop-outs they stay under covering windows, like canvas layers.
    for (const e of labelEntries) {
      if (opts?.deferred) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      }
      this.drawLabelNode(key, e.node, e.rp, surfaceModel, cam);
      if (opts?.deferred) gl.disable(gl.STENCIL_TEST);
    }

    if (stencilled) this.renderer.endStencilClip();
    if (scissored) this.renderer.clearScissor();
    if (post) this.endPost(post, env!, lights, cam, scissored ? clip : undefined, opts?.deferred === true);
  }

  /**
   * Simulate and draw one particle emitter (kind 'particles'), in the node's
   * local px space: `rate` particles/s stream continuously, `burst` emits
   * once on add and again whenever `burstKey` changes. Each particle flies
   * along `direction` within a `spread` cone at a `speed` in [min, max],
   * falls with `gravity`, and fades from `color` toward `colorEnd` over its
   * `lifetime` (plus sizeEnd, opacityEnd, spin, drag, turbulence, blend and a
   * `texture` sprite). The GPU evaluates every particle in one instanced
   * draw (see gpu-particles.ts); the CPU path below is the fallback for a
   * GPU that rejects that program. `deferred` pop-outs are depth-tested
   * (never written) against the covering slabs. Returns true while the
   * emitter still has something to draw.
   */
  private drawParticleNode(
    key: string, node: VocabNode, rp: Record<string, unknown>, surfaceModel: Mat4, cam: SceneCamera,
    deferred = false,
  ): boolean {
    const gpu = this.gpuParticles ??= new GpuParticles(this.renderer.context);
    if (!gpu.available) return this.drawParticleNodeCpu(key, node, rp, surfaceModel, cam);
    const id = `${key}/${node.id}`;
    this.touchedParticles.add(id);
    const alive = gpu.update(id, rp, this.sceneStore.worldMatrix(node, surfaceModel), performance.now());
    const color = parseCssColor(resolveSceneColor((rp.color as string) ?? '$accentSecondary', this.sceneTheme));
    const colorEnd = rp.colorEnd ? parseCssColor(resolveSceneColor(rp.colorEnd as string, this.sceneTheme)) : undefined;
    const basis = billboardBasis(cam.invViewProj);
    gpu.draw(id, {
      viewProj: cam.viewProj,
      cameraRight: basis.right,
      cameraUp: basis.up,
      color,
      colorEnd,
      texture: typeof rp.texture === 'string' ? this.resolveTexture(rp.texture) : undefined,
      depthTest: deferred,
    });
    return alive;
  }

  /** The CPU particle emitter (fallback when the GPU particle program cannot build). */
  private drawParticleNodeCpu(
    key: string, node: VocabNode, rp: Record<string, unknown>, surfaceModel: Mat4, cam: SceneCamera,
  ): boolean {
    const id = `${key}/${node.id}`;
    this.touchedParticles.add(id);
    const now = performance.now();
    let st = this.particleStates.get(id);
    if (!st) {
      st = { ps: [], acc: 0, last: now, burstKey: undefined, burstDone: false };
      this.particleStates.set(id, st);
    }
    const dt = Math.min(0.1, Math.max(0, (now - st.last) / 1000));
    st.last = now;

    const lifetime = ((rp.lifetime as number) ?? 1500) / 1000;
    const max = Math.min(1000, (rp.maxParticles as number) ?? 300);
    const [smin, smax] = (rp.speed as [number, number]) ?? [20, 60];
    const [zmin, zmax] = (rp.size as [number, number]) ?? [2, 4];
    const spread = (rp.spread as number) ?? Math.PI / 6;
    const dir = (rp.direction as [number, number, number]) ?? [0, -1, 0];
    const box = (rp.emitterSize as [number, number, number]) ?? [0, 0, 0];
    const gravity = (rp.gravity as number) ?? 0;
    const square = rp.shape === 'square';

    const spawn = (n: number) => {
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const d = [dir[0] / len, dir[1] / len, dir[2] / len];
      // Two axes perpendicular to d for the spread cone.
      const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const a = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
      const al = Math.hypot(a[0], a[1], a[2]) || 1;
      const u = [a[0] / al, a[1] / al, a[2] / al];
      const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
      for (let i = 0; i < n && st!.ps.length < max; i++) {
        const theta = Math.random() * spread;
        const phi = Math.random() * Math.PI * 2;
        const st2 = Math.sin(theta), ct = Math.cos(theta);
        const vx = d[0] * ct + (u[0] * Math.cos(phi) + v[0] * Math.sin(phi)) * st2;
        const vy = d[1] * ct + (u[1] * Math.cos(phi) + v[1] * Math.sin(phi)) * st2;
        const vz = d[2] * ct + (u[2] * Math.cos(phi) + v[2] * Math.sin(phi)) * st2;
        const speed = smin + Math.random() * (smax - smin);
        st!.ps.push({
          x: (Math.random() - 0.5) * box[0], y: (Math.random() - 0.5) * box[1], z: (Math.random() - 0.5) * box[2],
          vx: vx * speed, vy: vy * speed, vz: vz * speed,
          age: 0, size: zmin + Math.random() * (zmax - zmin),
        });
      }
    };

    const burst = (rp.burst as number) ?? 0;
    if (burst > 0 && (!st.burstDone || st.burstKey !== rp.burstKey)) {
      spawn(burst);
      st.burstDone = true;
      st.burstKey = rp.burstKey;
    }
    const rate = (rp.rate as number) ?? 0;
    if (rate > 0) {
      st.acc += rate * dt;
      const n = Math.floor(st.acc);
      st.acc -= n;
      spawn(n);
    }

    const world = this.sceneStore.worldMatrix(node, surfaceModel);
    const c0 = parseCssColor(resolveSceneColor((rp.color as string) ?? '$accentSecondary', this.sceneTheme));
    const c1 = rp.colorEnd ? parseCssColor(resolveSceneColor(rp.colorEnd as string, this.sceneTheme)) : c0;
    const opacity = (rp.opacity as number) ?? 1;
    const alive: typeof st.ps = [];
    for (const p of st.ps) {
      p.age += dt;
      if (p.age >= lifetime) continue;
      p.vy += gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      alive.push(p);
      const k = p.age / lifetime;
      const w = mat4TransformPoint(world, vec3(p.x, p.y, p.z));
      const q = square ? p.size * 2 + 2 : p.size * 6;
      this.renderer.drawGlow({
        model: mat4TRS(w.x, w.y, w.z, 0, 0, square ? p.age * 3 : 0, q, q, 1),
        viewProj: cam.viewProj,
        quadWidth: q, quadHeight: q,
        halfWidth: square ? p.size : 0.5, halfHeight: square ? p.size : 0.5,
        radius: square ? 0 : 0.5,
        color: {
          r: c0.r + (c1.r - c0.r) * k, g: c0.g + (c1.g - c0.g) * k, b: c0.b + (c1.b - c0.b) * k,
          a: (c0.a + (c1.a - c0.a) * k) * opacity,
        },
        a1: 1 - k, sigma1: square ? 0.4 : p.size * 0.9,
      });
    }
    st.ps = alive;
    return alive.length > 0 || rate > 0;
  }

  /** Drop simulation state for emitters that were not drawn this frame. */
  private pruneParticles(): void {
    for (const id of this.particleStates.keys()) {
      if (!this.touchedParticles.has(id)) this.particleStates.delete(id);
    }
    this.gpuParticles?.prune(this.touchedParticles);
    this.touchedParticles.clear();
  }

  /** Draw one resolved mesh entry (shared by the plain and sliced paths). */
  private drawMeshEntry(
    key: string,
    entry: { node: VocabNode; rp: Record<string, unknown> },
    surfaceModel: Mat4,
    lights: MeshLight[],
    env: ResolvedEnvironment | undefined,
    shadow: ShadowSet | undefined,
    cam: SceneCamera,
  ): void {
    if (Compositor.CONTENT_SOLIDS.has(entry.node.kind)) {
      this.drawContentSolid(key, entry, surfaceModel, {
        viewProj: cam.viewProj, lights, ambient: env?.ambient, fog: env?.fog, environment: env?.environment,
        shadow: shadow?.dir, spotShadow: shadow?.spot, cameraPos: cam.cameraPos,
      });
      return;
    }
    {
      const { node, rp } = entry;
      const world = this.sceneStore.worldMatrix(node, surfaceModel);
      // Preset (material: '<name>') under the node's own params, $tokens
      // against the theme, maps to textures (absent until loaded).
      const m = resolveMaterial(rp, this.sceneTheme, this.sceneLibrary);
      const material: MeshMaterialOpts = {
        ...materialDrawOpts(m, (src) => this.resolveTexture(src)),
        model: m.billboard ? this.billboardMatrix(world, cam.cameraPos) : world,
        viewProj: cam.viewProj,
        lights,
        ambient: env?.ambient,
        fog: env?.fog,
        environment: env?.environment,
        shadow: shadow?.dir,
        spotShadow: shadow?.spot,
        cameraPos: cam.cameraPos,
        closed: !hasCustomGeometry(rp) && Compositor.CLOSED_SHAPES.has((rp.primitive as string) ?? 'box'),
      };
      if (material.outline) {
        // Faceted convex primitives expand radially so the hull's corners meet.
        const radial = !hasCustomGeometry(rp) && Compositor.RADIAL_HULL.has((rp.primitive as string) ?? 'box');
        material.outline = { ...material.outline, radial };
      }
      if (Array.isArray(rp.instances) && (rp.instances as unknown[]).length > 0) {
        const handle = this.instancedHandle(key, node);
        if (handle) this.renderer.drawInstanced(handle, material);
      } else if (hasCustomGeometry(rp)) {
        const handle = this.customMeshHandle(key, node);
        if (handle) this.renderer.drawDynamicMesh(handle, material);
      } else {
        this.renderer.drawMesh({
          ...material,
          geometry: getShapeGeometry((rp.primitive as string) ?? 'box', rp.shape),
        });
      }
    }
  }

  /**
   * Get (or rebuild) the instanced-mesh handle for a node carrying
   * params.instances. The base geometry is rebuilt only when its signature
   * changes; the per-instance buffer (matrix + color) is repacked only when
   * the instances array reference changes. Marks the key touched for pruning.
   */
  private instancedHandle(key: string, node: VocabNode): InstancedMesh | undefined {
    const fullKey = `${key}/${node.id}`;
    this.touchedInstanced.add(fullKey);
    const custom = hasCustomGeometry(node.params);
    const baseSig = custom ? `geom:${node.geomRev}` : `prim:${(node.params.primitive as string) ?? 'box'}|${shapeKey(node.params.shape ?? null)}`;
    let entry = this.instancedMeshes.get(fullKey);
    if (!entry || entry.baseSig !== baseSig) {
      if (entry) this.renderer.deleteInstancedMesh(entry.handle);
      let geom: Geometry;
      if (custom) {
        const g = node.params.geometry as CustomGeometryParam;
        geom = customGeometry(g.positions, g.indices, g.normals, g.colors, g.uvs);
      } else {
        geom = getShapeGeometry((node.params.primitive as string) ?? 'box', node.params.shape);
      }
      entry = { baseSig, instRef: undefined, handle: this.renderer.createInstancedMesh(geom) };
      this.instancedMeshes.set(fullKey, entry);
    }
    const instances = node.params.instances as MeshInstance[];
    if (entry.instRef !== instances) {
      // A material preset may supply the colour instances default to.
      const baseParams = withMaterialPreset(node.params, this.sceneLibrary);
      const baseColor = parseCssColor(resolveSceneColor((baseParams.color as string) ?? '#ffffff', this.sceneTheme));
      const data = new Float32Array(instances.length * 19);
      for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const pos = inst.position ?? [0, 0, 0];
        const rot = inst.rotation ?? [0, 0, 0];
        const s = inst.scale ?? 1;
        const sc: [number, number, number] = typeof s === 'number' ? [s, s, s] : s;
        const m = mat4TRS(pos[0], pos[1], pos[2], rot[0], rot[1], rot[2], sc[0], sc[1], sc[2]);
        data.set(m, i * 19);
        const col = inst.color
          ? parseCssColor(resolveSceneColor(inst.color as unknown as string, this.sceneTheme))
          : baseColor;
        data[i * 19 + 16] = col.r; data[i * 19 + 17] = col.g; data[i * 19 + 18] = col.b;
      }
      this.renderer.updateInstances(entry.handle, data, instances.length);
      entry.instRef = instances;
    }
    return entry.handle;
  }

  /** Build a renderer light (point/directional/spot/hemisphere) plus its shadow request from a 'light' node. */
  private buildLight(node: VocabNode, surfaceModel: Mat4): ResolvedLight {
    return resolveLight(node.params, this.sceneTheme, this.sceneStore.worldMatrix(node, surfaceModel));
  }

  /**
   * Resolve a subtree's 'environment' node (merged over its look) into the
   * renderer's environment. Fog near/far are SCENE-relative depth (px behind
   * the content plane), not camera-relative: the camera distance scales with
   * the live viewport, so an author cannot know it. The camera-to-content
   * baseline makes small values work at any viewport size.
   */
  private environmentFor(nodes: VocabNode[], surfaceModel: Mat4): ResolvedEnvironment | undefined {
    const node = nodes.find((n) => n.kind === 'environment');
    if (!node) return undefined;
    const env = resolveEnvironment(node.params, this.sceneTheme, this.sceneLibrary, {
      baseline: this.cameraPos[2],
      worldY: surfaceWorldY(surfaceModel),
    });
    if (env.envMapSrc) env.environment.envMap = this.resolveTexture(env.envMapSrc);
    return env;
  }

  /**
   * Render the shadow maps this subtree's lights asked for (this.shadowPlan:
   * the first shadow-casting directional light and the first spot light).
   * Gathers the casters' world AABB and fits each light's frustum to it (an
   * orthographic box for the directional light, a perspective cone for the
   * spot), so the maps adapt to any scene with no magic constants. Casters
   * are this pass's meshes whose material casts (`castShadow: false` opts a
   * mesh out). Instanced meshes receive shadows but do not cast them (v1).
   * Returns the sampling state for the mesh pass, or undefined.
   */
  private renderShadowPass(
    key: string, meshes: VocabNode[], surfaceModel: Mat4,
    _dir: [number, number, number], _lightIndex: number,
  ): ShadowSet | undefined {
    const plan = this.shadowPlan;
    const casters = meshes.filter((n) => !Array.isArray(n.params.instances)
      && withMaterialPreset(this.sceneStore.resolveParams(n), this.sceneLibrary).castShadow !== false);
    if (casters.length === 0 || (!plan.dir && !plan.spot)) return undefined;

    const min: Vec3Tuple = [Infinity, Infinity, Infinity];
    const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
    const built: Array<{ node: VocabNode; world: Mat4; custom: boolean }> = [];
    for (const node of casters) {
      const world = this.sceneStore.worldMatrix(node, surfaceModel);
      const custom = hasCustomGeometry(node.params);
      const [lo, hi] = custom
        ? this.positionsAABB((node.params.geometry as CustomGeometryParam).positions)
        : Compositor.CONTENT_SOLIDS.has(node.kind) ? this.contentBounds(key, node)
        : [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]] as [number[], number[]];
      for (let i = 0; i < 8; i++) {
        const p = mat4TransformPoint(world, vec3(
          i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]));
        min[0] = Math.min(min[0], p.x); max[0] = Math.max(max[0], p.x);
        min[1] = Math.min(min[1], p.y); max[1] = Math.max(max[1], p.y);
        min[2] = Math.min(min[2], p.z); max[2] = Math.max(max[2], p.z);
      }
      built.push({ node, world, custom });
    }

    const out: ShadowSet = {};
    if (plan.dir) {
      const fit = fitDirectionalShadow(min, max, plan.dir.light.light.dir ?? [0, 0.4, -1]);
      out.dir = this.drawShadowMap(key, built, 'directional', fit, plan.dir);
    }
    if (plan.spot) {
      const l = plan.spot.light.light;
      const fit = fitSpotShadow(min, max, [l.pos[0], l.pos[1], l.pos[2]], l.dir ?? [0, 0.4, -1], plan.spot.light.angle ?? Math.PI / 6);
      if (fit) out.spot = this.drawShadowMap(key, built, 'spot', fit, plan.spot);
    }
    return out.dir || out.spot ? out : undefined;
  }

  /** Shadow-casting lights found by drawNodeTree's light collection, consumed by renderShadowPass. */
  private shadowPlan: { dir?: { index: number; light: ResolvedLight }; spot?: { index: number; light: ResolvedLight } } = {};

  /** Post-effect chain and its pooled targets, created on first use. */
  private postFxInstance?: PostEffects;
  private get postFx(): PostEffects {
    return (this.postFxInstance ??= new PostEffects(this.renderer));
  }

  /** The post-effect quality level the frame-time governor settled on (0 = full). */
  get postQuality(): { level: number; name: string; frameMs: number } {
    return { level: this.postFx.level, name: this.postFx.levelName, frameMs: +this.postFx.frameTime.toFixed(1) };
  }

  /**
   * Run a pass's post effects and composite it back. Light shafts stream
   * from the environment's sun, else the brightest directional light, else
   * the brightest point or spot light.
   */
  private endPost(
    post: PostPass, env: ResolvedEnvironment, lights: MeshLight[], cam: SceneCamera,
    clip: { x: number; y: number; width: number; height: number } | undefined, deferred: boolean,
  ): void {
    let lightDir: [number, number, number] | undefined;
    let lightPos: [number, number, number] | undefined;
    const sun = env.environment.sky?.sun;
    if (sun) {
      lightDir = sun.direction;
    } else {
      let best = -1;
      for (const l of lights) {
        const e = l.color[0] + l.color[1] + l.color[2];
        if (l.pos[3] > 2.5 || e <= best) continue;
        best = e;
        if (l.pos[3] < 0.5) { lightDir = l.dir ? [-l.dir[0], -l.dir[1], -l.dir[2]] : undefined; lightPos = undefined; } else { lightPos = [l.pos[0], l.pos[1], l.pos[2]]; lightDir = undefined; }
      }
    }
    if (lightDir) {
      const n = Math.hypot(lightDir[0], lightDir[1], lightDir[2]) || 1;
      lightDir = [lightDir[0] / n, lightDir[1] / n, lightDir[2] / n];
    }
    this.postFx.end(post, env.post!, {
      viewProj: cam.viewProj, invViewProj: cam.invViewProj, cameraPos: cam.cameraPos,
      baseline: this.cameraPos[2], lightDir, lightPos,
    }, { scissorCss: clip, depthTest: deferred });
  }

  /** Faceted convex primitives whose outline hull expands radially (their split normals would crack). */
  private static readonly RADIAL_HULL = new Set(['box', 'cylinder', 'cone']);

  /** Closed built-in primitives: glows and glass on them draw their near shell only. */
  private static readonly CLOSED_SHAPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'icosphere', 'capsule', 'roundedBox']);

  /**
   * True when a mesh belongs in the transparent, back-to-front pass: it may
   * carry alpha (opacity < 1, a texture) or its material adds light and shows
   * what is behind it (additive blend, rim holograms, glass). Those materials
   * write no depth, so drawn among the opaque meshes anything behind them
   * that draws later covers them.
   */
  private meshIsTranslucent(rp: Record<string, unknown>): boolean {
    return !!rp.texture || resolveMaterial(rp, this.sceneTheme, this.sceneLibrary).translucent;
  }

  /**
   * Draw one shadow map (directional or spot) of the casters and describe it
   * for the mesh pass. Map size follows the light's `shadow.size`, capped at
   * 1024 on phones; the receiver normal offset is 1.5 texels of world size.
   */
  private drawShadowMap(
    key: string, built: Array<{ node: VocabNode; world: Mat4; custom: boolean }>,
    kind: 'directional' | 'spot', fit: ShadowFit, planned: { index: number; light: ResolvedLight },
  ): ShadowOpts | undefined {
    const size = Math.min(planned.light.shadow.size, this.mobileMode ? 1024 : 4096);
    this.renderer.beginShadowPass(fit.lightVP, kind, size);
    for (const item of built) {
      if (Compositor.CONTENT_SOLIDS.has(item.node.kind)) {
        this.drawContentDepth(key, item.node, item.world);
      } else if (item.custom) {
        const handle = this.customMeshHandle(key, item.node);
        if (handle) this.renderer.drawDepthDynamic(handle, item.world);
      } else {
        this.renderer.drawDepthGeometry(getShapeGeometry((item.node.params.primitive as string) ?? 'box', item.node.params.shape), item.world);
      }
    }
    this.renderer.endShadowPass();
    const map = kind === 'spot' ? this.renderer.spotShadowMap : this.renderer.shadowMap;
    const res = this.renderer.shadowSize;
    return map ? {
      map, lightVP: fit.lightVP, lightIndex: planned.index, size: res,
      softness: planned.light.shadow.softness, bias: planned.light.shadow.bias,
      normalOffset: (1.5 * fit.texelWorld) / res,
    } : undefined;
  }

  /** Local-space AABB [min,max] of a flat positions array. */
  private positionsAABB(positions: number[]): [number[], number[]] {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    if (!isFinite(lo[0])) { lo = [-0.5, -0.5, -0.5]; hi = [0.5, 0.5, 0.5]; }
    return [lo, hi];
  }

  /** Camera-space depth (for transparency sorting): larger = nearer. */
  private nodeCameraDepth(node: VocabNode, surfaceModel: Mat4, cam: SceneCamera): number {
    const m = this.sceneStore.worldMatrix(node, surfaceModel);
    const dx = m[12] - cam.cameraPos[0], dy = m[13] - cam.cameraPos[1], dz = m[14] - cam.cameraPos[2];
    return -(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Replace a node's rotation with a camera-facing basis while keeping its
   * world position and scale (extracted from the basis-vector lengths).
   * Billboards keep sprites/labels readable from any camera angle.
   */
  private billboardMatrix(world: Mat4, cameraPos: [number, number, number]): Mat4 {
    const px = world[12], py = world[13], pz = world[14];
    const sx = Math.hypot(world[0], world[1], world[2]) || 1;
    const sy = Math.hypot(world[4], world[5], world[6]) || 1;
    const sz = Math.hypot(world[8], world[9], world[10]) || 1;
    let fx = cameraPos[0] - px, fy = cameraPos[1] - py, fz = cameraPos[2] - pz;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;       // forward (toward camera)
    // right = up × forward, with world up (0,1,0)
    let rx = 1 * fz - 0 * fy, ry = 0 * fx - 0 * fz, rz = 0 * fy - 1 * fx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;  // up = forward × right
    const m = new Float32Array(16);
    m[0] = rx * sx; m[1] = ry * sx; m[2] = rz * sx; m[3] = 0;
    m[4] = ux * sy; m[5] = uy * sy; m[6] = uz * sy; m[7] = 0;
    m[8] = fx * sz; m[9] = fy * sz; m[10] = fz * sz; m[11] = 0;
    m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
    return m;
  }

  /**
   * Resolve a mesh material's `texture` param to a GL texture. Accepts a
   * 'surface:<surfaceId>' reference (reuse a window's live content texture)
   * or a URL / data-URI (loaded once, async, then cached). Returns undefined
   * until an image finishes loading; the load triggers a re-render.
   */
  private resolveTexture(src: string | undefined): WebGLTexture | undefined {
    if (!src) return undefined;
    if (src.startsWith('surface:')) {
      return this.surfaceGl.get(src.slice('surface:'.length))?.texture;
    }
    const hit = this.meshTextures.get(src);
    if (hit) return hit.loaded ? hit.tex : undefined;
    const tex = this.renderer.createTexture();
    this.meshTextures.set(src, { tex, loaded: false });
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Mipmapped (trilinear + anisotropic via the mesh samplers), so maps
      // stay clean when a textured surface recedes or tilts away.
      this.renderer.uploadImageTexture(tex, img);
      const e = this.meshTextures.get(src);
      if (e) e.loaded = true;
      this.needsRender = true;
    };
    img.src = src;
    // Until it loads the mesh draws without this map (not black).
    return undefined;
  }

  // ── Camera nodes, orbit, and node constraints ───────────────────────

  /** Mouse button index for a camera node's orbit button. */
  private static readonly ORBIT_BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2 };
  /** Window-edge band (px) left to the resize handles when a camera captures the pointer. */
  private static readonly CAMERA_EDGE_BAND = 10;

  /** Track camera nodes and constrained nodes as ops land (see applyOps). */
  private syncMotionNode(surfaceKey: string, op: SceneOp): void {
    const fullKey = `${surfaceKey}/${op.id}`;
    if (op.op === 'remove') {
      this.constrainedNodes.delete(fullKey);
      this.orbitCams.delete(fullKey);
      if (this.cameraNodeIds.get(surfaceKey) === op.id) this.cameraNodeIds.delete(surfaceKey);
      return;
    }
    const node = this.sceneStore.getNode(surfaceKey, op.id);
    if (!node) return;
    // Cameras belong to windows; a world-scope camera node has no effect.
    if (node.kind === 'camera' && !surfaceKey.startsWith('world:')) this.cameraNodeIds.set(surfaceKey, node.id);
    if (node.params.lookAt != null || node.params.follow != null) {
      if (!this.constrainedNodes.has(fullKey)) this.constrainedNodes.set(fullKey, { surfaceKey, id: node.id });
    } else {
      this.constrainedNodes.delete(fullKey);
    }
  }

  /** A window subtree's camera node, if it has one (stale ids from silent cascades fall back to a rescan). */
  private cameraNodeOf(surfaceId: string): VocabNode | undefined {
    const id = this.cameraNodeIds.get(surfaceId);
    if (id === undefined) return undefined;
    const node = this.sceneStore.getNode(surfaceId, id);
    if (node?.kind === 'camera') return node;
    this.cameraNodeIds.delete(surfaceId);
    const other = this.sceneStore.nodesForSurface(surfaceId).find((n) => n.kind === 'camera');
    if (other) this.cameraNodeIds.set(surfaceId, other.id);
    return other;
  }

  /**
   * The camera a window's 3D subtree renders and picks through when the
   * subtree holds a `camera` node; undefined keeps `defaultCam` (the window
   * camera), so a window without one is exactly as before. The node camera
   * keeps the default camera's intrinsics (its field of view unless the node
   * sets `fov`, and any view zoom the desktop camera carries) and replaces
   * only the pose: the eye at the node's transform.position (default: the
   * default camera's own eye) looking at params.target (default the origin of
   * the node's parent space), with the target projected exactly where the
   * default camera shows it, so the scene stays glued to its window and
   * inside its clip. `frame` is the window's frame matrix; when it carries a
   * scale (an open / close transition, a card), the eye rides the scaled
   * frame and the focal length follows the scale, so the view shrinks with
   * the slab exactly as the default camera's does.
   */
  private cameraFor(surface: Surface, defaultCam: SceneCamera, frame: Mat4): SceneCamera | undefined {
    const node = this.cameraNodeOf(surface.id);
    if (!node) return undefined;
    const W = Math.max(1, this.width);
    const H = Math.max(1, this.height);
    const parent = this.sceneStore.parentMatrix(node, frame);
    const pose = this.cameraPose(node, this.sceneStore.parentMatrix(node, mat4StripScale(frame)), defaultCam);
    const frameScale = Math.sqrt(Math.hypot(frame[0], frame[1], frame[2]) * Math.hypot(frame[4], frame[5], frame[6])) || 1;
    const eye = mat4TransformPoint(parent, vec3(pose.eye[0], pose.eye[1], pose.eye[2]));
    const target = mat4TransformPoint(parent, vec3(pose.target[0], pose.target[1], pose.target[2]));
    // Screen-up follows the window, so a tilted window's camera stays upright to it.
    const up = mat4TransformDir(parent, vec3(0, -1, 0));
    // The default camera's projection (its view is a pure translation to its
    // eye), whose focal length carries any view zoom.
    const e = defaultCam.cameraPos;
    const proj = mat4Multiply(defaultCam.viewProj, mat4Translation(e[0], e[1], e[2]));
    const zoom = (Math.abs(proj[5]) * Math.tan(Compositor.CAMERA_FOV / 2) || 1) * frameScale;
    const anchor = projectToScreen(defaultCam.viewProj, target, W, H);
    const fov = typeof node.params.fov === 'number' && node.params.fov > 0
      ? (node.params.fov * Math.PI) / 180 : Compositor.CAMERA_FOV;
    const cam = buildNodeCamera({
      eye: [eye.x, eye.y, eye.z],
      target: [target.x, target.y, target.z],
      up: [up.x, up.y, up.z],
      fovY: fov,
      screenW: W,
      screenH: H,
      anchorX: anchor ? anchor.x : W / 2,
      anchorY: anchor ? anchor.y : H / 2,
      zoom,
    });
    return { viewProj: cam.viewProj, invViewProj: cam.invViewProj, cameraPos: cam.cameraPos };
  }

  /**
   * A camera node's eye and target in its parent space. The eye defaults to
   * the default camera's, placed through `parent` (the node's parent matrix
   * under the window's scale-free frame).
   */
  private cameraPose(node: VocabNode, parent: Mat4, defaultCam: SceneCamera): { eye: [number, number, number]; target: [number, number, number] } {
    const t = node.params.target;
    const target: [number, number, number] = Array.isArray(t) && t.length === 3 && t.every((v) => typeof v === 'number')
      ? [t[0] as number, t[1] as number, t[2] as number] : [0, 0, 0];
    const pos = node.transform.position;
    if (pos) return { eye: [pos[0], pos[1], pos[2]], target };
    const c = defaultCam.cameraPos;
    const local = mat4TransformPoint(mat4Invert(parent), vec3(c[0], c[1], c[2]));
    return { eye: [local.x, local.y, local.z], target };
  }

  /** A camera node's orbit options, or undefined when it does not orbit. */
  private static orbitSpecOf(orbit: unknown): { button: string; minDistance?: number; maxDistance?: number; minPitch?: number; maxPitch?: number; damping?: number } | undefined {
    if (orbit === true) return { button: 'left' };
    if (!orbit || typeof orbit !== 'object' || Array.isArray(orbit)) return undefined;
    const o = orbit as Record<string, unknown>;
    const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] as number : undefined);
    return {
      button: typeof o.button === 'string' && o.button in Compositor.ORBIT_BUTTONS ? o.button : 'left',
      minDistance: num('minDistance'), maxDistance: num('maxDistance'),
      minPitch: num('minPitch'), maxPitch: num('maxPitch'), damping: num('damping'),
    };
  }

  /** Where a camera captures the pointer, window-local px: params.viewport or the content area clear of the resize bands. */
  private cameraViewport(surface: Surface, node: VocabNode): { x: number; y: number; width: number; height: number } {
    const v = node.params.viewport as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
    if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.width === 'number' && typeof v.height === 'number') {
      return { x: v.x, y: v.y, width: v.width, height: v.height };
    }
    const band = Compositor.CAMERA_EDGE_BAND;
    const top = surface.transparent || surface.chromeless ? band : TITLE_BAR_HEIGHT;
    const { width, height } = surface.rect;
    return { x: band, y: top, width: Math.max(0, width - band * 2), height: Math.max(0, height - top - band) };
  }

  /** The camera node whose capture viewport holds a viewport point. */
  private cameraAt(x: number, y: number): { surface: Surface; node: VocabNode } | undefined {
    // (The phone picks through the same zoomed desktop camera, so it orbits too.)
    if (this.cameraNodeIds.size === 0) return undefined;
    const hit = this.surfaceLocalAt(x, y);
    if (!hit) return undefined;
    const node = this.cameraNodeOf(hit.surface.id);
    if (!node) return undefined;
    const vp = this.cameraViewport(hit.surface, node);
    if (hit.x < vp.x || hit.y < vp.y || hit.x > vp.x + vp.width || hit.y > vp.y + vp.height) return undefined;
    return { surface: hit.surface, node };
  }

  /** Whether a press with `button` here would orbit a camera (the client then keeps the context menu away). */
  cameraOrbitsAt(x: number, y: number, button: number): boolean {
    const at = this.cameraAt(x, y);
    const spec = at ? Compositor.orbitSpecOf(at.node.params.orbit) : undefined;
    return !!spec && Compositor.ORBIT_BUTTONS[spec.button] === button;
  }

  /** True while a held pointer orbits a camera. */
  get isOrbitingCamera(): boolean {
    return this.orbitGrab !== undefined;
  }

  /**
   * A press at a viewport point: when it lands in the capture viewport of a
   * window's camera node that orbits with this button, the camera takes the
   * drag (the window never sees the press). Returns whether it did.
   */
  beginCameraOrbit(x: number, y: number, button: number, time?: number): boolean {
    if (this.orbitGrab) this.endCameraOrbit(time);
    const at = this.cameraAt(x, y);
    const spec = at ? Compositor.orbitSpecOf(at.node.params.orbit) : undefined;
    if (!at || !spec || Compositor.ORBIT_BUTTONS[spec.button] !== button) return false;
    const oc = this.orbitCamFor(at.surface, at.node);
    oc.ctl.pointerDown(x, y, time ?? performance.now());
    oc.active = false;
    this.orbitGrab = `${at.surface.id}/${at.node.id}`;
    this.emitCamera(oc, 'start');
    return true;
  }

  /** Follow the held pointer: the eye turns around the target. */
  updateCameraOrbit(x: number, y: number, time?: number): void {
    const oc = this.orbitGrab ? this.orbitCams.get(this.orbitGrab) : undefined;
    if (!oc) return;
    if (oc.ctl.pointerMove(x, y, time ?? performance.now()) && this.writeCameraPose(oc)) this.emitCamera(oc, 'move');
  }

  /** Release the orbit: the view coasts on a flick (render loop), then reports 'end'. */
  endCameraOrbit(time?: number): void {
    const oc = this.orbitGrab ? this.orbitCams.get(this.orbitGrab) : undefined;
    this.orbitGrab = undefined;
    if (!oc) return;
    oc.ctl.pointerUp(time ?? performance.now());
    oc.lastT = performance.now();
    if (oc.ctl.moving) {
      oc.active = true;
      this.needsRender = true;
    } else {
      this.emitCamera(oc, 'end');
    }
  }

  /**
   * A wheel at a viewport point: dolly the camera whose capture viewport
   * holds it when its node has zoom: true. Returns whether the wheel was used.
   */
  cameraWheel(x: number, y: number, deltaY: number): boolean {
    const at = this.cameraAt(x, y);
    if (!at || at.node.params.zoom !== true) return false;
    const oc = this.orbitCamFor(at.surface, at.node);
    if (!oc.active && !oc.ctl.isDragging) {
      oc.lastT = performance.now();
      this.emitCamera(oc, 'start');
    }
    oc.ctl.wheel(deltaY);
    oc.active = true;
    this.needsRender = true;
    return true;
  }

  /** The orbit state for a camera node, created or re-synced with the node's current pose. */
  private orbitCamFor(surface: Surface, node: VocabNode): OrbitCam {
    const key = `${surface.id}/${node.id}`;
    const v = this.windowView(surface);
    const pose = this.cameraPose(node, this.sceneStore.parentMatrix(node, mat4StripScale(v.frame)), v.cam);
    const spec = Compositor.orbitSpecOf(node.params.orbit) ?? { button: 'left' };
    const sig = JSON.stringify(spec);
    let oc = this.orbitCams.get(key);
    if (!oc || oc.sig !== sig) {
      oc = {
        surfaceId: surface.id, nodeId: node.id, sig,
        ctl: new OrbitController(pose.eye, pose.target, {
          minDistance: spec.minDistance, maxDistance: spec.maxDistance,
          minPitch: spec.minPitch, maxPitch: spec.maxPitch, damping: spec.damping,
        }),
        eye: pose.eye, target: pose.target, lastT: performance.now(), active: false,
      };
      this.orbitCams.set(key, oc);
    } else if (!Compositor.sameVec(pose.eye, oc.eye) || !Compositor.sameVec(pose.target, oc.target)) {
      // The owner moved the camera since we last wrote it: start from there.
      oc.ctl.setView(pose.eye, pose.target);
      oc.eye = pose.eye;
      oc.target = pose.target;
    }
    return oc;
  }

  private static sameVec(a: readonly number[], b: readonly number[]): boolean {
    return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;
  }

  /** Write the controller's pose into the camera node (the retained copy renders and picks from it). */
  private writeCameraPose(oc: OrbitCam): boolean {
    const node = this.sceneStore.getNode(oc.surfaceId, oc.nodeId);
    if (!node) return false;
    const eye = oc.ctl.eye;
    const target: [number, number, number] = [oc.ctl.target[0], oc.ctl.target[1], oc.ctl.target[2]];
    node.transform = { ...node.transform, position: eye };
    node.params = { ...node.params, target };
    oc.eye = eye;
    oc.target = target;
    if (this.isSurfaceKeyRenderable(oc.surfaceId)) this.needsRender = true;
    return true;
  }

  private emitCamera(oc: OrbitCam, phase: CameraChangeEvent['phase']): void {
    try {
      this.onCameraChange?.({
        phase, surfaceId: oc.surfaceId, nodeId: oc.nodeId,
        position: [oc.eye[0], oc.eye[1], oc.eye[2]],
        target: [oc.target[0], oc.target[1], oc.target[2]],
      });
    } catch (err) {
      console.error('[Compositor] onCameraChange listener failed:', err);
    }
  }

  /** Coast released orbits and ease wheel dollies. Returns true while any camera still moves. */
  private stepCameras(now: number): boolean {
    if (this.orbitCams.size === 0) return false;
    let moving = false;
    for (const [key, oc] of this.orbitCams) {
      if (!oc.active || oc.ctl.isDragging) continue;
      const node = this.sceneStore.getNode(oc.surfaceId, oc.nodeId);
      if (!node || node.kind !== 'camera') { this.orbitCams.delete(key); continue; }
      const pos = node.transform.position;
      const tg = node.params.target as number[] | undefined;
      if ((pos && !Compositor.sameVec(pos, oc.eye)) || (Array.isArray(tg) && !Compositor.sameVec(tg, oc.target))) {
        // The owner moved it mid-coast: its word wins, the coast stops.
        oc.active = false;
        continue;
      }
      const still = oc.ctl.update(now - oc.lastT);
      oc.lastT = now;
      this.writeCameraPose(oc);
      if (still) {
        moving = true;
        this.emitCamera(oc, 'move');
      } else {
        oc.active = false;
        this.emitCamera(oc, 'end');
      }
    }
    return moving;
  }

  /**
   * Evaluate node constraints: `follow` eases a node toward another node's
   * position (plus offset) and `lookAt` turns it so its local +z faces a
   * point or node. Runs after animations and drags, so constraints see this
   * frame's positions. Returns true while a follower is still closing in
   * (a lookAt only changes when something it watches moves, which renders
   * anyway).
   */
  private stepConstraints(now: number): boolean {
    if (this.constrainedNodes.size === 0) return false;
    let moving = false;
    for (const [key, c] of this.constrainedNodes) {
      const node = this.sceneStore.getNode(c.surfaceKey, c.id);
      if (!node || (node.params.lookAt == null && node.params.follow == null)) {
        this.constrainedNodes.delete(key);
        continue;
      }
      const dt = c.lastT === undefined ? 0 : Math.min(0.25, Math.max(0, (now - c.lastT) / 1000));
      c.lastT = now;
      if (!this.isSurfaceKeyRenderable(c.surfaceKey)) continue;
      const f = node.params.follow as { node?: unknown; offset?: unknown; stiffness?: unknown } | null | undefined;
      // The hand wins over a follower being dragged.
      const held = this.nodeDrag !== undefined && this.nodeDrag.key === c.surfaceKey && this.nodeDrag.nodeId === node.id;
      if (f && typeof f.node === 'string' && !held) {
        const goal = this.pointInParentOf(node, f.node);
        if (goal) {
          const off = Array.isArray(f.offset) ? f.offset as number[] : [0, 0, 0];
          const g = [goal[0] + (off[0] ?? 0), goal[1] + (off[1] ?? 0), goal[2] + (off[2] ?? 0)];
          const cur = node.transform.position ?? [0, 0, 0];
          if (Math.hypot(g[0] - cur[0], g[1] - cur[1], g[2] - cur[2]) > 0.01) {
            let next = followStep(cur, g, typeof f.stiffness === 'number' ? f.stiffness : 0.15, dt);
            if (Math.hypot(g[0] - next[0], g[1] - next[1], g[2] - next[2]) <= 0.01) next = g;
            else moving = true;
            node.transform = { ...node.transform, position: [next[0], next[1], next[2]] };
          }
        }
      }
      const la = node.params.lookAt as unknown;
      const to = Array.isArray(la) && la.length === 3
        ? la as number[]
        : la && typeof la === 'object' && typeof (la as { node?: unknown }).node === 'string'
          ? this.pointInParentOf(node, (la as { node: string }).node) : undefined;
      if (to) {
        const r = lookAtEuler(node.transform.position ?? [0, 0, 0], to);
        const cur = node.transform.rotation;
        if (!cur || !Compositor.sameVec(cur, r)) node.transform = { ...node.transform, rotation: r };
      }
    }
    return moving;
  }

  /** Another node's origin in `node`'s parent space (same subtree), or undefined when it is gone. */
  private pointInParentOf(node: VocabNode, otherId: string): number[] | undefined {
    const other = this.sceneStore.getNode(node.surfaceId, otherId);
    if (!other || other === node) return undefined;
    const identity = mat4Identity();
    const w = this.sceneStore.worldMatrix(other, identity);
    const p = mat4TransformPoint(mat4Invert(this.sceneStore.parentMatrix(node, identity)), vec3(w[12], w[13], w[14]));
    return [p.x, p.y, p.z];
  }

  // ── Content kinds: models, 3D text, labels, lines, trails, sky ────────
  //
  // `model` and `text` are solids: drawMeshEntry hands them to
  // drawContentSolid, so presets, maps, lights, shadows, canvas-layer
  // slicing and transparency sorting treat them exactly like meshes. Lines
  // and trails draw after a pass's meshes (they test depth and, except
  // opaque mitred lines, write none), labels last (crisp 2D over the 3D),
  // and a sky first, behind everything else in its subtree. Models are
  // shared by source between every node naming them and freed when no node
  // does; per-node GPU state (labels, lines, trails) is freed when its node
  // stops drawing. Everything rebuilds after a lost context.

  private static readonly CONTENT_SOLIDS = new Set(['model', 'text']);
  /** Beyond this many triangles a model picks by its bounds instead of its triangles. */
  private static readonly MODEL_PICK_TRIANGLES = 20000;
  private static readonly ABX_PREFIX = 'abx:sha256:';

  private lineRendererInst?: LineRenderer;
  private skyRendererInst?: SkyRenderer;
  private get lineRenderer(): LineRenderer { return this.lineRendererInst ??= new LineRenderer(this.renderer); }
  private get skyRenderer(): SkyRenderer { return this.skyRendererInst ??= new SkyRenderer(this.renderer); }

  /** Parsed models and their GPU buffers, keyed by `src` (URL, data-URI or abx ref). */
  private models = new Map<string, ModelEntry>();
  /** Per model node: which clip plays and its clock. */
  private modelClocks = new Map<string, { clip: number; start: number; pausedAt?: number; speed: number }>();
  /** Per model node: its pose this frame (shared by the shadow pass, the draw and picking). */
  private modelPoses = new Map<string, { items: GltfDrawItem[]; fit: Mat4; src: string; frame: number; moving: boolean }>();
  /** Frame counter for per-frame content caches. */
  private contentFrame = 0;
  /** Per label node: its rendered texture and the quad it was last drawn as. */
  private labelTextures = new Map<string, { key: string; tex: WebGLTexture; w: number; h: number; model?: Mat4 }>();
  /** Per line node: GPU handle plus the param references it was built from. */
  private lineHandles = new Map<string, { handle: LineHandle; points: unknown; colors: unknown; widths: unknown; closed: unknown; theme?: SceneTheme }>();
  /** Per trailed node: recent world positions. */
  private trails = new Map<string, Trail>();
  /** Node keys whose label, line or trail drew this frame (drives pruning). */
  private touchedContent = new Set<string>();
  /** Fonts being fetched for 3D text (retraced once loaded). */
  private pendingTextFonts = new Set<string>();
  private lastModelSweep = 0;
  /** Resolves an `abx:sha256:` hash to a fetchable URL, or undefined when the bytes are not here yet. */
  private blobResolver?: (hash: string) => string | undefined;

  /**
   * Where model bytes delivered by the UIServer live (the client's blob
   * cache). A model whose blob is missing waits; call blobArrived when it lands.
   */
  setBlobResolver(resolve: (hash: string) => string | undefined): void {
    this.blobResolver = resolve;
  }

  /** A content blob arrived: retry the models that were waiting for it. */
  blobArrived(hash: string): void {
    const src = Compositor.ABX_PREFIX + hash;
    const e = this.models.get(src);
    if (e && e.state === 'waiting') {
      e.state = 'loading';
      void this.loadModel(e);
    }
  }

  /** Why a model node is not showing (for diagnostics), or undefined when it is fine. */
  modelStatus(src: string): { state: string; error?: string } | undefined {
    const e = this.models.get(src);
    return e ? { state: e.state, error: e.error } : undefined;
  }

  private modelEntry(src: string): ModelEntry {
    let e = this.models.get(src);
    if (!e) {
      e = { src, state: 'loading', meshes: new Map(), textures: new Map(), bitmaps: new Map(), generation: 0 };
      this.models.set(src, e);
      void this.loadModel(e);
    }
    return e;
  }

  /** Fetch, parse, and decode a model's images. GPU buffers are built on first draw. */
  private async loadModel(e: ModelEntry): Promise<void> {
    try {
      let bytes: Uint8Array;
      let base: string | undefined;
      if (e.src.startsWith(Compositor.ABX_PREFIX)) {
        const url = this.blobResolver?.(e.src.slice(Compositor.ABX_PREFIX.length));
        if (!url) { e.state = 'waiting'; return; }
        bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      } else if (e.src.startsWith('data:')) {
        const d = decodeDataUri(e.src);
        if (!d) throw new Error('the data-URI is malformed');
        bytes = d.bytes;
      } else {
        const res = await fetch(e.src);
        if (!res.ok) throw new Error(`HTTP ${res.status} loading ${e.src}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        base = res.url || e.src;
      }
      const fetchRelative = base
        ? async (uri: string) => {
          const r = await fetch(new URL(uri, base).href);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        }
        : undefined;
      const doc = await parseGltf(bytes, { fetch: fetchRelative });
      for (let i = 0; i < doc.images.length; i++) {
        const im = doc.images[i];
        if (!im.bytes || typeof createImageBitmap !== 'function') continue;
        try {
          const bmp = await createImageBitmap(new Blob([im.bytes as BlobPart], { type: im.mime }), {
            premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none',
          });
          e.bitmaps.set(i, bmp);
        } catch (err) {
          console.warn(`[scene] model ${e.src.slice(0, 60)}: image ${i} could not be decoded (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const items = flattenScene(doc);
      const b = drawItemsBounds(items);
      e.doc = doc;
      e.rest = { items, min: b.min, max: b.max };
      e.state = 'ready';
      for (const w of doc.warnings) console.info(`[scene] model ${e.src.slice(0, 60)}: ${w}`);
    } catch (err) {
      e.state = 'error';
      e.error = err instanceof Error ? err.message : String(err);
      console.warn(`[scene] model ${e.src.slice(0, 80)} failed: ${e.error}`);
    }
    this.needsRender = true;
  }

  /** Build (or rebuild after a context loss) a ready model's GPU buffers and textures. */
  private ensureModelGpu(e: ModelEntry): void {
    const gen = contextGeneration(this.renderer.context);
    if (e.generation === gen) return;
    // Old handles died with the old context; forget them without deleting.
    e.meshes.clear();
    e.textures.clear();
    for (const mesh of e.doc!.meshes) {
      for (const prim of mesh.primitives) {
        const handle = this.renderer.createDynamicMesh();
        this.renderer.updateDynamicMesh(handle, primitiveGeometry(prim));
        e.meshes.set(prim, handle);
      }
    }
    for (const [i, bmp] of e.bitmaps) {
      const tex = this.renderer.createTexture();
      this.renderer.uploadImageTexture(tex, bmp);
      e.textures.set(i, tex);
    }
    e.generation = gen;
  }

  private freeModel(e: ModelEntry): void {
    if (e.generation === contextGeneration(this.renderer.context)) {
      for (const h of e.meshes.values()) this.renderer.deleteDynamicMesh(h);
      for (const t of e.textures.values()) this.renderer.deleteTexture(t);
    }
    for (const bmp of e.bitmaps.values()) bmp.close?.();
    e.meshes.clear();
    e.textures.clear();
    e.bitmaps.clear();
  }

  /** `fit`: scale a model so its largest side is `fit` px, centred on the node. */
  private modelFitMatrix(e: ModelEntry, fit: unknown): Mat4 {
    if (typeof fit !== 'number' || !(fit > 0) || !e.rest) return mat4Identity();
    const { min, max } = e.rest;
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const k = fit / size;
    return mat4Multiply(
      mat4TRS(0, 0, 0, 0, 0, 0, k, k, k),
      mat4Translation(-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2),
    );
  }

  /** The pose a model node shows now (and whether its animation still moves). */
  private modelPose(fullKey: string, e: ModelEntry, rp: Record<string, unknown>): { items: GltfDrawItem[]; moving: boolean } {
    const doc = e.doc!;
    const clip = findAnimation(doc, rp.animation as string | number | undefined);
    if (clip < 0) {
      this.modelClocks.delete(fullKey);
      return { items: e.rest!.items, moving: false };
    }
    const now = performance.now();
    const speed = typeof rp.speed === 'number' ? rp.speed : 1;
    const playing = rp.playing !== false;
    let clock = this.modelClocks.get(fullKey);
    if (!clock || clock.clip !== clip) {
      clock = { clip, start: now, speed };
      this.modelClocks.set(fullKey, clock);
    }
    if (clock.speed !== speed) {
      // Keep the current time when the rate changes.
      const t = ((clock.pausedAt ?? now) - clock.start) * clock.speed;
      clock.start = (clock.pausedAt ?? now) - (speed !== 0 ? t / speed : 0);
      clock.speed = speed;
    }
    if (!playing && clock.pausedAt === undefined) clock.pausedAt = now;
    if (playing && clock.pausedAt !== undefined) {
      clock.start += now - clock.pausedAt;
      clock.pausedAt = undefined;
    }
    const anim = doc.animations[clip];
    const loop = rp.loop !== false;
    const elapsed = (((clock.pausedAt ?? now) - clock.start) / 1000) * speed;
    const t = animationTime(anim, elapsed, loop);
    const moving = playing && speed !== 0 && (loop || (elapsed >= 0 && elapsed < anim.duration));
    return { items: flattenScene(doc, { pose: sampleAnimation(anim, t) }), moving };
  }

  /**
   * One model primitive's material: the glTF material (linear factors
   * encoded to the sRGB the renderer expects, its maps and texture
   * transform), with the node's params as overrides: a `material` preset
   * replaces it (keeping the normal and occlusion maps), `color` tints,
   * `opacity` multiplies, and `shading`, metalness, roughness and emissive
   * replace their glTF values.
   */
  private modelMaterial(e: ModelEntry, item: GltfDrawItem, rp: Record<string, unknown>): Omit<MeshMaterialOpts, 'model' | 'viewProj' | 'cameraPos'> {
    const r = resolveMaterial(rp, this.sceneTheme, this.sceneLibrary);
    const base = materialDrawOpts(r, (src) => this.resolveTexture(src));
    const gm = item.materialIndex >= 0 ? e.doc!.materials[item.materialIndex] : undefined;
    const tex = (ref: { image: number } | undefined) => (ref && ref.image >= 0 ? e.textures.get(ref.image) : undefined);
    const preset = typeof rp.material === 'string' && !!this.sceneLibrary.materials[rp.material as string];
    if (!gm) return base;
    const maps = { ...(base.maps ?? {}) };
    maps.normal ??= tex(gm.normalTexture);
    maps.ao ??= tex(gm.occlusionTexture);
    if (preset) return { ...base, maps, normalScale: base.normalScale ?? gm.normalTexture?.scale };
    const bc = gm.baseColorFactor;
    const tint = rp.color !== undefined ? r.color : { r: 1, g: 1, b: 1, a: 1 };
    const enc = (lin: number, t: number) => linearToSrgb(lin * srgbToLinear(t));
    const emissive = rp.emissive !== undefined
      ? base.emissive
      : (gm.emissiveFactor.some((c) => c > 0) || gm.emissiveTexture
        ? { r: linearToSrgb(gm.emissiveFactor[0]), g: linearToSrgb(gm.emissiveFactor[1]), b: linearToSrgb(gm.emissiveFactor[2]), a: 1 }
        : undefined);
    if (rp.emissive === undefined && gm.emissiveTexture && !gm.emissiveFactor.some((c) => c > 0) && emissive) {
      emissive.r = emissive.g = emissive.b = 1;
    }
    const mr = tex(gm.metallicRoughnessTexture);
    const colorTex = tex(gm.baseColorTexture);
    const xf = gm.baseColorTexture;
    return {
      ...base,
      color: { r: enc(bc[0], tint.r), g: enc(bc[1], tint.g), b: enc(bc[2], tint.b), a: 1 },
      opacity: (gm.alphaMode === 'OPAQUE' ? 1 : bc[3]) * (typeof rp.opacity === 'number' ? rp.opacity : 1),
      metalness: typeof rp.metalness === 'number' ? rp.metalness : gm.metallicFactor,
      roughness: typeof rp.roughness === 'number' ? rp.roughness : gm.roughnessFactor,
      emissive,
      texture: base.texture ?? colorTex,
      maps: {
        ...maps,
        roughness: maps.roughness ?? mr,
        metalness: maps.metalness ?? mr,
        emissive: maps.emissive ?? tex(gm.emissiveTexture),
      },
      normalScale: base.normalScale ?? gm.normalTexture?.scale,
      uvRepeat: base.uvRepeat ?? (xf && (xf.scale[0] !== 1 || xf.scale[1] !== 1) ? xf.scale : undefined),
      uvOffset: base.uvOffset ?? (xf && (xf.offset[0] !== 0 || xf.offset[1] !== 0) ? xf.offset : undefined),
      shading: typeof rp.shading === 'string' ? base.shading : (gm.unlit ? 'unlit' : base.shading),
    };
  }

  /** Draw a model or text node (called from drawMeshEntry with the pass's lighting). */
  private drawContentSolid(
    key: string,
    entry: { node: VocabNode; rp: Record<string, unknown> },
    surfaceModel: Mat4,
    common: Pick<MeshMaterialOpts, 'viewProj' | 'lights' | 'ambient' | 'fog' | 'environment' | 'shadow' | 'spotShadow' | 'cameraPos'>,
  ): void {
    const { node, rp } = entry;
    const world = this.sceneStore.worldMatrix(node, surfaceModel);
    const fullKey = `${key}/${node.id}`;
    if (node.kind === 'text') {
      const geometry = this.textGeometryFor(rp);
      if (!geometry) return;
      const m = resolveMaterial(this.withDefaultColor(rp, '$textPrimary'), this.sceneTheme, this.sceneLibrary);
      this.renderer.drawMesh({ ...materialDrawOpts(m, (src) => this.resolveTexture(src)), ...common, model: world, geometry, closed: true });
      return;
    }
    const src = rp.src;
    if (typeof src !== 'string' || !src) return;
    const e = this.modelEntry(src);
    if (e.state !== 'ready') return;
    this.ensureModelGpu(e);
    const pose = this.posedModel(fullKey, e, rp);
    if (pose.moving) this.needsRender = true;
    const placed = mat4Multiply(world, pose.fit);
    for (const item of pose.items) {
      const handle = e.meshes.get(item.primitive);
      if (!handle) continue;
      const mode = item.primitive.mode === GLTF_MODE.POINTS ? 'points'
        : isTrianglePrimitive(item.primitive) ? undefined : 'lines';
      this.renderer.drawDynamicMesh(handle, {
        ...this.modelMaterial(e, item, rp),
        ...common,
        ...(mode ? { drawMode: mode } : {}),
        model: mat4Multiply(placed, item.worldMatrix),
      });
    }
  }

  /** A model node's pose for this frame, computed once and shared by every pass. */
  private posedModel(fullKey: string, e: ModelEntry, rp: Record<string, unknown>): { items: GltfDrawItem[]; fit: Mat4; src: string; moving: boolean } {
    const hit = this.modelPoses.get(fullKey);
    if (hit && hit.frame === this.contentFrame && hit.src === e.src) return hit;
    const pose = this.modelPose(fullKey, e, rp);
    const entry = { items: pose.items, fit: this.modelFitMatrix(e, rp.fit), src: e.src, frame: this.contentFrame, moving: pose.moving };
    this.modelPoses.set(fullKey, entry);
    return entry;
  }

  /** Params with a default colour when neither they nor their preset give one. */
  private withDefaultColor(rp: Record<string, unknown>, color: string): Record<string, unknown> {
    if (rp.color !== undefined) return rp;
    if (withMaterialPreset(rp, this.sceneLibrary).color !== undefined) return rp;
    return { ...rp, color };
  }

  /** Extruded geometry for a text node (cached by its text inputs), retraced once a web font loads. */
  private textGeometryFor(rp: Record<string, unknown>): Geometry | undefined {
    const text = rp.text;
    if (typeof text !== 'string' || !text) return undefined;
    const font = typeof rp.font === 'string' ? rp.font : (this.sceneTheme?.fonts?.display ?? 'sans-serif');
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts && !this.pendingTextFonts.has(font)) {
      let ready = true;
      try { ready = fonts.check(cssFont(font, 48)); } catch { ready = true; }
      if (!ready) {
        this.pendingTextFonts.add(font);
        void ensureTextFont(font).then(() => {
          clearTextGeometryCache();
          this.needsRender = true;
        });
      }
    }
    return getTextGeometry({
      text, font,
      size: typeof rp.size === 'number' ? rp.size : undefined,
      depth: typeof rp.depth === 'number' ? rp.depth : undefined,
      bevel: typeof rp.bevel === 'number' ? rp.bevel : undefined,
      align: rp.align as 'left' | 'center' | 'right' | undefined,
      lineHeight: typeof rp.lineHeight === 'number' ? rp.lineHeight : undefined,
    })?.geometry;
  }

  /** A sky node: the dome behind everything else in its subtree. */
  private drawSkyNode(rp: Record<string, unknown>, env: ResolvedEnvironment | undefined, cam: SceneCamera): void {
    const sky = resolveSky(rp, this.sceneTheme, env?.ambient);
    this.skyRenderer.draw({
      invViewProj: cam.invViewProj,
      top: sky.top, horizon: sky.horizon, bottom: sky.bottom,
      sun: sky.sun ? {
        direction: sky.sun.direction, color: sky.sun.color, intensity: sky.sun.intensity,
        size: (sky.sun.size * 180) / Math.PI,
      } : undefined,
      stars: rp.stars as boolean | number | undefined,
      texture: typeof rp.texture === 'string' ? this.resolveTexture(rp.texture) : undefined,
      rotation: typeof rp.rotation === 'number' ? rp.rotation : undefined,
      opacity: typeof rp.opacity === 'number' ? rp.opacity : undefined,
    });
  }

  /** A line node: thick polyline or ribbon in the node's local px. */
  private drawLineNode(key: string, node: VocabNode, rp: Record<string, unknown>, surfaceModel: Mat4, cam: SceneCamera): void {
    const pts = rp.points;
    if (!Array.isArray(pts) || pts.length < 2) return;
    const fullKey = `${key}/${node.id}`;
    this.touchedContent.add(fullKey);
    let entry = this.lineHandles.get(fullKey);
    if (!entry) {
      entry = { handle: this.lineRenderer.createLine(), points: undefined, colors: undefined, widths: undefined, closed: undefined };
      this.lineHandles.set(fullKey, entry);
    }
    if (entry.points !== pts || entry.colors !== rp.colors || entry.widths !== rp.widths
      || entry.closed !== rp.closed || entry.theme !== this.sceneTheme) {
      const colors = Array.isArray(rp.colors)
        ? (rp.colors as string[]).map((c) => parseCssColor(resolveSceneColor(c, this.sceneTheme)))
        : undefined;
      this.lineRenderer.updateLine(entry.handle, {
        points: pts as number[][], colors, widths: Array.isArray(rp.widths) ? rp.widths as number[] : undefined, closed: rp.closed === true,
      });
      Object.assign(entry, { points: pts, colors: rp.colors, widths: rp.widths, closed: rp.closed, theme: this.sceneTheme });
    }
    this.lineRenderer.drawLine(entry.handle, {
      model: this.sceneStore.worldMatrix(node, surfaceModel),
      viewProj: cam.viewProj,
      cameraPos: cam.cameraPos,
      width: typeof rp.width === 'number' ? rp.width : 2,
      color: parseCssColor(resolveSceneColor((rp.color as string) ?? '$accent', this.sceneTheme)),
      opacity: typeof rp.opacity === 'number' ? rp.opacity : 1,
      dashed: rp.dashed as { dash: number; gap: number } | undefined,
      blend: rp.blend === 'additive' ? 'additive' : 'normal',
      join: rp.join === 'round' ? 'round' : 'miter',
      cap: rp.cap === 'round' ? 'round' : 'butt',
      ribbon: rp.ribbon === true,
    });
  }

  /** A `trail` param: a fading ribbon through the node's recent world positions. */
  private drawNodeTrail(key: string, node: VocabNode, rp: Record<string, unknown>, surfaceModel: Mat4, cam: SceneCamera): void {
    const spec = (rp.trail === true ? {} : rp.trail) as Record<string, unknown> | undefined;
    if (!spec || typeof spec !== 'object') return;
    const fullKey = `${key}/${node.id}`;
    this.touchedContent.add(`${fullKey}#trail`);
    const now = performance.now();
    let trail = this.trails.get(fullKey);
    if (!trail) {
      trail = new Trail({
        capacity: typeof spec.length === 'number' ? spec.length : 48,
        minDistance: typeof spec.minDistance === 'number' ? spec.minDistance : 3,
        lifetime: typeof spec.lifetime === 'number' ? spec.lifetime : 600,
      });
      this.trails.set(fullKey, trail);
    }
    const w = this.sceneStore.worldMatrix(node, surfaceModel);
    trail.push(w[12], w[13], w[14], now);
    this.lineRenderer.drawTrail(trail, {
      viewProj: cam.viewProj,
      cameraPos: cam.cameraPos,
      width: typeof spec.width === 'number' ? spec.width : 12,
      color: parseCssColor(resolveSceneColor((spec.color as string) ?? (rp.color as string) ?? '$accent', this.sceneTheme)),
      opacity: typeof spec.opacity === 'number' ? spec.opacity : 1,
      blend: spec.blend === 'normal' ? 'normal' : 'additive',
      now,
    });
    if (trail.isActive(now)) this.needsRender = true;
  }

  /**
   * A label node: its text rendered at the device pixel ratio into a
   * texture, drawn as a quad facing the camera. Screen-space labels keep
   * their CSS size at any depth; others are world px at the node's scale.
   */
  private drawLabelNode(key: string, node: VocabNode, rp: Record<string, unknown>, surfaceModel: Mat4, cam: SceneCamera): void {
    if (typeof rp.text !== 'string' || !rp.text) return;
    const fullKey = `${key}/${node.id}`;
    this.touchedContent.add(fullKey);
    const dpr = this.renderer.canvas.width / Math.max(1, this.renderer.cssWidth);
    const opts: LabelOptions = {
      text: rp.text,
      font: typeof rp.font === 'string' ? rp.font : (this.sceneTheme?.fonts?.body ?? 'system-ui, sans-serif'),
      size: typeof rp.size === 'number' ? rp.size : 14,
      color: resolveSceneColor((rp.color as string) ?? '$textPrimary', this.sceneTheme),
      background: typeof rp.background === 'string' ? resolveSceneColor(rp.background, this.sceneTheme) : undefined,
      padding: typeof rp.padding === 'number' ? rp.padding : undefined,
      radius: typeof rp.radius === 'number' ? rp.radius : undefined,
      maxWidth: typeof rp.maxWidth === 'number' ? rp.maxWidth : undefined,
      align: rp.align as 'left' | 'center' | 'right' | undefined,
      lineHeight: typeof rp.lineHeight === 'number' ? rp.lineHeight : undefined,
      dpr,
    };
    const lkey = labelKey(opts);
    let entry = this.labelTextures.get(fullKey);
    if (!entry || entry.key !== lkey) {
      const rendered = renderLabel(opts);
      if (!rendered) return;
      const tex = entry?.tex ?? this.renderer.createTexture();
      this.renderer.uploadTexture(tex, rendered.canvas as HTMLCanvasElement);
      entry = { key: lkey, tex, w: rendered.width, h: rendered.height };
      this.labelTextures.set(fullKey, entry);
    }
    const world = this.sceneStore.worldMatrix(node, surfaceModel);
    const model = this.labelQuad(world, entry.w, entry.h, rp, cam);
    if (!model) return;
    entry.model = model;
    this.renderer.drawSurface({
      model, viewProj: cam.viewProj, texture: entry.tex, width: entry.w, height: entry.h,
      radius: 0, dim: 1, opacity: typeof rp.opacity === 'number' ? rp.opacity : 1,
    });
  }

  /**
   * The quad a label draws as: axes along the camera's screen right and down
   * at the label's point (any camera, off-axis or orbiting), sized in CSS px
   * (constant on screen when screenSpace, the default) times the node scale.
   */
  private labelQuad(world: Mat4, w: number, h: number, rp: Record<string, unknown>, cam: SceneCamera): Mat4 | undefined {
    const p = vec3(world[12], world[13], world[14]);
    const vp = cam.viewProj;
    const cw = vp[3] * p.x + vp[7] * p.y + vp[11] * p.z + vp[15];
    if (cw <= 1e-6) return undefined;
    const nx = (vp[0] * p.x + vp[4] * p.y + vp[8] * p.z + vp[12]) / cw;
    const ny = (vp[1] * p.x + vp[5] * p.y + vp[9] * p.z + vp[13]) / cw;
    const nz = (vp[2] * p.x + vp[6] * p.y + vp[10] * p.z + vp[14]) / cw;
    // Unproject one CSS px to the right and one down at the label's depth.
    const W = Math.max(1, this.width), H = Math.max(1, this.height);
    const o = mat4TransformPoint(cam.invViewProj, vec3(nx, ny, nz));
    const r = vec3Sub(mat4TransformPoint(cam.invViewProj, vec3(nx + 2 / W, ny, nz)), o);
    const d = vec3Sub(mat4TransformPoint(cam.invViewProj, vec3(nx, ny - 2 / H, nz)), o);
    const pxR = vec3Length(r), pxD = vec3Length(d);
    if (!(pxR > 0) || !(pxD > 0)) return undefined;
    const scale = Math.hypot(world[0], world[1], world[2]) || 1;
    const screen = rp.screenSpace !== false;
    const kx = (screen ? pxR : 1) * scale, ky = (screen ? pxD : 1) * scale;
    const right = vec3Scale(r, 1 / pxR), down = vec3Scale(d, 1 / pxD);
    const fwd = vec3Normalize(vec3Cross(right, down));
    const anchor = Array.isArray(rp.anchor) ? rp.anchor as [number, number] : [0.5, 0.5];
    const Wq = w * kx, Hq = h * ky;
    const ox = (0.5 - anchor[0]) * Wq, oy = (0.5 - anchor[1]) * Hq;
    const m = new Float32Array(16);
    m[0] = right.x * Wq; m[1] = right.y * Wq; m[2] = right.z * Wq;
    m[4] = down.x * Hq; m[5] = down.y * Hq; m[6] = down.z * Hq;
    m[8] = fwd.x; m[9] = fwd.y; m[10] = fwd.z;
    m[12] = p.x + right.x * ox + down.x * oy;
    m[13] = p.y + right.y * ox + down.y * oy;
    m[14] = p.z + right.z * ox + down.z * oy;
    m[15] = 1;
    return m;
  }

  /** Ray-test a content node (model, text, label, line); world distance or null. */
  private hitContentNode(ray: Ray, key: string, node: VocabNode, world: Mat4): number | null {
    const fullKey = `${key}/${node.id}`;
    const rp = this.sceneStore.resolveParams(node);
    if (node.kind === 'label') {
      const model = this.labelTextures.get(fullKey)?.model;
      return model ? rayMeshHit(ray, model, 'plane') : null;
    }
    if (node.kind === 'text') {
      // The text's box: clicks between letters still count.
      const g = this.textGeometryFor(rp);
      if (!g) return null;
      const [lo, hi] = this.positionsAABB(g.positions as unknown as number[]);
      const box = mat4Multiply(world, mat4TRS(
        (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, 0, 0, 0,
        Math.max(1e-3, hi[0] - lo[0]), Math.max(1e-3, hi[1] - lo[1]), Math.max(1e-3, hi[2] - lo[2])));
      return rayMeshHit(ray, box, 'box');
    }
    if (node.kind === 'line') {
      return this.hitLine(ray, world, rp);
    }
    if (node.kind === 'model') {
      const pose = this.modelPoses.get(fullKey);
      const e = pose ? this.models.get(pose.src) : undefined;
      if (!pose || !e?.rest) return null;
      const placed = mat4Multiply(world, pose.fit);
      let tris = 0;
      for (const it of pose.items) tris += (it.primitive.indices?.length ?? it.primitive.vertexCount) / 3;
      if (tris > Compositor.MODEL_PICK_TRIANGLES) {
        const { min, max } = e.rest;
        const box = mat4Multiply(placed, mat4TRS(
          (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2, 0, 0, 0,
          Math.max(1e-3, max[0] - min[0]), Math.max(1e-3, max[1] - min[1]), Math.max(1e-3, max[2] - min[2])));
        return rayMeshHit(ray, box, 'box');
      }
      let best: number | null = null;
      for (const it of pose.items) {
        if (!isTrianglePrimitive(it.primitive)) continue;
        const g = primitiveGeometry(it.primitive);
        const t = rayCustomMeshHit(ray, mat4Multiply(placed, it.worldMatrix), g.positions, g.indices);
        if (t !== null && (best === null || t < best)) best = t;
      }
      return best;
    }
    return null;
  }

  /** Nearest approach of a ray to a line node's segments, within half its width (plus slack). */
  private hitLine(ray: Ray, world: Mat4, rp: Record<string, unknown>): number | null {
    const pts = rp.points as number[][] | undefined;
    if (!Array.isArray(pts) || pts.length < 2) return null;
    const tol = Math.max(3, ((typeof rp.width === 'number' ? rp.width : 2) / 2) + 3);
    const P = pts.map((q) => mat4TransformPoint(world, vec3(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0)));
    if (rp.closed === true && P.length > 2) P.push(P[0]);
    const dl = vec3Length(ray.dir) || 1;
    const u = vec3Scale(ray.dir, 1 / dl);
    let best: number | null = null;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], v = vec3Sub(P[i + 1], a);
      const w0 = vec3Sub(ray.origin, a);
      const b = vec3Dot(u, v), c = vec3Dot(v, v), d = vec3Dot(u, w0), e = vec3Dot(v, w0);
      const den = c - b * b;
      let s = den > 1e-9 ? (e - b * d) / den : 0; // along the segment (0..1 of v)
      s = Math.max(0, Math.min(1, c > 0 ? s : 0));
      const q = vec3Add(a, vec3Scale(v, s));
      const t = Math.max(0, vec3Dot(vec3Sub(q, ray.origin), u));
      const dist = vec3Length(vec3Sub(vec3Add(ray.origin, vec3Scale(u, t)), q));
      if (dist <= tol && (best === null || t < best)) best = t;
    }
    return best;
  }

  /** Local AABB of a content solid (shadow-map fitting). */
  private contentBounds(key: string, node: VocabNode): [number[], number[]] {
    const rp = this.sceneStore.resolveParams(node);
    if (node.kind === 'text') {
      const g = this.textGeometryFor(rp);
      return g ? this.positionsAABB(g.positions as unknown as number[]) : [[0, 0, 0], [0, 0, 0]];
    }
    const e = typeof rp.src === 'string' ? this.models.get(rp.src) : undefined;
    if (!e || e.state !== 'ready') return [[0, 0, 0], [0, 0, 0]];
    const pose = this.posedModel(`${key}/${node.id}`, e, rp);
    const items = pose.items.map((it) => ({ ...it, worldMatrix: mat4Multiply(pose.fit, it.worldMatrix) }));
    const b = drawItemsBounds(items);
    return [b.min, b.max];
  }

  /** Draw a content solid's depth into the current shadow map. */
  private drawContentDepth(key: string, node: VocabNode, world: Mat4): void {
    if (node.kind === 'text') {
      const g = this.textGeometryFor(this.sceneStore.resolveParams(node));
      if (g) this.renderer.drawDepthGeometry(g, world);
      return;
    }
    const rp = this.sceneStore.resolveParams(node);
    const e = typeof rp.src === 'string' ? this.models.get(rp.src) : undefined;
    if (!e || e.state !== 'ready') return;
    this.ensureModelGpu(e);
    const pose = this.posedModel(`${key}/${node.id}`, e, rp);
    const placed = mat4Multiply(world, pose.fit);
    for (const it of pose.items) {
      if (!isTrianglePrimitive(it.primitive)) continue;
      const h = e.meshes.get(it.primitive);
      if (h) this.renderer.drawDepthDynamic(h, mat4Multiply(placed, it.worldMatrix));
    }
  }

  /**
   * Free content GPU state that no longer has a node: per-node labels,
   * lines and trails that did not draw this frame, and (every couple of
   * seconds) models no node names any more.
   */
  private pruneContent(): void {
    this.contentFrame++;
    for (const [k, e] of this.labelTextures) {
      if (this.touchedContent.has(k)) continue;
      this.renderer.deleteTexture(e.tex);
      this.labelTextures.delete(k);
    }
    for (const [k, e] of this.lineHandles) {
      if (this.touchedContent.has(k)) continue;
      this.lineRenderer.deleteLine(e.handle);
      this.lineHandles.delete(k);
    }
    for (const k of this.trails.keys()) {
      if (!this.touchedContent.has(`${k}#trail`)) this.trails.delete(k);
    }
    this.touchedContent.clear();
    const now = performance.now();
    if (this.models.size === 0 || now - this.lastModelSweep < 2000) return;
    this.lastModelSweep = now;
    const used = new Set<string>();
    const liveNodes = new Set<string>();
    for (const key of [...this.surfaces.keys(), ...this.worldKeys]) {
      for (const node of this.sceneStore.nodesForSurface(key)) {
        if (node.kind !== 'model') continue;
        liveNodes.add(`${key}/${node.id}`);
        const src = this.sceneStore.resolveParams(node).src;
        if (typeof src === 'string') used.add(src);
      }
    }
    for (const [src, e] of this.models) {
      if (used.has(src) || e.state === 'loading') continue;
      this.freeModel(e);
      this.models.delete(src);
    }
    for (const k of this.modelClocks.keys()) if (!liveNodes.has(k)) this.modelClocks.delete(k);
    for (const k of this.modelPoses.keys()) if (!liveNodes.has(k)) this.modelPoses.delete(k);
  }

  /** After a context restore: label textures re-render; models and lines rebuild from their CPU copies. */
  private contentContextRestored(): void {
    this.labelTextures.clear();
    this.lineHandles.clear();
    // Model buffers rebuild in ensureModelGpu (their generation is stale now).
  }

  // ── Declarative animation engine ─────────────────────────────────────

  private static readonly EASINGS: Record<string, EasingCurve> = {
    linear: LINEAR, standard: STANDARD, decelerate: [0, 0, 0.2, 1],
    accelerate: [0.4, 0, 1, 1], emphasize: EMPHASIZE,
  };

  /** Start (or stop) animations on a node from an 'animate' op's params. */
  private startOrStopAnim(surfaceKey: string, op: SceneOp): void {
    const fullKey = `${surfaceKey}/${op.id}`;
    const p = (op.params ?? {}) as Record<string, unknown>;
    if (p.stop === true) { this.nodeAnims.delete(fullKey); return; }
    const node = this.sceneStore.getNode(surfaceKey, op.id);
    if (!node) return;
    const existing = this.nodeAnims.get(fullKey)?.anims ?? [];
    // A new target for a running spring bends its motion (keeping its
    // velocity) instead of restarting it.
    if (p.spring !== undefined && p.spring !== false && typeof p.channel === 'string' && p.to !== undefined) {
      const running = existing.find((a) => a.channel === p.channel && a.spring && !a.spring.settled);
      if (running?.spring) {
        const cfg = typeof p.spring === 'object' && p.spring ? p.spring as Record<string, number> : {};
        retargetSpring(running.spring, this.channelValue(running.channel, p.to), cfg);
        this.needsRender = true;
        return;
      }
    }
    const built = this.buildAnims(node, p);
    if (built.length === 0) return;
    // Replace same-channel animations; keep others (so spin + bob can coexist).
    const channels = new Set(built.map((a) => a.channel));
    const merged = existing.filter((a) => !channels.has(a.channel)).concat(built);
    this.nodeAnims.set(fullKey, { surfaceKey, id: op.id, anims: merged });
    this.needsRender = true;
  }

  /** Expand an animate spec (preset or explicit channel) into NodeAnims. */
  private buildAnims(node: VocabNode, p: Record<string, unknown>): NodeAnim[] {
    const now = performance.now();
    const curve = this.easingOf(p.easing);
    const delay = (p.delay as number) ?? 0;
    const base = { start: now + delay, loop: p.loop === true, yoyo: p.yoyo === true, curve };
    const preset = p.preset as string | undefined;
    if (preset) {
      const dur = (p.duration as number) ?? (preset === 'spin' ? 6000 : preset === 'orbit' ? 8000 : 1500);
      if (preset === 'spin') {
        const axis = (p.axis as string) ?? 'y';
        const cur = this.vecOf(node, 'rotation');
        const to = [...cur]; const ai = axis === 'x' ? 0 : axis === 'z' ? 2 : 1; to[ai] += Math.PI * 2;
        return [{ ...base, channel: 'rotation', from: cur, to, duration: dur, loop: true, curve: LINEAR }];
      }
      if (preset === 'bob') {
        const amp = (p.amplitude as number) ?? 20; const cur = this.vecOf(node, 'position');
        return [{ ...base, channel: 'position', from: cur, to: [cur[0], cur[1] + amp, cur[2]], duration: dur, loop: true, yoyo: true, curve: EMPHASIZE }];
      }
      if (preset === 'pulse') {
        const k = (p.scale as number) ?? 1.15; const cur = this.vecOf(node, 'scale');
        return [{ ...base, channel: 'scale', from: cur, to: cur.map((v) => v * k), duration: dur, loop: true, yoyo: true, curve: EMPHASIZE }];
      }
      if (preset === 'shake') {
        // A decaying jolt along x (params.axis x|y|z, params.amplitude px).
        const amp = (p.amplitude as number) ?? 10;
        const ai = (p.axis as string) === 'y' ? 1 : (p.axis as string) === 'z' ? 2 : 0;
        const cur = this.vecOf(node, 'position');
        const at = (k: number) => { const v = [...cur]; v[ai] += amp * k; return v; };
        return [{
          ...base, channel: 'position', from: cur, to: cur, duration: (p.duration as number) ?? 450,
          loop: false, yoyo: false, curve: LINEAR,
          path: [cur, at(1), at(-0.8), at(0.55), at(-0.3), at(0.12), cur],
        }];
      }
      if (preset === 'flash') {
        // Emissive up to params.color (default the living light) and back.
        const cur = this.vecOf(node, 'emissive');
        const to = this.channelValue('emissive', (p.color as string) ?? '$accentSecondary');
        const up = Math.round(((p.duration as number) ?? 600) * 0.25);
        return [
          { ...base, channel: 'emissive', from: cur, to, duration: up, loop: false, yoyo: false, curve: DECELERATE },
          { ...base, start: base.start + up, channel: 'emissive', from: to, to: cur, duration: ((p.duration as number) ?? 600) - up, loop: false, yoyo: false, curve: STANDARD },
        ];
      }
      if (preset === 'float') {
        // A slow drift with a gentle turn: bob plus a small yaw sway.
        const amp = (p.amplitude as number) ?? 8;
        const pos = this.vecOf(node, 'position');
        const rot = this.vecOf(node, 'rotation');
        return [
          { ...base, channel: 'position', from: pos, to: [pos[0], pos[1] - amp, pos[2]], duration: dur * 2, loop: true, yoyo: true, curve: STANDARD },
          { ...base, channel: 'rotation', from: [rot[0], rot[1] - 0.12, rot[2]], to: [rot[0], rot[1] + 0.12, rot[2]], duration: dur * 3.3, loop: true, yoyo: true, curve: STANDARD },
        ];
      }
      if (preset === 'orbit') {
        const cur = this.vecOf(node, 'position');
        const center = (p.center as [number, number, number]) ?? [cur[0], cur[1], cur[2]];
        const radius = (p.radius as number) ?? 100;
        const plane = ((p.plane as string) ?? 'xz') as 'xy' | 'xz' | 'yz';
        return [{ ...base, channel: 'orbit', from: cur, to: cur, duration: dur, loop: true, center, radius, plane }];
      }
      // Data presets (wobble, breathe, hover, ...): keyframe tracks around
      // the node's current transform.
      const data = MOTION_PRESETS[preset];
      if (data) {
        const tracks = expandMotionPreset(data, {
          position: this.vecOf(node, 'position'), rotation: this.vecOf(node, 'rotation'), scale: this.vecOf(node, 'scale'),
        }, {
          duration: typeof p.duration === 'number' ? p.duration : undefined,
          amplitude: typeof p.amplitude === 'number' ? p.amplitude : undefined,
          loop: typeof p.loop === 'boolean' ? p.loop : undefined,
          yoyo: typeof p.yoyo === 'boolean' ? p.yoyo : undefined,
        });
        return tracks.map(({ channel, track }) => ({
          ...base, channel, from: [], to: [], duration: track.duration, loop: track.loop, yoyo: track.yoyo, track,
        }));
      }
      return [];
    }
    const channel = p.channel as NodeAnim['channel'];
    if (!channel) return [];
    if (Array.isArray(p.keyframes)) {
      // Keyframes: [{ t (ms), value, easing? }], each key's easing shaping
      // the segment that starts at it (default: the op's easing, else linear).
      const track = buildKeyframeTrack(
        p.keyframes as Array<{ t: number; value: unknown; easing?: unknown }>,
        (v) => this.keyframeValue(channel, v),
        { loop: p.loop === true, yoyo: p.yoyo === true, easing: p.easing },
      );
      if (!track) return [];
      return [{ ...base, channel, from: [], to: [], duration: track.duration, track }];
    }
    if (p.spring !== undefined && p.spring !== false && p.to !== undefined) {
      const cfg = typeof p.spring === 'object' && p.spring ? p.spring as Record<string, number> : {};
      const from = p.from !== undefined ? this.channelValue(channel, p.from) : this.vecOf(node, channel);
      const spring = createSpring(from, this.channelValue(channel, p.to), cfg);
      return [{ ...base, channel, from, to: spring.target, duration: 0, loop: false, yoyo: false, spring }];
    }
    const duration = (p.duration as number) ?? 800;
    if (channel === 'position' && Array.isArray(p.path)) {
      const path = (p.path as number[][]);
      return [{ ...base, channel, from: this.vecOf(node, 'position'), to: path[path.length - 1] ?? [0, 0, 0], duration, path }];
    }
    const from = p.from !== undefined ? this.channelValue(channel, p.from) : this.vecOf(node, channel);
    const to = this.channelValue(channel, p.to);
    return [{ ...base, channel, from, to, duration }];
  }

  private easingOf(e: unknown): EasingCurve {
    if (Array.isArray(e) && e.length === 4 && e.every((n) => typeof n === 'number')) return e as unknown as EasingCurve;
    if (typeof e === 'string' && Compositor.EASINGS[e]) return Compositor.EASINGS[e];
    return STANDARD;
  }

  /** Current numeric vector for a channel, read from the node. */
  private vecOf(node: VocabNode, channel: NodeAnim['channel']): number[] {
    const t = node.transform;
    if (channel === 'position') return [...(t.position ?? [0, 0, 0])];
    if (channel === 'rotation') return [...(t.rotation ?? [0, 0, 0])];
    if (channel === 'scale') { const s = t.scale ?? 1; return typeof s === 'number' ? [s, s, s] : [...s]; }
    if (channel === 'opacity') return [(node.params.opacity as number) ?? 1];
    // color / emissive
    const c = parseCssColor(resolveSceneColor((node.params[channel === 'color' ? 'color' : 'emissive'] as string) ?? '#ffffff', this.sceneTheme));
    return [c.r, c.g, c.b];
  }

  /** A keyframe's value as the channel's vector, or undefined when it does not fit the channel. */
  private keyframeValue(channel: NodeAnim['channel'], v: unknown): number[] | undefined {
    if (channel === 'color' || channel === 'emissive') return typeof v === 'string' ? this.channelValue(channel, v) : undefined;
    if (channel === 'opacity') return typeof v === 'number' ? [v] : undefined;
    if (typeof v === 'number') return channel === 'scale' ? [v, v, v] : undefined;
    return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number') ? [...v as number[]] : undefined;
  }

  /** Coerce an animate target value into the channel's numeric vector form. */
  private channelValue(channel: NodeAnim['channel'], v: unknown): number[] {
    if (channel === 'color' || channel === 'emissive') {
      const c = parseCssColor(resolveSceneColor(v as string, this.sceneTheme));
      return [c.r, c.g, c.b];
    }
    if (channel === 'opacity') return [typeof v === 'number' ? v : 1];
    if (channel === 'scale' && typeof v === 'number') return [v, v, v];
    return Array.isArray(v) ? (v as number[]) : [0, 0, 0];
  }

  /**
   * Advance every active animation and write results into node transforms/
   * params. Returns true while any animation is still running so the render
   * loop keeps requesting frames. Drops animations whose node is gone.
   */
  private stepAnimations(now: number): boolean {
    if (this.nodeAnims.size === 0) return false;
    let active = false;
    for (const [key, entry] of this.nodeAnims) {
      const node = this.sceneStore.getNode(entry.surfaceKey, entry.id);
      if (!node) { this.nodeAnims.delete(key); continue; }
      // Looping presets on hidden windows / inactive workspaces must not
      // keep the frame loop alive. Keep the entry (time-based anims resume
      // at the current phase on reveal) but neither step nor mark active.
      if (!this.isSurfaceKeyRenderable(entry.surfaceKey)) continue;
      const live: NodeAnim[] = [];
      for (const a of entry.anims) {
        const done = this.applyAnim(node, a, now);
        if (!done) { live.push(a); active = true; }
      }
      if (live.length === 0) this.nodeAnims.delete(key);
      else entry.anims = live;
    }
    return active;
  }

  /** Apply one animation channel to a node at time `now`. Returns true if finished. */
  private applyAnim(node: VocabNode, a: NodeAnim, now: number): boolean {
    const elapsed = now - a.start;
    if (elapsed < 0) return false; // still in delay
    if (a.track) {
      const { value, done } = sampleKeyframes(a.track, elapsed);
      this.writeChannel(node, a.channel, value);
      return done;
    }
    if (a.spring) {
      // Exact spring step for the real frame time (stable at any frame rate).
      const dt = (now - Math.max(a.lastT ?? a.start, a.start)) / 1000;
      a.lastT = now;
      const moving = stepSpring(a.spring, dt);
      this.writeChannel(node, a.channel, a.spring.value);
      return !moving;
    }
    if (a.channel === 'orbit') {
      const ang = (elapsed / a.duration) * Math.PI * 2;
      const c = a.center ?? [0, 0, 0], r = a.radius ?? 100;
      const co = Math.cos(ang) * r, si = Math.sin(ang) * r;
      const pos = a.plane === 'xy' ? [c[0] + co, c[1] + si, c[2]]
        : a.plane === 'yz' ? [c[0], c[1] + co, c[2] + si]
        : [c[0] + co, c[1], c[2] + si];
      node.transform = { ...node.transform, position: pos as [number, number, number] };
      return false; // orbit loops forever
    }
    let t = a.duration > 0 ? elapsed / a.duration : 1;
    let finished = false;
    if (t >= 1) {
      if (a.loop) {
        const cycle = Math.floor(t);
        t = t - cycle;
        if (a.yoyo && cycle % 2 === 1) t = 1 - t;
      } else { t = 1; finished = true; }
    }
    const eased = cubicBezier(a.curve, Math.max(0, Math.min(1, t)));
    const v = a.path ? this.samplePath(a.path, eased) : a.from.map((f, i) => f + (a.to[i] - f) * eased);
    this.writeChannel(node, a.channel, v);
    return finished;
  }

  /** Piecewise-linear sample of a waypoint path at progress 0..1. */
  private samplePath(path: number[][], t: number): number[] {
    if (path.length === 1) return path[0];
    const seg = t * (path.length - 1);
    const i = Math.min(path.length - 2, Math.floor(seg));
    const f = seg - i;
    const a = path[i], b = path[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /** Write an animated value into the node's retained transform/params. */
  private writeChannel(node: VocabNode, channel: NodeAnim['channel'], v: number[]): void {
    if (channel === 'position') node.transform = { ...node.transform, position: [v[0], v[1], v[2]] };
    else if (channel === 'rotation') node.transform = { ...node.transform, rotation: [v[0], v[1], v[2]] };
    else if (channel === 'scale') node.transform = { ...node.transform, scale: [v[0], v[1], v[2]] };
    else if (channel === 'opacity') node.params = { ...node.params, opacity: v[0] };
    else { // color / emissive
      const css = `rgb(${Math.round(v[0] * 255)}, ${Math.round(v[1] * 255)}, ${Math.round(v[2] * 255)})`;
      node.params = { ...node.params, [channel]: css };
    }
  }

  /**
   * Get (or build/refresh) the GPU handle for a custom-geometry mesh node.
   * The Float32/Uint32 arrays are rebuilt and re-uploaded only when the
   * node's geometry revision changes; transform/color updates reuse the
   * existing buffers. Marks the key touched so it survives end-of-frame
   * pruning.
   */
  private customMeshHandle(key: string, node: VocabNode): DynamicMesh | undefined {
    const fullKey = `${key}/${node.id}`;
    this.touchedCustomMeshes.add(fullKey);
    let entry = this.customMeshes.get(fullKey);
    if (entry && entry.rev === node.geomRev) return entry.handle;
    const g = node.params.geometry as CustomGeometryParam | undefined;
    if (!g || !Array.isArray(g.positions)) return entry?.handle;
    const geom = customGeometry(g.positions, g.indices, g.normals, g.colors, g.uvs);
    if (!entry) {
      entry = { rev: node.geomRev, geom, handle: this.renderer.createDynamicMesh() };
      this.customMeshes.set(fullKey, entry);
    } else {
      entry.geom = geom;
      entry.rev = node.geomRev;
    }
    this.renderer.updateDynamicMesh(entry.handle, geom);
    return entry.handle;
  }

  /**
   * Free GPU buffers for custom meshes that were not drawn this frame —
   * removed nodes, destroyed surfaces, or windows that went off-screen. The
   * retained scene store rebuilds any that reappear. Called once per frame.
   */
  private pruneCustomMeshes(): void {
    if (this.customMeshes.size > 0) {
      for (const [fullKey, entry] of this.customMeshes) {
        if (this.touchedCustomMeshes.has(fullKey)) continue;
        this.renderer.deleteDynamicMesh(entry.handle);
        this.customMeshes.delete(fullKey);
      }
    }
    if (this.instancedMeshes.size > 0) {
      for (const [fullKey, entry] of this.instancedMeshes) {
        if (this.touchedInstanced.has(fullKey)) continue;
        this.renderer.deleteInstancedMesh(entry.handle);
        this.instancedMeshes.delete(fullKey);
      }
    }
  }

  /** Draw all world-scope node trees for one layer (workspace coordinates). */
  private drawWorldNodes(layer: 'back' | 'front'): void {
    if (this.worldKeys.size === 0) return;
    const identity = mat4Identity();
    for (const key of this.worldKeys) {
      if (this.sceneStore.nodesForSurface(key).length === 0) {
        this.worldKeys.delete(key);
        continue;
      }
      this.drawNodeTree(key, identity, this.globalCamera(), layer);
    }
  }

  /**
   * Workspace size is the union of the viewport and the bounding box of all
   * visible surfaces, so users can always scroll to any window even if it
   * gets dragged off-screen.
   */
  private getWorkspaceSize(): { width: number; height: number } {
    let maxX = this.width;
    let maxY = this.height;
    for (const s of this.sortedSurfaces) {
      if (!s.visible) continue;
      if (this.isWorkspaceFiltered(s)) continue;
      const rx = s.rect.x + s.rect.width;
      const ry = s.rect.y + s.rect.height;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
    }
    return { width: maxX, height: maxY };
  }

  private clampScroll(): void {
    // The phone camera keeps to the used desktop instead (see clampMobileView).
    if (this.mobileMode) { this.clampMobileView(); return; }
    const ws = this.getWorkspaceSize();
    const maxX = Math.max(0, ws.width - this.width);
    const maxY = Math.max(0, ws.height - this.height);
    if (this.scrollX < 0) this.scrollX = 0;
    if (this.scrollY < 0) this.scrollY = 0;
    if (this.scrollX > maxX) this.scrollX = maxX;
    if (this.scrollY > maxY) this.scrollY = maxY;
  }

  /**
   * Scroll the viewport within the workspace. Coordinates are in workspace
   * pixels. Values are clamped to the workspace bounds on next render.
   */
  scrollTo(x: number, y: number): void {
    if (x === this.scrollX && y === this.scrollY) return;
    this.scrollX = x;
    this.scrollY = y;
    this.needsRender = true;
  }

  scrollBy(dx: number, dy: number): void {
    this.scrollTo(this.scrollX + dx, this.scrollY + dy);
  }

  getScroll(): { x: number; y: number } {
    return { x: this.scrollX, y: this.scrollY };
  }

  /** Screen-space chrome for the desktop (scrollbars) on the 2D overlay. */
  private renderScrollbarsOverlay(): void {
    const ws = this.getWorkspaceSize();
    const needH = ws.width > this.width;
    const needV = ws.height > this.height;
    const ctx = this.overlay.begin();
    if (!needH && !needV) return;
    this.overlay.markContent();

    const SZ = Compositor.SCROLLBAR_SIZE;
    const M = Compositor.SCROLLBAR_MARGIN;
    // Constructivist themes: an ink track and a square red thumb.
    // An ink track and a square accent thumb.
    const trackColor = 'rgba(0,0,0,0.25)';
    const thumbColor = this.sceneColor('accent', '#d32f22');
    const thumbRadius = 0;

    if (needV) {
      // Track
      ctx.fillStyle = trackColor;
      ctx.fillRect(this.width - SZ - M, M, SZ, this.height - 2 * M - (needH ? SZ + M : 0));
      // Thumb
      const trackH = this.height - 2 * M - (needH ? SZ + M : 0);
      const thumbH = Math.max(24, (this.height / ws.height) * trackH);
      const thumbY = M + (this.scrollY / (ws.height - this.height)) * (trackH - thumbH);
      ctx.fillStyle = thumbColor;
      this.roundRectOn(ctx, this.width - SZ - M, thumbY, SZ, thumbH, thumbRadius);
      ctx.fill();
    }
    if (needH) {
      ctx.fillStyle = trackColor;
      ctx.fillRect(M, this.height - SZ - M, this.width - 2 * M - (needV ? SZ + M : 0), SZ);
      const trackW = this.width - 2 * M - (needV ? SZ + M : 0);
      const thumbW = Math.max(24, (this.width / ws.width) * trackW);
      const thumbX = M + (this.scrollX / (ws.width - this.width)) * (trackW - thumbW);
      ctx.fillStyle = thumbColor;
      this.roundRectOn(ctx, thumbX, this.height - SZ - M, thumbW, SZ, thumbRadius);
      ctx.fill();
    }
  }

  private roundRectOn(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * Return the scrollbar hit (for starting a thumb drag) at viewport coords.
   */
  scrollbarAt(vx: number, vy: number): 'x' | 'y' | undefined {
    const ws = this.getWorkspaceSize();
    const needH = ws.width > this.width;
    const needV = ws.height > this.height;
    const SZ = Compositor.SCROLLBAR_SIZE;
    const M = Compositor.SCROLLBAR_MARGIN;
    if (needV && vx >= this.width - SZ - M && vx <= this.width - M) return 'y';
    if (needH && vy >= this.height - SZ - M && vy <= this.height - M) return 'x';
    return undefined;
  }

  beginScrollbarDrag(axis: 'x' | 'y', mouseViewportPos: number): void {
    this.scrollbarDrag = {
      axis,
      startMouse: mouseViewportPos,
      startScroll: axis === 'x' ? this.scrollX : this.scrollY,
    };
  }

  /**
   * Update scroll based on ongoing scrollbar thumb drag. Returns true if a
   * drag is in progress and the event should be consumed.
   */
  updateScrollbarDrag(mouseViewportX: number, mouseViewportY: number): boolean {
    if (!this.scrollbarDrag) return false;
    const ws = this.getWorkspaceSize();
    if (this.scrollbarDrag.axis === 'y') {
      const trackH = this.height - 2 * Compositor.SCROLLBAR_MARGIN;
      const thumbH = Math.max(24, (this.height / ws.height) * trackH);
      const travel = trackH - thumbH;
      const delta = mouseViewportY - this.scrollbarDrag.startMouse;
      const scrollRange = ws.height - this.height;
      if (travel > 0 && scrollRange > 0) {
        this.scrollTo(this.scrollX, this.scrollbarDrag.startScroll + (delta / travel) * scrollRange);
      }
    } else {
      const trackW = this.width - 2 * Compositor.SCROLLBAR_MARGIN;
      const thumbW = Math.max(24, (this.width / ws.width) * trackW);
      const travel = trackW - thumbW;
      const delta = mouseViewportX - this.scrollbarDrag.startMouse;
      const scrollRange = ws.width - this.width;
      if (travel > 0 && scrollRange > 0) {
        this.scrollTo(this.scrollbarDrag.startScroll + (delta / travel) * scrollRange, this.scrollY);
      }
    }
    return true;
  }

  endScrollbarDrag(): void {
    this.scrollbarDrag = undefined;
  }

  /** Middle-click pan drag support. */
  beginPanDrag(viewportX: number, viewportY: number): void {
    this.panDrag = {
      startX: viewportX,
      startY: viewportY,
      startScrollX: this.scrollX,
      startScrollY: this.scrollY,
    };
  }

  updatePanDrag(viewportX: number, viewportY: number): boolean {
    if (!this.panDrag) return false;
    const dx = viewportX - this.panDrag.startX;
    const dy = viewportY - this.panDrag.startY;
    this.scrollTo(this.panDrag.startScrollX - dx, this.panDrag.startScrollY - dy);
    return true;
  }

  endPanDrag(): void {
    this.panDrag = undefined;
  }

  /** Screen height above the gesture handle (where framing places content). */
  private get mobileAvailHeight(): number {
    return this.height - Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
  }

  /**
   * The phone renders the real desktop (renderDesktop: slabs, shadows, world
   * layers, pop-outs, effects, ghosts) through its zoomable camera, after
   * advancing any camera flight, glide or Exposé animation, then draws its
   * own 2D chrome: the gesture handle and, in Exposé, the window titles.
   */
  private renderMobile(): void {
    if (this.stepMobileCamera(performance.now())) this.needsRender = true;
    this.renderDesktop();
    this.drawMobileOverlay();
  }

  /** Advance the phone camera one frame (Exposé steps in stepExpose). True while anything moves. */
  private stepMobileCamera(now: number): boolean {
    let moving = false;
    // The framed window closed: fly out unless its object came right back.
    if (this.mobileFocusLost) {
      if (now - this.mobileFocusLost.at > 400) {
        this.mobileFocusLost = undefined;
        if (this.mobileView === MobileViewState.FOCUS) this.mobileFlyOut();
      } else {
        moving = true;
      }
    }
    // Keep the desktop fitted while windows arrive, until the user takes the camera.
    if (this.mobileAutoFit && !this.mobileFlight && this.mobileView === MobileViewState.DESKTOP) {
      const fit = this.mobileFitCam();
      if (Math.abs(fit.x - this.scrollX) > 0.01 || Math.abs(fit.y - this.scrollY) > 0.01
          || Math.abs(fit.zoom - this.viewZoom) > 1e-5) {
        this.applyMobileCam(fit);
      }
    }
    const f = this.mobileFlight;
    if (f) {
      const t = Math.min(1, (now - f.start) / f.duration);
      this.applyMobileCam(this.lerpCam(f.from, f.to, cubicBezier(EMPHASIZE, t)));
      if (t >= 1) this.mobileFlight = undefined;
      else moving = true;
    }
    const g = this.mobileGlide;
    if (g) {
      const dt = Math.min(0.05, Math.max(0, (now - g.last) / 1000));
      g.last = now;
      const decay = Math.exp(-Compositor.MOBILE_GLIDE_FRICTION * dt);
      g.vx *= decay;
      g.vy *= decay;
      const before = this.currentCam();
      this.scrollX -= (g.vx * dt) / this.viewZoom;
      this.scrollY -= (g.vy * dt) / this.viewZoom;
      this.clampMobileView();
      // A glide that hits the edge of the desktop stops there.
      if (Math.abs(this.scrollX - before.x) < 1e-3 && Math.abs(g.vx) > 0) g.vx = 0;
      if (Math.abs(this.scrollY - before.y) < 1e-3 && Math.abs(g.vy) > 0) g.vy = 0;
      if (Math.hypot(g.vx, g.vy) < 12) this.mobileGlide = undefined;
      else moving = true;
    }
    return moving;
  }

  /**
   * Advance Exposé one frame (render, phone and desktop): the spread, the
   * desktop's selection highlight, and the phone's flicked windows. True
   * while anything moves; once settled the desktop rests.
   */
  private stepExpose(now: number): boolean {
    let moving = this.syncExposeMembers(now);
    for (const slot of this.exposeSlots.values()) {
      if (!slot.from || slot.moveStart === undefined) continue;
      if (now - slot.moveStart < Compositor.EXPOSE_FLIGHT_MS) moving = true;
      else { slot.from = undefined; slot.moveStart = undefined; slot.joining = undefined; moving = true; }
    }
    const a = this.exposeAnim;
    if (a) {
      const t = Math.min(1, (now - a.start) / a.duration);
      this.exposeT = a.from + (a.to - a.from) * cubicBezier(EMPHASIZE, t);
      this.exposeP = a.pFrom + (a.to - a.pFrom) * t;
      if (t >= 1) {
        this.exposeAnim = undefined;
        a.done?.();
      } else {
        moving = true;
      }
    }
    for (const [id, fly] of this.exposeFlyOff) {
      const age = now - fly.start;
      if (age < 260) moving = true;
      // A window the backend kept (it refused to close) drops back into its slot.
      else if (age > 2500) { this.exposeFlyOff.delete(id); this.exposeLift.delete(id); moving = true; }
    }
    if (!this.mobileMode) {
      // The selected window eases up to its highlight; the rest ease down.
      for (const id of this.exposeSlots.keys()) {
        const target = id === this.exposeSelected && this.mobileView === MobileViewState.EXPOSE ? 1 : 0;
        const cur = this.exposeHot.get(id) ?? 0;
        if (cur === target) continue;
        const next = cur + (target - cur) * 0.3;
        this.exposeHot.set(id, Math.abs(next - target) < 0.01 ? target : next);
        moving = true;
      }
    }
    return moving;
  }

  /** Draw the phone's 2D chrome. The overlay texture is reused until what it shows changes. */
  private drawMobileOverlay(): void {
    const expose = this.exposeT > 0.02;
    const color = this.mobileView === MobileViewState.EXPOSE
      ? this.sceneColor('accent', '#d32f22')
      : this.sceneColor('textSecondary', '#a8a292');
    const sig = expose ? `expose:${performance.now()}` : `${this.width}x${this.height}:${color}`;
    if (sig === this.mobileOverlaySig) return;
    this.mobileOverlaySig = sig;
    const ctx = this.overlay.begin();
    this.overlay.markContent();
    if (expose) this.drawExposeLabels(ctx);
    this.drawGestureHandle(ctx, color);
  }

  /** Slim centered pill: the phone's "home" affordance (tap or swipe up to fly out). */
  private drawGestureHandle(ctx: OffscreenCanvasRenderingContext2D, color: string): void {
    const h = Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
    const y = this.height - h / 2;
    const pillW = 120;
    const pillH = 4;
    const x = (this.width - pillW) / 2;
    ctx.fillStyle = color;
    this.roundRectOn(ctx, x, y - pillH / 2, pillW, pillH, 0);
    ctx.fill();
  }

  // ── Phone camera ──────────────────────────────────────────────────────

  private currentCam(): MobileCam {
    return { x: this.scrollX, y: this.scrollY, zoom: this.viewZoom };
  }

  private applyMobileCam(c: MobileCam): void {
    this.scrollX = c.x;
    this.scrollY = c.y;
    this.viewZoom = c.zoom;
    this.needsRender = true;
  }

  /** Between two poses: zoom geometrically, the view centre in a straight line. */
  private lerpCam(a: MobileCam, b: MobileCam, t: number): MobileCam {
    const W = this.width;
    const H = this.height;
    const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
    const acx = a.x + W / (2 * a.zoom), acy = a.y + H / (2 * a.zoom);
    const bcx = b.x + W / (2 * b.zoom), bcy = b.y + H / (2 * b.zoom);
    const cx = acx + (bcx - acx) * t;
    const cy = acy + (bcy - acy) * t;
    return { x: cx - W / (2 * zoom), y: cy - H / (2 * zoom), zoom };
  }

  /** Fly the camera to a pose with the motion curve. */
  private flyTo(to: MobileCam, duration = Compositor.MOBILE_FLIGHT_MS): void {
    this.mobileGlide = undefined;
    this.mobileFlight = { from: this.currentCam(), to, start: performance.now(), duration };
    this.needsRender = true;
  }

  /** Workspace bounds the phone can see: every visible window, the dock included. */
  private mobileUsedBounds(): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.sortedSurfaces) {
      // Pinned windows live in screen space, not on the desktop being framed.
      if (!s.visible || !s.drawn || s.inputPassthrough || this.isWorkspaceFiltered(s) || this.pinnable(s)) continue;
      const b = this.surfaceBounds(s);
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
    }
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 1280, y1: 800 };
    return { x0, y0, x1, y1 };
  }

  /**
   * A window's workspace box: its rect, or for a window riding a scene node
   * the box its slab covered on screen last frame (mapped back to workspace
   * px), so framing follows where the window really is.
   */
  private surfaceBounds(s: Surface): { x0: number; y0: number; x1: number; y1: number; z?: number } {
    const st = this.surfaceGl.get(s.id);
    if (st?.attach && st.model) {
      // The slab's corners in world space (x, y) and its mean depth, which
      // framing uses for the perspective scale once the eye is over it.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z = 0;
      for (const [qx, qy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const p = mat4TransformPoint(st.model, vec3(qx, qy, 0));
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        z += p.z / 4;
      }
      if (Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(z)) return { x0, y0, x1, y1, z };
    }
    return { x0: s.rect.x, y0: s.rect.y, x1: s.rect.x + s.rect.width, y1: s.rect.y + s.rect.height };
  }

  /** The pose that shows the whole used desktop above the gesture handle. */
  private mobileFitCam(): MobileCam {
    const b = this.mobileUsedBounds();
    const m = Compositor.MOBILE_MARGIN;
    const W = Math.max(1, this.width);
    const H = Math.max(1, this.mobileAvailHeight);
    const bw = Math.max(1, b.x1 - b.x0);
    const bh = Math.max(1, b.y1 - b.y0);
    const zoom = Math.max(0.05, Math.min(1, (W - 2 * m) / bw, (H - 2 * m) / bh));
    return { x: (b.x0 + b.x1) / 2 - W / (2 * zoom), y: (b.y0 + b.y1) / 2 - H / (2 * zoom), zoom };
  }

  /**
   * The pose that frames a workspace box: its width fits the screen with a
   * small margin (zoom capped at `maxZoom`), top-aligned when it is taller
   * than the space above the handle (so a window's title bar stays in view),
   * centred otherwise.
   */
  private mobileFrameCam(b: { x0: number; y0: number; x1: number; y1: number; z?: number }, maxZoom: number): MobileCam {
    const m = Compositor.MOBILE_MARGIN;
    const W = Math.max(1, this.width);
    const Hc = Math.max(1, this.height);
    const H = Math.max(1, this.mobileAvailHeight);
    const bw = Math.max(1, b.x1 - b.x0);
    const bh = Math.max(1, b.y1 - b.y0);
    // A box off the z=0 plane (a window riding a node) shows larger or
    // smaller by the perspective at its depth once the eye is over it.
    const D = cameraDistance(Hc);
    const s = b.z ? D / Math.max(1, D - b.z) : 1;
    const zoom = Math.max(0.05, Math.min(maxZoom, (W - 2 * m) / (bw * s)));
    // The eye goes over the box centre horizontally; vertically the box is
    // top-aligned under the margin, or centred in the space above the handle.
    const x = (b.x0 + b.x1) / 2 - W / (2 * zoom);
    const eyeY = bh * s * zoom > H - 2 * m
      ? b.y0 - (m - Hc / 2) / (zoom * s)
      : (b.y0 + b.y1) / 2 - (H - Hc) / (2 * zoom * s);
    return { x, y: eyeY - Hc / (2 * zoom), zoom };
  }

  /**
   * Keep the phone camera on the desktop: zoom between half the fit-all zoom
   * and the maximum, and the view centre inside the used area (lowered by
   * any bottom inset, so a field just above a covering keyboard can scroll
   * into view). Flights and Exposé own the camera while they run.
   */
  private clampMobileView(): void {
    if (this.mobileFlight || this.exposeT > 0) return;
    const W = Math.max(1, this.width);
    const H = Math.max(1, this.height);
    const fit = this.mobileFitCam().zoom;
    const zoom = Math.max(fit * 0.5, Math.min(Compositor.MOBILE_MAX_ZOOM, this.viewZoom));
    const b = this.mobileUsedBounds();
    const cx = this.scrollX + W / (2 * this.viewZoom);
    const cy = this.scrollY + H / (2 * this.viewZoom);
    const ncx = Math.max(b.x0, Math.min(b.x1, cx));
    const ncy = Math.max(b.y0, Math.min(b.y1 + this.mobileBottomInset / zoom, cy));
    this.viewZoom = zoom;
    this.scrollX = ncx - W / (2 * zoom);
    this.scrollY = ncy - H / (2 * zoom);
  }

  // ── Exposé ────────────────────────────────────────────────────────────

  /**
   * Windows Exposé spreads (and focus swipes move between): visible and
   * ordinary, so no system rails, overlays, passthrough surfaces, windows
   * riding a scene node (they stay with their node), or windows pinned to
   * the phone's screen (HUDs, not places to go).
   */
  private exposeCandidates(): Surface[] {
    return this.sortedSurfaces.filter((s) => s.visible && s.drawn && !s.inputPassthrough && !s.transparent
      && s.zIndex < RAIL_Z_THRESHOLD && !this.isWorkspaceFiltered(s) && !this.surfaceGl.get(s.id)?.attach
      && !this.pinnable(s));
  }

  /**
   * A surface the desktop Exposé leaves in place, live over the scrim: the
   * system rails (the dock, toolbars, toasts: anything stacked at or above
   * the rail threshold). The phone's Exposé shows only the spread windows.
   */
  private exposeKeeps(s: Surface): boolean {
    return !this.mobileMode && s.zIndex >= RAIL_Z_THRESHOLD && s.visible && s.drawn && !this.isWorkspaceFiltered(s);
  }

  /**
   * The screen area the desktop Exposé grid fills: the viewport, less the
   * rails docked along its edges (they stay put, see exposeKeeps), inset by
   * a margin with room at the top for the key hint.
   */
  private exposeDesktopArea(): Rect {
    const W = this.width;
    const H = this.height;
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const s of this.sortedSurfaces) {
      if (!this.exposeKeeps(s)) continue;
      const p = this.workspaceToViewport(s.rect.x, s.rect.y);
      const { width: w, height: h } = s.rect;
      const edge = 8;
      if (h >= H * 0.5 && p.x <= edge) x0 = Math.max(x0, p.x + w);
      else if (h >= H * 0.5 && p.x + w >= W - edge) x1 = Math.min(x1, p.x);
      else if (w >= W * 0.5 && p.y <= edge) y0 = Math.max(y0, p.y + h);
      else if (w >= W * 0.5 && p.y + h >= H - edge) y1 = Math.min(y1, p.y);
    }
    const side = 36, top = 52, bottom = 24;
    return { x: x0 + side, y: y0 + top, width: Math.max(40, x1 - x0 - side * 2), height: Math.max(40, y1 - y0 - top - bottom) };
  }

  /**
   * Lay the windows out in a grid on the current screen (reading order,
   * columns chosen for the largest shown area, never above 1:1), stored as
   * workspace centres and scales so renderDesktop can carry each slab there.
   */
  private layoutExpose(wins: Surface[]): void {
    this.exposeSlots.clear();
    const desk = this.mobileMode ? undefined : this.exposeDesktopArea();
    const side = desk ? desk.x : 12;
    const top = desk ? desk.y : 28;
    const labelH = desk ? 36 : 22;
    const gap = desk ? 36 : 16;
    const areaW = desk ? desk.width : Math.max(40, this.width - side * 2);
    const areaH = desk ? desk.height : Math.max(40, this.mobileAvailHeight - top - 8);
    const n = wins.length;
    this.exposeCount = n;
    this.exposeMembers = new Set(wins.map((s) => s.id));
    const sorted = [...wins].sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
    const fitIn = (s: Surface, cw: number, ch: number) =>
      Math.max(0.02, Math.min(1, (cw - gap) / s.rect.width, (ch - gap - labelH) / s.rect.height));
    let cols = 1;
    let bestScore = -1;
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      const cw = areaW / c, ch = areaH / rows;
      let score = 0;
      for (const s of sorted) {
        const k = fitIn(s, cw, ch);
        score += k * k * s.rect.width * s.rect.height;
      }
      if (score > bestScore) { bestScore = score; cols = c; }
    }
    const rows = Math.ceil(n / cols);
    const cw = areaW / cols, ch = areaH / rows;
    sorted.forEach((s, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const sx = side + ((cols - inRow) * cw) / 2 + c * cw + cw / 2;
      const sy = top + r * ch + (ch - labelH) / 2;
      const k = fitIn(s, cw, ch);
      const w = this.viewportToWorkspace(sx, sy);
      this.exposeSlots.set(s.id, { cx: w.x, cy: w.y, s: k / this.viewZoom, title: s.title ?? '', index: i });
    });
  }

  /** Lay the open desktop grid out again for the current screen. */
  private relayoutExpose(): void {
    const wins = this.exposeCandidates();
    if (wins.length > 0) this.layoutExpose(wins);
  }

  /**
   * While Exposé is open, keep the grid in step with the windows (render,
   * phone and desktop): a window that opens, closes, hides or shows lays the
   * grid out again. Every window glides from where it is to its new slot; a
   * newcomer flies in from its own rect (arcing toward the viewer on the
   * desktop); a closed one folds away in its old slot (its close ghost rides
   * the slot frame it was last drawn in). No window left: Exposé closes.
   */
  private syncExposeMembers(now: number): boolean {
    if (this.mobileView !== MobileViewState.EXPOSE) return false;
    const wins = this.exposeCandidates();
    if (wins.length === this.exposeMembers.size && wins.every((w) => this.exposeMembers.has(w.id))) return false;
    if (wins.length === 0) {
      this.exitExpose();
      return true;
    }
    const from = new Map<string, { cx: number; cy: number; s: number }>();
    for (const [id, slot] of this.exposeSlots) from.set(id, this.exposeSlotNow(slot, now));
    this.layoutExpose(wins);
    for (const [id, slot] of this.exposeSlots) {
      const r = this.surfaces.get(id)!.rect;
      slot.from = from.get(id) ?? { cx: r.x + r.width / 2, cy: r.y + r.height / 2, s: 1 };
      slot.joining = !from.has(id);
      slot.moveStart = now;
    }
    if (this.exposeSelected && !this.exposeSlots.has(this.exposeSelected)) this.exposeSelected = this.exposeOrder()[0];
    return true;
  }

  /**
   * A slot where it is right now: gliding from its previous place after a
   * re-layout (EMPHASIZE over one flight), else at rest. z is the newcomer's
   * arc toward the viewer on the desktop.
   */
  private exposeSlotNow(slot: ExposeSlot, now: number): { cx: number; cy: number; s: number; z: number } {
    const f = slot.from;
    if (!f || slot.moveStart === undefined) return { cx: slot.cx, cy: slot.cy, s: slot.s, z: 0 };
    const k = Math.min(1, Math.max(0, (now - slot.moveStart) / Compositor.EXPOSE_FLIGHT_MS));
    if (k >= 1) return { cx: slot.cx, cy: slot.cy, s: slot.s, z: 0 };
    const e = cubicBezier(EMPHASIZE, k);
    return {
      cx: f.cx + (slot.cx - f.cx) * e,
      cy: f.cy + (slot.cy - f.cy) * e,
      s: f.s + (slot.s - f.s) * e,
      z: slot.joining && !this.mobileMode ? Math.sin(Math.PI * e) * Compositor.EXPOSE_ARC : 0,
    };
  }

  /**
   * Run the spread toward `to` (1 = into the grid, 0 = home). The phone flies
   * every window together; the desktop staggers them in reading order along
   * the linear progress (see exposeLocalT), so the whole run is longer.
   */
  private animateExpose(to: number, done?: () => void): void {
    const duration = this.mobileMode
      ? Compositor.MOBILE_FLIGHT_MS
      : Compositor.EXPOSE_FLIGHT_MS * (1 + Compositor.EXPOSE_STAGGER);
    this.exposeAnim = { from: this.exposeT, to, pFrom: this.exposeP, start: performance.now(), duration, done };
    this.needsRender = true;
  }

  /**
   * How far one window is along its flight (0 at its rect, 1 in its slot).
   * The phone moves every window with the scrim; the desktop starts each a
   * little after the one before it in reading order (and on the way home
   * the last one leaves first), each flight eased on its own.
   */
  private exposeLocalT(index: number): number {
    const n = this.exposeCount;
    if (this.mobileMode || n <= 1) return this.exposeT;
    const S = Compositor.EXPOSE_STAGGER;
    const q = Math.max(0, Math.min(1, this.exposeP * (1 + S) - (S * Math.min(index, n - 1)) / (n - 1)));
    return cubicBezier(EMPHASIZE, q);
  }

  /** A slot's vertical screen offset: the finger's lift, or a flick flying it off the top. */
  private exposeOffset(id: string): number {
    const fly = this.exposeFlyOff.get(id);
    if (fly) {
      const t = Math.min(1, (performance.now() - fly.start) / 240);
      return fly.from + (-(this.height + 200) - fly.from) * cubicBezier(ACCELERATE, t);
    }
    return this.exposeLift.get(id) ?? 0;
  }

  /**
   * Exposé pose of a window (renderDesktop): a frame carrying it from its
   * rect toward its grid slot, scaled, plus the window camera over that
   * spot. Undefined when Exposé is closed or the window has no slot.
   */
  private exposeView(surface: Surface, state: SurfaceGlState): { frame: Mat4; cam: SceneCamera } | undefined {
    if (this.exposeT <= 0) return undefined;
    const p = this.exposePose(surface);
    if (!p) return undefined;
    const z = p.z + p.s * (state.lift + (state.userZ ?? 0));
    return { frame: mat4TRS(p.cx, p.cy, p.z, 0, 0, 0, p.s, p.s, p.s), cam: this.windowCamera(p.cx, p.cy, z) };
  }

  /**
   * Where Exposé has a window right now: workspace centre and scale, and on
   * the desktop a hop toward the viewer mid-flight (z, 0 at rest) and the
   * selection's scale-up.
   */
  private exposePose(surface: Surface): { cx: number; cy: number; s: number; z: number } | undefined {
    const slot = this.exposeSlots.get(surface.id);
    if (!slot) return undefined;
    const t = this.exposeLocalT(slot.index);
    const at = this.exposeSlotNow(slot, performance.now());
    const rx = surface.rect.x + surface.rect.width / 2;
    const ry = surface.rect.y + surface.rect.height / 2;
    const hot = this.mobileMode ? 0 : (this.exposeHot.get(surface.id) ?? 0) * t;
    return {
      cx: rx + (at.cx - rx) * t,
      cy: ry + (at.cy - ry) * t + this.exposeOffset(surface.id) / this.viewZoom,
      s: (1 + (at.s - 1) * t) * (1 + Compositor.EXPOSE_HOT_SCALE * hot),
      z: (this.mobileMode ? 0 : Math.sin(Math.PI * t) * Compositor.EXPOSE_ARC) + at.z * t,
    };
  }

  /** A window's Exposé rect on screen (px), from its current pose. */
  private exposeScreenRect(surface: Surface): Rect | undefined {
    const p = this.exposePose(surface);
    if (!p) return undefined;
    const c = this.workspaceToViewport(p.cx, p.cy);
    const w = surface.rect.width * p.s * this.viewZoom;
    const h = surface.rect.height * p.s * this.viewZoom;
    return { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
  }

  /**
   * Whether a window lies wholly outside the phone camera's view, with room
   * for pop-outs (half its larger side, as popoutsCovered reaches). Windows
   * riding a node, pinned to the screen, Exposé, and running slab effects
   * always draw.
   */
  private mobileOffCamera(surface: Surface, state: SurfaceGlState): boolean {
    if (this.exposeT > 0 || state.attach || state.effects?.length || this.pinnable(surface)) return false;
    const { x, y, width, height } = surface.rect;
    const reach = Math.max(width, height) / 2;
    const z = this.viewZoom;
    const vx0 = this.scrollX, vy0 = this.scrollY;
    const vx1 = vx0 + this.width / z, vy1 = vy0 + this.height / z;
    return x + width + reach < vx0 || x - reach > vx1 || y + height + reach < vy0 || y - reach > vy1;
  }

  // ── Windows pinned to the screen (screenAnchor) ──────────────────────
  // On the phone's zoomable camera a window with a screenAnchor stays at
  // that spot of the screen, at a readable scale (its own px size, shrunk
  // only to fit), while the camera pans and zooms. It keeps its rect: it is
  // drawn and picked at that rect through its own ScreenView (windowCamera),
  // so slab effects, its 3D subtree and input all agree. Windows pinned to
  // the same anchor move as one block (their bounding box is what is
  // anchored), so a stack of toasts stays a stack. The desktop ignores
  // anchors: pinView is undefined there and nothing changes.

  /** Screen px kept between a pinned block and the screen edges. */
  private static readonly PIN_MARGIN = 12;

  /** Whether a window is pinned to the screen right now (the phone camera, not riding a node). */
  isScreenPinned(surfaceId: string): boolean {
    const s = this.surfaces.get(surfaceId);
    return !!s && this.pinnable(s);
  }

  private pinnable(s: Surface): boolean {
    return this.mobileMode && s.screenAnchor !== undefined && !this.surfaceGl.get(s.id)?.attach;
  }

  /**
   * The screen view a pinned window is drawn and picked through: the camera
   * the phone would have if it showed the window's anchored block at scale
   * k, placed at its anchor (clear of the gesture handle and any keyboard
   * at the bottom). Undefined for a window that is not pinned.
   */
  private pinView(surface: Surface): ScreenView | undefined {
    const anchor = surface.screenAnchor;
    if (!anchor || !this.pinnable(surface)) return undefined;
    // The block: this window and every shown window pinned to the same anchor.
    let x0 = surface.rect.x, y0 = surface.rect.y;
    let x1 = x0 + surface.rect.width, y1 = y0 + surface.rect.height;
    for (const s of this.sortedSurfaces) {
      if (s === surface || s.screenAnchor !== anchor || !s.visible || !s.drawn
          || this.isWorkspaceFiltered(s) || !this.pinnable(s)) continue;
      x0 = Math.min(x0, s.rect.x);
      y0 = Math.min(y0, s.rect.y);
      x1 = Math.max(x1, s.rect.x + s.rect.width);
      y1 = Math.max(y1, s.rect.y + s.rect.height);
    }
    const m = Compositor.PIN_MARGIN;
    const W = Math.max(1, this.width);
    const bottom = Math.max(1, this.height - Math.max(Compositor.MOBILE_GESTURE_HANDLE_HEIGHT, this.mobileBottomInset));
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    const k = Math.max(0.05, Math.min(1, (W - 2 * m) / bw, (bottom - 2 * m) / bh));
    const sx0 = anchor.includes('left') ? m
      : anchor.includes('right') ? W - m - bw * k
      : (W - bw * k) / 2;
    const sy0 = anchor.startsWith('top') ? m
      : anchor.startsWith('bottom') ? bottom - m - bh * k
      : (bottom - bh * k) / 2;
    // screen = (workspace - scroll) * k puts the block's corner (x0, y0) at (sx0, sy0).
    return { zoom: k, scrollX: x0 - sx0 / k, scrollY: y0 - sy0 / k };
  }

  /**
   * What Exposé leaves in place, then the scrim over it: stacked and front
   * world objects stay where they are (behind the scrim with the back layer,
   * receding with the rest of the desktop), so only the spread windows and
   * the desktop's rails draw above it.
   */
  private drawExposeUnderlay(order: DesktopItem[]): void {
    for (const item of order) {
      if (item.kind !== 'stack') continue;
      this.renderer.clearDepth();
      this.drawNodeTree(item.key, mat4Identity(), this.globalCamera(), 'stack', undefined, undefined, undefined, { rootId: item.rootId });
    }
    this.renderer.clearDepth();
    this.drawWorldNodes('front');
    this.drawExposeBackdrop();
  }

  /** A full-screen scrim behind the spread windows. */
  private drawExposeBackdrop(): void {
    const W = this.width;
    const H = this.height;
    const c = this.viewportToWorkspace(W / 2, H / 2);
    const model = mat4TRS(c.x, c.y, -4, 0, 0, 0, (W / this.viewZoom) * 1.2, (H / this.viewZoom) * 1.2, 1);
    const ink = parseCssColor(this.sceneColor('windowBg', '#0d0d14'));
    this.renderer.context.disable(this.renderer.context.DEPTH_TEST);
    this.renderer.drawFlat(model, this.viewProj, { ...ink, a: 0.78 * this.exposeT });
  }

  /**
   * Window titles under the Exposé slots. On the desktop the titles rest in
   * the secondary ink and the selected window's sits on an accent chip (the
   * hand's colour), under a one-line key hint.
   */
  private drawExposeLabels(ctx: OffscreenCanvasRenderingContext2D): void {
    const desk = !this.mobileMode;
    const display = this.sceneTheme?.fonts?.display ?? '"Oswald", sans-serif';
    ctx.globalAlpha = Math.max(0, Math.min(1, this.exposeT));
    ctx.font = `600 ${desk ? 13 : 12}px ${display}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const rest = this.sceneColor(desk ? 'textSecondary' : 'textPrimary', desk ? '#a8a292' : '#e8e2d0');
    for (const [id, slot] of this.exposeSlots) {
      const s = this.surfaces.get(id);
      const r = s && s.visible ? this.exposeScreenRect(s) : undefined;
      if (!r || r.y + r.height < 0) continue;
      const label = ((s?.title || slot.title) || id.slice(0, 12)).slice(0, 26).toLocaleUpperCase();
      const x = r.x + r.width / 2;
      const y = r.y + r.height + (desk ? 15 : 6);
      const maxW = Math.max(40, r.width + 8);
      if (desk && id === this.exposeSelected) {
        const w = Math.min(maxW, ctx.measureText(label).width) + 18;
        ctx.fillStyle = this.sceneColor('accent', '#d32f22');
        ctx.fillRect(x - w / 2, y - 4, w, 22);
        ctx.fillStyle = this.sceneColor('windowBg', '#0d0d14');
      } else {
        ctx.fillStyle = rest;
      }
      ctx.fillText(label, x, y, maxW);
    }
    if (desk) {
      const area = this.exposeDesktopArea();
      const n = this.exposeSlots.size;
      ctx.font = `500 11px ${display}`;
      ctx.fillStyle = rest;
      const hint = `${n} ${n === 1 ? 'WINDOW' : 'WINDOWS'}  ·  ARROWS OR TAB SELECT  ·  ENTER OPENS  ·  ESC RETURNS`;
      ctx.fillText(hint, area.x + area.width / 2, Math.max(8, area.y - 34), area.width);
    }
    ctx.globalAlpha = 1;
  }

  /** The desktop's 2D chrome while Exposé shows: the titles and the key hint. */
  private renderExposeOverlay(): void {
    const ctx = this.overlay.begin();
    this.overlay.markContent();
    this.drawExposeLabels(ctx);
  }

  /**
   * Find surface at a point. Desktop picking casts a ray through the camera
   * and intersects each slab's plane in its local space (so lifted/tilted
   * windows pick exactly), then keeps the existing per-pixel alpha test so
   * transparent pixels pass clicks through.
   */
  surfaceAt(x: number, y: number): Surface | undefined {
    // Exposé windows are picked as grid slots (exposeAt), not as windows; the
    // desktop's rails stay live over the scrim (desktopHitTest keeps only them).
    if (this.exposeT > 0 && this.mobileMode) return undefined;
    return this.desktopHitTest(x, y);
  }

  /**
   * Convert a viewport (x,y) point to workspace coords (on the z=0 plane,
   * through the phone's view zoom). Needed by callers that do their own rect
   * math (e.g., drag-resize hit tests).
   */
  viewportToWorkspace(x: number, y: number): { x: number; y: number } {
    if (this.viewZoom === 1) return { x: x + this.scrollX, y: y + this.scrollY };
    return { x: x / this.viewZoom + this.scrollX, y: y / this.viewZoom + this.scrollY };
  }

  /** Workspace coords (z=0 plane) to viewport px: the inverse of viewportToWorkspace. */
  workspaceToViewport(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.scrollX) * this.viewZoom, y: (y - this.scrollY) * this.viewZoom };
  }

  /** The view scale (1 on the desktop; the phone camera's zoom). */
  getViewZoom(): number {
    return this.viewZoom;
  }

  // ── One desktop scene: depth order, windows riding nodes, pop-outs ────

  /**
   * The desktop's back-to-front order: visible windows of the active
   * workspace and stacked world roots (layer 'stack'), by zIndex. At equal
   * zIndex a window draws above a stacked object. A stacked root without a
   * zIndex (the backend stamps one on add) sits just above the windows. A
   * window riding a node in another window's scene draws after its host.
   */
  private desktopOrder(): DesktopItem[] {
    const items: DesktopItem[] = [];
    let topWindow = 0;
    for (const s of this.sortedSurfaces) {
      if (!s.visible || !s.drawn || this.isWorkspaceFiltered(s)) continue;
      let z = s.zIndex;
      const a = this.surfaceGl.get(s.id)?.attach;
      if (a?.scope === 'window' && a.surfaceId) {
        const host = this.surfaces.get(a.surfaceId);
        if (host && host.zIndex >= z) z = host.zIndex + 0.25;
      }
      items.push({ kind: 'surface', surface: s, z });
      if (s.zIndex < RAIL_Z_THRESHOLD && s.zIndex > topWindow) topWindow = s.zIndex;
    }
    for (const key of this.worldKeys) {
      for (const node of this.sceneStore.nodesForSurface(key)) {
        if (node.params.layer !== 'stack' || this.sceneStore.parentOf(node)) continue;
        const zi = node.params.zIndex;
        const z = typeof zi === 'number' ? Math.min(zi, RAIL_Z_THRESHOLD - 0.01) : topWindow + 0.5;
        items.push({ kind: 'stack', key, rootId: node.id, z });
      }
    }
    // Stable sort: ties keep a stacked object below the window, and windows
    // keep their existing relative order.
    items.sort((a, b) => (a.z - b.z) || ((a.kind === 'stack' ? 0 : 1) - (b.kind === 'stack' ? 0 : 1)));
    return items;
  }

  /**
   * How a window is placed for picking (see WindowView). Mirrors
   * renderDesktop without the transient motion pose, as picking always
   * has. A window riding a node hangs from the node's frame and camera.
   */
  private windowView(surface: Surface, depth = 0): WindowView {
    const state = this.surfaceGl.get(surface.id);
    const { rect } = surface;
    const z = (state?.lift ?? 0) + (state?.userZ ?? 0);
    const rx = (state?.tiltX ?? 0) + (state?.userRotation?.[0] ?? 0);
    const ry = (state?.tiltY ?? 0) + (state?.userRotation?.[1] ?? 0);
    const rz = state?.userRotation?.[2] ?? 0;
    const anchor = state?.attach ? this.anchorView(surface, state, depth) : undefined;
    if (anchor) {
      const frame = mat4Multiply(anchor.frame, mat4TRS(0, 0, z, rx, ry, rz, 1, 1, 1));
      // The slab as last drawn (it moves with its node every frame).
      const slab = state?.attachFrame && state.model
        ? state.model
        : mat4Multiply(frame, mat4TRS(0, 0, 0, 0, 0, 0, rect.width, rect.height, 1));
      return { frame, slab, cam: anchor.cam, free: true, sceneCam: this.cameraFor(surface, anchor.cam, frame) };
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const frame = mat4TRS(cx, cy, z, rx, ry, rz, 1, 1, 1);
    // A window pinned to the screen is seen through its own view (see pinView).
    const pin = this.pinView(surface);
    const cam = this.windowCamera(cx, cy, z, pin);
    return {
      frame,
      slab: state?.model && !state.attachFrame ? state.model : mat4TRS(cx, cy, 0, 0, 0, 0, rect.width, rect.height, 1),
      cam,
      // Its content rect is no longer where the phone camera puts its rect: clip by the projected quad.
      free: !!(rx || ry || rz) || !!pin,
      sceneCam: this.cameraFor(surface, cam, frame),
    };
  }

  /**
   * The frame and camera a window riding a node hangs from: the node's
   * world matrix with its scale taken out (the window keeps its pixel size),
   * moved by the attach offset plus any title-bar drag since attaching.
   * World nodes render through the desktop camera; a node in another
   * window's scene through that window's camera. Undefined when the node
   * is gone (the window then sits at its own rect until detached).
   */
  private anchorView(surface: Surface, state: SurfaceGlState, depth: number): { frame: Mat4; cam: SceneCamera } | undefined {
    const a = state.attach;
    if (!a || depth > 8) return undefined;
    let world: Mat4;
    let cam: SceneCamera;
    if (a.scope === 'world') {
      const node = this.sceneStore.getNode(`world:${a.ownerId}`, a.nodeId);
      if (!node) return undefined;
      world = this.sceneStore.worldMatrix(node, mat4Identity());
      cam = this.globalCamera();
    } else {
      const host = a.surfaceId ? this.surfaces.get(a.surfaceId) : undefined;
      const node = host ? this.sceneStore.getNode(host.id, a.nodeId) : undefined;
      if (!host || !node) return undefined;
      // The host as drawn (it draws first, see desktopOrder), else its resting view.
      const hs = this.surfaceGl.get(host.id);
      const hv = hs?.frame && hs.cam && this.drawnThisFrame.has(host.id)
        ? { frame: hs.frame, cam: hs.cam }
        : this.windowView(host, depth + 1);
      world = this.sceneStore.worldMatrix(node, hv.frame);
      cam = this.cameraFor(host, hv.cam, hv.frame) ?? hv.cam;
    }
    const o = a.offset ?? [0, 0, 0];
    const origin = state.attachOrigin ?? { x: surface.rect.x, y: surface.rect.y };
    const dx = surface.rect.x - origin.x;
    const dy = surface.rect.y - origin.y;
    return { frame: mat4Multiply(mat4StripScale(world), mat4Translation(o[0] + dx, o[1] + dy, o[2])), cam };
  }

  /**
   * Make a window's slab ride a scene node (or stop, with null). `origin`
   * is the surface rect position when the backend attached it, so title-bar
   * drags since then move the window relative to its anchor.
   */
  setSurfaceAttachment(surfaceId: string, target: SurfaceAttachment | null, origin?: { x: number; y: number }): void {
    const state = this.glState(surfaceId);
    if (!target) {
      state.attach = undefined;
      state.attachOrigin = undefined;
      state.attachFrame = undefined;
      state.attachCam = undefined;
    } else {
      const surface = this.surfaces.get(surfaceId);
      state.attach = { ...target };
      state.attachOrigin = origin ?? (surface ? { x: surface.rect.x, y: surface.rect.y } : { x: 0, y: 0 });
    }
    this.needsRender = true;
  }

  /** Whether a window currently rides a scene node. */
  isSurfaceAttached(surfaceId: string): boolean {
    return !!this.surfaceGl.get(surfaceId)?.attach;
  }

  /**
   * Surface-local px of a viewport point on a window riding a node or
   * pinned to the phone's screen (the pointer may be outside it, e.g.
   * mid-drag). Undefined for ordinary windows: callers keep their rect math
   * there.
   */
  attachedSurfaceLocal(surfaceId: string, x: number, y: number): { x: number; y: number } | undefined {
    const surface = this.surfaces.get(surfaceId);
    // Windows pinned to the screen are not where rect math puts them either.
    if (!surface || !(this.surfaceGl.get(surfaceId)?.attach || this.pinnable(surface))) return undefined;
    const v = this.windowView(surface);
    const hit = raySurfacePlane(rayFromScreen(x, y, this.width, this.height, v.cam.invViewProj), v.slab, surface.rect.width, surface.rect.height);
    return hit ? { x: hit.x, y: hit.y } : undefined;
  }

  /** A window's screen rect (projected when it rides a node). */
  private screenRectOf(surface: Surface): { x: number; y: number; width: number; height: number } | undefined {
    const st = this.surfaceGl.get(surface.id);
    if ((st?.attach || this.pinnable(surface)) && st?.model && st.cam) return this.projectedQuadBounds(st.model, st.cam.viewProj);
    return this.zoomViewRect({ x: surface.rect.x - this.scrollX, y: surface.rect.y - this.scrollY, width: surface.rect.width, height: surface.rect.height });
  }

  /**
   * Whether a window's pop-outs may reach under an opaque window above it
   * (its rect grown by half its larger side, a generous reach for pop-out
   * content). Only then do they pay for the deferred, depth-tested pass.
   */
  private popoutsCovered(order: DesktopItem[], index: number, surface: Surface): boolean {
    if (this.depthQuad === null) return false; // no depth program: draw inline as before
    const mine = this.screenRectOf(surface);
    if (!mine) return false;
    const reach = Math.max(mine.width, mine.height) / 2;
    const x0 = mine.x - reach, y0 = mine.y - reach;
    const x1 = mine.x + mine.width + reach, y1 = mine.y + mine.height + reach;
    for (let j = index + 1; j < order.length; j++) {
      const it = order[j];
      if (it.kind !== 'surface' || it.surface.transparent) continue;
      const r = this.screenRectOf(it.surface);
      if (r && r.x < x1 && r.x + r.width > x0 && r.y < y1 && r.y + r.height > y0) return true;
    }
    return false;
  }

  /**
   * Pop-outs of a window that higher windows cover, drawn after every
   * window: first this window's own clipped 3D goes into a fresh depth
   * buffer (so pop-outs keep their usual stacking against it), then the
   * slabs of every opaque window above, then the pop-outs, depth-tested
   * against both. Near parts show over the higher windows; parts behind a
   * higher window's plane hide behind it.
   */
  private drawDeferredPopouts(
    d: { surface: Surface; frame: Mat4; cam: SceneCamera; index: number },
    order: DesktopItem[],
  ): void {
    const gl = this.renderer.context;
    this.renderer.clearDepth();
    gl.colorMask(false, false, false, false);
    this.drawVocabNodes(d.surface, d.frame, 'occluded', d.cam, false, true);
    // (a tilted window's stencil clip used the stencil buffer: start it clean)
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    for (let j = d.index + 1; j < order.length; j++) {
      const it = order[j];
      if (it.kind !== 'surface' || it.surface.transparent) continue;
      const st = this.surfaceGl.get(it.surface.id);
      if (!st?.cam || !this.drawnThisFrame.has(it.surface.id)) continue;
      this.writeSlabDepth(st.model, st.cam.viewProj);
    }
    gl.colorMask(true, true, true, true);
    this.drawVocabNodes(d.surface, d.frame, 'overlay', d.cam, false, false, true);
  }

  /**
   * Write a slab's unit quad into the depth buffer (colour writes are masked
   * by the caller) and mark it 1 in the stencil buffer whatever the depth,
   * so depthless pop-outs (canvas layers) can stay under covering windows.
   */
  private writeSlabDepth(model: Mat4, viewProj: Mat4): void {
    const gl = this.renderer.context;
    if (this.depthQuad === undefined) this.depthQuad = this.buildDepthQuad(gl);
    const dq = this.depthQuad;
    if (!dq) return;
    gl.useProgram(dq.program);
    gl.uniformMatrix4fv(dq.uModel, false, model);
    gl.uniformMatrix4fv(dq.uViewProj, false, viewProj);
    gl.bindVertexArray(dq.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.REPLACE, gl.REPLACE);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  /**
   * A tiny depth-only quad program (own VAO, attribute 0). A compile or link
   * failure is recorded as null once: pop-outs then draw inline as before.
   */
  private buildDepthQuad(gl: WebGL2RenderingContext): NonNullable<Compositor['depthQuad']> | null {
    try {
      const compile = (type: number, src: string): WebGLShader => {
        const sh = gl.createShader(type);
        if (!sh) throw new Error('createShader failed');
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'compile failed');
        return sh;
      };
      const program = gl.createProgram();
      if (!program) throw new Error('createProgram failed');
      gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aPos;
uniform mat4 uModel;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * uModel * vec4(aPos, 0.0, 1.0); }`));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      if (!vao || !buf) throw new Error('buffer allocation failed');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      return { program, uModel: gl.getUniformLocation(program, 'uModel'), uViewProj: gl.getUniformLocation(program, 'uViewProj'), vao };
    } catch (err) {
      console.error('[Compositor] pop-out depth program unavailable; pop-outs draw inline', err);
      this.onDiagnostic?.('popout-depth', String(err));
      return null;
    }
  }

  // ── Node dragging (client-side; mouse and touch drive the same calls) ──

  /** The scene node behind a hit, when it still exists. */
  private nodeOfHit(hit: NodeHit): VocabNode | undefined {
    const key = hit.scope === 'world' ? `world:${hit.ownerId}` : hit.surfaceId;
    return key ? this.sceneStore.getNode(key, hit.nodeId) : undefined;
  }

  /**
   * CSS cursor for hovering a node: its (or its nearest ancestor's) `cursor`
   * param, else 'grab' inside a draggable node, else 'pointer'.
   */
  nodeCursor(hit: NodeHit): string {
    const node = this.nodeOfHit(hit);
    if (!node) return 'pointer';
    const own = this.sceneStore.findUp(node, (p) => typeof p.cursor === 'string');
    if (own) return own.params.cursor as string;
    return this.sceneStore.findUp(node, (p) => parseDraggable(p.draggable) !== undefined) ? 'grab' : 'pointer';
  }

  /** Whether pressing this node takes keyboard focus exclusively (`focusable` on it or an ancestor). */
  nodeFocusable(hit: NodeHit): boolean {
    const node = this.nodeOfHit(hit);
    return !!node && this.sceneStore.findUp(node, (p) => p.focusable === true) !== undefined;
  }

  /**
   * A press on a stacked world object that raises (raiseOnClick or
   * draggable on the pressed node or an ancestor) brings its root to the top
   * of the window order, below the system rails. Applied locally at once;
   * returns the root to report to the backend (which decides for everyone),
   * or undefined when nothing needs raising.
   */
  raiseStackedNode(hit: NodeHit): { ownerId: string; nodeId: string } | undefined {
    if (hit.scope !== 'world' || !hit.ownerId) return undefined;
    const pressed = this.nodeOfHit(hit);
    if (!pressed) return undefined;
    const root = this.sceneStore.rootOf(pressed);
    if (root.params.layer !== 'stack') return undefined;
    if (!this.sceneStore.findUp(pressed, (p) => p.raiseOnClick === true || parseDraggable(p.draggable) !== undefined)) return undefined;
    let top = 0;
    for (const item of this.desktopOrder()) {
      if (item.kind === 'stack' && item.rootId === root.id && item.key === `world:${hit.ownerId}`) continue;
      const z = item.kind === 'surface' ? item.surface.zIndex : item.z;
      if (z < RAIL_Z_THRESHOLD && z > top) top = z;
    }
    const cur = root.params.zIndex;
    if (typeof cur === 'number' && cur > top) return undefined; // already frontmost
    root.params = { ...root.params, zIndex: Math.min(top + 0.5, RAIL_Z_THRESHOLD - 0.01) };
    this.needsRender = true;
    return { ownerId: hit.ownerId, nodeId: root.id };
  }

  /** Whether a pointer-held node drag is in progress (not an inertia glide). */
  get nodeDragActive(): boolean {
    return !!this.nodeDrag && !this.nodeDrag.released;
  }

  /**
   * Press on a draggable node at a viewport point. Finds the nearest
   * ancestor-or-self of the pressed node that declares `draggable`, and sets
   * up the drag in that node's PARENT space through the camera the node
   * renders with (window camera or desktop camera). Returns the drag target
   * (as a 'start' event, not yet emitted: onNodeDrag reports 'start' once the
   * pointer actually moves), or undefined when nothing draggable is there.
   */
  beginNodeDrag(x: number, y: number, time?: number): NodeDragEvent | undefined {
    // A glide in flight (or a release that never arrived) ends first.
    if (this.nodeDrag) this.finishNodeDrag();
    const pick = this.pickNode(x, y);
    if (!pick) return undefined;
    const pressed = this.sceneStore.getNode(pick.key, pick.nodeId);
    if (!pressed) return undefined;
    const target = this.sceneStore.findUp(pressed, (p) => parseDraggable(p.draggable) !== undefined);
    if (!target) return undefined;
    const spec = parseDraggable(target.params.draggable)!;
    const P = this.sceneStore.parentMatrix(target, pick.frame);
    const Pinv = mat4Invert(P);
    const hitWorld = vec3Add(pick.ray.origin, vec3Scale(pick.ray.dir, pick.t));
    const anchor = mat4TransformPoint(Pinv, hitWorld);
    const X = vec3(1, 0, 0), Y = vec3(0, 1, 0), Z = vec3(0, 0, 1);
    const basis: [Vec3, Vec3] = spec.plane === 'xz' ? [X, Z] : spec.plane === 'yz' ? [Y, Z] : [X, Y];
    const normal = spec.plane === 'xz' ? Y : spec.plane === 'yz' ? X : Z;
    const p0 = target.transform.position ?? [0, 0, 0];
    const startPos: [number, number, number] = [p0[0], p0[1], p0[2]];
    const session: NodeDragSession = {
      hit: { scope: pick.scope, surfaceId: pick.surfaceId, ownerId: pick.ownerId, nodeId: pick.nodeId },
      key: pick.key, nodeId: target.id, hitNodeId: pressed.id, spec,
      startX: x, startY: y, startPos, anchor, normal, basis,
      started: false, released: false,
      pos: [...startPos] as [number, number, number], vel: [0, 0, 0], lastT: time ?? performance.now(),
    };
    if (spec.axis) {
      // One axis: solve the pointer delta along the axis's screen direction.
      const axis = spec.axis === 'x' ? X : spec.axis === 'y' ? Y : Z;
      session.axis = axis;
      let j = this.screenStep(P, anchor, axis, pick.cam);
      if (Math.hypot(j.x, j.y) < 0.2) j = { x: 0, y: this.towardCamera(P, anchor, axis, pick.cam) ? 1 : -1 };
      session.screen = { j1: j, j2: { x: 0, y: 0 } };
    } else {
      // A plane seen nearly edge-on turns a ray-plane hit into a runaway;
      // solve such drags on screen instead (pointer down = toward the viewer).
      const wn = vec3Normalize(vec3Cross(mat4TransformDir(P, basis[0]), mat4TransformDir(P, basis[1])));
      if (Math.abs(vec3Dot(vec3Normalize(pick.ray.dir), wn)) < 0.35) {
        session.screen = this.planeScreenBasis(P, anchor, basis, pick.cam);
      }
    }
    this.stopPositionAnims(pick.key, target.id);
    this.nodeDrag = session;
    return this.dragEvent(session, 'start');
  }

  /**
   * Follow the pointer (viewport px). Moves the node in the local scene at
   * once. `time` is the input event's timestamp (performance.now() clock;
   * default now): flick speed is measured between events, not handlers.
   */
  updateNodeDrag(x: number, y: number, time?: number): void {
    const s = this.nodeDrag;
    if (!s || s.released) return;
    if (!s.started) {
      if (Math.hypot(x - s.startX, y - s.startY) < Compositor.DRAG_THRESHOLD_PX) return;
      s.started = true;
      this.emitDrag(s, 'start');
    }
    const node = this.sceneStore.getNode(s.key, s.nodeId);
    if (!node) { this.finishNodeDrag(); return; }
    let delta: Vec3 | undefined;
    if (s.screen) {
      const mx = x - s.startX, my = y - s.startY;
      const { j1, j2 } = s.screen;
      if (s.axis) {
        const a = (mx * j1.x + my * j1.y) / Math.max(1e-6, j1.x * j1.x + j1.y * j1.y);
        delta = vec3Scale(s.axis, a);
      } else {
        const det = j1.x * j2.y - j2.x * j1.y;
        if (Math.abs(det) < 1e-9) return;
        const a = (mx * j2.y - my * j2.x) / det;
        const b = (j1.x * my - j1.y * mx) / det;
        delta = vec3Add(vec3Scale(s.basis[0], a), vec3Scale(s.basis[1], b));
      }
    } else {
      const view = this.dragView(s);
      if (!view) return;
      const Pinv = mat4Invert(this.sceneStore.parentMatrix(node, view.frame));
      const ray = rayFromScreen(x, y, this.width, this.height, view.cam.invViewProj);
      const o = mat4TransformPoint(Pinv, ray.origin);
      const d = mat4TransformDir(Pinv, ray.dir);
      const t = rayPlaneT(o, d, s.anchor, s.normal);
      if (t === null) return;
      delta = vec3Sub(vec3Add(o, vec3Scale(d, t)), s.anchor);
      if (vec3Length(delta) > 1e5) return; // near the horizon: ignore the runaway
    }
    const next = this.constrainDrag(s, [s.startPos[0] + delta.x, s.startPos[1] + delta.y, s.startPos[2] + delta.z], true);
    const now = time ?? performance.now();
    const dt = (now - s.lastT) / 1000;
    if (dt > 0.001) {
      for (let i = 0; i < 3; i++) s.vel[i] = s.vel[i] * 0.4 + ((next[i] - s.pos[i]) / dt) * 0.6;
      s.lastT = now;
    }
    s.pos = next;
    this.writeDragPos(node, next, s.key);
    this.emitDrag(s, 'move');
  }

  /**
   * Release. A drag that never moved ends silently (it was a click). With
   * `inertia` and a flick, the node glides (render loop) and 'end' follows
   * when it settles; otherwise 'end' fires now.
   */
  endNodeDrag(time?: number): void {
    const s = this.nodeDrag;
    if (!s || s.released) return;
    if (!s.started) { this.nodeDrag = undefined; return; }
    const now = time ?? performance.now();
    // A flick: the pointer was still moving when released (event times, so a
    // busy frame between the last move and the release does not count).
    if (s.spec.inertia && now - s.lastT < 100 && Math.hypot(s.vel[0], s.vel[1], s.vel[2]) > 60) {
      s.released = true;
      s.lastT = performance.now();
      this.needsRender = true;
      return;
    }
    this.finishNodeDrag();
  }

  /** End the session: final snap and clamp, then report 'end'. */
  private finishNodeDrag(): void {
    const s = this.nodeDrag;
    if (!s) return;
    this.nodeDrag = undefined;
    if (!s.started) return;
    const node = this.sceneStore.getNode(s.key, s.nodeId);
    if (node) {
      s.pos = this.constrainDrag(s, s.pos, true);
      this.writeDragPos(node, s.pos, s.key);
    }
    this.emitDrag(s, 'end');
  }

  /** One inertia frame (friction decay, bounds stop the glide). Returns true while gliding. */
  private stepNodeDragInertia(now: number): boolean {
    const s = this.nodeDrag;
    if (!s || !s.released) return false;
    const node = this.sceneStore.getNode(s.key, s.nodeId);
    if (!node) { this.finishNodeDrag(); return false; }
    const dt = Math.min(0.05, Math.max(0, (now - s.lastT) / 1000));
    s.lastT = now;
    const decay = Math.exp(-Compositor.DRAG_FRICTION * dt);
    for (let i = 0; i < 3; i++) s.vel[i] *= decay;
    const raw: [number, number, number] = [s.pos[0] + s.vel[0] * dt, s.pos[1] + s.vel[1] * dt, s.pos[2] + s.vel[2] * dt];
    const next = this.constrainDrag(s, raw, false);
    for (let i = 0; i < 3; i++) if (next[i] !== raw[i]) s.vel[i] = 0;
    s.pos = next;
    this.writeDragPos(node, next, s.key);
    if (Math.hypot(s.vel[0], s.vel[1], s.vel[2]) < 12) {
      this.finishNodeDrag();
      return false;
    }
    this.emitDrag(s, 'move');
    return true;
  }

  /** Apply snap (on the plane or axis being dragged) and bounds to a position. */
  private constrainDrag(s: NodeDragSession, p: [number, number, number], snap: boolean): [number, number, number] {
    const out: [number, number, number] = [p[0], p[1], p[2]];
    const g = s.spec.snap;
    if (snap && g) {
      const moving = s.axis ? [s.axis] : s.basis;
      for (const ax of moving) {
        // Snap to the grid itself (multiples of `snap` in the parent space).
        const i = ax.x ? 0 : ax.y ? 1 : 2;
        out[i] = Math.round(out[i] / g) * g;
      }
    }
    const b = s.spec.bounds;
    if (b) for (let i = 0; i < 3; i++) out[i] = Math.max(b.min[i], Math.min(b.max[i], out[i]));
    return out;
  }

  /** Move the dragged node locally (no round trip) and wake the renderer if it shows. */
  private writeDragPos(node: VocabNode, pos: [number, number, number], key: string): void {
    node.transform = { ...node.transform, position: [pos[0], pos[1], pos[2]] };
    if (this.isSurfaceKeyRenderable(key)) this.needsRender = true;
  }

  /** The frame and camera the dragged node's tree is seen through right now. */
  private dragView(s: NodeDragSession): { frame: Mat4; cam: SceneCamera } | undefined {
    if (s.hit.scope === 'world') {
      this.clampScroll();
      this.updateCamera(this.scrollX, this.scrollY);
      return { frame: mat4Identity(), cam: this.globalCamera() };
    }
    const surface = s.hit.surfaceId ? this.surfaces.get(s.hit.surfaceId) : undefined;
    if (!surface) return undefined;
    const v = this.windowView(surface);
    // A pop-out moves under the window camera it draws with (see drawVocabNodes).
    const pressed = this.sceneStore.getNode(s.key, s.hitNodeId);
    const popout = !!pressed && clipModeOf(this.sceneStore.resolveParams(pressed)) === 'none';
    return { frame: v.frame, cam: popout ? v.cam : (v.sceneCam ?? v.cam) };
  }

  /** Screen px moved per parent unit along `dir` at `anchor` (parent space). */
  private screenStep(P: Mat4, anchor: Vec3, dir: Vec3, cam: SceneCamera): { x: number; y: number } {
    const a = projectToScreen(cam.viewProj, mat4TransformPoint(P, anchor), this.width, this.height);
    const b = projectToScreen(cam.viewProj, mat4TransformPoint(P, vec3Add(anchor, dir)), this.width, this.height);
    return a && b ? { x: b.x - a.x, y: b.y - a.y } : { x: 0, y: 0 };
  }

  /** Whether a parent-space direction at `anchor` points toward the camera. */
  private towardCamera(P: Mat4, anchor: Vec3, dir: Vec3, cam: SceneCamera): boolean {
    const w = mat4TransformPoint(P, anchor);
    const toCam = vec3Sub(vec3(cam.cameraPos[0], cam.cameraPos[1], cam.cameraPos[2]), w);
    return vec3Dot(mat4TransformDir(P, dir), toCam) > 0;
  }

  /**
   * Screen steps for a plane drag seen nearly edge-on. An in-plane axis that
   * points into the screen (no visible screen motion) gets the direction at
   * right angles to the other one, at its scale: pointer down moves it
   * toward the viewer, like a floor seen from above.
   */
  private planeScreenBasis(P: Mat4, anchor: Vec3, basis: [Vec3, Vec3], cam: SceneCamera): { j1: { x: number; y: number }; j2: { x: number; y: number } } {
    const j = [this.screenStep(P, anchor, basis[0], cam), this.screenStep(P, anchor, basis[1], cam)];
    const len = j.map((v) => Math.hypot(v.x, v.y));
    const big = Math.max(len[0], len[1], 1e-6);
    for (let i = 0; i < 2; i++) {
      if (len[i] >= 0.25 * big) continue;
      const other = j[1 - i];
      const toward = this.towardCamera(P, anchor, basis[i], cam);
      let c = len[1 - i] > 1e-6 ? { x: -other.y, y: other.x } : { x: 0, y: 1 };
      const mostlyVertical = Math.abs(c.y) >= Math.abs(c.x);
      const positive = mostlyVertical ? c.y > 0 : c.x > 0;
      if (positive !== toward) c = { x: -c.x, y: -c.y };
      const cl = Math.hypot(c.x, c.y) || 1;
      j[i] = { x: (c.x / cl) * big, y: (c.y / cl) * big };
    }
    return { j1: j[0], j2: j[1] };
  }

  /** Drop position-writing animations on a node the hand now moves. */
  private stopPositionAnims(key: string, nodeId: string): void {
    const fullKey = `${key}/${nodeId}`;
    const entry = this.nodeAnims.get(fullKey);
    if (!entry) return;
    entry.anims = entry.anims.filter((a) => a.channel !== 'position' && a.channel !== 'orbit');
    if (entry.anims.length === 0) this.nodeAnims.delete(fullKey);
  }

  private dragEvent(s: NodeDragSession, phase: NodeDragEvent['phase']): NodeDragEvent {
    return {
      phase,
      scope: s.hit.scope,
      surfaceId: s.hit.surfaceId,
      ownerId: s.hit.ownerId,
      nodeId: s.nodeId,
      hitNodeId: s.hitNodeId,
      position: [s.pos[0], s.pos[1], s.pos[2]],
    };
  }

  private emitDrag(s: NodeDragSession, phase: NodeDragEvent['phase']): void {
    try {
      this.onNodeDrag?.(this.dragEvent(s, phase));
    } catch (err) {
      console.error('[Compositor] onNodeDrag listener failed:', err);
    }
  }

  /**
   * The picking ray for a surface's SLAB — through the same window camera
   * the slab renders with (see the render loop). Identical to the desktop
   * ray for an untransformed slab; diverges exactly when the slab is tilted,
   * which is when picking through the wrong camera misses.
   */
  private slabRay(surface: Surface, x: number, y: number): Ray {
    const state = this.surfaceGl.get(surface.id);
    // A window riding a node renders through the node's camera.
    if (state?.attach) return rayFromScreen(x, y, this.width, this.height, this.windowView(surface).cam.invViewProj);
    const { rect } = surface;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const z = (state?.lift ?? 0) + (state?.userZ ?? 0);
    return rayFromScreen(x, y, this.width, this.height, this.windowCamera(cx, cy, z, this.pinView(surface)).invViewProj);
  }

  /**
   * Find the topmost interactive scene node at a viewport point, the 3D
   * analogue of widget hit-testing. Returns the node plus its scope so input
   * can route to the owner. See pickNode for the order.
   */
  nodeAt(x: number, y: number): NodeHit | undefined {
    const p = this.pickNode(x, y);
    return p ? { scope: p.scope, surfaceId: p.surfaceId, ownerId: p.ownerId, nodeId: p.nodeId } : undefined;
  }

  /**
   * Picking follows what is drawn:
   * 1. front-layer world nodes;
   * 2. pop-outs (clip 'none'), top window first, except where a covering
   *    slab of a higher window sits in front of them (the deferred pass
   *    depth-tests them the same way);
   * 3. the desktop order top-down: stacked world objects, and for each
   *    window its clipped nodes before its slab (an opaque slab occludes
   *    everything beneath it);
   * 4. back-layer world nodes.
   */
  private pickNode(x: number, y: number): NodePick | undefined {
    if (this.exposeT > 0) return undefined;
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);
    const worldCam = this.globalCamera();
    const ray = rayFromScreen(x, y, this.width, this.height, this.invViewProj);
    const identity = mat4Identity();
    const worldPick = (h: { ownerId: string; nodeId: string; t: number }): NodePick => ({
      scope: 'world', ownerId: h.ownerId, nodeId: h.nodeId,
      key: `world:${h.ownerId}`, ray, t: h.t, cam: worldCam, frame: identity,
    });

    // 1. World nodes above all windows
    const front = this.hitWorldNodes(ray, 'front');
    if (front) return worldPick(front);

    const order = this.desktopOrder();
    const views = new Map<string, WindowView>();
    const viewOf = (s: Surface): WindowView => {
      let v = views.get(s.id);
      if (!v) { v = this.windowView(s); views.set(s.id, v); }
      return v;
    };

    // 2. Pop-outs draw over the windows above their own, unless covered.
    for (let i = order.length - 1; i >= 0; i--) {
      const item = order[i];
      if (item.kind !== 'surface') continue;
      const v = viewOf(item.surface);
      // Pop-outs draw through the window camera, never a camera node (see drawVocabNodes).
      const sceneCam = v.cam;
      const nodeRay = rayFromScreen(x, y, this.width, this.height, sceneCam.invViewProj);
      const hit = this.hitNodeTree(nodeRay, item.surface.id, v.frame, { allow: (m) => m === 'none' });
      if (!hit) continue;
      const hitZ = nodeRay.origin.z + nodeRay.dir.z * hit.t;
      // A canvas pop-out has no depth: any covering window hides it (as drawn).
      const flat = this.sceneStore.getNode(item.surface.id, hit.nodeId)?.kind === 'canvas';
      if (this.popoutHidden(order, i, x, y, flat ? -Infinity : hitZ, viewOf)) continue;
      return {
        scope: 'window', surfaceId: item.surface.id, nodeId: hit.nodeId,
        key: item.surface.id, ray: nodeRay, t: hit.t, cam: sceneCam, frame: v.frame,
      };
    }

    // 3. The desktop order top-down.
    for (let i = order.length - 1; i >= 0; i--) {
      const item = order[i];
      if (item.kind === 'stack') {
        const hit = this.hitNodeTree(ray, item.key, identity, { layer: 'stack', rootId: item.rootId });
        if (hit) return worldPick({ ownerId: item.key.slice('world:'.length), nodeId: hit.nodeId, t: hit.t });
        continue;
      }
      const surface = item.surface;
      const { rect } = surface;
      const v = viewOf(surface);
      // Pick through the SAME camera the subtree was drawn with, or the ray
      // misses everything the off-axis projection moved.
      const nodeRay = rayFromScreen(x, y, this.width, this.height, v.cam.invViewProj);
      // Interaction must be CLIPPED to the window like rendering is. Clipped
      // nodes (the default) are scissored to the content rect when drawn, so a
      // click outside that rect must not hit them either — otherwise a mesh
      // grown large enough to project past its window ray-intercepts clicks
      // ANYWHERE on screen, and since this loop runs top-down it steals every
      // click from every window beneath it (invisible, since the mesh is
      // scissored out of view — the exact "one window eats the whole workspace"
      // bug). clip:'window' nodes reach the title bar; pop-outs were step 2.
      // Tilted (or node-riding) windows clip to the PROJECTED quad (see
      // drawVocabNodes), so picking uses the same region there.
      let inContent: boolean | undefined;
      let inWindow: boolean | undefined;
      const insideContent = (): boolean => inContent ??= v.free
        ? (() => {
            const { model, cw, ch } = this.contentQuadModel(surface, v.frame);
            return !!raySurfaceHit(nodeRay, model, cw, ch);
          })()
        : (() => {
            const c = this.contentClip(surface);
            return x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height;
          })();
      const insideWindow = (): boolean => inWindow ??= v.free
        ? !!raySurfaceHit(nodeRay, mat4Multiply(v.frame, mat4TRS(0, 0, 0, 0, 0, 0, rect.width, rect.height, 1)), rect.width, rect.height)
        : (() => {
            const c = this.windowClip(surface);
            return x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height;
          })();
      // The subtree itself may render through a camera node (cameraFor);
      // the clip region and the slab stay on the window camera.
      const sceneRay = v.sceneCam ? rayFromScreen(x, y, this.width, this.height, v.sceneCam.invViewProj) : nodeRay;
      const hit = this.hitNodeTree(sceneRay, surface.id, v.frame, {
        allow: (m) => (m === 'content' && insideContent()) || (m === 'window' && insideWindow()),
      });
      if (hit) {
        return {
          scope: 'window', surfaceId: surface.id, nodeId: hit.nodeId,
          key: surface.id, ray: sceneRay, t: hit.t, cam: v.sceneCam ?? v.cam, frame: v.frame,
        };
      }

      if (surface.inputPassthrough) continue;
      // The slab renders through the window camera — pick it the same way.
      const slabHit = raySurfaceHit(nodeRay, v.slab, rect.width, rect.height);
      if (!slabHit) continue;
      try {
        const pixel = surface.ctx.getImageData(
          Math.max(0, Math.min(rect.width - 1, Math.floor(slabHit.x))),
          Math.max(0, Math.min(rect.height - 1, Math.floor(slabHit.y))),
          1, 1
        ).data;
        if (pixel[3] === 0) continue;
      } catch { /* tainted — opaque */ }
      // Opaque slab occludes everything beneath; the click belongs to it.
      return undefined;
    }

    // 4. World nodes behind the windows
    const back = this.hitWorldNodes(ray, 'back');
    return back ? worldPick(back) : undefined;
  }

  /**
   * Whether a pop-out hit of order[index]'s window at world depth `hitZ` is
   * hidden behind the slab of an opaque window above it (the same test the
   * deferred pop-out pass makes in the depth buffer). Depth compares world
   * z: every window camera and the desktop camera share the eye plane, so
   * nearer means larger z for all of them.
   */
  private popoutHidden(
    order: DesktopItem[], index: number, x: number, y: number, hitZ: number,
    viewOf: (s: Surface) => WindowView,
  ): boolean {
    for (let j = index + 1; j < order.length; j++) {
      const it = order[j];
      if (it.kind !== 'surface' || it.surface.transparent) continue;
      const v = viewOf(it.surface);
      const { width, height } = it.surface.rect;
      const hit = raySurfacePlane(rayFromScreen(x, y, this.width, this.height, v.cam.invViewProj), v.slab, width, height);
      if (!hit || hit.x < 0 || hit.y < 0 || hit.x > width || hit.y > height) continue;
      if (hit.world.z >= hitZ) return true;
    }
    return false;
  }

  /** The nearest interactive node of one world layer across every owner. */
  private hitWorldNodes(ray: Ray, layer: 'back' | 'front'): { ownerId: string; nodeId: string; t: number } | undefined {
    const identity = mat4Identity();
    let best: { ownerId: string; nodeId: string; t: number } | undefined;
    for (const key of this.worldKeys) {
      const hit = this.hitNodeTree(ray, key, identity, { layer });
      if (hit && (!best || hit.t < best.t)) best = { ownerId: key.slice('world:'.length), nodeId: hit.nodeId, t: hit.t };
    }
    return best;
  }

  /** Node kinds a ray can pick (they have a shape the ray tests). */
  private static readonly PICKABLE_KINDS = new Set<string>(['mesh', 'canvas', 'model', 'text', 'label', 'line']);

  /**
   * Whether a node takes input. Nodes are decorative by default: only those
   * that opt in with `interactive: true`, or sit inside (or are) a node that
   * declares `draggable` or `raiseOnClick`, are click/drag/keyboard targets
   * (`interactive: false` opts a node back out). Without this, a
   * full-window decorative mesh (e.g. a water surface) would ray-intercept
   * every click and starve the window's widgets / input canvas.
   */
  private isInteractive(node: VocabNode): boolean {
    if (node.params.interactive === true) return true;
    if (node.params.interactive === false) return false;
    // Dragging and raising both need a press, so they imply input.
    return this.sceneStore.findUp(node, (p) => p.raiseOnClick === true || parseDraggable(p.draggable) !== undefined) !== undefined;
  }

  /**
   * Ray-test the interactive nodes of one retained node tree and return the
   * closest hit with its world distance along the ray. `layer` / `rootId`
   * narrow world trees the way the render passes do; `allow` admits window
   * nodes by clip mode (a node scissored away where the pointer is must not
   * be hit there).
   */
  private hitNodeTree(
    ray: Ray,
    key: string,
    frame: Mat4,
    opts: { layer?: string; rootId?: string; allow?: (clip: ClipMode) => boolean } = {},
  ): { nodeId: string; t: number } | undefined {
    const nodes = this.sceneStore.nodesForSurface(key);
    if (nodes.length === 0) return undefined;
    let bestId: string | undefined;
    let bestT = Infinity;
    for (const node of nodes) {
      if (!Compositor.PICKABLE_KINDS.has(node.kind)) continue;
      if (!this.isInteractive(node)) continue;
      if (opts.layer !== undefined || opts.allow) {
        const rp = this.sceneStore.resolveParams(node);
        if (opts.layer !== undefined && ((rp.layer as string) ?? 'back') !== opts.layer) continue;
        if (opts.allow && !opts.allow(clipModeOf(rp))) continue;
      }
      if (opts.rootId !== undefined && this.sceneStore.rootOf(node).id !== opts.rootId) continue;
      let model = this.sceneStore.worldMatrix(node, frame);
      let t: number | null;
      if (node.kind === 'canvas') {
        // A canvas layer picks as the same quad drawCanvasLayerNode renders.
        const quadModel = this.canvasNodeModel(key, node, frame);
        if (!quadModel) continue;
        model = quadModel;
        t = rayMeshHit(ray, model, 'plane');
      } else if (node.kind !== 'mesh') {
        t = this.hitContentNode(ray, key, node, model);
      } else if (hasCustomGeometry(node.params)) {
        const g = node.params.geometry as CustomGeometryParam;
        t = rayCustomMeshHit(ray, model, g.positions, g.indices);
      } else {
        const prim = (node.params.primitive as string) ?? 'box';
        if (isShapePrimitive(prim)) {
          // Parametric shapes pick against their triangles.
          const g = getShapeGeometry(prim, node.params.shape);
          t = rayCustomMeshHit(ray, model, g.positions, g.indices);
        } else {
          t = rayMeshHit(ray, model, prim as 'plane' | 'box' | 'sphere' | 'cylinder');
        }
      }
      if (t === null) continue;
      if (t < bestT) {
        bestT = t;
        bestId = node.id;
      }
    }
    return bestId !== undefined ? { nodeId: bestId, t: bestT } : undefined;
  }

  /**
   * Find the surface at a viewport point AND the exact surface-local
   * coordinates of the hit (projection-correct even for lifted/tilted
   * slabs). Prefer this over subtracting rect origins.
   */
  surfaceLocalAt(x: number, y: number): { surface: Surface; x: number; y: number } | undefined {
    if (this.exposeT > 0 && this.mobileMode) return undefined;
    const surface = this.desktopHitTest(x, y);
    if (!surface) return undefined;
    const { rect } = surface;
    const model = this.slabModelOf(surface);
    // Pick through the slab's own camera (matches how it renders when tilted).
    const hit = raySurfaceHit(this.slabRay(surface, x, y), model, rect.width, rect.height);
    if (!hit) return undefined;
    return { surface, x: hit.x, y: hit.y };
  }

  /**
   * The slab's last model matrix (falls back to an untransformed slab for
   * surfaces that haven't rendered yet; a window riding a node uses its
   * anchored slab).
   */
  private slabModelOf(surface: Surface): Mat4 {
    const state = this.surfaceGl.get(surface.id);
    if (state?.attach) return this.windowView(surface).slab;
    const { rect } = surface;
    return state?.model ?? mat4TRS(
      rect.x + rect.width / 2, rect.y + rect.height / 2, 0,
      0, 0, 0, rect.width, rect.height, 1,
    );
  }

  private desktopHitTest(viewportX: number, viewportY: number): Surface | undefined {
    // The camera follows scroll; make sure matrices reflect the current state
    // even if no frame has rendered since the last scroll.
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);

    // Iterate the desktop order top to bottom (stacked world objects take
    // input only through their interactive nodes, see pickNode).
    const order = this.desktopOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const item = order[i];
      if (item.kind !== 'surface') continue;
      const surface = item.surface;
      if (surface.inputPassthrough) continue;
      // In the desktop Exposé only the rails left in place take the pointer.
      if (this.exposeT > 0 && !this.exposeKeeps(surface)) continue;

      const { rect } = surface;
      const model = this.slabModelOf(surface);
      // Pick through the slab's own camera (matches how it renders when tilted).
      const hit = raySurfaceHit(this.slabRay(surface, viewportX, viewportY), model, rect.width, rect.height);
      if (!hit) continue;

      // Transparent pixels pass input through to surfaces below.
      // getImageData throws on tainted canvases (cross-origin images
      // loaded without CORS); treat those surfaces as fully opaque.
      try {
        const pixel = surface.ctx.getImageData(
          Math.max(0, Math.min(rect.width - 1, Math.floor(hit.x))),
          Math.max(0, Math.min(rect.height - 1, Math.floor(hit.y))),
          1, 1
        ).data;
        if (pixel[3] === 0) continue;
      } catch {
        // Canvas tainted by cross-origin image — treat as opaque
      }

      return surface;
    }
    return undefined;
  }

  // ── Phone camera API (the frontend's gestures drive these) ───────────

  /** Current phone view state, for gesture routing in the frontend. */
  getMobileView(): MobileViewState {
    return this.mobileView;
  }

  /** Whether a point falls within the bottom gesture-handle band. */
  isInGestureHandle(y: number): boolean {
    return this.mobileMode && y >= this.height - Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
  }

  setMobileMode(enabled: boolean): void {
    if (this.mobileMode === enabled) return;
    this.mobileMode = enabled;
    this.mobileFlight = undefined;
    this.mobileGlide = undefined;
    this.mobileFocusLost = undefined;
    this.mobileFocusedSurfaceId = undefined;
    this.mobileView = MobileViewState.DESKTOP;
    this.exposeT = 0;
    this.exposeAnim = undefined;
    this.exposeSlots.clear();
    this.exposeLift.clear();
    this.exposeFlyOff.clear();
    this.mobileOverlaySig = '';
    // The phone starts fitted to the used desktop; the desktop is 1:1.
    this.mobileAutoFit = enabled;
    if (!enabled) this.viewZoom = 1;
    this.needsRender = true;
  }

  getMobileMode(): boolean {
    return this.mobileMode;
  }

  /** The window the phone camera is framed on (focus mode), if any. */
  get mobileFocusSurface(): string | undefined {
    return this.mobileView === MobileViewState.FOCUS ? this.mobileFocusedSurfaceId : undefined;
  }

  /**
   * Screen px at the bottom that something covers (a virtual keyboard over a
   * canvas that did not shrink). The camera may then pan content up past the
   * desktop's lower edge, and windows pinned to the screen keep above it.
   */
  setMobileBottomInset(px: number): void {
    const next = Math.max(0, px);
    if (next !== this.mobileBottomInset) this.needsRender = true;
    this.mobileBottomInset = next;
  }

  /** Show the whole used desktop right away (the view after connecting). */
  mobileFitNow(): void {
    if (!this.mobileMode) return;
    this.mobileFlight = undefined;
    this.mobileGlide = undefined;
    this.mobileView = MobileViewState.DESKTOP;
    this.mobileAutoFit = true;
    this.applyMobileCam(this.mobileFitCam());
  }

  /** The user has the camera: stop fitting it automatically as windows arrive. */
  private takeMobileCamera(): void {
    this.mobileAutoFit = false;
    this.mobileFlight = undefined;
  }

  /** Pinch: zoom by `factor` about a screen point (the workspace point under it stays put). */
  mobileZoomAt(factor: number, sx: number, sy: number): void {
    if (!this.mobileMode || !Number.isFinite(factor) || factor <= 0) return;
    this.takeMobileCamera();
    this.mobileGlide = undefined;
    const fit = this.mobileFitCam().zoom;
    const zoom = Math.max(fit * 0.5, Math.min(Compositor.MOBILE_MAX_ZOOM, this.viewZoom * factor));
    const w = this.viewportToWorkspace(sx, sy);
    this.applyMobileCam({ x: w.x - sx / zoom, y: w.y - sy / zoom, zoom });
  }

  /** Pan the camera by a screen-px finger delta (content follows the finger). */
  mobilePanBy(dx: number, dy: number): void {
    if (!this.mobileMode) return;
    this.takeMobileCamera();
    this.scrollX -= dx / this.viewZoom;
    this.scrollY -= dy / this.viewZoom;
    this.needsRender = true;
  }

  /** A pan released with speed (screen px/s): the camera glides to a stop. */
  mobileGlideFrom(vx: number, vy: number): void {
    if (!this.mobileMode || Math.hypot(vx, vy) < 80) return;
    this.mobileGlide = { vx, vy, last: performance.now() };
    this.needsRender = true;
  }

  /** A finger landed: stop any glide or flight. True when something was moving (the touch only catches it). */
  mobileStopMotion(): boolean {
    const moving = !!this.mobileGlide || !!this.mobileFlight;
    this.mobileGlide = undefined;
    if (this.mobileFlight) {
      this.mobileFlight = undefined;
      this.mobileAutoFit = false;
    }
    return moving;
  }

  /**
   * A pinch ended. Zoomed out well past fit-all: Exposé (returns 'expose').
   * Past fit-all a little: settle back to the fitted desktop ('fit').
   */
  mobilePinchEnd(): 'expose' | 'fit' | undefined {
    if (!this.mobileMode || this.mobileView === MobileViewState.EXPOSE) return undefined;
    const fit = this.mobileFitCam();
    if (this.viewZoom < fit.zoom * 0.85 && this.enterExpose()) return 'expose';
    if (this.viewZoom < fit.zoom * 0.999) {
      this.mobileView = MobileViewState.DESKTOP;
      this.mobileFocusedSurfaceId = undefined;
      this.flyTo(fit);
      return 'fit';
    }
    return undefined;
  }

  /** Focus mode: fly in so the window's width fills the screen (scale only, no reflow). */
  mobileFlyToSurface(surfaceId: string): boolean {
    const s = this.surfaces.get(surfaceId);
    // A window pinned to the screen already shows at a readable scale.
    if (!this.mobileMode || !s || !s.visible || this.isWorkspaceFiltered(s) || this.pinnable(s)) return false;
    if (this.mobileView === MobileViewState.EXPOSE) this.leaveExpose();
    this.takeMobileCamera();
    this.mobileFocusLost = undefined;
    this.mobileFocusedSurfaceId = surfaceId;
    this.mobileView = MobileViewState.FOCUS;
    this.flyTo(this.mobileFrameCam(this.surfaceBounds(s), Compositor.MOBILE_FOCUS_MAX_ZOOM));
    return true;
  }

  /**
   * Focus mode on a 3D node: a world node (or the stacked object it belongs
   * to) is framed by its projected bounds; a node inside a window focuses
   * that window.
   */
  mobileFlyToNode(hit: NodeHit): boolean {
    if (!this.mobileMode) return false;
    if (hit.scope === 'window') return hit.surfaceId ? this.mobileFlyToSurface(hit.surfaceId) : false;
    const b = this.worldNodeBounds(hit);
    if (!b) return false;
    this.takeMobileCamera();
    this.mobileFocusedSurfaceId = undefined;
    this.mobileView = MobileViewState.FOCUS;
    const cam = this.mobileFrameCam(b, 3);
    // Centre an object vertically whatever its height.
    const H = this.mobileAvailHeight;
    cam.y = (b.y0 + b.y1) / 2 - H / (2 * cam.zoom);
    if ((b.y1 - b.y0) * cam.zoom > H) {
      const z = Math.max(0.05, (H - 2 * Compositor.MOBILE_MARGIN) / Math.max(1, b.y1 - b.y0));
      cam.x += this.width / (2 * cam.zoom) - this.width / (2 * z);
      cam.y = (b.y0 + b.y1) / 2 - H / (2 * z);
      cam.zoom = z;
    }
    this.flyTo(cam);
    return true;
  }

  /**
   * A world node's workspace box: the corners of every shaped node of its
   * stacked object (or of the node alone) projected through the desktop
   * camera and mapped back to the z=0 plane.
   */
  private worldNodeBounds(hit: NodeHit): { x0: number; y0: number; x1: number; y1: number } | undefined {
    const key = `world:${hit.ownerId}`;
    const node = this.sceneStore.getNode(key, hit.nodeId);
    if (!node) return undefined;
    const root = this.sceneStore.rootOf(node);
    const members = root.params.layer === 'stack'
      ? this.sceneStore.nodesForSurface(key).filter((n) => this.sceneStore.rootOf(n).id === root.id)
      : [node];
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);
    const identity = mat4Identity();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (m: Mat4, pts: ReadonlyArray<readonly [number, number, number]>) => {
      for (const [px, py, pz] of pts) {
        const p = mat4TransformPoint(this.viewProj, mat4TransformPoint(m, vec3(px, py, pz)));
        const w = this.viewportToWorkspace((p.x + 1) / 2 * this.width, (1 - p.y) / 2 * this.height);
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
        x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x);
        y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y);
      }
    };
    const cube: Array<[number, number, number]> = [];
    for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) cube.push([cx, cy, cz]);
    for (const n of members) {
      if (n.kind === 'canvas') {
        const q = this.canvasNodeModel(key, n, identity);
        if (q) add(q, [[-0.5, -0.5, 0], [0.5, -0.5, 0], [-0.5, 0.5, 0], [0.5, 0.5, 0]]);
      } else if (n.kind !== 'light' && n.kind !== 'group' && n.kind !== 'environment' && n.kind !== 'camera') {
        add(this.sceneStore.worldMatrix(n, identity), cube);
      }
    }
    if (!Number.isFinite(x0)) {
      // Nothing with a shape: frame a modest box around the node's origin.
      const o = this.sceneStore.worldMatrix(node, identity);
      return { x0: o[12] - 120, y0: o[13] - 120, x1: o[12] + 120, y1: o[13] + 120 };
    }
    return { x0, y0, x1, y1 };
  }

  /** Back out to the desktop view, fitted to the used area. */
  mobileFlyOut(): void {
    if (!this.mobileMode) return;
    if (this.mobileView === MobileViewState.EXPOSE) this.leaveExpose();
    this.mobileView = MobileViewState.DESKTOP;
    this.mobileFocusedSurfaceId = undefined;
    this.mobileFocusLost = undefined;
    this.flyTo(this.mobileFitCam());
  }

  /**
   * Focus mode: fly to the spatially nearest window on one side (-1 left,
   * +1 right) of the framed one. Returns the window flown to.
   */
  mobileFlyToNeighbor(dir: -1 | 1): string | undefined {
    if (!this.mobileMode) return undefined;
    const cur = this.mobileFocusedSurfaceId ? this.surfaces.get(this.mobileFocusedSurfaceId) : undefined;
    const from = cur
      ? { x: cur.rect.x + cur.rect.width / 2, y: cur.rect.y + cur.rect.height / 2 }
      : this.viewportToWorkspace(this.width / 2, this.height / 2);
    let best: { id: string; d: number } | undefined;
    for (const s of this.exposeCandidates()) {
      if (s.id === cur?.id) continue;
      const dx = s.rect.x + s.rect.width / 2 - from.x;
      const dy = s.rect.y + s.rect.height / 2 - from.y;
      if (dx * dir <= 1) continue;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { id: s.id, d };
    }
    if (!best) return undefined;
    this.mobileFlyToSurface(best.id);
    return best.id;
  }

  /**
   * Pan (flying) so a screen rect sits inside [top, bottom] of the screen,
   * e.g. a text field above the virtual keyboard. Returns the pose before
   * the pan (to restore when the keyboard goes), or undefined when the rect
   * already shows.
   */
  mobileReveal(rect: Rect, top: number, bottom: number): MobileCam | undefined {
    if (!this.mobileMode) return undefined;
    const margin = 12;
    // Keep clear of the gesture handle when the band ends at the canvas bottom.
    const low = bottom >= this.height - 1 ? Compositor.MOBILE_GESTURE_HANDLE_HEIGHT + 8 : margin;
    let dy = 0;
    if (rect.y + rect.height > bottom - low) dy = rect.y + rect.height - (bottom - low);
    if (rect.y - dy < top + margin) dy = rect.y - (top + margin);
    if (Math.abs(dy) < 1) return undefined;
    const before = this.currentCam();
    this.takeMobileCamera();
    this.flyTo({ x: before.x, y: before.y + dy / before.zoom, zoom: before.zoom }, 250);
    return before;
  }

  /** Fly back to a pose saved by mobileReveal. */
  mobileRestore(cam: MobileCam): void {
    if (!this.mobileMode) return;
    this.flyTo({ ...cam }, 250);
  }

  /**
   * Where a window-local point (surface px) is on screen, through the
   * window's actual slab placement (tilt, lift, riding a node, zoom).
   */
  surfaceLocalToViewport(surfaceId: string, lx: number, ly: number): { x: number; y: number } | undefined {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return undefined;
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);
    const v = this.windowView(surface);
    const p = mat4TransformPoint(v.frame, vec3(lx - surface.rect.width / 2, ly - surface.rect.height / 2, 0));
    const n = mat4TransformPoint(v.cam.viewProj, p);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return undefined;
    return { x: (n.x + 1) / 2 * this.width, y: (1 - n.y) / 2 * this.height };
  }

  /** Whether pressing this node starts a drag (it, or an ancestor, declares `draggable`). */
  nodeDraggable(hit: NodeHit): boolean {
    const node = this.nodeOfHit(hit);
    return !!node && this.sceneStore.findUp(node, (p) => parseDraggable(p.draggable) !== undefined) !== undefined;
  }

  /** A system rail (dock, sidebar, toolbars): stacked at or above the rail threshold. */
  isRailSurface(surfaceId: string): boolean {
    const s = this.surfaces.get(surfaceId);
    return !!s && s.zIndex >= RAIL_Z_THRESHOLD;
  }

  /** Whether a window may be closed by a phone gesture (Exposé flick). */
  isSurfaceClosable(surfaceId: string): boolean {
    return this.surfaces.get(surfaceId)?.closable ?? true;
  }

  /**
   * Spread the visible windows of the active workspace into a grid (visual
   * only; backend rects never change). Works on the phone (camera view) and
   * the desktop (mouse and keys; the focused window starts selected). False
   * when there is no window to spread.
   */
  enterExpose(): boolean {
    if (this.mobileView === MobileViewState.EXPOSE) return true;
    const wins = this.exposeCandidates();
    if (wins.length === 0) return false;
    this.clampScroll();
    if (this.mobileMode) {
      this.takeMobileCamera();
      this.mobileGlide = undefined;
    }
    this.exposeLift.clear();
    this.exposeFlyOff.clear();
    this.exposeHot.clear();
    this.layoutExpose(wins);
    const focused = this.focusedSurfaceId;
    this.exposeSelected = focused && this.exposeSlots.has(focused) ? focused : this.exposeOrder()[0];
    this.mobileView = MobileViewState.EXPOSE;
    this.animateExpose(1);
    return true;
  }

  /**
   * Leave Exposé: windows glide home. With a window chosen, the phone's
   * camera flies into it; the desktop raises it at once so it lands on top
   * (the backend's raise and focus, sent by the caller, confirm it).
   */
  exitExpose(focusSurfaceId?: string): void {
    if (this.mobileView !== MobileViewState.EXPOSE) return;
    this.leaveExpose();
    this.mobileView = MobileViewState.DESKTOP;
    if (!this.mobileMode) {
      if (focusSurfaceId && this.surfaces.has(focusSurfaceId)) {
        this.exposeSelected = focusSurfaceId;
        this.raiseLocally(focusSurfaceId);
        this.setFocusedSurface(focusSurfaceId);
      }
      return;
    }
    if (focusSurfaceId && this.mobileFlyToSurface(focusSurfaceId)) return;
    // Opened by pinching out past the fit: settle back on the fitted desktop.
    const fit = this.mobileFitCam();
    if (this.viewZoom < fit.zoom * 0.999) this.flyTo(fit);
  }

  private leaveExpose(): void {
    this.mobileView = MobileViewState.DESKTOP;
    this.animateExpose(0, () => {
      this.exposeSlots.clear();
      this.exposeLift.clear();
      this.exposeFlyOff.clear();
      this.exposeHot.clear();
      this.exposeMembers.clear();
      this.exposeSelected = undefined;
    });
  }

  /** Close Exposé without the flight home (another workspace took the screen). */
  private closeExposeNow(): void {
    if (this.mobileView === MobileViewState.EXPOSE) this.mobileView = MobileViewState.DESKTOP;
    this.exposeAnim = undefined;
    this.exposeT = 0;
    this.exposeP = 0;
    this.exposeSlots.clear();
    this.exposeLift.clear();
    this.exposeFlyOff.clear();
    this.exposeHot.clear();
    this.exposeMembers.clear();
    this.exposeSelected = undefined;
    this.needsRender = true;
  }

  /** Bring a window above every other ordinary window here (its backend raise follows). */
  private raiseLocally(surfaceId: string): void {
    const s = this.surfaces.get(surfaceId);
    if (!s || s.zIndex >= RAIL_Z_THRESHOLD) return;
    let top = 0;
    for (const o of this.surfaces.values()) {
      if (o !== s && o.zIndex < RAIL_Z_THRESHOLD && o.zIndex > top) top = o.zIndex;
    }
    if (s.zIndex <= top) this.setZIndex(surfaceId, top + 1);
  }

  /** Whether Exposé is open (on the phone or the desktop). */
  isExposeOpen(): boolean {
    return this.mobileView === MobileViewState.EXPOSE;
  }

  /** The spread windows that can be picked, in reading order. */
  private exposeOrder(): string[] {
    return [...this.exposeSlots.entries()]
      .filter(([id]) => {
        const s = this.surfaces.get(id);
        return !!s && s.visible && s.drawn && !this.exposeFlyOff.has(id);
      })
      .sort((a, b) => a[1].index - b[1].index)
      .map(([id]) => id);
  }

  /** Desktop Exposé: the selected window (hover or keys), if any. */
  getExposeSelection(): string | undefined {
    return this.isExposeOpen() ? this.exposeSelected : undefined;
  }

  /** Desktop Exposé: select a spread window (the pointer rests on it). */
  exposeSelect(surfaceId: string): void {
    require(typeof surfaceId === 'string' && surfaceId.length > 0, 'exposeSelect: surfaceId is required');
    if (!this.isExposeOpen() || !this.exposeSlots.has(surfaceId) || this.exposeSelected === surfaceId) return;
    this.exposeSelected = surfaceId;
    this.needsRender = true;
  }

  /**
   * Desktop Exposé: move the selection. 'next' / 'prev' step through the
   * grid in reading order (wrapping); the arrows move to the nearest window
   * that way on screen (staying put at the edge). Returns the selection.
   */
  exposeMoveSelection(dir: 'left' | 'right' | 'up' | 'down' | 'next' | 'prev'): string | undefined {
    require(['left', 'right', 'up', 'down', 'next', 'prev'].includes(dir), `exposeMoveSelection: unknown direction ${dir}`);
    if (!this.isExposeOpen()) return undefined;
    const ids = this.exposeOrder();
    if (ids.length === 0) return undefined;
    const cur = this.exposeSelected && ids.includes(this.exposeSelected) ? this.exposeSelected : undefined;
    let next: string | undefined;
    if (!cur) {
      next = ids[0];
    } else if (dir === 'next' || dir === 'prev') {
      const i = ids.indexOf(cur);
      next = ids[(i + (dir === 'next' ? 1 : ids.length - 1)) % ids.length];
    } else {
      const from = this.exposeSlots.get(cur)!;
      const [ux, uy] = dir === 'left' ? [-1, 0] : dir === 'right' ? [1, 0] : dir === 'up' ? [0, -1] : [0, 1];
      let best = Infinity;
      for (const id of ids) {
        if (id === cur) continue;
        const to = this.exposeSlots.get(id)!;
        const dx = to.cx - from.cx;
        const dy = to.cy - from.cy;
        const along = dx * ux + dy * uy;
        if (along <= 1) continue;
        // Straight ahead wins over a closer window off to the side.
        const score = along + 2 * Math.abs(dx * uy - dy * ux);
        if (score < best) { best = score; next = id; }
      }
      next ??= cur;
    }
    if (next) this.exposeSelect(next);
    return this.exposeSelected;
  }

  /** The Exposé window under a screen point. */
  exposeAt(x: number, y: number): string | undefined {
    if (this.mobileView !== MobileViewState.EXPOSE) return undefined;
    for (const id of this.exposeSlots.keys()) {
      if (this.exposeFlyOff.has(id)) continue;
      const s = this.surfaces.get(id);
      const r = s && s.visible && s.drawn ? this.exposeScreenRect(s) : undefined;
      if (r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return id;
    }
    return undefined;
  }

  /** Lift an Exposé window with the finger (screen px, negative = up). */
  exposeSetLift(surfaceId: string, dy: number): void {
    if (!this.exposeSlots.has(surfaceId)) return;
    this.exposeLift.set(surfaceId, Math.min(24, dy));
    this.needsRender = true;
  }

  /**
   * Release a lifted Exposé window: a flick sends it off the top (true; the
   * caller asks the backend to close it), otherwise it drops back.
   */
  exposeRelease(surfaceId: string, close: boolean): boolean {
    if (!this.exposeSlots.has(surfaceId)) return false;
    const lift = this.exposeLift.get(surfaceId) ?? 0;
    if (close && this.isSurfaceClosable(surfaceId)) {
      this.exposeFlyOff.set(surfaceId, { from: lift, start: performance.now() });
      this.needsRender = true;
      return true;
    }
    this.exposeLift.delete(surfaceId);
    this.needsRender = true;
    return false;
  }

  /**
   * Get canvas dimensions.
   */
  get width(): number {
    return this.canvas.width / (window.devicePixelRatio || 1);
  }

  get height(): number {
    return this.canvas.height / (window.devicePixelRatio || 1);
  }

  /**
   * Get surface count.
   */
  get surfaceCount(): number {
    return this.surfaces.size;
  }
}

/** A model loaded for `model` nodes, shared by every node naming the same source. */
interface ModelEntry {
  src: string;
  /** waiting = its content blob has not arrived yet (see Compositor.blobArrived). */
  state: 'loading' | 'waiting' | 'ready' | 'error';
  doc?: GltfDocument;
  error?: string;
  /** The rest pose (no animation) and its bounds, model units after the y flip. */
  rest?: { items: GltfDrawItem[]; min: [number, number, number]; max: [number, number, number] };
  /** GPU buffers per primitive and textures per image, for context `generation`. */
  meshes: Map<GltfPrimitive, DynamicMesh>;
  textures: Map<number, WebGLTexture>;
  /** Decoded images, kept to re-upload after a lost context. */
  bitmaps: Map<number, ImageBitmap>;
  generation: number;
}
