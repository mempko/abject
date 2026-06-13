/**
 * Overlay2D — a viewport-sized 2D canvas composited as the final pass over
 * the 3D scene. Screen-space chrome that wants the browser's text and
 * vector rasterizer (scrollbars, mobile card titles, close chips, gesture
 * handle, empty states) draws here with ordinary canvas code and uploads
 * as one texture only when something changed.
 */

import { GlRenderer } from './renderer.js';

export class Overlay2D {
  private canvas: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  private texture: WebGLTexture;
  private dirty = false;
  private hasContent = false;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  constructor(private renderer: GlRenderer) {
    this.canvas = new OffscreenCanvas(1, 1);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = renderer.createTexture();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.dirty = true;
  }

  /** Begin a chrome redraw; returns a ctx already scaled to CSS pixels. */
  begin(): OffscreenCanvasRenderingContext2D {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this.dpr, this.dpr);
    this.dirty = true;
    this.hasContent = false;
    return ctx;
  }

  /** Mark that the redraw produced visible content (skip the draw call otherwise). */
  markContent(): void {
    this.hasContent = true;
  }

  /** Composite the overlay if it has content; uploads only when dirty. */
  draw(): void {
    if (!this.hasContent) return;
    if (this.dirty) {
      this.renderer.uploadTexture(this.texture, this.canvas);
      this.dirty = false;
    }
    this.renderer.drawOverlay(this.texture);
  }

  /** Force re-upload (e.g. after GL context restore). */
  invalidate(): void {
    this.dirty = true;
  }

  get width(): number { return this.cssWidth; }
  get height(): number { return this.cssHeight; }
}
