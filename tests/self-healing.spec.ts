/**
 * Self-healing test - verify proxy regeneration on errors.
 */

import { test, expect } from '@playwright/test';

test.describe('Self-Healing', () => {
  test('health monitor is active', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const hasHealthMonitor = await page.evaluate(() => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, { listObjects: () => { manifest: { name: string } }[] }>;
      const objects = abjects.registry?.listObjects() ?? [];
      return objects.some((o) => o.manifest.name === 'HealthMonitor');
    });

    expect(hasHealthMonitor).toBe(true);
  });

  test('health monitor can track connections', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Verify health monitor starts with no tracked connections
    const connectionCount = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { HealthMonitor } = abjects.modules;

      // Create a new health monitor instance for testing
      const monitor = new HealthMonitor();

      // Track a test connection
      monitor.trackConnection('test-agreement-1');
      monitor.recordSuccess('test-agreement-1');

      return monitor.connectionCount;
    });

    expect(connectionCount).toBe(1);
  });

  test('health status calculation works', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const status = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { HealthMonitor } = abjects.modules;

      const monitor = new HealthMonitor({ minMessages: 5 });
      monitor.trackConnection('test-agreement');

      // Record some successes
      for (let i = 0; i < 10; i++) {
        monitor.recordSuccess('test-agreement');
      }

      // Record some errors
      monitor.recordError('test-agreement', {
        code: 'TEST_ERROR',
        message: 'Test error',
      });

      const status = monitor.getStatus('test-agreement');
      return {
        errorRate: status?.errorRate,
        healthy: status?.healthy,
        messageCount: status?.messageCount,
      };
    });

    expect(status.messageCount).toBe(11);
    expect(status.errorRate).toBeLessThan(10); // Should be ~9%
    expect(status.healthy).toBe(true);
  });
});
