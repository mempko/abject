/**
 * Binary wire codec for all remote traffic: the UI protocol between backend
 * and client (WebSocket and WebRTC raw frames) and AbjectMessages between
 * peers. Replaces JSON on the wire.
 *
 * A generic self-describing value encoding (JSON data model plus native
 * bytes) with per-connection string interning. Interning is what makes the
 * generic encoding compact: repeated object keys ('type', 'surfaceId',
 * 'params', ...), surface ids, fonts, and colors shrink to 2-3 bytes after
 * first sight. Numbers ride as zigzag varints (integers) or f64 (floats).
 * Uint8Array values ride as raw bytes with no base64 inflation.
 *
 * STATEFUL: a WireEncoder and the remote WireDecoder share an interning
 * table that grows as frames flow. The pair is per-connection, created
 * together at attach time and discarded together at disconnect. Two rules
 * follow:
 *   1. Encode a frame only if it will be sent. Encoding mutates the table;
 *      dropping an encoded frame desyncs the remote decoder. Coalesce or
 *      drop messages BEFORE encoding, never after.
 *   2. Frames must be delivered in encode order over a reliable, ordered
 *      channel (WebSocket, ordered DataChannel, MessagePort all qualify).
 *
 * Frame envelope (first byte):
 *   0x01  body is a value encoding
 *   0x02  body is deflate(value encoding) — used when it actually shrinks
 * JSON text frames start with '{' (0x7b) or '[' (0x5b), so envelope bytes
 * also cleanly distinguish binary frames from pre-auth JSON strings.
 *
 * Value encoding (tag byte + payload):
 *   0x00 null        0x01 false        0x02 true
 *   0x03 int         zigzag varint (safe integers)
 *   0x04 f64         8 bytes LE
 *   0x05 string-new  varint byteLen + UTF-8; receiver appends to table
 *   0x06 string-ref  varint table index
 *   0x07 string      varint byteLen + UTF-8; not interned
 *   0x08 bytes       varint byteLen + raw bytes
 *   0x09 array       varint count + elements
 *   0x0a object      varint count + (key as string form, value) pairs
 *
 * Encoding follows JSON.stringify semantics where they matter: undefined /
 * function object entries are skipped, undefined array elements become
 * null, toJSON() is honored. Divergences (all strict improvements): NaN and
 * ±Infinity survive as f64 instead of collapsing to null, and Uint8Array
 * values survive as bytes instead of index-keyed objects.
 */

import { require, requireDefined } from '../core/contracts.js';
import { deflateSync, inflateSync } from 'fflate';

const TAG_NULL = 0x00;
const TAG_FALSE = 0x01;
const TAG_TRUE = 0x02;
const TAG_INT = 0x03;
const TAG_F64 = 0x04;
const TAG_STR_NEW = 0x05;
const TAG_STR_REF = 0x06;
const TAG_STR = 0x07;
const TAG_BYTES = 0x08;
const TAG_ARRAY = 0x09;
const TAG_OBJECT = 0x0a;

export const FRAME_WIRE = 0x01;
export const FRAME_WIRE_DEFLATE = 0x02;

/** Strings longer than this are never interned (one-off text, paths). */
const MAX_INTERN_LEN = 128;
/** Interning stops when the table is full; refs to existing entries keep working. */
const MAX_INTERN_TABLE = 8192;
/** Frames below this size skip the deflate attempt. */
const DEFLATE_THRESHOLD = 256;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WireEncoder {
  private buf = new Uint8Array(4096);
  private len = 0;
  /** string → intern id, shared knowledge with the remote decoder. */
  private table = new Map<string, number>();
  /** Value strings seen once; second sight promotes them into the table. */
  private seenOnce = new Set<string>();

  /**
   * Encode a value into a framed Uint8Array ready for the wire. When
   * allowDeflate is set and the body clears the threshold, the frame is
   * deflated if that actually shrinks it. Transports that deflate at a
   * lower layer (PeerTransport) pass allowDeflate=false to avoid paying
   * for compression twice.
   */
  encodeFrame(value: unknown, allowDeflate: boolean): Uint8Array {
    this.len = 0;
    this.buf[this.len++] = FRAME_WIRE;
    this.writeValue(value, false);
    const body = this.buf.subarray(0, this.len);

    if (allowDeflate && body.byteLength >= DEFLATE_THRESHOLD) {
      const deflated = deflateSync(body.subarray(1)) as Uint8Array;
      if (deflated.byteLength + 1 < body.byteLength) {
        const frame = new Uint8Array(1 + deflated.byteLength);
        frame[0] = FRAME_WIRE_DEFLATE;
        frame.set(deflated, 1);
        return frame;
      }
    }
    return body.slice();
  }

  // ── value writers ──────────────────────────────────────────────────

  private writeValue(value: unknown, isKey: boolean): void {
    if (value === null || value === undefined) {
      this.writeTag(TAG_NULL);
      return;
    }
    switch (typeof value) {
      case 'boolean':
        this.writeTag(value ? TAG_TRUE : TAG_FALSE);
        return;
      case 'number':
        // Zigzag doubles the magnitude, so stay well under 2^53; larger
        // integers are exact in f64 anyway.
        if (Number.isSafeInteger(value) && Math.abs(value) < 2 ** 51) {
          this.writeTag(TAG_INT);
          this.writeVarint(value >= 0 ? value * 2 : -value * 2 - 1);
        } else {
          this.writeTag(TAG_F64);
          this.ensure(8);
          new DataView(this.buf.buffer, this.buf.byteOffset + this.len, 8).setFloat64(0, value, true);
          this.len += 8;
        }
        return;
      case 'string':
        this.writeString(value, isKey);
        return;
      case 'object':
        break;
      default:
        // function / symbol / bigint — mirror JSON: null in value position
        this.writeTag(TAG_NULL);
        return;
    }

    if (value instanceof Uint8Array) {
      this.writeTag(TAG_BYTES);
      this.writeVarint(value.byteLength);
      this.ensure(value.byteLength);
      this.buf.set(value, this.len);
      this.len += value.byteLength;
      return;
    }
    if (Array.isArray(value)) {
      this.writeTag(TAG_ARRAY);
      this.writeVarint(value.length);
      for (const item of value) this.writeValue(item, false);
      return;
    }
    const withToJson = value as { toJSON?: (key?: string) => unknown };
    if (typeof withToJson.toJSON === 'function') {
      this.writeValue(withToJson.toJSON(), isKey);
      return;
    }

    const obj = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      keys.push(key);
    }
    this.writeTag(TAG_OBJECT);
    this.writeVarint(keys.length);
    for (const key of keys) {
      this.writeString(key, true);
      this.writeValue(obj[key], false);
    }
  }

  private writeString(s: string, isKey: boolean): void {
    const ref = this.table.get(s);
    if (ref !== undefined) {
      this.writeTag(TAG_STR_REF);
      this.writeVarint(ref);
      return;
    }
    const internable = s.length <= MAX_INTERN_LEN && this.table.size < MAX_INTERN_TABLE;
    if (internable && (isKey || this.seenOnce.has(s))) {
      this.table.set(s, this.table.size);
      this.seenOnce.delete(s);
      this.writeTag(TAG_STR_NEW);
      this.writeUtf8(s);
      return;
    }
    if (internable) {
      // Bound the promotion-candidate set: ever-changing one-off strings
      // (clock text, counters) must not accumulate forever.
      if (this.seenOnce.size >= MAX_INTERN_TABLE * 2) this.seenOnce.clear();
      this.seenOnce.add(s);
    }
    this.writeTag(TAG_STR);
    this.writeUtf8(s);
  }

  private writeUtf8(s: string): void {
    const bytes = textEncoder.encode(s);
    this.writeVarint(bytes.byteLength);
    this.ensure(bytes.byteLength);
    this.buf.set(bytes, this.len);
    this.len += bytes.byteLength;
  }

  private writeTag(tag: number): void {
    this.ensure(1);
    this.buf[this.len++] = tag;
  }

  private writeVarint(n: number): void {
    require(n >= 0 && Number.isSafeInteger(n), 'varint requires a non-negative safe integer');
    this.ensure(8);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}

export class WireDecoder {
  private table: string[] = [];

  /** Decode a framed Uint8Array produced by the paired WireEncoder. */
  decodeFrame(frame: Uint8Array): unknown {
    require(frame.byteLength >= 2, 'wire frame too short');
    let body: Uint8Array;
    if (frame[0] === FRAME_WIRE) {
      body = frame.subarray(1);
    } else if (frame[0] === FRAME_WIRE_DEFLATE) {
      body = inflateSync(frame.subarray(1));
    } else {
      throw new Error(`unknown wire frame type 0x${frame[0].toString(16)}`);
    }
    const reader = new WireReader(body, this.table);
    const value = reader.readValue();
    require(reader.exhausted, 'trailing bytes after wire value');
    return value;
  }
}

class WireReader {
  private pos = 0;
  private view: DataView;

  constructor(private bytes: Uint8Array, private table: string[]) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get exhausted(): boolean {
    return this.pos === this.bytes.byteLength;
  }

  readValue(): unknown {
    const tag = this.readByte();
    switch (tag) {
      case TAG_NULL: return null;
      case TAG_FALSE: return false;
      case TAG_TRUE: return true;
      case TAG_INT: {
        const z = this.readVarint();
        return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      }
      case TAG_F64: {
        require(this.pos + 8 <= this.bytes.byteLength, 'truncated f64');
        const v = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return v;
      }
      case TAG_STR_NEW: {
        const s = this.readUtf8();
        this.table.push(s);
        return s;
      }
      case TAG_STR_REF: {
        const id = this.readVarint();
        const s = this.table[id];
        requireDefined(s, `wire string ref ${id} out of range (table size ${this.table.length})`);
        return s;
      }
      case TAG_STR: return this.readUtf8();
      case TAG_BYTES: {
        const len = this.readVarint();
        require(this.pos + len <= this.bytes.byteLength, 'truncated bytes');
        const out = this.bytes.slice(this.pos, this.pos + len);
        this.pos += len;
        return out;
      }
      case TAG_ARRAY: {
        const count = this.readVarint();
        require(count <= this.bytes.byteLength - this.pos, 'array count exceeds remaining bytes');
        const arr = new Array(count);
        for (let i = 0; i < count; i++) arr[i] = this.readValue();
        return arr;
      }
      case TAG_OBJECT: {
        const count = this.readVarint();
        require(count * 2 <= this.bytes.byteLength - this.pos, 'object count exceeds remaining bytes');
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const key = this.readValue();
          require(typeof key === 'string', 'object key must decode to a string');
          obj[key as string] = this.readValue();
        }
        return obj;
      }
      default:
        throw new Error(`unknown wire tag 0x${tag.toString(16)} at ${this.pos - 1}`);
    }
  }

  private readByte(): number {
    require(this.pos < this.bytes.byteLength, 'truncated wire value');
    return this.bytes[this.pos++];
  }

  private readVarint(): number {
    let n = 0;
    let mult = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.readByte();
      n += (b & 0x7f) * mult;
      if ((b & 0x80) === 0) {
        require(Number.isSafeInteger(n), 'varint exceeds safe integer range');
        return n;
      }
      mult *= 0x80;
    }
    throw new Error('varint too long');
  }

  private readUtf8(): string {
    const len = this.readVarint();
    require(this.pos + len <= this.bytes.byteLength, 'truncated string');
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}

/**
 * True when an incoming WebSocket/DataChannel payload is a wire-codec frame
 * rather than a pre-auth JSON text message that arrived as bytes.
 */
export function isWireFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && (bytes[0] === FRAME_WIRE || bytes[0] === FRAME_WIRE_DEFLATE);
}
