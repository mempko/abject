/**
 * Object Creator test - verify user can create objects via prompt.
 */

import { test, expect } from '@playwright/test';

test.describe('Object Creator', () => {
  test('object creator is registered', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const hasObjectCreator = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { getAllObjects: () => Array<{ manifest: { name: string } }> };
      const allObjs = factory.getAllObjects();
      return allObjs.some((o) => o.manifest.name === 'ObjectCreator');
    });

    expect(hasObjectCreator).toBe(true);
  });

  test('object creator can list available objects', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const objectCount = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { getAllObjects: () => Array<{ manifest: { name: string }; listAvailableObjects?: () => Promise<unknown[]> }> };
      const creator = factory.getAllObjects().find((o) => o.manifest.name === 'ObjectCreator') as
        { listAvailableObjects: () => Promise<unknown[]> } | undefined;
      if (!creator) return 0;
      const objects = await creator.listAvailableObjects();
      return objects?.length ?? 0;
    });

    expect(objectCount).toBeGreaterThan(0);
  });

  test('object creator can get object graph', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const graph = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { getAllObjects: () => Array<{ manifest: { name: string }; getObjectGraph?: () => Promise<{ nodes: unknown[] }> }> };
      const creator = factory.getAllObjects().find((o) => o.manifest.name === 'ObjectCreator') as
        { getObjectGraph: () => Promise<{ nodes: unknown[] }> } | undefined;
      if (!creator) return undefined;
      return await creator.getObjectGraph();
    });

    expect(graph).toBeDefined();
    expect(graph!.nodes.length).toBeGreaterThan(0);
  });

  test('object creator generates ScriptableAbject from prompt', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    test.skip(!apiKey, 'Requires ANTHROPIC_API_KEY in .env.test');

    // Inject key before page loads
    await page.addInitScript((key) => {
      (window as Record<string, unknown>).ANTHROPIC_API_KEY = key;
    }, apiKey);

    // Capture browser console for debugging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warn') {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { getAllObjects: () => Array<{ manifest: { name: string }; createObject?: (prompt: string) => Promise<unknown> }> };
      const objectCreator = factory.getAllObjects().find((o) => o.manifest.name === 'ObjectCreator') as {
        createObject: (prompt: string) => Promise<{
          success: boolean;
          objectId?: string;
          manifest?: { name: string };
          code?: string;
          error?: string;
        }>;
      } | undefined;

      if (!objectCreator) {
        return {
          success: false,
          error: 'ObjectCreator not found in factory',
          code: undefined,
          objectId: undefined,
          manifest: undefined,
          _debug: 'ObjectCreator not found',
        };
      }

      try {
        const r = await objectCreator.createObject(
          'A simple greeting object with one method called greet that accepts a name parameter and returns a greeting string. Keep it very simple, plain JavaScript only.'
        );
        // If it failed, also try to return more diagnostic info
        if (!r.success) {
          // Try to get raw LLM output for debugging
          (r as Record<string, unknown>)._debug = 'createObject returned failure';
        }
        return r;
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          code: undefined,
          objectId: undefined,
          manifest: undefined,
          _debug: err instanceof Error ? err.stack : undefined,
        };
      }
    }, { timeout: 90000 });

    if (!result.success) {
      console.error('Creation failed:', JSON.stringify(result));
      console.error('Browser logs:', consoleLogs.join('\n'));
    }
    expect(result.success).toBe(true);
    expect(result.objectId).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.code).toBeDefined();

    // Verify the object exists (spawned via Factory)
    const isSpawned = await page.evaluate((objectId) => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const factory = abjects.factory as { getObject: (id: string) => unknown | undefined };
      return factory.getObject(objectId) !== undefined;
    }, result.objectId);

    expect(isSpawned).toBe(true);
  });
});
