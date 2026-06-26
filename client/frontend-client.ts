/**
 * FrontendClient — Thin browser client that owns the Canvas/Compositor.
 *
 * Receives draw/surface commands from BackendUI over WebSocket and renders
 * them locally. Captures input events and sends them back to the backend.
 * Handles measureText and displayInfo requests locally.
 */

import { Compositor, DrawCommand, MobileViewState } from '../src/ui/compositor.js';
import type { SceneOp, SceneTheme } from '../src/ui/gl/scene-types.js';
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
import type { ClientTransport } from './transport.js';

/**
 * The thin browser frontend that owns the Canvas and Compositor.
 */
/** Fonts to pre-measure for server-side text width computation */
const MEASURED_FONTS = [
  '14px "Spectral", Georgia, "Times New Roman", serif',        // WIDGET_FONT
  '600 14px "Fraunces", "Spectral", Georgia, serif',           // TITLE_FONT
  '13px "Spline Sans Mono", "JetBrains Mono", monospace',      // CODE_FONT
  '14px system-ui',                                            // legacy WIDGET_FONT
];

/** ASCII printable range pre-measured for every new font we see. */
const ASCII_MIN = 32;
const ASCII_MAX = 126;

export class FrontendClient {
  private compositor: Compositor;
  private canvas: HTMLCanvasElement;
  private transport: ClientTransport | null = null;
  private focusedSurface?: string;
  private grabbedSurface?: string;
  /** Currently hovered 3D scene node (mesh), for enter/leave synthesis. */
  private hoveredNode?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
  /**
   * Drag capture for 3D nodes: set on node mousedown, released on mouseup.
   * While set, mousemove streams to this node even when the cursor outruns
   * the mesh — smooth drags, like window/widget grabs.
   */
  private grabbedNode?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
  private currentSelectedText = '';
  private authenticated = false;
  private loginFormHandler: ((e: Event) => void) | null = null;
  private pendingMouseMove: FrontendToBackendMsg | null = null;
  private mouseMoveRafId = 0;
  /** Per-surface accumulated wheel deltas; flushed once per animation frame. */
  private pendingWheels: Map<string, {
    surfaceId: string;
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  }> = new Map();
  private wheelRafId = 0;
  /** Fonts for which we've already shipped a full ASCII metrics table. */
  private measuredFonts: Set<string> = new Set();
  /** Middle-click-drag pan in progress. */
  private panningViewport = false;
  /** Scrollbar thumb drag in progress. */
  private draggingScrollbar = false;
  private mobileMode = false;
  private mobileKeyboardProxy?: HTMLInputElement;  // hidden input for virtual keyboard
  // Pinch-zoom state
  private pinchStartDist?: number;
  private pinchStartZoom?: number;
  // Two-finger pan state
  private panLastMidX?: number;
  private panLastMidY?: number;

  // ── Single-finger gesture state machine (mobile) ──
  private static readonly DOUBLE_TAP_MS = 300;
  private static readonly TAP_SLOP_PX = 10;
  private static readonly EDGE_SWIPE_TRIGGER_PX = 40;
  private static readonly LONG_PRESS_MS = 350;
  private static readonly FLICK_VELOCITY = 0.6;  // px/ms upward to close a card
  private static readonly CARD_CLOSE_DISTANCE = 120;  // px dragged up to close
  /** Per-touch gesture descriptor (single finger). */
  private activeTouch?: {
    startX: number; startY: number; startTime: number;
    lastX: number; lastY: number; lastTime: number; lastVy: number;
    mode: 'undecided' | 'content' | 'pan' | 'edgeSwipe' | 'edgeConsumed' | 'cardPan' | 'cardClose' | 'cardReorder';
    cardId?: string;
    longPressTimer?: ReturnType<typeof setTimeout>;
  };
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
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
  private fileUploadProxy?: HTMLInputElement;
  /** Surface that requested the file picker; the chosen file routes back to it. */
  private fileUploadTargetSurface?: string;
  /** Monotonic counter to give each upload a unique id for chunk reassembly. */
  private nextUploadSeq = 0;

  constructor(canvas: HTMLCanvasElement, abyssBg?: AbyssBgControl) {
    this.canvas = canvas;
    this.abyssBg = abyssBg;
    this.compositor = new Compositor(canvas);
    this.detectMobileMode();
    this.setupInputListeners();
    this.setupMobileKeyboard();
    this.setupViewportShift();
    this.setupFileUpload();
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

    // Tell the backend when the viewport changes size (debounced past the
    // resize-drag stream) so display-sized chrome like the sidebar dock can
    // follow. Read the dimensions inside the debounce: the compositor's own
    // resize handler has updated the canvas by then.
    let resizeNotifyTimer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      if (resizeNotifyTimer) clearTimeout(resizeNotifyTimer);
      resizeNotifyTimer = setTimeout(() => {
        resizeNotifyTimer = undefined;
        this.sendToBackend({
          type: 'displayResized',
          width: this.compositor.width,
          height: this.compositor.height,
        });
      }, 250);
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

  /**
   * Wire the hidden file input (opened on demand by the backend) and canvas
   * drag-drop. Selected/dropped files are read as base64 and streamed to the
   * backend in chunks tagged with the target surface.
   */
  private setupFileUpload(): void {
    const proxy = document.getElementById('file-upload-proxy') as HTMLInputElement | null;
    if (proxy) {
      this.fileUploadProxy = proxy;
      proxy.addEventListener('change', () => {
        const files = proxy.files;
        const surfaceId = this.fileUploadTargetSurface;
        if (files && surfaceId) {
          for (const file of Array.from(files)) {
            void this.uploadFile(file, surfaceId);
          }
        }
        // Reset so selecting the same file again re-fires change.
        proxy.value = '';
        this.fileUploadTargetSurface = undefined;
      });
    }

    // Drag-and-drop onto the canvas: route to the surface under the drop point.
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    this.canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const surface = this.compositor.surfaceAt(e.clientX - rect.left, e.clientY - rect.top);
      const surfaceId = surface?.id ?? this.focusedSurface;
      if (!surfaceId) return;
      for (const file of Array.from(files)) {
        void this.uploadFile(file, surfaceId);
      }
    });
  }

  /**
   * Read a File as base64 and send it to the backend in chunks. When
   * `toFocusedWidget` is set, the assembled file is routed to the focused
   * child widget (used for images pasted into a text input) instead of the
   * surface owner.
   */
  private async uploadFile(file: File, surfaceId: string, toFocusedWidget = false): Promise<void> {
    const buf = await file.arrayBuffer();
    const base64 = this.arrayBufferToBase64(buf);
    const uploadId = `${surfaceId}-${this.nextUploadSeq++}`;
    // ~700 KB of base64 per chunk keeps individual JSON frames modest.
    const CHUNK = 700_000;
    const chunkCount = Math.max(1, Math.ceil(base64.length / CHUNK));
    const mimeType = file.type || 'application/octet-stream';
    for (let i = 0; i < chunkCount; i++) {
      this.sendToBackend({
        type: 'fileUpload',
        surfaceId,
        uploadId,
        name: file.name,
        mimeType,
        base64: base64.slice(i * CHUNK, (i + 1) * CHUNK),
        chunkIndex: i,
        chunkCount,
        ...(toFocusedWidget ? { toFocusedWidget: true } : {}),
      } as FrontendToBackendMsg);
    }
  }

  private arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const STEP = 0x8000; // avoid call-stack limits in String.fromCharCode.apply
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return btoa(binary);
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
   * Connect via a pluggable transport (WebSocket for local dev, WebRTC for
   * paired remote clients). The transport owns its own reconnect logic.
   */
  async connect(transport: ClientTransport): Promise<void> {
    this.showConnecting();
    this.transport = transport;
    this.authenticated = false;

    transport.onOpen(() => {
      console.log('[Frontend] Connected to backend');
      // Clear stale surfaces from any previous connection before replaying state
      this.compositor.clearAllSurfaces();
      this.focusedSurface = undefined;
      this.compositor.setFocusedSurface(undefined);
      this.grabbedSurface = undefined;
      this.localDragState = undefined;
      this.authenticated = false;
      // Don't send ready yet — wait for auth status from server
    });

    transport.onMessage((data: string) => {
      try {
        const msg = JSON.parse(data);

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
    });

    transport.onClose(() => {
      console.log('[Frontend] Transport closed');
      this.authenticated = false;
    });

    await transport.connect();
  }

  /**
   * Disconnect from the backend.
   */
  disconnect(): void {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
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
    if (this.transport && this.transport.ready) {
      this.transport.send(JSON.stringify(msg));
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
        if (msg.glowColor) this.compositor.setFocusGlowColor(msg.glowColor);
        if (typeof msg.glowRadius === 'number') this.compositor.setFocusGlowRadius(msg.glowRadius);
        this.compositor.setFocusedSurface(msg.surfaceId);
        break;

      case 'sceneOps':
        if (msg.world && msg.ownerId) {
          this.compositor.applyWorldSceneOps(msg.ownerId, msg.ops as unknown as SceneOp[]);
        } else {
          this.compositor.applySceneOps(msg.surfaceId, msg.ops as unknown as SceneOp[]);
        }
        break;

      case 'setSceneTheme':
        this.compositor.setSceneTheme(msg.theme as unknown as SceneTheme);
        break;

      case 'setSurfaceTransform':
        this.compositor.setSurfaceTransform(msg.surfaceId, { rotation: msg.rotation, z: msg.z });
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

      case 'openFilePicker':
        if (this.fileUploadProxy) {
          this.fileUploadTargetSurface = msg.surfaceId;
          this.fileUploadProxy.accept = msg.accept ?? '';
          this.fileUploadProxy.multiple = msg.multiple ?? false;
          this.fileUploadProxy.click();
        }
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
      msg.transparent ?? false,
      msg.closable ?? true,
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

      // Two-finger touch: start pinch-zoom (not in card overview)
      if (e.touches.length === 2) {
        this.cancelActiveTouch();
        if (this.compositor.getMobileView() === MobileViewState.CARD_OVERVIEW) return;
        const t0 = e.touches[0], t1 = e.touches[1];
        this.pinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        this.pinchStartZoom = 1; // relative
        this.panLastMidX = (t0.clientX + t1.clientX) / 2 - canvasRect.left;
        this.panLastMidY = (t0.clientY + t1.clientY) / 2 - canvasRect.top;
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;
      this.onTouchStart(touch, touch.clientX - canvasRect.left, touch.clientY - canvasRect.top);
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
      this.onTouchMove(touch, touch.clientX - canvasRect.left, touch.clientY - canvasRect.top);
    }, { passive: false });

    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();

      // End pinch if fewer than 2 fingers remain
      if (this.pinchStartDist !== undefined && e.touches.length < 2) {
        this.pinchStartDist = undefined;
        this.pinchStartZoom = undefined;
        this.panLastMidX = undefined;
        this.panLastMidY = undefined;
        // If one finger remains, don't generate a single-finger gesture
        if (e.touches.length === 1) return;
      }

      const touch = e.changedTouches[0];
      if (!touch) return;
      const canvasRect = this.canvas.getBoundingClientRect();
      this.onTouchEnd(touch, touch.clientX - canvasRect.left, touch.clientY - canvasRect.top);
    }, { passive: false });
  }

  private cancelActiveTouch(): void {
    if (this.activeTouch?.longPressTimer) clearTimeout(this.activeTouch.longPressTimer);
    this.activeTouch = undefined;
  }

  /** Begin a single-finger gesture; the mode is chosen by view state + start location. */
  private onTouchStart(touch: Touch, cx: number, cy: number): void {
    const now = performance.now();
    const at = this.activeTouch = {
      startX: cx, startY: cy, startTime: now,
      lastX: cx, lastY: cy, lastTime: now, lastVy: 0,
      mode: 'undecided' as const,
    } as NonNullable<FrontendClient['activeTouch']>;

    const view = this.compositor.getMobileView();

    if (view === MobileViewState.CARD_OVERVIEW) {
      at.cardId = this.compositor.cardAt(cx, cy);
      const id = at.cardId;
      if (id) {
        at.longPressTimer = setTimeout(() => {
          if (this.activeTouch === at && at.mode === 'undecided') {
            at.mode = 'cardReorder';
            this.compositor.cardReorderBegin(id);
          }
        }, FrontendClient.LONG_PRESS_MS);
      }
      return;
    }

    // Native states: bottom band arms the swipe-up; fit-mode forwards content input.
    if (this.compositor.isInGestureHandle(cy)) {
      at.mode = 'edgeSwipe';
      return;
    }
    if (view === MobileViewState.NATIVE_FIT) {
      at.mode = 'content';
      this.handleTouchEvent(touch, 'mousedown');
    }
    // NATIVE_ZOOMED: stay 'undecided' — pan on move, click on tap.
  }

  private onTouchMove(touch: Touch, cx: number, cy: number): void {
    const at = this.activeTouch;
    if (!at) return;
    const now = performance.now();
    const dxStep = cx - at.lastX;
    const dyStep = cy - at.lastY;
    at.lastVy = dyStep / Math.max(1, now - at.lastTime);
    at.lastX = cx; at.lastY = cy; at.lastTime = now;
    const movedDist = Math.hypot(cx - at.startX, cy - at.startY);

    switch (at.mode) {
      case 'edgeConsumed':
        return;
      case 'edgeSwipe':
        if (at.startY - cy > FrontendClient.EDGE_SWIPE_TRIGGER_PX) {
          this.compositor.enterCardOverview();
          at.mode = 'edgeConsumed';
        }
        return;
      case 'content':
        this.handleTouchEvent(touch, 'mousemove');
        return;
      case 'pan':
        this.compositor.mobilePan(dxStep, dyStep);
        return;
      case 'cardReorder':
        this.compositor.cardReorder(dxStep);
        return;
      case 'cardPan':
        this.compositor.cardDeckPan(dxStep);
        return;
      case 'cardClose':
        this.compositor.cardCloseDrag(dyStep);
        return;
      case 'undecided': {
        if (movedDist <= FrontendClient.TAP_SLOP_PX) return;
        if (at.longPressTimer) { clearTimeout(at.longPressTimer); at.longPressTimer = undefined; }
        if (this.compositor.getMobileView() === MobileViewState.CARD_OVERVIEW) {
          const dxTotal = cx - at.startX;
          const dyTotal = cy - at.startY;
          if (at.cardId && dyTotal < 0 && Math.abs(dyTotal) > Math.abs(dxTotal)
              && this.compositor.isSurfaceClosable(at.cardId)) {
            at.mode = 'cardClose';
            this.compositor.cardCloseDragBegin(at.cardId);
            this.compositor.cardCloseDrag(dyTotal);
          } else {
            at.mode = 'cardPan';
            this.compositor.cardDeckPan(cx - at.startX);
          }
        } else {
          // NATIVE_ZOOMED → pan
          at.mode = 'pan';
          this.compositor.mobilePan(cx - at.startX, cy - at.startY);
        }
        return;
      }
    }
  }

  private onTouchEnd(touch: Touch, cx: number, cy: number): void {
    const at = this.activeTouch;
    this.activeTouch = undefined;
    if (!at) return;
    if (at.longPressTimer) clearTimeout(at.longPressTimer);

    const movedDist = Math.hypot(cx - at.startX, cy - at.startY);
    const isTap = movedDist < FrontendClient.TAP_SLOP_PX && (performance.now() - at.startTime) < 500;

    switch (at.mode) {
      case 'content':
        this.handleTouchEvent(touch, 'mouseup');
        if (isTap) this.maybeDoubleTap(cx, cy);
        return;
      case 'edgeSwipe':
        // Tap (or partial swipe) on the bottom indicator also opens the overview.
        this.compositor.enterCardOverview();
        return;
      case 'pan':
      case 'edgeConsumed':
        return;
      case 'cardReorder':
        this.compositor.cardReorderEnd();
        return;
      case 'cardPan':
        this.compositor.cardDeckSnap();
        return;
      case 'cardClose': {
        const draggedUp = at.startY - at.lastY;
        const shouldClose = at.lastVy < -FrontendClient.FLICK_VELOCITY
          || draggedUp > FrontendClient.CARD_CLOSE_DISTANCE;
        if (at.cardId && shouldClose) {
          this.closeWindowForSurface(at.cardId);
          this.compositor.cardFlickClose(at.cardId);
        } else if (at.cardId) {
          this.compositor.cardSnapBack(at.cardId);
        }
        return;
      }
      case 'undecided': {
        if (!isTap) return;
        if (this.compositor.getMobileView() === MobileViewState.CARD_OVERVIEW) {
          const chip = this.compositor.closeChipAt(cx, cy);
          if (chip) {
            this.closeWindowForSurface(chip);
            this.compositor.cardFlickClose(chip);
          } else if (at.cardId) {
            this.compositor.exitCardOverview(at.cardId);
          } else if (this.compositor.isInGestureHandle(cy)) {
            // Tap the handle to leave the overview without picking a card.
            this.compositor.exitCardOverview();
          }
        } else {
          // NATIVE_ZOOMED tap → forward a click, and detect double-tap.
          this.handleTouchEvent(touch, 'mousedown');
          this.handleTouchEvent(touch, 'mouseup');
          this.maybeDoubleTap(cx, cy);
        }
        return;
      }
    }
  }

  /** Toggle 1:1 native zoom on a quick second tap near the first. */
  private maybeDoubleTap(cx: number, cy: number): void {
    const now = performance.now();
    if (now - this.lastTapTime < FrontendClient.DOUBLE_TAP_MS
        && Math.hypot(cx - this.lastTapX, cy - this.lastTapY) < FrontendClient.TAP_SLOP_PX) {
      this.compositor.mobileToggleNativeZoom(cx, cy);
      this.lastTapTime = 0; // consume, so a third tap doesn't re-trigger
    } else {
      this.lastTapTime = now;
      this.lastTapX = cx;
      this.lastTapY = cy;
    }
  }

  /** Ask the backend to close the window owning a surface (card flick-up). */
  private closeWindowForSurface(surfaceId: string): void {
    this.sendToBackend({ type: 'closeWindow', surfaceId });
  }

  /** Send a 3D node input event (enter/leave are immediate, not batched). */
  private sendNodeInput(
    inputType: 'mouseenter' | 'mouseleave',
    node: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string },
    wx: number,
    wy: number,
    e: MouseEvent,
  ): void {
    const nodeSurface = node.surfaceId ? this.compositor.getSurface(node.surfaceId) : undefined;
    this.sendToBackend({
      type: 'input',
      inputType,
      surfaceId: node.surfaceId,
      nodeId: node.nodeId,
      nodeScope: node.scope,
      nodeOwnerId: node.ownerId,
      x: nodeSurface ? wx - nodeSurface.rect.x : wx,
      y: nodeSurface ? wy - nodeSurface.rect.y : wy,
      button: e.button,
      modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
    } as unknown as FrontendToBackendMsg);
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
      this.compositor.setFocusedSurface(surface.id);
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

    // Node drag capture: a held node receives the mouseup wherever it lands.
    if (type === 'mouseup' && this.grabbedNode) {
      const held = this.grabbedNode;
      this.grabbedNode = undefined;
      const heldSurface = held.surfaceId ? this.compositor.getSurface(held.surfaceId) : undefined;
      this.sendToBackend({
        type: 'input',
        inputType: 'mouseup',
        surfaceId: held.surfaceId,
        nodeId: held.nodeId,
        nodeScope: held.scope,
        nodeOwnerId: held.ownerId,
        x: heldSurface ? wx - heldSurface.rect.x : wx,
        y: heldSurface ? wy - heldSurface.rect.y : wy,
        button: e.button,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
      } as unknown as FrontendToBackendMsg);
      return;
    }

    // 3D scene-node hit test: mesh nodes are click targets (like widgets).
    // Only when no drag/grab is in flight — drags belong to their surface.
    if ((type === 'mousedown' || type === 'mouseup') && !this.grabbedSurface && !this.localDragState) {
      const node = this.compositor.nodeAt(x, y);
      if (node) {
        if (type === 'mousedown') this.grabbedNode = node;
        const nodeSurface = node.surfaceId ? this.compositor.getSurface(node.surfaceId) : undefined;
        this.sendToBackend({
          type: 'input',
          inputType: type,
          surfaceId: node.surfaceId,
          nodeId: node.nodeId,
          nodeScope: node.scope,
          nodeOwnerId: node.ownerId,
          x: nodeSurface ? wx - nodeSurface.rect.x : wx,
          y: nodeSurface ? wy - nodeSurface.rect.y : wy,
          button: e.button,
          modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
        } as unknown as FrontendToBackendMsg);
        return;
      }
    }

    // Hit test locally — compositor is local. surfaceLocalAt returns
    // projection-correct local coords (slabs may be lifted/tilted in 3D).
    const hit = this.compositor.surfaceLocalAt(x, y);
    const hitSurface = hit?.surface;
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    // Grabbed surfaces use rect math (the pointer may be outside the slab
    // mid-drag); free hits use the exact ray-hit coords.
    const localX = !grabbed && hit ? hit.x : surface ? wx - surface.rect.x : wx;
    const localY = !grabbed && hit ? hit.y : surface ? wy - surface.rect.y : wy;

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
      this.compositor.setFocusedSurface(surface.id);
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

    // Node drag capture: while a node is held, every mousemove streams to it
    // regardless of what's under the cursor — drags stay smooth even when the
    // pointer outruns the mesh. Hover enter/leave is suspended for the drag.
    if (this.grabbedNode) {
      const held = this.grabbedNode;
      const heldSurface = held.surfaceId ? this.compositor.getSurface(held.surfaceId) : undefined;
      this.pendingMouseMove = {
        type: 'input',
        inputType: 'mousemove',
        surfaceId: held.surfaceId,
        nodeId: held.nodeId,
        nodeScope: held.scope,
        nodeOwnerId: held.ownerId,
        x: heldSurface ? wx - heldSurface.rect.x : wx,
        y: heldSurface ? wy - heldSurface.rect.y : wy,
        button: e.button,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
      } as unknown as FrontendToBackendMsg;
      if (!this.mouseMoveRafId) {
        this.mouseMoveRafId = requestAnimationFrame(() => {
          this.mouseMoveRafId = 0;
          if (this.pendingMouseMove) {
            this.sendToBackend(this.pendingMouseMove);
            this.pendingMouseMove = null;
          }
        });
      }
      return;
    }

    // 3D node hover: meshes receive mousemove like widgets, with synthesized
    // enter/leave on hover changes (sent immediately; moves are rAF-batched).
    const node = this.compositor.nodeAt(x, y);
    if (this.hoveredNode && (!node || node.nodeId !== this.hoveredNode.nodeId
        || node.surfaceId !== this.hoveredNode.surfaceId || node.ownerId !== this.hoveredNode.ownerId)) {
      this.sendNodeInput('mouseleave', this.hoveredNode, wx, wy, e);
      this.hoveredNode = undefined;
    }
    if (node && !this.hoveredNode) {
      this.hoveredNode = node;
      this.sendNodeInput('mouseenter', node, wx, wy, e);
    }
    if (node) {
      const nodeSurface = node.surfaceId ? this.compositor.getSurface(node.surfaceId) : undefined;
      this.pendingMouseMove = {
        type: 'input',
        inputType: 'mousemove',
        surfaceId: node.surfaceId,
        nodeId: node.nodeId,
        nodeScope: node.scope,
        nodeOwnerId: node.ownerId,
        x: nodeSurface ? wx - nodeSurface.rect.x : wx,
        y: nodeSurface ? wy - nodeSurface.rect.y : wy,
        button: e.button,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
      } as unknown as FrontendToBackendMsg;
      if (!this.mouseMoveRafId) {
        this.mouseMoveRafId = requestAnimationFrame(() => {
          this.mouseMoveRafId = 0;
          if (this.pendingMouseMove) {
            this.sendToBackend(this.pendingMouseMove);
            this.pendingMouseMove = null;
          }
        });
      }
      return;
    }

    // Projection-correct local coords (slabs may be lifted/tilted in 3D).
    const hit = this.compositor.surfaceLocalAt(x, y);
    const surface = hit?.surface;

    const localX = hit ? hit.x : wx;
    const localY = hit ? hit.y : wy;

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
    const localX = wx - surface.rect.x;
    const localY = wy - surface.rect.y;
    const modifiers = {
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
    };

    // Trackpads emit wheel events at 60–120Hz. Coalesce into one input per
    // animation frame so a fast scroll doesn't fan out into a flood of
    // backend round-trips (and the worker re-renders that come with them).
    const prev = this.pendingWheels.get(surface.id);
    if (prev) {
      prev.deltaX += e.deltaX;
      prev.deltaY += e.deltaY;
      prev.x = localX;
      prev.y = localY;
      prev.modifiers = modifiers;
    } else {
      this.pendingWheels.set(surface.id, {
        surfaceId: surface.id,
        x: localX,
        y: localY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers,
      });
    }

    if (!this.wheelRafId) {
      this.wheelRafId = requestAnimationFrame(() => {
        this.wheelRafId = 0;
        for (const w of this.pendingWheels.values()) {
          this.sendToBackend({
            type: 'input',
            inputType: 'wheel',
            surfaceId: w.surfaceId,
            x: w.x,
            y: w.y,
            deltaX: w.deltaX,
            deltaY: w.deltaY,
            modifiers: w.modifiers,
          });
        }
        this.pendingWheels.clear();
      });
    }
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

    // Image paste: route each image file to the focused widget via the chunked
    // upload transport (tagged toFocusedWidget) so a widget can accept it.
    const items = e.clipboardData?.items;
    const imageFiles: File[] = [];
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      let n = 0;
      for (const file of imageFiles) {
        // Clipboard images often have no name — synthesize a stable one.
        const named = file.name
          ? file
          : new File([file], `pasted-image-${this.nextUploadSeq + n}.${(file.type.split('/')[1] || 'png')}`, { type: file.type });
        n++;
        void this.uploadFile(named, this.focusedSurface, true);
      }
      return;
    }

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
    if (this.transport && this.transport.ready) {
      this.transport.send(JSON.stringify(msg));
    }
  }
}
