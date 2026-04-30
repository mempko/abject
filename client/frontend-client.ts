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
import type { AbyssBgControl } from './abyss-bg.js';

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

/** ASCII printable range pre-measured for every new font we see. */
const ASCII_MIN = 32;
const ASCII_MAX = 126;

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
  /** Fonts for which we've already shipped a full ASCII metrics table. */
  private measuredFonts: Set<string> = new Set();
  /** Middle-click-drag pan in progress. */
  private panningViewport = false;
  /** Scrollbar thumb drag in progress. */
  private draggingScrollbar = false;
  private reconnectAttempt = 0;
  private mobileMode = false;
  private mobileTabTouchStartX?: number;  // track start X for tap vs scroll detection
  private mobileKeyboardProxy?: HTMLInputElement;  // hidden input for virtual keyboard
  // Pinch-zoom state
  private pinchStartDist?: number;
  private pinchStartZoom?: number;
  // Two-finger pan state
  private panLastMidX?: number;
  private panLastMidY?: number;
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
  private abyssBg?: AbyssBgControl;
  private resizableSurfaces: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, abyssBg?: AbyssBgControl) {
    this.canvas = canvas;
    this.abyssBg = abyssBg;
    this.compositor = new Compositor(canvas);
    this.detectMobileMode();
    this.setupInputListeners();
    this.setupMobileKeyboard();
    this.setupViewportShift();
  }

  private detectMobileMode(): void {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const narrow = window.innerWidth < 768;
    const touch = 'ontouchstart' in window;
    this.mobileMode = (coarse || touch) && narrow;
    this.compositor.setMobileMode(this.mobileMode);

    // Re-detect on resize (tablet rotation)
    window.addEventListener('resize', () => {
      const wasMobile = this.mobileMode;
      const nowNarrow = window.innerWidth < 768;
      this.mobileMode = (coarse || touch) && nowNarrow;
      if (this.mobileMode !== wasMobile) {
        this.compositor.setMobileMode(this.mobileMode);
      }
    });
  }

  private setupMobileKeyboard(): void {
    const proxy = document.getElementById('mobile-keyboard-proxy') as HTMLInputElement | null;
    if (!proxy) return;
    this.mobileKeyboardProxy = proxy;

    // Track composition state to avoid double-sending during autocomplete/predictive text
    let composing = false;
    proxy.addEventListener('compositionstart', () => { composing = true; });
    proxy.addEventListener('compositionend', () => {
      composing = false;
      // Flush whatever the composition produced
      this.flushProxyInput(proxy);
    });

    // Use beforeinput for the most reliable character capture on mobile.
    // Only handle insertText (typed characters) and insertCompositionText here.
    proxy.addEventListener('beforeinput', (e: InputEvent) => {
      if (!this.focusedSurface) return;

      // During composition, let compositionend handle the final text
      if (composing && e.inputType === 'insertCompositionText') return;

      if (e.inputType === 'insertText' && e.data) {
        e.preventDefault();
        for (const ch of e.data) {
          this.sendToBackend({
            type: 'input',
            inputType: 'keydown',
            surfaceId: this.focusedSurface,
            key: ch,
            code: '',
            modifiers: { shift: false, ctrl: false, alt: false, meta: false },
          } as FrontendToBackendMsg);
        }
        proxy.value = '';
        return;
      }

      // deleteContentBackward = Backspace on mobile
      if (e.inputType === 'deleteContentBackward') {
        e.preventDefault();
        this.sendToBackend({
          type: 'input',
          inputType: 'keydown',
          surfaceId: this.focusedSurface,
          key: 'Backspace',
          code: 'Backspace',
          modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        } as FrontendToBackendMsg);
        return;
      }

      // insertLineBreak = Enter on mobile
      if (e.inputType === 'insertLineBreak') {
        e.preventDefault();
        this.sendToBackend({
          type: 'input',
          inputType: 'keydown',
          surfaceId: this.focusedSurface,
          key: 'Enter',
          code: 'Enter',
          modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        } as FrontendToBackendMsg);
        return;
      }
    });

    // Fallback: capture special keys that don't fire beforeinput (arrows, Tab, Escape)
    proxy.addEventListener('keydown', (e) => {
      if (!this.focusedSurface) return;
      // Skip printable characters -- handled by beforeinput
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) return;
      // Skip keys already handled by beforeinput
      if (e.key === 'Backspace' || e.key === 'Enter') return;
      e.preventDefault();
      this.sendToBackend({
        type: 'input',
        inputType: 'keydown',
        surfaceId: this.focusedSurface,
        key: e.key,
        code: e.code,
        modifiers: {
          shift: e.shiftKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
      } as FrontendToBackendMsg);
    });
  }

  /** Flush any remaining text in the proxy input (after composition ends). */
  private flushProxyInput(proxy: HTMLInputElement): void {
    if (!this.focusedSurface || !proxy.value) return;
    for (const ch of proxy.value) {
      this.sendToBackend({
        type: 'input',
        inputType: 'keydown',
        surfaceId: this.focusedSurface,
        key: ch,
        code: '',
        modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      } as FrontendToBackendMsg);
    }
    proxy.value = '';
  }

  /** Focus the hidden input proxy to trigger the mobile virtual keyboard. */
  private focusMobileKeyboard(): void {
    if (!this.mobileMode || !this.mobileKeyboardProxy) return;
    // Move proxy on-screen briefly so iOS respects the focus
    this.mobileKeyboardProxy.style.left = '0';
    this.mobileKeyboardProxy.focus();
    // Move it back off-screen after focus is established
    requestAnimationFrame(() => {
      if (this.mobileKeyboardProxy) {
        this.mobileKeyboardProxy.style.left = '-9999px';
      }
    });
  }

  /**
   * Listen for visual viewport changes (keyboard show/hide) and shift
   * the canvas up so content stays visible above the keyboard.
   */
  private setupViewportShift(): void {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      // When the keyboard opens, visualViewport.height shrinks.
      // Shift the canvas up by the difference.
      const keyboardHeight = window.innerHeight - vv.height;
      if (keyboardHeight > 50) {
        // Keyboard is open -- shift canvas up
        this.canvas.style.transform = `translateY(-${keyboardHeight}px)`;
      } else {
        this.canvas.style.transform = '';
      }
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }

  /**
   * Connect to the backend WebSocket server.
   */
  connect(url: string): void {
    const t0 = performance.now();
    const clog = (msg: string) => console.log(`[WS-CLIENT T+${Math.round(performance.now() - t0)}ms] ${msg}`);

    this.showConnecting();

    clog(`new WebSocket(${url})`);
    this.ws = new WebSocket(url);
    clog('WebSocket constructor returned');
    this.authenticated = false;

    this.ws.onopen = () => {
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
      clog(`onclose fired (code=${ev.code})`);
      console.log(`[Frontend] Disconnected from backend (code=${ev.code})`);
      this.ws = null;
      this.authenticated = false;

      // Auto-reconnect. ECONNREFUSED returns instantly on localhost so
      // fast retries when the server is down don't waste resources.
      // Don't force-close CONNECTING sockets — that poisons Firefox's
      // connection cache and causes minutes of phantom failures.
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
        this.hideConnecting();
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
          this.hideConnecting();
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

  private showConnecting(): void {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay) {
      overlay.classList.remove('hidden', 'landed');
    }
    const app = document.getElementById('app');
    if (app) app.classList.remove('landed');
    document.body.classList.remove('landed');
    this.abyssBg?.setDescending(true);
  }

  private hideConnecting(): void {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay) {
      // Animate logo up and status out
      overlay.classList.add('landed');
      // Fade away the overlay after the animation
      setTimeout(() => overlay.classList.add('hidden'), 700);
    }
    // Animate the UI rising into view + clouds appearing
    const app = document.getElementById('app');
    if (app) app.classList.add('landed');
    document.body.classList.add('landed');
    this.abyssBg?.setDescending(false);
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
      for (let code = ASCII_MIN; code <= ASCII_MAX; code++) {
        const ch = String.fromCharCode(code);
        charWidths[ch] = ctx.measureText(ch).width;
      }
      metrics[font] = charWidths;
      this.measuredFonts.add(font);
    }

    this.sendRaw({ type: 'fontMetrics', metrics });
  }

  /**
   * Measure ASCII char widths for a font and ship them to the backend so its
   * local cache handles all future measureText calls without a round-trip.
   */
  private shipFontMetrics(font: string): void {
    if (this.measuredFonts.has(font)) return;
    this.measuredFonts.add(font);
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d')!;
    ctx.font = font;
    const charWidths: Record<string, number> = {};
    for (let code = ASCII_MIN; code <= ASCII_MAX; code++) {
      const ch = String.fromCharCode(code);
      charWidths[ch] = ctx.measureText(ch).width;
    }
    this.sendRaw({ type: 'fontMetrics', metrics: { [font]: charWidths } });
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
        this.resizableSurfaces.delete(msg.surfaceId);
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

      case 'setSurfaceTitle':
        this.compositor.setSurfaceTitle(msg.surfaceId, msg.title);
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

      case 'openUrl':
        window.open((msg as { url: string }).url, '_blank');
        break;

      case 'setSurfaceResizable':
        if (msg.resizable) {
          this.resizableSurfaces.add(msg.surfaceId);
        } else {
          this.resizableSurfaces.delete(msg.surfaceId);
        }
        break;

      case 'startWindowDrag':
        this.handleStartWindowDrag(msg as StartWindowDragMsg);
        break;

      case 'showMobileKeyboard':
        if (msg.show) {
          this.focusMobileKeyboard();
        } else if (this.mobileKeyboardProxy) {
          this.mobileKeyboardProxy.blur();
        }
        break;

      case 'setCursor':
        this.canvas.style.cursor = msg.cursor || 'default';
        break;

      case 'captureSurfaceRequest':
        this.handleCaptureSurfaceRequest(msg.requestId!, msg.surfaceId);
        break;

      case 'captureDesktopRequest':
        this.handleCaptureDesktopRequest(msg.requestId!);
        break;
    }
  }

  private handleCreateSurface(msg: CreateSurfaceMsg): void {
    this.compositor.createSurface(
      msg.objectId as AbjectId,
      msg.rect,
      msg.zIndex,
      msg.surfaceId,
      msg.inputPassthrough ?? false,
      false, // inputMonitor
      msg.title,
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
    // No window drag/resize on mobile
    if (this.mobileMode) return;

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
      this.canvas.style.cursor = 'move';
    } else if (msg.dragType === 'resize' && msg.edge) {
      this.canvas.style.cursor = FrontendClient.edgeToCursor(msg.edge);
    }
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
      this.canvas.style.cursor = 'default';
      return;
    }

    // Normal mouseup path -- reset cursor when grab ends
    if (this.grabbedSurface) {
      this.canvas.style.cursor = 'default';
    }
    this.handleMouseEvent(e, 'mouseup');
  }

  // ── Resize cursor helpers ─────────────────────────────────────────

  private static readonly EDGE_SIZE = 10;

  private static edgeToCursor(edge: string): string {
    switch (edge) {
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'nw': case 'se': return 'nwse-resize';
      default: return 'default';
    }
  }

  private detectResizeEdge(
    rect: { width: number; height: number },
    localX: number,
    localY: number,
  ): string | null {
    const sz = FrontendClient.EDGE_SIZE;
    const n = localY < sz;
    const s = localY > rect.height - sz;
    const w = localX < sz;
    const e = localX > rect.width - sz;

    if (n && w) return 'nw';
    if (n && e) return 'ne';
    if (s && w) return 'sw';
    if (s && e) return 'se';
    if (n) return 'n';
    if (s) return 's';
    if (w) return 'w';
    if (e) return 'e';
    return null;
  }

  private updateCursor(canvasX: number, canvasY: number): void {
    const surface = this.compositor.surfaceAt(canvasX, canvasY);
    if (surface && this.resizableSurfaces.has(surface.id)) {
      const { x: wx, y: wy } = this.compositor.viewportToWorkspace(canvasX, canvasY);
      const localX = wx - surface.rect.x;
      const localY = wy - surface.rect.y;
      const edge = this.detectResizeEdge(surface.rect, localX, localY);
      this.canvas.style.cursor = edge ? FrontendClient.edgeToCursor(edge) : 'default';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  private handleMeasureTextRequest(
    requestId: string,
    surfaceId: string,
    text: string,
    font: string
  ): void {
    // First time we see this font: ship full ASCII metrics so the server's
    // local cache handles every subsequent measureText call without a
    // round-trip. One round-trip per unique font, not per widget render.
    this.shipFontMetrics(font);

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

  private async handleCaptureSurfaceRequest(requestId: string, surfaceId: string): Promise<void> {
    const result = await this.compositor.captureSurface(surfaceId);
    this.sendToBackend({
      type: 'captureSurfaceReply',
      requestId,
      imageBase64: result?.imageBase64 ?? '',
      width: result?.width ?? 0,
      height: result?.height ?? 0,
    });
  }

  private handleCaptureDesktopRequest(requestId: string): void {
    const result = this.compositor.captureDesktop();
    this.sendToBackend({
      type: 'captureDesktopReply',
      requestId,
      imageBase64: result.imageBase64,
      width: result.width,
      height: result.height,
    });
  }

  // ── Input capture ──────────────────────────────────────────────────────

  private setupInputListeners(): void {
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';

    this.canvas.addEventListener('mousedown', (e) => {
      this.canvas.focus();
      if (this.handleScrollOrPanMouseDown(e)) return;
      this.handleMouseEvent(e, 'mousedown');
    });
    this.canvas.addEventListener('mouseup', (e) => {
      if (this.handleScrollOrPanMouseUp()) return;
      this.handleMouseUp(e);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.handleScrollOrPanMouseMove(e)) return;
      this.handleMouseMoveThrottled(e);
    });
    this.canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e));
    this.canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.canvas.addEventListener('contextmenu', (e) => {
      // Don't block browser context menu normally, but if a middle-pan is
      // happening we don't want it to intercept.
      if (this.panningViewport) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => this.handleKeyEvent(e, 'keydown'));
    document.addEventListener('keyup', (e) => this.handleKeyEvent(e, 'keyup'));

    document.addEventListener('paste', (e) => this.handlePasteEvent(e));
    document.addEventListener('copy', (e) => this.handleCopyEvent(e));
    document.addEventListener('cut', (e) => this.handleCutEvent(e));

    // Touch events for mobile
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.canvas.focus();
      const canvasRect = this.canvas.getBoundingClientRect();

      // Two-finger touch: start pinch-zoom
      if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        this.pinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        this.pinchStartZoom = 1; // relative
        this.panLastMidX = (t0.clientX + t1.clientX) / 2 - canvasRect.left;
        this.panLastMidY = (t0.clientY + t1.clientY) / 2 - canvasRect.top;
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;
      const cy = touch.clientY - canvasRect.top;
      const cx = touch.clientX - canvasRect.left;
      // Start tab bar scroll gesture if touching the tab bar
      if (this.compositor.isInMobileTabBar(cy)) {
        this.mobileTabTouchStartX = cx;
        this.compositor.mobileTabDragStart(cx);
        return;
      }
      this.handleTouchEvent(touch, 'mousedown');
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const canvasRect = this.canvas.getBoundingClientRect();

      // Two-finger move: pinch-zoom + pan
      if (e.touches.length === 2 && this.pinchStartDist) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const zoomDelta = dist / this.pinchStartDist;
        const midX = (t0.clientX + t1.clientX) / 2 - canvasRect.left;
        const midY = (t0.clientY + t1.clientY) / 2 - canvasRect.top;

        this.compositor.mobilePinchZoom(zoomDelta, midX, midY);
        this.pinchStartDist = dist; // reset for incremental zoom

        // Pan with two-finger drag
        if (this.panLastMidX !== undefined && this.panLastMidY !== undefined) {
          this.compositor.mobilePan(midX - this.panLastMidX, midY - this.panLastMidY);
        }
        this.panLastMidX = midX;
        this.panLastMidY = midY;
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;
      const cx = touch.clientX - canvasRect.left;
      const cy = touch.clientY - canvasRect.top;
      // Continue tab bar scroll gesture
      if (this.compositor.isInMobileTabBar(cy) || this.compositor.isMobileTabDragging) {
        this.compositor.mobileTabDragMove(cx);
        return;
      }
      this.handleTouchEvent(touch, 'mousemove');
    }, { passive: false });

    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();

      // End pinch if fewer than 2 fingers remain
      if (this.pinchStartDist !== undefined && e.touches.length < 2) {
        this.pinchStartDist = undefined;
        this.pinchStartZoom = undefined;
        this.panLastMidX = undefined;
        this.panLastMidY = undefined;
        // If one finger remains, don't generate mouseup
        if (e.touches.length === 1) return;
      }

      const touch = e.changedTouches[0];
      if (!touch) return;
      const canvasRect = this.canvas.getBoundingClientRect();
      const cx = touch.clientX - canvasRect.left;
      const cy = touch.clientY - canvasRect.top;
      // End tab bar scroll gesture -- if barely moved, treat as tap
      if (this.compositor.isMobileTabDragging) {
        const moved = Math.abs(cx - (this.mobileTabTouchStartX ?? cx));
        this.mobileTabTouchStartX = undefined;
        this.compositor.mobileTabDragEnd();
        if (moved < 10) {
          this.compositor.handleMobileTabTap(cx, cy);
        }
        return;
      }
      this.handleTouchEvent(touch, 'mouseup');
    }, { passive: false });
  }

  private handleTouchEvent(
    touch: Touch,
    type: 'mousedown' | 'mouseup' | 'mousemove'
  ): void {
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasX = touch.clientX - canvasRect.left;
    const canvasY = touch.clientY - canvasRect.top;

    this.lastCanvasX = canvasX;
    this.lastCanvasY = canvasY;

    // In mobile mode, check tab bar taps first
    if (this.mobileMode && type === 'mousedown') {
      if (this.compositor.handleMobileTabTap(canvasX, canvasY)) {
        return; // tab bar consumed the tap
      }
    }

    // Hit test
    const hitSurface = this.compositor.surfaceAt(canvasX, canvasY);
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    if (!surface) return;

    // In mobile mode, transform coordinates through the mobile scale
    let localX: number;
    let localY: number;
    if (this.mobileMode) {
      const coords = this.compositor.mobileToSurfaceCoords(canvasX, canvasY);
      localX = coords.x;
      localY = coords.y;
    } else {
      localX = canvasX - surface.rect.x;
      localY = canvasY - surface.rect.y;
    }

    this.sendToBackend({
      type: 'input',
      inputType: type,
      surfaceId: surface.id,
      x: localX,
      y: localY,
      button: 0,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    } as FrontendToBackendMsg);

    if (type === 'mousedown') {
      this.grabbedSurface = surface.id;
      this.focusedSurface = surface.id;
    }
    if (type === 'mouseup') {
      this.grabbedSurface = undefined;
    }
  }

  /**
   * Intercept mousedown for scrollbar thumb or middle-click pan. Returns true
   * if the event was consumed and the normal input path should be skipped.
   */
  private handleScrollOrPanMouseDown(e: MouseEvent): boolean {
    if (this.mobileMode) return false;
    const canvasRect = this.canvas.getBoundingClientRect();
    const vx = e.clientX - canvasRect.left;
    const vy = e.clientY - canvasRect.top;

    // Scrollbar thumb? (left button only)
    if (e.button === 0) {
      const axis = this.compositor.scrollbarAt(vx, vy);
      if (axis) {
        this.compositor.beginScrollbarDrag(axis, axis === 'x' ? vx : vy);
        this.draggingScrollbar = true;
        e.preventDefault();
        return true;
      }
    }

    // Middle-click pans anywhere.
    if (e.button === 1) {
      this.compositor.beginPanDrag(vx, vy);
      this.panningViewport = true;
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return true;
    }

    return false;
  }

  private handleScrollOrPanMouseMove(e: MouseEvent): boolean {
    if (!this.panningViewport && !this.draggingScrollbar) return false;
    const canvasRect = this.canvas.getBoundingClientRect();
    const vx = e.clientX - canvasRect.left;
    const vy = e.clientY - canvasRect.top;
    if (this.draggingScrollbar) {
      this.compositor.updateScrollbarDrag(vx, vy);
      return true;
    }
    if (this.panningViewport) {
      this.compositor.updatePanDrag(vx, vy);
      return true;
    }
    return false;
  }

  private handleScrollOrPanMouseUp(): boolean {
    if (this.draggingScrollbar) {
      this.compositor.endScrollbarDrag();
      this.draggingScrollbar = false;
      return true;
    }
    if (this.panningViewport) {
      this.compositor.endPanDrag();
      this.panningViewport = false;
      this.canvas.style.cursor = 'default';
      return true;
    }
    return false;
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

    // Workspace coords (surface.rect is in workspace space, mouse is in viewport)
    const { x: wx, y: wy } = this.compositor.viewportToWorkspace(x, y);

    // Hit test locally — compositor is local
    const hitSurface = this.compositor.surfaceAt(x, y);
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    const localX = surface ? wx - surface.rect.x : wx;
    const localY = surface ? wy - surface.rect.y : wy;

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
      inputMsg.globalX = wx;
      inputMsg.globalY = wy;
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

    // Update resize cursor on hover (instant, no server round-trip)
    this.updateCursor(x, y);

    const { x: wx, y: wy } = this.compositor.viewportToWorkspace(x, y);
    const hitSurface = this.compositor.surfaceAt(x, y);
    const surface = hitSurface;

    const localX = surface ? wx - surface.rect.x : wx;
    const localY = surface ? wy - surface.rect.y : wy;

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

    // Wheel over empty desktop pans the viewport. Shift+wheel scrolls
    // horizontally (standard mousewheel convention).
    if (!surface) {
      e.preventDefault();
      if (e.shiftKey) {
        this.compositor.scrollBy(e.deltaY !== 0 ? e.deltaY : e.deltaX, 0);
      } else {
        this.compositor.scrollBy(e.deltaX, e.deltaY);
      }
      return;
    }

    const { x: wx, y: wy } = this.compositor.viewportToWorkspace(x, y);
    this.sendToBackend({
      type: 'input',
      inputType: 'wheel',
      surfaceId: surface.id,
      x: wx - surface.rect.x,
      y: wy - surface.rect.y,
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
    // Global shortcuts: pulled out of the regular keydown stream so they
    // always work regardless of which surface holds focus.
    //   ⌘K / Ctrl-K → CommandPalette (launch any Abject)
    //   ⌘` / Ctrl-` → WindowSwitcher (jump to an open window)
    if (
      type === 'keydown' &&
      (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    ) {
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        this.sendToBackend({ type: 'globalShortcut', combo: 'commandPalette' });
        return;
      }
      if (e.key === '`') {
        e.preventDefault();
        this.sendToBackend({ type: 'globalShortcut', combo: 'windowSwitcher' });
        return;
      }
    }

    if (!this.focusedSurface) return;

    // On mobile, the hidden proxy input handles keyboard events -- skip
    // the document-level handler to avoid sending duplicate characters.
    if (this.mobileKeyboardProxy && e.target === this.mobileKeyboardProxy) return;

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
