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
import { MAX_MESH_LIGHTS } from './gl/shaders.js';
import { Overlay2D } from './gl/overlay-2d.js';
import { SceneStore, VocabNode } from './gl/scene.js';
import { SceneOp, SceneTheme, MeshPrimitive, CustomGeometryParam, resolveSceneColor, hasCustomGeometry } from './gl/scene-types.js';
import { getGeometry, customGeometry, Geometry } from './gl/primitives.js';
import { cubicBezier, STANDARD, LINEAR, EMPHASIZE } from './motion.js';
import { EasingCurve } from '../core/theme-data.js';
import { Mat4, mat4Identity, mat4Multiply, mat4PerspectiveYDown, mat4Translation, mat4TRS, mat4Invert, mat4LookAt, mat4Ortho, mat4TransformPoint, vec3 } from './gl/math.js';
import { rayFromScreen, raySurfaceHit, rayMeshHit, rayCustomMeshHit, Ray } from './gl/picking.js';

/**
 * Mobile interaction states (WebOS-style).
 * - NATIVE_FIT: one window shown fit-to-screen; single finger = content input.
 * - NATIVE_ZOOMED: window shown at 1:1 native pixels; single finger pans.
 * - CARD_OVERVIEW: all windows as cards; gestures flip/close/open/reorder them.
 */
export enum MobileViewState {
  NATIVE_FIT = 'fit',
  NATIVE_ZOOMED = 'zoomed',
  CARD_OVERVIEW = 'overview',
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  closable: boolean;     // mobile card overview may flick this closed (false for system rails)
  workspaceId?: string;  // undefined = always visible (global objects)
  title?: string;        // window title for mobile tab bar
}

export interface DrawCommand {
  type: DrawCommandType;
  surfaceId: string;
  params: unknown;
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
  /** Global bloom post-effect config, set by an 'environment' node's `bloom`. */
  private bloomConfig?: { threshold: number; intensity: number };
  private bloomOwnerKey?: string;
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
  private focusGlowColor = 'rgba(91, 229, 160, 0.55)'; // Arcane rune-green default
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
  private static readonly CAMERA_FOV = (30 * Math.PI) / 180;
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

  // ── Mobile mode state ──
  private mobileMode = false;
  private mobileFocusedSurfaceId?: string;
  private mobileView = MobileViewState.NATIVE_FIT;
  /** Slim bottom band that hints the swipe-up gesture (replaces the tab bar). */
  private static readonly MOBILE_GESTURE_HANDLE_HEIGHT = 28;
  /** Cached mobile transform for coordinate mapping (native states). */
  private mobileTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  // Pinch / double-tap zoom state: userZoom multiplies the fit-to-screen base scale.
  private mobileUserZoom = 1;
  private static readonly MOBILE_MAX_ZOOM = 3;  // pinch ceiling beyond fit-to-screen
  private mobilePanX = 0;  // pan offset when zoomed in
  private mobilePanY = 0;

  // ── Card overview state ──
  /** Stable, mutable deck order (surfaceIds), independent of z-index. */
  private mobileCardOrder: string[] = [];
  /** Carousel offset measured in card slots (active index = round(scroll)). */
  private mobileCardScroll = 0;
  /** Per-card drag in progress (flick-close or long-press reorder). */
  private cardDragState?: { surfaceId: string; dx: number; dy: number; reorder: boolean };
  /** Reveal progress 0→1 when entering the overview. */
  private cardRevealT = 1;
  /** Active overview/zoom tween (only one runs at a time). */
  private cardAnim?: Tween;
  // Overview layout fractions of the available content area.
  private static readonly CARD_BOX_W_FRAC = 0.72;
  private static readonly CARD_BOX_H_FRAC = 0.54;
  private static readonly CARD_SLOT_FRAC = 0.82;  // center-to-center spacing / box width

  constructor(canvas: HTMLCanvasElement) {
    require(canvas !== null, 'canvas is required');

    this.canvas = canvas;
    this.renderer = new GlRenderer(canvas);
    this.overlay = new Overlay2D(this.renderer);
    this.renderer.onContextRestored = () => {
      // GPU state is gone; OffscreenCanvases retain content, so re-upload all.
      for (const state of this.surfaceGl.values()) state.texture = undefined;
      for (const surface of this.surfaces.values()) surface.dirty = true;
      // Custom-mesh GPU handles are now invalid; drop them so they rebuild
      // from the retained scene store on the next frame (no deleteDynamicMesh
      // — the underlying GL objects no longer exist).
      this.customMeshes.clear();
      this.instancedMeshes.clear();
      // Mesh textures are gone too; drop the cache so resolveTexture reloads.
      this.meshTextures.clear();
      this.overlay.invalidate();
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
  ): string {
    require(objectId !== '', 'objectId is required');
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
      title,
    };

    this.surfaces.set(id, surface);
    this.sortSurfaces();
    this.needsRender = true;

    ensure(this.surfaces.has(id), 'Surface must be registered');
    return id;
  }

  /**
   * Destroy a surface.
   */
  destroySurface(surfaceId: string): boolean {
    const deleted = this.surfaces.delete(surfaceId);
    if (deleted) {
      this.liveDataImages.delete(surfaceId);
      this.surfaceVideoStamps.delete(surfaceId);
      for (const [videoId, region] of this.videoRegions) {
        if (region.surfaceId === surfaceId) this.videoRegions.delete(videoId);
      }
      const glState = this.surfaceGl.get(surfaceId);
      if (glState?.texture) this.renderer.deleteTexture(glState.texture);
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
    this.surfaceGl.clear();
    this.sceneStore.clear();
    this.worldKeys.clear();
    this.surfaces.clear();
    this.sortedSurfaces = [];
    this.liveDataImages.clear();
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
   */
  async captureSurface(surfaceId: string): Promise<{ imageBase64: string; width: number; height: number } | null> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !surface.drawn) return null;

    try {
      // convertToBlob throws on a canvas tainted by a cross-origin image.
      const blob = await surface.canvas.convertToBlob({ type: 'image/png' });
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return {
        imageBase64: btoa(binary),
        width: surface.rect.width,
        height: surface.rect.height,
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
  private applyOps(surfaceKey: string, ops: SceneOp[]): void {
    const rest: SceneOp[] = [];
    for (const op of ops) {
      if (op.op === 'animate') { this.startOrStopAnim(surfaceKey, op); continue; }
      if (op.op === 'remove') this.nodeAnims.delete(`${surfaceKey}/${op.id}`);
      rest.push(op);
    }
    if (rest.length > 0) this.sceneStore.apply(surfaceKey, rest);
    // Pick up bloom config from any 'environment' node (global post-effect).
    for (const op of rest) this.syncBloomFrom(surfaceKey, op);
    this.needsRender = true;
  }

  /** Update the global bloom config when an 'environment' node changes. */
  private syncBloomFrom(surfaceKey: string, op: SceneOp): void {
    const fullKey = `${surfaceKey}/${op.id}`;
    if (op.op === 'remove') {
      if (this.bloomOwnerKey === fullKey) { this.bloomConfig = undefined; this.bloomOwnerKey = undefined; }
      return;
    }
    const node = this.sceneStore.getNode(surfaceKey, op.id);
    if (node?.kind !== 'environment') return;
    const b = node.params.bloom as boolean | { threshold?: number; intensity?: number } | undefined;
    if (b) {
      this.bloomConfig = b === true
        ? { threshold: 0.6, intensity: 1 }
        : { threshold: b.threshold ?? 0.6, intensity: b.intensity ?? 1 };
      this.bloomOwnerKey = fullKey;
    } else if (this.bloomOwnerKey === fullKey) {
      this.bloomConfig = undefined; this.bloomOwnerKey = undefined;
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
      surface.visible = visible;
      this.needsRender = true;
    }
  }

  /**
   * Set a surface's title (used for mobile tab bar labels).
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
    this.activeWorkspaceId = workspaceId;
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
        this.draw({
          type: params.url !== undefined ? 'imageUrl' : 'image',
          surfaceId: command.surfaceId,
          params,
        });
        break;
      }

      case 'imageUrl': {
        const p = command.params as ImageUrlParams;
        const sid = command.surfaceId;

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

            const surf = this.surfaces.get(sid);
            if (surf) {
              surf.ctx.save();
              surf.ctx.setTransform(savedTransform);
              blitImage(surf.ctx, img, p);
              surf.ctx.restore();
              surf.dirty = true;
            }
            this.needsRender = true;
          };
          // On error, keep showing the old image (don't update liveDataImages)
          img.src = p.url;
        } else {
          // Regular URL path: use imageCache with CORS fallback
          const cached = this.imageCache.get(p.url);
          if (cached && cached.loaded) {
            blitImage(ctx, cached.img, p);
          } else if (!cached) {
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
              const surf = this.surfaces.get(sid);
              if (surf) {
                surf.ctx.save();
                surf.ctx.setTransform(savedTransform);
                blitImage(surf.ctx, image, p);
                surf.ctx.restore();
                surf.dirty = true;
              }
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
          // If cached but not yet loaded, skip — will render on next frame when load completes
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

    surface.dirty = true;
    surface.drawn = true;
    this.needsRender = true;
  }

  /**
   * Fully reset a surface's context state and wipe its bitmap. Prevents leaks
   * from a previous frame's unbalanced save/restore (e.g. a child render that
   * errored mid-draw, leaving residual translate/clip on the context). Without
   * this, clearRect operates in the wrong coordinate space and fails to clear
   * the full surface.
   */
  private resetSurfaceState(surface: Surface): void {
    const ctx = surface.ctx;
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
    ctx.clearRect(0, 0, surface.rect.width, surface.rect.height);
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
      // Composite playing videos into their surfaces before the render check,
      // so a fresh frame both updates the canvas and schedules the upload.
      if (this.blitVideoFrames()) this.needsRender = true;
      if (this.needsRender) {
        // Clear BEFORE rendering so an animating frame can re-request.
        this.needsRender = false;
        this.render();
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
    // Advance declarative animations; keep the loop alive while any run.
    if (this.stepAnimations(performance.now())) this.needsRender = true;
    this.touchedCustomMeshes.clear();
    this.touchedInstanced.clear();
    this.renderer.beginFrame();
    if (this.mobileMode) {
      this.renderMobile();
    } else {
      this.renderDesktop();
    }
    // Bloom is a post pass over the rendered scene, beneath the 2D chrome.
    if (this.bloomConfig) this.renderer.applyBloom(this.bloomConfig.threshold, this.bloomConfig.intensity);
    this.overlay.draw();
    this.pruneCustomMeshes();
  }

  /**
   * Perspective camera whose z=0 plane maps ~1:1 to CSS pixels. The eye sits
   * over the viewport center (plus scroll), so desktop scroll is a camera
   * truck and lifted/tilted slabs gain genuine parallax.
   */
  private updateCamera(scrollX: number, scrollY: number): void {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const dist = (h / 2) / Math.tan(Compositor.CAMERA_FOV / 2);
    const eyeX = w / 2 + scrollX;
    const eyeY = h / 2 + scrollY;
    this.cameraPos = [eyeX, eyeY, dist];
    const proj = mat4PerspectiveYDown(Compositor.CAMERA_FOV, w / h, dist / 10, dist * 4);
    const view = mat4Translation(-eyeX, -eyeY, -dist);
    this.viewProj = mat4Multiply(proj, view);
    this.invViewProj = mat4Invert(this.viewProj);
  }

  /** Theme-derived chrome values with arcane defaults pre-theme. */
  private chromeColors(): { shadow: RGBA; glow: RGBA; radius: number; depth: number } {
    const t = this.sceneTheme;
    return {
      shadow: parseCssColor(t?.shadow.color ?? 'rgba(0,0,0,0.55)'),
      glow: parseCssColor(t?.glow.focusColor ?? this.focusGlowColor),
      radius: t?.windowRadius ?? this.focusGlowRadius,
      depth: t?.surface.gradient ?? 1,
    };
  }

  private renderDesktop(): void {
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);

    const chrome = this.chromeColors();
    let animating = false;

    // World-scope nodes behind the windows (desktop décor, roaming pets).
    this.drawWorldNodes('back');

    for (const surface of this.sortedSurfaces) {
      if (!surface.visible || !surface.drawn) continue;
      if (this.isWorkspaceFiltered(surface)) continue;

      const state = this.glState(surface.id);
      const focused = surface.id === this.focusedSurfaceId;

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

      const { rect } = surface;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rot = state.userRotation ?? [0, 0, 0];
      const z = state.lift + (state.userZ ?? 0);
      const model = mat4TRS(
        cx, cy, z,
        state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
        rect.width, rect.height, 1,
      );
      state.model = model;

      const radius = surface.transparent ? 0 : Math.min(chrome.radius, rect.width / 2, rect.height / 2);

      if (!surface.transparent) {
        // Soft shadow beneath the slab — deeper when focused (depth scaled
        // by the theme's surface treatment; flat themes get flat desktops).
        const shadowSigma = (focused ? 16 : 9) * Math.max(0.25, chrome.depth);
        const pad = shadowSigma * 4;
        const shadowModel = mat4TRS(
          cx, cy + (focused ? 12 : 7), z - 1,
          state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
          rect.width + pad * 2, rect.height + pad * 2, 1,
        );
        this.renderer.drawGlow({
          model: shadowModel, viewProj: this.viewProj,
          quadWidth: rect.width + pad * 2, quadHeight: rect.height + pad * 2,
          halfWidth: rect.width / 2 - 1, halfHeight: rect.height / 2 - 1,
          radius,
          color: chrome.shadow,
          a1: focused ? 0.55 : 0.4, sigma1: shadowSigma,
        });

        // Focus bloom: the accent halo around the focused slab.
        if (focused) {
          const pad2 = 56;
          const glowModel = mat4TRS(
            cx, cy, z - 0.5,
            state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
            rect.width + pad2 * 2, rect.height + pad2 * 2, 1,
          );
          this.renderer.drawGlow({
            model: glowModel, viewProj: this.viewProj,
            quadWidth: rect.width + pad2 * 2, quadHeight: rect.height + pad2 * 2,
            halfWidth: rect.width / 2 - 1, halfHeight: rect.height / 2 - 1,
            radius,
            color: chrome.glow,
            a1: 0.5, sigma1: 5,
            a2: 0.3, sigma2: 12,
          });
        }
      }

      this.drawSurfaceSlab(surface, state, model, {
        radius,
        dim: focused || surface.transparent ? 1 : 0.93,
        opacity: 1,
        rim: focused && !surface.transparent
          ? { ...chrome.glow, a: chrome.glow.a * 0.9 }
          : undefined,
      });

      // Scene-vocabulary nodes ride the window's UNSCALED frame (the slab
      // model bakes in the window's px size, which would distort meshes).
      const frame = mat4TRS(
        cx, cy, z,
        state.tiltX + rot[0], state.tiltY + rot[1], rot[2],
        1, 1, 1,
      );
      // Occluded children (default): clipped to the window's content rect, so
      // they stay inside the frame and below the title bar. Overlay children
      // (occlude:false): unclipped, drawn on top — pop-out 3D / decorations.
      this.drawVocabNodes(surface, frame, 'occluded');
      this.drawVocabNodes(surface, frame, 'overlay');
    }

    // World-scope nodes above the windows (params.layer: 'front').
    this.drawWorldNodes('front');

    this.renderScrollbarsOverlay();
    if (animating) this.needsRender = true;
  }

  /** Upload (if dirty) and draw one surface slab. */
  private drawSurfaceSlab(
    surface: Surface,
    state: SurfaceGlState,
    model: Mat4,
    opts: { radius: number; dim: number; opacity: number; rim?: RGBA; scissor?: { x: number; y: number; width: number; height: number } },
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
        console.warn(`[Compositor] surface ${surface.id} tainted by a cross-origin image; freezing its texture`);
      }
    }
    this.renderer.drawSurface({
      model,
      viewProj: this.viewProj,
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
   * Draw a window's scene-vocabulary nodes in one of two passes:
   * - 'occluded' (default for window children): clipped to the window's screen
   *   rect and drawn BEFORE the slab, so the window's chrome/content occludes
   *   them and they cannot spill across the desktop.
   * - 'overlay': nodes whose resolved params set `occlude: false`, drawn AFTER
   *   the slab with no clip, so they sit on top and may extend past the window
   *   (pop-out 3D, decorations meant to be visible over the chrome).
   */
  private drawVocabNodes(surface: Surface, surfaceModel: Mat4, pass: 'occluded' | 'overlay'): void {
    // Clip occluded children to the window's CONTENT rect (in screen px): inset
    // the title bar + a thin border on chromed windows so 3D can never paint
    // over the title bar or escape the frame. Transparent windows have no
    // chrome, so they clip to the full rect.
    const titleBar = surface.transparent ? 0 : TITLE_BAR_HEIGHT;
    const border = surface.transparent ? 0 : 2;
    const clip = {
      x: surface.rect.x - this.scrollX + border,
      y: surface.rect.y - this.scrollY + titleBar,
      width: Math.max(0, surface.rect.width - border * 2),
      height: Math.max(0, surface.rect.height - titleBar - border),
    };
    this.drawNodeTree(surface.id, surfaceModel, undefined, clip, pass);
  }

  /**
   * Draw a retained node tree (a window subtree or a world-scope namespace).
   * `layer` filters world meshes (back/front). `clip` + `pass` drive window
   * occlusion: when given, meshes are partitioned by their resolved `occlude`
   * param and only the matching pass is drawn (occluded meshes are scissored
   * to `clip`). World trees pass neither and draw every mesh unclipped.
   */
  private drawNodeTree(
    key: string, surfaceModel: Mat4,
    layer?: 'back' | 'front',
    clip?: { x: number; y: number; width: number; height: number },
    pass?: 'occluded' | 'overlay',
  ): void {
    const nodes = this.sceneStore.nodesForSurface(key);
    if (nodes.length === 0) return;

    // Scene-wide environment (ambient + fog) from an 'environment' node, if any.
    const env = this.environmentFor(nodes);

    // Collect lights first (they illuminate every mesh in this subtree).
    // Note the first shadow-casting directional light's index + direction.
    const lights: MeshLight[] = [];
    let shadowLightIndex = -1;
    let shadowDir: [number, number, number] | undefined;
    for (const node of nodes) {
      if (node.kind !== 'light' || lights.length >= MAX_MESH_LIGHTS) continue;
      if (shadowLightIndex < 0 && node.params.lightType === 'directional' && node.params.castShadow === true) {
        shadowLightIndex = lights.length;
        shadowDir = (node.params.direction as [number, number, number]) ?? [0, 0.4, -1];
      }
      lights.push(this.buildLight(node, surfaceModel));
    }
    if (lights.length === 0) {
      // Default key light from the camera's upper left (directional → dir).
      lights.push({ pos: [0, 0, 0, 0], color: [0.9, 0.9, 0.95], dir: [-0.4, -0.5, -1] });
    }

    // Resolve each mesh's effective params (inheriting from ancestor groups),
    // then keep only those in this layer + occlusion pass.
    let entries = nodes
      .filter((n) => n.kind === 'mesh')
      .map((n) => ({ node: n, rp: this.sceneStore.resolveParams(n) }))
      .filter(({ rp }) => layer === undefined || ((rp.layer as string) ?? 'back') === layer);
    if (pass) {
      entries = entries.filter(({ rp }) => (pass === 'overlay') === (rp.occlude === false));
    }
    if (entries.length === 0) return;

    // Transparent meshes draw last, back-to-front, so they composite correctly.
    const opaque = entries.filter(({ rp }) => ((rp.opacity as number) ?? 1) >= 1 && !rp.texture);
    const transparent = entries.filter((e) => !opaque.includes(e));
    transparent.sort((a, b) => this.nodeCameraDepth(b.node, surfaceModel) - this.nodeCameraDepth(a.node, surfaceModel));

    // Opt-in directional shadows: render a depth map from the light's POV,
    // auto-fitting the ortho frustum to the casters' world AABB. Casters are
    // this pass's meshes; skip on the overlay pass (overlay nodes pop out).
    const shadow = shadowLightIndex >= 0 && shadowDir && pass !== 'overlay'
      ? this.renderShadowPass(key, entries.map((e) => e.node), surfaceModel, shadowDir, shadowLightIndex)
      : undefined;

    const scissored = clip !== undefined && pass === 'occluded';
    if (scissored) this.renderer.setScissor(clip);

    for (const { node, rp } of [...opaque, ...transparent]) {
      const world = this.sceneStore.worldMatrix(node, surfaceModel);
      const color = parseCssColor(resolveSceneColor((rp.color as string) ?? '#ffffff', this.sceneTheme));
      const emissiveStr = rp.emissive as string | undefined;
      const billboard = rp.billboard === true;
      const material = {
        model: billboard ? this.billboardMatrix(world) : world,
        viewProj: this.viewProj,
        color,
        emissive: emissiveStr ? parseCssColor(resolveSceneColor(emissiveStr, this.sceneTheme)) : undefined,
        opacity: (rp.opacity as number) ?? 1,
        metalness: rp.metalness as number | undefined,
        roughness: rp.roughness as number | undefined,
        texture: this.resolveTexture(rp.texture as string | undefined),
        drawMode: rp.drawMode as DrawMode | undefined,
        pointSize: rp.pointSize as number | undefined,
        lights,
        ambient: env.ambient,
        fog: env.fog,
        shadow,
        cameraPos: this.cameraPos,
      };
      if (Array.isArray(rp.instances) && (rp.instances as unknown[]).length > 0) {
        const handle = this.instancedHandle(key, node);
        if (handle) this.renderer.drawInstanced(handle, material);
      } else if (hasCustomGeometry(rp)) {
        const handle = this.customMeshHandle(key, node);
        if (handle) this.renderer.drawDynamicMesh(handle, material);
      } else {
        this.renderer.drawMesh({
          ...material,
          geometry: getGeometry((rp.primitive as MeshPrimitive) ?? 'box'),
        });
      }
    }

    if (scissored) this.renderer.clearScissor();
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
    const baseSig = custom ? `geom:${node.geomRev}` : `prim:${(node.params.primitive as string) ?? 'box'}`;
    let entry = this.instancedMeshes.get(fullKey);
    if (!entry || entry.baseSig !== baseSig) {
      if (entry) this.renderer.deleteInstancedMesh(entry.handle);
      let geom: Geometry;
      if (custom) {
        const g = node.params.geometry as CustomGeometryParam;
        geom = customGeometry(g.positions, g.indices, g.normals, g.colors, g.uvs);
      } else {
        geom = getGeometry((node.params.primitive as MeshPrimitive) ?? 'box');
      }
      entry = { baseSig, instRef: undefined, handle: this.renderer.createInstancedMesh(geom) };
      this.instancedMeshes.set(fullKey, entry);
    }
    const instances = node.params.instances as MeshInstance[];
    if (entry.instRef !== instances) {
      const baseColor = parseCssColor(resolveSceneColor((node.params.color as string) ?? '#ffffff', this.sceneTheme));
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

  /** Build a renderer light from a 'light' node's params (point/dir/spot). */
  private buildLight(node: VocabNode, surfaceModel: Mat4): MeshLight {
    const world = this.sceneStore.worldMatrix(node, surfaceModel);
    const col = parseCssColor(resolveSceneColor((node.params.color as string) ?? '#ffffff', this.sceneTheme));
    const intensity = (node.params.intensity as number) ?? 1;
    const color: [number, number, number] = [col.r * intensity, col.g * intensity, col.b * intensity];
    const type = node.params.lightType as string;
    const dir = (node.params.direction as [number, number, number]) ?? [0, 0.4, -1];
    if (type === 'directional') {
      return { pos: [0, 0, 0, 0], color, dir };
    }
    const pos: [number, number, number, number] = [world[12], world[13], world[14], type === 'spot' ? 2 : 1];
    const range = (node.params.range as number) ?? 0;
    if (type === 'spot') {
      const angle = (node.params.angle as number) ?? Math.PI / 6;
      const penumbra = Math.min(1, Math.max(0, (node.params.penumbra as number) ?? 0.3));
      return { pos, color, dir, range, spotInner: Math.cos(angle * (1 - penumbra)), spotOuter: Math.cos(angle) };
    }
    return { pos, color, range };
  }

  /** Resolve a node's ambient/fog 'environment' settings for a subtree. */
  private environmentFor(nodes: VocabNode[]): { ambient?: [number, number, number]; fog?: FogOpts } {
    const node = nodes.find((n) => n.kind === 'environment');
    if (!node) return {};
    const out: { ambient?: [number, number, number]; fog?: FogOpts } = {};
    if (node.params.ambient !== undefined) {
      const c = parseCssColor(resolveSceneColor(node.params.ambient as string, this.sceneTheme));
      out.ambient = [c.r, c.g, c.b];
    }
    const fog = node.params.fog as { color?: string; near: number; far: number } | undefined;
    if (fog && typeof fog.near === 'number' && typeof fog.far === 'number') {
      const c = parseCssColor(resolveSceneColor(fog.color ?? '#0a0a14', this.sceneTheme));
      // fog.near/far are SCENE-relative depth (px behind the content plane), not
      // camera-relative — the camera distance scales with the live viewport, so
      // an author can't know it. Add the camera-to-content baseline here so a
      // small near/far works at any viewport size.
      const baseline = this.cameraPos[2];
      out.fog = { color: [c.r, c.g, c.b], near: baseline + fog.near, far: baseline + fog.far };
    }
    return out;
  }

  /**
   * Render the directional shadow map: gather the casters' world AABB, fit an
   * orthographic light frustum to it (so the map adapts to any scene with no
   * magic constants), then draw caster depth from the light's POV. Returns the
   * sampling state for the mesh pass, or undefined if there is nothing to cast.
   * Instanced meshes receive shadows but do not cast them (v1).
   */
  private renderShadowPass(
    key: string, meshes: VocabNode[], surfaceModel: Mat4,
    dir: [number, number, number], lightIndex: number,
  ): ShadowOpts | undefined {
    const casters = meshes.filter((n) => !Array.isArray(n.params.instances));
    if (casters.length === 0) return undefined;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const built: Array<{ node: VocabNode; world: Mat4; custom: boolean }> = [];
    for (const node of casters) {
      const world = this.sceneStore.worldMatrix(node, surfaceModel);
      const custom = hasCustomGeometry(node.params);
      const [lo, hi] = custom
        ? this.positionsAABB((node.params.geometry as CustomGeometryParam).positions)
        : [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]] as [number[], number[]];
      for (let i = 0; i < 8; i++) {
        const p = mat4TransformPoint(world, vec3(
          i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      built.push({ node, world, custom });
    }

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const radius = Math.max(1, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
    let dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d: [number, number, number] = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    const up = Math.abs(d[1]) > 0.99 ? vec3(0, 0, 1) : vec3(0, 1, 0);
    const dist = radius * 2 + 50;
    const eye = vec3(cx - d[0] * dist, cy - d[1] * dist, cz - d[2] * dist);
    const view = mat4LookAt(eye, vec3(cx, cy, cz), up);

    // Fit the ortho box to the AABB in light space.
    let lminX = Infinity, lminY = Infinity, lminZ = Infinity, lmaxX = -Infinity, lmaxY = -Infinity, lmaxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = mat4TransformPoint(view, vec3(
        i & 1 ? maxX : minX, i & 2 ? maxY : minY, i & 4 ? maxZ : minZ));
      lminX = Math.min(lminX, p.x); lmaxX = Math.max(lmaxX, p.x);
      lminY = Math.min(lminY, p.y); lmaxY = Math.max(lmaxY, p.y);
      lminZ = Math.min(lminZ, p.z); lmaxZ = Math.max(lmaxZ, p.z);
    }
    const pad = radius * 0.05 + 1;
    const ortho = mat4Ortho(lminX - pad, lmaxX + pad, lminY - pad, lmaxY + pad, -(lmaxZ + dist), -(lminZ - pad));
    const lightVP = mat4Multiply(ortho, view);

    this.renderer.beginShadowPass(lightVP);
    for (const item of built) {
      if (item.custom) {
        const handle = this.customMeshHandle(key, item.node);
        if (handle) this.renderer.drawDepthDynamic(handle, item.world);
      } else {
        this.renderer.drawDepthGeometry(getGeometry((item.node.params.primitive as MeshPrimitive) ?? 'box'), item.world);
      }
    }
    this.renderer.endShadowPass();
    const map = this.renderer.shadowMap;
    return map ? { map, lightVP, lightIndex } : undefined;
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
  private nodeCameraDepth(node: VocabNode, surfaceModel: Mat4): number {
    const m = this.sceneStore.worldMatrix(node, surfaceModel);
    const dx = m[12] - this.cameraPos[0], dy = m[13] - this.cameraPos[1], dz = m[14] - this.cameraPos[2];
    return -(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Replace a node's rotation with a camera-facing basis while keeping its
   * world position and scale (extracted from the basis-vector lengths).
   * Billboards keep sprites/labels readable from any camera angle.
   */
  private billboardMatrix(world: Mat4): Mat4 {
    const px = world[12], py = world[13], pz = world[14];
    const sx = Math.hypot(world[0], world[1], world[2]) || 1;
    const sy = Math.hypot(world[4], world[5], world[6]) || 1;
    const sz = Math.hypot(world[8], world[9], world[10]) || 1;
    let fx = this.cameraPos[0] - px, fy = this.cameraPos[1] - py, fz = this.cameraPos[2] - pz;
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
    if (hit) return hit.tex;
    const tex = this.renderer.createTexture();
    this.meshTextures.set(src, { tex, loaded: false });
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.renderer.uploadTexture(tex, img);
      const e = this.meshTextures.get(src);
      if (e) e.loaded = true;
      this.needsRender = true;
    };
    img.src = src;
    return tex;
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
    const built = this.buildAnims(node, p);
    if (built.length === 0) return;
    const existing = this.nodeAnims.get(fullKey)?.anims ?? [];
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
      if (preset === 'orbit') {
        const cur = this.vecOf(node, 'position');
        const center = (p.center as [number, number, number]) ?? [cur[0], cur[1], cur[2]];
        const radius = (p.radius as number) ?? 100;
        const plane = ((p.plane as string) ?? 'xz') as 'xy' | 'xz' | 'yz';
        return [{ ...base, channel: 'orbit', from: cur, to: cur, duration: dur, loop: true, center, radius, plane }];
      }
      return [];
    }
    const channel = p.channel as NodeAnim['channel'];
    if (!channel) return [];
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
      this.drawNodeTree(key, identity, layer);
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

    if (needV) {
      // Track
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(this.width - SZ - M, M, SZ, this.height - 2 * M - (needH ? SZ + M : 0));
      // Thumb
      const trackH = this.height - 2 * M - (needH ? SZ + M : 0);
      const thumbH = Math.max(24, (this.height / ws.height) * trackH);
      const thumbY = M + (this.scrollY / (ws.height - this.height)) * (trackH - thumbH);
      ctx.fillStyle = 'rgba(180,180,200,0.6)';
      this.roundRectOn(ctx, this.width - SZ - M, thumbY, SZ, thumbH, 4);
      ctx.fill();
    }
    if (needH) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(M, this.height - SZ - M, this.width - 2 * M - (needV ? SZ + M : 0), SZ);
      const trackW = this.width - 2 * M - (needV ? SZ + M : 0);
      const thumbW = Math.max(24, (this.width / ws.width) * trackW);
      const thumbX = M + (this.scrollX / (ws.width - this.width)) * (trackW - thumbW);
      ctx.fillStyle = 'rgba(180,180,200,0.6)';
      this.roundRectOn(ctx, thumbX, this.height - SZ - M, thumbW, SZ, 4);
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

  private get mobileAvailHeight(): number {
    return this.height - Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
  }

  private renderMobile(): void {
    this.updateCamera(0, 0);

    if (this.mobileView === MobileViewState.CARD_OVERVIEW) {
      this.renderCardOverview();
      return;
    }

    const availW = this.width;
    const availH = this.mobileAvailHeight;

    // Find focused surface (or fallback to top visible)
    const surface = this.mobileFocusedSurfaceId
      ? this.surfaces.get(this.mobileFocusedSurfaceId)
      : this.getTopVisibleSurface();

    if (surface && surface.drawn && surface.visible) {
      // Base scale: fit window into available area
      const baseScale = Math.min(availW / surface.rect.width, availH / surface.rect.height);
      // Final scale: base * user zoom (min zoom = fit-to-screen)
      const scale = baseScale * this.mobileUserZoom;

      // When zoomed in, allow panning. Clamp pan so content stays visible.
      const scaledW = surface.rect.width * scale;
      const scaledH = surface.rect.height * scale;
      const maxPanX = Math.max(0, (scaledW - availW) / 2);
      const maxPanY = Math.max(0, (scaledH - availH) / 2);
      this.mobilePanX = Math.max(-maxPanX, Math.min(maxPanX, this.mobilePanX));
      this.mobilePanY = Math.max(-maxPanY, Math.min(maxPanY, this.mobilePanY));

      const offsetX = (availW - scaledW) / 2 + this.mobilePanX;
      const offsetY = (availH - scaledH) / 2 + this.mobilePanY;

      // Cache transform for coordinate mapping
      this.mobileTransform = { scale, offsetX, offsetY };

      const state = this.glState(surface.id);
      const model = mat4TRS(
        offsetX + scaledW / 2, offsetY + scaledH / 2, 0,
        0, 0, 0,
        scaledW, scaledH, 1,
      );
      state.model = model;
      this.drawSurfaceSlab(surface, state, model, {
        radius: 0,
        dim: 1,
        opacity: 1,
        // Clip to content area (above the gesture handle)
        scissor: { x: 0, y: 0, width: availW, height: availH },
      });
    }

    const ctx = this.overlay.begin();
    this.drawGestureHandle(ctx);
    this.overlay.markContent();
  }

  /** Slim centered pill hinting the swipe-up-from-bottom gesture. */
  private drawGestureHandle(ctx: OffscreenCanvasRenderingContext2D): void {
    const h = Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
    const y = this.height - h / 2;
    const pillW = 120;
    const pillH = 4;
    const x = (this.width - pillW) / 2;
    ctx.fillStyle = this.mobileView === MobileViewState.CARD_OVERVIEW
      ? 'rgba(139,139,255,0.6)'
      : 'rgba(160,160,190,0.4)';
    this.roundRectOn(ctx, x, y - pillH / 2, pillW, pillH, pillH / 2);
    ctx.fill();
  }

  // ── Card overview (WebOS-style) ─────────────────────────────────────

  /** Sync mobileCardOrder with the currently visible surfaces. */
  private reconcileCardOrder(): void {
    const vis = this.getMobileVisibleSurfaces().map(s => s.id);
    const visSet = new Set(vis);
    // Drop destroyed/hidden surfaces, preserve existing positions.
    this.mobileCardOrder = this.mobileCardOrder.filter(id => visSet.has(id));
    // Append newly-visible surfaces at the end.
    const known = new Set(this.mobileCardOrder);
    for (const id of vis) if (!known.has(id)) this.mobileCardOrder.push(id);
    // Clamp scroll to deck bounds.
    const n = this.mobileCardOrder.length;
    this.mobileCardScroll = Math.max(0, Math.min(this.mobileCardScroll, Math.max(0, n - 1)));
  }

  /** Card box dimensions and slot spacing for the current viewport. */
  private cardMetrics(): { boxW: number; boxH: number; slotW: number; cx: number; cy: number } {
    const availH = this.mobileAvailHeight;
    const boxW = this.width * Compositor.CARD_BOX_W_FRAC;
    const boxH = availH * Compositor.CARD_BOX_H_FRAC;
    return {
      boxW,
      boxH,
      slotW: boxW * Compositor.CARD_SLOT_FRAC,
      cx: this.width / 2,
      cy: availH / 2,
    };
  }

  /** Eased size factor for a card by its signed slot distance from center. */
  private cardSizeFactor(slot: number): number {
    const d = Math.min(Math.abs(slot), 1);
    return 1 - 0.18 * d;
  }

  /** Drawn rect (and surface) for a deck index, applying any active drag. */
  private cardDrawRect(index: number): { x: number; y: number; w: number; h: number; surface: Surface; slot: number } | undefined {
    const id = this.mobileCardOrder[index];
    if (id === undefined) return undefined;
    const surface = this.surfaces.get(id);
    if (!surface || !surface.drawn) return undefined;

    const { boxW, boxH, slotW, cx, cy } = this.cardMetrics();
    let slot = index - this.mobileCardScroll;

    // A reordering card follows the finger horizontally.
    const drag = this.cardDragState;
    let dragDx = 0, dragDy = 0;
    if (drag && drag.surfaceId === id) {
      if (drag.reorder) dragDx = drag.dx;
      else dragDy = drag.dy;
    }

    const reveal = 0.92 + 0.08 * this.cardRevealT;
    const fit = Math.min(boxW / surface.rect.width, boxH / surface.rect.height);
    const cardScale = fit * this.cardSizeFactor(slot) * reveal;
    const w = surface.rect.width * cardScale;
    const h = surface.rect.height * cardScale;
    const centerX = cx + slot * slotW + dragDx;
    const centerY = cy + dragDy;
    return { x: centerX - w / 2, y: centerY - h / 2, w, h, surface, slot };
  }

  private renderCardOverview(): void {
    this.reconcileCardOrder();
    const availH = this.mobileAvailHeight;
    const chrome = this.chromeColors();

    // Dim backdrop quad.
    const backdropModel = mat4TRS(this.width / 2, availH / 2, -2, 0, 0, 0, this.width, availH, 1);
    this.renderer.drawFlat(backdropModel, this.viewProj, { r: 8 / 255, g: 8 / 255, b: 16 / 255, a: 0.92 });

    const overlayCtx = this.overlay.begin();
    this.overlay.markContent();

    const n = this.mobileCardOrder.length;
    if (n === 0) {
      overlayCtx.fillStyle = '#666680';
      overlayCtx.font = '16px "Spectral", Georgia, serif';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.fillText('No windows', this.width / 2, availH / 2);
      this.drawGestureHandle(overlayCtx);
      return;
    }

    // Draw far-to-near so the centered card sits on top.
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => Math.abs(b - this.mobileCardScroll) - Math.abs(a - this.mobileCardScroll));

    for (const i of order) {
      const r = this.cardDrawRect(i);
      if (!r) continue;
      const { x, y, w, h, surface, slot } = r;
      if (x + w < -40 || x > this.width + 40) continue; // offscreen

      const dist = Math.min(Math.abs(slot), 1.4);
      let alpha = (1 - 0.4 * dist) * this.cardRevealT;
      // Fade a card as it is dragged up to close.
      const drag = this.cardDragState;
      if (drag && drag.surfaceId === surface.id && !drag.reorder && drag.dy < 0) {
        alpha *= Math.max(0, 1 - (-drag.dy) / (h * 0.6));
      }
      alpha = Math.max(0, alpha);
      const isActive = Math.round(this.mobileCardScroll) === i;

      // Real depth: off-center cards recede and turn toward the center.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const zRecede = -Math.min(Math.abs(slot), 2) * 90;
      const yTurn = -Math.max(-1.2, Math.min(1.2, slot)) * 0.32;
      const state = this.glState(surface.id);
      const model = mat4TRS(cx, cy, zRecede, 0, yTurn, 0, w, h, 1);
      state.model = model;

      // Card shadow.
      const pad = 40;
      this.renderer.drawGlow({
        model: mat4TRS(cx, cy + 6, zRecede - 1, 0, yTurn, 0, w + pad * 2, h + pad * 2, 1),
        viewProj: this.viewProj,
        quadWidth: w + pad * 2, quadHeight: h + pad * 2,
        halfWidth: w / 2, halfHeight: h / 2,
        radius: 8,
        color: { r: 0, g: 0, b: 0, a: 0.5 * alpha },
        a1: 1, sigma1: (isActive ? 24 : 12) / 2,
      });

      // Card frame fill behind transparent content (sharp rounded rect via
      // the glow shader with a sub-pixel sigma).
      this.renderer.drawGlow({
        model,
        viewProj: this.viewProj,
        quadWidth: w, quadHeight: h,
        halfWidth: w / 2, halfHeight: h / 2,
        radius: 8,
        color: { r: 13 / 255, g: 13 / 255, b: 20 / 255, a: alpha },
        a1: 1, sigma1: 0.4,
      });

      this.drawSurfaceSlab(surface, state, model, {
        radius: 8,
        dim: 1,
        opacity: alpha,
        rim: isActive ? { ...chrome.glow, a: 0.8 * alpha } : undefined,
      });

      // Title below the card (active card sits unrotated, so 2D chrome aligns).
      overlayCtx.globalAlpha = alpha;
      overlayCtx.fillStyle = isActive ? '#c8c8ff' : '#666680';
      overlayCtx.font = '13px "Spectral", Georgia, serif';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = 'top';
      const label = (surface.title || surface.id.slice(0, 12)).slice(0, 22);
      overlayCtx.fillText(label, x + w / 2, y + h + 8);

      // Close chip on the active card (only if the window may be closed).
      if (isActive && surface.closable) {
        const chip = this.cardCloseChipRect(x, y, w);
        overlayCtx.fillStyle = 'rgba(20,20,34,0.9)';
        overlayCtx.beginPath();
        overlayCtx.arc(chip.cx, chip.cy, chip.r, 0, Math.PI * 2);
        overlayCtx.fill();
        overlayCtx.strokeStyle = '#8b8bff';
        overlayCtx.lineWidth = 1.5;
        overlayCtx.beginPath();
        overlayCtx.moveTo(chip.cx - 4, chip.cy - 4);
        overlayCtx.lineTo(chip.cx + 4, chip.cy + 4);
        overlayCtx.moveTo(chip.cx + 4, chip.cy - 4);
        overlayCtx.lineTo(chip.cx - 4, chip.cy + 4);
        overlayCtx.stroke();
      }
      overlayCtx.globalAlpha = 1;
    }

    this.drawGestureHandle(overlayCtx);
  }

  private cardCloseChipRect(x: number, y: number, w: number): { cx: number; cy: number; r: number } {
    return { cx: x + w - 14, cy: y + 14, r: 12 };
  }

  /**
   * Find surface at a point. Desktop picking casts a ray through the camera
   * and intersects each slab's plane in its local space (so lifted/tilted
   * windows pick exactly), then keeps the existing per-pixel alpha test so
   * transparent pixels pass clicks through.
   */
  surfaceAt(x: number, y: number): Surface | undefined {
    if (this.mobileMode) {
      return this.mobileHitTest(x, y);
    }
    return this.desktopHitTest(x, y);
  }

  /**
   * Convert a viewport (x,y) point to workspace coords. Needed by callers
   * that do their own rect math (e.g., drag-resize hit tests).
   */
  viewportToWorkspace(x: number, y: number): { x: number; y: number } {
    return { x: x + this.scrollX, y: y + this.scrollY };
  }

  /**
   * Find the topmost scene-vocabulary MESH node at a viewport point — the
   * 3D analogue of widget hit-testing. Follows visual order: front-layer
   * world nodes, then each window's subtree meshes and slab top-down
   * (an opaque slab occludes everything beneath it), then back-layer world
   * nodes. Returns the node plus its scope so input can route to the owner.
   */
  nodeAt(x: number, y: number): { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string } | undefined {
    if (this.mobileMode) return undefined;
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);
    const ray = rayFromScreen(x, y, this.width, this.height, this.invViewProj);

    // 1. World nodes above all windows
    const front = this.hitWorldNodes(ray, 'front');
    if (front) return front;

    // 2. Windows top-down: subtree meshes render above their slab
    for (let i = this.sortedSurfaces.length - 1; i >= 0; i--) {
      const surface = this.sortedSurfaces[i];
      if (!surface.visible || !surface.drawn) continue;
      if (this.isWorkspaceFiltered(surface)) continue;

      const state = this.surfaceGl.get(surface.id);
      const { rect } = surface;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const slabModel = state?.model ?? mat4TRS(cx, cy, 0, 0, 0, 0, rect.width, rect.height, 1);

      const frame = mat4TRS(
        cx, cy, (state?.lift ?? 0) + (state?.userZ ?? 0),
        (state?.tiltX ?? 0) + (state?.userRotation?.[0] ?? 0),
        (state?.tiltY ?? 0) + (state?.userRotation?.[1] ?? 0),
        state?.userRotation?.[2] ?? 0,
        1, 1, 1,
      );
      const nodeId = this.hitNodeTree(ray, surface.id, frame);
      if (nodeId) return { scope: 'window', surfaceId: surface.id, nodeId };

      if (surface.inputPassthrough) continue;
      const hit = raySurfaceHit(ray, slabModel, rect.width, rect.height);
      if (!hit) continue;
      try {
        const pixel = surface.ctx.getImageData(
          Math.max(0, Math.min(rect.width - 1, Math.floor(hit.x))),
          Math.max(0, Math.min(rect.height - 1, Math.floor(hit.y))),
          1, 1
        ).data;
        if (pixel[3] === 0) continue;
      } catch { /* tainted — opaque */ }
      // Opaque slab occludes everything beneath; the click belongs to it.
      return undefined;
    }

    // 3. World nodes behind the windows
    return this.hitWorldNodes(ray, 'back');
  }

  private hitWorldNodes(ray: Ray, layer: 'back' | 'front'): { scope: 'world'; ownerId: string; nodeId: string } | undefined {
    const identity = mat4Identity();
    let best: { ownerId: string; nodeId: string; t: number } | undefined;
    for (const key of this.worldKeys) {
      const nodeId = this.hitNodeTree(ray, key, identity, layer, (t, id) => {
        if (!best || t < best.t) best = { ownerId: key.slice('world:'.length), nodeId: id, t };
      });
      void nodeId;
    }
    return best ? { scope: 'world', ownerId: best.ownerId, nodeId: best.nodeId } : undefined;
  }

  /**
   * Ray-test the meshes of one retained node tree. Returns the closest hit
   * node id (or reports hits via `collect` for cross-tree comparison).
   */
  private hitNodeTree(
    ray: Ray,
    key: string,
    frame: Mat4,
    layer?: 'back' | 'front',
    collect?: (t: number, nodeId: string) => void,
  ): string | undefined {
    const nodes = this.sceneStore.nodesForSurface(key);
    if (nodes.length === 0) return undefined;
    let bestId: string | undefined;
    let bestT = Infinity;
    for (const node of nodes) {
      if (node.kind !== 'mesh') continue;
      // Meshes are decorative by default: only those that explicitly opt in with
      // `params.interactive === true` are click/drag/keyboard targets. Without
      // this, a full-window decorative mesh (e.g. a water surface) would ray-
      // intercept every click and starve the window's widgets / input canvas.
      if (node.params.interactive !== true) continue;
      if (layer !== undefined && ((node.params.layer as string) ?? 'back') !== layer) continue;
      const model = this.sceneStore.worldMatrix(node, frame);
      let t: number | null;
      if (hasCustomGeometry(node.params)) {
        const g = node.params.geometry as CustomGeometryParam;
        t = rayCustomMeshHit(ray, model, g.positions, g.indices);
      } else {
        t = rayMeshHit(ray, model, ((node.params.primitive as string) ?? 'box') as 'plane' | 'box' | 'sphere' | 'cylinder');
      }
      if (t === null) continue;
      if (collect) collect(t, node.id);
      if (t < bestT) {
        bestT = t;
        bestId = node.id;
      }
    }
    return bestId;
  }

  /**
   * Find the surface at a viewport point AND the exact surface-local
   * coordinates of the hit (projection-correct even for lifted/tilted
   * slabs). Prefer this over subtracting rect origins.
   */
  surfaceLocalAt(x: number, y: number): { surface: Surface; x: number; y: number } | undefined {
    if (this.mobileMode) {
      const surface = this.mobileHitTest(x, y);
      if (!surface) return undefined;
      const local = this.mobileToSurfaceCoords(x, y);
      return { surface, x: local.x, y: local.y };
    }
    const surface = this.desktopHitTest(x, y);
    if (!surface) return undefined;
    const state = this.surfaceGl.get(surface.id);
    const { rect } = surface;
    const model = state?.model ?? mat4TRS(
      rect.x + rect.width / 2, rect.y + rect.height / 2, 0,
      0, 0, 0, rect.width, rect.height, 1,
    );
    const ray = rayFromScreen(x, y, this.width, this.height, this.invViewProj);
    const hit = raySurfaceHit(ray, model, rect.width, rect.height);
    if (!hit) return undefined;
    return { surface, x: hit.x, y: hit.y };
  }

  private desktopHitTest(viewportX: number, viewportY: number): Surface | undefined {
    // The camera follows scroll; make sure matrices reflect the current state
    // even if no frame has rendered since the last scroll.
    this.clampScroll();
    this.updateCamera(this.scrollX, this.scrollY);
    const ray = rayFromScreen(viewportX, viewportY, this.width, this.height, this.invViewProj);

    // Iterate in reverse z-order (top to bottom)
    for (let i = this.sortedSurfaces.length - 1; i >= 0; i--) {
      const surface = this.sortedSurfaces[i];
      if (!surface.visible || !surface.drawn) continue;
      if (this.isWorkspaceFiltered(surface)) continue;
      if (surface.inputPassthrough) continue;

      const state = this.surfaceGl.get(surface.id);
      const { rect } = surface;
      // The slab's last model matrix (falls back to an untransformed slab
      // for surfaces that haven't rendered yet).
      const model = state?.model ?? mat4TRS(
        rect.x + rect.width / 2, rect.y + rect.height / 2, 0,
        0, 0, 0, rect.width, rect.height, 1,
      );
      const hit = raySurfaceHit(ray, model, rect.width, rect.height);
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

  private mobileHitTest(x: number, y: number): Surface | undefined {
    // The card overview handles its own hit-testing.
    if (this.mobileView === MobileViewState.CARD_OVERVIEW) return undefined;

    // Gesture handle band -- reserved for the swipe-up gesture.
    if (y >= this.height - Compositor.MOBILE_GESTURE_HANDLE_HEIGHT) return undefined;

    // Reverse-transform through mobile scale/offset to get surface-local coords
    const surface = this.mobileFocusedSurfaceId
      ? this.surfaces.get(this.mobileFocusedSurfaceId)
      : this.getTopVisibleSurface();

    if (!surface || !surface.drawn || !surface.visible) return undefined;

    const { scale, offsetX, offsetY } = this.mobileTransform;
    const sx = (x - offsetX) / scale;
    const sy = (y - offsetY) / scale;

    if (sx >= 0 && sx < surface.rect.width && sy >= 0 && sy < surface.rect.height) {
      return surface;
    }
    return undefined;
  }

  /**
   * Transform canvas-space coordinates to surface-local coordinates in mobile mode.
   * Returns [localX, localY] relative to the surface's rect origin.
   */
  mobileToSurfaceCoords(canvasX: number, canvasY: number): { x: number; y: number } {
    const { scale, offsetX, offsetY } = this.mobileTransform;
    return {
      x: (canvasX - offsetX) / scale,
      y: (canvasY - offsetY) / scale,
    };
  }

  /** Current mobile view state, for gesture routing in the frontend. */
  getMobileView(): MobileViewState {
    return this.mobileView;
  }

  /** Whether a point falls within the bottom gesture-handle band. */
  isInGestureHandle(y: number): boolean {
    return this.mobileMode && y >= this.height - Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
  }

  // ── Card overview gesture API ───────────────────────────────────────

  /** Open the card overview, centering the current window. */
  enterCardOverview(): void {
    this.cardAnim?.cancel();
    this.reconcileCardOrder();
    const focusId = this.mobileFocusedSurfaceId ?? this.getTopVisibleSurface()?.id;
    const idx = focusId ? this.mobileCardOrder.indexOf(focusId) : -1;
    this.mobileCardScroll = idx >= 0 ? idx : 0;
    this.mobileView = MobileViewState.CARD_OVERVIEW;
    this.cardDragState = undefined;
    // Subtle scale-in reveal.
    this.cardRevealT = 0;
    this.cardAnim = new Tween({
      from: 0, to: 1, duration: 200, easing: DECELERATE,
      onUpdate: (v) => { this.cardRevealT = v; this.needsRender = true; },
    }).start();
    this.needsRender = true;
  }

  /** Exit the overview, optionally focusing a chosen card. */
  exitCardOverview(focusSurfaceId?: string): void {
    this.cardAnim?.cancel();
    this.cardAnim = undefined;
    this.cardDragState = undefined;
    this.cardRevealT = 1;
    if (focusSurfaceId) {
      this.setMobileFocusSurface(focusSurfaceId);
    }
    this.mobileView = MobileViewState.NATIVE_FIT;
    this.resetMobileZoom();
    this.needsRender = true;
  }

  /** Surface whose card contains (x,y) in the overview, preferring the active card. */
  cardAt(x: number, y: number): string | undefined {
    if (this.mobileView !== MobileViewState.CARD_OVERVIEW) return undefined;
    let best: { id: string; slot: number } | undefined;
    for (let i = 0; i < this.mobileCardOrder.length; i++) {
      const r = this.cardDrawRect(i);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (!best || Math.abs(r.slot) < Math.abs(best.slot)) {
          best = { id: r.surface.id, slot: r.slot };
        }
      }
    }
    return best?.id;
  }

  /** Whether the card overview is allowed to close this surface. */
  isSurfaceClosable(surfaceId: string): boolean {
    return this.surfaces.get(surfaceId)?.closable ?? true;
  }

  /** Surface whose active-card close chip contains (x,y), if any. */
  closeChipAt(x: number, y: number): string | undefined {
    if (this.mobileView !== MobileViewState.CARD_OVERVIEW) return undefined;
    const i = Math.round(this.mobileCardScroll);
    const r = this.cardDrawRect(i);
    if (!r || !r.surface.closable) return undefined;
    const chip = this.cardCloseChipRect(r.x, r.y, r.w);
    if (Math.hypot(x - chip.cx, y - chip.cy) <= chip.r + 4) return r.surface.id;
    return undefined;
  }

  /** Pan the carousel by a canvas-pixel delta (positive dx = drag right). */
  cardDeckPan(dx: number): void {
    const { slotW } = this.cardMetrics();
    const n = this.mobileCardOrder.length;
    this.mobileCardScroll = Math.max(0, Math.min(n - 1, this.mobileCardScroll - dx / slotW));
    this.needsRender = true;
  }

  /** Snap the carousel to the nearest card. */
  cardDeckSnap(): void {
    const target = Math.max(0, Math.min(this.mobileCardOrder.length - 1, Math.round(this.mobileCardScroll)));
    this.animateScroll(target);
  }

  private animateScroll(target: number): void {
    this.cardAnim?.cancel();
    const from = this.mobileCardScroll;
    if (from === target) { this.needsRender = true; return; }
    this.cardAnim = new Tween({
      from, to: target, duration: 220, easing: DECELERATE,
      onUpdate: (v) => { this.mobileCardScroll = v; this.needsRender = true; },
    }).start();
  }

  cardReorderBegin(surfaceId: string): void {
    this.cardDragState = { surfaceId, dx: 0, dy: 0, reorder: true };
    this.needsRender = true;
  }

  /** Drag a reordering card horizontally by accumulated dx; swaps on midpoint crossing. */
  cardReorder(dx: number): void {
    const drag = this.cardDragState;
    if (!drag || !drag.reorder) return;
    drag.dx += dx;
    const { slotW } = this.cardMetrics();
    const idx = this.mobileCardOrder.indexOf(drag.surfaceId);
    if (idx < 0) return;
    if (drag.dx > slotW / 2 && idx < this.mobileCardOrder.length - 1) {
      this.swapCards(idx, idx + 1);
      drag.dx -= slotW;
      this.mobileCardScroll = idx + 1;
    } else if (drag.dx < -slotW / 2 && idx > 0) {
      this.swapCards(idx, idx - 1);
      drag.dx += slotW;
      this.mobileCardScroll = idx - 1;
    }
    this.needsRender = true;
  }

  cardReorderEnd(): void {
    this.cardDragState = undefined;
    this.cardDeckSnap();
  }

  private swapCards(a: number, b: number): void {
    const tmp = this.mobileCardOrder[a];
    this.mobileCardOrder[a] = this.mobileCardOrder[b];
    this.mobileCardOrder[b] = tmp;
  }

  /** Begin a vertical drag on a card (towards flick-to-close). */
  cardCloseDragBegin(surfaceId: string): void {
    this.cardDragState = { surfaceId, dx: 0, dy: 0, reorder: false };
    this.needsRender = true;
  }

  cardCloseDrag(dy: number): void {
    const drag = this.cardDragState;
    if (!drag || drag.reorder) return;
    drag.dy += dy;
    this.needsRender = true;
  }

  /** Whether a vertical close-drag is in progress (so move/end route to close). */
  get cardCloseDragOffset(): number | undefined {
    const drag = this.cardDragState;
    return drag && !drag.reorder ? drag.dy : undefined;
  }

  get cardReorderActive(): boolean {
    return !!this.cardDragState?.reorder;
  }

  /** Animate a card flying off the top, then drop it from the deck. */
  cardFlickClose(surfaceId: string): void {
    const idx = this.mobileCardOrder.indexOf(surfaceId);
    if (idx < 0) return;
    const r = this.cardDrawRect(idx);
    const startDy = (this.cardDragState && this.cardDragState.surfaceId === surfaceId && !this.cardDragState.reorder)
      ? this.cardDragState.dy : 0;
    const flyTo = -(this.mobileAvailHeight + (r ? r.h : 400));
    this.cardDragState = { surfaceId, dx: 0, dy: startDy, reorder: false };
    this.cardAnim?.cancel();
    this.cardAnim = new Tween({
      from: startDy, to: flyTo, duration: 220, easing: ACCELERATE,
      onUpdate: (v) => {
        if (this.cardDragState && this.cardDragState.surfaceId === surfaceId) this.cardDragState.dy = v;
        this.needsRender = true;
      },
      onDone: () => {
        this.mobileCardOrder = this.mobileCardOrder.filter(id => id !== surfaceId);
        this.cardDragState = undefined;
        this.cardDeckSnap();
        this.needsRender = true;
      },
    }).start();
  }

  /** Animate a partially-dragged card back into place. */
  cardSnapBack(surfaceId: string): void {
    const drag = this.cardDragState;
    if (!drag || drag.surfaceId !== surfaceId) { this.cardDragState = undefined; this.needsRender = true; return; }
    const from = drag.dy;
    this.cardAnim?.cancel();
    this.cardAnim = new Tween({
      from, to: 0, duration: 180, easing: DECELERATE,
      onUpdate: (v) => {
        if (this.cardDragState && this.cardDragState.surfaceId === surfaceId) this.cardDragState.dy = v;
        this.needsRender = true;
      },
      onDone: () => { this.cardDragState = undefined; this.needsRender = true; },
    }).start();
  }

  // ── Mobile mode API ─────────────────────────────────────────────────

  /**
   * Apply a pinch-zoom delta. zoomDelta > 1 zooms in, < 1 zooms out.
   * Zoom is clamped: min = 1 (fit-to-screen), max = MOBILE_MAX_ZOOM.
   * Zoom is centered on the pinch midpoint.
   */
  mobilePinchZoom(zoomDelta: number, centerX: number, centerY: number): void {
    if (this.mobileView === MobileViewState.CARD_OVERVIEW) return;
    const surface = this.mobileFocusedSurfaceId
      ? this.surfaces.get(this.mobileFocusedSurfaceId)
      : this.getTopVisibleSurface();
    // Allow pinch up to native 1:1 (which may exceed the default ceiling on small screens).
    const maxZoom = surface
      ? Math.max(Compositor.MOBILE_MAX_ZOOM, this.nativeZoomTarget(surface))
      : Compositor.MOBILE_MAX_ZOOM;

    const oldZoom = this.mobileUserZoom;
    const newZoom = Math.max(1, Math.min(maxZoom, oldZoom * zoomDelta));
    if (newZoom === oldZoom) return;

    this.zoomAbout(newZoom, centerX, centerY, surface);
    this.mobileView = newZoom > 1 ? MobileViewState.NATIVE_ZOOMED : MobileViewState.NATIVE_FIT;
    this.needsRender = true;
  }

  /** Fit-to-screen base scale → the user-zoom factor that yields 1:1 native pixels. */
  private nativeZoomTarget(surface: Surface): number {
    const baseScale = Math.min(this.width / surface.rect.width, this.mobileAvailHeight / surface.rect.height);
    return baseScale > 0 ? 1 / baseScale : 1;
  }

  /** Set zoom while keeping the surface point under (centerX,centerY) fixed. */
  private zoomAbout(newZoom: number, centerX: number, centerY: number, surface: Surface | undefined): void {
    const { scale: oldScale, offsetX: oldOX, offsetY: oldOY } = this.mobileTransform;
    const sx = (centerX - oldOX) / oldScale;
    const sy = (centerY - oldOY) / oldScale;
    this.mobileUserZoom = newZoom;
    if (!surface) return;
    const availW = this.width;
    const availH = this.mobileAvailHeight;
    const baseScale = Math.min(availW / surface.rect.width, availH / surface.rect.height);
    const newScale = baseScale * newZoom;
    const scaledW = surface.rect.width * newScale;
    const scaledH = surface.rect.height * newScale;
    const newCenterX = sx * newScale;
    const newCenterY = sy * newScale;
    this.mobilePanX = centerX - (availW / 2) - (newCenterX - scaledW / 2);
    this.mobilePanY = centerY - (availH / 2) - (newCenterY - scaledH / 2);
  }

  /**
   * Toggle between fit-to-screen and 1:1 native resolution, centered at (x,y).
   * Double-tap entry point.
   */
  mobileToggleNativeZoom(centerX: number, centerY: number): void {
    if (this.mobileView === MobileViewState.CARD_OVERVIEW) return;
    const surface = this.mobileFocusedSurfaceId
      ? this.surfaces.get(this.mobileFocusedSurfaceId)
      : this.getTopVisibleSurface();
    if (!surface) return;

    if (this.mobileView === MobileViewState.NATIVE_ZOOMED) {
      this.resetMobileZoom();
      this.mobileView = MobileViewState.NATIVE_FIT;
    } else {
      this.zoomAbout(this.nativeZoomTarget(surface), centerX, centerY, surface);
      this.mobileView = MobileViewState.NATIVE_ZOOMED;
    }
    this.needsRender = true;
  }

  /**
   * Pan the zoomed view by a delta in canvas pixels (single-finger when zoomed).
   */
  mobilePan(dx: number, dy: number): void {
    if (this.mobileView !== MobileViewState.NATIVE_ZOOMED && this.mobileUserZoom <= 1) return;
    this.mobilePanX += dx;
    this.mobilePanY += dy;
    this.needsRender = true;
  }

  /**
   * Reset zoom and pan (called when switching windows).
   */
  private resetMobileZoom(): void {
    this.mobileUserZoom = 1;
    this.mobilePanX = 0;
    this.mobilePanY = 0;
  }

  setMobileMode(enabled: boolean): void {
    this.mobileMode = enabled;
    this.resetMobileZoom();
    this.mobileView = MobileViewState.NATIVE_FIT;
    this.needsRender = true;
  }

  getMobileMode(): boolean {
    return this.mobileMode;
  }

  setMobileFocusSurface(surfaceId: string): void {
    this.mobileFocusedSurfaceId = surfaceId;
    this.resetMobileZoom();
    if (this.mobileView !== MobileViewState.CARD_OVERVIEW) {
      this.mobileView = MobileViewState.NATIVE_FIT;
    }
    this.needsRender = true;
  }

  private getMobileVisibleSurfaces(): Surface[] {
    return this.sortedSurfaces.filter(s =>
      s.visible && s.drawn && !s.inputPassthrough && !this.isWorkspaceFiltered(s)
    );
  }

  private getTopVisibleSurface(): Surface | undefined {
    const visible = this.getMobileVisibleSurfaces();
    return visible.length > 0 ? visible[visible.length - 1] : undefined;
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
