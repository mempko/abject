/**
 * FrontendClient — Thin browser client that owns the Canvas/Compositor.
 *
 * Receives draw/surface commands from BackendUI over WebSocket and renders
 * them locally. Captures input events and sends them back to the backend.
 * Handles measureText and displayInfo requests locally.
 */

import { Compositor, DrawCommand } from '../src/ui/compositor.js';
import type { AbjectId } from '../src/core/types.js';
import type {
  BackendToFrontendMsg,
  FrontendToBackendMsg,
  CreateSurfaceMsg,
  DrawMsg,
  SetSelectedTextMsg,
  StartWindowDragMsg,
  AuthResultMsg,
} from '../server/ws-protocol.js';

/**
 * The thin browser frontend that owns the Canvas and Compositor.
 */
/** Fonts to pre-measure for server-side text width computation */
const MEASURED_FONTS = [
  '14px "Inter", system-ui, sans-serif',   // WIDGET_FONT
  '600 13px "Inter", system-ui, sans-serif', // TITLE_FONT
  '13px "JetBrains Mono", "Fira Code", monospace', // CODE_FONT
  '14px system-ui',                         // legacy WIDGET_FONT
];

export class FrontendClient {
  private compositor: Compositor;
  private canvas: HTMLCanvasElement;
  private ws: WebSocket | null = null;
  private focusedSurface?: string;
  private grabbedSurface?: string;
  private currentSelectedText = '';
  private authenticated = false;
  private loginFormHandler: ((e: Event) => void) | null = null;
  private pendingMouseMove: FrontendToBackendMsg | null = null;
  private mouseMoveRafId = 0;
  private reconnectAttempt = 0;
  // Stay at 200ms for many attempts to catch tsx --watch restarts quickly,
  // then back off to 1s. ECONNREFUSED returns instantly on localhost so
  // fast retries don't waste resources.
  private static readonly RECONNECT_DELAYS = [100, 100, 200, 200, 200, 200, 200, 200, 200, 200, 500, 1000];
  /** Client-side drag state for zero-latency window moves */
  private localDragState?: {
    surfaceId: string;
    dragType: 'move' | 'resize';
    startX: number;
    startY: number;
    startSurfaceX: number;
    startSurfaceY: number;
  };
  /** Track last canvas-space mouse position for drag start */
  private lastCanvasX = 0;
  private lastCanvasY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.compositor = new Compositor(canvas);
    this.setupInputListeners();
  }

  /**
   * Connect to the backend WebSocket server.
   */
  connect(url: string): void {
    const t0 = performance.now();
    const clog = (msg: string) => console.log(`[WS-CLIENT T+${Math.round(performance.now() - t0)}ms] ${msg}`);

    clog(`new WebSocket(${url})`);
    this.ws = new WebSocket(url);
    clog('WebSocket constructor returned');
    this.authenticated = false;

    // Abort stuck TCP connections quickly — browser default timeout is ~5s
    const connectTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        clog('connect timeout (500ms), aborting');
        this.ws.close();
      }
    }, 500);

    this.ws.onopen = () => {
      clearTimeout(connectTimeout);
      clog('onopen fired');
      console.log('[Frontend] Connected to backend');
      this.reconnectAttempt = 0;
      // Clear stale surfaces from any previous connection before replaying state
      this.compositor.clearAllSurfaces();
      this.focusedSurface = undefined;
      this.grabbedSurface = undefined;
      this.localDragState = undefined;
      // Don't send ready yet — wait for auth status from server
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);

        // Handle auth protocol before authenticated
        if (!this.authenticated) {
          this.handleAuthMessage(msg);
          return;
        }

        // Backend may send a single message or a batched array
        if (Array.isArray(msg)) {
          for (const m of msg) {
            this.handleBackendMessage(m as BackendToFrontendMsg);
          }
        } else {
          this.handleBackendMessage(msg as BackendToFrontendMsg);
        }
      } catch (err) {
        console.error('[Frontend] Failed to parse backend message:', err);
      }
    };

    this.ws.onclose = (ev) => {
      clearTimeout(connectTimeout);
      clog(`onclose fired (code=${ev.code})`);
      console.log(`[Frontend] Disconnected from backend (code=${ev.code})`);
      this.ws = null;
      this.authenticated = false;

      // Auto-reconnect with progressive delay (100ms → 200ms → 500ms → 1000ms)
      const delays = FrontendClient.RECONNECT_DELAYS;
      const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
      this.reconnectAttempt++;
      setTimeout(() => {
        console.log(`[Frontend] Reconnecting (attempt ${this.reconnectAttempt}, delay ${delay}ms)...`);
        this.connect(url);
      }, delay);
    };

    this.ws.onerror = (err) => {
      clog('onerror fired');
      console.error('[Frontend] WebSocket error:', err);
    };
  }

  /**
   * Disconnect from the backend.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /**
   * Stop the compositor render loop.
   */
  stop(): void {
    this.compositor.stop();
  }

  // ── Auth handling ────────────────────────────────────────────────────

  private handleAuthMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'authNotRequired':
        this.authenticated = true;
        this.hideLoginForm();
        this.sendFontMetricsWhenReady();
        break;

      case 'authRequired': {
        // Try stored session token first
        const token = localStorage.getItem('abjects_auth_token');
        if (token) {
          this.sendRaw({ type: 'auth', token });
        } else {
          this.showLoginForm();
        }
        break;
      }

      case 'authResult': {
        const result = msg as unknown as AuthResultMsg;
        if (result.success && result.token) {
          localStorage.setItem('abjects_auth_token', result.token);
          this.authenticated = true;
          this.hideLoginForm();
          this.sendFontMetricsWhenReady();
        } else {
          // Token was rejected — clear it and show form
          localStorage.removeItem('abjects_auth_token');
          this.showLoginForm(result.error as string | undefined);
        }
        break;
      }
    }
  }

  private showLoginForm(error?: string): void {
    const overlay = document.getElementById('login-overlay');
    const errorEl = document.getElementById('login-error');
    const form = document.getElementById('login-form') as HTMLFormElement | null;
    if (!overlay || !form) return;

    overlay.classList.add('visible');
    if (errorEl) errorEl.textContent = error ?? '';

    // Remove previous handler if any
    if (this.loginFormHandler) {
      form.removeEventListener('submit', this.loginFormHandler);
    }

    this.loginFormHandler = (e: Event) => {
      e.preventDefault();
      const username = (document.getElementById('login-user') as HTMLInputElement).value;
      const password = (document.getElementById('login-pass') as HTMLInputElement).value;
      if (errorEl) errorEl.textContent = '';
      this.sendRaw({ type: 'auth', username, password });
    };
    form.addEventListener('submit', this.loginFormHandler);
  }

  private hideLoginForm(): void {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.classList.remove('visible');
    if (this.loginFormHandler) {
      const form = document.getElementById('login-form');
      form?.removeEventListener('submit', this.loginFormHandler);
      this.loginFormHandler = null;
    }
  }

  /**
   * Measure character widths for all known fonts and send to backend.
   * This lets the server compute text widths locally without round-trips.
   */
  private sendFontMetrics(): void {
    const metrics: Record<string, Record<string, number>> = {};
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d')!;

    for (const font of MEASURED_FONTS) {
      ctx.font = font;
      const charWidths: Record<string, number> = {};
      // Measure printable ASCII (32-126)
      for (let code = 32; code <= 126; code++) {
        const ch = String.fromCharCode(code);
        charWidths[ch] = ctx.measureText(ch).width;
      }
      metrics[font] = charWidths;
    }

    this.sendRaw({ type: 'fontMetrics', metrics });
  }

  /**
   * Wait for web fonts to finish loading, then send metrics and ready.
   * Without this, measurements use the system-ui fallback and the first
   * render frame has wrong glyph widths / visually different font weight.
   */
  private sendFontMetricsWhenReady(): void {
    document.fonts.ready.then(() => {
      this.sendFontMetrics();
      this.sendRaw({ type: 'ready' });
    });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Backend message handling ──────────────────────────────────────────

  private handleBackendMessage(msg: BackendToFrontendMsg): void {
    switch (msg.type) {
      case 'createSurface':
        this.handleCreateSurface(msg as CreateSurfaceMsg);
        break;

      case 'destroySurface':
        this.compositor.destroySurface(msg.surfaceId);
        break;

      case 'draw':
        this.handleDraw(msg as DrawMsg);
        break;

      case 'moveSurface':
        // Ignore server-side move if we're locally dragging this surface
        if (this.localDragState && this.localDragState.surfaceId === msg.surfaceId) break;
        this.compositor.moveSurface(msg.surfaceId, msg.x, msg.y);
        break;

      case 'resizeSurface':
        this.compositor.resizeSurface(msg.surfaceId, msg.width, msg.height);
        break;

      case 'setZIndex':
        this.compositor.setZIndex(msg.surfaceId, msg.zIndex);
        break;

      case 'setFocused':
        this.focusedSurface = msg.surfaceId;
        break;

      case 'measureTextRequest':
        this.handleMeasureTextRequest(msg.requestId!, msg.surfaceId, msg.text, msg.font);
        break;

      case 'displayInfoRequest':
        this.handleDisplayInfoRequest(msg.requestId!);
        break;

      case 'setSelectedText':
        this.currentSelectedText = (msg as SetSelectedTextMsg).text;
        break;

      case 'setSurfaceVisible':
        this.compositor.setVisible(msg.surfaceId, msg.visible);
        break;

      case 'setSurfaceWorkspace':
        this.compositor.setSurfaceWorkspace(msg.surfaceId, msg.workspaceId);
        break;

      case 'setActiveWorkspace':
        this.compositor.setActiveWorkspace(msg.workspaceId);
        break;

      case 'clipboardWrite':
        navigator.clipboard.writeText(msg.text).catch(err =>
          console.warn('[Frontend] Clipboard write failed:', err)
        );
        break;

      case 'startWindowDrag':
        this.handleStartWindowDrag(msg as StartWindowDragMsg);
        break;
    }
  }

  private handleCreateSurface(msg: CreateSurfaceMsg): void {
    this.compositor.createSurface(
      msg.objectId as AbjectId,
      msg.rect,
      msg.zIndex,
      msg.surfaceId,
      msg.inputPassthrough ?? false
    );

    this.sendToBackend({
      type: 'surfaceCreated',
      surfaceId: msg.surfaceId,
    });
  }

  private handleDraw(msg: DrawMsg): void {
    for (const cmd of msg.commands) {
      this.compositor.draw(cmd as DrawCommand);
    }
  }

  private handleStartWindowDrag(msg: StartWindowDragMsg): void {
    if (msg.dragType === 'move') {
      // Enter client-side local drag mode for zero-latency window moves
      const surface = this.compositor.getSurface(msg.surfaceId);
      if (!surface) return;
      this.localDragState = {
        surfaceId: msg.surfaceId,
        dragType: 'move',
        startX: this.lastCanvasX,
        startY: this.lastCanvasY,
        startSurfaceX: surface.rect.x,
        startSurfaceY: surface.rect.y,
      };
    }
    // For resize drags: no local handling — server sends moveSurface/resizeSurface
  }

  private handleMouseUp(e: MouseEvent): void {
    // If in local move drag, send final position to server and clean up
    if (this.localDragState && this.localDragState.dragType === 'move') {
      const surface = this.compositor.getSurface(this.localDragState.surfaceId);
      if (surface) {
        this.sendToBackend({
          type: 'endWindowDrag',
          surfaceId: this.localDragState.surfaceId,
          x: surface.rect.x,
          y: surface.rect.y,
        } as FrontendToBackendMsg);
      }
      this.localDragState = undefined;
      this.grabbedSurface = undefined;
      return;
    }

    // Normal mouseup path
    this.handleMouseEvent(e, 'mouseup');
  }

  private handleMeasureTextRequest(
    requestId: string,
    surfaceId: string,
    text: string,
    font: string
  ): void {
    let width = 0;
    const surface = this.compositor.getSurface(surfaceId);
    if (surface && text) {
      surface.ctx.font = font;
      width = surface.ctx.measureText(text).width;
    }

    this.sendToBackend({
      type: 'measureTextReply',
      requestId,
      width,
    });
  }

  private handleDisplayInfoRequest(requestId: string): void {
    this.sendToBackend({
      type: 'displayInfoReply',
      requestId,
      width: this.compositor.width,
      height: this.compositor.height,
    });
  }

  // ── Input capture ──────────────────────────────────────────────────────

  private setupInputListeners(): void {
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';

    this.canvas.addEventListener('mousedown', (e) => {
      this.canvas.focus();
      this.handleMouseEvent(e, 'mousedown');
    });
    this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMoveThrottled(e));
    this.canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e));

    document.addEventListener('keydown', (e) => this.handleKeyEvent(e, 'keydown'));
    document.addEventListener('keyup', (e) => this.handleKeyEvent(e, 'keyup'));

    document.addEventListener('paste', (e) => this.handlePasteEvent(e));
    document.addEventListener('copy', (e) => this.handleCopyEvent(e));
    document.addEventListener('cut', (e) => this.handleCutEvent(e));
  }

  private handleMouseEvent(
    e: MouseEvent,
    type: 'mousedown' | 'mouseup' | 'mousemove'
  ): void {
    const canvasRect = this.canvas.getBoundingClientRect();
    const x = e.clientX - canvasRect.left;
    const y = e.clientY - canvasRect.top;

    // Track canvas-space mouse position for drag start reference
    this.lastCanvasX = x;
    this.lastCanvasY = y;

    // Hit test locally — compositor is local
    const hitSurface = this.compositor.surfaceAt(x, y);
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    const localX = surface ? x - surface.rect.x : x;
    const localY = surface ? y - surface.rect.y : y;

    // For resize drags (grabbedSurface set, no local drag), include globalX/globalY
    // to avoid stale local→global reconstruction on the server
    const inputMsg: Record<string, unknown> = {
      type: 'input',
      inputType: type,
      surfaceId: surface?.id,
      x: localX,
      y: localY,
      button: e.button,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    };

    if (this.grabbedSurface && !this.localDragState) {
      inputMsg.globalX = x;
      inputMsg.globalY = y;
    }

    this.sendToBackend(inputMsg as unknown as FrontendToBackendMsg);

    if (type === 'mousedown' && surface) {
      this.grabbedSurface = surface.id;
      this.focusedSurface = surface.id;
    }

    if (type === 'mouseup') {
      this.grabbedSurface = undefined;
    }
  }

  private handleMouseMoveThrottled(e: MouseEvent): void {
    // Client-side local move drag — move surface instantly, no server round-trip
    if (this.localDragState && this.localDragState.dragType === 'move') {
      const canvasRect = this.canvas.getBoundingClientRect();
      const x = e.clientX - canvasRect.left;
      const y = e.clientY - canvasRect.top;
      this.lastCanvasX = x;
      this.lastCanvasY = y;
      const dx = x - this.localDragState.startX;
      const dy = y - this.localDragState.startY;
      this.compositor.moveSurface(
        this.localDragState.surfaceId,
        this.localDragState.startSurfaceX + dx,
        this.localDragState.startSurfaceY + dy,
      );
      return;
    }

    // During drag (grabbed surface), send immediately — throttling causes
    // jitter because surface positions change between capture and send.
    if (this.grabbedSurface) {
      this.handleMouseEvent(e, 'mousemove');
      return;
    }

    // Throttle hover moves to rAF rate (~60fps)
    const canvasRect = this.canvas.getBoundingClientRect();
    const x = e.clientX - canvasRect.left;
    const y = e.clientY - canvasRect.top;
    this.lastCanvasX = x;
    this.lastCanvasY = y;

    const hitSurface = this.compositor.surfaceAt(x, y);
    const surface = hitSurface;

    const localX = surface ? x - surface.rect.x : x;
    const localY = surface ? y - surface.rect.y : y;

    this.pendingMouseMove = {
      type: 'input',
      inputType: 'mousemove',
      surfaceId: surface?.id,
      x: localX,
      y: localY,
      button: e.button,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    } as FrontendToBackendMsg;

    if (!this.mouseMoveRafId) {
      this.mouseMoveRafId = requestAnimationFrame(() => {
        this.mouseMoveRafId = 0;
        if (this.pendingMouseMove) {
          this.sendToBackend(this.pendingMouseMove);
          this.pendingMouseMove = null;
        }
      });
    }
  }

  private handleWheelEvent(e: WheelEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const surface = this.compositor.surfaceAt(x, y);
    if (!surface) return;

    this.sendToBackend({
      type: 'input',
      inputType: 'wheel',
      surfaceId: surface.id,
      x: x - surface.rect.x,
      y: y - surface.rect.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    });
  }

  private handleKeyEvent(e: KeyboardEvent, type: 'keydown' | 'keyup'): void {
    if (!this.focusedSurface) return;

    // Let clipboard shortcuts through so browser fires paste/copy/cut events
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'c' || e.key === 'x')) {
      return;
    }

    e.preventDefault();

    this.sendToBackend({
      type: 'input',
      inputType: type,
      surfaceId: this.focusedSurface,
      key: e.key,
      code: e.code,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    });
  }

  private handlePasteEvent(e: ClipboardEvent): void {
    if (!this.focusedSurface) return;

    const pasteText = e.clipboardData?.getData('text') ?? '';
    if (!pasteText) return;

    e.preventDefault();

    this.sendToBackend({
      type: 'input',
      inputType: 'paste',
      surfaceId: this.focusedSurface,
      pasteText,
    });
  }

  private handleCopyEvent(e: ClipboardEvent): void {
    if (!this.currentSelectedText) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', this.currentSelectedText);
  }

  private handleCutEvent(e: ClipboardEvent): void {
    if (!this.currentSelectedText || !this.focusedSurface) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', this.currentSelectedText);
    // Forward cut as keydown so widget deletes the selection via normal input routing
    this.sendToBackend({
      type: 'input',
      inputType: 'keydown',
      surfaceId: this.focusedSurface,
      key: 'x',
      code: 'KeyX',
      modifiers: { shift: false, ctrl: true, alt: false, meta: false },
    });
    this.currentSelectedText = '';
  }

  // ── Send to backend ────────────────────────────────────────────────────

  private sendToBackend(msg: FrontendToBackendMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
