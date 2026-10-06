import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractViolation } from '../core/contracts.js';
import {
  allowOrigins, canonicalOrigin, clientOriginsFromEnv, refuseAllOrigins, DEFAULT_DEV_CLIENT_PORT,
} from './origin-policy.js';

test('canonicalOrigin lowercases, drops the default port and the path', () => {
  assert.equal(canonicalOrigin('HTTPS://Abject.Example.COM:443/'), 'https://abject.example.com');
  assert.equal(canonicalOrigin('http://127.0.0.1:5174/some/path?q=1'), 'http://127.0.0.1:5174');
  assert.equal(canonicalOrigin('http://localhost:80'), 'http://localhost');
});

test('canonicalOrigin refuses what is not an http(s) origin', () => {
  for (const value of ['null', '', 'file:///etc/passwd', 'ws://127.0.0.1:7719', 'chrome-extension://abc', 'not a url']) {
    assert.equal(canonicalOrigin(value), undefined, value);
  }
});

test('allowOrigins admits exactly the listed origins', () => {
  const allow = allowOrigins(['http://127.0.0.1:5174', 'https://abject.example.com/']);
  assert.equal(allow('http://127.0.0.1:5174'), true);
  assert.equal(allow('https://abject.example.com'), true);
  assert.equal(allow('HTTPS://ABJECT.EXAMPLE.COM:443'), true);

  assert.equal(allow('http://127.0.0.1:5175'), false, 'another port');
  assert.equal(allow('http://localhost:5174'), false, 'another host name for the same address');
  assert.equal(allow('http://abject.example.com'), false, 'another scheme');
  assert.equal(allow('https://evil.abject.example.com'), false, 'a subdomain');
  assert.equal(allow('https://abject.example.com.evil.example'), false, 'a suffix');
  assert.equal(allow('null'), false, 'the opaque origin');
});

test('allowOrigins refuses to be configured with something that is not an origin', () => {
  assert.throws(() => allowOrigins(['ws://127.0.0.1:7719']), ContractViolation);
});

test('refuseAllOrigins refuses every page', () => {
  assert.equal(refuseAllOrigins('http://127.0.0.1:5174'), false);
});

test('clientOriginsFromEnv allows the dev client on its default port when nothing is set', () => {
  const { origins, ignored } = clientOriginsFromEnv({});
  assert.deepEqual(origins, [
    `http://127.0.0.1:${DEFAULT_DEV_CLIENT_PORT}`,
    `http://localhost:${DEFAULT_DEV_CLIENT_PORT}`,
  ]);
  assert.deepEqual(ignored, []);
});

test('clientOriginsFromEnv follows VITE_CLIENT_PORT for a second instance', () => {
  const { origins } = clientOriginsFromEnv({ VITE_CLIENT_PORT: '5175' });
  assert.deepEqual(origins, ['http://127.0.0.1:5175', 'http://localhost:5175']);
});

test('clientOriginsFromEnv in the desktop app allows its own client and no dev client', () => {
  const { origins } = clientOriginsFromEnv({
    ELECTRON_PACKAGED: '1',
    ABJECTS_CLIENT_ORIGIN: 'http://127.0.0.1:41235',
  });
  assert.deepEqual(origins, ['http://127.0.0.1:41235']);
});

test('clientOriginsFromEnv adds ABJECTS_ALLOWED_ORIGINS and reports the entries it ignores', () => {
  const { origins, ignored } = clientOriginsFromEnv({
    ELECTRON_PACKAGED: '1',
    ABJECTS_ALLOWED_ORIGINS: 'https://max.abject.world/, https://Other.Example:8443 wss://nope.example null',
  });
  assert.deepEqual(origins, ['https://max.abject.world', 'https://other.example:8443']);
  assert.deepEqual(ignored, ['wss://nope.example', 'null']);
});
