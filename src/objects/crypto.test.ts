/**
 * Crypto: what a script abject without node:crypto relies on for session ids,
 * webhook signatures, stored passwords and signed tokens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';

import { Runtime } from '../runtime/runtime.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';
import { Crypto } from './capabilities/crypto.js';

class Probe extends Abject {
  constructor() {
    super({ manifest: { name: 'Probe', description: 'p', version: '1.0.0',
      interface: { id: 'test:probe' as InterfaceId, name: 'Probe', description: 'p', methods: [] },
      tags: [] } as unknown as AbjectManifest });
  }
  ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

async function withCrypto(fn: (probe: Probe, id: AbjectId) => Promise<void>): Promise<void> {
  const rt = new Runtime();
  await rt.start();
  try {
    const c = new Crypto();
    const probe = new Probe();
    await rt.objectFactory.spawnInstance(c);
    await rt.objectFactory.spawnInstance(probe);
    await fn(probe, c.id);
  } finally {
    await rt.stop();
  }
}

test('random bytes are fresh each time, sized and encoded as asked', async () => {
  await withCrypto(async (probe, id) => {
    const a = await probe.ask<string>(id, 'randomBytes', {});
    const b = await probe.ask<string>(id, 'randomBytes', {});
    assert.notEqual(a, b);
    assert.equal(Buffer.from(a, 'base64url').byteLength, 32);
    assert.match(await probe.ask<string>(id, 'randomBytes', { length: 4, encoding: 'hex' }), /^[0-9a-f]{8}$/);
    assert.match(await probe.ask<string>(id, 'randomUUID'), /^[0-9a-f-]{36}$/);
    await assert.rejects(probe.ask(id, 'randomBytes', { length: 5000 }), /1 to 1024/);
  });
});

test('hash and hmac match node:crypto, so a Stripe-style webhook signature checks out', async () => {
  await withCrypto(async (probe, id) => {
    assert.equal(await probe.ask(id, 'hash', { data: 'abc' }), nodeCrypto.createHash('sha256').update('abc').digest('hex'));
    const signed = '1700000000.{"id":"evt_1"}';
    const expected = nodeCrypto.createHmac('sha256', 'whsec_test').update(signed).digest('hex');
    const mac = await probe.ask<string>(id, 'hmac', { key: 'whsec_test', data: signed });
    assert.equal(mac, expected);
    assert.equal(await probe.ask(id, 'timingSafeEqual', { a: mac, b: expected }), true);
    assert.equal(await probe.ask(id, 'timingSafeEqual', { a: mac, b: expected.slice(1) }), false);
  });
});

test('a password hash verifies the password and nothing else, and is salted', async () => {
  await withCrypto(async (probe, id) => {
    const h1 = await probe.ask<string>(id, 'hashPassword', { password: 'correct horse' });
    const h2 = await probe.ask<string>(id, 'hashPassword', { password: 'correct horse' });
    assert.notEqual(h1, h2, 'salted');
    assert.match(h1, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await probe.ask(id, 'verifyPassword', { password: 'correct horse', hash: h1 }), true);
    assert.equal(await probe.ask(id, 'verifyPassword', { password: 'wrong', hash: h1 }), false);
    assert.equal(await probe.ask(id, 'verifyPassword', { password: 'x', hash: 'scrypt$1073741824$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA' }), false,
      'a stored hash cannot ask for unbounded work');
  });
});

test('encodings convert both ways and a JWT signed with a JWK verifies', async () => {
  await withCrypto(async (probe, id) => {
    const b64 = await probe.ask<string>(id, 'encode', { data: 'héllo', to: 'base64url' });
    assert.equal(await probe.ask(id, 'encode', { data: b64, from: 'base64url', to: 'utf8' }), 'héllo');

    const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
    const sig = nodeCrypto.sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const jwk = publicKey.export({ format: 'jwk' });
    assert.equal(await probe.ask(id, 'verifySignature', { algorithm: 'ES256', publicKey: jwk, data: `${header}.${body}`, signature: sig }), true);
    assert.equal(await probe.ask(id, 'verifySignature', { algorithm: 'ES256', publicKey: jwk, data: `${header}.e30`, signature: sig }), false);
    await assert.rejects(probe.ask(id, 'verifySignature', { algorithm: 'HS256', publicKey: jwk, data: 'x', signature: 'y' }), /algorithm must be one of/);
  });
});
