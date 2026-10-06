/**
 * Deleting a shared workspace must announce that it is no longer shared, or
 * WorkspaceShareRegistry keeps offering it to peers: a workspace recreated
 * under the same name (an organization restored from a backup, say) then
 * loses to the dead entry and its peers cannot reach it.
 *
 * Run: npx tsx --test src/objects/workspace-manager.delete-shared.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceManager, type WorkspaceInfo } from './workspace-manager.js';
import type { AbjectId, TypeId } from '../core/types.js';

function ws(id: string, accessMode: WorkspaceInfo['accessMode']): WorkspaceInfo {
  return {
    id, name: `ws-${id}`, description: '', tags: [], accessMode, whitelist: ['p'.repeat(64)],
    exposedObjectIds: [], exposedTypeIds: [] as TypeId[], childIds: [], registryId: `reg-${id}` as AbjectId,
    storageId: `sto-${id}` as AbjectId, taskbarId: undefined as unknown as AbjectId, uiObjects: [],
    childTypeIds: new Map(), uiSpawned: false, profile: 'default', profileObjects: [], profileUi: [],
  } as WorkspaceInfo;
}

function manager(...list: WorkspaceInfo[]) {
  const wm = new WorkspaceManager() as unknown as Record<string, unknown> & {
    workspaces: Map<string, WorkspaceInfo>;
    deleteWorkspace(id: string): Promise<boolean>;
  };
  for (const w of list) wm.workspaces.set(w.id, w);
  const announced: Array<{ aspect: string; value: unknown }> = [];
  wm.changed = (aspect: string, value: unknown) => { announced.push({ aspect, value }); };
  wm.persistWorkspaceList = async () => {};
  wm.persistActiveWorkspaceId = async () => {};
  wm.dropShareRegistryEntry = async () => {};
  wm.refreshTaskbar = async () => {};
  wm.request = async () => undefined;
  wm.activeWorkspaceId = 'keep';
  return { wm, announced };
}

test('deleting a shared workspace announces that it is no longer shared', async () => {
  const { wm, announced } = manager(ws('keep', 'local'), ws('org', 'shared'));
  assert.equal(await wm.deleteWorkspace('org'), true);
  assert.deepEqual(announced.filter(a => a.aspect === 'workspaceUnshared'), [{ aspect: 'workspaceUnshared', value: { workspaceId: 'org', name: 'ws-org' } }]);
});

test('deleting a local workspace announces nothing about sharing', async () => {
  const { wm, announced } = manager(ws('keep', 'local'), ws('mine', 'local'));
  await wm.deleteWorkspace('mine');
  assert.equal(announced.filter(a => a.aspect === 'workspaceUnshared').length, 0);
});
