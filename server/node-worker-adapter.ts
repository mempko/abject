/**
 * Node.js worker_threads adapter for WorkerLike interface.
 *
 * Wraps a Node.js Worker (from worker_threads) to implement the
 * cross-platform WorkerLike interface used by WorkerBridge.
 */

import { Worker as NodeWorker } from 'node:worker_threads';
import type { WorkerLike } from '../src/runtime/worker-bridge.js';

export class NodeWorkerAdapter implements WorkerLike {
  private worker: NodeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  constructor(scriptPath: string | URL) {
    // worker_threads doesn't inherit tsx's TypeScript loader, so we use
    // eval mode to register tsx/esm/api inside the worker before importing
    // the actual script. This enables .ts file resolution and .js→.ts rewrites.
    const href = scriptPath instanceof URL ? scriptPath.href : new URL(scriptPath).href;
    this.worker = new NodeWorker(
      `import('tsx/esm/api').then(({ register }) => { register(); return import('${href}') })`,
      { eval: true },
    );

    this.worker.on('message', (data) => {
      this.onmessage?.({ data });
    });

    this.worker.on('error', (err: Error) => {
      this.onerror?.({ message: err.message });
    });
  }

  postMessage(data: unknown): void {
    this.worker.postMessage(data);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
