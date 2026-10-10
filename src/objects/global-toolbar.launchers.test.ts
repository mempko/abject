/**
 * Which abjects get a row in the dock's System section: a local abject tagged
 * `launcher` that can `show` and `hide` (a system-scope package with a
 * window, say). Remote entries and abjects without both methods do not.
 *
 * Run: npx tsx --test src/objects/global-toolbar.launchers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchersFrom } from './global-toolbar.js';
import type { AbjectId, ObjectRegistration } from '../core/types.js';

function reg(name: string, opts: { tags?: string[]; methods?: string[]; icon?: string; ownerPeerId?: string } = {}): ObjectRegistration {
  return {
    id: `id-${name}` as AbjectId,
    name,
    status: 'ready',
    registeredAt: 0,
    ...(opts.ownerPeerId ? { ownerPeerId: opts.ownerPeerId } : {}),
    manifest: {
      name, description: '', version: '1.0.0', 
      tags: opts.tags ?? ['launcher'],
      ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
      interface: {
        id: `iface-${name}`,
        name,
        description: '',
        methods: (opts.methods ?? ['show', 'hide']).map(m => ({ name: m, description: '', parameters: [] })),
      },
    },
  } as unknown as ObjectRegistration;
}

test('local abjects tagged launcher with show and hide get a row, by name', () => {
  const rows = launchersFrom([
    reg('Zeta', { icon: '🛰️' }),
    reg('Alpha', { icon: '🏢' }),
  ]);
  assert.deepEqual(rows, [
    { id: 'id-Alpha', name: 'Alpha', icon: '🏢' },
    { id: 'id-Zeta', name: 'Zeta', icon: '🛰️' },
  ]);
});

test('untagged, window-less and remote abjects get none; a missing icon falls back', () => {
  const rows = launchersFrom([
    reg('Plain', { tags: ['system'] }),
    reg('NoHide', { methods: ['show'] }),
    reg('Remote', { ownerPeerId: 'p'.repeat(64) }),
    reg('Blank', { icon: '  ' }),
  ]);
  assert.deepEqual(rows, [{ id: 'id-Blank', name: 'Blank', icon: '▣' }]);
});
