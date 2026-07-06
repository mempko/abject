/**
 * WASM ABI v1 — types, constants, and buffer codec shared by the host pieces.
 *
 * See docs/WASM_ABI.md for the full specification. The guest exchanges JSON
 * envelopes with the host through linear memory; this module defines those
 * envelope shapes and the length-prefixed buffer encoding.
 */

import { AbjectManifest, AbjectMessage, TypeId } from '../core/types.js';
import { require } from '../core/contracts.js';

export const WASM_ABI_VERSION = 1;

/** Exports every conforming module must provide. */
export const REQUIRED_EXPORTS = [
  'memory',
  'abject_abi_version',
  'abject_alloc',
  'abject_manifest',
  'abject_init',
  'abject_handle',
] as const;

/** Typed view of a conforming module's exports. */
export interface WasmAbjectExports {
  memory: WebAssembly.Memory;
  abject_abi_version: () => number;
  abject_alloc: (size: number) => number;
  abject_manifest: () => number;
  abject_init: (ptr: number, len: number) => number;
  abject_handle: (ptr: number, len: number) => number;
  abject_snapshot?: () => number;
  _initialize?: () => void;
}

// ── Envelopes ────────────────────────────────────────────────────────────

/** Host → guest: an incoming request or event from another abject. */
export interface InboundMessageEnvelope {
  kind: 'message';
  message: AbjectMessage;
}

/** Host → guest: completion of a guest-initiated request. */
export interface InboundResultEnvelope {
  kind: 'result';
  id: string;
  ok: boolean;
  payload?: unknown;
  code?: string;
  message?: string;
}

export type InboundEnvelope = InboundMessageEnvelope | InboundResultEnvelope;

/** Guest → host envelopes. */
export interface ReplyEnvelope {
  kind: 'reply';
  correlationId: string;
  payload?: unknown;
}

export interface ErrorEnvelope {
  kind: 'error';
  correlationId: string;
  code: string;
  message: string;
}

export interface RequestEnvelope {
  kind: 'request';
  /** Guest-chosen id; the matching `result` envelope carries it back. */
  id: string;
  /** AbjectId, well-known id, or '@Name' for Registry discovery. */
  to: string;
  method: string;
  payload?: unknown;
  timeoutMs?: number;
}

export interface EventEnvelope {
  kind: 'event';
  to: string;
  method: string;
  payload?: unknown;
}

export interface ChangedEnvelope {
  kind: 'changed';
  aspect: string;
  value?: unknown;
}

export interface PersistEnvelope {
  kind: 'persist';
}

export interface LogEnvelope {
  kind: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export type OutboundEnvelope =
  | ReplyEnvelope
  | ErrorEnvelope
  | RequestEnvelope
  | EventEnvelope
  | ChangedEnvelope
  | PersistEnvelope
  | LogEnvelope;

/** Input to abject_init. */
export interface WasmInitInfo {
  objectId: string;
  typeId?: TypeId;
  name: string;
  data?: Record<string, unknown>;
  now: number;
}

// ── Buffer codec ─────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Read a guest-returned buffer: u32 LE length at ptr, UTF-8 bytes at ptr+4.
 */
export function readGuestBuffer(memory: WebAssembly.Memory, ptr: number): string {
  require(ptr > 0, 'buffer pointer must be positive');
  const view = new DataView(memory.buffer);
  const len = view.getUint32(ptr, true);
  require(ptr + 4 + len <= memory.buffer.byteLength, 'buffer exceeds guest memory');
  const bytes = new Uint8Array(memory.buffer, ptr + 4, len);
  return decoder.decode(bytes);
}

/** Read raw UTF-8 (no length prefix) from guest memory. */
export function readGuestString(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): string {
  require(ptr >= 0 && len >= 0, 'ptr/len must be non-negative');
  require(ptr + len <= memory.buffer.byteLength, 'string exceeds guest memory');
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

// ── Module validation ────────────────────────────────────────────────────

/**
 * Check a compiled module declares every required export with the right kind.
 * Returns a list of problems; empty means conforming.
 */
export function validateWasmModule(module: WebAssembly.Module): string[] {
  const exports = WebAssembly.Module.exports(module);
  const byName = new Map(exports.map((e) => [e.name, e.kind]));
  const errors: string[] = [];

  for (const name of REQUIRED_EXPORTS) {
    const kind = byName.get(name);
    const expected = name === 'memory' ? 'memory' : 'function';
    if (!kind) {
      errors.push(`Missing required export: ${name}`);
    } else if (kind !== expected) {
      errors.push(`Export ${name} must be a ${expected}, found ${kind}`);
    }
  }

  return errors;
}

/** Minimal structural check that parsed JSON is a plausible AbjectManifest. */
export function looksLikeManifest(value: unknown): value is AbjectManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<AbjectManifest>;
  return (
    typeof m.name === 'string' &&
    m.name.length > 0 &&
    typeof m.description === 'string' &&
    m.interface !== undefined &&
    typeof m.interface === 'object' &&
    Array.isArray((m.interface as { methods?: unknown }).methods)
  );
}
