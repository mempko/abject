/**
 * Canvas-based compositor for rendering object surfaces.
 */

import { AbjectId } from '../core/types.js';
import { require, ensure } from '../core/contracts.js';
import { Tween, DECELERATE, ACCELERATE } from './motion.js';

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
  drawn: boolean;        // false until first draw batch; prevents rendering empty surfaces
  transparent: boolean;  // window paints no background; skip the focus-glow halo (it would bleed through)
  closable: boolean;     // mobile card overview may flick this closed (false for system rails)
  workspaceId?: string;  // undefined = always visible (global objects)
  title?: string;        // window title for mobile tab bar
}

export interface DrawCommand {
  type: 'rect' | 'text' | 'line' | 'image' | 'imageUrl' | 'clear' | 'path' | 'save' | 'restore' | 'clip' | 'translate'
    | 'circle' | 'arc' | 'ellipse' | 'polygon' | 'rotate' | 'scale'
    | 'globalAlpha' | 'shadow' | 'setLineDash' | 'linearGradient' | 'radialGradient'
    | 'bezierCurve' | 'quadraticCurve';
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
  data: ImageBitmap | HTMLImageElement | ImageData;
}

export interface ImageUrlParams {
  x: number;
  y: number;
  width?: number;
  height?: number;
  url: string;
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
  radius: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface ArcParams {
  cx: number;
  cy: number;
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
  radiusX: number;
  radiusY: number;
  rotation?: number;
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
 * The compositor manages surfaces and renders them to a canvas.
 */
export class Compositor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private surfaces: Map<string, Surface> = new Map();
  private sortedSurfaces: Surface[] = [];
  private animationFrameId?: number;
  private needsRender = false;
  private activeWorkspaceId?: string;
  // Focused window gets a soft accent halo drawn behind it (on the desktop, so
  // it extends beyond the window edges and content can't cover it).
  private focusedSurfaceId?: string;
  private focusGlowColor = 'rgba(91, 229, 160, 0.55)'; // Arcane rune-green default
  private focusGlowRadius = 7; // window corner radius, so the halo matches the window
  private imageCache: Map<string, { img: HTMLImageElement; loaded: boolean }> = new Map();
  private static IMAGE_CACHE_MAX = 100;
  private liveDataImages: Map<string, { img: HTMLImageElement; width: number; height: number }> = new Map();

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
    const ctx = canvas.getContext('2d');
    require(ctx !== null, 'Failed to get 2D context');
    this.ctx = ctx!;

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

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);

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
      this.sortSurfaces();
      this.needsRender = true;
    }
    return deleted;
  }

  /**
   * Destroy all surfaces. Used when reconnecting to backend.
   */
  clearAllSurfaces(): void {
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
  }

  /**
   * Capture the entire desktop as a base64-encoded PNG.
   */
  captureDesktop(): { imageBase64: string; width: number; height: number } {
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
      surface.rect.x = x;
      surface.rect.y = y;
      this.needsRender = true;
    }
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

  /**
   * Draw a soft accent halo around a focused window's rect, on the desktop
   * canvas (in workspace coords — caller has already applied the scroll
   * translate). Drawn before the surface image so window content covers the
   * inward spill, leaving the outward halo visible beyond the window edges.
   */
  private drawFocusGlow(rect: Rect): void {
    const ctx = this.ctx;
    // Pure BLOOM (no ring line): fill the window silhouette inset behind the
    // window and show only its outward shadow. Two passes — a tight bright halo
    // hugging the edge plus a soft wider falloff — so it reads as a real glow
    // around the single window border, not a second outline.
    // Match the window's silhouette (its corner radius, hugged with a 1px inset)
    // so the bloom is uniform on the edges AND the corners.
    const inset = 1;
    const x = rect.x + inset;
    const y = rect.y + inset;
    const w = rect.width - inset * 2;
    const h = rect.height - inset * 2;
    if (w <= 0 || h <= 0) return;
    const radius = Math.max(0, Math.min(this.focusGlowRadius, w / 2, h / 2));
    ctx.save();
    ctx.fillStyle = this.focusGlowColor;
    ctx.shadowColor = this.focusGlowColor;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
    ctx.globalAlpha = 0.5;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.restore();
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

  /**
   * Execute a draw command on a surface.
   */
  draw(command: DrawCommand): void {
    const surface = this.surfaces.get(command.surfaceId);
    if (!surface) {
      return;
    }

    const ctx = surface.ctx;

    switch (command.type) {
      case 'clear': {
        // Fully reset canvas state to prevent leaks from a previous frame's
        // unbalanced save/restore (e.g. a child render that errored mid-draw,
        // leaving residual translate/clip on the context). Without this, clearRect
        // operates in the wrong coordinate space and fails to clear the full surface.
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
        const p = command.params as { color?: string };
        if (p?.color) {
          ctx.fillStyle = p.color;
          ctx.fillRect(0, 0, surface.rect.width, surface.rect.height);
        }
        break;
      }

      case 'rect': {
        const p = command.params as RectParams;
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
        if (p.width && p.height) {
          ctx.drawImage(p.data as CanvasImageSource, p.x, p.y, p.width, p.height);
        } else {
          ctx.drawImage(p.data as CanvasImageSource, p.x, p.y);
        }
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
            if (p.width && p.height) {
              ctx.drawImage(cachedData.img, p.x, p.y, p.width, p.height);
            } else {
              ctx.drawImage(cachedData.img, p.x, p.y);
            }
            break;
          }

          // Live-screenshot fallback: show the previous data URI synchronously
          // while the new one decodes. Prevents blank flash on surfaces that
          // continually swap data URIs (remote views, etc.).
          const live = this.liveDataImages.get(sid);
          if (live) {
            if (p.width && p.height) {
              ctx.drawImage(live.img, p.x, p.y, p.width, p.height);
            } else {
              ctx.drawImage(live.img, p.x, p.y);
            }
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
              if (p.width && p.height) {
                surf.ctx.drawImage(img, p.x, p.y, p.width, p.height);
              } else {
                surf.ctx.drawImage(img, p.x, p.y);
              }
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
            if (p.width && p.height) {
              ctx.drawImage(cached.img, p.x, p.y, p.width, p.height);
            } else {
              ctx.drawImage(cached.img, p.x, p.y);
            }
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
                if (p.width && p.height) {
                  surf.ctx.drawImage(image, p.x, p.y, p.width, p.height);
                } else {
                  surf.ctx.drawImage(image, p.x, p.y);
                }
                surf.ctx.restore();
                surf.dirty = true;
              }
              this.needsRender = true;
            };
            entry.img.crossOrigin = 'anonymous';
            entry.img.onload = () => drawToSurface(entry.img);
            entry.img.onerror = () => {
              const fallback = new Image();
              fallback.onload = () => drawToSurface(fallback);
              fallback.onerror = () => this.imageCache.delete(p.url);
              fallback.src = p.url;
            };
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
        const p = command.params as RectParams;
        ctx.beginPath();
        ctx.rect(p.x, p.y, p.width, p.height);
        ctx.clip();
        break;
      }

      case 'translate': {
        const p = command.params as { x: number; y: number };
        ctx.translate(p.x ?? 0, p.y ?? 0);
        break;
      }

      case 'circle': {
        const p = command.params as CircleParams;
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, p.radius, 0, Math.PI * 2);
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
        ctx.beginPath();
        if (p.fill) {
          ctx.moveTo(p.cx, p.cy);
        }
        ctx.arc(p.cx, p.cy, p.radius, p.startAngle, p.endAngle, p.counterclockwise ?? false);
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
        ctx.beginPath();
        ctx.ellipse(p.cx, p.cy, p.radiusX, p.radiusY, p.rotation ?? 0, 0, Math.PI * 2);
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
        const p = command.params as { alpha: number };
        ctx.globalAlpha = p.alpha;
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
        const p = command.params as { segments: number[] };
        ctx.setLineDash(p.segments);
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
    }

    surface.dirty = true;
    surface.drawn = true;
    this.needsRender = true;
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
      if (this.needsRender) {
        this.render();
        this.needsRender = false;
      }
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.animationFrameId = requestAnimationFrame(render);
  }

  /**
   * Stop the render loop.
   */
  stop(): void {
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Render all surfaces to the main canvas.
   */
  private render(): void {
    // Clear main canvas
    this.ctx.clearRect(
      0,
      0,
      this.canvas.width / (window.devicePixelRatio || 1),
      this.canvas.height / (window.devicePixelRatio || 1)
    );

    if (this.mobileMode) {
      this.renderMobile();
    } else {
      this.renderDesktop();
    }
  }

  private renderDesktop(): void {
    this.clampScroll();

    this.ctx.save();
    this.ctx.translate(-this.scrollX, -this.scrollY);
    for (const surface of this.sortedSurfaces) {
      if (!surface.visible || !surface.drawn) continue;
      if (this.isWorkspaceFiltered(surface)) continue;

      // Skip the focus-glow halo for transparent windows: the glow fills the
      // window silhouette behind the surface, which would bleed through a
      // surface that paints no background of its own (e.g. toasts).
      if (surface.id === this.focusedSurfaceId && !surface.transparent) {
        this.drawFocusGlow(surface.rect);
      }

      this.ctx.drawImage(
        surface.canvas,
        surface.rect.x,
        surface.rect.y,
        surface.rect.width,
        surface.rect.height
      );
    }
    this.ctx.restore();

    this.renderScrollbars();
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

  private renderScrollbars(): void {
    const ws = this.getWorkspaceSize();
    const needH = ws.width > this.width;
    const needV = ws.height > this.height;
    if (!needH && !needV) return;

    const SZ = Compositor.SCROLLBAR_SIZE;
    const M = Compositor.SCROLLBAR_MARGIN;
    this.ctx.save();

    if (needV) {
      // Track
      this.ctx.fillStyle = 'rgba(0,0,0,0.25)';
      this.ctx.fillRect(this.width - SZ - M, M, SZ, this.height - 2 * M - (needH ? SZ + M : 0));
      // Thumb
      const trackH = this.height - 2 * M - (needH ? SZ + M : 0);
      const thumbH = Math.max(24, (this.height / ws.height) * trackH);
      const thumbY = M + (this.scrollY / (ws.height - this.height)) * (trackH - thumbH);
      this.ctx.fillStyle = 'rgba(180,180,200,0.6)';
      this.scrollbarThumbPath(this.width - SZ - M, thumbY, SZ, thumbH, 4);
      this.ctx.fill();
    }
    if (needH) {
      this.ctx.fillStyle = 'rgba(0,0,0,0.25)';
      this.ctx.fillRect(M, this.height - SZ - M, this.width - 2 * M - (needV ? SZ + M : 0), SZ);
      const trackW = this.width - 2 * M - (needV ? SZ + M : 0);
      const thumbW = Math.max(24, (this.width / ws.width) * trackW);
      const thumbX = M + (this.scrollX / (ws.width - this.width)) * (trackW - thumbW);
      this.ctx.fillStyle = 'rgba(180,180,200,0.6)';
      this.scrollbarThumbPath(thumbX, this.height - SZ - M, thumbW, SZ, 4);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  private scrollbarThumbPath(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
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
    if (this.mobileView === MobileViewState.CARD_OVERVIEW) {
      this.renderCardOverview();
      this.renderGestureHandle();
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

      // Clip to content area (above the gesture handle)
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(0, 0, availW, availH);
      this.ctx.clip();
      this.ctx.translate(offsetX, offsetY);
      this.ctx.scale(scale, scale);
      this.ctx.drawImage(surface.canvas, 0, 0, surface.rect.width, surface.rect.height);
      this.ctx.restore();
    }

    this.renderGestureHandle();
  }

  /** Slim centered pill hinting the swipe-up-from-bottom gesture. */
  private renderGestureHandle(): void {
    const h = Compositor.MOBILE_GESTURE_HANDLE_HEIGHT;
    const y = this.height - h / 2;
    const pillW = 120;
    const pillH = 4;
    const x = (this.width - pillW) / 2;
    this.ctx.save();
    this.ctx.fillStyle = this.mobileView === MobileViewState.CARD_OVERVIEW
      ? 'rgba(139,139,255,0.6)'
      : 'rgba(160,160,190,0.4)';
    this.roundRectPath(x, y - pillH / 2, pillW, pillH, pillH / 2);
    this.ctx.fill();
    this.ctx.restore();
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

    // Dim backdrop.
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(8,8,16,0.92)';
    this.ctx.fillRect(0, 0, this.width, availH);
    this.ctx.restore();

    const n = this.mobileCardOrder.length;
    if (n === 0) {
      this.ctx.save();
      this.ctx.fillStyle = '#666680';
      this.ctx.font = '16px "Spectral", Georgia, serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText('No windows', this.width / 2, availH / 2);
      this.ctx.restore();
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
      const isActive = Math.round(this.mobileCardScroll) === i;

      this.ctx.save();
      this.ctx.globalAlpha = Math.max(0, alpha);

      // Card frame + shadow.
      this.ctx.shadowColor = 'rgba(0,0,0,0.5)';
      this.ctx.shadowBlur = isActive ? 24 : 12;
      this.ctx.shadowOffsetY = 6;
      this.ctx.fillStyle = '#0d0d14';
      this.roundRectPath(x, y, w, h, 8);
      this.ctx.fill();
      this.ctx.shadowColor = 'transparent';
      this.ctx.shadowBlur = 0;

      // Live snapshot, clipped to rounded card.
      this.ctx.save();
      this.roundRectPath(x, y, w, h, 8);
      this.ctx.clip();
      this.ctx.drawImage(
        surface.canvas,
        0, 0, surface.rect.width, surface.rect.height,
        x, y, w, h,
      );
      this.ctx.restore();

      // Accent border on the active card.
      if (isActive) {
        this.ctx.strokeStyle = 'rgba(139,139,255,0.8)';
        this.ctx.lineWidth = 2;
        this.roundRectPath(x, y, w, h, 8);
        this.ctx.stroke();
      }

      // Title below the card.
      this.ctx.fillStyle = isActive ? '#c8c8ff' : '#666680';
      this.ctx.font = '13px "Spectral", Georgia, serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'top';
      const label = (surface.title || surface.id.slice(0, 12)).slice(0, 22);
      this.ctx.fillText(label, x + w / 2, y + h + 8);

      // Close chip on the active card (only if the window may be closed).
      if (isActive && surface.closable) {
        const chip = this.cardCloseChipRect(x, y, w);
        this.ctx.fillStyle = 'rgba(20,20,34,0.9)';
        this.ctx.beginPath();
        this.ctx.arc(chip.cx, chip.cy, chip.r, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.strokeStyle = '#8b8bff';
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(chip.cx - 4, chip.cy - 4);
        this.ctx.lineTo(chip.cx + 4, chip.cy + 4);
        this.ctx.moveTo(chip.cx + 4, chip.cy - 4);
        this.ctx.lineTo(chip.cx - 4, chip.cy + 4);
        this.ctx.stroke();
      }

      this.ctx.restore();
    }
  }

  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    this.ctx.beginPath();
    this.ctx.moveTo(x + rr, y);
    this.ctx.arcTo(x + w, y, x + w, y + h, rr);
    this.ctx.arcTo(x + w, y + h, x, y + h, rr);
    this.ctx.arcTo(x, y + h, x, y, rr);
    this.ctx.arcTo(x, y, x + w, y, rr);
    this.ctx.closePath();
  }

  private cardCloseChipRect(x: number, y: number, w: number): { cx: number; cy: number; r: number } {
    return { cx: x + w - 14, cy: y + 14, r: 12 };
  }

  /**
   * Find surface at a point.
   */
  surfaceAt(x: number, y: number): Surface | undefined {
    if (this.mobileMode) {
      return this.mobileHitTest(x, y);
    }
    // Translate viewport coords → workspace coords
    return this.desktopHitTest(x + this.scrollX, y + this.scrollY);
  }

  /**
   * Convert a viewport (x,y) point to workspace coords. Needed by callers
   * that do their own rect math (e.g., drag-resize hit tests).
   */
  viewportToWorkspace(x: number, y: number): { x: number; y: number } {
    return { x: x + this.scrollX, y: y + this.scrollY };
  }

  private desktopHitTest(x: number, y: number): Surface | undefined {
    // Iterate in reverse z-order (top to bottom)
    for (let i = this.sortedSurfaces.length - 1; i >= 0; i--) {
      const surface = this.sortedSurfaces[i];
      if (!surface.visible || !surface.drawn) continue;
      if (this.isWorkspaceFiltered(surface)) continue;
      if (surface.inputPassthrough) continue;

      const { rect } = surface;
      if (
        x >= rect.x &&
        x < rect.x + rect.width &&
        y >= rect.y &&
        y < rect.y + rect.height
      ) {
        // Transparent pixels pass input through to surfaces below.
        // getImageData throws on tainted canvases (cross-origin images
        // loaded without CORS); treat those surfaces as fully opaque.
        try {
          const pixel = surface.ctx.getImageData(
            Math.floor(x - rect.x),
            Math.floor(y - rect.y),
            1, 1
          ).data;
          if (pixel[3] === 0) continue;
        } catch {
          // Canvas tainted by cross-origin image — treat as opaque
        }

        return surface;
      }
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
