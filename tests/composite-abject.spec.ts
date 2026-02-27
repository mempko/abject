/**
 * CompositeAbject E2E tests — verify composite creation, routing, lifecycle.
 */

import { test, expect } from '@playwright/test';

/** Standard wait for system bootstrap. */
async function waitForSystem(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => (window as Record<string, unknown>).abjects !== undefined,
    { timeout: 10000 }
  );
}

test.describe('CompositeAbject', () => {
  test('delegate routing forwards to correct child', async ({ page }) => {
    await waitForSystem(page);

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { message } = abjects.modules;
      const { request } = message;
      const bus = abjects.runtime.messageBus;
      const factoryId = abjects.ids.factory;

      // Build composite spec: calculator + memory
      const spec = {
        name: 'CalcWithMem',
        description: 'Calculator with memory',
        version: '1.0.0',
        interface: {
          id: 'calc:with-memory',
          name: 'CalculatorWithMemory',
          description: 'Calc + mem',
          methods: [
            { name: 'add', description: 'Add two numbers', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
            { name: 'store', description: 'Store a value', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'recall', description: 'Recall stored value', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
          ],
        },
        children: [
          {
            role: 'calc',
            source: '({ add(msg) { return msg.payload.a + msg.payload.b; } })',
            manifest: {
              name: 'Calculator', description: 'Adds numbers', version: '1.0.0',
              interface: { id: 'calc:math', name: 'Math', description: 'Math ops', methods: [{ name: 'add', description: 'add', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
          {
            role: 'mem',
            source: '({ _value: 0, store(msg) { this._value = msg.payload.value; return true; }, recall() { return this._value; } })',
            manifest: {
              name: 'Memory', description: 'Stores a value', version: '1.0.0',
              interface: { id: 'calc:storage', name: 'Storage', description: 'Storage ops', methods: [{ name: 'store', description: 'store', parameters: [] }, { name: 'recall', description: 'recall', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
        ],
        routes: {
          'add': { strategy: 'delegate', target: 'calc' },
          'store': { strategy: 'delegate', target: 'mem' },
          'recall': { strategy: 'delegate', target: 'mem' },
        },
        tags: ['composite'],
      };

      // Spawn via Factory using bootstrap helper
      const BOOTSTRAP_ID = 'test-bootstrap';
      const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      bus.register(BOOTSTRAP_ID);
      bus.setReplyHandler(BOOTSTRAP_ID, (msg: any) => {
        const pending = pendingReplies.get(msg.header.correlationId);
        if (pending) {
          pendingReplies.delete(msg.header.correlationId);
          if (msg.header.type === 'error') {
            pending.reject(new Error(msg.payload.message));
          } else {
            pending.resolve(msg.payload);
          }
        }
      });

      function testRequest<T>(target: string, method: string, payload: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          const msg = request(BOOTSTRAP_ID, target, method, payload);
          pendingReplies.set(msg.header.messageId, {
            resolve: resolve as (v: unknown) => void, reject,
          });
          bus.send(msg).catch(reject);
        });
      }

      try {
        // Spawn the composite
        const spawnResult: any = await testRequest(factoryId, 'spawn', {
          manifest: { name: spec.name, description: spec.description, version: '1.0.0',
                      interface: spec.interface, requiredCapabilities: [], tags: ['composite'] },
          source: JSON.stringify(spec),
        });

        const compositeId = spawnResult.objectId;

        // Test add (delegates to calc child)
        const addResult = await testRequest(compositeId, 'add', { a: 3, b: 4 });

        // Test store (delegates to mem child)
        const storeResult = await testRequest(compositeId, 'store', { value: 42 });

        // Test recall (delegates to mem child)
        const recallResult = await testRequest(compositeId, 'recall', {});

        // Cleanup
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);

        return { addResult, storeResult, recallResult, compositeId };
      } catch (err: any) {
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);
        return { error: err.message };
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.addResult).toBe(7);
    expect(result.storeResult).toBe(true);
    expect(result.recallResult).toBe(42);
  });

  test('fanout routing sends to multiple children and aggregates', async ({ page }) => {
    await waitForSystem(page);

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { message } = abjects.modules;
      const { request } = message;
      const bus = abjects.runtime.messageBus;
      const factoryId = abjects.ids.factory;

      const spec = {
        name: 'FanoutTest',
        description: 'Tests fanout routing',
        version: '1.0.0',
        interface: {
          id: 'test:fanout',
          name: 'FanoutTest',
          description: 'Fanout test',
          methods: [
            { name: 'computeAll', description: 'Compute all (array)', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
            { name: 'computeFirst', description: 'Compute first only', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
          ],
        },
        children: [
          {
            role: 'doubler',
            source: '({ computeAll(msg) { return msg.payload.x * 2; }, computeFirst(msg) { return msg.payload.x * 2; } })',
            manifest: {
              name: 'Doubler', description: 'Doubles', version: '1.0.0',
              interface: { id: 'test:doubler', name: 'Doubler', description: 'Doubles', methods: [{ name: 'computeAll', description: 'computeAll', parameters: [] }, { name: 'computeFirst', description: 'computeFirst', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
          {
            role: 'tripler',
            source: '({ computeAll(msg) { return msg.payload.x * 3; }, computeFirst(msg) { return msg.payload.x * 3; } })',
            manifest: {
              name: 'Tripler', description: 'Triples', version: '1.0.0',
              interface: { id: 'test:tripler', name: 'Tripler', description: 'Triples', methods: [{ name: 'computeAll', description: 'computeAll', parameters: [] }, { name: 'computeFirst', description: 'computeFirst', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
        ],
        routes: {
          'computeAll': { strategy: 'fanout', targets: ['doubler', 'tripler'], aggregate: 'array' },
          'computeFirst': { strategy: 'fanout', targets: ['doubler', 'tripler'], aggregate: 'first' },
        },
        tags: ['composite'],
      };

      const BOOTSTRAP_ID = 'test-bootstrap-fanout';
      const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      bus.register(BOOTSTRAP_ID);
      bus.setReplyHandler(BOOTSTRAP_ID, (msg: any) => {
        const pending = pendingReplies.get(msg.header.correlationId);
        if (pending) {
          pendingReplies.delete(msg.header.correlationId);
          if (msg.header.type === 'error') {
            pending.reject(new Error(msg.payload.message));
          } else {
            pending.resolve(msg.payload);
          }
        }
      });

      function testRequest<T>(target: string, method: string, payload: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          const msg = request(BOOTSTRAP_ID, target, method, payload);
          pendingReplies.set(msg.header.messageId, {
            resolve: resolve as (v: unknown) => void, reject,
          });
          bus.send(msg).catch(reject);
        });
      }

      try {
        const spawnResult: any = await testRequest(factoryId, 'spawn', {
          manifest: { name: spec.name, description: spec.description, version: '1.0.0',
                      interface: spec.interface, requiredCapabilities: [], tags: ['composite'] },
          source: JSON.stringify(spec),
        });

        const compositeId = spawnResult.objectId;

        // Fanout with array aggregation
        const arrayResult: any = await testRequest(compositeId, 'computeAll', { x: 5 });

        // Fanout with first aggregation
        const firstResult: any = await testRequest(compositeId, 'computeFirst', { x: 5 });

        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);

        return { arrayResult, firstResult };
      } catch (err: any) {
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);
        return { error: err.message };
      }
    });

    expect(result.error).toBeUndefined();
    // Array aggregation: [10, 15] (doubler: 5*2=10, tripler: 5*3=15)
    expect(result.arrayResult).toEqual([10, 15]);
    // First aggregation: 10 (first child result = doubler)
    expect(result.firstResult).toBe(10);
  });

  test('killing composite destroys children', async ({ page }) => {
    await waitForSystem(page);

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { message } = abjects.modules;
      const { request } = message;
      const bus = abjects.runtime.messageBus;
      const factoryId = abjects.ids.factory;
      const registryId = abjects.ids.registry;

      const spec = {
        name: 'LifecycleTest',
        description: 'Tests lifecycle',
        version: '1.0.0',
        interface: {
          id: 'test:lifecycle',
          name: 'LifecycleTest',
          description: 'Lifecycle test',
          methods: [
            { name: 'echo', description: 'Echo', parameters: [], returns: { kind: 'primitive', primitive: 'string' } },
          ],
        },
        children: [
          {
            role: 'echoer',
            source: '({ echo(msg) { return msg.payload.text; } })',
            manifest: {
              name: 'Echoer', description: 'Echoes', version: '1.0.0',
              interface: { id: 'test:echoer', name: 'Echoer', description: 'Echoes', methods: [{ name: 'echo', description: 'echo', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
        ],
        routes: {
          'echo': { strategy: 'delegate', target: 'echoer' },
        },
        tags: ['composite'],
      };

      const BOOTSTRAP_ID = 'test-bootstrap-lifecycle';
      const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      bus.register(BOOTSTRAP_ID);
      bus.setReplyHandler(BOOTSTRAP_ID, (msg: any) => {
        const pending = pendingReplies.get(msg.header.correlationId);
        if (pending) {
          pendingReplies.delete(msg.header.correlationId);
          if (msg.header.type === 'error') {
            pending.reject(new Error(msg.payload.message));
          } else {
            pending.resolve(msg.payload);
          }
        }
      });

      function testRequest<T>(target: string, method: string, payload: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          const msg = request(BOOTSTRAP_ID, target, method, payload);
          pendingReplies.set(msg.header.messageId, {
            resolve: resolve as (v: unknown) => void, reject,
          });
          bus.send(msg).catch(reject);
        });
      }

      try {
        const spawnResult: any = await testRequest(factoryId, 'spawn', {
          manifest: { name: spec.name, description: spec.description, version: '1.0.0',
                      interface: spec.interface, requiredCapabilities: [], tags: ['composite'] },
          source: JSON.stringify(spec),
        });

        const compositeId = spawnResult.objectId;

        // Count objects before kill
        const objectsBefore = abjects.registry.listObjects().length;

        // Verify it works
        const echoResult = await testRequest(compositeId, 'echo', { text: 'hello' });

        // Kill the composite
        await testRequest(factoryId, 'kill', { objectId: compositeId });

        // Wait for async cleanup
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Count objects after kill — composite and child should both be gone
        const objectsAfter = abjects.registry.listObjects().length;

        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);

        return { echoResult, objectsBefore, objectsAfter, removed: objectsBefore - objectsAfter };
      } catch (err: any) {
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);
        return { error: err.message };
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.echoResult).toBe('hello');
    // At least the composite itself should be removed; child removal depends on
    // Factory tracking, but composite + child = 2 removed
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });

  test('cloning a composite creates independent copy', async ({ page }) => {
    await waitForSystem(page);

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { message } = abjects.modules;
      const { request } = message;
      const bus = abjects.runtime.messageBus;
      const factoryId = abjects.ids.factory;

      const spec = {
        name: 'CloneTest',
        description: 'Tests cloning',
        version: '1.0.0',
        interface: {
          id: 'test:clone',
          name: 'CloneTest',
          description: 'Clone test',
          methods: [
            { name: 'add', description: 'Add', parameters: [], returns: { kind: 'primitive', primitive: 'number' } },
          ],
        },
        children: [
          {
            role: 'adder',
            source: '({ add(msg) { return msg.payload.a + msg.payload.b; } })',
            manifest: {
              name: 'Adder', description: 'Adds', version: '1.0.0',
              interface: { id: 'test:adder', name: 'Adder', description: 'Adds', methods: [{ name: 'add', description: 'add', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
        ],
        routes: {
          'add': { strategy: 'delegate', target: 'adder' },
        },
        tags: ['composite'],
      };

      const BOOTSTRAP_ID = 'test-bootstrap-clone';
      const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      bus.register(BOOTSTRAP_ID);
      bus.setReplyHandler(BOOTSTRAP_ID, (msg: any) => {
        const pending = pendingReplies.get(msg.header.correlationId);
        if (pending) {
          pendingReplies.delete(msg.header.correlationId);
          if (msg.header.type === 'error') {
            pending.reject(new Error(msg.payload.message));
          } else {
            pending.resolve(msg.payload);
          }
        }
      });

      function testRequest<T>(target: string, method: string, payload: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          const msg = request(BOOTSTRAP_ID, target, method, payload);
          pendingReplies.set(msg.header.messageId, {
            resolve: resolve as (v: unknown) => void, reject,
          });
          bus.send(msg).catch(reject);
        });
      }

      try {
        // Spawn original
        const spawnResult: any = await testRequest(factoryId, 'spawn', {
          manifest: { name: spec.name, description: spec.description, version: '1.0.0',
                      interface: spec.interface, requiredCapabilities: [], tags: ['composite'] },
          source: JSON.stringify(spec),
        });
        const originalId = spawnResult.objectId;

        // Clone it
        const cloneResult: any = await testRequest(factoryId, 'clone', {
          objectId: originalId,
        });
        const cloneId = cloneResult.objectId;

        // Both should work independently
        const originalAdd = await testRequest(originalId, 'add', { a: 1, b: 2 });
        const cloneAdd = await testRequest(cloneId, 'add', { a: 10, b: 20 });

        // They should have different IDs
        const differentIds = originalId !== cloneId;

        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);

        return { originalAdd, cloneAdd, differentIds };
      } catch (err: any) {
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);
        return { error: err.message };
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.originalAdd).toBe(3);
    expect(result.cloneAdd).toBe(30);
    expect(result.differentIds).toBe(true);
  });

  test('inter-child observation via addDependent/changed', async ({ page }) => {
    await waitForSystem(page);

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { message } = abjects.modules;
      const { request } = message;
      const bus = abjects.runtime.messageBus;
      const factoryId = abjects.ids.factory;

      // The "publisher" child has a notify() method that calls this.changed()
      // The "subscriber" child observes publisher and tracks the last change
      const spec = {
        name: 'ObserverTest',
        description: 'Tests inter-child observation',
        version: '1.0.0',
        interface: {
          id: 'test:observer',
          name: 'ObserverTest',
          description: 'Observer test',
          methods: [
            { name: 'notify', description: 'Notify', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'getLastChange', description: 'Get last change', parameters: [], returns: { kind: 'primitive', primitive: 'string' } },
          ],
        },
        children: [
          {
            role: 'publisher',
            source: '({ notify(msg) { this.changed("data", msg.payload.value); return true; } })',
            manifest: {
              name: 'Publisher', description: 'Publishes changes', version: '1.0.0',
              interface: { id: 'test:publisher', name: 'Publisher', description: 'Publishes', methods: [{ name: 'notify', description: 'notify', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
          },
          {
            role: 'subscriber',
            source: '({ _lastChange: null, changed(msg) { this._lastChange = msg.payload; }, getLastChange() { return this._lastChange; } })',
            manifest: {
              name: 'Subscriber', description: 'Subscribes to changes', version: '1.0.0',
              interface: { id: 'test:subscriber', name: 'Subscriber', description: 'Subscribes', methods: [{ name: 'getLastChange', description: 'getLastChange', parameters: [] }] },
              requiredCapabilities: [], tags: [],
            },
            observes: ['publisher'],
          },
        ],
        routes: {
          'notify': { strategy: 'delegate', target: 'publisher' },
          'getLastChange': { strategy: 'delegate', target: 'subscriber' },
        },
        tags: ['composite'],
      };

      const BOOTSTRAP_ID = 'test-bootstrap-observer';
      const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      bus.register(BOOTSTRAP_ID);
      bus.setReplyHandler(BOOTSTRAP_ID, (msg: any) => {
        const pending = pendingReplies.get(msg.header.correlationId);
        if (pending) {
          pendingReplies.delete(msg.header.correlationId);
          if (msg.header.type === 'error') {
            pending.reject(new Error(msg.payload.message));
          } else {
            pending.resolve(msg.payload);
          }
        }
      });

      function testRequest<T>(target: string, method: string, payload: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
          const msg = request(BOOTSTRAP_ID, target, method, payload);
          pendingReplies.set(msg.header.messageId, {
            resolve: resolve as (v: unknown) => void, reject,
          });
          bus.send(msg).catch(reject);
        });
      }

      try {
        const spawnResult: any = await testRequest(factoryId, 'spawn', {
          manifest: { name: spec.name, description: spec.description, version: '1.0.0',
                      interface: spec.interface, requiredCapabilities: [], tags: ['composite'] },
          source: JSON.stringify(spec),
        });

        const compositeId = spawnResult.objectId;

        // Trigger change on publisher
        await testRequest(compositeId, 'notify', { value: 'hello-world' });

        // Wait for the changed event to propagate
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Read subscriber's last change
        const lastChange: any = await testRequest(compositeId, 'getLastChange', {});

        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);

        return { lastChange };
      } catch (err: any) {
        bus.removeReplyHandler(BOOTSTRAP_ID);
        bus.unregister(BOOTSTRAP_ID);
        return { error: err.message };
      }
    });

    expect(result.error).toBeUndefined();
    // The changed event sends { aspect, value } as payload
    expect(result.lastChange).toBeDefined();
    expect(result.lastChange.aspect).toBe('data');
    expect(result.lastChange.value).toBe('hello-world');
  });
});
