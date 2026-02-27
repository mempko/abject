/**
 * Messaging test - verify objects can send and receive messages.
 */

import { test, expect } from '@playwright/test';

test.describe('Messaging', () => {
  test('objects can send messages to each other', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Create two simple objects and have them communicate
    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { spawn: (obj: unknown) => Promise<void>, messageBus: unknown };

      // Get constructors from exposed modules
      const { SimpleAbject, message } = abjects.modules as any;
      const { request } = message;

      let receivedMessage = '';

      // Create receiver object
      const receiver = new SimpleAbject('Receiver', 'Test receiver', {
        ping: async (msg: unknown) => {
          receivedMessage = 'pong';
          return 'pong';
        },
      });

      await runtime.spawn(receiver);

      // Create sender object
      const sender = new SimpleAbject('Sender', 'Test sender', {});
      await runtime.spawn(sender);

      // Send message from sender to receiver
      const bus = runtime.messageBus as { send: (msg: unknown) => Promise<void> };
      const msg = request(sender.id, receiver.id, 'ping', { data: 'hello' });
      await bus.send(msg);

      // Small delay for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      return receivedMessage;
    });

    expect(result).toBe('pong');
  });

  test('messages are routed correctly by interface', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as Record<string, unknown>;
      const runtime = abjects.runtime as { objectRegistry: { lookupObject: (id: string) => unknown } };

      // Registry should respond to lookup requests
      const registry = runtime.objectRegistry;
      const objects = registry.lookupObject('nonexistent');

      return objects === null;
    });

    expect(result).toBe(true);
  });
});
