/**
 * Crypto — secure randomness, hashing, MACs, password hashing and signature
 * checks, for abjects that cannot reach `node:crypto`.
 *
 * The script sandbox has no `crypto` global, and `Math.random` is predictable.
 * A script abject that issues session ids or one-time tokens, checks a webhook
 * signature, stores a password, or verifies a signed token asks this object.
 * Nothing here holds a key: every key and secret comes in with the request and
 * is forgotten after it.
 */

import * as crypto from 'node:crypto';
import { AbjectMessage, InterfaceId, MethodDeclaration } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require as precondition } from '../../core/contracts.js';

/** Encodings for binary data passed as strings. */
export type CryptoEncoding = 'utf8' | 'hex' | 'base64' | 'base64url';
export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512' | 'sha1';
export type SignatureAlgorithm = 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384' | 'EdDSA';

const ENCODINGS: ReadonlySet<string> = new Set(['utf8', 'hex', 'base64', 'base64url']);
const HASHES: ReadonlySet<string> = new Set(['sha256', 'sha384', 'sha512', 'sha1']);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_RANDOM_BYTES = 1024;

/** scrypt parameters for hashPassword: about 50 ms and 16 MB per hash. */
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
/** Refuse stored hashes asking for more work than this (a hostile hash string). */
const SCRYPT_MAX_N = 1 << 20;

function encoding(value: unknown, fallback: CryptoEncoding, what: string): CryptoEncoding {
  const e = value ?? fallback;
  precondition(typeof e === 'string' && ENCODINGS.has(e), `${what} must be one of utf8, hex, base64, base64url`);
  return e as CryptoEncoding;
}

function hashAlgorithm(value: unknown): HashAlgorithm {
  const a = value ?? 'sha256';
  precondition(typeof a === 'string' && HASHES.has(a), 'algorithm must be one of sha256, sha384, sha512, sha1');
  return a as HashAlgorithm;
}

function bytes(data: unknown, enc: CryptoEncoding, what: string): Buffer {
  precondition(typeof data === 'string', `${what} must be a string`);
  const buf = Buffer.from(data as string, enc);
  precondition(buf.byteLength <= MAX_INPUT_BYTES, `${what} is larger than 16 MB`);
  return buf;
}

/** Constant-time equality of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  // Comparing digests keeps the time independent of where, or whether, the
  // lengths differ.
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db) && a.length === b.length;
}

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$key`, salt and key in base64url. */
export async function hashPassword(password: string): Promise<string> {
  precondition(typeof password === 'string' && password.length > 0, 'password must be a non-empty string');
  precondition(password.length <= 1024, 'password is longer than 1024 characters');
  const salt = crypto.randomBytes(SCRYPT.saltLen);
  const key = await scryptAsync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string' || password.length > 1024) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.byteLength < 8 || expected.byteLength < 16 || expected.byteLength > 64) return false;
  const key = await scryptAsync(password, salt, expected.byteLength, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

const SIGNATURES: Record<SignatureAlgorithm, { digest: string | null; options?: Partial<crypto.VerifyKeyObjectInput> }> = {
  RS256: { digest: 'sha256' },
  RS384: { digest: 'sha384' },
  RS512: { digest: 'sha512' },
  PS256: { digest: 'sha256', options: { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } },
  ES256: { digest: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { digest: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
  EdDSA: { digest: null },
};

/**
 * Check a signature made with the private half of `publicKey` (a JWK object
 * or a PEM string). Algorithms use JOSE names, so a JWT's `alg` can be passed
 * as is; ES* signatures are the raw r||s form JWTs use.
 */
export function verifySignature(input: {
  algorithm: string; publicKey: unknown; data: string; signature: string;
  dataEncoding?: CryptoEncoding; signatureEncoding?: CryptoEncoding;
}): boolean {
  const spec = SIGNATURES[input.algorithm as SignatureAlgorithm];
  precondition(spec !== undefined, `algorithm must be one of ${Object.keys(SIGNATURES).join(', ')}`);
  let key: crypto.KeyObject;
  try {
    key = typeof input.publicKey === 'string'
      ? crypto.createPublicKey(input.publicKey)
      : crypto.createPublicKey({ key: input.publicKey as crypto.JsonWebKey, format: 'jwk' });
  } catch (err) {
    throw new Error(`publicKey is not a usable public key: ${err instanceof Error ? err.message : String(err)}`);
  }
  precondition(key.type === 'public', 'publicKey must be a public key');
  const data = bytes(input.data, encoding(input.dataEncoding, 'utf8', 'dataEncoding'), 'data');
  const signature = bytes(input.signature, encoding(input.signatureEncoding, 'base64url', 'signatureEncoding'), 'signature');
  try {
    return crypto.verify(spec.digest, data, { key, ...spec.options } as crypto.VerifyKeyObjectInput, signature);
  } catch {
    return false;
  }
}

const str = { kind: 'primitive' as const, primitive: 'string' as const };
const num = { kind: 'primitive' as const, primitive: 'number' as const };
const bool = { kind: 'primitive' as const, primitive: 'boolean' as const };
type Primitive = typeof str | typeof num | typeof bool;
const param = (name: string, description: string, type: Primitive = str, optional = false) =>
  ({ name, description, type, ...(optional ? { optional } : {}) });

const METHODS: MethodDeclaration[] = [
  {
    name: 'randomBytes',
    description: 'Cryptographically secure random bytes, encoded (default 32 bytes as base64url). Use for session ids, one-time tokens, OAuth state and nonces.',
    parameters: [param('length', '1 to 1024 bytes (default 32)', num, true), param('encoding', 'hex, base64 or base64url (default)', str, true)],
    returns: str,
  },
  { name: 'randomUUID', description: 'A random version 4 UUID.', parameters: [], returns: str },
  {
    name: 'hash',
    description: 'Digest of data: sha256 (default), sha384, sha512 or sha1. Returns hex unless encoding says otherwise.',
    parameters: [
      param('data', 'The input'), param('algorithm', 'sha256, sha384, sha512, sha1', str, true),
      param('inputEncoding', 'How data is encoded: utf8 (default), hex, base64, base64url', str, true),
      param('encoding', 'Output encoding: hex (default), base64, base64url', str, true),
    ],
    returns: str,
  },
  {
    name: 'hmac',
    description: 'HMAC of data under key (default HMAC-SHA256, hex). Checks webhook signatures and signs cookies or tokens.',
    parameters: [
      param('key', 'The secret key'), param('data', 'The input'), param('algorithm', 'sha256 (default), sha384, sha512, sha1', str, true),
      param('keyEncoding', 'utf8 (default), hex, base64, base64url', str, true),
      param('inputEncoding', 'utf8 (default), hex, base64, base64url', str, true),
      param('encoding', 'Output: hex (default), base64, base64url', str, true),
    ],
    returns: str,
  },
  {
    name: 'timingSafeEqual',
    description: 'Compare two strings in constant time, for secrets, tokens and MACs.',
    parameters: [param('a', 'First string'), param('b', 'Second string')],
    returns: bool,
  },
  {
    name: 'hashPassword',
    description: 'Hash a password with scrypt and a random salt. Store the returned string; check it with verifyPassword.',
    parameters: [param('password', 'The password')],
    returns: str,
  },
  {
    name: 'verifyPassword',
    description: 'True when password matches a hash from hashPassword.',
    parameters: [param('password', 'The password'), param('hash', 'The stored hash')],
    returns: bool,
  },
  {
    name: 'encode',
    description: 'Convert a string between utf8, hex, base64 and base64url (default utf8 to base64). Decodes a JWT segment with from=base64url, to=utf8.',
    parameters: [param('data', 'The input'), param('from', 'utf8 (default), hex, base64, base64url', str, true), param('to', 'utf8, hex, base64 (default), base64url', str, true)],
    returns: str,
  },
  {
    name: 'verifySignature',
    description: 'Check a signature against a public key (JWK object or PEM). Algorithms by JOSE name: RS256, RS384, RS512, PS256, ES256, ES384, EdDSA; verifies a JWT given header.payload as data and its third segment as signature.',
    parameters: [
      param('algorithm', 'JOSE algorithm name'),
      { name: 'publicKey', description: 'JWK object or PEM string', type: { kind: 'object' as const, properties: {} } },
      param('data', 'The signed data'), param('signature', 'The signature'),
      param('dataEncoding', 'utf8 (default), hex, base64, base64url', str, true),
      param('signatureEncoding', 'base64url (default), hex, base64', str, true),
    ],
    returns: bool,
  },
];

export class Crypto extends Abject {
  constructor() {
    super({
      manifest: {
        name: 'Crypto',
        description:
          'Secure random bytes and UUIDs, hashes, HMACs, constant-time comparison, scrypt password hashing, encoding conversion, ' +
          'and signature verification against a supplied public key. For abjects without node:crypto (script abjects): ' +
          'session ids, one-time tokens, webhook signatures, stored passwords, signed tokens. Holds no keys.',
        version: '1.0.0',
        interface: {
          id: 'abjects:crypto' as InterfaceId,
          name: 'Crypto',
          description: 'Randomness, hashing, MACs, password hashing and signature checks',
          methods: METHODS,
        },
        tags: ['system', 'capability', 'crypto'],
      },
    });

    this.on('randomBytes', (msg: AbjectMessage) => {
      const { length = 32, encoding: enc } = (msg.payload ?? {}) as { length?: number; encoding?: string };
      precondition(Number.isInteger(length) && length >= 1 && length <= MAX_RANDOM_BYTES, 'length must be an integer from 1 to 1024');
      const out = encoding(enc, 'base64url', 'encoding');
      precondition(out !== 'utf8', 'random bytes cannot be encoded as utf8');
      return crypto.randomBytes(length).toString(out);
    });

    this.on('randomUUID', () => crypto.randomUUID());

    this.on('hash', (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as { data?: string; algorithm?: string; inputEncoding?: string; encoding?: string };
      const out = encoding(p.encoding, 'hex', 'encoding');
      precondition(out !== 'utf8', 'a digest cannot be encoded as utf8');
      return crypto.createHash(hashAlgorithm(p.algorithm))
        .update(bytes(p.data, encoding(p.inputEncoding, 'utf8', 'inputEncoding'), 'data'))
        .digest(out);
    });

    this.on('hmac', (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as { key?: string; data?: string; algorithm?: string; keyEncoding?: string; inputEncoding?: string; encoding?: string };
      const out = encoding(p.encoding, 'hex', 'encoding');
      precondition(out !== 'utf8', 'a MAC cannot be encoded as utf8');
      const key = bytes(p.key, encoding(p.keyEncoding, 'utf8', 'keyEncoding'), 'key');
      precondition(key.byteLength > 0, 'key must not be empty');
      return crypto.createHmac(hashAlgorithm(p.algorithm), key)
        .update(bytes(p.data, encoding(p.inputEncoding, 'utf8', 'inputEncoding'), 'data'))
        .digest(out);
    });

    this.on('timingSafeEqual', (msg: AbjectMessage) => {
      const { a, b } = (msg.payload ?? {}) as { a?: unknown; b?: unknown };
      precondition(typeof a === 'string' && typeof b === 'string', 'a and b must be strings');
      return safeEqual(a as string, b as string);
    });

    this.on('hashPassword', (msg: AbjectMessage) => hashPassword((msg.payload as { password?: string })?.password as string));

    this.on('verifyPassword', (msg: AbjectMessage) => {
      const { password, hash } = (msg.payload ?? {}) as { password?: string; hash?: string };
      return verifyPassword(password as string, hash as string);
    });

    this.on('encode', (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as { data?: string; from?: string; to?: string };
      return bytes(p.data, encoding(p.from, 'utf8', 'from'), 'data').toString(encoding(p.to, 'base64', 'to'));
    });

    this.on('verifySignature', (msg: AbjectMessage) => verifySignature(msg.payload as Parameters<typeof verifySignature>[0]));
  }
}
