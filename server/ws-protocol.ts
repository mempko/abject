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
  | OpenUrlMsg
  | StartWindowDragMsg
  | SetSurfaceResizableMsg
  | ShowMobileKeyboardMsg
  | SetCursorMsg
  | CaptureSurfaceRequestMsg
  | CaptureDesktopRequestMsg
  | AuthRequiredMsg
  | AuthNotRequiredMsg
  | AuthResultMsg;

// =============================================================================
// Frontend -> Backend messages
// =============================================================================

export interface InputMsg extends WsEnvelope {
  type: 'input';
  inputType: 'mousedown' | 'mouseup' | 'mousemove' | 'keydown' | 'keyup' | 'wheel' | 'paste';
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

export interface ReadyMsg extends WsEnvelope {
  type: 'ready';
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

export type FrontendToBackendMsg =
  | InputMsg
  | EndWindowDragMsg
  | MeasureTextReplyMsg
  | DisplayInfoReplyMsg
  | CaptureSurfaceReplyMsg
  | CaptureDesktopReplyMsg
  | SurfaceCreatedMsg
  | ReadyMsg
  | FontMetricsMsg
  | GlobalShortcutMsg
  | AuthLoginMsg
  | AuthTokenMsg;

export type WsMessage = BackendToFrontendMsg | FrontendToBackendMsg;
