/**
 * Error isolation test - verify a bad object cannot crash other objects or the system.
 */

import { test, expect } from '@playwright/test';

test.describe('Error Isolation', () => {
  test('a throwing handler does not crash the sender', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };
      const { SimpleAbject, message } = abjects.modules as any;
      const { request } = message;

      // Create a "bad" object whose handler always throws
      const badObject = new SimpleAbject('BadObject', 'Always throws', {
        doWork: () => {
          throw new Error('I am a bad object');
        },
      });
      await runtime.spawn(badObject);

      // Create a "good" sender object
      const sender = new SimpleAbject('GoodSender', 'Sends messages', {});
      await runtime.spawn(sender);

      // Send a message from the good sender to the bad object
      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };
      const msg = request(sender.id, badObject.id, 'doWork', {});
      await bus.send(msg);

      // Small delay for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      return {
        senderState: sender.status.state,
        badObjectState: badObject.status.state,
        badObjectErrorCount: badObject.status.errorCount,
      };
    });

    // The sender must NOT be crashed — it should still be ready
    expect(result.senderState).toBe('ready');
    // The bad object should be in error state
    expect(result.badObjectState).toBe('error');
    expect(result.badObjectErrorCount).toBeGreaterThan(0);
  });

  test('recover() returns an errored object to ready state', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };
      const { SimpleAbject, message } = abjects.modules as any;
      const { request } = message;

      // Create a bad object
      const badObject = new SimpleAbject('BadObject', 'Throws then recovers', {
        doWork: () => {
          throw new Error('Temporary failure');
        },
      });
      await runtime.spawn(badObject);

      // Trigger the error
      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };
      const msg = request(badObject.id, badObject.id, 'doWork', {});
      await bus.send(msg);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stateBeforeRecover = badObject.status.state;

      // Recover the object
      (badObject as any).recover();

      return {
        stateBeforeRecover,
        stateAfterRecover: badObject.status.state,
      };
    });

    expect(result.stateBeforeRecover).toBe('error');
    expect(result.stateAfterRecover).toBe('ready');
  });
});
