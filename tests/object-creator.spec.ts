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

  test.skip('object creator generates code from prompt', async ({ page }) => {
    // This test requires LLM API key
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Would test: create a simple counter object
    // Requires ANTHROPIC_API_KEY or OPENAI_API_KEY
  });
});
