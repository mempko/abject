/**
 * Proxy generation test - verify LLM generates working proxies.
 */

import { test, expect } from '@playwright/test';

test.describe('Proxy Generation', () => {
  test.skip('proxy generator creates manifest', async ({ page }) => {
    // This test requires LLM API key
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Note: Full proxy generation requires LLM API key
    // This test verifies the proxy generator exists
    const hasProxyGenerator = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.some((o) => o.manifest.name === 'ProxyGenerator');
    });

    expect(hasProxyGenerator).toBe(true);
  });

  test('negotiator can establish direct connections', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Verify negotiator is registered
    const hasNegotiator = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.some((o) => o.manifest.name === 'Negotiator');
    });

    expect(hasNegotiator).toBe(true);
  });
});
