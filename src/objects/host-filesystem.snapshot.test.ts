import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { HostFileSystem } from './capabilities/host-filesystem.js';
import { ExternalCreator } from './external-creator.js';
import { ExternalProjectRegistry } from './external-project-registry.js';

// Fixture setup must also create physical .asar files under Electron.
const rawFs: typeof nodeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;
const fs = rawFs.promises;
class HeadlessCreator extends ExternalCreator { protected override async onInit(): Promise<void> {} }
class HeadlessProjects extends ExternalProjectRegistry { protected override async onInit(): Promise<void> {} }
class Client extends Abject {
  constructor() {
    super({ manifest: { name: 'Client', version: '1', description: 'Snapshot test',
      interface: { id: 'snapshot-client', name: 'Client', description: 'fixture', methods: [] },
      requiredCapabilities: [], providedCapabilities: [] } });
  }
  call(to: AbjectId, method: string, payload: unknown): Promise<any> {
    return this.request(request(this.id, to, method, payload), 5000);
  }
}

test('ExternalCreator snapshots opaque .asar bytes through messages and HostFileSystem permissions', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'abject-asar-'));
  const allowed = path.join(root, 'project'), denied = path.join(root, 'outside');
  await fs.mkdir(allowed); await fs.mkdir(denied);
  const archive = path.join(allowed, 'app.asar');
  const bytes = Buffer.from('opaque archive bytes\0\xff', 'latin1');
  await fs.writeFile(archive, bytes);
  await fs.writeFile(path.join(denied, 'private.txt'), 'not part of the project');
  await fs.symlink(denied, path.join(allowed, 'external-link'));
  const bus = new MessageBus(), registry = new Registry();
  const host = new HostFileSystem({ allowedPaths: [allowed], readOnly: true });
  const projects: any = new HeadlessProjects(), creator: any = new HeadlessCreator(), client = new Client();
  const objects: Abject[] = [registry, host, projects, creator, client];
  try {
    await registry.init(bus);
    for (const object of objects.slice(1)) {
      object.setRegistryHint(registry.id);
      await object.init(bus);
      registry.registerObject(object.id, object.manifest);
    }
    projects.projects.set('fixture', {
      name: 'fixture', root: allowed, description: 'Snapshot fixture',
      isolation: 'none', vcs: 'none', trusted: false, autonomy: 'ask',
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const extra = { taskId: 'snapshot', project: { name: 'fixture' }, workRoot: allowed, filesModified: new Set() };
    const before = await creator.projectRevision(extra);
    assert.equal(before.complete, true);
    const snapshot = await client.call(host.id, 'snapshotTree', { root: allowed });
    assert.equal(snapshot.files['app.asar'], createHash('sha256').update(bytes).digest('hex'));
    assert.equal(snapshot.files['external-link'], `symlink:${denied}`);
    assert.equal(Object.keys(snapshot.files).length, 2, 'snapshot does not follow symlinks outside the project');
    await fs.writeFile(archive, Buffer.from('updated archive'));
    const after = await creator.projectRevision(extra);
    assert.notEqual(after.revision, before.revision);
    assert(extra.filesModified.has(archive));

    const outside = { taskId: 'denied', project: { name: 'fixture' }, workRoot: denied, filesModified: new Set() };
    await assert.rejects(creator.projectRevision(outside), /not allowed/);
    await assert.rejects(client.call(host.id, 'conditionalWrite', { path: archive, expectedContent: 'updated archive', content: 'overwritten' }), /read-only/);
    await assert.rejects(client.call(projects.id, 'captureRevision', { taskId: 'snapshot' }), /owned by another caller/);
  } finally {
    for (const object of objects.reverse()) await object.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
