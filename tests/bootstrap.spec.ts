/**
 * Bootstrap test - verify system boots correctly.
 */

import { test, expect } from '@playwright/test';

test.describe('Bootstrap', () => {
  test('system boots and core objects register', async ({ page }) => {
    await page.goto('/');

    // Wait for the system to initialize
    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Check that runtime is available
    const hasRuntime = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      return abjects.runtime !== undefined;
    });
    expect(hasRuntime).toBe(true);

    // Check that registry has objects
    const objectCount = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { objectCount: number }>;
      return abjects.registry?.objectCount ?? 0;
    });
    expect(objectCount).toBeGreaterThanOrEqual(2);

    // Check that core objects are registered
    const coreObjects = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.map((o: { manifest: { name: string } }) => o.manifest.name);
    });

    expect(coreObjects).toContain('Registry');
    expect(coreObjects).toContain('Factory');
  });

  test('capability objects are available', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const capabilities = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.map((o: { manifest: { name: string } }) => o.manifest.name);
    });

    expect(capabilities).toContain('HttpClient');
    expect(capabilities).toContain('Storage');
    expect(capabilities).toContain('Timer');
    expect(capabilities).toContain('Console');
    expect(capabilities).toContain('FileSystem');
  });

  test('UI server is running', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Check that UIServer is registered
    const hasUIServer = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.some((o: { manifest: { name: string } }) => o.manifest.name === 'UIServer');
    });

    expect(hasUIServer).toBe(true);
  });
});
