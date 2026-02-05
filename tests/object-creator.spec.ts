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
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.some((o) => o.manifest.name === 'ObjectCreator');
    });

    expect(hasObjectCreator).toBe(true);
  });

  test('object creator can list available objects', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const objectCount = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { objectCreator: { listAvailableObjects: () => Promise<unknown[]> } }>;
      const objects = await abjects.objectCreator?.listAvailableObjects();
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
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { objectCreator: { getObjectGraph: () => Promise<{ nodes: unknown[] }> } }>;
      return await abjects.objectCreator?.getObjectGraph();
    });

    expect(graph).toBeDefined();
    expect(graph.nodes.length).toBeGreaterThan(0);
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
      const objectCreator = abjects.objectCreator as {
        createObject: (prompt: string) => Promise<{
          success: boolean;
          objectId?: string;
          manifest?: { name: string };
          code?: string;
          error?: string;
        }>;
      };

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

    // Verify the object is registered in the registry
    const isRegistered = await page.evaluate((objectId) => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, {
        registry: { lookupObject: (id: string) => { source?: string } | null };
      }>;
      const reg = abjects.registry?.lookupObject(objectId);
      return reg !== null && reg?.source !== undefined;
    }, result.objectId);

    expect(isRegistered).toBe(true);
  });
});
