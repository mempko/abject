/**
 * Worker parallelism E2E test.
 *
 * Verifies that objects can be spawned in Web Workers and communicate
 * across worker boundaries via the main-thread MessageBus hub.
 */

import { test, expect } from '@playwright/test';

test.describe('Worker Parallelism', () => {
  test('objects spawn in workers by default', async ({ page }) => {
    // Workers are now enabled by default — no init script needed
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 15000 });

    // Verify that some objects are worker-hosted
    const result = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { isWorkerHosted: (id: string) => boolean };
      const ids = abjects.ids as Record<string, string>;

      // These should be worker-hosted when workers are enabled
      return {
        httpClientWorker: factory.isWorkerHosted(ids.httpClient),
        llmWorker: factory.isWorkerHosted(ids.llm),
        // WindowManager should NOT be worker-hosted (it's a DOM object)
        windowManagerWorker: factory.isWorkerHosted(ids.windowManager),
      };
    });

    expect(result.httpClientWorker).toBe(true);
    expect(result.llmWorker).toBe(true);
    expect(result.windowManagerWorker).toBe(false);
  });

  test('cross-worker request/reply works', async ({ page }) => {
    // Workers are now enabled by default — no init script needed
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 15000 });

    // Send a ping request from a main-thread object to a worker-hosted object
    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { messageBus: unknown };
      const { SimpleAbject, message } = abjects.modules as Record<string, unknown>;
      const { request } = message as { request: (...args: unknown[]) => unknown };
      const ids = abjects.ids as Record<string, string>;

      // Create a main-thread test object
      const Ctor = SimpleAbject as new (...args: unknown[]) => unknown;
      const tester = new Ctor('Tester', 'Cross-worker test', {});
      await (runtime as { spawn: (o: unknown) => Promise<void> }).spawn(tester);

      // Ping a worker-hosted object (Timer — simple and always available)
      const bus = runtime.messageBus as { send: (m: unknown) => Promise<void> };
      const testerId = (tester as { id: string }).id;
      const timerId = ids.timer;

      // Use the introspect interface ping
      const msg = request(testerId, timerId, 'abjects:introspect', 'ping', {});

      // Set up reply handling
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);

        const pendingReplies = new Map<string, (v: unknown) => void>();
        const busObj = runtime.messageBus as {
          setReplyHandler: (id: string, h: (m: unknown) => void) => void;
          removeReplyHandler: (id: string) => void;
        };

        busObj.setReplyHandler(testerId, (reply: unknown) => {
          clearTimeout(timeout);
          const r = reply as { payload: { alive: boolean } };
          resolve(r.payload?.alive === true);
        });

        bus.send(msg).catch(() => resolve(false));
      });
    });

    expect(result).toBe(true);
  });

  test('system works normally with workers explicitly disabled', async ({ page }) => {
    // Explicitly disable workers via ABJECTS_WORKER_COUNT = 0
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).ABJECTS_WORKER_COUNT = 0;
    });

    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 15000 });

    // Verify objects exist and are NOT worker-hosted
    const result = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { isWorkerHosted: (id: string) => boolean };
      const ids = abjects.ids as Record<string, string>;
      const runtime = abjects.runtime as { workerPool: unknown };

      return {
        workerPoolExists: runtime.workerPool !== undefined,
        httpClientWorker: factory.isWorkerHosted(ids.httpClient),
        objectCount: (abjects.registry as { objectCount: number }).objectCount,
      };
    });

    expect(result.workerPoolExists).toBe(false);
    expect(result.httpClientWorker).toBe(false);
    expect(result.objectCount).toBeGreaterThan(5);
  });
});
