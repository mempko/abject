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
  AuthResultMsg,
} from '../server/ws-protocol.js';

/**
 * The thin browser frontend that owns the Canvas and Compositor.
 */
export class FrontendClient {
  private compositor: Compositor;
  private canvas: HTMLCanvasElement;
  private ws: WebSocket | null = null;
  private focusedSurface?: string;
  private grabbedSurface?: string;
  private currentSelectedText = '';
  private authenticated = false;
  private loginFormHandler: ((e: Event) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.compositor = new Compositor(canvas);
    this.setupInputListeners();
  }

  /**
   * Connect to the backend WebSocket server.
   */
  connect(url: string): void {
    this.ws = new WebSocket(url);
    this.authenticated = false;

    this.ws.onopen = () => {
      console.log('[Frontend] Connected to backend');
      // Clear stale surfaces from any previous connection before replaying state
      this.compositor.clearAllSurfaces();
      this.focusedSurface = undefined;
      this.grabbedSurface = undefined;
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

        this.handleBackendMessage(msg as BackendToFrontendMsg);
      } catch (err) {
        console.error('[Frontend] Failed to parse backend message:', err);
      }
    };

    this.ws.onclose = (ev) => {
      console.log(`[Frontend] Disconnected from backend (code=${ev.code})`);
      this.ws = null;
      this.authenticated = false;

      // Auto-reconnect after disconnect (auth change, server restart, etc.)
      setTimeout(() => {
        console.log('[Frontend] Reconnecting...');
        this.connect(url);
      }, 1000);
    };

    this.ws.onerror = (err) => {
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
        this.sendRaw({ type: 'ready' });
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
          this.sendRaw({ type: 'ready' });
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
    this.canvas.addEventListener('mouseup', (e) => this.handleMouseEvent(e, 'mouseup'));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseEvent(e, 'mousemove'));
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

    // Hit test locally — compositor is local
    const hitSurface = this.compositor.surfaceAt(x, y);
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    const localX = surface ? x - surface.rect.x : x;
    const localY = surface ? y - surface.rect.y : y;

    this.sendToBackend({
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
    });

    if (type === 'mousedown' && surface) {
      this.grabbedSurface = surface.id;
      this.focusedSurface = surface.id;
    }

    if (type === 'mouseup') {
      this.grabbedSurface = undefined;
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
