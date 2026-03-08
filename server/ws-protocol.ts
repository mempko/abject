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

export interface StartWindowDragMsg extends WsEnvelope {
  type: 'startWindowDrag';
  surfaceId: string;
  dragType: 'move' | 'resize';
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
  | SetSurfaceVisibleMsg
  | SetSurfaceWorkspaceMsg
  | SetActiveWorkspaceMsg
  | ClipboardWriteMsg
  | StartWindowDragMsg
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

export type FrontendToBackendMsg =
  | InputMsg
  | EndWindowDragMsg
  | MeasureTextReplyMsg
  | DisplayInfoReplyMsg
  | SurfaceCreatedMsg
  | ReadyMsg
  | FontMetricsMsg
  | AuthLoginMsg
  | AuthTokenMsg;

export type WsMessage = BackendToFrontendMsg | FrontendToBackendMsg;
