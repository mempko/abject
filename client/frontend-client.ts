/**
 * FrontendClient — Thin browser client that owns the Canvas/Compositor.
 *
 * Receives draw/surface commands from BackendUI over WebSocket and renders
 * them locally. Captures input events and sends them back to the backend.
 * Handles measureText and displayInfo requests locally.
 */

/**
 * P6: identity of the deployed client bundle. Vite fingerprints the entry
 * script (index-<hash>.js); that hash identifies exactly which bundle is
 * running, so sessions can be matched against server logs and a stale
 * cached page becomes visible.
 */
const CLIENT_BUNDLE_ID: string = (() => {
  try {
    for (const script of Array.from(document.querySelectorAll('script[src]'))) {
      const m = (script.getAttribute('src') ?? '').match(/index-([A-Za-z0-9_-]+)\.js/);
      if (m) return m[1];
    }
  } catch {
    // DOM not available or query failed — fall through to unknown.
  }
  return 'unknown';
})();

import { Compositor, DrawCommand, MobileViewState } from '../src/ui/compositor.js';
import type { NodeDragEvent, NodeHit, CameraChangeEvent } from '../src/ui/compositor.js';
import type { SceneOp, SceneTheme } from '../src/ui/gl/scene-types.js';
import { isScreenAnchor } from '../src/ui/gl/scene-types.js';
import type { AbjectId } from '../src/core/types.js';
import type {
  BackendToFrontendMsg,
  FrontendToBackendMsg,
  CreateSurfaceMsg,
  DrawMsg,
  ImageBlobMsg,
  SetSelectedTextMsg,
  StartWindowDragMsg,
  AuthResultMsg,
  AudioPlayMsg,
  AudioControlMsg,
  AudioGraphMsg,
  MediaCaptureRequestMsg,
  MediaCaptureFrameRequestMsg,
  MediaRecordStartMsg,
  MediaRecordStopMsg,
  MediaStreamControlMsg,
  SpeechSpeakMsg,
  SpeechRecognizeRequestMsg,
  SpeechVoicesRequestMsg,
  VideoSetupMsg,
  VideoControlMsg,
} from '../server/ws-protocol.js';
import type { BackdropControl } from './backdrop.js';
import type { SlabEffectSpec, SlabMotionConfig } from '../src/ui/gl/slab-motion.js';
import type { SceneLibraryConfig } from '../src/ui/gl/scene-presets.js';
import { widgetFont, titleFont, codeFont, DEFAULT_THEME, TITLE_BAR_HEIGHT } from '../src/objects/widgets/widget-types.js';
import type { ClientTransport } from './transport.js';
import { WireEncoder, WireDecoder, isWireFrame } from '../src/network/wire-codec.js';
import { computeInputDelta } from './mobile-input-delta.js';

/**
 * The thin browser frontend that owns the Canvas and Compositor.
 */
/** Fonts to pre-measure for server-side text width computation */
const MEASURED_FONTS = [
  // Legacy (soft) themes: exact WIDGET_FONT / TITLE_FONT / CODE_FONT strings.
  '14px "Spectral", Georgia, "Times New Roman", serif',        // WIDGET_FONT
  '600 14px "Fraunces", "Spectral", Georgia, serif',           // TITLE_FONT
  '13px "Spline Sans Mono", "JetBrains Mono", monospace',      // CODE_FONT
  '14px system-ui',                                            // legacy WIDGET_FONT
  // Constructivist themes: the same roles, derived from the default theme so
  // the strings match what widgets build byte for byte.
  widgetFont(DEFAULT_THEME),
  titleFont(DEFAULT_THEME),
  codeFont(DEFAULT_THEME),
];

/**
 * Load every Latin web-font face the page declares (all weights and styles),
 * not just the ones measured above. Canvas text drawn with a face that has not
 * arrived yet is painted in a fallback font and never repainted, while layout
 * uses the real face's widths, so bold and italic runs overlapped their
 * neighbours on first paint. Faces load lazily by default; this makes them
 * all resident before the client reports ready.
 */
function preloadWebFontFaces(): Array<Promise<unknown>> {
  if (typeof document === 'undefined' || !document.fonts) return [];
  const loads: Array<Promise<unknown>> = [];
  document.fonts.forEach((face) => {
    // Google Fonts splits each face into unicode-range subsets; the Latin one
    // covers U+0000-00FF. Other scripts still load on demand.
    const range = face.unicodeRange ?? '';
    if (range && !/U\+0000-00FF/i.test(range)) return;
    if (face.status === 'unloaded') loads.push(face.load().catch(() => undefined));
  });
  return loads;
}

/** ASCII printable range pre-measured for every new font we see. */
const ASCII_MIN = 32;
const ASCII_MAX = 126;

export class FrontendClient {
  private compositor: Compositor;
  private canvas: HTMLCanvasElement;
  private transport: ClientTransport | null = null;
  /**
   * Wire codec pair, recreated on every (re)connect to stay in sync with the
   * fresh per-connection pair BackendUI creates when this client attaches.
   */
  private wireEnc = new WireEncoder();
  private wireDec = new WireDecoder();
  private wireDeflate = false;
  /** Wire frames processed on this connection; acked cumulatively per rAF. */
  private wireFramesReceived = 0;
  private frameAckScheduled = false;
  /**
   * Content-addressed image cache: sha256 → object URL for bytes received
   * via imageBlob. LRU-capped; evicted entries are re-requested on demand.
   */
  private imageBlobUrls: Map<string, string> = new Map();
  private static readonly IMAGE_BLOB_CACHE_MAX = 300;
  /** Draw commands waiting on a blob that wasn't cached (evicted or raced). */
  private pendingBlobDraws: Map<string, DrawCommand[]> = new Map();
  private focusedSurface?: string;
  /**
   * P1: set when the focused surface is destroyed by churn, with the owning
   * object id of the destroyed surface. The next createSurface for the same
   * object (the reminted replacement) is adopted as the new forwarding
   * target within FOCUS_ADOPTION_WINDOW_MS.
   */
  private focusedDestroyedAt = 0;
  private focusedDestroyedObjectId?: string;
  /** P1: how long after a focused-surface destroy a replacement may be adopted. */
  private static readonly FOCUS_ADOPTION_WINDOW_MS = 10_000;
  /** P3: last clientDiagnostic send per gate, for per-gate rate limiting. */
  private lastDiagnosticAt: Record<string, number> = {};
  private grabbedSurface?: string;
  /** Latest setFocused surface id deferred by an interaction guard; applied
   *  when the guard clears (touch end, drag end, composition end, blur). */
  private pendingMobileAutoSwitch?: string;
  /** Currently hovered 3D scene node (mesh), for enter/leave synthesis. */
  private hoveredNode?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
  /**
   * Drag capture for 3D nodes: set on node mousedown, released on mouseup.
   * While set, mousemove streams to this node even when the cursor outruns
   * the mesh — smooth drags, like window/widget grabs.
   */
  private grabbedNode?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
  /** The grabbed node is draggable: pointer moves drive the compositor's drag. */
  private nodeDragging = false;
  /** Last pointer (viewport px) of a node drag, for the drag messages' x/y. */
  private nodeDragPointer = { x: 0, y: 0 };
  /** Throttle state for dragMove messages (about 10 per second). */
  private nodeDragLastSent = 0;
  private nodeDragPending?: NodeDragEvent;
  private nodeDragTimer?: ReturnType<typeof setTimeout>;
  private static readonly NODE_DRAG_MOVE_MS = 100;
  /** A held pointer is orbiting a window's camera node (the window never saw the press). */
  private cameraOrbiting = false;
  /** Latest unsent camera 'move' per camera, flushed about 10 per second. */
  private cameraPending = new Map<string, CameraChangeEvent>();
  private cameraLastSent = 0;
  private cameraTimer?: ReturnType<typeof setTimeout>;
  /**
   * A focusable node holds the keyboard exclusively: keys flow to the
   * backend (which routes them to the node) even with no focused window.
   */
  private nodeKeyFocus?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
  /** Per-node accumulated wheel deltas; flushed once per animation frame. */
  private pendingNodeWheels: Map<string, {
    node: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: string; nodeId: string };
    x: number; y: number; deltaX: number; deltaY: number;
    modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  }> = new Map();
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
  /** A phone-sized touch screen, in either orientation (reported to the backend). */
  private isPhone = false;
  /** Touch-capable device (phones AND tablets in desktop layout) -- gates the virtual keyboard. */
  private touchDevice = false;
  private mobileKeyboardProxy?: HTMLInputElement;  // hidden input for virtual keyboard
  /** Proxy value already forwarded to the backend (delta baseline). */
  private proxySentValue = '';
  /** True while an IME composition (predictive/autocorrect) is active in the proxy. */
  private proxyComposing = false;
  /** Backend wants the virtual keyboard up (a text widget holds focus). */
  private keyboardWanted = false;
  /** Virtual keyboard currently shown (tracked via visualViewport shrink). */
  private keyboardVisible = false;
  /** The text field the keyboard serves (window-local rect), when the widget says. */
  private keyboardField?: { surfaceId: string; rect: { x: number; y: number; width: number; height: number } };
  /** Camera pose before the keyboard panned it, restored when the keyboard goes. */
  private keyboardRestoreCam?: ReturnType<Compositor['mobileReveal']>;
  private keyboardRevealTimer?: ReturnType<typeof setTimeout>;
  /** Surfaces that just appeared (not a reconnect replay): the phone flies into them on focus. */
  private recentlyCreated = new Map<string, number>();
  /** Between 'ready' and the end of the backend's state replay. */
  private replayingState = false;
  private replayTimer?: ReturnType<typeof setTimeout>;

  // ── Phone gestures: the phone is a camera on the desktop ──
  private static readonly DOUBLE_TAP_MS = 300;
  private static readonly TAP_SLOP_PX = 10;
  private static readonly EDGE_SWIPE_TRIGGER_PX = 40;
  /** Hold after a swipe up from the handle opens Exposé. */
  private static readonly EXPOSE_HOLD_MS = 450;
  private static readonly LONG_PRESS_MS = 450;
  private static readonly FLICK_VELOCITY = 0.6;  // px/ms upward to close an Exposé window
  private static readonly CLOSE_DISTANCE = 120;  // px dragged up to close
  /** Two-finger swipes starting this close to a side edge fly to the neighbour window. */
  private static readonly EDGE_ZONE_PX = 24;
  /** A tap this close to a title-bar button (screen px) snaps onto it. */
  private static readonly TITLE_TAP_SNAP_PX = 14;
  /** Title-bar button geometry (the theme defaults WindowAbject draws with). */
  private static readonly TITLE_BUTTON_SIZE = 24;
  private static readonly TITLE_BUTTON_MARGIN = 6;
  /** Scrolling widgets move a fixed step per wheel event (they read its sign). */
  private static readonly WHEEL_STEP = 30;
  /** One finger on the phone. `mode` is decided by where it lands and how it moves. */
  private activeTouch?: {
    id: number;
    startX: number; startY: number; startTime: number;
    lastX: number; lastY: number; lastTime: number;
    /** Finger velocity, px/ms (smoothed). */
    vx: number; vy: number;
    mode: 'undecided' | 'mouse' | 'pan' | 'scroll' | 'held' | 'orbit' | 'handle' | 'expose' | 'exposeLift' | 'exposeSwipe' | 'ignore';
    /** Surface / interactive node under the press, and the press in surface-local px. */
    surfaceId?: string;
    node?: NodeHit;
    local?: { x: number; y: number };
    /** The press landed on a window's title bar (a drag moves the window). */
    title?: boolean;
    /** The press landed where a window's orbiting camera captures the pointer. */
    orbit?: boolean;
    /** The touch stopped a glide or a scroll: it is not a tap. */
    caught?: boolean;
    swipedUp?: boolean;
    exposeId?: string;
    scrollAcc: number;
    scrollAxis?: 'x' | 'y';
    longPressTimer?: ReturnType<typeof setTimeout>;
    holdTimer?: ReturnType<typeof setTimeout>;
  };
  /** Two fingers on the phone: pinch zoom and pan (always the camera). */
  private pinch?: {
    lastDist: number; lastMidX: number; lastMidY: number;
    startDist: number; startMidX: number;
    /** Started at a side edge: -1 left, 1 right. */
    edge?: -1 | 1;
  };
  /** Desktop view: a tap waits a moment so a second tap can zoom instead of clicking. */
  private pendingTap?: { timer: ReturnType<typeof setTimeout>; fire: () => void };
  private lastTap?: { x: number; y: number; time: number };
  /** Where the last tap landed (screen px), the keyboard pan's fallback target. */
  private lastTapPoint?: { x: number; y: number };
  /** A one-finger scroll released with speed keeps scrolling (wheel steps) until it settles. */
  private scrollGlide?: { surfaceId?: string; node?: NodeHit; local: { x: number; y: number }; v: number; acc: number; last: number; raf: number };
  /** Client-side drag state for zero-latency window moves */
  /**
   * Whether the primary button (or the finger driving mouse input) is down.
   * A quick click on a title bar can release before the backend's
   * startWindowDrag arrives; that late start must not begin a drag that
   * follows the pointer with no button held.
   */
  private primaryHeld = false;
  private localDragState?: {
    surfaceId: string;
    dragType: 'move' | 'resize';
    startX: number;
    startY: number;
    startSurfaceX: number;
    startSurfaceY: number;
  };
  /** Where the last press landed on a surface (and that surface's rect then). */
  private pressAt?: { surfaceId: string; x: number; y: number; rectX: number; rectY: number };
  /** Track last canvas-space mouse position for drag start */
  private lastCanvasX = 0;
  private lastCanvasY = 0;
  private backdrop?: BackdropControl;
  private resizableSurfaces: Set<string> = new Set();
  private fileUploadProxy?: HTMLInputElement;

  // ── Audio playback + media capture state (backend-relayed) ────────────
  private audioPlaybacks: Map<string, HTMLAudioElement> = new Map();
  /** Synthesized Web Audio graphs (from audioGraph). Value stops+tears down the graph. */
  private audioGraphs: Map<string, (immediate?: boolean) => void> = new Map();
  private sharedAudioCtx?: AudioContext;
  private mediaStreams: Map<string, MediaStream> = new Map();
  /** Hidden playing <video> per video-bearing stream so frames are grabbable. */
  private mediaVideoEls: Map<string, HTMLVideoElement> = new Map();
  /** Video-widget elements keyed by videoId; frames composite via the compositor. */
  private videoWidgetEls: Map<string, HTMLVideoElement> = new Map();
  /** Per-video throttle stamp for 'time' events (1/sec drives seek bars). */
  private videoTimeStamps: Map<string, number> = new Map();
  private mediaRecorders: Map<string, {
    recorder: MediaRecorder;
    chunks: Blob[];
    startedAt: number;
    timer?: ReturnType<typeof setTimeout>;
  }> = new Map();
  /** Surface that requested the file picker; the chosen file routes back to it. */
  private fileUploadTargetSurface?: string;
  /** Monotonic counter to give each upload a unique id for chunk reassembly. */
  private nextUploadSeq = 0;

  constructor(canvas: HTMLCanvasElement, backdrop?: BackdropControl) {
    this.canvas = canvas;
    this.backdrop = backdrop;
    this.compositor = new Compositor(canvas);
    // Relay compositor diagnostics (e.g. cross-origin surface taint) into the
    // backend log via the clientDiagnostic message — the browser console is
    // invisible in abject.log.
    this.compositor.onDiagnostic = (gate, detail) => this.sendDiagnostic(gate, detail);
    // Model nodes name their bytes by content ref; they come from the same
    // blob cache as images (a missing blob is requested; the model waits).
    this.compositor.setBlobResolver((hash) => this.resolveContentBlob(hash));
    // Node drags run in the compositor; this relays them to the backend.
    this.compositor.onNodeDrag = (e) => this.relayNodeDrag(e);
    this.compositor.onCameraChange = (e) => this.relayCameraChange(e);
    this.detectMobileMode();
    this.setupInputListeners();
    this.setupMobileKeyboard();
    this.setupKeyboardCamera();
    this.setupFileUpload();
    this.setupMobilePaletteButton();
    this.setupMobileExposeButton();
  }

  /**
   * Wire the floating mobile palette button (touch equivalent of desktop
   * Cmd/Ctrl+K). It sends the exact same globalShortcut message the desktop
   * keydown handler sends, so the per-workspace CommandPalette abject opens
   * in the canvas with the same registry-sourced entry list.
   */
  private setupMobilePaletteButton(): void {
    const btn = document.getElementById('mobile-palette-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!this.authenticated) return;
      this.sendToBackend({ type: 'globalShortcut', combo: 'commandPalette' });
    });
    this.updateMobileButtons();
  }

  /**
   * Wire the floating mobile Exposé button: opens the same window overview
   * the swipe-up-and-hold gesture on the bottom handle opens, as a tap.
   */
  private setupMobileExposeButton(): void {
    const btn = document.getElementById('mobile-expose-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!this.authenticated) return;
      this.compositor.enterExpose();
    });
    this.updateMobileButtons();
  }

  /** Show the floating mobile buttons only on mobile once authenticated. */
  private updateMobileButtons(): void {
    // Out of the way while the virtual keyboard is up (it would cover the field).
    const show = this.authenticated && this.mobileMode && !this.keyboardVisible;
    for (const id of ['mobile-palette-btn', 'mobile-expose-btn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      if (show) {
        btn.removeAttribute('hidden');
      } else {
        btn.setAttribute('hidden', '');
      }
    }
  }

  private detectMobileMode(): void {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const narrow = window.innerWidth < 768;
    const touch = 'ontouchstart' in window;
    // touchDevice gates the virtual keyboard only. maxTouchPoints catches
    // iPadOS Safari, which masquerades as desktop macOS (pointer: fine, no
    // ontouchstart) yet still needs the on-screen keyboard.
    this.touchDevice = coarse || touch || navigator.maxTouchPoints > 0;
    // mobileMode gates the phone layout. Deliberately narrower than
    // touchDevice: a desktop-masquerading tablet keeps the desktop layout.
    this.mobileMode = (coarse || touch) && narrow;
    // A phone (even turned to landscape) looks at the desktop through a
    // camera; the backend sizes the desktop from non-phone clients.
    this.isPhone = (coarse || touch) && Math.min(screen.width, screen.height) < 768;
    this.compositor.setMobileMode(this.mobileMode);

    // Re-detect on resize (tablet rotation)
    window.addEventListener('resize', () => {
      const wasMobile = this.mobileMode;
      const nowNarrow = window.innerWidth < 768;
      this.mobileMode = (coarse || touch) && nowNarrow;
      if (this.mobileMode !== wasMobile) {
        this.compositor.setMobileMode(this.mobileMode);
        this.updateMobileButtons();
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
          mobile: this.mobileMode || this.isPhone,
        });
      }, 250);
    });
  }

  private setupMobileKeyboard(): void {
    const proxy = document.getElementById('mobile-keyboard-proxy') as HTMLInputElement | null;
    if (!proxy) return;
    this.mobileKeyboardProxy = proxy;

    // Keep a zero-width-space sentinel in the proxy: iOS fires no event at
    // all for backspace on an empty field, so deletion must always have a
    // character to consume.
    this.proxySentValue = FrontendClient.KB_SENTINEL;
    this.proxyComposing = false;

    proxy.addEventListener('focus', () => this.resetProxySentinel(proxy));

    // Track composition state. Mobile IMEs (GBoard, iOS predictive) deliver
    // typed text as insertCompositionText updates that cannot be
    // preventDefault-ed; the composed text lands in the proxy and is
    // forwarded as a delta against the last-sent value.
    proxy.addEventListener('compositionstart', () => { this.proxyComposing = true; });
    proxy.addEventListener('compositionend', () => {
      this.proxyComposing = false;
      // Flush whatever the composition produced
      this.flushProxyInput(proxy);
      // Composition guard released — a deferred auto-switch can land now.
      this.applyPendingMobileAutoSwitch();
    });

    // Deliver composed/autocorrected text as it evolves. Some keyboards
    // (iOS autocorrect/predictive) often never fire compositionend, so
    // relying on it to flush dropped every composed character; 'input'
    // fires after each edit the keyboard applies to the proxy, and the
    // delta against the last-sent value is what reaches the widget.
    proxy.addEventListener('input', () => {
      if (!this.focusedSurface) {
        console.warn('[frontend-client] mobile proxy input dropped: no focused surface');
        this.sendDiagnostic('proxy-input', 'proxy input dropped: no focused surface');
        return;
      }
      this.sendProxyDelta(proxy);
    });

    // Flush pending composed text when the proxy loses focus (keyboard
    // dismissed, another element focused) so nothing is left stranded.
    proxy.addEventListener('blur', () => {
      this.flushProxyInput(proxy);
      // A blur ends any in-flight composition (some keyboards, e.g. iOS
      // predictive, never fire compositionend), so the composition guard
      // must be released here too — a deferred auto-switch can then land.
      this.proxyComposing = false;
      this.applyPendingMobileAutoSwitch();
    });

    // Use beforeinput for the most reliable character capture on mobile.
    // Only handle insertText (typed characters) and insertCompositionText here.
    proxy.addEventListener('beforeinput', (e: InputEvent) => {
      if (!this.focusedSurface) {
        console.warn(`[frontend-client] mobile proxy beforeinput (${e.inputType}) dropped: no focused surface`);
        this.sendDiagnostic('proxy-beforeinput', `beforeinput ${e.inputType} dropped: no focused surface`);
        return;
      }

      // While an IME composition is active the keyboard owns the proxy's
      // content: every edit lands in the field and is delta-forwarded by
      // the 'input' listener above. Never reset the proxy mid-composition —
      // a programmatic value write aborts the composition and the
      // compositionend flush never arrives.
      if (this.proxyComposing) return;

      if (e.inputType === 'insertText' && e.data) {
        e.preventDefault();
        this.sendTypedChars(e.data);
        this.resetProxySentinel(proxy);
        return;
      }

      // insertReplacementText (iOS autocorrect substitutions), insertFromPaste
      // and other insertions we do not cancel: let the edit land in the
      // proxy and forward the resulting delta via the 'input' listener.
      if (e.inputType.startsWith('insert') && e.data) {
        return;
      }

      // Deletions: backspace variants map to Backspace (word-level deletes
      // send a single Backspace), forward delete maps to Delete. While an
      // IME composition is active the IME edits the proxy itself and
      // compositionend flushes the net result, so let those pass through.
      if (e.inputType.startsWith('delete')) {
        // deleteCompositionText is the IME undoing its own edits; the
        // delta sync above already accounts for the net change.
        if (e.inputType === 'deleteCompositionText' || e.inputType === 'deleteByComposition') return;
        e.preventDefault();
        const key = e.inputType === 'deleteContentForward' ? 'Delete' : 'Backspace';
        this.sendSpecialKey(key, key);
        this.resetProxySentinel(proxy);
        return;
      }

      // insertLineBreak = Enter on mobile
      if (e.inputType === 'insertLineBreak') {
        e.preventDefault();
        this.sendSpecialKey('Enter', 'Enter');
        return;
      }

      // Unknown input types (historyUndo, format*, ...) are not text input,
      // but log them loudly: a silent fall-through here is exactly how typed
      // text was being lost (insertCompositionText/insertReplacementText
      // used to fall through this handler with no branch at all).
      console.warn(`[mobile-keyboard] unhandled beforeinput inputType: ${e.inputType}`, { data: e.data });
    });

    // Fallback: capture special keys that don't fire beforeinput (arrows, Tab, Escape)
    proxy.addEventListener('keydown', (e) => {
      if (!this.focusedSurface) return;
      // Skip printable characters -- handled by beforeinput
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) return;
      // Skip keys already handled by beforeinput
      if (e.key === 'Backspace' || e.key === 'Enter') return;
      // Deliver any pending composed text first so it precedes the special key.
      this.sendProxyDelta(proxy);
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

  /** Zero-width space kept in the proxy so backspace always has a target. */
  private static readonly KB_SENTINEL = '\u200b';

  /** Restore the proxy to just the sentinel with the caret after it. */
  private resetProxySentinel(proxy: HTMLInputElement): void {
    // A programmatic value write aborts an active IME composition (and the
    // compositionend that would flush it) — never touch the field then.
    if (this.proxyComposing) return;
    proxy.value = FrontendClient.KB_SENTINEL;
    proxy.setSelectionRange(proxy.value.length, proxy.value.length);
    this.proxySentValue = proxy.value;
  }

  /**
   * P6: tell the backend which client bundle this session runs. Sent on the
   * post-auth path as a 'hello' handshake carrying the bundle identity.
   */
  private sendBundleIdentity(): void {
    this.sendRaw({
      type: 'hello',
      client: {
        bundle: CLIENT_BUNDLE_ID,
        userAgent: navigator.userAgent,
        mobile: this.mobileMode || this.isPhone,
      },
    });
  }

  /** Flush any remaining text in the proxy input (after composition ends,
   *  on blur, or when the keyboard is dismissed). */
  private flushProxyInput(proxy: HTMLInputElement): void {
    if (this.focusedSurface) this.sendProxyDelta(proxy);
    this.resetProxySentinel(proxy);
  }

  /** Forward the difference between the proxy's current value and the value
   *  already delivered to the backend. Delta-based so it works for plain
   *  appends AND for in-place replacements (autocorrect/predictive text). */
  private sendProxyDelta(proxy: HTMLInputElement): void {
    const delta = computeInputDelta(this.proxySentValue, proxy.value);
    // Update the forwarded baseline ONLY when the delta is actually
    // delivered: absorbing it before the focusedSurface gate silently
    // swallowed typed text whenever no surface held focus.
    if (!this.focusedSurface) {
      this.sendDiagnostic('proxy-delta', `proxy delta dropped: no focused surface (len ${proxy.value.length})`);
      return;
    }
    this.proxySentValue = proxy.value;
    for (let i = 0; i < delta.backspaces; i++) {
      this.sendSpecialKey('Backspace', 'Backspace');
    }
    this.sendTypedChars(delta.inserted);
  }

  /** Send printable characters as per-char keydown input messages. */
  private sendTypedChars(text: string): void {
    if (!this.focusedSurface) return;
    for (const ch of text) {
      this.sendToBackend({
        type: 'input',
        inputType: 'keydown',
        surfaceId: this.focusedSurface,
        key: ch,
        code: '',
        modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      } as FrontendToBackendMsg);
    }
  }

  /** Send a single non-printable key (Backspace, Delete, Enter, ...). */
  private sendSpecialKey(key: string, code: string): void {
    if (!this.focusedSurface) return;
    this.sendToBackend({
      type: 'input',
      inputType: 'keydown',
      surfaceId: this.focusedSurface,
      key,
      code,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    } as FrontendToBackendMsg);
  }

  /**
   * P3: report a silent client-side drop to the backend as a clientDiagnostic
   * message so it lands in the server log — the browser console never crosses
   * the wire. Rate-limited to one message per gate per second.
   */
  private sendDiagnostic(gate: string, detail: string): void {
    const now = Date.now();
    if (now - (this.lastDiagnosticAt[gate] ?? 0) < 1000) return;
    this.lastDiagnosticAt[gate] = now;
    this.sendRaw({ type: 'clientDiagnostic', gate, detail });
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

  /**
   * Summon the virtual keyboard from inside a trusted touch gesture. iOS only
   * raises the keyboard for focus() calls made during user interaction, so
   * the async showMobileKeyboard round-trip records intent (keyboardWanted)
   * and the tap that follows completes the summon here.
   */
  private summonKeyboardIfWanted(): void {
    if (!this.keyboardWanted || !this.touchDevice || !this.mobileKeyboardProxy) return;
    if (this.keyboardVisible) {
      // Keyboard is already up: just re-establish proxy focus so its
      // beforeinput/input listeners keep firing after surface churn (a
      // destroy/recreate can leave the proxy unfocused). Do NOT do the full
      // blur/refocus dance here — blurring would dismiss the keyboard.
      if (document.activeElement !== this.mobileKeyboardProxy) {
        this.focusMobileKeyboard();
      }
      return;
    }
    // Refocus from scratch: iOS ignores focus() on an already-focused
    // element, and the earlier async attempt may have left the proxy
    // focused without a keyboard.
    if (document.activeElement === this.mobileKeyboardProxy) {
      this.mobileKeyboardProxy.blur();
    }
    this.focusMobileKeyboard();
  }

  /** Focus the hidden input proxy to trigger the mobile virtual keyboard. */
  private focusMobileKeyboard(): void {
    if (!this.touchDevice || !this.mobileKeyboardProxy) return;
    // Move proxy on-screen briefly so iOS respects the focus
    this.mobileKeyboardProxy.style.left = '0';
    this.mobileKeyboardProxy.focus({ preventScroll: true });
    // Move it back off-screen after focus is established
    requestAnimationFrame(() => {
      if (this.mobileKeyboardProxy) {
        this.mobileKeyboardProxy.style.left = '-9999px';
      }
    });
  }

  /**
   * Keep the focused text field visible above the virtual keyboard by
   * panning the phone camera (the canvas itself never moves).
   *
   * Two keyboard behaviours reach here through the visual viewport:
   *  - `interactive-widget=resizes-content` (Android Chrome) shrinks the
   *    layout viewport, so the canvas itself gets shorter;
   *  - resizes-visual (iOS Safari) keeps the canvas full height and covers
   *    its bottom with the keyboard.
   * Either way the visible band of the canvas shrinks. The keyboard counts
   * as up when that band is well short of the tallest seen at this width.
   * When it opens (or the field moves while it is up) the camera pans so the
   * field sits inside the band; when it closes the camera flies back.
   */
  private setupKeyboardCamera(): void {
    if (!window.visualViewport) return;
    const vv = window.visualViewport;
    let baseWidth = 0;
    let baseHeight = 0;
    const update = () => {
      if (Math.abs(window.innerWidth - baseWidth) > 2) {
        baseWidth = window.innerWidth;
        baseHeight = 0;
      }
      baseHeight = Math.max(baseHeight, window.innerHeight, vv.height);
      const covered = baseHeight - vv.height;
      const visible = covered > 80;
      if (this.keyboardVisible && !visible) {
        // Keyboard closed (user dismissed it, or focus moved on): drop the
        // summon intent so the next tap doesn't immediately resurrect it.
        this.keyboardWanted = false;
      }
      if (this.keyboardVisible !== visible) {
        this.keyboardVisible = visible;
        this.updateMobileButtons();
      }
      this.scheduleKeyboardReveal();
    };
    // The page loads without a keyboard: that height is the baseline.
    baseWidth = window.innerWidth;
    baseHeight = Math.max(window.innerHeight, vv.height);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);
  }

  /** Re-run the keyboard pan once the viewport (and the canvas) settle. */
  private scheduleKeyboardReveal(): void {
    if (this.keyboardRevealTimer) clearTimeout(this.keyboardRevealTimer);
    this.keyboardRevealTimer = setTimeout(() => {
      this.keyboardRevealTimer = undefined;
      this.applyKeyboardReveal();
    }, 120);
  }

  private applyKeyboardReveal(): void {
    if (!this.mobileMode) return;
    const vv = window.visualViewport;
    const r = this.canvas.getBoundingClientRect();
    const top = Math.max(0, (vv?.offsetTop ?? 0) - r.top);
    const bottom = Math.min(r.height, top + (vv?.height ?? r.height));
    if (!this.keyboardVisible) {
      this.compositor.setMobileBottomInset(0);
      if (this.keyboardRestoreCam) this.compositor.mobileRestore(this.keyboardRestoreCam);
      this.keyboardRestoreCam = undefined;
      return;
    }
    this.compositor.setMobileBottomInset(Math.max(0, r.height - bottom));
    const field = this.keyboardFieldRect();
    if (!field) return;
    const before = this.compositor.mobileReveal(field, top, bottom);
    if (before && !this.keyboardRestoreCam) this.keyboardRestoreCam = before;
  }

  /**
   * The keyboard's text field on screen: the rect the widget reported,
   * projected through its window, or else a band around the last tap.
   */
  private keyboardFieldRect(): { x: number; y: number; width: number; height: number } | undefined {
    const f = this.keyboardField;
    if (f && this.compositor.getSurface(f.surfaceId)) {
      const a = this.compositor.surfaceLocalToViewport(f.surfaceId, f.rect.x, f.rect.y);
      const b = this.compositor.surfaceLocalToViewport(f.surfaceId, f.rect.x + f.rect.width, f.rect.y + f.rect.height);
      if (a && b) {
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      }
    }
    if (!this.lastTapPoint) return undefined;
    return { x: this.lastTapPoint.x - 20, y: this.lastTapPoint.y - 20, width: 40, height: 40 };
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
      // Fresh connection — the backend created a fresh codec pair for us
      this.wireEnc = new WireEncoder();
      this.wireDec = new WireDecoder();
      this.wireDeflate = transport.kind === 'websocket';
      this.wireFramesReceived = 0;
      for (const url of this.imageBlobUrls.values()) URL.revokeObjectURL(url);
      this.imageBlobUrls.clear();
      this.pendingBlobDraws.clear();
      // Clear stale surfaces from any previous connection before replaying state
      this.compositor.clearAllSurfaces();
      // A phone starts on the whole desktop, fitted as the replay arrives.
      this.compositor.mobileFitNow();
      this.recentlyCreated.clear();
      this.focusedSurface = undefined;
      this.compositor.setFocusedSurface(undefined);
      this.grabbedSurface = undefined;
      this.localDragState = undefined;
      this.authenticated = false;
      // Don't send ready yet — wait for auth status from server
    });

    transport.onMessage((data: string | Uint8Array) => {
      try {
        // Binary wire frames carry the UI protocol; JSON (text frame, or
        // UTF-8 bytes on the WebRTC path) carries the pre-auth exchange.
        let msg: unknown;
        if (typeof data === 'string') {
          msg = JSON.parse(data);
        } else if (isWireFrame(data)) {
          msg = this.wireDec.decodeFrame(data);
          this.wireFramesReceived++;
          this.scheduleFrameAck();
        } else {
          msg = JSON.parse(new TextDecoder().decode(data));
        }

        // Handle auth protocol before authenticated
        if (!this.authenticated) {
          this.handleAuthMessage(msg as { type: string; [key: string]: unknown });
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
        console.error('[Frontend] Failed to decode backend message:', err);
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
        this.updateMobileButtons();
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
          this.updateMobileButtons();
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
    this.backdrop?.setDescending(true);
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
    this.backdrop?.setDescending(false);
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
    // Web fonts load lazily on first use. Measuring a face that has not
    // arrived yet would ship the fallback font's widths, and the backend
    // caches the first metrics it gets, so wait for the face first.
    if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(font)) {
      document.fonts.load(font)
        .catch(() => undefined)
        .then(() => this.measureAndShipFont(font));
      return;
    }
    this.measureAndShipFont(font);
  }

  private measureAndShipFont(font: string): void {
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
    // P6: report which client bundle this session runs so server logs can
    // attribute sessions to a deployed bundle (and a stale cached page is
    // visible in the log).
    this.sendBundleIdentity();
    // Explicitly load every pre-measured face: `fonts.ready` only covers
    // faces something has already asked for, and nothing has drawn yet.
    const loads = [
      ...MEASURED_FONTS.map((f) => document.fonts.load(f).catch(() => undefined)),
      ...preloadWebFontFaces(),
    ];
    Promise.all(loads)
      .then(() => document.fonts.ready)
      .then(() => {
        this.sendFontMetrics();
        // Surfaces the backend replays now are not new windows (no fly-in).
        this.replayingState = true;
        if (this.replayTimer) clearTimeout(this.replayTimer);
        this.replayTimer = setTimeout(() => this.endReplay(), 3000);
        this.sendRaw({ type: 'ready' });
      });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.transport && this.transport.ready) {
      // Pre-auth messages ride as JSON (the server auth layer reads them off
      // the raw socket, before the wire codec pair exists); everything after
      // auth is binary.
      if (this.authenticated) {
        this.transport.send(this.wireEnc.encodeFrame(msg, this.wireDeflate));
      } else {
        this.transport.send(JSON.stringify(msg));
      }
    }
  }

  // ── Backend message handling ──────────────────────────────────────────

  private handleBackendMessage(msg: BackendToFrontendMsg): void {
    switch (msg.type) {
      case 'createSurface':
        this.handleCreateSurface(msg as CreateSurfaceMsg);
        break;

      case 'destroySurface': {
        // P1: capture the destroyed surface's owning object BEFORE the
        // compositor drops it, so the reminted replacement surface (same
        // object, new id) can be adopted as the new forwarding target in
        // handleCreateSurface.
        const destroyedObjectId = this.compositor.getSurface(msg.surfaceId)?.objectId;
        this.compositor.destroySurface(msg.surfaceId);
        this.resizableSurfaces.delete(msg.surfaceId);
        this.recentlyCreated.delete(msg.surfaceId);
        // The destroyed surface may have held keyboard focus (window churn on
        // mobile destroys a surface and recreates it under a new id). A stale
        // focusedSurface silently swallows every keystroke and strands the
        // keyboard proxy's forwarding target. Clear the stale focus and
        // re-summon the proxy so typing keeps working on the new surface.
        if (this.focusedSurface === msg.surfaceId) {
          this.focusedSurface = undefined;
          this.focusedDestroyedAt = Date.now();
          this.focusedDestroyedObjectId = destroyedObjectId;
          this.compositor.setFocusedSurface(undefined);
          this.summonKeyboardIfWanted();
        }
        break;
      }

      case 'imageBlob':
        this.handleImageBlob(msg as ImageBlobMsg);
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
        // The replay restores focus after recreating every surface.
        if (this.replayingState) this.endReplay();
        this.focusedSurface = msg.surfaceId;
        if (msg.glowColor) this.compositor.setFocusGlowColor(msg.glowColor);
        if (typeof msg.glowRadius === 'number') this.compositor.setFocusGlowRadius(msg.glowRadius);
        this.compositor.setFocusedSurface(msg.surfaceId);
        this.mobileAutoSwitchToFocusedSurface(msg.surfaceId);
        break;

      case 'sceneOps':
        if (msg.world && msg.ownerId) {
          this.compositor.applyWorldSceneOps(msg.ownerId, msg.ops as unknown as SceneOp[]);
        } else {
          this.compositor.applySceneOps(msg.surfaceId, msg.ops as unknown as SceneOp[]);
        }
        break;

      case 'setSceneTheme': {
        // The replay sends the theme after every surface (and focus).
        if (this.replayingState) this.endReplay();
        const sceneTheme = msg.theme as unknown as SceneTheme;
        this.compositor.setSceneTheme(sceneTheme);
        // The backdrop follows the theme: abyss or constructivist poster.
        this.backdrop?.setTheme(sceneTheme);
        break;
      }

      case 'surfaceEffect':
        this.compositor.surfaceEffect(msg.surfaceId, msg.effect as string | SlabEffectSpec, msg.color);
        break;
      case 'setSurfaceModal':
        this.compositor.setSurfaceModal(msg.surfaceId, msg.modal);
        break;
      case 'setSlabMotion':
        this.compositor.setSlabMotion(msg.config as unknown as SlabMotionConfig);
        break;
      case 'setSceneLibrary':
        this.compositor.setSceneLibrary(msg.config as unknown as SceneLibraryConfig);
        break;
      case 'expose':
        this.setExpose(msg.action);
        break;
      case 'setSurfaceTransform':
        this.compositor.setSurfaceTransform(msg.surfaceId, { rotation: msg.rotation, z: msg.z });
        break;
      case 'attachSurface':
        this.compositor.setSurfaceAttachment(msg.surfaceId, msg.target, msg.origin);
        break;

      case 'measureTextRequest':
        this.handleMeasureTextRequest(msg.requestId!, msg.surfaceId, msg.text, msg.font);
        break;

      case 'displayInfoRequest':
        this.handleDisplayInfoRequest(msg.requestId!);
        break;

      case 'sceneInfoRequest':
        this.handleSceneInfoRequest(msg.requestId!);
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

      case 'clipboardWriteImage':
        // Write an image (data:image/* URI) to the OS clipboard via ClipboardItem.
        (async () => {
          try {
            const blob = await (await fetch(msg.image)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          } catch (err) {
            console.warn('[Frontend] Clipboard image write failed:', err);
          }
        })();
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
          // The field's place (newer widgets send it) lets the phone camera
          // keep it above the keyboard; without it the last tap stands in.
          if (msg.surfaceId && msg.rect) {
            this.keyboardField = { surfaceId: msg.surfaceId, rect: { ...msg.rect } };
          } else {
            this.keyboardField = undefined;
          }
          // Try to focus right away; platforms that reject programmatic
          // focus outside a user gesture (iOS) are covered by the next tap
          // completing the summon in-gesture via keyboardWanted.
          this.keyboardWanted = true;
          this.focusMobileKeyboard();
          if (this.keyboardVisible) this.scheduleKeyboardReveal();
        } else {
          this.keyboardWanted = false;
          if (this.mobileKeyboardProxy) this.mobileKeyboardProxy.blur();
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

      case 'audioPlay':
        this.handleAudioPlay(msg as AudioPlayMsg);
        break;

      case 'audioControl':
        this.handleAudioControl(msg as AudioControlMsg);
        break;

      case 'audioGraph':
        this.handleAudioGraph(msg as AudioGraphMsg);
        break;

      case 'mediaCaptureRequest':
        this.handleMediaCaptureRequest(msg as MediaCaptureRequestMsg);
        break;

      case 'mediaCaptureFrameRequest':
        this.handleMediaCaptureFrameRequest(msg as MediaCaptureFrameRequestMsg);
        break;

      case 'mediaRecordStart':
        this.handleMediaRecordStart(msg as MediaRecordStartMsg);
        break;

      case 'mediaRecordStop':
        this.handleMediaRecordStop(msg as MediaRecordStopMsg);
        break;

      case 'mediaStreamControl':
        this.handleMediaStreamControl(msg as MediaStreamControlMsg);
        break;

      case 'speechSpeak':
        this.handleSpeechSpeak(msg as SpeechSpeakMsg);
        break;

      case 'speechRecognizeRequest':
        this.handleSpeechRecognize(msg as SpeechRecognizeRequestMsg);
        break;

      case 'speechVoicesRequest':
        this.handleSpeechVoices(msg as SpeechVoicesRequestMsg);
        break;

      case 'videoSetup':
        this.handleVideoSetup(msg as VideoSetupMsg);
        break;

      case 'videoControl':
        this.handleVideoControl(msg as VideoControlMsg);
        break;
    }
  }

  // ── Audio playback (relayed from the AudioOutput capability) ─────────

  private handleAudioPlay(msg: AudioPlayMsg): void {
    try {
      const audio = new Audio(msg.source);
      audio.volume = Math.max(0, Math.min(1, msg.volume ?? 1));
      audio.loop = msg.loop ?? false;
      audio.addEventListener('ended', () => {
        // Looping audio never fires 'ended'; map cleanup happens on stop.
        this.audioPlaybacks.delete(msg.playbackId);
        this.sendToBackend({ type: 'audioEvent', playbackId: msg.playbackId, event: 'ended' });
      });
      audio.addEventListener('error', () => {
        this.audioPlaybacks.delete(msg.playbackId);
        this.sendToBackend({
          type: 'audioEvent', playbackId: msg.playbackId, event: 'error',
          error: audio.error?.message ?? 'audio element error',
        });
      });
      this.audioPlaybacks.set(msg.playbackId, audio);
      audio.play().catch(err => {
        this.audioPlaybacks.delete(msg.playbackId);
        this.sendToBackend({
          type: 'audioEvent', playbackId: msg.playbackId, event: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.sendToBackend({
        type: 'audioEvent', playbackId: msg.playbackId, event: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleAudioControl(msg: AudioControlMsg): void {
    if (msg.action === 'stopAll') {
      for (const [id, audio] of this.audioPlaybacks) {
        audio.pause();
        audio.src = '';
        this.audioPlaybacks.delete(id);
      }
      for (const [id, stop] of this.audioGraphs) {
        stop(true);
        this.audioGraphs.delete(id);
      }
      return;
    }
    // A synthesized graph shares the playbackId namespace with element playback.
    const graphStop = msg.playbackId ? this.audioGraphs.get(msg.playbackId) : undefined;
    if (graphStop) {
      // Envelope release on stop; hard-cut on pause (no resume for graphs).
      graphStop(msg.action === 'pause');
      if (msg.action !== 'pause') this.audioGraphs.delete(msg.playbackId!);
      return;
    }
    const audio = msg.playbackId ? this.audioPlaybacks.get(msg.playbackId) : undefined;
    if (!audio) return;
    switch (msg.action) {
      case 'pause':
        audio.pause();
        break;
      case 'resume':
        audio.play().catch(() => { /* reported via error listener */ });
        break;
      case 'stop':
        audio.pause();
        audio.src = '';
        this.audioPlaybacks.delete(msg.playbackId!);
        break;
    }
  }

  /**
   * Build and play a synthesized Web Audio graph (oscillators + white noise,
   * optional biquad filter, attack/hold/release gain envelope). Abjects run in
   * a sandboxed backend with no AudioContext, so they describe the graph
   * declaratively and it is materialized here. Non-looping graphs report
   * 'ended' once every voice has finished; looping graphs sustain until stopped.
   */
  private handleAudioGraph(msg: AudioGraphMsg): void {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API unavailable');
      if (!this.sharedAudioCtx || this.sharedAudioCtx.state === 'closed') {
        this.sharedAudioCtx = new Ctor();
      }
      const ctx = this.sharedAudioCtx;
      // Autoplay policy: contexts start suspended until a user gesture. Best-effort resume.
      if (ctx.state === 'suspended') void ctx.resume();

      const master = ctx.createGain();
      master.gain.value = Math.max(0, Math.min(1, msg.volume ?? 1));
      master.connect(ctx.destination);

      const loop = msg.loop ?? false;
      const t0 = ctx.currentTime;
      const sources: AudioScheduledSourceNode[] = [];
      const gains: GainNode[] = [];
      let latestEnd = t0;

      for (const v of msg.voices.slice(0, 32)) {
        const start = t0 + Math.max(0, v.start ?? 0);
        const attack = Math.max(0, v.attack ?? 0.01);
        const duration = Math.max(0.01, v.duration ?? 0.3);
        const release = Math.max(0, v.release ?? 0.1);
        const hold = Math.max(0, v.hold ?? duration);
        const peak = Math.max(0, Math.min(1, v.gain ?? 0.2));

        let node: AudioScheduledSourceNode;
        if ((v.source ?? 'osc') === 'noise') {
          const seconds = loop ? 2 : Math.max(0.2, attack + hold + release);
          const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
          const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
          const noise = ctx.createBufferSource();
          noise.buffer = buffer;
          noise.loop = loop;
          node = noise;
        } else {
          const osc = ctx.createOscillator();
          osc.type = v.wave ?? 'sine';
          const freq = Math.max(1, v.freq ?? 220);
          osc.frequency.setValueAtTime(freq, start);
          if (v.freqRamp && v.freqRamp.to > 0) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.freqRamp.to), start + Math.max(0.001, v.freqRamp.time));
          }
          node = osc;
        }

        let tail: AudioNode = node;
        if (v.filter) {
          const filter = ctx.createBiquadFilter();
          filter.type = v.filter.type;
          filter.frequency.setValueAtTime(Math.max(1, v.filter.freq), start);
          if (v.filter.q !== undefined) filter.Q.setValueAtTime(Math.max(0.0001, v.filter.q), start);
          tail.connect(filter);
          tail = filter;
        }

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + attack);
        if (!loop) {
          const releaseStart = start + attack + hold;
          gain.gain.setValueAtTime(peak, releaseStart);
          gain.gain.linearRampToValueAtTime(0, releaseStart + release);
        }
        tail.connect(gain);
        gain.connect(master);

        node.start(start);
        const voiceEnd = start + attack + hold + release;
        if (!loop) {
          node.stop(voiceEnd);
          if (voiceEnd > latestEnd) latestEnd = voiceEnd;
        }
        sources.push(node);
        gains.push(gain);
      }

      let ended = false;
      const teardown = () => {
        if (ended) return;
        ended = true;
        this.audioGraphs.delete(msg.playbackId);
        try { master.disconnect(); } catch { /* already gone */ }
        this.sendToBackend({ type: 'audioEvent', playbackId: msg.playbackId, event: 'ended' });
      };

      // stop(immediate): pause = hard cut; otherwise a short release ramp.
      this.audioGraphs.set(msg.playbackId, (immediate?: boolean) => {
        const now = ctx.currentTime;
        const rel = immediate ? 0 : 0.08;
        for (const g of gains) {
          try {
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(g.gain.value, now);
            g.gain.linearRampToValueAtTime(0, now + rel);
          } catch { /* node finished */ }
        }
        for (const s of sources) { try { s.stop(now + rel + 0.01); } catch { /* already stopped */ } }
      });

      if (!loop) {
        const ms = Math.max(0, (latestEnd - t0) * 1000) + 60;
        window.setTimeout(teardown, ms);
      }
    } catch (err) {
      this.sendToBackend({
        type: 'audioEvent', playbackId: msg.playbackId, event: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Video widget elements (relayed from VideoWidget) ─────────────────
  //
  // The element lives here (hidden in the DOM for autoplay reliability); the
  // compositor reads its frames into the widget's videoFrame region every
  // animation frame, so pixels never cross the relay.

  private handleVideoSetup(msg: VideoSetupMsg): void {
    // Reconfigure: dispose any prior element under the same id first.
    this.disposeVideoWidgetEl(msg.videoId);

    const video = document.createElement('video');
    video.muted = msg.muted ?? false;
    video.loop = msg.loop ?? false;
    video.playsInline = true;
    video.crossOrigin = 'anonymous'; // non-CORS sources fail to error, never taint
    video.style.position = 'fixed';
    video.style.left = '-10000px';
    video.style.width = '1px';
    video.style.height = '1px';

    const sendEvent = (
      event: 'playing' | 'paused' | 'ended' | 'error' | 'meta' | 'time',
      extra: { error?: string } = {},
    ) => {
      this.sendToBackend({
        type: 'videoEvent',
        videoId: msg.videoId,
        event,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
        currentTime: video.currentTime,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        ...extra,
      });
    };

    video.addEventListener('loadedmetadata', () => sendEvent('meta'));
    video.addEventListener('playing', () => sendEvent('playing'));
    video.addEventListener('pause', () => sendEvent('paused'));
    video.addEventListener('ended', () => sendEvent('ended'));
    video.addEventListener('error', () => sendEvent('error', {
      error: video.error?.message ?? 'video element error',
    }));
    video.addEventListener('timeupdate', () => {
      const now = performance.now();
      const last = this.videoTimeStamps.get(msg.videoId) ?? 0;
      if (now - last >= 1000) {
        this.videoTimeStamps.set(msg.videoId, now);
        sendEvent('time');
      }
    });

    if (msg.streamId) {
      const stream = this.mediaStreams.get(msg.streamId);
      if (!stream) {
        this.sendToBackend({
          type: 'videoEvent', videoId: msg.videoId, event: 'error',
          error: `unknown streamId ${msg.streamId} (capture it first via MediaStream)`,
        });
        return;
      }
      video.srcObject = stream;
    } else if (msg.source) {
      video.src = msg.source;
    }

    document.body.appendChild(video);
    this.videoWidgetEls.set(msg.videoId, video);
    this.compositor.registerVideoElement(msg.videoId, video);

    if (msg.autoplay !== false) {
      video.play().catch(err => {
        sendEvent('error', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  private handleVideoControl(msg: VideoControlMsg): void {
    const video = this.videoWidgetEls.get(msg.videoId);
    if (!video) return;
    switch (msg.action) {
      case 'play':
        video.play().catch(() => { /* reported via error listener */ });
        break;
      case 'pause':
        video.pause();
        break;
      case 'seek':
        if (typeof msg.value === 'number' && Number.isFinite(msg.value)) {
          video.currentTime = Math.max(0, msg.value);
        }
        break;
      case 'setMuted':
        video.muted = msg.value === 1;
        break;
      case 'dispose':
        this.disposeVideoWidgetEl(msg.videoId);
        break;
    }
  }

  private disposeVideoWidgetEl(videoId: string): void {
    const video = this.videoWidgetEls.get(videoId);
    if (!video) return;
    this.compositor.unregisterVideoElement(videoId);
    this.videoWidgetEls.delete(videoId);
    this.videoTimeStamps.delete(videoId);
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
    video.remove();
  }

  // ── Media capture (relayed from the MediaStream capability) ──────────

  private handleMediaCaptureRequest(msg: MediaCaptureRequestMsg): void {
    (async () => {
      try {
        const stream = msg.display
          ? await navigator.mediaDevices.getDisplayMedia({ video: true })
          : await navigator.mediaDevices.getUserMedia({ audio: msg.audio, video: msg.video });
        this.mediaStreams.set(stream.id, stream);

        // Keep a hidden, playing video element for every video-bearing stream
        // so captureFrame always has a decoded frame to draw.
        if (stream.getVideoTracks().length > 0) {
          const video = document.createElement('video');
          video.muted = true;
          video.autoplay = true;
          video.playsInline = true;
          video.style.position = 'fixed';
          video.style.left = '-10000px';
          video.style.width = '1px';
          video.style.height = '1px';
          video.srcObject = stream;
          document.body.appendChild(video);
          video.play().catch(() => { /* frame grabs will report failure */ });
          this.mediaVideoEls.set(stream.id, video);
        }

        this.sendToBackend({
          type: 'mediaCaptureReply',
          requestId: msg.requestId,
          streamId: stream.id,
          tracks: stream.getTracks().map(t => ({ id: t.id, kind: t.kind, label: t.label })),
        });
      } catch (err) {
        this.sendToBackend({
          type: 'mediaCaptureReply',
          requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  private handleMediaCaptureFrameRequest(msg: MediaCaptureFrameRequestMsg): void {
    const video = this.mediaVideoEls.get(msg.streamId);
    if (!video || video.videoWidth === 0) {
      this.sendToBackend({
        type: 'mediaCaptureFrameReply', requestId: msg.requestId,
        error: video ? 'no decoded frame yet' : 'unknown streamId or stream has no video track',
      });
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const dataUri = canvas.toDataURL('image/png');
      this.sendToBackend({
        type: 'mediaCaptureFrameReply',
        requestId: msg.requestId,
        base64: dataUri.slice(dataUri.indexOf(',') + 1),
        width: canvas.width,
        height: canvas.height,
      });
    } catch (err) {
      this.sendToBackend({
        type: 'mediaCaptureFrameReply', requestId: msg.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleMediaRecordStart(msg: MediaRecordStartMsg): void {
    const stream = this.mediaStreams.get(msg.streamId);
    if (!stream) {
      this.sendToBackend({
        type: 'mediaRecordingComplete', recordingId: msg.recordingId,
        error: 'unknown streamId',
      });
      return;
    }
    try {
      const hasVideo = stream.getVideoTracks().length > 0;
      const mimeType = hasVideo ? 'video/webm' : 'audio/webm';
      const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined);
      const entry = { recorder, chunks: [] as Blob[], startedAt: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
      recorder.ondataavailable = (e) => { if (e.data.size > 0) entry.chunks.push(e.data); };
      recorder.onstop = () => {
        if (entry.timer) clearTimeout(entry.timer);
        this.mediaRecorders.delete(msg.recordingId);
        const blob = new Blob(entry.chunks, { type: recorder.mimeType || mimeType });
        const durationMs = Date.now() - entry.startedAt;
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUri = String(reader.result ?? '');
          this.sendToBackend({
            type: 'mediaRecordingComplete',
            recordingId: msg.recordingId,
            base64: dataUri.slice(dataUri.indexOf(',') + 1),
            mimeType: blob.type,
            durationMs,
          });
        };
        reader.onerror = () => {
          this.sendToBackend({
            type: 'mediaRecordingComplete', recordingId: msg.recordingId,
            error: 'failed to encode recording',
          });
        };
        reader.readAsDataURL(blob);
      };
      recorder.onerror = () => {
        if (entry.timer) clearTimeout(entry.timer);
        this.mediaRecorders.delete(msg.recordingId);
        this.sendToBackend({
          type: 'mediaRecordingComplete', recordingId: msg.recordingId,
          error: 'MediaRecorder error',
        });
      };
      this.mediaRecorders.set(msg.recordingId, entry);
      recorder.start();
      if (msg.maxDurationMs && msg.maxDurationMs > 0) {
        entry.timer = setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, msg.maxDurationMs);
      }
    } catch (err) {
      this.sendToBackend({
        type: 'mediaRecordingComplete', recordingId: msg.recordingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleMediaRecordStop(msg: MediaRecordStopMsg): void {
    const entry = this.mediaRecorders.get(msg.recordingId);
    if (entry && entry.recorder.state !== 'inactive') {
      entry.recorder.stop();
    }
  }

  private handleMediaStreamControl(msg: MediaStreamControlMsg): void {
    if (msg.action === 'stopStream' && msg.streamId) {
      const stream = this.mediaStreams.get(msg.streamId);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        this.mediaStreams.delete(msg.streamId);
      }
      const video = this.mediaVideoEls.get(msg.streamId);
      if (video) {
        video.srcObject = null;
        video.remove();
        this.mediaVideoEls.delete(msg.streamId);
      }
      return;
    }
    if (msg.action === 'muteTrack' && msg.trackId) {
      for (const stream of this.mediaStreams.values()) {
        for (const track of stream.getTracks()) {
          if (track.id === msg.trackId) {
            track.enabled = !(msg.muted ?? true);
            return;
          }
        }
      }
    }
  }

  // ── Speech (relayed from the Speech capability) ───────────────────────

  private handleSpeechSpeak(msg: SpeechSpeakMsg): void {
    if (!('speechSynthesis' in window)) {
      this.sendToBackend({
        type: 'speechSpeakReply', requestId: msg.requestId,
        error: 'speechSynthesis unavailable in this browser',
      });
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(msg.text);
      if (msg.voice) {
        const match = window.speechSynthesis.getVoices().find(v => v.name === msg.voice);
        if (match) utterance.voice = match;
      }
      let replied = false;
      const replyOnce = (payload: { spoken?: boolean; error?: string }) => {
        if (replied) return;
        replied = true;
        this.sendToBackend({ type: 'speechSpeakReply', requestId: msg.requestId, ...payload });
      };
      // Reply on start so long passages never block the relay round-trip.
      utterance.onstart = () => replyOnce({ spoken: true });
      utterance.onerror = (e) => replyOnce({ error: `speech error: ${e.error ?? 'unknown'}` });
      // Some engines skip onstart for empty/whitespace text; onend covers it.
      utterance.onend = () => replyOnce({ spoken: true });
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      this.sendToBackend({
        type: 'speechSpeakReply', requestId: msg.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleSpeechRecognize(msg: SpeechRecognizeRequestMsg): void {
    const maxMs = msg.maxDurationMs ?? 10000;
    type RecognitionCtor = new () => {
      lang: string; interimResults: boolean; maxAlternatives: number;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: ((e: { error?: string }) => void) | null;
      onend: (() => void) | null;
      start(): void; stop(): void;
    };
    const w = window as unknown as {
      SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor;
    };
    const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;

    if (Recognition) {
      try {
        const rec = new Recognition();
        rec.lang = navigator.language || 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        let transcript = '';
        let replied = false;
        const replyOnce = (payload: { text?: string; error?: string }) => {
          if (replied) return;
          replied = true;
          this.sendToBackend({ type: 'speechRecognizeReply', requestId: msg.requestId, ...payload });
        };
        const timer = setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, maxMs);
        rec.onresult = (e) => {
          for (let i = 0; i < e.results.length; i++) {
            transcript += e.results[i][0]?.transcript ?? '';
          }
        };
        rec.onerror = (e) => {
          clearTimeout(timer);
          // 'no-speech' ends with an empty transcript rather than an error.
          if (e.error === 'no-speech') replyOnce({ text: '' });
          else replyOnce({ error: `speech recognition error: ${e.error ?? 'unknown'}` });
        };
        rec.onend = () => {
          clearTimeout(timer);
          replyOnce({ text: transcript.trim() });
        };
        rec.start();
        return;
      } catch { /* fall through to mic recording */ }
    }

    // No Web Speech API: record the mic for the window and let the server
    // route the audio to a transcription provider.
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream,
          MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : undefined);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          for (const track of stream.getTracks()) track.stop();
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUri = String(reader.result ?? '');
            this.sendToBackend({
              type: 'speechRecognizeReply',
              requestId: msg.requestId,
              audioBase64: dataUri.slice(dataUri.indexOf(',') + 1),
              mimeType: blob.type,
            });
          };
          reader.onerror = () => {
            this.sendToBackend({
              type: 'speechRecognizeReply', requestId: msg.requestId,
              error: 'failed to encode recorded audio',
            });
          };
          reader.readAsDataURL(blob);
        };
        recorder.start();
        setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, maxMs);
      } catch (err) {
        this.sendToBackend({
          type: 'speechRecognizeReply', requestId: msg.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  private handleSpeechVoices(msg: SpeechVoicesRequestMsg): void {
    const voices = 'speechSynthesis' in window
      ? window.speechSynthesis.getVoices().map(v => v.name)
      : [];
    this.sendToBackend({ type: 'speechVoicesReply', requestId: msg.requestId, voices });
  }

  /**
   * Phone only: when the backend focuses a window that just appeared (own
   * launch via palette or dock, or one created for the user by an agent or
   * abject; both take focus server-side via the focusOnCreate window
   * option), the camera flies into it (focus mode). Focus moving between
   * windows that already existed (a tap, a reconnect replay) leaves the
   * camera where the user put it. Deferred while the user is actively
   * interacting (touch gesture in flight, local drag, or IME composition) so
   * background window creation never fights their hands. The soft keyboard
   * is NOT summoned here; that stays server-driven via showMobileKeyboard.
   * Desktop is untouched: desktop layout follows backend focus only for the
   * focus treatment.
   */
  private mobileAutoSwitchToFocusedSurface(surfaceId: string): void {
    if (!this.mobileMode) return;
    const created = this.recentlyCreated.get(surfaceId);
    if (created === undefined || performance.now() - created > FrontendClient.AUTO_FOCUS_WINDOW_MS) return;
    const surface = this.compositor.getSurface(surfaceId);
    if (!surface || surface.transparent || surface.inputPassthrough || this.compositor.isRailSurface(surfaceId)) return;
    // In Exposé a new window joins the grid instead (the camera stays put).
    if (this.compositor.isExposeOpen()) return;
    if (this.activeTouch || this.pinch || this.localDragState || this.grabbedSurface || this.proxyComposing) {
      // The user is mid-gesture, dragging, or composing IME text (e.g.
      // typing in the command palette or tapping a result row). Defer it
      // instead of dropping it: the latest deferred target is applied as
      // soon as the guard clears.
      this.pendingMobileAutoSwitch = surfaceId;
      return;
    }
    this.recentlyCreated.delete(surfaceId);
    this.compositor.mobileFlyToSurface(surfaceId);
  }

  /** Apply a deferred mobile auto-switch once no interaction guard is active. */
  private applyPendingMobileAutoSwitch(): void {
    if (!this.mobileMode || !this.pendingMobileAutoSwitch) return;
    if (this.activeTouch || this.pinch || this.localDragState || this.grabbedSurface || this.proxyComposing) return;
    const target = this.pendingMobileAutoSwitch;
    this.pendingMobileAutoSwitch = undefined;
    if (!this.compositor.getSurface(target) || this.compositor.isExposeOpen()) return;
    this.recentlyCreated.delete(target);
    this.compositor.mobileFlyToSurface(target);
  }

  /** How long after it appears a window still counts as new for the fly-in. */
  private static readonly AUTO_FOCUS_WINDOW_MS = 10_000;

  /** The backend's state replay after 'ready' is over: later surfaces are new windows. */
  private endReplay(): void {
    this.replayingState = false;
    if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = undefined; }
  }

  private handleCreateSurface(msg: CreateSurfaceMsg): void {
    if (!this.replayingState) {
      const now = performance.now();
      for (const [id, at] of this.recentlyCreated) {
        if (now - at > FrontendClient.AUTO_FOCUS_WINDOW_MS) this.recentlyCreated.delete(id);
      }
      this.recentlyCreated.set(msg.surfaceId, now);
    }
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
      {
        chromeless: msg.chromeless === true,
        screenAnchor: isScreenAnchor(msg.screenAnchor) ? msg.screenAnchor : undefined,
      },
    );

    // P1: if the focused surface was recently destroyed by churn, adopt this
    // reminted surface (same owning object, new id) as the forwarding target
    // so proxy keystrokes keep flowing without requiring a fresh tap.
    if (
      !this.focusedSurface &&
      this.focusedDestroyedObjectId !== undefined &&
      this.focusedDestroyedObjectId === (msg.objectId as string) &&
      Date.now() - this.focusedDestroyedAt < FrontendClient.FOCUS_ADOPTION_WINDOW_MS
    ) {
      this.focusedSurface = msg.surfaceId;
      this.focusedDestroyedObjectId = undefined;
      this.compositor.setFocusedSurface(msg.surfaceId);
      this.sendDiagnostic('focus-adopted', `adopted reminted surface ${msg.surfaceId} as forwarding target after churn`);
    }

    this.sendToBackend({
      type: 'surfaceCreated',
      surfaceId: msg.surfaceId,
    });
  }

  private handleDraw(msg: DrawMsg): void {
    for (const cmd of msg.commands) {
      const resolved = this.resolveImageRef(cmd as DrawCommand);
      if (resolved) this.compositor.draw(resolved);
    }
  }

  private static readonly ABX_IMAGE_PREFIX = 'abx:sha256:';

  /**
   * Translate an `abx:sha256:` image ref to the cached object URL. When the
   * blob isn't cached (evicted, or lost to a race) the command is parked and
   * re-executed when the re-requested bytes arrive; the rest of the surface
   * repaint proceeds without it.
   */
  private resolveImageRef(cmd: DrawCommand): DrawCommand | undefined {
    if (cmd.type !== 'imageUrl') return cmd;
    const url = (cmd.params as { url?: string }).url;
    if (!url || !url.startsWith(FrontendClient.ABX_IMAGE_PREFIX)) return cmd;
    const hash = url.slice(FrontendClient.ABX_IMAGE_PREFIX.length);
    const objectUrl = this.imageBlobUrls.get(hash);
    if (objectUrl) {
      // LRU touch
      this.imageBlobUrls.delete(hash);
      this.imageBlobUrls.set(hash, objectUrl);
      return { ...cmd, params: { ...(cmd.params as object), url: objectUrl } } as DrawCommand;
    }
    const pending = this.pendingBlobDraws.get(hash);
    if (pending) {
      pending.push(cmd);
    } else {
      this.pendingBlobDraws.set(hash, [cmd]);
      this.sendToBackend({ type: 'needBlob', hash });
    }
    return undefined;
  }

  /**
   * The object URL of a content blob (a model's bytes) from the image blob
   * cache, or undefined after asking the backend to send it (once).
   */
  private resolveContentBlob(hash: string): string | undefined {
    const url = this.imageBlobUrls.get(hash);
    if (url) {
      this.imageBlobUrls.delete(hash);
      this.imageBlobUrls.set(hash, url);
      return url;
    }
    if (!this.requestedContentBlobs.has(hash)) {
      this.requestedContentBlobs.add(hash);
      this.sendToBackend({ type: 'needBlob', hash });
    }
    return undefined;
  }

  /** Content blobs already requested with needBlob (cleared as each arrives). */
  private requestedContentBlobs = new Set<string>();

  private handleImageBlob(msg: ImageBlobMsg): void {
    const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes as ArrayBufferLike);
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: msg.mime }));
    this.imageBlobUrls.set(msg.hash, objectUrl);
    this.requestedContentBlobs.delete(msg.hash);
    this.compositor.blobArrived(msg.hash);
    while (this.imageBlobUrls.size > FrontendClient.IMAGE_BLOB_CACHE_MAX) {
      const [oldest, oldestUrl] = this.imageBlobUrls.entries().next().value as [string, string];
      URL.revokeObjectURL(oldestUrl);
      this.imageBlobUrls.delete(oldest);
    }
    const parked = this.pendingBlobDraws.get(msg.hash);
    if (parked) {
      this.pendingBlobDraws.delete(msg.hash);
      for (const cmd of parked) {
        const resolved = this.resolveImageRef(cmd);
        if (resolved) this.compositor.draw(resolved);
      }
    }
  }

  private handleStartWindowDrag(msg: StartWindowDragMsg): void {
    if (msg.dragType === 'move') {
      // Enter client-side local drag mode for zero-latency window moves
      const surface = this.compositor.getSurface(msg.surfaceId);
      if (!surface) return;
      // A finger outruns the startWindowDrag round trip: on the phone the
      // drag is anchored at the press, so the window stays under the finger.
      const press = this.mobileMode && this.pressAt?.surfaceId === msg.surfaceId ? this.pressAt : undefined;
      this.localDragState = {
        surfaceId: msg.surfaceId,
        dragType: 'move',
        startX: press ? press.x : this.lastCanvasX,
        startY: press ? press.y : this.lastCanvasY,
        startSurfaceX: press ? press.rectX : surface.rect.x,
        startSurfaceY: press ? press.rectY : surface.rect.y,
      };
      // The press already ended (a quick click on the title bar): end the
      // drag where it stands instead of letting the window follow a
      // pointer with no button held.
      if (!press && !this.primaryHeld) {
        this.finishLocalDragMove();
        return;
      }
      this.canvas.style.cursor = 'move';
    } else if (msg.dragType === 'resize' && msg.edge) {
      this.canvas.style.cursor = FrontendClient.edgeToCursor(msg.edge);
    }
  }

  /** Follow the pointer/finger during a client-side local move drag. */
  private applyLocalDragMove(x: number, y: number): void {
    if (!this.localDragState || this.localDragState.dragType !== 'move') return;
    this.lastCanvasX = x;
    this.lastCanvasY = y;
    // Screen px to workspace px (the phone camera may be zoomed; 1 on the desktop).
    const zoom = this.compositor.getViewZoom();
    const dx = (x - this.localDragState.startX) / zoom;
    const dy = (y - this.localDragState.startY) / zoom;
    this.compositor.moveSurface(
      this.localDragState.surfaceId,
      this.localDragState.startSurfaceX + dx,
      this.localDragState.startSurfaceY + dy,
    );
  }

  /** Commit a local move drag: send the final position and clean up. */
  private finishLocalDragMove(): void {
    if (!this.localDragState || this.localDragState.dragType !== 'move') return;
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
    this.applyPendingMobileAutoSwitch();
  }

  private handleMouseUp(e: MouseEvent): void {
    if ((e.button ?? 0) === 0) this.primaryHeld = false;
    // A camera orbit ends where it was released (it may coast on).
    if (this.cameraOrbiting) {
      this.cameraOrbiting = false;
      this.compositor.endCameraOrbit(e.timeStamp || undefined);
      this.canvas.style.cursor = 'default';
      return;
    }
    // If in local move drag, send final position to server and clean up
    if (this.localDragState && this.localDragState.dragType === 'move') {
      this.finishLocalDragMove();
      return;
    }

    // Normal mouseup path -- reset cursor when grab ends
    if (this.grabbedSurface) {
      this.canvas.style.cursor = 'default';
    }
    this.handleMouseEvent(e, 'mouseup');
    // A grab release can clear the last guard holding a deferred switch.
    this.applyPendingMobileAutoSwitch();
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

    const reply = () => {
      let width = 0;
      const surface = this.compositor.getSurface(surfaceId);
      const ctx = surface?.ctx ?? this.measureCtx();
      if (ctx && text) {
        ctx.font = font;
        width = ctx.measureText(text).width;
      }
      this.sendToBackend({
        type: 'measureTextReply',
        requestId,
        width,
      });
    };

    // A face that has not loaded yet would measure as the fallback font, and
    // the caller lays text out with that width. Wait for the face first.
    if (typeof document !== 'undefined' && document.fonts && !document.fonts.check(font)) {
      document.fonts.load(font).catch(() => undefined).then(reply);
      return;
    }
    reply();
  }

  private measureCanvasCtx?: CanvasRenderingContext2D | null;

  /** A detached 2D context for measuring when no surface is named. */
  private measureCtx(): CanvasRenderingContext2D | null {
    if (this.measureCanvasCtx === undefined) {
      this.measureCanvasCtx = document.createElement('canvas').getContext('2d');
    }
    return this.measureCanvasCtx;
  }

  private handleDisplayInfoRequest(requestId: string): void {
    this.sendToBackend({
      type: 'displayInfoReply',
      requestId,
      width: this.compositor.width,
      height: this.compositor.height,
    });
  }

  /** GPU capabilities and running scene stats, for WidgetManager getSceneParams. */
  private handleSceneInfoRequest(requestId: string): void {
    let info: { capabilities: Record<string, unknown>; stats: Record<string, unknown> };
    try {
      info = this.compositor.sceneInfo();
    } catch (err) {
      info = { capabilities: { error: err instanceof Error ? err.message : String(err) }, stats: {} };
    }
    this.sendToBackend({ type: 'sceneInfoReply', requestId, capabilities: info.capabilities, stats: info.stats });
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
      this.focusCanvasUnlessTyping();
      if (this.exposeMouse(e, 'mousedown')) return;
      if (this.handleCameraMouseDown(e)) return;
      if (this.handleScrollOrPanMouseDown(e)) return;
      this.handleMouseEvent(e, 'mousedown');
    });
    this.canvas.addEventListener('mouseup', (e) => {
      if (this.exposeMouse(e, 'mouseup')) return;
      if (this.handleScrollOrPanMouseUp()) return;
      this.handleMouseUp(e);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.exposeMouse(e, 'mousemove')) return;
      if (this.handleScrollOrPanMouseMove(e)) return;
      this.handleMouseMoveThrottled(e);
    });
    this.canvas.addEventListener('wheel', (e) => {
      if (this.exposeWheel(e)) return;
      this.handleWheelEvent(e);
    });
    // A release anywhere (even outside the canvas) lets go of the button.
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.primaryHeld = false; }, true);
    // A node drag released outside the canvas still ends (its owner hears dragEnd).
    window.addEventListener('mouseup', (e) => {
      if ((!this.nodeDragging && !this.cameraOrbiting) || e.target === this.canvas) return;
      this.handleMouseUp(e);
    });
    this.canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.canvas.addEventListener('contextmenu', (e) => {
      // Don't block browser context menu normally, but if a middle-pan is
      // happening we don't want it to intercept.
      if (this.panningViewport || this.cameraOrbiting) { e.preventDefault(); return; }
      // A camera that orbits with the right button keeps the menu away.
      const r = this.canvas.getBoundingClientRect();
      if (!this.mobileMode && this.compositor.cameraOrbitsAt(e.clientX - r.left, e.clientY - r.top, 2)) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => this.handleKeyEvent(e, 'keydown'));
    document.addEventListener('keyup', (e) => this.handleKeyEvent(e, 'keyup'));

    document.addEventListener('paste', (e) => this.handlePasteEvent(e));
    document.addEventListener('copy', (e) => this.handleCopyEvent(e));
    document.addEventListener('cut', (e) => this.handleCutEvent(e));

    // Touch. Desktop layout: the first finger is a mouse. Phone layout: the
    // phone is a camera on the desktop (see onTouchStart for the gestures).
    const pos = (t: Touch) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.focusCanvasUnlessTyping();
      if (!this.mobileMode) {
        // Extra fingers are phone vocabulary; the first finger's gesture continues untouched.
        if (e.touches.length > 1) return;
        const t = e.changedTouches[0];
        if (!t) return;
        const p = pos(t);
        this.activeTouch = this.newTouch(t.identifier, p.x, p.y, 'mouse', e.timeStamp);
        this.touchMouse(p.x, p.y, 'mousedown');
        return;
      }
      // Two fingers always drive the camera, in every view.
      if (e.touches.length >= 2) {
        if (!this.pinch) this.beginPinch(pos(e.touches[0]), pos(e.touches[1]));
        return;
      }
      const t = e.changedTouches[0];
      if (!t) return;
      const p = pos(t);
      this.onTouchStart(t.identifier, p.x, p.y, e.timeStamp);
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (this.pinch && e.touches.length >= 2) {
        this.movePinch(pos(e.touches[0]), pos(e.touches[1]));
        return;
      }
      const at = this.activeTouch;
      if (!at) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== at.id) continue;
        const p = pos(t);
        this.onTouchMove(p.x, p.y, e.timeStamp);
      }
    }, { passive: false });

    const end = (e: TouchEvent, cancelled: boolean) => {
      e.preventDefault();
      if (this.pinch) {
        if (e.touches.length >= 2) return;
        this.endPinch(cancelled);
        // A finger still down after a pinch does nothing until it lifts.
        const rest = e.touches[0];
        if (rest) {
          const p = pos(rest);
          this.activeTouch = this.newTouch(rest.identifier, p.x, p.y, 'ignore', e.timeStamp);
        }
        return;
      }
      const at = this.activeTouch;
      if (!at) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== at.id) continue;
        const p = pos(t);
        this.onTouchEnd(p.x, p.y, cancelled, e.timeStamp);
      }
    };
    this.canvas.addEventListener('touchend', (e) => end(e, false), { passive: false });
    this.canvas.addEventListener('touchcancel', (e) => end(e, true), { passive: false });
  }

  /**
   * Focus the canvas so document-level key handling wins, but never steal
   * focus from the keyboard proxy: on iOS that would dismiss the virtual
   * keyboard on every tap (including caret taps inside the same text box).
   * The backend explicitly blurs the proxy via showMobileKeyboard(false)
   * when focus moves to a non-text widget.
   */
  private focusCanvasUnlessTyping(): void {
    if (this.mobileKeyboardProxy && document.activeElement === this.mobileKeyboardProxy) return;
    this.canvas.focus();
  }

  /** Touch times come from the events (performance.now() clock), so speeds measure the finger, not handler delays. */
  private newTouch(id: number, x: number, y: number, mode: NonNullable<FrontendClient['activeTouch']>['mode'], time?: number): NonNullable<FrontendClient['activeTouch']> {
    const now = time || performance.now();
    return { id, startX: x, startY: y, startTime: now, lastX: x, lastY: y, lastTime: now, vx: 0, vy: 0, mode, scrollAcc: 0 };
  }

  private clearTouchTimers(at: NonNullable<FrontendClient['activeTouch']>): void {
    if (at.longPressTimer) { clearTimeout(at.longPressTimer); at.longPressTimer = undefined; }
    if (at.holdTimer) { clearTimeout(at.holdTimer); at.holdTimer = undefined; }
  }

  /**
   * The finger acts as the mouse: synthesize the minimal MouseEvent the
   * mouse handlers read and reuse them wholesale, so touch gets 3D node
   * picking, node drags, window drags and projection-correct hit testing
   * (through the phone camera's zoom) identical to a mouse.
   */
  private touchMouse(x: number, y: number, type: 'mousedown' | 'mousemove' | 'mouseup', button = 0): void {
    const r = this.canvas.getBoundingClientRect();
    const synth = {
      clientX: x + r.left,
      clientY: y + r.top,
      button,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      timeStamp: performance.now(),
      preventDefault: () => {},
    } as unknown as MouseEvent;
    // Desktop layout: a finger in the desktop Exposé picks like the mouse.
    if (this.exposeMouse(synth, type)) return;
    if (type === 'mousedown') {
      // Desktop layout: a window's orbiting camera takes the press, as with a mouse.
      if (this.handleCameraMouseDown(synth)) return;
      this.handleMouseEvent(synth, 'mousedown');
    } else if (type === 'mousemove') this.handleMouseMoveThrottled(synth);
    else this.handleMouseUp(synth);
  }

  /**
   * One finger lands on the phone. What it becomes depends on the view and
   * on what is under it:
   * - Exposé: tap picks a window, a flick up closes one, a swipe down leaves.
   * - the bottom handle: tap or swipe up flies out; swipe up and hold opens Exposé.
   * - a draggable 3D object: the finger drags it (the compositor drag engine).
   * - anything else waits for the gesture: a tap clicks, a drag pans the
   *   camera (desktop view) or scrolls the window under it (focus mode), a
   *   drag from a title bar moves the window, and a long press turns into a
   *   real mouse drag (move) or a right-click (release).
   */
  private onTouchStart(id: number, x: number, y: number, time?: number): void {
    // A waiting tap clicks now, before this gesture can move the camera
    // under it, unless this touch may be its second tap.
    if (this.pendingTap && (!this.lastTap || Math.hypot(x - this.lastTap.x, y - this.lastTap.y) >= 30)) this.flushPendingTap();
    const caught = this.compositor.mobileStopMotion() || this.stopScrollGlide();
    const at = this.newTouch(id, x, y, 'undecided', time);
    at.caught = caught;
    this.activeTouch = at;

    if (this.compositor.getMobileView() === MobileViewState.EXPOSE) {
      at.mode = 'expose';
      at.exposeId = this.compositor.exposeAt(x, y);
      return;
    }
    if (this.compositor.isInGestureHandle(y)) {
      at.mode = 'handle';
      return;
    }
    const node = this.compositor.nodeAt(x, y);
    const hit = this.compositor.surfaceLocalAt(x, y);
    at.node = node;
    at.surfaceId = node?.surfaceId ?? hit?.surface.id;
    if (hit && (!node || node.surfaceId === hit.surface.id)) at.local = { x: hit.x, y: hit.y };
    if (node && this.compositor.nodeDraggable(node)) {
      at.mode = 'mouse';
      this.touchMouse(x, y, 'mousedown');
      return;
    }
    if (!node && hit && !hit.surface.transparent && !hit.surface.chromeless && !this.compositor.isRailSurface(hit.surface.id)
        && !this.compositor.isScreenPinned(hit.surface.id) && hit.y >= 0 && hit.y < TITLE_BAR_HEIGHT) at.title = true;
    // A window's orbiting camera takes one-finger drags in its viewport (taps still click).
    if (!node && !at.title && this.compositor.cameraOrbitsAt(x, y, 0)) at.orbit = true;
    if (at.surfaceId || node) {
      at.longPressTimer = setTimeout(() => {
        at.longPressTimer = undefined;
        if (this.activeTouch !== at || at.mode !== 'undecided') return;
        at.mode = 'held';
        try { navigator.vibrate?.(12); } catch { /* not supported */ }
      }, FrontendClient.LONG_PRESS_MS);
    }
  }

  private onTouchMove(x: number, y: number, time?: number): void {
    const at = this.activeTouch;
    if (!at) return;
    const now = time || performance.now();
    const dt = now - at.lastTime;
    const dxStep = x - at.lastX;
    const dyStep = y - at.lastY;
    if (dt > 0) {
      at.vx = at.vx * 0.3 + (dxStep / dt) * 0.7;
      at.vy = at.vy * 0.3 + (dyStep / dt) * 0.7;
    }
    at.lastX = x; at.lastY = y; at.lastTime = now;
    const dx = x - at.startX;
    const dy = y - at.startY;
    const moved = Math.hypot(dx, dy);
    // The finger moved before the long-press time (by the event clock): a
    // busy main thread fired the timer late, so this was never a long press.
    if (at.mode === 'held' && now - at.startTime < FrontendClient.LONG_PRESS_MS) at.mode = 'undecided';

    switch (at.mode) {
      case 'ignore':
        return;
      case 'mouse':
        this.touchMouse(x, y, 'mousemove');
        return;
      case 'pan':
        this.compositor.mobilePanBy(dxStep, dyStep);
        return;
      case 'scroll':
        this.touchScroll(at, dxStep, dyStep);
        return;
      case 'orbit':
        this.compositor.updateCameraOrbit(x, y, now);
        return;
      case 'held':
        // A long press that moves is a real mouse drag from the press point.
        if (moved < 4) return;
        at.mode = 'mouse';
        this.touchMouse(at.startX, at.startY, 'mousedown');
        this.touchMouse(x, y, 'mousemove');
        return;
      case 'handle':
        if (!at.swipedUp && at.startY - y > FrontendClient.EDGE_SWIPE_TRIGGER_PX) {
          at.swipedUp = true;
          at.holdTimer = setTimeout(() => {
            at.holdTimer = undefined;
            if (this.activeTouch !== at || at.mode !== 'handle') return;
            if (this.compositor.enterExpose()) at.mode = 'ignore';
          }, FrontendClient.EXPOSE_HOLD_MS);
        }
        return;
      case 'expose':
        if (moved <= FrontendClient.TAP_SLOP_PX) return;
        if (at.exposeId && dy < 0 && Math.abs(dy) > Math.abs(dx) && this.compositor.isSurfaceClosable(at.exposeId)) {
          at.mode = 'exposeLift';
          this.compositor.exposeSetLift(at.exposeId, dy);
        } else {
          at.mode = 'exposeSwipe';
        }
        return;
      case 'exposeLift':
        if (at.exposeId) this.compositor.exposeSetLift(at.exposeId, dy);
        return;
      case 'exposeSwipe':
        return;
      case 'undecided': {
        if (moved <= FrontendClient.TAP_SLOP_PX) return;
        this.clearTouchTimers(at);
        this.flushPendingTap();
        if (at.orbit && this.compositor.beginCameraOrbit(at.startX, at.startY, 0, at.startTime)) {
          at.mode = 'orbit';
          this.compositor.updateCameraOrbit(x, y, now);
          return;
        }
        if (at.title) {
          // A title-bar drag moves the window: the finger is the mouse (the
          // desktop window-drag flow, zoom-corrected).
          at.mode = 'mouse';
          this.touchMouse(at.startX, at.startY, 'mousedown');
          this.touchMouse(x, y, 'mousemove');
          return;
        }
        if (this.compositor.getMobileView() === MobileViewState.FOCUS && at.surfaceId) {
          // Focus mode: the finger scrolls what is under it. Mostly sideways
          // drags pan the camera only when the window is wider than the screen.
          at.mode = 'scroll';
          const wide = this.surfaceWiderThanScreen(at.surfaceId);
          at.scrollAxis = wide && Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
          this.touchScroll(at, dx, dy);
          return;
        }
        at.mode = 'pan';
        this.compositor.mobilePanBy(dx, dy);
        return;
      }
    }
  }

  private onTouchEnd(x: number, y: number, cancelled: boolean, time?: number): void {
    const at = this.activeTouch;
    this.activeTouch = undefined;
    if (!at) return;
    this.clearTouchTimers(at);
    const now = time || performance.now();
    // Released before the long-press time by the event clock: a tap, not a right-click.
    if (at.mode === 'held' && now - at.startTime < FrontendClient.LONG_PRESS_MS) at.mode = 'undecided';
    const moved = Math.hypot(x - at.startX, y - at.startY);
    const isTap = !cancelled && moved < FrontendClient.TAP_SLOP_PX && now - at.startTime < 500;
    // Still moving at release (not stopped and held): glides carry on.
    const flung = !cancelled && now - at.lastTime < 80;

    switch (at.mode) {
      case 'mouse':
        this.touchMouse(x, y, 'mouseup');
        if (isTap) this.afterTap(x, y);
        break;
      case 'pan':
        if (flung) this.compositor.mobileGlideFrom(at.vx * 1000, at.vy * 1000);
        break;
      case 'orbit':
        // Released while moving, the view coasts on (the compositor's orbit inertia).
        this.compositor.endCameraOrbit(now);
        break;
      case 'scroll':
        if (flung && at.scrollAxis === 'y') this.startScrollGlide(at);
        else if (flung) this.compositor.mobileGlideFrom(at.vx * 1000, 0);
        break;
      case 'held':
        // A long press released in place is a right-click.
        if (!cancelled) {
          this.touchMouse(at.startX, at.startY, 'mousedown', 2);
          this.touchMouse(at.startX, at.startY, 'mouseup', 2);
        }
        break;
      case 'handle':
        // Tap, or swipe up without holding: back out to the desktop view.
        if (!cancelled && (isTap || at.swipedUp)) this.compositor.mobileFlyOut();
        break;
      case 'expose':
        if (!isTap) break;
        if (at.exposeId) {
          // The user explicitly chose this window: backend focus follows,
          // so a later replay (reconnect) lands on their selection.
          this.sendRaw({ type: 'frontendFocus', surfaceId: at.exposeId });
          this.compositor.exitExpose(at.exposeId);
        } else {
          this.compositor.exitExpose();
        }
        break;
      case 'exposeLift': {
        if (!at.exposeId) break;
        const up = at.startY - y;
        const flick = at.vy < -FrontendClient.FLICK_VELOCITY || up > FrontendClient.CLOSE_DISTANCE;
        if (!cancelled && flick && this.compositor.exposeRelease(at.exposeId, true)) {
          this.closeWindowForSurface(at.exposeId);
        } else {
          this.compositor.exposeRelease(at.exposeId, false);
        }
        break;
      }
      case 'exposeSwipe':
        // Swipe down leaves Exposé.
        if (!cancelled && y - at.startY > 60 && Math.abs(y - at.startY) > Math.abs(x - at.startX)) this.compositor.exitExpose();
        break;
      case 'undecided':
        if (isTap && !at.caught) this.onTap(at, x, y);
        break;
      case 'ignore':
        break;
    }
    this.applyPendingMobileAutoSwitch();
  }

  /**
   * A tap on the phone. Desktop view: a tap on a window waits a moment, so a
   * second tap can fly into the window instead of clicking it (the dock and
   * other system rails click at once). Focus mode: taps click at once, and
   * a double tap on empty space flies back out (on another window, flies to it).
   */
  private onTap(at: NonNullable<FrontendClient['activeTouch']>, x: number, y: number): void {
    const now = performance.now();
    const second = !!this.lastTap && now - this.lastTap.time < FrontendClient.DOUBLE_TAP_MS
      && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 30;
    // Rails and windows pinned to the screen click at once (there is no
    // flying into them, so a tap need not wait for a second one).
    const rail = !!at.surfaceId && (this.compositor.isRailSurface(at.surfaceId) || this.compositor.isScreenPinned(at.surfaceId));
    if (this.compositor.getMobileView() !== MobileViewState.FOCUS) {
      if (rail) {
        this.lastTap = undefined;
        this.tapClick(x, y);
        return;
      }
      if (second && this.pendingTap) {
        clearTimeout(this.pendingTap.timer);
        this.pendingTap = undefined;
        this.lastTap = undefined;
        this.doubleTapAt(at);
        return;
      }
      this.flushPendingTap();
      this.lastTap = { x, y, time: now };
      const fire = () => { this.pendingTap = undefined; this.tapClick(x, y); };
      this.pendingTap = { fire, timer: setTimeout(fire, FrontendClient.DOUBLE_TAP_MS) };
      return;
    }
    this.flushPendingTap();
    this.tapClick(x, y);
    if (!second) {
      this.lastTap = { x, y, time: now };
      return;
    }
    this.lastTap = undefined;
    if (!at.surfaceId && !at.node) this.compositor.mobileFlyOut();
    else if (at.node?.scope === 'world') this.compositor.mobileFlyToNode(at.node);
    else if (at.surfaceId && !rail && at.surfaceId !== this.compositor.mobileFocusSurface) this.compositor.mobileFlyToSurface(at.surfaceId);
  }

  /** A waiting tap that a new gesture makes final: click it now. */
  private flushPendingTap(): void {
    const p = this.pendingTap;
    if (!p) return;
    clearTimeout(p.timer);
    p.fire();
  }

  /** Desktop view double tap: fly into the window or 3D object, or back out from empty space. */
  private doubleTapAt(at: NonNullable<FrontendClient['activeTouch']>): void {
    if (at.node && (at.node.scope === 'world' || !at.surfaceId)) {
      if (this.compositor.mobileFlyToNode(at.node)) return;
    }
    if (at.surfaceId && this.compositor.mobileFlyToSurface(at.surfaceId)) return;
    this.compositor.mobileFlyOut();
  }

  /** A click from a tap: mouse down and up at the (title-button snapped) point. */
  private tapClick(x: number, y: number): void {
    const p = this.snapTitleButton(x, y);
    this.touchMouse(p.x, p.y, 'mousedown');
    this.touchMouse(p.x, p.y, 'mouseup');
    this.afterTap(p.x, p.y);
  }

  /** Bookkeeping every phone tap needs: the keyboard target and the keyboard itself. */
  private afterTap(x: number, y: number): void {
    this.lastTapPoint = { x, y };
    // P5: a tap on content must (re-)establish the forwarding target. After
    // surface churn focusedSurface can be undefined even though the tap
    // landed on a live surface; set it so the keyboard proxy has a target
    // when input arrives.
    const tapped = this.compositor.surfaceAt(x, y);
    if (tapped && this.focusedSurface !== tapped.id) {
      this.focusedSurface = tapped.id;
      this.compositor.setFocusedSurface(tapped.id);
      this.sendDiagnostic('tap-refocus', `tap set forwarding target to surface ${tapped.id}`);
    }
    this.summonKeyboardIfWanted();
  }

  /**
   * Title-bar buttons are small under a finger: a tap within a few screen px
   * of close / maximize / minimize / help lands on the button's centre.
   * (Geometry mirrors WindowAbject's title bar at the theme defaults.)
   */
  private snapTitleButton(x: number, y: number): { x: number; y: number } {
    const hit = this.compositor.surfaceLocalAt(x, y);
    if (!hit || hit.surface.transparent || hit.surface.chromeless || !hit.surface.closable || this.compositor.isRailSurface(hit.surface.id)) return { x, y };
    if (hit.y < 0 || hit.y >= TITLE_BAR_HEIGHT) return { x, y };
    const size = FrontendClient.TITLE_BUTTON_SIZE;
    const margin = FrontendClient.TITLE_BUTTON_MARGIN;
    // The finger's slack in window px, capped so a zoomed-out tap cannot reach far.
    const reach = size / 2 + Math.min(20, FrontendClient.TITLE_TAP_SNAP_PX / Math.max(0.05, this.compositor.getViewZoom()));
    let cx = hit.surface.rect.width - margin - size / 2;
    let best: { cx: number; d: number } | undefined;
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(hit.x - cx);
      if (d <= reach && (!best || d < best.d)) best = { cx, d };
      cx -= size + margin;
    }
    if (!best) return { x, y };
    const p = this.compositor.surfaceLocalToViewport(hit.surface.id, best.cx, TITLE_BAR_HEIGHT / 2);
    return p ?? { x, y };
  }

  /** Whether a window shows wider than the screen through the phone camera. */
  private surfaceWiderThanScreen(surfaceId: string): boolean {
    const s = this.compositor.getSurface(surfaceId);
    return !!s && s.rect.width * this.compositor.getViewZoom() > this.compositor.width + 1;
  }

  /**
   * Focus-mode scroll: finger travel becomes wheel input on the surface (and
   * an interactive node) under the press. Scrolling widgets move a fixed step
   * per wheel event, so travel is sent in whole steps as it accumulates,
   * which keeps the content under the finger.
   */
  private touchScroll(at: NonNullable<FrontendClient['activeTouch']>, dx: number, dy: number): void {
    if (at.scrollAxis === 'x') {
      this.compositor.mobilePanBy(dx, 0);
      return;
    }
    at.scrollAcc += -dy / this.compositor.getViewZoom();
    at.scrollAcc = this.emitScrollSteps(at.surfaceId, at.node, at.local ?? { x: 0, y: 0 }, at.scrollAcc, at.startX, at.startY);
  }

  /** Send whole wheel steps out of an accumulated scroll; returns the remainder. */
  private emitScrollSteps(surfaceId: string | undefined, node: NodeHit | undefined, local: { x: number; y: number }, acc: number, sx: number, sy: number): number {
    const step = FrontendClient.WHEEL_STEP;
    let n = 0;
    while (Math.abs(acc) >= step && n < 8) {
      const d = acc > 0 ? step : -step;
      acc -= d;
      n++;
      this.sendTouchWheel(surfaceId, node, local, d, sx, sy);
    }
    return acc;
  }

  /** One wheel step, like a mouse wheel over the press point (a window node hears it too). */
  private sendTouchWheel(surfaceId: string | undefined, node: NodeHit | undefined, local: { x: number; y: number }, deltaY: number, sx: number, sy: number): void {
    const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
    if (node) {
      const nl = this.nodeLocal(node, sx, sy);
      this.sendToBackend({
        type: 'input', inputType: 'wheel',
        surfaceId: node.surfaceId, nodeId: node.nodeId, nodeScope: node.scope, nodeOwnerId: node.ownerId,
        x: nl.x, y: nl.y, deltaX: 0, deltaY, modifiers,
      });
      if (node.scope === 'world') return;
    }
    if (!surfaceId) return;
    this.sendToBackend({ type: 'input', inputType: 'wheel', surfaceId, x: local.x, y: local.y, deltaX: 0, deltaY, modifiers });
  }

  /** A scroll released with speed keeps scrolling, slowing to a stop (off the render loop). */
  private startScrollGlide(at: NonNullable<FrontendClient['activeTouch']>): void {
    this.stopScrollGlide();
    const v = (-at.vy * 1000) / this.compositor.getViewZoom();  // content px/s
    if (Math.abs(v) < 120) return;
    const g = { surfaceId: at.surfaceId, node: at.node, local: at.local ?? { x: 0, y: 0 }, v, acc: at.scrollAcc, last: performance.now(), raf: 0 };
    const sx = at.startX, sy = at.startY;
    const tick = () => {
      if (this.scrollGlide !== g) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - g.last) / 1000);
      g.last = now;
      g.v *= Math.exp(-3 * dt);
      g.acc = this.emitScrollSteps(g.surfaceId, g.node, g.local, g.acc + g.v * dt, sx, sy);
      if (Math.abs(g.v) < 40) { this.scrollGlide = undefined; return; }
      g.raf = requestAnimationFrame(tick);
    };
    this.scrollGlide = g;
    g.raf = requestAnimationFrame(tick);
  }

  /** Stop a scroll glide (a finger caught it). True when one was running. */
  private stopScrollGlide(): boolean {
    const g = this.scrollGlide;
    if (!g) return false;
    cancelAnimationFrame(g.raf);
    this.scrollGlide = undefined;
    return true;
  }

  /** Two fingers down: end any one-finger gesture cleanly, then the camera follows the pair. */
  private beginPinch(a: { x: number; y: number }, b: { x: number; y: number }): void {
    this.flushPendingTap();
    const at = this.activeTouch;
    if (at) {
      this.clearTouchTimers(at);
      if (at.mode === 'mouse') this.touchMouse(at.lastX, at.lastY, 'mouseup');
      if (at.mode === 'orbit') this.compositor.endCameraOrbit();
      if (at.mode === 'exposeLift' && at.exposeId) this.compositor.exposeRelease(at.exposeId, false);
      this.activeTouch = undefined;
    }
    this.compositor.mobileStopMotion();
    this.stopScrollGlide();
    const edge = FrontendClient.EDGE_ZONE_PX;
    const w = this.compositor.width;
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.pinch = {
      lastDist: dist, lastMidX: mx, lastMidY: my, startDist: dist, startMidX: mx,
      edge: Math.min(a.x, b.x) < edge ? -1 : Math.max(a.x, b.x) > w - edge ? 1 : undefined,
    };
  }

  private movePinch(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const p = this.pinch;
    if (!p) return;
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.compositor.mobileZoomAt(dist / p.lastDist, mx, my);
    this.compositor.mobilePanBy(mx - p.lastMidX, my - p.lastMidY);
    p.lastDist = dist; p.lastMidX = mx; p.lastMidY = my;
  }

  /**
   * Fingers lifted. In focus mode a two-finger sideways swipe from a screen
   * edge flies to the nearest window on that side; otherwise a zoom past the
   * fitted desktop settles back to it, or (well past it) opens Exposé.
   */
  private endPinch(cancelled: boolean): void {
    const p = this.pinch;
    this.pinch = undefined;
    if (!p || cancelled) return;
    const swipe = p.lastMidX - p.startMidX;
    if (p.edge && this.compositor.getMobileView() === MobileViewState.FOCUS
        && Math.abs(swipe) > 60 && Math.abs(p.lastDist - p.startDist) < 50 && Math.sign(swipe) === -p.edge) {
      if (this.compositor.mobileFlyToNeighbor(p.edge)) return;
    }
    this.compositor.mobilePinchEnd();
  }

  /** Ask the backend to close the window owning a surface (Exposé flick-up). */
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

  /**
   * A node event's pointer position: window-relative px for window scope
   * (projection-exact for a window riding a node), workspace px for world.
   */
  private nodeLocal(node: NodeHit, vx: number, vy: number): { x: number; y: number } {
    const { x: wx, y: wy } = this.compositor.viewportToWorkspace(vx, vy);
    if (!node.surfaceId) return { x: wx, y: wy };
    const exact = this.compositor.attachedSurfaceLocal(node.surfaceId, vx, vy);
    if (exact) return exact;
    const s = this.compositor.getSurface(node.surfaceId);
    return s ? { x: wx - s.rect.x, y: wy - s.rect.y } : { x: wx, y: wy };
  }

  /**
   * A press on an interactive node: keyboard focus (exclusive for a
   * focusable node, released by any other press), raising a stacked world
   * object, and starting a drag when the node (or an ancestor) is draggable.
   */
  private pressNode(node: NodeHit, x: number, y: number, time?: number): void {
    this.nodeKeyFocus = this.compositor.nodeFocusable(node) ? node : undefined;
    const raised = this.compositor.raiseStackedNode(node);
    if (raised) this.sendToBackend({ type: 'raiseWorldNode', ownerId: raised.ownerId, nodeId: raised.nodeId });
    this.nodeDragPointer = { x, y };
    this.nodeDragging = this.compositor.beginNodeDrag(x, y, time) !== undefined;
    if (this.nodeDragging) this.canvas.style.cursor = 'grabbing';
  }

  /**
   * A press that belongs to a window's orbiting camera: inside the camera's
   * viewport, with its orbit button, and (left button) not on an
   * interactive node, a scrollbar, or a ctrl+drag of the window. The camera
   * takes the drag and the window never sees the press.
   */
  private handleCameraMouseDown(e: MouseEvent): boolean {
    if (this.mobileMode || this.localDragState || this.grabbedSurface || e.ctrlKey) return false;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (!this.compositor.cameraOrbitsAt(x, y, e.button)) return false;
    if (e.button === 0 && (this.compositor.scrollbarAt(x, y) || this.compositor.nodeAt(x, y))) return false;
    if (!this.compositor.beginCameraOrbit(x, y, e.button, e.timeStamp || undefined)) return false;
    this.cameraOrbiting = true;
    this.lastCanvasX = x;
    this.lastCanvasY = y;
    this.canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return true;
  }

  /** Relay camera changes to the backend: start and end at once, moves about 10 per second. */
  private relayCameraChange(e: CameraChangeEvent): void {
    const key = `${e.surfaceId}/${e.nodeId}`;
    if (e.phase === 'start') {
      // Focus follows the press (the window itself never saw it).
      this.focusedSurface = e.surfaceId;
      this.compositor.setFocusedSurface(e.surfaceId);
    }
    if (e.phase === 'move') {
      this.cameraPending.set(key, e);
      const wait = FrontendClient.NODE_DRAG_MOVE_MS - (performance.now() - this.cameraLastSent);
      if (wait <= 0) this.flushCameraMoves();
      else if (!this.cameraTimer) this.cameraTimer = setTimeout(() => this.flushCameraMoves(), wait);
      return;
    }
    // The end carries the resting view; a queued move for it is stale.
    if (e.phase === 'end') this.cameraPending.delete(key);
    this.sendCameraChange(e);
  }

  private flushCameraMoves(): void {
    if (this.cameraTimer) { clearTimeout(this.cameraTimer); this.cameraTimer = undefined; }
    this.cameraLastSent = performance.now();
    const pending = [...this.cameraPending.values()];
    this.cameraPending.clear();
    for (const e of pending) this.sendCameraChange(e);
  }

  private sendCameraChange(e: CameraChangeEvent): void {
    this.sendToBackend({
      type: 'cameraChange',
      phase: e.phase,
      surfaceId: e.surfaceId,
      nodeId: e.nodeId,
      position: e.position,
      target: e.target,
    });
  }

  /** Relay the compositor's node drag to the backend: start and end at once, moves about 10 per second. */
  private relayNodeDrag(e: NodeDragEvent): void {
    if (e.phase === 'move') {
      this.nodeDragPending = e;
      const wait = FrontendClient.NODE_DRAG_MOVE_MS - (performance.now() - this.nodeDragLastSent);
      if (wait <= 0) this.flushNodeDragMove();
      else if (!this.nodeDragTimer) this.nodeDragTimer = setTimeout(() => this.flushNodeDragMove(), wait);
      return;
    }
    if (e.phase === 'end') {
      // The end carries the final position (after any inertia); a queued move is stale.
      this.nodeDragPending = undefined;
      if (this.nodeDragTimer) { clearTimeout(this.nodeDragTimer); this.nodeDragTimer = undefined; }
    }
    this.sendNodeDrag(e);
    if (e.phase === 'start') this.nodeDragLastSent = performance.now();
  }

  private flushNodeDragMove(): void {
    if (this.nodeDragTimer) { clearTimeout(this.nodeDragTimer); this.nodeDragTimer = undefined; }
    const e = this.nodeDragPending;
    this.nodeDragPending = undefined;
    if (!e) return;
    this.nodeDragLastSent = performance.now();
    this.sendNodeDrag(e);
  }

  private sendNodeDrag(e: NodeDragEvent): void {
    const p = this.nodeLocal(e, this.nodeDragPointer.x, this.nodeDragPointer.y);
    this.sendToBackend({
      type: 'nodeDrag',
      phase: e.phase,
      nodeScope: e.scope,
      surfaceId: e.surfaceId,
      nodeOwnerId: e.ownerId,
      nodeId: e.nodeId,
      hitNodeId: e.hitNodeId,
      position: e.position,
      x: p.x,
      y: p.y,
    });
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
    // A mousedown that finds local drag state still active means the ending
    // event was lost (a tap that outran the startWindowDrag round-trip, or a
    // release outside the canvas). Commit the stale drag so the window
    // doesn't stay wedged in drag mode.
    if (type === 'mousedown' && this.localDragState) {
      this.finishLocalDragMove();
    }
    if (type === 'mousedown' && (e.button ?? 0) === 0) this.primaryHeld = true;

    const canvasRect = this.canvas.getBoundingClientRect();
    const x = e.clientX - canvasRect.left;
    const y = e.clientY - canvasRect.top;

    // Track canvas-space mouse position for drag start reference
    this.lastCanvasX = x;
    this.lastCanvasY = y;

    // Workspace coords (surface.rect is in workspace space, mouse is in viewport)
    const { x: wx, y: wy } = this.compositor.viewportToWorkspace(x, y);

    // A node drag whose release never arrived ends before the next press.
    if (type === 'mousedown' && this.nodeDragging) {
      this.nodeDragging = false;
      this.compositor.endNodeDrag();
    }

    // Node drag capture: a held node receives the mouseup wherever it lands.
    if (type === 'mouseup' && this.grabbedNode) {
      const held = this.grabbedNode;
      this.grabbedNode = undefined;
      if (this.nodeDragging) {
        // Release the drag first: dragEnd (or the inertia glide) precedes mouseup.
        this.nodeDragging = false;
        this.nodeDragPointer = { x, y };
        this.compositor.endNodeDrag(e.timeStamp || undefined);
        this.canvas.style.cursor = 'default';
      }
      const local = this.nodeLocal(held, x, y);
      this.sendToBackend({
        type: 'input',
        inputType: 'mouseup',
        surfaceId: held.surfaceId,
        nodeId: held.nodeId,
        nodeScope: held.scope,
        nodeOwnerId: held.ownerId,
        x: local.x,
        y: local.y,
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
        const local = this.nodeLocal(node, x, y);
        this.sendToBackend({
          type: 'input',
          inputType: type,
          surfaceId: node.surfaceId,
          nodeId: node.nodeId,
          nodeScope: node.scope,
          nodeOwnerId: node.ownerId,
          x: local.x,
          y: local.y,
          button: e.button,
          modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
        } as unknown as FrontendToBackendMsg);
        if (type === 'mousedown') this.pressNode(node, x, y, e.timeStamp || undefined);
        return;
      }
    }
    // A press anywhere but a node releases an exclusive node keyboard focus.
    if (type === 'mousedown') this.nodeKeyFocus = undefined;

    // Hit test locally — compositor is local. surfaceLocalAt returns
    // projection-correct local coords (slabs may be lifted/tilted in 3D).
    const hit = this.compositor.surfaceLocalAt(x, y);
    const hitSurface = hit?.surface;
    const grabbed = this.grabbedSurface
      ? this.compositor.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    // Grabbed surfaces use rect math (the pointer may be outside the slab
    // mid-drag); free hits use the exact ray-hit coords. A grabbed window
    // riding a node has no rect on screen: project onto its slab plane.
    const riding = grabbed ? this.compositor.attachedSurfaceLocal(grabbed.id, x, y) : undefined;
    const localX = !grabbed && hit ? hit.x : riding ? riding.x : surface ? wx - surface.rect.x : wx;
    const localY = !grabbed && hit ? hit.y : riding ? riding.y : surface ? wy - surface.rect.y : wy;

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
      this.pressAt = { surfaceId: surface.id, x, y, rectX: surface.rect.x, rectY: surface.rect.y };
    }

    if (type === 'mouseup') {
      this.grabbedSurface = undefined;
    }
  }

  private handleMouseMoveThrottled(e: MouseEvent): void {
    // An orbiting camera follows the pointer locally; its changes are relayed
    // (throttled) instead of a mousemove stream.
    if (this.cameraOrbiting) {
      const r = this.canvas.getBoundingClientRect();
      this.compositor.updateCameraOrbit(e.clientX - r.left, e.clientY - r.top, e.timeStamp || undefined);
      return;
    }
    // Client-side local move drag — move surface instantly, no server round-trip
    if (this.localDragState && this.localDragState.dragType === 'move') {
      const canvasRect = this.canvas.getBoundingClientRect();
      this.applyLocalDragMove(e.clientX - canvasRect.left, e.clientY - canvasRect.top);
      return;
    }

    // A draggable node follows the pointer locally every event; the
    // compositor reports the drag (throttled dragMove) instead of a
    // mousemove stream.
    if (this.nodeDragging) {
      const canvasRect = this.canvas.getBoundingClientRect();
      const x = e.clientX - canvasRect.left;
      const y = e.clientY - canvasRect.top;
      this.lastCanvasX = x;
      this.lastCanvasY = y;
      this.nodeDragPointer = { x, y };
      this.compositor.updateNodeDrag(x, y, e.timeStamp || undefined);
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
      const heldLocal = this.nodeLocal(held, x, y);
      this.pendingMouseMove = {
        type: 'input',
        inputType: 'mousemove',
        surfaceId: held.surfaceId,
        nodeId: held.nodeId,
        nodeScope: held.scope,
        nodeOwnerId: held.ownerId,
        x: heldLocal.x,
        y: heldLocal.y,
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
      // grab for draggable nodes, pointer for interactive ones, or the node's own cursor.
      this.canvas.style.cursor = this.compositor.nodeCursor(node);
      const nodeLocal = this.nodeLocal(node, x, y);
      this.pendingMouseMove = {
        type: 'input',
        inputType: 'mousemove',
        surfaceId: node.surfaceId,
        nodeId: node.nodeId,
        nodeScope: node.scope,
        nodeOwnerId: node.ownerId,
        x: nodeLocal.x,
        y: nodeLocal.y,
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

    // A window camera with zoom: true dollies on the wheel inside its
    // viewport; the window does not scroll then (an interactive node under
    // the pointer still hears the wheel).
    if (!this.mobileMode) {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      if (this.compositor.cameraWheel(x, y, e.deltaY * unit)) {
        e.preventDefault();
        const node = this.compositor.nodeAt(x, y);
        if (node) this.queueNodeWheel(node, x, y, e);
        return;
      }
    }

    // An interactive node under the pointer hears the wheel ('wheel' node
    // input). A window's node shares it with the window (which still
    // scrolls); a world node takes it, so the desktop pans only when no
    // interactive world node is under the pointer. So does a pop-out hanging
    // past its window (an open dropdown list): whatever lies beneath it,
    // another window or the desktop, stays put.
    const node = this.mobileMode ? undefined : this.compositor.nodeAt(x, y);
    const surface = this.compositor.surfaceAt(x, y);
    if (node) {
      this.queueNodeWheel(node, x, y, e);
      if (node.scope === 'world' || node.surfaceId !== surface?.id) {
        e.preventDefault();
        return;
      }
    }

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
    const riding = this.compositor.attachedSurfaceLocal(surface.id, x, y);
    const localX = riding ? riding.x : wx - surface.rect.x;
    const localY = riding ? riding.y : wy - surface.rect.y;
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

    this.scheduleWheelFlush();
  }

  /** Accumulate a node's wheel deltas for the next animation frame. */
  private queueNodeWheel(node: NodeHit, x: number, y: number, e: WheelEvent): void {
    const key = `${node.scope}|${node.surfaceId ?? node.ownerId ?? ''}|${node.nodeId}`;
    const local = this.nodeLocal(node, x, y);
    const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    const prev = this.pendingNodeWheels.get(key);
    if (prev) {
      prev.deltaX += e.deltaX;
      prev.deltaY += e.deltaY;
      prev.x = local.x;
      prev.y = local.y;
      prev.modifiers = modifiers;
    } else {
      this.pendingNodeWheels.set(key, { node, x: local.x, y: local.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers });
    }
    this.scheduleWheelFlush();
  }

  /** Send the frame's coalesced wheel inputs (surfaces and nodes) once per animation frame. */
  private scheduleWheelFlush(): void {
    if (this.wheelRafId) return;
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
      for (const w of this.pendingNodeWheels.values()) {
        this.sendToBackend({
          type: 'input',
          inputType: 'wheel',
          surfaceId: w.node.surfaceId,
          nodeId: w.node.nodeId,
          nodeScope: w.node.scope,
          nodeOwnerId: w.node.ownerId,
          x: w.x,
          y: w.y,
          deltaX: w.deltaX,
          deltaY: w.deltaY,
          modifiers: w.modifiers,
        });
      }
      this.pendingNodeWheels.clear();
    });
  }

  // ── Exposé (desktop input; the phone's gestures live in onTouchStart) ──
  //
  // Exposé is per client and visual only (the compositor spreads the
  // windows; backend rects never change). On the desktop: hover selects a
  // window, a click picks it, a click on empty space leaves; arrows and Tab
  // move the selection, Enter picks, Escape leaves. The rails left in place
  // (dock, toolbars) stay clickable and leave Exposé as they take the click.

  /** A press that began in the desktop Exposé (on a window, or on empty space). */
  private exposePress?: { id?: string; button: number };

  /** F3, or Ctrl-↑ (Mission Control's keys), without other modifiers. */
  private static isExposeHotkey(e: KeyboardEvent): boolean {
    if (e.altKey || e.shiftKey || e.metaKey) return false;
    return (e.key === 'F3' && !e.ctrlKey) || (e.key === 'ArrowUp' && e.ctrlKey);
  }

  /**
   * Open, close or toggle Exposé on this client (the hotkey, or the
   * backend's `expose` message). The phone opens its camera Exposé, the
   * desktop the mouse-and-keys one.
   */
  private setExpose(action: 'show' | 'hide' | 'toggle'): void {
    const open = this.compositor.isExposeOpen();
    const want = action === 'toggle' ? !open : action === 'show';
    if (want === open) return;
    this.exposePress = undefined;
    if (want) {
      if (this.compositor.enterExpose() && !this.mobileMode) this.canvas.style.cursor = 'default';
    } else {
      this.compositor.exitExpose();
    }
  }

  /** Pick a window in Exposé: it flies home on top, and the backend focuses and raises it. */
  private pickExpose(surfaceId: string): void {
    this.focusedSurface = surfaceId;
    this.compositor.exitExpose(surfaceId);
    this.sendToBackend({ type: 'frontendFocus', surfaceId, raise: true });
  }

  /** Desktop Exposé pointer handling. True when Exposé took the event. */
  private exposeMouse(e: MouseEvent, type: 'mousedown' | 'mouseup' | 'mousemove'): boolean {
    if (this.mobileMode) return false;
    const open = this.compositor.isExposeOpen();
    if (!open && !this.exposePress) return false;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const id = open ? this.compositor.exposeAt(x, y) : undefined;
    if (type === 'mousemove') {
      if (this.exposePress) return true;
      if (!id) return false; // the rails left in place still hear the pointer
      this.compositor.exposeSelect(id);
      this.canvas.style.cursor = 'pointer';
      return true;
    }
    if (type === 'mousedown') {
      if (!open) return false;
      if (!id && this.compositor.surfaceAt(x, y)) {
        // A rail left in place: leave Exposé and let the press reach it.
        this.compositor.exitExpose();
        return false;
      }
      this.exposePress = { id, button: e.button };
      if (id) this.compositor.exposeSelect(id);
      return true;
    }
    const press = this.exposePress;
    this.exposePress = undefined;
    if (!press) return false;
    if (open && press.button === 0 && e.button === 0) {
      if (press.id && id === press.id) this.pickExpose(press.id);
      else if (!press.id && !id) this.setExpose('hide');
    }
    return true;
  }

  /** The desktop Exposé keeps the wheel (a rail left in place still scrolls). */
  private exposeWheel(e: WheelEvent): boolean {
    if (this.mobileMode || !this.compositor.isExposeOpen()) return false;
    const r = this.canvas.getBoundingClientRect();
    if (this.compositor.surfaceAt(e.clientX - r.left, e.clientY - r.top)) return false;
    e.preventDefault();
    return true;
  }

  /** Desktop Exposé keys: arrows and Tab move the selection, Enter or Space picks, Escape leaves. */
  private exposeKey(e: KeyboardEvent): void {
    const move = (dir: 'left' | 'right' | 'up' | 'down' | 'next' | 'prev') => { this.compositor.exposeMoveSelection(dir); };
    switch (e.key) {
      case 'Escape': this.setExpose('hide'); return;
      case 'Enter':
      case ' ': {
        const id = this.compositor.getExposeSelection();
        if (id) this.pickExpose(id);
        else this.setExpose('hide');
        return;
      }
      case 'ArrowLeft': move('left'); return;
      case 'ArrowRight': move('right'); return;
      case 'ArrowUp': move('up'); return;
      case 'ArrowDown': move('down'); return;
      case 'Tab': move(e.shiftKey ? 'prev' : 'next'); return;
    }
  }

  private handleKeyEvent(e: KeyboardEvent, type: 'keydown' | 'keyup'): void {
    // Global shortcuts: pulled out of the regular keydown stream so they
    // always work regardless of which surface holds focus.
    //   ⌘K / Ctrl-K → CommandPalette (launch any Abject)
    //   ⌘` / Ctrl-` → WindowSwitcher (jump to an open window)
    //   F3 / Ctrl-↑ → Exposé (this client's windows spread out to pick one)
    if (
      type === 'keydown' &&
      (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
    ) {
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        this.setExpose('hide');
        this.sendToBackend({ type: 'globalShortcut', combo: 'commandPalette' });
        return;
      }
      if (e.key === '`') {
        e.preventDefault();
        this.setExpose('hide');
        this.sendToBackend({ type: 'globalShortcut', combo: 'windowSwitcher' });
        return;
      }
    }
    if (type === 'keydown' && FrontendClient.isExposeHotkey(e)) {
      e.preventDefault();
      if (!e.repeat) this.setExpose('toggle');
      return;
    }
    // The desktop Exposé holds the keyboard while it shows.
    if (!this.mobileMode && this.compositor.isExposeOpen()) {
      e.preventDefault();
      if (type === 'keydown') this.exposeKey(e);
      return;
    }

    // A focusable scene node holds the keyboard: keys go to the backend,
    // which routes them to the node's owner only, window or no window.
    if (this.nodeKeyFocus && !(this.mobileKeyboardProxy && e.target === this.mobileKeyboardProxy)) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'c' || e.key === 'x')) return;
      e.preventDefault();
      this.sendToBackend({
        type: 'input',
        inputType: type,
        surfaceId: this.focusedSurface,
        key: e.key,
        code: e.code,
        modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey },
      });
      return;
    }

    if (!this.focusedSurface) {
      // Silent drop point: without a focused surface, keys go nowhere.
      // Proxy-targeted events are exempt here — they are logged below.
      if (!(this.mobileKeyboardProxy && e.target === this.mobileKeyboardProxy)) {
        console.warn(`[frontend-client] ${type} dropped: no focused surface (target=${(e.target as HTMLElement)?.id || (e.target as HTMLElement)?.tagName})`);
      }
      return;
    }

    // On mobile, the hidden proxy input handles keyboard events -- skip
    // the document-level handler to avoid sending duplicate characters.
    if (this.mobileKeyboardProxy && e.target === this.mobileKeyboardProxy) {
      console.warn(`[frontend-client] ${type} delegated to mobile keyboard proxy (surfaceId=${this.focusedSurface})`);
      return;
    }

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
      this.transport.send(this.wireEnc.encodeFrame(msg, this.wireDeflate));
    }
  }

  /**
   * Ack processed wire frames, at most once per animation frame. The backend
   * uses the in-flight count as flow control: when this tab is slow (or
   * backgrounded, where rAF stops), it coalesces instead of piling up stale
   * frames on the socket.
   */
  private scheduleFrameAck(): void {
    if (this.frameAckScheduled) return;
    this.frameAckScheduled = true;
    requestAnimationFrame(() => {
      this.frameAckScheduled = false;
      if (this.authenticated) {
        this.sendToBackend({ type: 'frameAck', n: this.wireFramesReceived });
      }
    });
  }
}
