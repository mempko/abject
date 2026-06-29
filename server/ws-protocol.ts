/**
 * Shared WebSocket protocol types for backend-frontend communication.
 *
 * Backend -> Frontend: draw/surface commands, request proxies for measureText/displayInfo
 * Frontend -> Backend: input events, replies to measurement requests, lifecycle signals
 */

import type { AbjectId } from '../src/core/types.js';

// =============================================================================
// Common
// =============================================================================

export interface WsEnvelope {
  type: string;
  requestId?: string;
}

// =============================================================================
// Backend -> Frontend messages
// =============================================================================

export interface CreateSurfaceMsg extends WsEnvelope {
  type: 'createSurface';
  surfaceId: string;
  objectId: AbjectId;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
  inputPassthrough?: boolean;
  title?: string;
  /** Window paints no background; the compositor skips its focus-glow halo. */
  transparent?: boolean;
  /** Whether the mobile card overview may close this surface (default true).
   * System rails (taskbar, switchers, toolbars) set this false. */
  closable?: boolean;
}

export interface SetSurfaceTitleMsg extends WsEnvelope {
  type: 'setSurfaceTitle';
  surfaceId: string;
  title: string;
}

export interface DestroySurfaceMsg extends WsEnvelope {
  type: 'destroySurface';
  surfaceId: string;
}

export interface DrawMsg extends WsEnvelope {
  type: 'draw';
  commands: Array<{
    type: string;
    surfaceId: string;
    params: unknown;
  }>;
}

export interface MoveSurfaceMsg extends WsEnvelope {
  type: 'moveSurface';
  surfaceId: string;
  x: number;
  y: number;
}

export interface ResizeSurfaceMsg extends WsEnvelope {
  type: 'resizeSurface';
  surfaceId: string;
  width: number;
  height: number;
}

export interface SetZIndexMsg extends WsEnvelope {
  type: 'setZIndex';
  surfaceId: string;
  zIndex: number;
}

export interface SetFocusedMsg extends WsEnvelope {
  type: 'setFocused';
  surfaceId: string;
  /** Accent color for the compositor's focus-glow halo (theme accent). */
  glowColor?: string;
  /** Window corner radius so the halo matches the window silhouette. */
  glowRadius?: number;
}

export interface MeasureTextRequestMsg extends WsEnvelope {
  type: 'measureTextRequest';
  requestId: string;
  surfaceId: string;
  text: string;
  font: string;
}

export interface DisplayInfoRequestMsg extends WsEnvelope {
  type: 'displayInfoRequest';
  requestId: string;
}

export interface SetSelectedTextMsg extends WsEnvelope {
  type: 'setSelectedText';
  text: string;
}

export interface SetSurfaceVisibleMsg extends WsEnvelope {
  type: 'setSurfaceVisible';
  surfaceId: string;
  visible: boolean;
}

export interface SetSurfaceWorkspaceMsg extends WsEnvelope {
  type: 'setSurfaceWorkspace';
  surfaceId: string;
  workspaceId: string;
}

export interface SetActiveWorkspaceMsg extends WsEnvelope {
  type: 'setActiveWorkspace';
  workspaceId: string;
}

export interface ClipboardWriteMsg extends WsEnvelope {
  type: 'clipboardWrite';
  text: string;
}

export interface ClipboardWriteImageMsg extends WsEnvelope {
  type: 'clipboardWriteImage';
  image: string;
}

export interface OpenUrlMsg extends WsEnvelope {
  type: 'openUrl';
  url: string;
}

export interface StartWindowDragMsg extends WsEnvelope {
  type: 'startWindowDrag';
  surfaceId: string;
  dragType: 'move' | 'resize';
  edge?: string;
}

export interface SetSurfaceResizableMsg extends WsEnvelope {
  type: 'setSurfaceResizable';
  surfaceId: string;
  resizable: boolean;
}

export interface ShowMobileKeyboardMsg extends WsEnvelope {
  type: 'showMobileKeyboard';
  show: boolean;
}

/**
 * Ask the backend to close the window owning a surface. Sent by the mobile
 * card overview when a card is flicked up to close. Routed to WindowManager,
 * which replays the same close path as the title-bar close button.
 */
export interface CloseWindowMsg extends WsEnvelope {
  type: 'closeWindow';
  surfaceId: string;
}

/**
 * Update the canvas cursor. Sent only when the cursor hint actually
 * changes — the backend throttles redundant updates so we don't burn
 * messages while the mouse is moving freely.
 */
export interface SetCursorMsg extends WsEnvelope {
  type: 'setCursor';
  cursor: string;
}

export interface CaptureSurfaceRequestMsg extends WsEnvelope {
  type: 'captureSurfaceRequest';
  requestId: string;
  surfaceId: string;
}

export interface CaptureDesktopRequestMsg extends WsEnvelope {
  type: 'captureDesktopRequest';
  requestId: string;
}

/**
 * Ask the client to open a native file picker. The chosen file(s) come back as
 * one or more {@link FileUploadMsg} carrying base64 chunks tagged with the same
 * surfaceId so the backend can route them to the surface that requested them.
 */
export interface OpenFilePickerMsg extends WsEnvelope {
  type: 'openFilePicker';
  surfaceId: string;
  /** Optional `accept` attribute for the file input (e.g. 'image/*,.pdf'). */
  accept?: string;
  /** Allow selecting multiple files. */
  multiple?: boolean;
}

// =============================================================================
// Auth messages (server -> client)
// =============================================================================

export interface AuthRequiredMsg extends WsEnvelope {
  type: 'authRequired';
}

export interface AuthNotRequiredMsg extends WsEnvelope {
  type: 'authNotRequired';
}

export interface AuthResultMsg extends WsEnvelope {
  type: 'authResult';
  success: boolean;
  token?: string;
  error?: string;
}

export type BackendToFrontendMsg =
  | CreateSurfaceMsg
  | DestroySurfaceMsg
  | DrawMsg
  | MoveSurfaceMsg
  | ResizeSurfaceMsg
  | SetZIndexMsg
  | SetFocusedMsg
  | MeasureTextRequestMsg
  | DisplayInfoRequestMsg
  | SetSelectedTextMsg
  | SetSurfaceTitleMsg
  | SetSurfaceVisibleMsg
  | SetSurfaceWorkspaceMsg
  | SetActiveWorkspaceMsg
  | ClipboardWriteMsg
  | ClipboardWriteImageMsg
  | OpenUrlMsg
  | StartWindowDragMsg
  | SetSurfaceResizableMsg
  | ShowMobileKeyboardMsg
  | SetCursorMsg
  | CaptureSurfaceRequestMsg
  | CaptureDesktopRequestMsg
  | OpenFilePickerMsg
  | SceneOpsMsg
  | SetSceneThemeMsg
  | SetSurfaceTransformMsg
  | AuthRequiredMsg
  | AuthNotRequiredMsg
  | AuthResultMsg;

// =============================================================================
// Frontend -> Backend messages
// =============================================================================

export interface InputMsg extends WsEnvelope {
  type: 'input';
  /** Set when the hit target is a 3D scene-vocabulary mesh node. */
  nodeId?: string;
  nodeScope?: 'window' | 'world';
  /** Owning abject for world-scope node hits. */
  nodeOwnerId?: string;
  inputType: 'mousedown' | 'mouseup' | 'mousemove' | 'mouseenter' | 'mouseleave' | 'keydown' | 'keyup' | 'wheel' | 'paste';
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
  globalX?: number;   // canvas-space X (for drag events — avoids stale local→global reconstruction)
  globalY?: number;   // canvas-space Y (for drag events)
}

export interface EndWindowDragMsg extends WsEnvelope {
  type: 'endWindowDrag';
  surfaceId: string;
  x: number;
  y: number;
}

export interface MeasureTextReplyMsg extends WsEnvelope {
  type: 'measureTextReply';
  requestId: string;
  width: number;
}

export interface DisplayInfoReplyMsg extends WsEnvelope {
  type: 'displayInfoReply';
  requestId: string;
  width: number;
  height: number;
}

export interface CaptureSurfaceReplyMsg extends WsEnvelope {
  type: 'captureSurfaceReply';
  requestId: string;
  imageBase64: string;
  width: number;
  height: number;
}

export interface CaptureDesktopReplyMsg extends WsEnvelope {
  type: 'captureDesktopReply';
  requestId: string;
  imageBase64: string;
  width: number;
  height: number;
}

export interface SurfaceCreatedMsg extends WsEnvelope {
  type: 'surfaceCreated';
  surfaceId: string;
}

/**
 * Retained 3D scene operations: either for a surface's subtree (meshes,
 * lights, groups riding a window's slab) or, with world=true, for the
 * global scene graph in workspace coordinates, namespaced per owner.
 */
export interface SceneOpsMsg extends WsEnvelope {
  type: 'sceneOps';
  surfaceId: string;
  /** World scope: nodes attach to the desktop scene, not a window. */
  world?: boolean;
  /** Owning abject for world-scope nodes (namespacing + teardown). */
  ownerId?: string;
  ops: Array<Record<string, unknown>>;
}

/** Active workspace's palette subset for the 3D scene chrome and $tokens. */
export interface SetSceneThemeMsg extends WsEnvelope {
  type: 'setSceneTheme';
  theme: Record<string, unknown>;
}

/** Abject-requested slab transform: tilt/float a window in the scene. */
export interface SetSurfaceTransformMsg extends WsEnvelope {
  type: 'setSurfaceTransform';
  surfaceId: string;
  rotation?: [number, number, number];
  z?: number;
}

export interface ReadyMsg extends WsEnvelope {
  type: 'ready';
}

/**
 * Sent by the client (debounced) when its viewport changes size, so
 * display-sized chrome (the sidebar dock) can follow without polling.
 */
export interface DisplayResizedMsg extends WsEnvelope {
  type: 'displayResized';
  width: number;
  height: number;
}

// =============================================================================
// Auth messages (client -> server)
// =============================================================================

export interface AuthLoginMsg extends WsEnvelope {
  type: 'auth';
  username: string;
  password: string;
}

export interface AuthTokenMsg extends WsEnvelope {
  type: 'auth';
  token: string;
}

export interface FontMetricsMsg extends WsEnvelope {
  type: 'fontMetrics';
  /** Keyed by CSS font string, then by character → pixel width */
  metrics: Record<string, Record<string, number>>;
}

/**
 * Global keyboard shortcut intercept. The frontend pulls a small set of
 * known combos (currently ⌘K / Ctrl-K) out of the regular keydown stream
 * and sends them here so they aren't swallowed by whichever widget happens
 * to hold focus.
 */
export interface GlobalShortcutMsg extends WsEnvelope {
  type: 'globalShortcut';
  combo: 'commandPalette' | 'windowSwitcher';
}

/**
 * A file uploaded from the client (via picker or drag-drop), delivered as one
 * or more base64 chunks. The backend reassembles chunks keyed by `uploadId`
 * and, once complete, hands the full file to the object owning `surfaceId`.
 */
export interface FileUploadMsg extends WsEnvelope {
  type: 'fileUpload';
  surfaceId: string;
  uploadId: string;
  name: string;
  mimeType: string;
  /** Base64 of this chunk. */
  base64: string;
  chunkIndex: number;
  chunkCount: number;
  /**
   * When true, the assembled file is delivered to the surface's currently
   * focused child widget (e.g. an image pasted into a text input) rather than
   * to the surface owner. Lets widgets accept pasted images generically.
   */
  toFocusedWidget?: boolean;
}

export type FrontendToBackendMsg =
  | InputMsg
  | FileUploadMsg
  | CloseWindowMsg
  | EndWindowDragMsg
  | MeasureTextReplyMsg
  | DisplayInfoReplyMsg
  | CaptureSurfaceReplyMsg
  | CaptureDesktopReplyMsg
  | SurfaceCreatedMsg
  | ReadyMsg
  | DisplayResizedMsg
  | FontMetricsMsg
  | GlobalShortcutMsg
  | AuthLoginMsg
  | AuthTokenMsg;

export type WsMessage = BackendToFrontendMsg | FrontendToBackendMsg;
