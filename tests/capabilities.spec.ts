/**
 * Capabilities test - verify capability objects work.
 */

import { test, expect } from '@playwright/test';

test.describe('Capabilities', () => {
  test('Storage can store and retrieve values', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const storage = abjects.storage;

      // Use the already-initialized storage instance
      await storage.setValue('testKey', { hello: 'world' });
      const value = await storage.getValue('testKey');
      const exists = await storage.hasKey('testKey');
      const keys = await storage.getKeys();

      return {
        value,
        exists,
        keyCount: keys.length,
      };
    });

    expect(result.value).toEqual({ hello: 'world' });
    expect(result.exists).toBe(true);
    // Global Storage may also contain workspace metadata keys (workspaces:list, workspaces:active)
    expect(result.keyCount).toBeGreaterThanOrEqual(1);
  });

  test('Timer schedules callbacks', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { Timer } = abjects.modules;

      const timer = new Timer();
      const objectId = 'test-object';

      // Schedule a timer
      const timerId = timer.scheduleTimeout(objectId, 100);

      // Check timer info
      const info = timer.getTimerInfo(timerId);

      // Wait for timer to fire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Timer should be gone after firing
      const afterInfo = timer.getTimerInfo(timerId);

      return {
        scheduled: info !== null,
        fired: afterInfo === null,
      };
    });

    expect(result.scheduled).toBe(true);
    expect(result.fired).toBe(true);
  });

  test('Console logs messages', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { Console } = abjects.modules;

      const console = new Console();
      console.log('info', 'test-object', 'Test message', { data: 123 });
      console.log('error', 'test-object', 'Error message');

      const logs = console.getLogs();
      const infoLogs = console.getLogs(undefined, 'info');

      return {
        totalLogs: logs.length,
        infoLogs: infoLogs.length,
      };
    });

    expect(result.totalLogs).toBe(2);
    expect(result.infoLogs).toBe(1);
  });

  test('FileSystem creates and reads files', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { FileSystem } = abjects.modules;

      const fs = new FileSystem();

      // Create directory
      fs.mkdir('/test');

      // Write file
      fs.writeFile('/test/hello.txt', 'Hello, World!');

      // Read file
      const content = fs.readFile('/test/hello.txt');

      // List directory
      const files = fs.readdir('/test');

      // Check exists
      const exists = fs.exists('/test/hello.txt');

      // Get stat
      const stat = fs.stat('/test/hello.txt');

      return {
        content,
        fileCount: files.length,
        exists,
        isFile: stat?.isDirectory === false,
      };
    });

    expect(result.content).toBe('Hello, World!');
    expect(result.fileCount).toBe(1);
    expect(result.exists).toBe(true);
    expect(result.isFile).toBe(true);
  });

  test.skip('HttpClient makes requests', async ({ page }) => {
    // This test requires actual network access
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Would test actual HTTP requests
    // Requires CORS-enabled endpoint or proxy
  });
});
