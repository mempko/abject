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
  onexit: ((event: { code: number }) => void) | null = null;

  constructor(scriptPath: string | URL) {
    const href = scriptPath instanceof URL ? scriptPath.href : new URL(scriptPath).href;

    const envMb = Number(process.env.ABJECTS_WORKER_MAX_OLD_SPACE_MB);
    const maxOldGenerationSizeMb = Number.isFinite(envMb) && envMb > 0 ? envMb : 8192;
    const resourceLimits = { maxOldGenerationSizeMb };

    if (process.env.ELECTRON_PACKAGED) {
      // Packaged mode: workers are pre-compiled JS. Swap .ts extension to .js.
      const jsHref = href.replace(/\.ts$/, '.js');
      this.worker = new NodeWorker(new URL(jsHref), { resourceLimits });
    } else {
      // Dev mode: worker_threads doesn't inherit tsx's TypeScript loader,
      // so we use eval mode to register tsx/esm/api inside the worker
      // before importing the actual script.
      this.worker = new NodeWorker(
        `import('tsx/esm/api').then(({ register }) => { register(); return import('${href}') })`,
        { eval: true, resourceLimits },
      );
    }

    this.worker.on('message', (data) => {
      this.onmessage?.({ data });
    });

    this.worker.on('error', (err: Error) => {
      this.onerror?.({ message: err.message });
    });

    this.worker.on('exit', (code: number) => {
      this.onexit?.({ code });
    });
  }

  postMessage(data: unknown, transferList?: unknown[]): void {
    if (transferList && transferList.length > 0) {
      this.worker.postMessage(data, transferList as import('node:worker_threads').TransferListItem[]);
    } else {
      this.worker.postMessage(data);
    }
  }

  terminate(): void {
    this.worker.terminate();
  }
}
