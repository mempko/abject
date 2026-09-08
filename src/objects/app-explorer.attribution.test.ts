import test from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectRegistration } from '../core/types.js';
import {
  appExplorerPeerAttributionLabels,
  normalizeAppExplorerEntries,
  resolveAppExplorerPeerAttribution,
} from './app-explorer.js';

function registration(overrides: Partial<ObjectRegistration> = {}): ObjectRegistration {
  return {
    id: 'object-1',
    manifest: {
      name: 'RemoteApp',
      description: 'A remote app',
      version: '1.0.0',
      interfaces: [],
      requiredCapabilities: [],
      providedCapabilities: [],
      tags: ['app'],
    },
    state: 'running',
    registeredAt: Date.now(),
    ...overrides,
  } as ObjectRegistration;
}

test('peer attribution labels are entry-derived and independent of AppExplorer tab state', () => {
  const entry = registration({
    ownerPeerId: 'peer-123456789',
    workspaceId: 'workspace-1',
    workspaceName: 'Research Lab',
  } as Partial<ObjectRegistration>);
  const peerNames = new Map([['peer-123456789', 'Maxim’s Laptop']]);

  assert.deepEqual(appExplorerPeerAttributionLabels(entry, peerNames), [
    'Owner peer ID: peer-123456789',
    'Peer name: Maxim’s Laptop',
    'Origin workspace: Research Lab',
  ]);
  assert.deepEqual(resolveAppExplorerPeerAttribution(entry, peerNames), {
    ownerPeerId: 'peer-123456789',
    peerName: 'Maxim’s Laptop',
    originWorkspace: 'Research Lab',
  });
});

test('local entries without peer provenance do not receive attribution', () => {
  const entry = registration();
  assert.equal(resolveAppExplorerPeerAttribution(entry, new Map()), undefined);
  assert.deepEqual(appExplorerPeerAttributionLabels(entry, new Map()), []);
});

test('direct remote browse normalization preserves registrations and canonical provenance', () => {
  const entry = registration({ data: { retained: true } });
  const [normalized] = normalizeAppExplorerEntries([entry], {
    ownerPeerId: 'peer-remote',
    workspaceId: 'workspace-remote',
    workspaceName: 'Remote Workspace',
  });

  assert.equal(normalized.id, entry.id);
  assert.deepEqual(normalized.data, { retained: true });
  assert.equal(normalized.ownerPeerId, 'peer-remote');
  assert.equal((normalized as ObjectRegistration & { workspaceId?: string }).workspaceId, 'workspace-remote');
  assert.equal((normalized as ObjectRegistration & { workspaceName?: string }).workspaceName, 'Remote Workspace');
});

test('normalization does not overwrite provenance already carried by an entry', () => {
  const entry = registration({
    ownerPeerId: 'peer-original',
    workspaceId: 'workspace-original',
    workspaceName: 'Original Workspace',
  } as Partial<ObjectRegistration>);
  const [normalized] = normalizeAppExplorerEntries([entry], {
    ownerPeerId: 'peer-context',
    workspaceId: 'workspace-context',
    workspaceName: 'Context Workspace',
  });

  assert.strictEqual(normalized, entry);
  assert.equal(normalized.ownerPeerId, 'peer-original');
});
