/**
 * BackendUI — Node.js-side display server abject.
 *
 * Implements the same `abjects:ui` interface as UIServer so that all existing
 * abjects (WidgetManager, WindowAbject, widgets, etc.) can communicate with it
 * without changes. Instead of calling a local Compositor, it forwards draw
 * commands over WebSocket to the thin browser FrontendClient.
 */

import {
  AbjectId,
  AbjectMessage,
} from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { require as contractRequire } from '../src/core/contracts.js';
import { event, request } from '../src/core/message.js';
import { Capabilities } from '../src/core/capability.js';
import type { WebSocket } from 'ws';
import type {
  BackendToFrontendMsg,
  FrontendToBackendMsg,
  FontMetricsMsg,
  InputMsg,
  EndWindowDragMsg,
  FileUploadMsg,
  CloseWindowMsg,
  DisplayResizedMsg,
  AudioVoiceSpec,
} from './ws-protocol.js';
import { validateSceneOps, normalizeSceneOps, SCENE_NODE_KINDS, type SceneOp, type SceneTheme } from '../src/ui/gl/scene-types.js';
import type { AuthConfig, SessionStore } from './auth.js';
import type { UITransport } from './ui-transport.js';
import { WebSocketUITransport } from './ui-transport.js';
import { WireEncoder, WireDecoder, isWireFrame } from '../src/network/wire-codec.js';
import { Log } from '../src/core/timed-log.js';
import { createHash } from 'node:crypto';

const log = new Log('BackendUI');
const UI_INTERFACE = 'abjects:ui';
const WIDGET_FONT = '14px "Inter", system-ui, sans-serif';

/**
 * Merge an update op's params into a retained node, deep-merging `geometry`
 * so a positions-only deform update keeps the existing indices/uvs. A shallow
 * spread would drop indices from the retained snapshot, so reconnect replay
 * would rebuild the mesh as a disjoint triangle soup. Mirrors the client
 * SceneStore merge so retained state and live state stay identical.
 */
function mergeSceneParams(node: SceneOp, incoming: Record<string, unknown>): void {
  const prevGeom = node.params?.geometry as Record<string, unknown> | undefined;
  const nextGeom = incoming.geometry as Record<string, unknown> | undefined;
  node.params = { ...(node.params ?? {}), ...incoming };
  if (incoming.geometry !== undefined && prevGeom && nextGeom) {
    node.params.geometry = { ...prevGeom, ...nextGeom };
  }
}

export interface SurfaceState {
  surfaceId: string;
  objectId: AbjectId;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
  inputPassthrough: boolean;
  inputMonitor: boolean;
  transparent: boolean;
  closable: boolean;
  lastDrawCommands: Array<{ type: string; surfaceId: string; params: unknown }>;
  /**
   * Retained scene-vocabulary nodes riding this surface's slab, compacted
   * to their latest definition (add + merged updates) for reconnect replay.
   */
  sceneNodes: Map<string, SceneOp>;
  /**
   * Decorations: scene nodes contributed by abjects OTHER than the surface
   * owner (nodeId -> contributor). Their input routes to the contributor and
   * they tear down when the contributor dies.
   */
  sceneContributors: Map<string, AbjectId>;
  /** Abject-requested slab transform (tilt/float), replayed on reconnect. */
  slabTransform?: { rotation?: [number, number, number]; z?: number };
  workspaceId?: string;
  title?: string;
}

export interface InputEvent {
  type: 'mousedown' | 'mouseup' | 'mousemove' | 'mouseenter' | 'mouseleave' | 'keydown' | 'keyup' | 'wheel' | 'paste';
  surfaceId?: string;
  x?: number;
  y?: number;
  button?: number;
  key?: string;
  code?: string;
  modifiers?: {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
  deltaX?: number;
  deltaY?: number;
  pasteText?: string;
}

/**
 * BackendUI — implements `abjects:ui` on the Node.js backend.
 * Surface commands are forwarded to the browser frontend over WebSocket.
 * Input events from the frontend are routed to surface owners.
 */
/** Per-client connection state for multi-client broadcast. */
interface ClientConnection {
  id: string;
  transport: UITransport;
  ready: boolean;
  sendQueue: BackendToFrontendMsg[];
  flushScheduled: boolean;
  kind: 'websocket' | 'webrtc';
  peerId?: string;
  name?: string;
  connectedAt: number;
  /** Wire codec pair for this connection — stateful, paired with the client's. */
  enc: WireEncoder;
  dec: WireDecoder;
  /**
   * Whether encodeFrame should deflate large frames. WebRTC transports
   * already deflate inside PeerTransport, so only WebSocket clients opt in.
   */
  deflate: boolean;
  /** Wire frames sent on this connection (flushes + immediate sends). */
  framesSent: number;
  /** Cumulative frames the client reported processing (frameAck). */
  framesAcked: number;
  /** Queue index of the last queued single-surface draw, per surface. */
  queuedDrawIndex: Map<string, number>;
  /** Queue index of the last queued message touching a surface, per surface. */
  lastSurfaceTouch: Map<string, number>;
  /** Queue index of the last queued setCursor, for latest-wins replacement. */
  queuedCursorIndex?: number;
  /** Queue index of the last queued update-only sceneOps batch, per scene key. */
  queuedSceneUpdateIndex: Map<string, number>;
  /** Stale messages replaced in-queue since the last diagnostics line. */
  coalescedDrops: number;
  lastCoalesceLog: number;
  /** Image blob hashes already delivered to this client. */
  sentBlobs: Set<string>;
}

/**
 * Flow-control water marks (frames in flight, i.e. sent but not yet acked by
 * the client). Above HIGH the flush loop pauses and the queue coalesces;
 * an ack that brings the count to LOW or below resumes flushing.
 */
const UNACKED_HIGH = 8;
const UNACKED_LOW = 3;

/**
 * Hard ceiling on a client's send queue. Coalescing keeps well-behaved
 * traffic bounded by state size, but any un-coalesced message type produced
 * at frame rate against a stalled client (a backgrounded tab stops acking)
 * would otherwise grow the queue without limit — a 30fps 3D animation once
 * ate the UI worker's whole 8GB heap this way. Past the cap we drop the
 * client; on reconnect it gets a full state replay, which is strictly
 * cheaper than the backlog.
 */
const MAX_CLIENT_QUEUE = 5000;

/**
 * Per-node last-wins merge of two update-only sceneOps batches: the same
 * shallow transform/params merge the retained state applies, so replacing
 * the queued batch with the merge is indistinguishable (to the client) from
 * having applied both.
 */
function mergeSceneUpdateOps(
  prev: Array<Record<string, unknown>>,
  next: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const op of prev) byId.set(String(op.id), op);
  for (const op of next) {
    const old = byId.get(String(op.id));
    if (!old) { byId.set(String(op.id), op); continue; }
    const merged: Record<string, unknown> = { ...old, ...op };
    if (old.transform || op.transform) {
      merged.transform = { ...(old.transform as object | undefined), ...(op.transform as object | undefined) };
    }
    if (old.params || op.params) {
      merged.params = { ...(old.params as object | undefined), ...(op.params as object | undefined) };
    }
    byId.set(String(op.id), merged);
  }
  return [...byId.values()];
}

/** URL scheme for content-addressed images in draw commands. */
const ABX_IMAGE_PREFIX = 'abx:sha256:';

/** Optional metadata supplied when registering a transport with addTransport. */
export interface ClientMeta {
  kind?: 'websocket' | 'webrtc';
  peerId?: string;
  name?: string;
}

export class BackendUI extends Abject {
  private surfaces: Map<string, SurfaceState> = new Map();
  /** In-progress file uploads, keyed by uploadId, awaiting all chunks. */
  private fileUploads: Map<string, { surfaceId: string; name: string; mimeType: string; chunks: string[]; received: number; chunkCount: number; toFocusedWidget?: boolean }> = new Map();
  private focusedSurface?: string;
  /** Accent color for the focused window's glow halo (last focused window's theme accent). */
  private focusGlowColor?: string;
  /** Corner radius of the focused window, so the halo matches its silhouette. */
  private focusGlowRadius?: number;
  /** Active workspace's palette subset for the 3D scene (replayed on reconnect). */
  private sceneTheme?: SceneTheme;
  /**
   * World-scope scene nodes (the global scene graph beyond windows), keyed by
   * owning abject. Positions are workspace px; nodes live until removed or
   * their owner dies. Compacted like per-surface nodes for reconnect replay.
   */
  private worldScenes: Map<AbjectId, Map<string, SceneOp>> = new Map();
  /**
   * The selected 3D scene node: set on node mousedown, cleared when focus
   * moves elsewhere. While set, keyboard input routes to the node's owner
   * (with focus/blur events bracketing the selection) — widget-style focus
   * for scene geometry.
   */
  private focusedNode?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: AbjectId; nodeId: string };
  private mouseGrabAbject?: AbjectId;  // WindowManager grabs mouse during drag
  private mouseGrabClientId?: string;  // Which client owns the current resize grab
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }> = new Map();

  /** playbackId → Abject to notify of ended/error audio events. */
  private audioNotify: Map<string, AbjectId> = new Map();
  /** recordingId → Abject to notify when a media recording completes. */
  private recordingNotify: Map<string, AbjectId> = new Map();
  /**
   * videoId → Abject to notify of video element state (videoEvent). Unlike
   * audioNotify this is long-lived: a video emits many events over its life,
   * so entries clear on dispose, not on first event.
   */
  private videoNotify: Map<string, AbjectId> = new Map();
  /** All connected frontend clients, keyed by clientId. */
  private clients: Map<string, ClientConnection> = new Map();
  private clientCounter = 0;
  private surfaceCounter = 0;
  private consoleId?: AbjectId;
  private windowManagerId?: AbjectId;
  private currentSelectedText = '';
  private lastDisplayInfo: { width: number; height: number } = { width: 1280, height: 720 };
  /** Last hovered surface per client, to synthesize mouseleave on change. */
  private hoverSurfaceByClient: Map<string, string | undefined> = new Map();
  private lastMouseX = 0;
  private lastMouseY = 0;
  /** Which client sent the last mousedown (for requestDrag targeting). */
  private lastInputClientId?: string;
  private lastMonitorMoveTime = 0;
  private activeWorkspaceId?: string;
  private authConfig?: AuthConfig;
  private sessionStore?: SessionStore;
  /** Font metrics from frontend: font -> char -> pixel width */
  private fontMetrics: Map<string, Map<string, number>> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'UIServer',
        description:
          'X11-style display server rendering a native WebGL2 3D desktop scene. Manages surfaces (slabs in the 3D scene), 2D draw commands, retained 3D scene ops (scene: mesh/light nodes with primitives box/sphere/plane/cylinder, theme-token colors), slab transforms (setSurfaceTransform), and routes input events to surface owners. Use cases: draw shapes/text/images on surfaces, render lit 3D content attached to windows, handle raw mouse and keyboard input events.',
        version: '1.0.0',
        interface: {
            id: UI_INTERFACE,
            name: 'UI',
            description: 'Surface management and input routing',
            methods: [
              {
                name: 'createSurface',
                description: 'Create a new drawing surface. Example: const surfaceId = await this.call(this.dep("UIServer"), "createSurface", { rect: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 100 })',
                parameters: [
                  {
                    name: 'rect',
                    type: { kind: 'reference', reference: 'Rect' },
                    description: 'Surface position and size',
                  },
                  {
                    name: 'zIndex',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Z-ordering (higher = on top)',
                    optional: true,
                  },
                  {
                    name: 'inputPassthrough',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'If true, surface is display-only — input events pass through to surfaces behind it',
                    optional: true,
                  },
                  {
                    name: 'inputMonitor',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'If true, surface receives a copy of all mouse/wheel events (in surface-local coordinates) before normal hit-test routing. Use with inputPassthrough for cursor-following overlays.',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroySurface',
                description: 'Destroy a surface. Example: await this.call(this.dep("UIServer"), "destroySurface", { surfaceId })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to destroy',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'draw',
                description: 'Execute draw commands on a surface. Each command has exactly 3 fields: { type, surfaceId, params }. ' +
                  'Valid types: "clear" (params: {}), "rect" (params: { x, y, width, height, fill?, stroke?, lineWidth?, radius? }), ' +
                  '"text" (params: { x, y, text, font?, fill?, align?, baseline? }), "line" (params: { x1, y1, x2, y2, stroke?, lineWidth? }), ' +
                  '"path" (params: { path (SVG path string), fill?, stroke?, lineWidth? }), ' +
                  '"imageUrl" (params: { x, y, width?, height?, url }) — draws an image from a URL or data URI. ' +
                  'IMPORTANT: Use "fill" for fill color (NOT "color"), "stroke" for stroke color, "rect" (NOT "fillRect"), "text" (NOT "fillText"). ' +
                  'Always nest parameters inside "params", NOT as flat top-level fields.',
                parameters: [
                  {
                    name: 'commands',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'DrawCommand' },
                    },
                    description: 'Array of { type, surfaceId, params } draw commands',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'moveSurface',
                description: 'Move a surface. Example: await this.call(uiId, "abjects:ui", "moveSurface", { surfaceId, x: 200, y: 100 })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to move',
                  },
                  {
                    name: 'x',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New x position',
                  },
                  {
                    name: 'y',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New y position',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resizeSurface',
                description: 'Resize a surface. Example: await this.call(uiId, "abjects:ui", "resizeSurface", { surfaceId, width: 400, height: 300 })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to resize',
                  },
                  {
                    name: 'width',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New width',
                  },
                  {
                    name: 'height',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New height',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setZIndex',
                description: 'Set surface z-index',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface',
                  },
                  {
                    name: 'zIndex',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New z-index',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'focus',
                description: 'Set keyboard focus to a surface',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to focus',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'scene',
                description: 'Apply retained 3D scene ops. Default scope: your window\'s subtree (every window is a slab in the 3D scene; nodes travel with it, positions are px from the window center). With world: true, nodes attach to the GLOBAL scene graph instead — positions are workspace px, no window needed (desktop pets, ambient décor); params.layer: "back" (default, behind windows) or "front" (above windows). Ops: { op: "add"|"update"|"remove"|"animate", id, parentId?, kind: "mesh"|"light"|"group"|"environment", transform: { position?: [x,y,z], rotation?: [rx,ry,rz], scale?: n|[x,y,z] }, params }. Mesh params: { primitive: "plane"|"box"|"sphere"|"cylinder"|"cone"|"torus"|"icosphere", color, emissive?, opacity?, layer?, metalness?(0..1), roughness?(0..1), texture?(url|dataURI|"surface:<id>"), billboard?, drawMode?("triangles"|"lines"|"points"), pointSize?, occlude?(default true: clipped to the window & below the title bar; false = draw on top / pop out), instances?:[{position,scale?,rotation?,color?},...](one geometry drawn many times in a single call — particles/fields) } for a built-in shape, OR { geometry: { positions, indices?, normals?, colors?(per-vertex rgb 0..1), uvs? }, color, ... } for an arbitrary polygonal mesh (re-send geometry in an "update" op to deform it every frame). Light params: { lightType: "point"|"directional"|"spot", color?, intensity?, direction?, range?, angle?, penumbra?, castShadow?(directional — casters shadow each other) }. Environment params: { ambient?, fog?:{ color?, near, far }, bloom?:true|{ threshold?, intensity? } (glow on bright/emissive meshes) }. ANIMATE (client-side): { op:"animate", id, params:{ preset?:"spin"|"orbit"|"bob"|"pulse", channel?:"position"|"rotation"|"scale"|"color"|"emissive"|"opacity", to?, from?, duration?, easing?, loop?, yoyo?, delay?, path?, stop?:true } }. Colors accept "#hex" or theme tokens like "$accent". Nodes are RETAINED until removed (world nodes also tear down when their owner dies). Example: await this.call(uiId, "scene", { world: true, ops: [{ op: "add", id: "pet", kind: "mesh", transform: { position: [400, 600, 30], scale: 40 }, params: { primitive: "sphere", color: "$accent" } }] })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Target surface (defaults to your first surface; ignored with world: true)',
                    optional: true,
                  },
                  {
                    name: 'world',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'Attach nodes to the global scene graph (workspace coordinates) instead of a window',
                    optional: true,
                  },
                  {
                    name: 'ops',
                    type: { kind: 'array', elementType: { kind: 'reference', reference: 'SceneOp' } },
                    description: 'Scene operations (validated; invalid batches are rejected with the vocabulary)',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setSurfaceTransform',
                description: 'Tilt or float your window\'s slab in the 3D scene (visual only — input picking follows automatically). rotation: [rx, ry, rz] radians; z: px toward the viewer.',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Your surface',
                  },
                  {
                    name: 'rotation',
                    type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'number' } },
                    description: 'Euler radians [rx, ry, rz]',
                    optional: true,
                  },
                  {
                    name: 'z',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Lift toward the viewer in px',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getDisplayInfo',
                description: 'Get display dimensions',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'measureText',
                description: 'Measure the pixel width of text on a surface',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to measure on',
                  },
                  {
                    name: 'text',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The text to measure',
                  },
                  {
                    name: 'font',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'CSS font string',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'injectInput',
                description: 'Inject a synthetic input event into a surface (click, keypress, etc.)',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Target surface ID',
                  },
                  {
                    name: 'type',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Event type: mousedown, mouseup, mousemove, keydown, keyup',
                  },
                  {
                    name: 'x',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'X coordinate (surface-local)',
                    optional: true,
                  },
                  {
                    name: 'y',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Y coordinate (surface-local)',
                    optional: true,
                  },
                  {
                    name: 'button',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Mouse button (0=left, 1=middle, 2=right)',
                    optional: true,
                  },
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Key value for keyboard events',
                    optional: true,
                  },
                  {
                    name: 'code',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Key code for keyboard events',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'click',
                description: 'Simulate a mouse click (mousedown + mouseup) at a position on a surface',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target surface ID' },
                  { name: 'x', type: { kind: 'primitive', primitive: 'number' }, description: 'X coordinate (surface-local)' },
                  { name: 'y', type: { kind: 'primitive', primitive: 'number' }, description: 'Y coordinate (surface-local)' },
                  { name: 'button', type: { kind: 'primitive', primitive: 'number' }, description: 'Mouse button (0=left, 1=middle, 2=right)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'type',
                description: 'Simulate typing a string of text by sending keydown/keyup for each character',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target surface ID' },
                  { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to type' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'keyPress',
                description: 'Simulate a single key press (keydown + keyup)',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target surface ID' },
                  { name: 'key', type: { kind: 'primitive', primitive: 'string' }, description: 'Key value (e.g. "Enter", "Escape", "a")' },
                  { name: 'code', type: { kind: 'primitive', primitive: 'string' }, description: 'Key code (e.g. "Enter", "KeyA")', optional: true },
                  { name: 'modifiers', type: { kind: 'reference', reference: 'Modifiers' }, description: 'Modifier keys: { shift, ctrl, alt, meta }', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'captureScreenshot',
                description: 'Capture a screenshot of an object\'s window as base64-encoded PNG',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'AbjectId of the object whose window to capture',
                  },
                ],
                returns: {
                  kind: 'object',
                  properties: {
                    imageBase64: { kind: 'primitive', primitive: 'string' },
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'captureDesktop',
                description: 'Capture a screenshot of the entire desktop as base64-encoded PNG',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    imageBase64: { kind: 'primitive', primitive: 'string' },
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'listWindows',
                description: 'List all visible windows with their objectId, title, and position',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'WindowInfo' },
                },
              },
              {
                name: 'audioPlay',
                description: 'Relay: start audio playback on the connected frontend client (used by the AudioOutput capability; call AudioOutput, not this, for playback)',
                parameters: [
                  { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-chosen playback id' },
                  { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'http(s) URL or data: URI' },
                  { name: 'volume', type: { kind: 'primitive', primitive: 'number' }, description: '0..1', optional: true },
                  { name: 'loop', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Loop playback', optional: true },
                  { name: 'notifyId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId to notify of ended/error via playbackEvent', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'audioControl',
                description: 'Relay: pause/resume/stop/stopAll a frontend audio playback',
                parameters: [
                  { name: 'action', type: { kind: 'primitive', primitive: 'string' }, description: 'pause | resume | stop | stopAll' },
                  { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target playback (omit for stopAll)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'audioGraph',
                description: 'Relay: synthesize and play a Web Audio oscillator/noise graph on the connected frontend (used by the AudioOutput capability; call AudioOutput.playGraph/playTone, not this)',
                parameters: [
                  { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-chosen playback id' },
                  { name: 'voices', type: { kind: 'array', elementType: { kind: 'reference', reference: 'AudioVoiceSpec' } }, description: 'Oscillator/noise voices to synthesize' },
                  { name: 'volume', type: { kind: 'primitive', primitive: 'number' }, description: 'Master gain 0..1', optional: true },
                  { name: 'loop', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Sustain voices until stopped', optional: true },
                  { name: 'notifyId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId to notify of ended/error via playbackEvent', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'videoSetup',
                description: 'Relay: create a client-side video element for a video widget (used by VideoWidget; frames composite client-side into videoFrame regions)',
                parameters: [
                  { name: 'videoId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-chosen video element id' },
                  { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'http(s) URL or data: URI', optional: true },
                  { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Client-held captured MediaStream id (live source)', optional: true },
                  { name: 'muted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Start muted', optional: true },
                  { name: 'loop', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Loop playback', optional: true },
                  { name: 'autoplay', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Start playing immediately (default true)', optional: true },
                  { name: 'notifyId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId to notify of playback state via videoEvent', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'videoControl',
                description: 'Relay: play/pause/seek/setMuted/dispose a client-side video element',
                parameters: [
                  { name: 'videoId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target video element' },
                  { name: 'action', type: { kind: 'primitive', primitive: 'string' }, description: 'play | pause | seek | setMuted | dispose' },
                  { name: 'value', type: { kind: 'primitive', primitive: 'number' }, description: 'seek: seconds; setMuted: 1 muted, 0 audible', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'mediaCapture',
                description: 'Relay: capture mic/camera (or screen with display: true) on the frontend client; returns { streamId, tracks } (used by the MediaStream capability)',
                parameters: [
                  { name: 'audio', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Capture audio', optional: true },
                  { name: 'video', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Capture video', optional: true },
                  { name: 'display', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Screen share instead of camera', optional: true },
                ],
                returns: { kind: 'object', properties: { streamId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'mediaCaptureFrame',
                description: 'Relay: grab one PNG frame of a frontend-captured video stream; returns { base64, width, height }',
                parameters: [
                  { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Stream id from mediaCapture' },
                ],
                returns: { kind: 'object', properties: { base64: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'mediaRecordStart',
                description: 'Relay: start a MediaRecorder on a frontend-captured stream; completion arrives via a recordingReady event to notifyId',
                parameters: [
                  { name: 'recordingId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-chosen recording id' },
                  { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Stream id from mediaCapture' },
                  { name: 'maxDurationMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Auto-stop after this many ms', optional: true },
                  { name: 'notifyId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId to notify via recordingReady', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'mediaRecordStop',
                description: 'Relay: stop an in-progress frontend recording early (recordingReady still fires)',
                parameters: [
                  { name: 'recordingId', type: { kind: 'primitive', primitive: 'string' }, description: 'Recording id' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'mediaStreamControl',
                description: 'Relay: stop a frontend-captured stream or mute/unmute one of its tracks',
                parameters: [
                  { name: 'action', type: { kind: 'primitive', primitive: 'string' }, description: 'stopStream | muteTrack' },
                  { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'For stopStream', optional: true },
                  { name: 'trackId', type: { kind: 'primitive', primitive: 'string' }, description: 'For muteTrack', optional: true },
                  { name: 'muted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'For muteTrack', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'speechSpeak',
                description: 'Relay: speak text with the frontend browser speechSynthesis (used by the Speech capability; call Speech, not this, for text-to-speech)',
                parameters: [
                  { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to speak' },
                  { name: 'voice', type: { kind: 'primitive', primitive: 'string' }, description: 'Voice name from speechVoices', optional: true },
                ],
                returns: { kind: 'object', properties: { spoken: { kind: 'primitive', primitive: 'boolean' } } },
              },
              {
                name: 'speechRecognize',
                description: 'Relay: live speech recognition on the frontend; returns { text } when the browser recognizes speech, or { audioBase64, mimeType } of a mic recording for server-side transcription',
                parameters: [
                  { name: 'maxDurationMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Listening window in ms (default 10000)', optional: true },
                ],
                returns: { kind: 'object', properties: {
                  text: { kind: 'primitive', primitive: 'string' },
                  audioBase64: { kind: 'primitive', primitive: 'string' },
                  mimeType: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'speechVoices',
                description: 'Relay: list the frontend browser speechSynthesis voice names',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'listFrontendClients',
                description: 'List all currently connected frontend UI clients (both WebSocket and WebRTC).',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: {
                    kind: 'object',
                    properties: {
                      clientId: { kind: 'primitive', primitive: 'string' },
                      kind: { kind: 'primitive', primitive: 'string' },
                      peerId: { kind: 'primitive', primitive: 'string' },
                      name: { kind: 'primitive', primitive: 'string' },
                      connectedAt: { kind: 'primitive', primitive: 'number' },
                      ready: { kind: 'primitive', primitive: 'boolean' },
                    },
                  },
                },
              },
              {
                name: 'disconnectFrontendClient',
                description: 'Forcefully close a connected frontend UI client by clientId.',
                parameters: [
                  { name: 'clientId', type: { kind: 'primitive', primitive: 'string' }, description: 'Client id from listFrontendClients' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'input',
                description: 'Input event (mouse, keyboard, paste)',
                payload: { kind: 'reference', reference: 'InputEvent' },
              },
              {
                name: 'focus',
                description: 'Surface gained/lost focus',
                payload: {
                  kind: 'object',
                  properties: {
                    surfaceId: { kind: 'primitive', primitive: 'string' },
                    focused: { kind: 'primitive', primitive: 'boolean' },
                  },
                },
              },
              {
                name: 'frontendClientsChanged',
                description: 'Emitted when a frontend UI client connects or disconnects',
                payload: {
                  kind: 'object',
                  properties: {
                    count: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.UI_SURFACE, Capabilities.UI_INPUT],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createSurface', async (msg: AbjectMessage) => {
      const { rect, zIndex, inputPassthrough, inputMonitor, transparent, closable } = msg.payload as {
        rect: { x: number; y: number; width: number; height: number };
        zIndex?: number;
        inputPassthrough?: boolean;
        inputMonitor?: boolean;
        transparent?: boolean;
        closable?: boolean;
      };
      return this.handleCreateSurface(msg.routing.from, rect, zIndex, inputPassthrough, inputMonitor, transparent, closable);
    });

    this.on('destroySurface', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.handleDestroySurface(msg.routing.from, surfaceId);
    });

    this.on('draw', async (msg: AbjectMessage) => {
      const { commands } = msg.payload as {
        commands: Array<{ type: string; surfaceId: string; params: unknown }>;
      };
      return this.handleDraw(msg.routing.from, commands);
    });

    // ── Scene vocabulary: retained 3D nodes riding a window's slab, or
    // attached to the WORLD (the global scene graph beyond windows) ──
    this.on('scene', async (msg: AbjectMessage) => {
      const { surfaceId, world, ops, contributorId } = msg.payload as {
        surfaceId?: string; world?: boolean; ops: SceneOp[]; contributorId?: AbjectId;
      };
      if (world) {
        return this.handleWorldSceneOps(msg.routing.from, ops);
      }
      // contributorId is trusted only because the direct caller must own the
      // surface (windows relay decoration batches from other abjects).
      return this.handleSceneOps(msg.routing.from, surfaceId, ops, contributorId);
    });

    this.on('setSceneTheme', async (msg: AbjectMessage) => {
      const { theme } = msg.payload as { theme: SceneTheme };
      if (!theme || typeof theme !== 'object' || !theme.colors) return false;
      this.sceneTheme = theme;
      this.sendToFrontend({ type: 'setSceneTheme', theme: theme as unknown as Record<string, unknown> });
      return true;
    });

    this.on('setSurfaceTransform', async (msg: AbjectMessage) => {
      const { surfaceId, rotation, z } = msg.payload as {
        surfaceId: string; rotation?: [number, number, number]; z?: number;
      };
      const state = this.surfaces.get(surfaceId);
      if (!state) return false;
      contractRequire(state.objectId === msg.routing.from, 'setSurfaceTransform: caller does not own the surface');
      state.slabTransform = { rotation, z };
      this.sendToFrontend({ type: 'setSurfaceTransform', surfaceId, rotation, z });
      return true;
    });

    this.on('moveSurface', async (msg: AbjectMessage) => {
      const { surfaceId, x, y } = msg.payload as {
        surfaceId: string;
        x: number;
        y: number;
      };
      return this.handleMoveSurface(msg.routing.from, surfaceId, x, y);
    });

    this.on('resizeSurface', async (msg: AbjectMessage) => {
      const { surfaceId, width, height } = msg.payload as {
        surfaceId: string;
        width: number;
        height: number;
      };
      return this.handleResizeSurface(msg.routing.from, surfaceId, width, height);
    });

    this.on('setZIndex', async (msg: AbjectMessage) => {
      const { surfaceId, zIndex } = msg.payload as {
        surfaceId: string;
        zIndex: number;
      };
      return this.handleSetZIndex(msg.routing.from, surfaceId, zIndex);
    });

    this.on('focus', async (msg: AbjectMessage) => {
      const { surfaceId, glowColor, glowRadius } = msg.payload as { surfaceId: string; glowColor?: string; glowRadius?: number };
      return this.handleFocus(msg.routing.from, surfaceId, glowColor, glowRadius);
    });

    this.on('getDisplayInfo', async () => {
      return this.handleGetDisplayInfo();
    });

    this.on('measureText', async (msg: AbjectMessage) => {
      const { surfaceId, text, font } = msg.payload as {
        surfaceId: string;
        text: string;
        font?: string;
      };
      return this.handleMeasureText(surfaceId, text, font ?? WIDGET_FONT);
    });

    this.on('setSurfaceTitle', async (msg: AbjectMessage) => {
      const { surfaceId, title } = msg.payload as { surfaceId: string; title: string };
      const state = this.surfaces.get(surfaceId);
      if (state) state.title = title;
      this.sendToFrontend({ type: 'setSurfaceTitle', surfaceId, title });
      return true;
    });

    this.on('showMobileKeyboard', async (msg: AbjectMessage) => {
      const { show } = msg.payload as { show: boolean };
      this.sendToFrontend({ type: 'showMobileKeyboard', show });
      return true;
    });

    // An object (e.g. a Chat window) asks the client to open a native file
    // picker for one of its surfaces. The chosen file comes back as fileUpload
    // chunks and is delivered to the surface owner as a 'fileUploaded' event.
    this.on('openFilePicker', async (msg: AbjectMessage) => {
      const { surfaceId, accept, multiple } = msg.payload as { surfaceId: string; accept?: string; multiple?: boolean };
      this.sendToFrontend({ type: 'openFilePicker', surfaceId, accept, multiple });
      return true;
    });

    this.on('setSurfaceVisible', async (msg: AbjectMessage) => {
      const { surfaceId, visible } = msg.payload as { surfaceId: string; visible: boolean };
      this.sendToFrontend({ type: 'setSurfaceVisible', surfaceId, visible });
      return true;
    });

    this.on('setSurfaceWorkspace', async (msg: AbjectMessage) => {
      const { surfaceId, workspaceId } = msg.payload as { surfaceId: string; workspaceId: string };
      const state = this.surfaces.get(surfaceId);
      if (state) {
        state.workspaceId = workspaceId;
      }
      this.sendToFrontend({ type: 'setSurfaceWorkspace', surfaceId, workspaceId });
      return true;
    });

    this.on('setActiveWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      this.activeWorkspaceId = workspaceId;
      this.sendToFrontend({ type: 'setActiveWorkspace', workspaceId });
      return true;
    });

    this.on('clipboardWrite', async (msg: AbjectMessage) => {
      const { text } = msg.payload as { text: string };
      this.sendToFrontend({ type: 'clipboardWrite', text });
      return true;
    });

    this.on('clipboardWriteImage', async (msg: AbjectMessage) => {
      const { image } = msg.payload as { image: string };
      this.sendToFrontend({ type: 'clipboardWriteImage', image });
      return true;
    });

    this.on('selectionChanged', async (msg: AbjectMessage) => {
      const { selectedText } = msg.payload as { selectedText: string };
      this.currentSelectedText = selectedText;
      this.sendToFrontend({ type: 'setSelectedText', text: selectedText });
    });

    // ── Audio playback relay (AudioOutput capability → frontend) ────────
    this.on('audioPlay', async (msg: AbjectMessage) => {
      const { playbackId, source, volume, loop, notifyId } = msg.payload as {
        playbackId: string; source: string; volume?: number; loop?: boolean; notifyId?: AbjectId;
      };
      contractRequire(typeof playbackId === 'string' && playbackId.length > 0, 'audioPlay requires playbackId');
      contractRequire(typeof source === 'string' && source.length > 0, 'audioPlay requires source');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; audio output unavailable');
      if (notifyId) this.audioNotify.set(playbackId, notifyId);
      this.sendToFrontend({ type: 'audioPlay', playbackId, source, volume, loop });
      return true;
    });

    this.on('audioControl', async (msg: AbjectMessage) => {
      const { action, playbackId } = msg.payload as {
        action: 'pause' | 'resume' | 'stop' | 'stopAll'; playbackId?: string;
      };
      this.sendToFrontend({ type: 'audioControl', action, playbackId });
      if (action === 'stop' && playbackId) this.audioNotify.delete(playbackId);
      if (action === 'stopAll') this.audioNotify.clear();
      return true;
    });

    this.on('audioGraph', async (msg: AbjectMessage) => {
      const { playbackId, voices, volume, loop, notifyId } = msg.payload as {
        playbackId: string; voices: AudioVoiceSpec[]; volume?: number; loop?: boolean; notifyId?: AbjectId;
      };
      contractRequire(typeof playbackId === 'string' && playbackId.length > 0, 'audioGraph requires playbackId');
      contractRequire(Array.isArray(voices) && voices.length > 0, 'audioGraph requires a non-empty voices array');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; audio output unavailable');
      if (notifyId) this.audioNotify.set(playbackId, notifyId);
      this.sendToFrontend({ type: 'audioGraph', playbackId, voices, volume, loop });
      return true;
    });

    // ── Video element relay (VideoWidget → frontend) ────────────────────
    this.on('videoSetup', async (msg: AbjectMessage) => {
      const { videoId, source, streamId, muted, loop, autoplay, notifyId } = msg.payload as {
        videoId: string; source?: string; streamId?: string;
        muted?: boolean; loop?: boolean; autoplay?: boolean; notifyId?: AbjectId;
      };
      contractRequire(typeof videoId === 'string' && videoId.length > 0, 'videoSetup requires videoId');
      contractRequire(!!source || !!streamId, 'videoSetup requires source or streamId');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; video unavailable');
      if (notifyId) this.videoNotify.set(videoId, notifyId);
      this.sendToFrontend({ type: 'videoSetup', videoId, source, streamId, muted, loop, autoplay });
      return true;
    });

    this.on('videoControl', async (msg: AbjectMessage) => {
      const { videoId, action, value } = msg.payload as {
        videoId: string; action: 'play' | 'pause' | 'seek' | 'setMuted' | 'dispose'; value?: number;
      };
      contractRequire(typeof videoId === 'string' && videoId.length > 0, 'videoControl requires videoId');
      this.sendToFrontend({ type: 'videoControl', videoId, action, value });
      if (action === 'dispose') this.videoNotify.delete(videoId);
      return true;
    });

    // ── Media capture relay (MediaStream capability → frontend) ─────────
    this.on('mediaCapture', async (msg: AbjectMessage) => {
      const { audio, video, display } = msg.payload as {
        audio?: boolean; video?: boolean; display?: boolean;
      };
      if (!this.hasReadyClient) throw new Error('No frontend client connected; media capture unavailable');
      // Long timeout: the browser shows a permission prompt the user must answer.
      const reply = await this.requestFromFrontend<{
        streamId?: string; tracks?: Array<{ id: string; kind: string; label: string }>; error?: string;
      }>({
        type: 'mediaCaptureRequest',
        requestId: this.nextRequestId(),
        audio: audio ?? true,
        video: video ?? false,
        display: display ?? false,
      }, 60000);
      if (reply.error || !reply.streamId) throw new Error(reply.error ?? 'media capture failed');
      return { streamId: reply.streamId, tracks: reply.tracks ?? [] };
    });

    this.on('mediaCaptureFrame', async (msg: AbjectMessage) => {
      const { streamId } = msg.payload as { streamId: string };
      contractRequire(typeof streamId === 'string' && streamId.length > 0, 'mediaCaptureFrame requires streamId');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; frame capture unavailable');
      const reply = await this.requestFromFrontend<{
        base64?: string; width?: number; height?: number; error?: string;
      }>({
        type: 'mediaCaptureFrameRequest',
        requestId: this.nextRequestId(),
        streamId,
      }, 15000);
      if (reply.error || !reply.base64) throw new Error(reply.error ?? 'frame capture failed');
      return { base64: reply.base64, width: reply.width ?? 0, height: reply.height ?? 0 };
    });

    this.on('mediaRecordStart', async (msg: AbjectMessage) => {
      const { recordingId, streamId, maxDurationMs, notifyId } = msg.payload as {
        recordingId: string; streamId: string; maxDurationMs?: number; notifyId?: AbjectId;
      };
      contractRequire(typeof recordingId === 'string' && recordingId.length > 0, 'mediaRecordStart requires recordingId');
      contractRequire(typeof streamId === 'string' && streamId.length > 0, 'mediaRecordStart requires streamId');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; recording unavailable');
      if (notifyId) this.recordingNotify.set(recordingId, notifyId);
      this.sendToFrontend({ type: 'mediaRecordStart', recordingId, streamId, maxDurationMs });
      return true;
    });

    this.on('mediaRecordStop', async (msg: AbjectMessage) => {
      const { recordingId } = msg.payload as { recordingId: string };
      this.sendToFrontend({ type: 'mediaRecordStop', recordingId });
      return true;
    });

    this.on('mediaStreamControl', async (msg: AbjectMessage) => {
      const { action, streamId, trackId, muted } = msg.payload as {
        action: 'stopStream' | 'muteTrack'; streamId?: string; trackId?: string; muted?: boolean;
      };
      this.sendToFrontend({ type: 'mediaStreamControl', action, streamId, trackId, muted });
      return true;
    });

    // ── Speech relay (Speech capability → frontend browser speech APIs) ──
    this.on('speechSpeak', async (msg: AbjectMessage) => {
      const { text, voice } = msg.payload as { text: string; voice?: string };
      contractRequire(typeof text === 'string' && text.length > 0, 'speechSpeak requires text');
      if (!this.hasReadyClient) throw new Error('No frontend client connected; speech unavailable');
      // The client replies when the utterance starts, so the timeout covers
      // voice loading, not the full spoken duration.
      const reply = await this.requestFromFrontend<{ spoken?: boolean; error?: string }>({
        type: 'speechSpeak',
        requestId: this.nextRequestId(),
        text,
        voice,
      }, 20000);
      if (reply.error) throw new Error(reply.error);
      return { spoken: reply.spoken === true };
    });

    this.on('speechRecognize', async (msg: AbjectMessage) => {
      const { maxDurationMs } = msg.payload as { maxDurationMs?: number };
      if (!this.hasReadyClient) throw new Error('No frontend client connected; speech recognition unavailable');
      const windowMs = Math.min(Math.max(maxDurationMs ?? 10000, 1000), 60000);
      const reply = await this.requestFromFrontend<{
        text?: string; audioBase64?: string; mimeType?: string; error?: string;
      }>({
        type: 'speechRecognizeRequest',
        requestId: this.nextRequestId(),
        maxDurationMs: windowMs,
      }, windowMs + 30000);
      if (reply.error) throw new Error(reply.error);
      return { text: reply.text, audioBase64: reply.audioBase64, mimeType: reply.mimeType };
    });

    this.on('speechVoices', async () => {
      if (!this.hasReadyClient) throw new Error('No frontend client connected; speech unavailable');
      const reply = await this.requestFromFrontend<{ voices?: string[] }>({
        type: 'speechVoicesRequest',
        requestId: this.nextRequestId(),
      }, 10000);
      return reply.voices ?? [];
    });

    this.on('openUrl', async (msg: AbjectMessage) => {
      const { url } = msg.payload as { url: string };
      this.sendToFrontend({ type: 'openUrl', url });
    });

    this.on('registerWindowManager', async (msg: AbjectMessage) => {
      this.windowManagerId = msg.routing.from;
      return true;
    });

    this.on('markSurfaceResizable', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      this.sendToFrontend({ type: 'setSurfaceResizable', surfaceId, resizable: true });
    });

    this.on('unmarkSurfaceResizable', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      this.sendToFrontend({ type: 'setSurfaceResizable', surfaceId, resizable: false });
    });

    // Two-phase drag: WindowAbject sends requestDrag when a chromeless+draggable
    // window's empty area is clicked. We tell WindowManager to start the drag
    // and the client to handle the move locally (zero latency).
    this.on('requestDrag', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      if (!this.windowManagerId || !surfaceId) return;
      const state = this.surfaces.get(surfaceId);
      if (!state) return;
      this.send(event(this.id, this.windowManagerId,
        'startDrag', {
          surfaceId,
          globalX: this.lastMouseX,
          globalY: this.lastMouseY,
        }));
      // Tell only the client that sent the mousedown to handle the drag locally
      if (this.lastInputClientId) {
        this.sendToClient({
          type: 'startWindowDrag',
          surfaceId,
          dragType: 'move',
        }, this.lastInputClientId);
      }
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.destroySurfacesForObject(objectId);
      this.destroyWorldSceneForObject(objectId);
      this.destroyDecorationsForObject(objectId);
    });

    this.on('updateAuth', async (msg: AbjectMessage) => {
      const { enabled, username, password } = msg.payload as {
        enabled: boolean;
        username: string;
        password: string;
      };
      if (!this.authConfig || !this.sessionStore) return false;

      const changed = this.authConfig.enabled !== enabled
        || this.authConfig.username !== username
        || this.authConfig.password !== password;

      this.authConfig.enabled = enabled;
      this.authConfig.username = username;
      this.authConfig.password = password;

      if (changed) {
        this.sessionStore.clearAll();
        this.disconnectFrontend();
        log.info(`Auth config updated (enabled=${enabled}), sessions cleared, frontend disconnected`);
      }
      return true;
    });

    this.on('injectInput', async (msg: AbjectMessage) => {
      const { surfaceId, type, x, y, button, key, code, modifiers } = msg.payload as {
        surfaceId: string;
        type: InputEvent['type'];
        x?: number;
        y?: number;
        button?: number;
        key?: string;
        code?: string;
        modifiers?: InputEvent['modifiers'];
      };
      const state = this.surfaces.get(surfaceId);
      if (!state) return false;
      await this.sendInputEvent(state.objectId, {
        type,
        surfaceId,
        x,
        y,
        button,
        key,
        code,
        modifiers,
      });
      return true;
    });

    this.on('click', async (msg: AbjectMessage) => {
      const { surfaceId, x, y, button } = msg.payload as {
        surfaceId: string; x: number; y: number; button?: number;
      };
      const state = this.surfaces.get(surfaceId);
      if (!state) return false;
      const btn = button ?? 0;
      await this.sendInputEvent(state.objectId, { type: 'mousedown', surfaceId, x, y, button: btn });
      await this.sendInputEvent(state.objectId, { type: 'mouseup', surfaceId, x, y, button: btn });
      return true;
    });

    this.on('type', async (msg: AbjectMessage) => {
      const { surfaceId, text } = msg.payload as { surfaceId: string; text: string };
      const state = this.surfaces.get(surfaceId);
      if (!state) return false;
      for (const char of text) {
        await this.sendInputEvent(state.objectId, {
          type: 'keydown', surfaceId, key: char, code: `Key${char.toUpperCase()}`,
        });
        await this.sendInputEvent(state.objectId, {
          type: 'keyup', surfaceId, key: char, code: `Key${char.toUpperCase()}`,
        });
      }
      return true;
    });

    this.on('keyPress', async (msg: AbjectMessage) => {
      const { surfaceId, key, code, modifiers } = msg.payload as {
        surfaceId: string; key: string; code?: string;
        modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
      };
      const state = this.surfaces.get(surfaceId);
      if (!state) return false;
      await this.sendInputEvent(state.objectId, {
        type: 'keydown', surfaceId, key, code: code ?? key, modifiers,
      });
      await this.sendInputEvent(state.objectId, {
        type: 'keyup', surfaceId, key, code: code ?? key, modifiers,
      });
      return true;
    });

    this.on('captureScreenshot', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.handleCaptureScreenshot(objectId);
    });

    this.on('captureDesktop', async () => {
      return this.handleCaptureDesktop();
    });

    this.on('listWindows', async () => {
      return this.handleListWindows();
    });

    this.on('listFrontendClients', async () => {
      return Array.from(this.clients.values()).map((c) => ({
        clientId: c.id,
        kind: c.kind,
        peerId: c.peerId ?? '',
        name: c.name ?? '',
        connectedAt: c.connectedAt,
        ready: c.ready && c.transport.ready,
      }));
    });

    this.on('disconnectFrontendClient', async (msg: AbjectMessage) => {
      const { clientId } = msg.payload as { clientId: string };
      const conn = this.clients.get(clientId);
      if (!conn) return false;
      try {
        conn.transport.close(1000, 'disconnected by operator');
      } catch (err) {
        log.warn(`disconnectFrontendClient close threw: ${err}`);
      }
      // onClose handler will delete from this.clients and emit the event.
      return true;
    });
  }

  protected override async onInit(): Promise<void> {
    this.consoleId = await this.discoverDep('Console') ?? undefined;

    const registryId = await this.discoverDep('Registry') ?? undefined;
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }

    this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
  }

  // CommandPalette and WindowSwitcher are per-workspace, so we resolve the
  // target instance lazily via the active workspace's registry on every
  // shortcut press. Caching by workspace id avoids repeated discovery.
  private workspaceManagerId?: AbjectId;
  private paletteByWorkspace: Map<string, AbjectId> = new Map();
  private switcherByWorkspace: Map<string, AbjectId> = new Map();

  // Cursor-hint state. lastCursor is what the frontend currently shows; we
  // suppress redundant setCursor messages when the hint hasn't changed.
  private lastCursor = 'default';
  private lastCursorRequestAt = 0;
  private cursorRequestInFlight = false;
  private static readonly CURSOR_THROTTLE_MS = 33;

  private maybeUpdateCursor(surfaceId: string | undefined, localX: number, localY: number): void {
    if (!this.windowManagerId) return;
    if (this.cursorRequestInFlight) return;
    const now = Date.now();
    if (now - this.lastCursorRequestAt < BackendUI.CURSOR_THROTTLE_MS) return;
    this.lastCursorRequestAt = now;

    if (!surfaceId) {
      // Mouse is over the desktop backdrop — clear any sticky hint.
      this.applyCursor('default');
      return;
    }

    this.cursorRequestInFlight = true;
    this.request<string>(
      request(this.id, this.windowManagerId, 'getCursorAt', { surfaceId, localX, localY }),
    )
      .then((cursor) => { this.applyCursor(cursor || 'default'); })
      .catch(() => { /* swallow — bad cursor hint is not worth a log */ })
      .finally(() => { this.cursorRequestInFlight = false; });
  }

  private applyCursor(cursor: string): void {
    if (cursor === this.lastCursor) return;
    this.lastCursor = cursor;
    this.sendToFrontend({ type: 'setCursor', cursor });
  }

  private async dispatchGlobalShortcut(combo: string): Promise<void> {
    const targetName =
      combo === 'commandPalette' ? 'CommandPalette' :
      combo === 'windowSwitcher' ? 'WindowSwitcher' :
      undefined;
    if (!targetName) return;

    const target = await this.resolveActiveWorkspaceObject(targetName, combo);
    if (target) {
      this.send(event(this.id, target, 'toggle', {}));
    }
  }

  /**
   * Resolve a per-workspace Abject by name in the *active* workspace.
   *
   * 1. Ask WorkspaceManager for the active workspace and its registry.
   * 2. Discover the target by name in that registry — WorkspaceRegistry
   *    serves local hits first, so we get the workspace's own instance.
   * 3. Cache by workspace id so a held-down shortcut doesn't refetch.
   */
  private async resolveActiveWorkspaceObject(name: string, combo: string): Promise<AbjectId | undefined> {
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.discoverDep('WorkspaceManager') ?? undefined;
      if (!this.workspaceManagerId) return undefined;
    }

    let active: { id?: string; registryId?: AbjectId } | null = null;
    try {
      active = await this.request<{ id?: string; registryId?: AbjectId } | null>(
        request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {}),
      );
    } catch { return undefined; }
    if (!active?.id || !active?.registryId) return undefined;

    const cache = combo === 'commandPalette' ? this.paletteByWorkspace : this.switcherByWorkspace;
    const cached = cache.get(active.id);
    if (cached) return cached;

    try {
      const found = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, active.registryId, 'discover', { name }),
      );
      const targetId = found?.[0]?.id;
      if (targetId) {
        cache.set(active.id, targetId);
        return targetId;
      }
    } catch { /* fall through */ }

    return undefined;
  }

  private async log(level: string, message: string, data?: unknown): Promise<void> {
    if (!this.consoleId) return;
    try {
      this.send(
        request(this.id, this.consoleId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## UIServer Usage Guide

### Creating and Using Surfaces

Create a surface:
  const surfaceId = await this.call(this.dep('UIServer'), 'createSurface',
    { rect: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 100 });

Destroy a surface:
  await this.call(this.dep('UIServer'), 'destroySurface', { surfaceId });

### Drawing

Each draw command has exactly 3 fields: { type, surfaceId, params }

  await this.call(this.dep('UIServer'), 'draw', {
    commands: [
      { type: 'clear', surfaceId, params: { color: '#1e1e2e' } },
      { type: 'rect', surfaceId, params: { x: 10, y: 10, width: 80, height: 30, fill: '#4a4a6e', radius: 4 } },
      { type: 'text', surfaceId, params: { x: 150, y: 100, text: 'Hello', font: '24px system-ui', fill: '#ffffff', align: 'center' } },
    ]
  });

### Draw Command Types

'clear' - Clear surface. params: {} or { color: '#rrggbb' }
'rect'  - Rectangle. params: { x, y, width, height, fill?, stroke?, lineWidth?, radius? }
'text'  - Text. params: { x, y, text, font?, fill?, stroke?, align?, baseline? }
'line'  - Line. params: { x1, y1, x2, y2, stroke?, lineWidth? }
'path'  - SVG path. params: { path, fill?, stroke?, lineWidth? }
'circle' - Circle. params: { cx, cy, radius, fill?, stroke?, lineWidth? }
'arc'   - Arc. params: { cx, cy, radius, startAngle, endAngle, fill?, stroke?, counterclockwise? }
'ellipse' - Ellipse. params: { cx, cy, radiusX, radiusY, rotation?, fill?, stroke? }
'polygon' - Polygon. params: { points: [{x,y}...], fill?, stroke?, closePath? }
'imageUrl' - Draw image from URL or data URI. params: { x, y, width?, height?, url }
          Use with HttpClient.getBase64() to display fetched images.

### Displaying Images

  // 1. Fetch image as base64 data URI
  const img = await this.call(this.dep('HttpClient'), 'getBase64', { url: 'https://example.com/photo.jpg' });
  // 2. Draw on surface
  await this.call(this.dep('UIServer'), 'draw', {
    commands: [{ type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 300, height: 200, url: img.dataUri } }]
  });

### State management
'save'/'restore' - Save/restore canvas state
'clip' - Set clipping region. params: { x, y, width, height }
'translate'/'rotate'/'scale' - Transform canvas
'globalAlpha' - Set transparency. params: { alpha }
'shadow' - Set shadow. params: { color, blur, offsetX?, offsetY? }
'linearGradient'/'radialGradient' - Set gradient fill+stroke

### 3D Scene (retained)

THE DESKTOP IS A NATIVE 3D SCENE (WebGL2-backed) — no Three.js needed; 3D is
built in. Your surface is a slab in that scene. For anything 3D (spinning
shapes, lit geometry, depth), attach retained scene nodes — GPU-rendered and
animated by updating transforms, which beats simulating 3D with projection
math on a 2D canvas. Nodes travel with the surface (you must own the surface
— for WidgetManager windows, call 'scene' on the WINDOW instead; windows
accept scene ops from ANY abject, so you can decorate windows you don't own,
discovered via WidgetManager listWindows — decoration input routes back to
the contributor and decorations tear down when the contributor dies):

  await this.call(this.dep('UIServer'), 'scene', { surfaceId, ops: [
    { op: 'add', id: 'orb', kind: 'mesh',
      transform: { position: [0, 0, 40], scale: 30 },   // px from slab center, +z toward viewer
      params: { primitive: 'sphere', color: '$accent' } },
    { op: 'add', id: 'key', kind: 'light',
      transform: { position: [120, -200, 300] },
      params: { lightType: 'point', color: '#ffffff' } },
  ]});

Kinds: mesh (primitive: plane|box|sphere|cylinder; params color, emissive?,
opacity?), light (lightType: point|directional; color?, direction?), group.
transform: { position: [x,y,z], rotation: [rx,ry,rz] radians, scale: n|[x,y,z] }.
CUSTOM / DEFORMABLE MESHES — when no built-in primitive fits (a wave surface,
terrain, a generated or morphing shape), give the mesh node its own polygons
instead of a primitive: params { geometry: { positions: [x,y,z, ...], indices?:
[...], normals?: [...] }, color, ... }. positions is a flat local-px vertex
list; indices a flat triangle list (omit for a sequential triangle soup);
normals auto-compute smooth when omitted. Re-send geometry in an 'update' op to
DEFORM the mesh — GPU buffers are reused, so animating a heightfield every frame
is cheap. This is how you render a continuous changing surface rather than a
grid of discrete primitive tiles:
  await this.call(this.dep('UIServer'), 'scene', { surfaceId, ops: [
    { op: 'update', id: 'water', params: { geometry: { positions: nextPositions } } } ]});
Custom geometry also takes geometry.colors (flat [r,g,b,...] 0..1 per vertex —
gradients/heatmaps) and geometry.uvs (flat [u,v,...]) for texturing.

PRIMITIVES: plane, box, sphere, cylinder, cone, torus, icosphere.
MATERIALS: params.metalness/roughness (0..1) give a PBR look (glass, metal,
glossy water); params.emissive glows; params.texture is a url/data-URI or
'surface:<surfaceId>' (wrap a window's live 2D content onto geometry);
params.billboard faces the camera; params.drawMode 'points'|'lines' draws the
vertices as a cloud/polyline (params.pointSize). INSTANCING: params.instances =
[{ position, scale?, rotation?, color? }, ...] draws one geometry many times in
a single call (starfields, particles, swarms, grids). LIGHTS: lightType
'point'|'directional'|'spot' with color, intensity, range, (spot) angle +
penumbra, and (directional) castShadow:true — meshes cast shadows on each other,
frustum auto-fit to the scene. ENVIRONMENT: a kind:'environment' node { ambient, fog:{ color, near,
far }, bloom:true|{ threshold, intensity } } sets scene-wide mood/depth and a
glow post-effect on bright/emissive meshes.

ANIMATION — declarative and client-side, so one op animates at the native
frame rate instead of a transform message per tick:
  await this.call(this.dep('UIServer'), 'scene', { surfaceId, ops: [
    { op: 'animate', id: 'orb', params: { preset: 'spin', duration: 4000 } } ]});
Presets: spin, orbit (center/radius/plane), bob (amplitude), pulse (scale). Or
a channel: { op:'animate', id, params:{ channel:'position'|'rotation'|'scale'|
'color'|'emissive'|'opacity', to, from?, duration, easing?, loop?, yoyo?,
delay?, path?:[[x,y,z],...] } }. Stop with params:{ stop:true }. Animations are
transient client state — re-issue them after a reconnect if you want them back.

OCCLUSION (window scope): a window's 3D children are clipped to the window's
content area and sit below the title bar by default — they can't spill across
the desktop or cover the chrome. Set params.occlude:false to let a node draw on
top / extend past the window (pop-out 3D, decorations over the chrome). Occluded
3D draws on top of the window's own 2D background, so an immersive all-3D window
should BE its 3D content, not hide it behind a full-window opaque backdrop mesh.

INHERITANCE: a child inherits its parent group's material/behaviour params —
color, emissive, opacity, metalness, roughness, texture, drawMode, pointSize,
layer, occlude, castShadow — unless it overrides them. primitive/geometry/
instances are per-node. Transforms already compose down the parent chain.

FOG IS SCENE-RELATIVE: fog.near/far are depth in px BEHIND the content plane
(the camera-to-content baseline is added automatically), so use SMALL values —
e.g. near 0, far 400 for a tank ~300px deep. far should roughly match your
scene's depth; do NOT pass camera-distance values (far 2000+) — fog would never
show. light range is world-space px (distance from the light to the surface).
COORDINATES ARE Y-DOWN, the screen convention: +y moves DOWN, +x right, +z
toward the viewer (this differs from y-up 3D engines). Mouse dx/dy therefore
map DIRECTLY onto position dx/dy — apply both with the same sign, no flips.
The camera is a long lens (the desktop UI must stay undistorted), so small
objects read near-isometric. For visible perspective, go BIG: scale 200+ and
vary z across the scene — depth shows when it's a meaningful fraction of the
camera distance (~1.9x viewport height).
Colors accept '#hex', 'rgb(a)', or theme tokens ('$accent', '$statusError',
'$windowBg', ...) that re-resolve on every theme change. Nodes are RETAINED
until { op: 'remove', id }; invalid batches are rejected with the vocabulary.
Tilt/float the whole slab: this.call(this.dep('UIServer'), 'setSurfaceTransform',
{ surfaceId, rotation: [0, 0.1, 0], z: 20 }).

WORLD SCOPE — the global scene graph beyond windows. Pass world: true and
positions become workspace px ([x, y, z], +z toward viewer); no window or
surface needed. Use for desktop pets, ambient décor, free-floating geometry.
params.layer: 'back' (default — renders behind all windows) or 'front'
(above them). Nodes are namespaced to YOUR abject, retained across
reconnects, and torn down automatically if your abject dies. A pet that
walks: add a group of meshes once, then update the group's position/rotation
from a Timer tick:

  await this.call(this.dep('UIServer'), 'scene', { world: true, ops: [
    { op: 'add', id: 'pet', kind: 'group', transform: { position: [400, 600, 30] } },
    { op: 'add', id: 'body', parentId: 'pet', kind: 'mesh',
      transform: { scale: [60, 40, 40] }, params: { primitive: 'sphere', color: '$accent' } },
    { op: 'add', id: 'head', parentId: 'pet', kind: 'mesh',
      transform: { position: [40, -20, 0], scale: 28 }, params: { primitive: 'sphere', color: '$accent' } },
  ]});
  // each tick:
  await this.call(this.dep('UIServer'), 'scene', { world: true, ops: [
    { op: 'update', id: 'pet', transform: { position: [x, y, 30], rotation: [0, heading, wobble] } },
  ]});

MESH INPUT — scene nodes are full input targets, like widgets. You receive
'nodeInput' events for meshes you own:
  this.on('nodeInput', (msg) => {
    const { type, nodeId, x, y, key, code, button, world } = msg.payload;
    // type: 'mousedown' | 'mouseup' | 'mousemove' | 'mouseenter' | 'mouseleave'
    //     | 'focus' | 'blur' | 'keydown' | 'keyup'
  });
- Hover: mouseenter/mouseleave fire on hover changes; mousemove streams while
  the pointer is over the mesh (~60fps, rAF-batched).
- Drag capture: after mousedown on a mesh, mousemove keeps streaming to that
  mesh until mouseup, even when the cursor outruns it. To drag a node, apply
  the input deltas directly — both axes share the screen convention (y-down),
  so position = [startX + dx, startY + dy, z] with NO sign flips.
- Selection + keyboard: clicking a mesh SELECTS it ('focus' event); while
  selected, keydown/keyup events route to you (key, code, modifiers). Focus
  moves away ('blur') when the user clicks anything else. React to focus by
  e.g. boosting the node's emissive via a scene update.
World-scope hits deliver straight to you (x,y in workspace px). Window-scope
hits deliver to the WINDOW's owner with windowId in the payload (x,y relative
to the window). Picking is exact 3D ray casting, so it works on rotated and
animated meshes — click the pet mid-walk.

### Input Injection

Simulate a mouse click on a surface (mousedown + mouseup):
  await this.call(this.dep('UIServer'), 'click',
    { surfaceId, x: 150, y: 30 });
  // button: 0=left (default), 1=middle, 2=right

Type a string of text (keydown/keyup per character):
  await this.call(this.dep('UIServer'), 'type',
    { surfaceId, text: 'hello world' });

Press a single key:
  await this.call(this.dep('UIServer'), 'keyPress',
    { surfaceId, key: 'Enter' });

  // With modifiers:
  await this.call(this.dep('UIServer'), 'keyPress',
    { surfaceId, key: 'a', code: 'KeyA',
      modifiers: { ctrl: true, shift: false, alt: false, meta: false } });

Low-level input injection (single event):
  await this.call(this.dep('UIServer'), 'injectInput',
    { surfaceId, type: 'mousedown', x: 100, y: 50, button: 0 });

### Screenshots

Capture a screenshot of an object's window (returns base64 PNG):
  const img = await this.call(this.dep('UIServer'), 'captureScreenshot',
    { objectId: targetObjectId });
  // img = { imageBase64: '...', width: 800, height: 600 } or null

Capture the entire desktop:
  const desktop = await this.call(this.dep('UIServer'), 'captureDesktop', {});

List all visible windows:
  const windows = await this.call(this.dep('UIServer'), 'listWindows', {});
  // [{ objectId, title, surfaceId, rect: { x, y, width, height } }, ...]

IMPORTANT:
- Use 'fill' for fill color, NOT 'color'
- Use 'rect' NOT 'fillRect', 'text' NOT 'fillText'
- Always nest parameters inside 'params'
- Transparent pixels do NOT receive mouse input -- use opaque backgrounds
- Click/type/keyPress coordinates are relative to the surface (0,0 = top-left of the window)
- Use listWindows to discover surfaceIds for input injection targets`;
  }

  // ── Auth gate ───────────────────────────────────────────────────────

  /**
   * Store references to the shared AuthConfig and SessionStore so
   * the `updateAuth` handler can mutate them at runtime.
   */
  setAuthGate(config: AuthConfig, sessions: SessionStore): void {
    this.authConfig = config;
    this.sessionStore = sessions;
  }

  /**
   * Force-disconnect all frontend WebSockets.
   * Frontends will reconnect automatically and go through the auth gate.
   */
  disconnectFrontend(): void {
    for (const client of this.clients.values()) {
      client.transport.close(4001, 'Auth config changed');
    }
  }

  // ── WebSocket management ────────────────────────────────────────────

  private nextClientId(): string {
    return `client-${++this.clientCounter}`;
  }

  /** Whether any client is connected and ready. */
  private get hasReadyClient(): boolean {
    for (const client of this.clients.values()) {
      if (client.ready) return true;
    }
    return false;
  }

  /** Return the first ready client, or undefined. */
  private get firstReadyClient(): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (client.ready) return client;
    }
    return undefined;
  }

  /**
   * Add a WebSocket connection as a new client (convenience wrapper).
   */
  addWebSocket(ws: WebSocket): string {
    return this.addTransport(new WebSocketUITransport(ws), { kind: 'websocket' });
  }

  /**
   * Add a transport as a new client. Multiple clients can be connected
   * simultaneously; all receive broadcasts.
   */
  addTransport(newTransport: UITransport, meta?: ClientMeta): string {
    const clientId = this.nextClientId();
    const kind = meta?.kind ?? 'websocket';
    const conn: ClientConnection = {
      id: clientId,
      transport: newTransport,
      ready: false,
      sendQueue: [],
      flushScheduled: false,
      kind,
      peerId: meta?.peerId,
      name: meta?.name,
      connectedAt: Date.now(),
      enc: new WireEncoder(),
      dec: new WireDecoder(),
      deflate: kind === 'websocket',
      framesSent: 0,
      framesAcked: 0,
      queuedDrawIndex: new Map(),
      lastSurfaceTouch: new Map(),
      queuedSceneUpdateIndex: new Map(),
      coalescedDrops: 0,
      lastCoalesceLog: 0,
      sentBlobs: new Set(),
    };
    this.clients.set(clientId, conn);
    log.info(`Client ${clientId} connected (${this.clients.size} total)`);
    this.emitFrontendClientsChanged();

    newTransport.onMessage((data: string | Uint8Array) => {
      try {
        const msg = (typeof data === 'string'
          ? JSON.parse(data)
          : isWireFrame(data)
            ? conn.dec.decodeFrame(data)
            : JSON.parse(new TextDecoder().decode(data))) as FrontendToBackendMsg;
        this.handleFrontendMessage(msg, clientId);
      } catch (err) {
        log.error('Failed to decode frontend message:', err);
      }
    });
    newTransport.onClose(() => {
      this.clients.delete(clientId);
      this.hoverSurfaceByClient.delete(clientId);
      log.info(`Client ${clientId} disconnected (${this.clients.size} remaining)`);
      // Release resize grab if this client owned it
      if (this.mouseGrabClientId === clientId) {
        this.mouseGrabAbject = undefined;
        this.mouseGrabClientId = undefined;
      }
      // Reject pending requests that can no longer be answered if no clients remain
      if (this.clients.size === 0) {
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('All frontends disconnected'));
        }
        this.pendingRequests.clear();
      }
      this.emitFrontendClientsChanged();
    });

    return clientId;
  }

  /**
   * Backward-compatible aliases. setTransport disconnects all existing
   * clients first (old single-transport behavior).
   */
  setWebSocket(ws: WebSocket): void {
    this.addWebSocket(ws);
  }

  setTransport(newTransport: UITransport, meta?: ClientMeta): void {
    this.addTransport(newTransport, meta);
  }

  private emitFrontendClientsChanged(): void {
    this.changed('frontendClientsChanged', { count: this.clients.size });
  }

  /**
   * Broadcast a message to all ready clients (batched).
   * Messages are queued per-client and flushed via setTimeout(0).
   */
  private sendToFrontend(msg: BackendToFrontendMsg): void {
    for (const client of this.clients.values()) {
      if (!client.ready || !client.transport.ready) continue;
      this.enqueueForClient(client, msg);
    }
  }

  /**
   * Send a message to one specific client (batched).
   */
  private sendToClient(msg: BackendToFrontendMsg, clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client || !client.ready || !client.transport.ready) return;
    this.enqueueForClient(client, msg);
  }

  /**
   * Broadcast a message to all ready clients except one (batched).
   * Used when one client already has the state (e.g. local drag).
   */
  private sendToFrontendExcept(msg: BackendToFrontendMsg, excludeClientId: string): void {
    for (const client of this.clients.values()) {
      if (client.id === excludeClientId) continue;
      if (!client.ready || !client.transport.ready) continue;
      this.enqueueForClient(client, msg);
    }
  }

  /**
   * Queue a message for a client with stale-state coalescing, and schedule a
   * flush unless the client is over its unacked-frames budget (in that case
   * the ack handler resumes flushing).
   *
   * Coalescing rules — all order-preserving, applied only to messages that
   * fully supersede an older queued one:
   *   - a single-surface 'draw' (a full repaint of that surface) replaces the
   *     previously queued single-surface draw for the same surface, provided
   *     no later queued message touches that surface;
   *   - 'setCursor' replaces a previously queued setCursor.
   * Everything else appends. This keeps a slow client's queue bounded by
   * state size rather than by frame rate.
   */
  private enqueueForClient(client: ClientConnection, msg: BackendToFrontendMsg): void {
    const queue = client.sendQueue;

    if (msg.type === 'draw') {
      const surfaces = new Set(msg.commands.map((c) => c.surfaceId));
      if (surfaces.size === 1) {
        const sid: string = msg.commands[0].surfaceId;
        const drawIdx = client.queuedDrawIndex.get(sid);
        if (drawIdx !== undefined && client.lastSurfaceTouch.get(sid) === drawIdx) {
          queue[drawIdx] = msg;
          client.coalescedDrops++;
          this.maybeScheduleFlush(client);
          return;
        }
        queue.push(msg);
        client.queuedDrawIndex.set(sid, queue.length - 1);
        client.lastSurfaceTouch.set(sid, queue.length - 1);
      } else {
        queue.push(msg);
        for (const sid of surfaces) {
          client.queuedDrawIndex.delete(sid);
          client.lastSurfaceTouch.set(sid, queue.length - 1);
        }
      }
    } else if (msg.type === 'setCursor') {
      if (client.queuedCursorIndex !== undefined) {
        queue[client.queuedCursorIndex] = msg;
        client.coalescedDrops++;
        this.maybeScheduleFlush(client);
        return;
      }
      queue.push(msg);
      client.queuedCursorIndex = queue.length - 1;
    } else if (msg.type === 'sceneOps') {
      // An update-only batch (pure transform/param animation frames) merges
      // into the previously queued update-only batch for the same scene,
      // per node id — the same last-wins merge the retained state applies.
      // Structural batches (add/remove/animate) append and become a barrier.
      // This is what keeps a 30-60fps scene animation bounded by node count
      // instead of frame rate when a client is slow or backgrounded.
      const sceneMsg = msg as { surfaceId: string; world?: boolean; ownerId?: string; ops: Array<Record<string, unknown>> };
      const key = sceneMsg.world ? `#world:${sceneMsg.ownerId ?? ''}` : sceneMsg.surfaceId;
      const updateOnly = sceneMsg.ops.every((o) => o.op === 'update');
      if (updateOnly) {
        const idx = client.queuedSceneUpdateIndex.get(key);
        if (idx !== undefined && client.lastSurfaceTouch.get(key) === idx) {
          const prev = queue[idx] as { ops: Array<Record<string, unknown>> };
          queue[idx] = { ...sceneMsg, ops: mergeSceneUpdateOps(prev.ops, sceneMsg.ops) } as BackendToFrontendMsg;
          client.coalescedDrops++;
          this.maybeScheduleFlush(client);
          return;
        }
        queue.push(msg);
        client.queuedSceneUpdateIndex.set(key, queue.length - 1);
        client.lastSurfaceTouch.set(key, queue.length - 1);
      } else {
        queue.push(msg);
        client.queuedSceneUpdateIndex.delete(key);
        client.lastSurfaceTouch.set(key, queue.length - 1);
      }
    } else {
      queue.push(msg);
      const sid = (msg as { surfaceId?: string }).surfaceId;
      if (sid) client.lastSurfaceTouch.set(sid, queue.length - 1);
    }

    // Backstop: a queue past the cap means the client stopped consuming and
    // coalescing could not absorb the traffic. Drop the client; a reconnect
    // replays full state and costs far less than an unbounded backlog.
    if (queue.length > MAX_CLIENT_QUEUE) {
      log.error(`Client ${client.id} send queue exceeded ${MAX_CLIENT_QUEUE} messages (stalled client?); disconnecting — reconnect will replay state`);
      try { client.transport.close(1013, 'send queue overflow'); } catch { /* already gone */ }
      return;
    }

    this.maybeScheduleFlush(client);
  }



  private maybeScheduleFlush(client: ClientConnection): void {
    if (client.flushScheduled) return;
    if (client.framesSent - client.framesAcked > UNACKED_HIGH) return; // ack handler resumes
    client.flushScheduled = true;
    const cid = client.id;
    setTimeout(() => this.flushClientQueue(cid), 0);
  }

  /** frameAck from a client: record credit and resume flushing if drained. */
  private handleFrameAck(client: ClientConnection, n: number): void {
    client.framesAcked = Math.max(client.framesAcked, n);
    if (client.sendQueue.length > 0
        && !client.flushScheduled
        && client.framesSent - client.framesAcked <= UNACKED_LOW) {
      this.flushClientQueue(client.id);
    }
  }

  /**
   * Send a message to one specific client immediately (bypasses batching).
   * Used for request/reply messages where the caller awaits a response.
   */
  private sendToClientImmediate(msg: BackendToFrontendMsg, clientId: string): void {
    const client = this.clients.get(clientId);
    if (client && client.ready && client.transport.ready) {
      client.framesSent++;
      client.transport.send(client.enc.encodeFrame(msg, client.deflate));
    }
  }

  private flushClientQueue(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.flushScheduled = false;
    if (!client.transport.ready || client.sendQueue.length === 0) return;
    if (client.framesSent - client.framesAcked > UNACKED_HIGH) return; // resumed by frameAck

    const batch = client.sendQueue.length === 1 ? client.sendQueue[0] : client.sendQueue;
    client.framesSent++;
    client.transport.send(client.enc.encodeFrame(batch, client.deflate));
    client.sendQueue = [];
    client.queuedDrawIndex.clear();
    client.lastSurfaceTouch.clear();
    client.queuedSceneUpdateIndex.clear();
    client.queuedCursorIndex = undefined;

    if (client.coalescedDrops > 0 && Date.now() - client.lastCoalesceLog > 5_000) {
      log.info(`client ${client.id}: coalesced ${client.coalescedDrops} stale queued messages (flow control, ${client.framesSent - client.framesAcked} frames in flight)`);
      client.coalescedDrops = 0;
      client.lastCoalesceLog = Date.now();
    }
  }

  // ── Surface API ──────────────────────────────────────────────────────

  private handleCreateSurface(
    objectId: AbjectId,
    rect: { x: number; y: number; width: number; height: number },
    zIndex?: number,
    inputPassthrough?: boolean,
    inputMonitor?: boolean,
    transparent?: boolean,
    closable?: boolean
  ): string {
    const surfaceId = `surface-${objectId}-${this.surfaceCounter++}`;
    const z = zIndex ?? 0;

    this.surfaces.set(surfaceId, {
      surfaceId,
      objectId,
      rect: { ...rect },
      zIndex: z,
      inputPassthrough: inputPassthrough ?? false,
      inputMonitor: inputMonitor ?? false,
      transparent: transparent ?? false,
      closable: closable ?? true,
      lastDrawCommands: [],
      sceneNodes: new Map(),
      sceneContributors: new Map(),
    });

    this.sendToFrontend({
      type: 'createSurface',
      surfaceId,
      objectId,
      rect,
      zIndex: z,
      inputPassthrough: inputPassthrough ?? false,
      transparent: transparent ?? false,
      closable: closable ?? true,
    });

    this.log('debug', 'createSurface', { surfaceId, objectId, rect, zIndex });
    return surfaceId;
  }

  private handleDestroySurface(objectId: AbjectId, surfaceId: string): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.objectId !== objectId) {
      return false;
    }

    if (this.focusedNode?.surfaceId === surfaceId) this.focusedNode = undefined;
    this.releaseBlobs(this.blobHashesIn(state.lastDrawCommands));
    this.surfaces.delete(surfaceId);

    this.sendToFrontend({
      type: 'destroySurface',
      surfaceId,
    });

    this.log('debug', 'destroySurface', { surfaceId, objectId });
    return true;
  }

  /**
   * Destroy all surfaces owned by a given object (cleanup on unregister).
   */
  private destroySurfacesForObject(objectId: AbjectId): number {
    let count = 0;
    for (const [surfaceId, state] of this.surfaces.entries()) {
      if (state.objectId === objectId) {
        this.releaseBlobs(this.blobHashesIn(state.lastDrawCommands));
        this.surfaces.delete(surfaceId);
        this.sendToFrontend({ type: 'destroySurface', surfaceId });
        if (this.focusedSurface === surfaceId) this.focusedSurface = undefined;
        count++;
      }
    }
    return count;
  }

  private handleDraw(
    objectId: AbjectId,
    commands: Array<{ type: string; surfaceId: string; params: unknown }>
  ): boolean {
    // Filter commands to only include surfaces owned by the caller, then
    // intern inline data: URI images into the content-addressed blob store
    // so repaints and replays reference bytes the client already holds.
    const validCommands = commands
      .filter((cmd) => this.surfaces.get(cmd.surfaceId)?.objectId === objectId)
      .map((cmd) => this.internImageCommand(cmd));

    // Retain the new batch's blobs BEFORE releasing the replaced batch's —
    // a repaint reusing the same image must not let its refcount touch zero.
    const hashes = this.blobHashesIn(validCommands);
    this.retainBlobs(hashes);

    // Snapshot the latest draw batch per surface so reconnecting clients can
    // be replayed (handleClientReady reuses state.lastDrawCommands).
    const touched = new Set<string>();
    for (const cmd of validCommands) {
      const state = this.surfaces.get(cmd.surfaceId);
      if (!state) continue;
      if (!touched.has(cmd.surfaceId)) {
        this.releaseBlobs(this.blobHashesIn(state.lastDrawCommands));
        state.lastDrawCommands = [];
        touched.add(cmd.surfaceId);
      }
      state.lastDrawCommands.push(cmd);
    }

    if (validCommands.length > 0) {
      if (hashes.length > 0) {
        // Deliver bytes each client is missing before the draw that uses them
        // (same ordered queue, so the blob always precedes its first use).
        for (const client of this.clients.values()) {
          if (!client.ready || !client.transport.ready) continue;
          this.queueBlobsForClient(client, hashes);
        }
      }
      this.sendToFrontend({
        type: 'draw',
        commands: validCommands,
      });
    }

    this.log('debug', 'draw', { objectId, commandCount: commands.length });
    return true;
  }

  // ── Content-addressed image blobs ────────────────────────────────────

  /** hash → bytes + mime, refcounted by retained lastDrawCommands. */
  private imageBlobs: Map<string, { bytes: Uint8Array; mime: string; refs: number }> = new Map();

  /**
   * Rewrite an imageUrl command with an inline base64 data: URI to reference
   * the blob store by hash. The bytes travel once per client as an
   * ImageBlobMsg instead of riding inside every repaint.
   */
  private internImageCommand(
    cmd: { type: string; surfaceId: string; params: unknown },
  ): { type: string; surfaceId: string; params: unknown } {
    if (cmd.type !== 'imageUrl') return cmd;
    const url = (cmd.params as { url?: string } | undefined)?.url;
    if (!url || !url.startsWith('data:')) return cmd;
    const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
    if (!m) return cmd; // non-base64 data URI — leave as-is
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
    } catch {
      return cmd;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!this.imageBlobs.has(hash)) {
      this.imageBlobs.set(hash, { bytes, mime: m[1] || 'application/octet-stream', refs: 0 });
    }
    return { ...cmd, params: { ...(cmd.params as object), url: ABX_IMAGE_PREFIX + hash } };
  }

  private blobHashesIn(commands: Array<{ type: string; params: unknown }>): string[] {
    const hashes: string[] = [];
    for (const cmd of commands) {
      if (cmd.type !== 'imageUrl') continue;
      const url = (cmd.params as { url?: string } | undefined)?.url;
      if (url?.startsWith(ABX_IMAGE_PREFIX)) hashes.push(url.slice(ABX_IMAGE_PREFIX.length));
    }
    return hashes;
  }

  private retainBlobs(hashes: string[]): void {
    for (const hash of hashes) {
      const blob = this.imageBlobs.get(hash);
      if (blob) blob.refs++;
    }
  }

  private releaseBlobs(hashes: string[]): void {
    for (const hash of hashes) {
      const blob = this.imageBlobs.get(hash);
      if (!blob) continue;
      blob.refs--;
      if (blob.refs <= 0) this.imageBlobs.delete(hash);
    }
  }

  /** Queue ImageBlobMsgs for any of the hashes this client hasn't received. */
  private queueBlobsForClient(client: ClientConnection, hashes: string[]): void {
    for (const hash of hashes) {
      if (client.sentBlobs.has(hash)) continue;
      const blob = this.imageBlobs.get(hash);
      if (!blob) continue;
      client.sentBlobs.add(hash);
      this.enqueueForClient(client, { type: 'imageBlob', hash, mime: blob.mime, bytes: blob.bytes });
    }
  }

  /**
   * Apply a scene-vocabulary op batch to a surface's subtree: validate
   * loudly (callers self-correct from the error, like the canvas
   * vocabulary), compact into the retained per-surface node map for
   * reconnect replay, and broadcast.
   */
  private handleSceneOps(objectId: AbjectId, surfaceId: string | undefined, rawOps: SceneOp[], contributorId?: AbjectId): boolean {
    // Forgiving field aliases (e.g. parent → parentId) before anything else.
    const ops = normalizeSceneOps(rawOps) as SceneOp[];
    // Default to the caller's first surface so windowless callers fail loudly
    // and single-window abjects don't need to track their surfaceId.
    let state = surfaceId ? this.surfaces.get(surfaceId) : undefined;
    if (!state) {
      for (const s of this.surfaces.values()) {
        if (s.objectId === objectId) { state = s; break; }
      }
    }
    contractRequire(state !== undefined, 'scene: no surface — create a window first');
    contractRequire(state!.objectId === objectId, 'scene: caller does not own the surface');

    const problems = validateSceneOps(ops);
    if (problems.length > 0) {
      throw new Error(
        `Invalid scene ops (nothing was applied): ${problems.join('; ')}. ` +
        `Node kinds: ${SCENE_NODE_KINDS.join(', ')}. ` +
        `Shape: { op: 'add'|'update'|'remove'|'animate', id, parentId?, kind?, transform: { position?, rotation?, scale? }, params } — ` +
        `e.g. { op: 'add', id: 'orb', kind: 'mesh', transform: { position: [0, 0, 40], scale: 30 }, params: { primitive: 'sphere', color: '$accent' } }.`
      );
    }

    // Compact into retained state: adds insert, updates merge, removes delete.
    // 'animate' ops are transient client-side animations — forward them but
    // never merge them into the retained node (their channel/to/duration are
    // not node params and would corrupt the snapshot + reconnect replay).
    const foreign = contributorId !== undefined && contributorId !== state!.objectId;
    for (const op of ops) {
      if (op.op === 'animate') continue;
      if (op.op === 'remove') {
        state!.sceneNodes.delete(op.id);
        state!.sceneContributors.delete(op.id);
        continue;
      }
      if (op.op === 'add') {
        state!.sceneNodes.set(op.id, { ...op });
        if (foreign) state!.sceneContributors.set(op.id, contributorId!);
        continue;
      }
      const existing = state!.sceneNodes.get(op.id);
      if (!existing) continue;
      if (op.transform) existing.transform = { ...existing.transform, ...op.transform };
      if (op.params) mergeSceneParams(existing, op.params);
      if (op.parentId !== undefined) existing.parentId = op.parentId;
    }

    this.sendToFrontend({
      type: 'sceneOps',
      surfaceId: state!.surfaceId,
      ops: ops as unknown as Array<Record<string, unknown>>,
    });
    this.log('debug', 'sceneOps', { objectId, surfaceId: state!.surfaceId, opCount: ops.length });
    return true;
  }

  /**
   * Apply a WORLD-scope scene-op batch: nodes attach to the global scene
   * graph (workspace coordinates) rather than a window, scoped to the
   * calling abject's own namespace. Same validation, retention, and replay
   * semantics as window subtrees; nodes are torn down when the owner dies.
   */
  private handleWorldSceneOps(objectId: AbjectId, rawOps: SceneOp[]): boolean {
    const ops = normalizeSceneOps(rawOps) as SceneOp[];
    const problems = validateSceneOps(ops);
    if (problems.length > 0) {
      throw new Error(
        `Invalid world scene ops (nothing was applied): ${problems.join('; ')}. ` +
        `Node kinds: ${SCENE_NODE_KINDS.join(', ')}. ` +
        `World positions are workspace px ([x, y, z], +z toward the viewer); params.layer: 'back' (default, behind windows) or 'front'. ` +
        `e.g. { op: 'add', id: 'pet-body', kind: 'mesh', transform: { position: [400, 600, 30], scale: 40 }, params: { primitive: 'sphere', color: '$accent' } }.`
      );
    }

    let nodes = this.worldScenes.get(objectId);
    if (!nodes) {
      nodes = new Map();
      this.worldScenes.set(objectId, nodes);
    }
    for (const op of ops) {
      if (op.op === 'animate') continue;
      if (op.op === 'remove') {
        nodes.delete(op.id);
        continue;
      }
      if (op.op === 'add') {
        nodes.set(op.id, { ...op });
        continue;
      }
      const existing = nodes.get(op.id);
      if (!existing) continue;
      if (op.transform) existing.transform = { ...existing.transform, ...op.transform };
      if (op.params) mergeSceneParams(existing, op.params);
      if (op.parentId !== undefined) existing.parentId = op.parentId;
    }
    if (nodes.size === 0) this.worldScenes.delete(objectId);

    this.sendToFrontend({
      type: 'sceneOps',
      surfaceId: '',
      world: true,
      ownerId: objectId,
      ops: ops as unknown as Array<Record<string, unknown>>,
    });
    this.log('debug', 'worldSceneOps', { objectId, opCount: ops.length });
    return true;
  }

  /**
   * Deliver a node input event to the node's owner: world-scope straight to
   * the owning abject (only if it really owns world nodes — no spoofed
   * routing), window-scope to the window, which relays to its owner —
   * except decorations (foreign-contributed nodes), which go straight to
   * their contributor.
   */
  private deliverNodeEvent(
    target: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: AbjectId },
    payload: Record<string, unknown>,
  ): void {
    if (target.scope === 'world' && target.ownerId) {
      if (this.worldScenes.has(target.ownerId)) {
        this.send(event(this.id, target.ownerId, 'nodeInput', payload));
      }
      return;
    }
    if (target.surfaceId) {
      const state = this.surfaces.get(target.surfaceId);
      if (state) {
        // Decorations route straight to their contributor (with the host
        // window's id attached); the owner's own nodes go through the window.
        const nodeId = payload.nodeId as string | undefined;
        const contributor = nodeId ? state.sceneContributors.get(nodeId) : undefined;
        if (contributor) {
          this.send(event(this.id, contributor, 'nodeInput', { ...payload, windowId: state.objectId }));
        } else {
          this.send(event(this.id, state.objectId, 'nodeInput', payload));
        }
      }
    }
  }

  /** Move node keyboard focus, bracketing the change with blur/focus events. */
  private setFocusedNode(target?: { scope: 'window' | 'world'; surfaceId?: string; ownerId?: AbjectId; nodeId: string }): void {
    const prev = this.focusedNode;
    if (prev && target && prev.nodeId === target.nodeId
      && prev.surfaceId === target.surfaceId && prev.ownerId === target.ownerId) {
      return;
    }
    if (prev) {
      this.deliverNodeEvent(prev, { type: 'blur', nodeId: prev.nodeId, world: prev.scope === 'world' });
    }
    this.focusedNode = target;
    if (target) {
      this.deliverNodeEvent(target, { type: 'focus', nodeId: target.nodeId, world: target.scope === 'world' });
    }
  }

  /**
   * Tear down decorations a dead abject contributed to OTHER abjects' windows,
   * so host windows never accumulate orphaned foreign nodes.
   */
  private destroyDecorationsForObject(objectId: AbjectId): void {
    for (const state of this.surfaces.values()) {
      const dead: string[] = [];
      for (const [nodeId, contributor] of state.sceneContributors) {
        if (contributor === objectId) dead.push(nodeId);
      }
      if (dead.length === 0) continue;
      for (const nodeId of dead) {
        state.sceneNodes.delete(nodeId);
        state.sceneContributors.delete(nodeId);
        if (this.focusedNode?.surfaceId === state.surfaceId && this.focusedNode.nodeId === nodeId) {
          this.focusedNode = undefined;
        }
      }
      this.sendToFrontend({
        type: 'sceneOps',
        surfaceId: state.surfaceId,
        ops: dead.map((id) => ({ op: 'remove', id })),
      });
    }
  }

  /** Tear down an owner's world nodes (owner unregistered/died). */
  private destroyWorldSceneForObject(objectId: AbjectId): void {
    if (this.focusedNode?.ownerId === objectId) this.focusedNode = undefined;
    const nodes = this.worldScenes.get(objectId);
    if (!nodes || nodes.size === 0) {
      this.worldScenes.delete(objectId);
      return;
    }
    const removes = [...nodes.keys()].map((id) => ({ op: 'remove', id }));
    this.worldScenes.delete(objectId);
    this.sendToFrontend({
      type: 'sceneOps',
      surfaceId: '',
      world: true,
      ownerId: objectId,
      ops: removes,
    });
  }

  private handleMoveSurface(
    objectId: AbjectId,
    surfaceId: string,
    x: number,
    y: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.rect.x = x;
    state.rect.y = y;

    this.sendToFrontend({
      type: 'moveSurface',
      surfaceId,
      x,
      y,
    });

    return true;
  }

  private handleResizeSurface(
    objectId: AbjectId,
    surfaceId: string,
    width: number,
    height: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.rect.width = width;
    state.rect.height = height;

    this.sendToFrontend({
      type: 'resizeSurface',
      surfaceId,
      width,
      height,
    });

    return true;
  }

  private handleSetZIndex(
    objectId: AbjectId,
    surfaceId: string,
    zIndex: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.zIndex = zIndex;

    this.sendToFrontend({
      type: 'setZIndex',
      surfaceId,
      zIndex,
    });

    return true;
  }

  private handleFocus(objectId: AbjectId, surfaceId: string, glowColor?: string, glowRadius?: number): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.objectId !== objectId) {
      return false;
    }

    const oldFocus = this.focusedSurface;
    this.focusedSurface = surfaceId;
    if (glowColor) this.focusGlowColor = glowColor;
    if (typeof glowRadius === 'number') this.focusGlowRadius = glowRadius;

    // Send focus lost to previous owner
    if (oldFocus && oldFocus !== surfaceId) {
      const oldState = this.surfaces.get(oldFocus);
      if (oldState) {
        this.sendFocusEvent(oldState.objectId, oldFocus, false);
      }
    }

    // Send focus gained to new owner
    this.sendFocusEvent(objectId, surfaceId, true);

    // Tell frontend which surface is focused (for keyboard routing) and the
    // accent color for the focus-glow halo.
    this.sendToFrontend({
      type: 'setFocused',
      surfaceId,
      glowColor: this.focusGlowColor,
      glowRadius: this.focusGlowRadius,
    });

    return true;
  }

  private async handleGetDisplayInfo(): Promise<{ width: number; height: number }> {
    if (!this.hasReadyClient) {
      return { ...this.lastDisplayInfo };
    }
    try {
      const info = await this.requestFromFrontend<{ width: number; height: number }>({
        type: 'displayInfoRequest',
        requestId: this.nextRequestId(),
      });
      this.lastDisplayInfo = { width: info.width, height: info.height };
      return info;
    } catch {
      return { ...this.lastDisplayInfo };
    }
  }

  private async handleMeasureText(
    surfaceId: string,
    text: string,
    font: string
  ): Promise<number> {
    if (!text) return 0;

    // Try local measurement using font metrics table from frontend
    const charWidths = this.fontMetrics.get(font);
    if (charWidths) {
      let width = 0;
      for (let i = 0; i < text.length; i++) {
        const cw = charWidths.get(text[i]);
        width += cw ?? (charWidths.get('M') ?? 7.5);
      }
      return width;
    }

    // No metrics yet -- fall back to round-trip or estimate
    if (!this.hasReadyClient) {
      return text.length * 7.5;
    }

    try {
      const result = await this.requestFromFrontend<{ width: number }>({
        type: 'measureTextRequest',
        requestId: this.nextRequestId(),
        surfaceId,
        text,
        font,
      });
      return result.width;
    } catch {
      return text.length * 7.5;
    }
  }

  private async handleCaptureScreenshot(
    objectId: AbjectId
  ): Promise<{ imageBase64: string; width: number; height: number } | null> {
    const objectSurfaces = Array.from(this.surfaces.values())
      .filter(s => s.objectId === objectId);
    if (objectSurfaces.length === 0) return null;
    if (!this.hasReadyClient) return null;

    const surface = objectSurfaces[0];
    try {
      return await this.requestFromFrontend<{ imageBase64: string; width: number; height: number }>({
        type: 'captureSurfaceRequest',
        requestId: this.nextRequestId(),
        surfaceId: surface.surfaceId,
      }, 15000);
    } catch {
      return null;
    }
  }

  private async handleCaptureDesktop(): Promise<{ imageBase64: string; width: number; height: number }> {
    if (!this.hasReadyClient) {
      return { imageBase64: '', width: 0, height: 0 };
    }
    try {
      return await this.requestFromFrontend<{ imageBase64: string; width: number; height: number }>({
        type: 'captureDesktopRequest',
        requestId: this.nextRequestId(),
      }, 15000);
    } catch {
      return { imageBase64: '', width: 0, height: 0 };
    }
  }

  private handleListWindows(): Array<{
    objectId: AbjectId;
    title: string;
    surfaceId: string;
    rect: { x: number; y: number; width: number; height: number };
  }> {
    const windows: Array<{
      objectId: AbjectId;
      title: string;
      surfaceId: string;
      rect: { x: number; y: number; width: number; height: number };
    }> = [];
    for (const state of this.surfaces.values()) {
      windows.push({
        objectId: state.objectId as AbjectId,
        title: state.title ?? '',
        surfaceId: state.surfaceId,
        rect: { ...state.rect },
      });
    }
    return windows;
  }

  // ── Request/reply with frontend ─────────────────────────────────────

  private requestIdCounter = 0;

  private nextRequestId(): string {
    return `req-${++this.requestIdCounter}`;
  }

  private requestFromFrontend<T>(msg: BackendToFrontendMsg & { requestId: string }, timeoutMs = 10000): Promise<T> {
    const target = this.firstReadyClient;
    if (!target) {
      return Promise.reject(new Error('No ready frontend client'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.requestId);
        reject(new Error(`Frontend request ${msg.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(msg.requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.sendToClientImmediate(msg, target.id);
    });
  }

  // ── Frontend message handling ───────────────────────────────────────

  private handleFrontendMessage(msg: FrontendToBackendMsg, clientId: string): void {
    switch (msg.type) {
      case 'input':
        this.handleFrontendInput(msg as InputMsg, clientId);
        break;

      case 'frameAck': {
        const client = this.clients.get(clientId);
        if (client) this.handleFrameAck(client, msg.n);
        break;
      }

      case 'needBlob': {
        const client = this.clients.get(clientId);
        const blob = this.imageBlobs.get(msg.hash);
        if (client && blob) {
          client.sentBlobs.add(msg.hash);
          this.sendToClientImmediate({ type: 'imageBlob', hash: msg.hash, mime: blob.mime, bytes: blob.bytes }, clientId);
        } else {
          log.warn(`needBlob: no blob ${msg.hash.slice(0, 12)} for client ${clientId} (referenced image no longer retained)`);
        }
        break;
      }

      case 'globalShortcut': {
        const m = msg as { combo: string };
        this.dispatchGlobalShortcut(m.combo).catch(() => {});
        break;
      }

      case 'fileUpload':
        this.handleFileUpload(msg);
        break;

      case 'measureTextReply': {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ width: msg.width });
        }
        break;
      }

      case 'displayInfoReply': {
        this.lastDisplayInfo = { width: msg.width, height: msg.height };
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ width: msg.width, height: msg.height });
        }
        break;
      }

      case 'captureSurfaceReply': {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ imageBase64: msg.imageBase64, width: msg.width, height: msg.height });
        }
        break;
      }

      case 'captureDesktopReply': {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ imageBase64: msg.imageBase64, width: msg.width, height: msg.height });
        }
        break;
      }

      case 'mediaCaptureReply':
      case 'mediaCaptureFrameReply':
      case 'speechSpeakReply':
      case 'speechRecognizeReply':
      case 'speechVoicesReply': {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve(msg);
        }
        break;
      }

      case 'audioEvent': {
        const notifyId = this.audioNotify.get(msg.playbackId);
        this.audioNotify.delete(msg.playbackId);
        if (notifyId) {
          this.send(event(this.id, notifyId, 'playbackEvent', {
            playbackId: msg.playbackId,
            event: msg.event,
            error: msg.error,
          }));
        }
        break;
      }

      case 'videoEvent': {
        // Long-lived mapping: a video emits many events; cleared on dispose.
        const notifyId = this.videoNotify.get(msg.videoId);
        if (notifyId) {
          this.send(event(this.id, notifyId, 'videoEvent', {
            videoId: msg.videoId,
            event: msg.event,
            error: msg.error,
            duration: msg.duration,
            currentTime: msg.currentTime,
            width: msg.width,
            height: msg.height,
          }));
        }
        break;
      }

      case 'mediaRecordingComplete': {
        const notifyId = this.recordingNotify.get(msg.recordingId);
        this.recordingNotify.delete(msg.recordingId);
        if (notifyId) {
          this.send(event(this.id, notifyId, 'recordingReady', {
            recordingId: msg.recordingId,
            base64: msg.base64,
            mimeType: msg.mimeType,
            durationMs: msg.durationMs,
            error: msg.error,
          }));
        }
        break;
      }

      case 'fontMetrics': {
        const fmMsg = msg as FontMetricsMsg;
        const hadMetrics = this.fontMetrics.size > 0;
        // Multi-client safety: a secondary client (e.g. a paired phone) reports
        // its own font widths, but the layout is shared. Overwriting the
        // first client's metrics with a different-font set would re-flow every
        // window using mismatched widths. Keep first-arrival per (font, char).
        for (const [font, chars] of Object.entries(fmMsg.metrics)) {
          let charMap = this.fontMetrics.get(font);
          if (!charMap) {
            charMap = new Map<string, number>();
            this.fontMetrics.set(font, charMap);
          }
          for (const [ch, w] of Object.entries(chars)) {
            if (!charMap.has(ch)) charMap.set(ch, w);
          }
        }
        log.info(`Received font metrics from ${clientId} for ${Object.keys(fmMsg.metrics).length} fonts (additive)`);
        // Only fire fontMetricsChanged on first metrics arrival
        if (!hadMetrics) {
          const notifiedOwners = new Set<string>();
          for (const state of this.surfaces.values()) {
            if (!notifiedOwners.has(state.objectId)) {
              notifiedOwners.add(state.objectId);
              this.send(event(this.id, state.objectId as AbjectId, 'fontMetricsChanged', {}));
            }
          }
        }
        break;
      }

      case 'ready': {
        const client = this.clients.get(clientId);
        if (client) {
          client.ready = true;
        }
        log.info(`Client ${clientId} ready (${this.clients.size} total)`);
        this.replayStateToClient(clientId);
        // A ready client means live display info — dependents sizing UI to the
        // display (e.g. the sidebar dock) re-measure on this signal.
        this.emitFrontendClientsChanged();
        break;
      }

      case 'displayResized': {
        const m = msg as DisplayResizedMsg;
        if (m.width > 0 && m.height > 0) {
          this.lastDisplayInfo = { width: m.width, height: m.height };
          // Same signal as client-ready: display-sized chrome re-measures.
          this.emitFrontendClientsChanged();
          // Let the WindowManager re-fit maximized windows to the new viewport.
          if (this.windowManagerId) {
            this.send(event(this.id, this.windowManagerId, 'viewportResized', {
              width: m.width, height: m.height,
            }));
          }
        }
        break;
      }

      case 'closeWindow': {
        const m = msg as CloseWindowMsg;
        if (this.windowManagerId) {
          this.send(event(this.id, this.windowManagerId, 'closeWindow', { surfaceId: m.surfaceId }));
        }
        break;
      }

      case 'endWindowDrag':
        this.handleEndWindowDrag(msg as EndWindowDragMsg, clientId);
        break;

      case 'surfaceCreated':
        // Acknowledgment from frontend -- no action needed
        break;
    }
  }

  /**
   * Reassemble an uploaded file from its base64 chunks. Once the final chunk
   * arrives, deliver the whole file to the surface owner as a single
   * 'fileUploaded' event — buffering here (rather than forwarding each chunk)
   * keeps the owner's mailbox to one message regardless of file size.
   */
  private handleFileUpload(msg: FileUploadMsg): void {
    let entry = this.fileUploads.get(msg.uploadId);
    if (!entry) {
      entry = {
        surfaceId: msg.surfaceId,
        name: msg.name,
        mimeType: msg.mimeType,
        chunks: new Array<string>(msg.chunkCount).fill(''),
        received: 0,
        chunkCount: msg.chunkCount,
        toFocusedWidget: msg.toFocusedWidget === true,
      };
      this.fileUploads.set(msg.uploadId, entry);
    }
    if (msg.chunkIndex >= 0 && msg.chunkIndex < entry.chunks.length && entry.chunks[msg.chunkIndex] === '') {
      entry.chunks[msg.chunkIndex] = msg.base64;
      entry.received++;
    }
    if (entry.received < entry.chunkCount) return;

    this.fileUploads.delete(msg.uploadId);
    const base64 = entry.chunks.join('');
    const owner = this.surfaces.get(entry.surfaceId)?.objectId;
    if (!owner) {
      log.warn(`fileUpload for unknown surface ${entry.surfaceId}, dropping`);
      return;
    }
    this.send(event(this.id, owner as AbjectId, 'fileUploaded', {
      name: entry.name,
      mimeType: entry.mimeType,
      base64,
      ...(entry.toFocusedWidget ? { toFocusedWidget: true } : {}),
    }));
  }

  private async handleFrontendInput(msg: InputMsg, clientId: string): Promise<void> {
    // Track last mouse position and client (global coords) for requestDrag
    if (msg.inputType === 'mousedown' || msg.inputType === 'mousemove') {
      const surfState = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
      this.lastMouseX = (msg.x ?? 0) + (surfState?.rect.x ?? 0);
      this.lastMouseY = (msg.y ?? 0) + (surfState?.rect.y ?? 0);
      this.lastInputClientId = clientId;
    }

    // ── Synthesize mouseleave when the pointer changes surface ──
    // Hit-testing happens client-side per event, so without this a window
    // never learns the pointer left it (stale hover backplates, stranded
    // tooltips). Tracked per client so two connected clients don't fight.
    if (msg.inputType === 'mousemove' && !this.mouseGrabAbject) {
      const prev = this.hoverSurfaceByClient.get(clientId);
      if (prev !== msg.surfaceId) {
        if (prev) {
          const prevState = this.surfaces.get(prev);
          if (prevState) {
            await this.sendInputEvent(prevState.objectId, { type: 'mouseleave', surfaceId: prev });
          }
        }
        this.hoverSurfaceByClient.set(clientId, msg.surfaceId);
      }
    }

    // ── Cursor hint: ask WindowManager which CSS cursor fits the current
    // (surface, x, y). Throttled to 30 Hz; only forwarded to the frontend
    // when the cursor *changes*, so a still or steady-zone mouse costs
    // nothing.
    if (msg.inputType === 'mousemove' && !this.mouseGrabAbject) {
      this.maybeUpdateCursor(msg.surfaceId, msg.x ?? 0, msg.y ?? 0);
    }

    // ── Input monitors: broadcast mouse/wheel events to all monitor surfaces ──
    // Throttle mousemove to ~60fps to avoid flooding monitor mailboxes
    const now = Date.now();
    const isMouseMove = msg.inputType === 'mousemove';
    const shouldBroadcast = !isMouseMove || (now - this.lastMonitorMoveTime >= 16);
    if (shouldBroadcast && (msg.inputType === 'mousedown' || msg.inputType === 'mouseup' ||
        msg.inputType === 'mousemove' || msg.inputType === 'wheel')) {
      if (isMouseMove) this.lastMonitorMoveTime = now;
      // Reconstruct global coords
      const surfState = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
      const globalX = (msg.x ?? 0) + (surfState?.rect.x ?? 0);
      const globalY = (msg.y ?? 0) + (surfState?.rect.y ?? 0);

      for (const state of this.surfaces.values()) {
        if (!state.inputMonitor) continue;
        this.sendInputEvent(state.objectId, {
          type: msg.inputType,
          surfaceId: state.surfaceId,
          x: globalX - state.rect.x,
          y: globalY - state.rect.y,
          button: msg.button,
          deltaX: msg.deltaX,
          deltaY: msg.deltaY,
          modifiers: msg.modifiers,
        });
      }
    }

    // ── WindowManager grab: route drag events to WindowManager (resize only) ──
    // Move drags are handled client-side; resize drags still go through the server.
    // Only the client that owns the grab sends drag events.
    if (this.mouseGrabAbject && this.mouseGrabClientId === clientId) {
      if (msg.inputType === 'mousemove') {
        const state = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
        const globalX = msg.globalX ?? ((msg.x ?? 0) + (state?.rect.x ?? 0));
        const globalY = msg.globalY ?? ((msg.y ?? 0) + (state?.rect.y ?? 0));
        this.send(event(this.id, this.mouseGrabAbject, 'dragMove', {
          globalX, globalY,
        }));
        return;
      }
      if (msg.inputType === 'mouseup') {
        const state = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
        const globalX = msg.globalX ?? ((msg.x ?? 0) + (state?.rect.x ?? 0));
        const globalY = msg.globalY ?? ((msg.y ?? 0) + (state?.rect.y ?? 0));
        this.send(event(this.id, this.mouseGrabAbject, 'dragEnd', {
          globalX, globalY,
        }));
        this.mouseGrabAbject = undefined;
        this.mouseGrabClientId = undefined;
        return;
      }
    }

    // ── 3D scene-node input: mesh nodes are input targets like widgets.
    // World-scope hits route straight to the owning abject; window-subtree
    // hits route to the window, which forwards to its owner as 'nodeInput'.
    if (msg.nodeId) {
      const target = {
        scope: (msg.nodeScope ?? 'window') as 'window' | 'world',
        surfaceId: msg.surfaceId,
        ownerId: msg.nodeOwnerId as AbjectId | undefined,
        nodeId: msg.nodeId,
      };
      // Selection: a clicked node takes keyboard focus until focus moves.
      if (msg.inputType === 'mousedown') {
        this.setFocusedNode(target);
      }
      this.deliverNodeEvent(target, {
        type: msg.inputType,
        nodeId: msg.nodeId,
        world: target.scope === 'world',
        x: msg.x,
        y: msg.y,
        button: msg.button,
        modifiers: msg.modifiers,
      });
      return;
    }

    // A non-node mousedown moves focus away from any selected node.
    if (msg.inputType === 'mousedown' && this.focusedNode) {
      this.setFocusedNode(undefined);
    }

    // Keyboard routes to the selected node while one holds focus.
    if ((msg.inputType === 'keydown' || msg.inputType === 'keyup') && this.focusedNode) {
      this.deliverNodeEvent(this.focusedNode, {
        type: msg.inputType,
        nodeId: this.focusedNode.nodeId,
        world: this.focusedNode.scope === 'world',
        key: msg.key,
        code: msg.code,
        modifiers: msg.modifiers,
      });
      return;
    }

    const inputEvent: InputEvent = {
      type: msg.inputType,
      surfaceId: msg.surfaceId,
      x: msg.x,
      y: msg.y,
      button: msg.button,
      key: msg.key,
      code: msg.code,
      modifiers: msg.modifiers,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY,
      pasteText: msg.pasteText,
    };

    if (msg.surfaceId) {
      const state = this.surfaces.get(msg.surfaceId);
      if (state) {
        if (msg.inputType === 'mousedown' && this.windowManagerId) {
          // ── Ctrl+click: immediately start window drag (client-side move) ──
          if (msg.modifiers?.ctrl) {
            const globalX = (msg.x ?? 0) + (state.rect.x ?? 0);
            const globalY = (msg.y ?? 0) + (state.rect.y ?? 0);
            this.send(event(this.id, this.windowManagerId,
              'startDrag', {
                surfaceId: msg.surfaceId, globalX, globalY,
              }));
            // Tell only the initiating client to handle the move drag locally
            this.sendToClient({
              type: 'startWindowDrag',
              surfaceId: msg.surfaceId,
              dragType: 'move',
            }, clientId);
            this.handleFocus(state.objectId, msg.surfaceId);
            return;
          }

          // Ask WindowManager if it wants to grab the mouse (drag/resize)
          const localX = msg.x ?? 0;
          const localY = msg.y ?? 0;
          try {
            const reply = await this.request<{ grab: boolean; dragType?: 'move' | 'resize'; edge?: string; minimize?: string }>(
              request(this.id, this.windowManagerId,
                'surfaceMouseDown', {
                  surfaceId: msg.surfaceId, localX, localY,
                })
            );

            // WindowManager requested a minimize -- hide the surface directly
            if (reply.minimize) {
              this.sendToFrontend({ type: 'setSurfaceVisible', surfaceId: reply.minimize, visible: false });
              return;
            }

            if (reply.grab) {
              // Tell only the initiating client about the drag start
              this.sendToClient({
                type: 'startWindowDrag',
                surfaceId: msg.surfaceId,
                dragType: reply.dragType ?? 'move',
                edge: reply.edge,
              }, clientId);

              if (reply.dragType === 'resize') {
                // Resize drags still go through server (needs content re-rendering)
                this.mouseGrabAbject = this.windowManagerId;
                this.mouseGrabClientId = clientId;
              }
              // Move drags: no mouseGrabAbject -- client handles it locally
              this.handleFocus(state.objectId, msg.surfaceId);
              return;
            }
          } catch (err) {
            // WindowManager not available -- fall through to original behavior
          }

          // WindowManager didn't grab -- proceed with normal input routing
          await this.sendInputEvent(state.objectId, inputEvent);
          this.handleFocus(state.objectId, msg.surfaceId);
          return;
        }

        await this.sendInputEvent(state.objectId, inputEvent);
      }
    }
  }

  // ── Client-side drag end ────────────────────────────────────────────

  /**
   * Handle endWindowDrag from client -- client did the move locally,
   * now sync final position to server state, WindowManager, and other clients.
   */
  private handleEndWindowDrag(msg: EndWindowDragMsg, fromClientId: string): void {
    const state = this.surfaces.get(msg.surfaceId);
    if (state) {
      state.rect.x = msg.x;
      state.rect.y = msg.y;
    }

    // Notify WindowManager of the final position so it updates its windows map
    if (this.windowManagerId) {
      this.send(event(this.id, this.windowManagerId, 'clientDragEnd', {
        surfaceId: msg.surfaceId,
        x: msg.x,
        y: msg.y,
      }));
    }

    // Broadcast moveSurface to all OTHER clients so they see the window move.
    // The originating client already has the correct position from local drag.
    this.sendToFrontendExcept({
      type: 'moveSurface',
      surfaceId: msg.surfaceId,
      x: msg.x,
      y: msg.y,
    }, fromClientId);
  }

  // ── State replay ────────────────────────────────────────────────────

  /**
   * Replay all current surface state to a specific client.
   * Called when a client sends 'ready' (initial connect or reconnect).
   */
  private replayStateToClient(clientId: string): void {
    // 1. Recreate all surfaces
    for (const state of this.surfaces.values()) {
      this.sendToClient({
        type: 'createSurface',
        surfaceId: state.surfaceId,
        objectId: state.objectId,
        rect: { ...state.rect },
        zIndex: state.zIndex,
        inputPassthrough: state.inputPassthrough,
        transparent: state.transparent,
        closable: state.closable,
        title: state.title,
      }, clientId);
    }

    // 2. Replay last draw commands for each surface (image bytes first —
    // a reconnecting client starts with an empty blob cache)
    const replayClient = this.clients.get(clientId);
    for (const state of this.surfaces.values()) {
      if (state.lastDrawCommands.length > 0) {
        if (replayClient) {
          this.queueBlobsForClient(replayClient, this.blobHashesIn(state.lastDrawCommands));
        }
        this.sendToClient({
          type: 'draw',
          commands: state.lastDrawCommands,
        }, clientId);
      }
    }

    // 3. Replay workspace assignments
    for (const state of this.surfaces.values()) {
      if (state.workspaceId) {
        this.sendToClient({
          type: 'setSurfaceWorkspace',
          surfaceId: state.surfaceId,
          workspaceId: state.workspaceId,
        }, clientId);
      }
    }

    // 4. Replay active workspace filter
    if (this.activeWorkspaceId) {
      this.sendToClient({
        type: 'setActiveWorkspace',
        workspaceId: this.activeWorkspaceId,
      }, clientId);
    }

    // 5. Restore focus
    if (this.focusedSurface && this.surfaces.has(this.focusedSurface)) {
      this.sendToClient({
        type: 'setFocused',
        surfaceId: this.focusedSurface,
        glowColor: this.focusGlowColor,
        glowRadius: this.focusGlowRadius,
      }, clientId);
    }

    // 6. Replay the scene: theme, slab transforms, and retained vocab nodes
    if (this.sceneTheme) {
      this.sendToClient({
        type: 'setSceneTheme',
        theme: this.sceneTheme as unknown as Record<string, unknown>,
      }, clientId);
    }
    for (const state of this.surfaces.values()) {
      if (state.slabTransform) {
        this.sendToClient({
          type: 'setSurfaceTransform',
          surfaceId: state.surfaceId,
          rotation: state.slabTransform.rotation,
          z: state.slabTransform.z,
        }, clientId);
      }
      if (state.sceneNodes.size > 0) {
        this.sendToClient({
          type: 'sceneOps',
          surfaceId: state.surfaceId,
          ops: [...state.sceneNodes.values()] as unknown as Array<Record<string, unknown>>,
        }, clientId);
      }
    }
    for (const [ownerId, nodes] of this.worldScenes) {
      if (nodes.size === 0) continue;
      this.sendToClient({
        type: 'sceneOps',
        surfaceId: '',
        world: true,
        ownerId,
        ops: [...nodes.values()] as unknown as Array<Record<string, unknown>>,
      }, clientId);
    }

    let totalDrawCmds = 0;
    for (const state of this.surfaces.values()) {
      totalDrawCmds += state.lastDrawCommands.length;
    }
    log.info(`Replayed ${this.surfaces.size} surfaces (${totalDrawCmds} draw commands) to ${clientId}`);
  }

  // ── Event sending ───────────────────────────────────────────────────

  private async sendInputEvent(
    objectId: AbjectId,
    inputEvent: InputEvent
  ): Promise<void> {
    this.send(
      event(this.id, objectId, 'input', inputEvent)
    );
  }

  private async sendFocusEvent(
    objectId: AbjectId,
    surfaceId: string,
    focused: boolean
  ): Promise<void> {
    this.send(
      event(this.id, objectId, 'focus', { surfaceId, focused })
    );
  }

  /**
   * Get surface count.
   */
  get surfaceCount(): number {
    return this.surfaces.size;
  }
}

export const BACKEND_UI_ID = 'abjects:backend-ui' as AbjectId;
