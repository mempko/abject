/**
 * Application shell - bootstraps the UI in the browser.
 */

import { Runtime, getRuntime } from '../runtime/runtime.js';
import { Compositor } from './compositor.js';
import { UIServer } from '../objects/ui-server.js';
import { require } from '../core/contracts.js';

export interface AppConfig {
  container: HTMLElement | string;
  debug?: boolean;
}

/**
 * The main application class.
 */
export class App {
  private runtime: Runtime;
  private compositor: Compositor;
  private uiServer: UIServer;
  private canvas: HTMLCanvasElement;

  constructor(config: AppConfig) {
    const container =
      typeof config.container === 'string'
        ? document.querySelector(config.container)
        : config.container;

    require(container !== null, 'Container element not found');

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container!.appendChild(this.canvas);

    // Create compositor
    this.compositor = new Compositor(this.canvas);

    // Create UI server
    this.uiServer = new UIServer();
    this.uiServer.setCompositor(this.compositor);

    // Create runtime
    this.runtime = getRuntime({ debug: config.debug });
    this.runtime.registerCoreObject(this.uiServer);
  }

  /**
   * Start the application.
   */
  async start(): Promise<void> {
    // Start runtime
    await this.runtime.start();

    // Setup input listeners
    this.uiServer.setupInputListeners(this.canvas);

    console.log('[APP] Abjects application started');
  }

  /**
   * Stop the application.
   */
  async stop(): Promise<void> {
    this.compositor.stop();
    await this.runtime.stop();
    console.log('[APP] Abjects application stopped');
  }

  /**
   * Get the runtime.
   */
  get appRuntime(): Runtime {
    return this.runtime;
  }

  /**
   * Get the compositor.
   */
  get appCompositor(): Compositor {
    return this.compositor;
  }

  /**
   * Get the UI server.
   */
  get appUIServer(): UIServer {
    return this.uiServer;
  }

  /**
   * Get canvas dimensions.
   */
  get width(): number {
    return this.compositor.width;
  }

  get height(): number {
    return this.compositor.height;
  }
}

/**
 * Create and start the application.
 */
export async function createApp(config: AppConfig): Promise<App> {
  const app = new App(config);
  await app.start();
  return app;
}
