/**
 * A workspace created while the server runs spawns its WebExposure before
 * WorkspaceManager lists it, so the first lookup of the workspace's name finds
 * nothing. The name must still be found on a later lookup, or the gateway
 * routes the workspace under its id (`/ws-1a2b3c4d/`) for the rest of the run.
 *
 * Run: npx tsx --test src/objects/web-exposure.workspace-name.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebExposure } from './web-exposure.js';
import type { AbjectMessage } from '../core/types.js';

test('the workspace name is looked up again until WorkspaceManager lists the workspace', async () => {
  const exposure = new WebExposure();
  let listed = false;
  const any = exposure as unknown as {
    widgetManagerId: string;
    workspaceManagerId: string;
    workspaceName: string;
    request(msg: AbjectMessage): Promise<unknown>;
    ensureWorkspaceId(): Promise<string | undefined>;
  };
  any.widgetManagerId = 'wm-widgets';
  any.workspaceManagerId = 'wm';
  any.request = async (msg: AbjectMessage) => {
    const method = (msg.routing as { method?: string }).method;
    if (method === 'getObjectWorkspace') return 'ws-1';
    if (method === 'listWorkspaces') return listed ? [{ id: 'ws-1', name: 'org-acme' }] : [];
    throw new Error(`unexpected ${method}`);
  };

  assert.equal(await any.ensureWorkspaceId(), 'ws-1');
  assert.equal(any.workspaceName, '', 'not listed yet');
  listed = true;
  assert.equal(await any.ensureWorkspaceId(), 'ws-1');
  assert.equal(any.workspaceName, 'org-acme');
});
