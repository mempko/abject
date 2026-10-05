/**
 * Workspace profiles: which built-in objects and packages a workspace gets.
 * Validation of configured profiles, loading profiles.json, and which
 * packages join which profile. WorkspaceManager's use of them is exercised
 * on a real server (see docs/WORKSPACE_PROFILES.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_PROFILE, INFRA_OBJECTS, UI_OBJECTS, buildProfile, loadWorkspaceProfiles, packageInProfile,
} from './workspace-profiles.js';
import { parseProfiles } from '../sandbox/extensions.js';

test('built-in profiles: default is today\'s full set, service has no agents and no desktop', () => {
  const { profiles, problems } = loadWorkspaceProfiles('/nonexistent/profiles.json');
  assert.deepEqual(problems, []);
  const def = profiles.get(DEFAULT_PROFILE)!;
  assert.deepEqual([...def.objects], [...INFRA_OBJECTS]);
  assert.deepEqual([...def.ui], [...UI_OBJECTS]);
  const service = profiles.get('service')!;
  assert.ok(service.objects.includes('AbjectStore') && service.objects.includes('WebExposure'));
  for (const agentish of ['AgentAbject', 'ObjectCreator', 'ChatManager', 'Scheduler']) {
    assert.ok(!service.objects.includes(agentish), `service has no ${agentish}`);
  }
  assert.deepEqual([...service.ui], []);
});

test('a configured profile: AbjectStore added, dependency order, UI split out, requirements enforced', () => {
  const ok = buildProfile('org', 'One organization', ['WebExposure', 'SharedState', 'NotificationCenter']);
  assert.ok('profile' in ok);
  assert.deepEqual([...ok.profile.objects], ['AbjectStore', 'SharedState', 'WebExposure'],
    'AbjectStore is always there, and the order is the spawn order');
  assert.deepEqual([...ok.profile.ui], ['NotificationCenter']);

  const missing = buildProfile('broken', '', ['Taskbar']);
  assert.ok('error' in missing);
  assert.match(missing.error, /Taskbar needs AppExplorer, ChatBrowser, JobBrowser, PeersViewer/);
  assert.match((buildProfile('agents', '', ['ScrumMaster']) as { error: string }).error, /ScrumMaster needs AgentAbject, GoalManager/);
  assert.match((buildProfile('typo', '', ['Sharedstate']) as { error: string }).error, /unknown object\(s\) Sharedstate/);
  assert.match((buildProfile('default', '', []) as { error: string }).error, /built-in profile/);
  assert.match((buildProfile('Bad Name', '', []) as { error: string }).error, /not a profile name/);
  assert.match((buildProfile('x', '', 'SharedState') as { error: string }).error, /must be a list/);
});

test('profiles.json: good profiles load, bad ones are reported and left out, a broken file never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abject-profiles-'));
  try {
    const file = path.join(dir, 'profiles.json');
    fs.writeFileSync(file, JSON.stringify({
      profiles: {
        org: { description: 'Org partition', objects: ['SharedState', 'WebExposure'] },
        broken: { objects: ['GoalBrowser'] },
      },
    }));
    const { profiles, problems } = loadWorkspaceProfiles(file);
    assert.deepEqual([...profiles.keys()].sort(), ['default', 'org', 'service']);
    assert.equal(profiles.get('org')!.description, 'Org partition');
    assert.deepEqual(problems, ['profile "broken": GoalBrowser needs GoalManager']);

    fs.writeFileSync(file, '{ not json');
    const bad = loadWorkspaceProfiles(file);
    assert.deepEqual([...bad.profiles.keys()].sort(), ['default', 'service'], 'the built-ins survive a broken file');
    assert.match(bad.problems[0], /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packages join the profiles they name; one that names none joins default only', () => {
  assert.equal(packageInProfile('default', undefined), true);
  assert.equal(packageInProfile('org', undefined), false);
  assert.equal(packageInProfile('org', ['org']), true);
  assert.equal(packageInProfile('default', ['org']), false, 'naming a profile leaves default unless listed');
  assert.equal(packageInProfile('default', ['org', 'default']), true);

  assert.deepEqual(parseProfiles(['org', 'org', 'default'], 'workspace'), ['org', 'default']);
  assert.equal(parseProfiles(undefined, 'workspace'), undefined);
  assert.throws(() => parseProfiles(['org'], 'system'), /workspace-scope packages/);
  assert.throws(() => parseProfiles([], 'workspace'), /non-empty list/);
  assert.throws(() => parseProfiles(['Org Space'], 'workspace'), /profile names/);
});
