/**
 * Canvas-based compositor for rendering object surfaces.
 */

import { AbjectId } from '../core/types.js';
import { require, ensure } from '../core/contracts.js';

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
  workspaceId?: string;  // undefined = always visible (global objects)
}

export interface DrawCommand {
  type: 'rect' | 'text' | 'line' | 'image' | 'imageUrl' | 'clear' | 'path' | 'save' | 'restore' | 'clip' | 'translate'
    | 'circle' | 'arc' | 'ellipse' | 'polygon' | 'rotate' | 'scale'
    | 'globalAlpha' | 'shadow' | 'setLineDash' | 'linearGradient' | 'radialGradient';
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
}

export interface LineParams {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: string;
  lineWidth?: number;
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
  private imageCache: Map<string, { img: HTMLImageElement; loaded: boolean }> = new Map();
  private static IMAGE_CACHE_MAX = 100;

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
    inputMonitor = false
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
          ctx.fillText(p.text, p.x, p.y);
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke;
          ctx.lineWidth = p.strokeWidth ?? 1;
          ctx.strokeText(p.text, p.x, p.y);
        }
        if (!p.fill && !p.stroke) {
          ctx.fillStyle = '#000';
          ctx.fillText(p.text, p.x, p.y);
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
          const img = new Image();
          img.crossOrigin = 'anonymous';
          const entry = { img, loaded: false };
          this.imageCache.set(p.url, entry);
          img.onload = () => {
            entry.loaded = true;
            this.needsRender = true;
          };
          img.onerror = () => {
            // Remove failed entries so they can be retried
            this.imageCache.delete(p.url);
          };
          img.src = p.url;
        }
        // If cached but not yet loaded, skip — will render on next frame when load completes
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
    }

    surface.dirty = true;
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
    radius: number
  ): void {
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

    // Draw surfaces in z-order
    for (const surface of this.sortedSurfaces) {
      if (!surface.visible) continue;
      if (this.isWorkspaceFiltered(surface)) continue;

      this.ctx.drawImage(
        surface.canvas,
        surface.rect.x,
        surface.rect.y,
        surface.rect.width,
        surface.rect.height
      );
    }
  }

  /**
   * Find surface at a point.
   */
  surfaceAt(x: number, y: number): Surface | undefined {
    // Iterate in reverse z-order (top to bottom)
    for (let i = this.sortedSurfaces.length - 1; i >= 0; i--) {
      const surface = this.sortedSurfaces[i];
      if (!surface.visible) continue;
      if (this.isWorkspaceFiltered(surface)) continue;
      if (surface.inputPassthrough) continue;

      const { rect } = surface;
      if (
        x >= rect.x &&
        x < rect.x + rect.width &&
        y >= rect.y &&
        y < rect.y + rect.height
      ) {
        // Transparent pixels pass input through to surfaces below
        const pixel = surface.ctx.getImageData(
          Math.floor(x - rect.x),
          Math.floor(y - rect.y),
          1, 1
        ).data;
        if (pixel[3] === 0) continue;

        return surface;
      }
    }
    return undefined;
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
