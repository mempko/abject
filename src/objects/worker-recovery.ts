/**
 * WorkerRecovery — rebuilds what a crashed worker thread took with it.
 *
 * A pool worker that runs out of memory or throws its way out takes every
 * object it hosted: a workspace's registry and storage, its agents, MCP
 * bridges, user objects. The pool cuts the routes and replaces the thread;
 * this object is told what was lost and puts it back, through the objects
 * that own each kind of thing:
 *
 *   - WorkspaceManager respawns any workspace that lost part of itself,
 *     restores that workspace's user objects from snapshots, and fails the
 *     goals that were running there with a reason a person can act on.
 *   - SkillRegistry respawns the MCP bridges that died.
 *   - The Supervisor is told about its own children immediately, instead of
 *     finding out after a run of missed pings.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { withKeyedLock } from '../core/keyed-lock.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WorkerRecovery');

export interface RecoveryReport {
  workerIndex: number;
  lost: number;
  workspaces: Array<{ workspaceId: string; name: string; lost: number; restored: number; goalsFailed: number }>;
  bridges: number;
  supervised: number;
}

export class WorkerRecovery extends Abject {
  constructor() {
    super({
      manifest: {
        name: 'WorkerRecovery',
        description: 'Rebuilds what a crashed worker thread took with it: respawns affected workspaces, restores their user objects from snapshots, restarts lost MCP bridges, notifies the Supervisor, and fails the goals that were running there with a clear reason.',
        version: '1.0.0',
        interface: {
          id: 'abjects:worker-recovery' as InterfaceId,
          name: 'WorkerRecovery',
          description: 'Recovery after a worker thread dies',
          methods: [
            {
              name: 'workerLost',
              description: 'A worker thread has died and been replaced; rebuild the objects it hosted. Returns a report of what was respawned.',
              parameters: [
                { name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Ids of the objects the worker hosted' },
                { name: 'workerIndex', type: { kind: 'primitive', primitive: 'number' }, description: 'Which pool worker died', optional: true },
                { name: 'reason', type: { kind: 'primitive', primitive: 'string' }, description: 'Why it died, as far as the runtime knows', optional: true },
              ],
              returns: { kind: 'object', properties: {} },
            },
          ],
          events: [
            { name: 'recovered', description: 'Recovery after a worker death finished; payload is the report', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'runtime'],
      },
    });
    this.on('workerLost', async (msg: AbjectMessage) => {
      const { objectIds, workerIndex, reason } = msg.payload as { objectIds: AbjectId[]; workerIndex?: number; reason?: string };
      if (!Array.isArray(objectIds) || objectIds.length === 0) return { workerIndex: workerIndex ?? -1, lost: 0, workspaces: [], bridges: 0, supervised: 0 };
      // Two deaths in a row recover one after the other, never interleaved.
      return withKeyedLock(`${this.id}:recovery`, () => this.rebuild(objectIds, workerIndex ?? -1, reason ?? 'worker exited'));
    });
  }

  private async rebuild(objectIds: AbjectId[], workerIndex: number, why: string): Promise<RecoveryReport> {
    const report: RecoveryReport = { workerIndex, lost: objectIds.length, workspaces: [], bridges: 0, supervised: 0 };
    const reason = `A worker thread crashed (${why}) and took ${objectIds.length} objects with it; the workspace was rebuilt from its snapshots. Work in flight at the time is lost. Start the goal again.`;
    log.warn(`worker ${workerIndex} died (${why}); rebuilding ${objectIds.length} lost objects`);

    const supervisorId = await this.discoverDep('Supervisor');
    if (supervisorId) {
      try {
        const children = await this.request<Array<{ id?: AbjectId; childId?: AbjectId }>>(
          request(this.id, supervisorId, 'getChildren', {}), 15_000);
        const lost = new Set(objectIds);
        for (const child of children ?? []) {
          const id = child.id ?? child.childId;
          if (!id || !lost.has(id)) continue;
          this.send(request(this.id, supervisorId, 'childFailed', { childId: id, error: { code: 'WORKER_DEAD', message: reason } }));
          report.supervised++;
        }
      } catch (err) {
        log.warn(`Supervisor not consulted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const workspaceManagerId = await this.discoverDep('WorkspaceManager');
    if (workspaceManagerId) {
      try {
        const res = await this.request<{ workspaces: RecoveryReport['workspaces'] }>(
          request(this.id, workspaceManagerId, 'recoverLostObjects', { objectIds, reason }), 600_000);
        report.workspaces = res?.workspaces ?? [];
      } catch (err) {
        log.error(`workspace recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const skillRegistryId = await this.discoverDep('SkillRegistry');
    if (skillRegistryId) {
      try {
        const res = await this.request<{ respawned: number }>(
          request(this.id, skillRegistryId, 'respawnLostBridges', { objectIds }), 300_000);
        report.bridges = res?.respawned ?? 0;
      } catch (err) {
        log.error(`bridge recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ws = report.workspaces.map(w => `${w.name}: ${w.restored} objects restored, ${w.goalsFailed} goals failed`).join('; ') || 'no workspace affected';
    log.warn(`recovery after worker ${workerIndex}: ${ws}; ${report.bridges} MCP bridge(s) respawned; ${report.supervised} supervised object(s) reported`);
    this.changed('recovered', report);
    return report;
  }
}

export const WORKER_RECOVERY_ID = 'abjects:worker-recovery' as AbjectId;
