import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRouter } from './peer-router.js';

// P2-2: allowedSystemObjects is a curation bypass, so admission is restricted to
// the well-known signaling/routing objects and scoped to their method sets.

test('an arbitrary object cannot be admitted to the bypass set', () => {
  const r = new PeerRouter() as any;
  r.allowSystemObjectDirect('llm-uuid', 'abjects:llm', 'type:LLMObject');
  assert.equal(r.allowedSystemObjects.has('llm-uuid'), false);
  r.allowSystemObjectDirect('bare-uuid');
  assert.equal(r.allowedSystemObjects.has('bare-uuid'), false);
  assert.equal(r.allowedSystemObjects.size, 0);
});

test('the bus-reachable allowSystemObject handler is gone', () => {
  const r = new PeerRouter() as any;

  // `handlers` is the protected dispatch map on Abject, populated by
  // setupHandlers() in the constructor. If a bus-reachable widening path
  // existed, it would have to be registered here.
  const handlers = r.handlers;
  assert.ok(handlers instanceof Map, 'handlers dispatch map is readable');
  assert.ok(handlers.size > 0, 'handlers map is populated at construction');
  assert.equal(handlers.has('allowSystemObject'), false);

  // AbjectManifest declares a SINGULAR `interface: InterfaceDeclaration`
  // (src/core/types.ts) whose `methods` array is the advertised surface.
  // `manifest` is a public readonly property assigned in Abject's constructor,
  // so it is readable off a bare instance without init(bus).
  const mf = r.manifest;
  assert.ok(mf && mf.interface && Array.isArray(mf.interface.methods), 'manifest interface methods are readable');
  const methods = mf.interface.methods;
  assert.ok(methods.length > 0);
  assert.equal(methods.some((m: any) => m.name === 'allowSystemObject'), false);
  // sanity: the manifest we are reading really is PeerRouter's routing surface
  assert.ok(methods.some((m: any) => m.name === 'registerRoute'), 'manifest is PeerRouter\u2019s own');
});

test('a permitted system object is not a universal proxy', () => {
  const r = new PeerRouter() as any;
  r.allowSystemObjectDirect('wsr-uuid', 'abjects:workspace-share-registry', 'type:WSR');
  assert.equal(r.allowedSystemObjects.has('wsr-uuid'), true);
  // signaling method: allowed
  assert.equal(r.checkInboundPermission('wsr-uuid', 'peerA', undefined, 'workspace:join_request'), true);
  // non-signaling method: still subject to the curation check (no cache -> denied)
  assert.equal(r.checkInboundPermission('wsr-uuid', 'peerA', undefined, 'getSource'), false);
  assert.equal(r.checkInboundPermission('wsr-uuid', 'peerA', undefined, undefined), false);
  // route announcement still advertises WSR
  const routes = r.collectSystemRoutesForPeer('peerA');
  assert.ok(routes.some((x: any) => x.objectId === 'wsr-uuid' && x.wellKnownId === 'abjects:workspace-share-registry'));
});
