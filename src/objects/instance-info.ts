/**
 * InstanceInfo — what this instance is and whether it is up, for abjects.
 *
 * An abject that reports on its instance (a control-plane link sending a
 * heartbeat, a status page) needs the running version and readiness without
 * reading files or the environment, which the script sandbox cannot do. The
 * same answer backs the local health endpoint (GET /healthz on the UI port),
 * so the two never disagree.
 */

import { AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';

export interface InstanceInfoSource {
  /** The Abject release this instance runs. */
  version: string;
  startedAt: number;
  /** Pool workers (0: everything on the main thread). */
  workerCount: number;
  /** True once boot has finished and the instance serves. */
  ready(): boolean;
}

export interface InstanceInfoReport {
  version: string;
  ready: boolean;
  startedAt: number;
  uptimeSec: number;
  node: string;
  platform: string;
  arch: string;
  workerCount: number;
}

export function instanceReport(source: InstanceInfoSource): InstanceInfoReport {
  return {
    version: source.version,
    ready: source.ready(),
    startedAt: source.startedAt,
    uptimeSec: Math.round((Date.now() - source.startedAt) / 1000),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    workerCount: source.workerCount,
  };
}

export class InstanceInfo extends Abject {
  constructor(private readonly source: InstanceInfoSource) {
    super({
      manifest: {
        name: 'InstanceInfo',
        description:
          'This instance\'s running version, whether it has finished booting, uptime, Node version, platform, and worker count. ' +
          'Ask it for the version an abject should report.',
        version: '1.0.0',
        interface: {
          id: 'abjects:instance-info' as InterfaceId,
          name: 'InstanceInfo',
          description: 'Version and readiness of this instance',
          methods: [
            {
              name: 'getInfo',
              description: 'Returns { version, ready, startedAt, uptimeSec, node, platform, arch, workerCount }.',
              parameters: [],
              returns: { kind: 'object', properties: {} },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system'],
      },
    });
    this.on('getInfo', (_msg: AbjectMessage) => instanceReport(this.source));
  }
}
