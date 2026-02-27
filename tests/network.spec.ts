/**
 * Network test - verify cross-machine communication via WebSocket.
 */

import { test, expect } from '@playwright/test';

test.describe('Network', () => {
  test('MockTransport can send messages', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { MockTransport, message } = abjects.modules;
      const { request } = message;

      // Create pair of mock transports
      const [transportA, transportB] = MockTransport.pair();

      let receivedMessage: unknown = null;

      // Set up receiver
      transportB.on({
        onMessage: (msg) => {
          receivedMessage = msg;
        },
      });

      // Connect both
      await transportA.connect('mock://peer-b');
      await transportB.connect('mock://peer-a');

      // Send message
      const msg = request('object-a', 'object-b', 'hello', { data: 'test' });
      await transportA.send(msg);

      // Wait for message
      await new Promise((resolve) => setTimeout(resolve, 50));

      return {
        received: receivedMessage !== null,
        payload: (receivedMessage as { payload?: unknown })?.payload,
      };
    });

    expect(result.received).toBe(true);
    expect(result.payload).toEqual({ data: 'test' });
  });

  test('Transport state management works', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const abjects = (window as Record<string, unknown>).abjects as any;
      const { MockTransport } = abjects.modules;

      const transport = new MockTransport();

      const states: string[] = [];
      transport.on({
        onStateChange: (state) => states.push(state),
      });

      // Initial state
      const initialState = transport.connectionState;

      // Connect
      await transport.connect('mock://test');
      const connectedState = transport.connectionState;

      // Disconnect
      await transport.disconnect();
      const disconnectedState = transport.connectionState;

      return {
        initialState,
        connectedState,
        disconnectedState,
        stateTransitions: states,
      };
    });

    expect(result.initialState).toBe('disconnected');
    expect(result.connectedState).toBe('connected');
    expect(result.disconnectedState).toBe('disconnected');
    expect(result.stateTransitions).toContain('connecting');
    expect(result.stateTransitions).toContain('connected');
    expect(result.stateTransitions).toContain('disconnected');
  });

  test.skip('WebSocket transport connects', async ({ page }) => {
    // This test requires a WebSocket server
    await page.goto('/');

    await page.waitForFunction(() => {
      return (window as Record<string, unknown>).abjects !== undefined;
    }, { timeout: 10000 });

    // Would test actual WebSocket connection
    // Requires running WebSocket server
  });
});
