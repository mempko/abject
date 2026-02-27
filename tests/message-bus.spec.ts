/**
 * MessageBus & Supervisor E2E tests — verifies non-blocking send,
 * parallel processing, request/reply, supervisor restart, and liveness.
 */

import { test, expect } from '@playwright/test';

test.describe('MessageBus & Supervisor', () => {
  test('bus.send() returns before the handler completes (non-blocking)', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };
      const { SimpleAbject, message } = abjects.modules as any;
      const createRequest = message.request;

      let handlerFinished = false;

      // Receiver takes 200ms to handle
      const receiver = new SimpleAbject('SlowReceiver', 'Takes 200ms', {
        doWork: async () => {
          await new Promise((r) => setTimeout(r, 200));
          handlerFinished = true;
          return 'done';
        },
      });
      await runtime.spawn(receiver);

      const sender = new SimpleAbject('FastSender', 'Just sends', {});
      await runtime.spawn(sender);

      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };
      const msg = createRequest(sender.id, receiver.id, 'doWork', {});

      const before = performance.now();
      await bus.send(msg);
      const after = performance.now();

      const sendElapsed = after - before;
      const handlerFinishedImmediately = handlerFinished;

      // Wait for handler to actually complete
      await new Promise((r) => setTimeout(r, 300));

      return {
        sendElapsed,
        handlerFinishedImmediately,
        handlerFinishedAfterWait: handlerFinished,
      };
    });

    // send() should return almost immediately, not wait 200ms for the handler
    expect(result.sendElapsed).toBeLessThan(50);
    expect(result.handlerFinishedImmediately).toBe(false);
    expect(result.handlerFinishedAfterWait).toBe(true);
  });

  test('two objects process messages concurrently', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };
      const { SimpleAbject, message } = abjects.modules as any;
      const createRequest = message.request;

      let aFinished = false;
      let bFinished = false;

      const objectA = new SimpleAbject('ParallelA', 'Slow handler A', {
        doWork: async () => {
          await new Promise((r) => setTimeout(r, 200));
          aFinished = true;
          return 'doneA';
        },
      });
      await runtime.spawn(objectA);

      const objectB = new SimpleAbject('ParallelB', 'Slow handler B', {
        doWork: async () => {
          await new Promise((r) => setTimeout(r, 200));
          bFinished = true;
          return 'doneB';
        },
      });
      await runtime.spawn(objectB);

      const sender = new SimpleAbject('ParallelSender', 'Sends to both', {});
      await runtime.spawn(sender);

      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };

      // Send to both simultaneously
      await bus.send(createRequest(sender.id, objectA.id, 'doWork', {}));
      await bus.send(createRequest(sender.id, objectB.id, 'doWork', {}));

      // If parallel, both 200ms handlers finish in ~200ms total.
      // If sequential, second finishes at ~400ms. Wait 350ms to distinguish.
      await new Promise((r) => setTimeout(r, 350));

      return { aFinished, bFinished };
    });

    expect(result.aFinished).toBe(true);
    expect(result.bFinished).toBe(true);
  });

  test('request/reply works across independent processing loops', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void> };
      const { SimpleAbject, message } = abjects.modules as any;
      const createRequest = message.request;

      const responder = new SimpleAbject('Responder', 'Returns 42', {
        getValue: () => ({ value: 42 }),
      });
      await runtime.spawn(responder);

      const requester = new SimpleAbject('Requester', 'Asks for value', {});
      await runtime.spawn(requester);

      // Use the protected request() method to send and await a reply
      const msg = createRequest(requester.id, responder.id, 'getValue', {});
      const reply = await (requester as any).request(msg, 5000);

      return reply;
    });

    expect(result).toEqual({ value: 42 });
  });

  test('mutual request/reply completes without deadlock', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void> };
      const { SimpleAbject, message } = abjects.modules as any;
      const createRequest = message.request;

      const objectA = new SimpleAbject('MutualA', 'Returns fromA', {
        getValue: () => ({ source: 'fromA' }),
      });
      await runtime.spawn(objectA);

      const objectB = new SimpleAbject('MutualB', 'Returns fromB', {
        getValue: () => ({ source: 'fromB' }),
      });
      await runtime.spawn(objectB);

      // A helper sends requests to both simultaneously — proves neither blocks the other
      const helper = new SimpleAbject('MutualHelper', 'Requests both', {});
      await runtime.spawn(helper);

      const [replyA, replyB] = await Promise.all([
        (helper as any).request(
          createRequest(helper.id, objectA.id, 'getValue', {}),
          5000
        ),
        (helper as any).request(
          createRequest(helper.id, objectB.id, 'getValue', {}),
          5000
        ),
      ]);

      return { replyA, replyB };
    });

    expect(result.replyA).toEqual({ source: 'fromA' });
    expect(result.replyB).toEqual({ source: 'fromB' });
  });

  test('Supervisor restarts a dead object with the same ID', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };
      const factory = abjects.factory as any;
      const supervisor = abjects.supervisor as any;
      const { SimpleAbject, message } = abjects.modules as any;
      const createEvent = message.event;

      // Register a constructor so Factory can respawn the type
      factory.registerConstructor('TestForRestart', () =>
        new SimpleAbject('TestForRestart', 'Respawnable object', {
          ping: () => ({ alive: true }),
        })
      );

      // Spawn the object
      const obj = new SimpleAbject('TestForRestart', 'Will be restarted', {
        ping: () => ({ alive: true }),
      });
      await runtime.spawn(obj);
      const originalId = obj.id;

      // Register as a permanent child with the Supervisor
      supervisor.addChild({
        id: originalId,
        constructorName: 'TestForRestart',
        restart: 'permanent',
      });

      // Simulate failure via childFailed event
      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };
      await bus.send(
        createEvent(
          originalId,
          supervisor.id,
          'childFailed',
          {
            childId: originalId,
            error: { code: 'TEST_CRASH', message: 'Simulated crash' },
          }
        )
      );

      // Wait for the restart to complete
      await new Promise((r) => setTimeout(r, 500));

      // Verify the object was respawned with the same ID
      const respawned = factory.getObject(originalId);

      return {
        originalId,
        respawnedExists: respawned !== undefined,
        respawnedId: respawned?.id,
        respawnedState: respawned?.status?.state,
        respawnedName: respawned?.manifest?.name,
      };
    });

    expect(result.respawnedExists).toBe(true);
    expect(result.respawnedId).toBe(result.originalId);
    expect(result.respawnedState).toBe('ready');
    expect(result.respawnedName).toBe('TestForRestart');
  });

  test('HealthMonitor detects an unresponsive object', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void> };
      const { SimpleAbject, HealthMonitor } = abjects.modules as any;

      // Create a target object that responds to pings
      const target = new SimpleAbject('LivenessTarget', 'Will be stopped', {});
      await runtime.spawn(target);

      // Create a HealthMonitor with short intervals for fast testing
      const monitor = new HealthMonitor({
        checkInterval: 200,
        pingTimeout: 200,
        maxPingFailures: 10, // High threshold so failures don't reset mid-test
      });
      await runtime.spawn(monitor);

      // Start monitoring the target
      monitor.monitorObject(target.id);
      monitor.markObjectReady(target.id);
      monitor.startMonitoring();

      // Wait for at least one successful ping cycle
      await new Promise((r) => setTimeout(r, 500));

      const beforeStop = monitor.getObjectLiveness(target.id);

      // Stop the target — pings will now time out
      await target.stop();

      // Wait for several failed ping cycles
      await new Promise((r) => setTimeout(r, 1500));

      const afterStop = monitor.getObjectLiveness(target.id);

      // Cleanup
      monitor.stopMonitoring();

      return {
        beforeAlive: beforeStop?.alive,
        beforeFailures: beforeStop?.consecutiveFailures,
        afterFailures: afterStop?.consecutiveFailures,
      };
    });

    expect(result.beforeAlive).toBe(true);
    expect(result.beforeFailures).toBe(0);
    expect(result.afterFailures).toBeGreaterThan(0);
  });
});
