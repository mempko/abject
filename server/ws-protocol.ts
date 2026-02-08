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

export type BackendToFrontendMsg =
  | CreateSurfaceMsg
  | DestroySurfaceMsg
  | DrawMsg
  | MoveSurfaceMsg
  | ResizeSurfaceMsg
  | SetZIndexMsg
  | SetFocusedMsg
  | MeasureTextRequestMsg
  | DisplayInfoRequestMsg;

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

export type FrontendToBackendMsg =
  | InputMsg
  | MeasureTextReplyMsg
  | DisplayInfoReplyMsg
  | SurfaceCreatedMsg
  | ReadyMsg;

export type WsMessage = BackendToFrontendMsg | FrontendToBackendMsg;
