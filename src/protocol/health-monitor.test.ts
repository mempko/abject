/**
 * Regression tests for HealthMonitor's rolling window.
 *
 * Runs on Node's built-in test runner, no new dependencies:
 *   pnpm tsx --test src/protocol/health-monitor.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HealthMonitor } from './health-monitor.js';
import type { AgreementId, AbjectError } from '../core/types.js';

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

const AG = 'agreement-under-test' as AgreementId;
const err: AbjectError = {
  code: 'UNKNOWN_METHOD',
  message: 'proxy lost the mapping',
} as AbjectError;

function atOffset(ms: number): void {
  Date.now = () => realNow() + ms;
}

test('old traffic outside the window cannot hide a broken connection', () => {
  const hm = new HealthMonitor();
  hm.trackConnection(AG);

  // two minutes ago: 990 healthy replies, all outside the 60s window
  atOffset(-120_000);
  for (let i = 0; i < 990; i++) hm.recordSuccess(AG);

  // now: every message in the window is an error
  atOffset(0);
  for (let i = 0; i < 60; i++) hm.recordError(AG, err);

  const s = hm.getStatus(AG);
  assert.ok(s);
  assert.equal(s.messageCount, 60);
  assert.equal(s.errorCount, 60);
  assert.equal(s.errorRate, 100);
  assert.equal(s.healthy, false);
});

test('a healthy connection stays healthy as it ages', () => {
  const hm = new HealthMonitor();
  hm.trackConnection(AG);

  atOffset(-120_000);
  for (let i = 0; i < 500; i++) hm.recordSuccess(AG);

  atOffset(0);
  for (let i = 0; i < 95; i++) hm.recordSuccess(AG);
  for (let i = 0; i < 5; i++) hm.recordError(AG, err);

  const s = hm.getStatus(AG);
  assert.ok(s);
  assert.equal(s.messageCount, 100);
  assert.equal(s.errorCount, 5);
  assert.equal(s.errorRate, 5);
  assert.equal(s.healthy, true);
});

test('messageCount tracks the window as traffic expires', () => {
  const hm = new HealthMonitor();
  hm.trackConnection(AG);

  atOffset(-90_000);
  for (let i = 0; i < 30; i++) hm.recordSuccess(AG);
  atOffset(-10_000);
  for (let i = 0; i < 20; i++) hm.recordSuccess(AG);

  atOffset(0);
  const s = hm.getStatus(AG);
  assert.ok(s);
  // only the 20 messages from 10s ago are inside the 60s window
  assert.equal(s.messageCount, 20);
  assert.equal(s.errorCount, 0);
  assert.equal(s.healthy, true);
});
