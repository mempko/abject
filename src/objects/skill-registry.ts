/**
 * SkillRegistry -- manages skill lifecycle for a workspace.
 *
 * Scans $ABJECTS_DATA_DIR/skills/ for SKILL.md files (compatible with Claude Code and
 * OpenClaw formats), manages enable/disable state, and provides enabled skill
 * summaries for AgentAbject to inject into LLM prompts.
 *
 * Uninstalling sets a skill's folder aside in `skills-trash/` (beside the
 * skills directory) for the session and at least three days, so its caller
 * can undo it; enable and disable are undoable too. Config holds credentials
 * and is never kept in undo history: it stays in storage under the skill's
 * name, so a skill brought back finds it there.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { UndoHistories, UndoRefused, undoMethods, UNDO_EVENTS } from '../core/undo.js';
import type { UndoAction, UndoHistoryJSON, UndoStep } from '../core/undo.js';
import { parseSkillMd, ParsedSkill } from '../core/skill-parser.js';
import { discoverHostMcpServers, synthesizeHostSkillMd } from '../core/host-mcp-import.js';
import { sanitiseSkillName } from '../core/skill-synth.js';
import type { SkillInfo, SkillConfig, EnabledSkillSummary } from '../core/skill-types.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SkillRegistry');

const SKILL_REGISTRY_INTERFACE: InterfaceId = 'abjects:skill-registry';
const STORAGE_KEY = 'skills:states';
const CONFIG_STORAGE_KEY = 'skills:config';
/**
 * How long an enable waits for the person to finish signing in to a remote
 * MCP server before answering that it is still waiting. The person is not
 * timed by this: the sign-in carries on and the bridge connects whenever it
 * completes.
 */
const SIGN_IN_WAIT_MS = 15 * 60 * 1000;
/** Bridge states an enable waits through: a remote server connecting, or waiting on a sign-in. */
const BRIDGE_SETTLING = new Set(['connecting', 'signing_in']);

interface SkillEntry {
  parsed: ParsedSkill;
  enabled: boolean;
  error?: string;
  /** The skill's folder under the skills directory. */
  dirName: string;
}

/** An uninstalled skill's folder, kept in the trash under its id. */
interface SkillTrashItem {
  id: string;
  name: string;
  dirName: string;
  removedAt: number;
  bytes: number;
}

/** One undoable change. Config is never part of one: it holds credentials. */
type SkillStep =
  | { kind: 'uninstall'; name: string; dirName: string; enabled: boolean; contentHash: string; trashId?: string }
  | { kind: 'enable'; name: string; before: boolean; after: boolean };

/** What is set aside stays this long past the session it was set aside in. */
const TRASH_KEEP_MS = 3 * 24 * 60 * 60_000;
const TRASH_MAX_ITEMS = 200;
const TRASH_MAX_BYTES = 512 * 1024 * 1024;
const TRASH_PURGE_MS = 60 * 60_000;

export class SkillRegistry extends Abject {
  private skills = new Map<string, SkillEntry>();
  private skillConfigs = new Map<string, SkillConfig>();
  private skillsDir: string;
  private storageId?: AbjectId;
  private shellExecutorId?: AbjectId;
  private factoryId?: AbjectId;
  private secretsVaultId?: AbjectId;
  /** AbjectId of each running MCPBridge, keyed by skill name. */
  private mcpBridges = new Map<string, AbjectId>();
  /** Cached bridge health state, keyed by skill name. */
  private mcpBridgeStates = new Map<string, {
    status: string; error?: string; toolCount: number; stderrTail?: string;
  }>();
  /** Callers of enableSkill / setSkillConfig waiting for a bridge to settle, keyed by skill name. */
  private bridgeWaiters = new Map<string, Array<() => void>>();
  /** Uninstalled skills' folders (beside the skills directory) and the trash index and undo file in it. */
  private readonly trashDir: string;
  private trash = new Map<string, SkillTrashItem>();
  /** Each caller's changes; uninstall steps are kept on disk with the trash. */
  private undo = new UndoHistories<SkillStep>();
  private readonly sessionStartedAt = Date.now();
  /** Uninstalls, undo and purges run one at a time. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(skillsDir?: string) {
    super({
      manifest: {
        name: 'SkillRegistry',
        description:
          'Manages skill lifecycle. Scans the skills/ directory for SKILL.md files (Claude Code and OpenClaw formats), ' +
          'handles enable/disable, and provides skill summaries for agent prompt injection.',
        version: '1.0.0',
        interface: {
          id: SKILL_REGISTRY_INTERFACE,
          name: 'SkillRegistry',
          description: 'Skill management operations',
          methods: [
            {
              name: 'listSkills',
              description: 'List all discovered skills with their state',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SkillInfo' } },
            },
            {
              name: 'getSkill',
              description: 'Get metadata for a single skill',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
              ],
              returns: { kind: 'reference', reference: 'SkillInfo' },
            },
            {
              name: 'enableSkill',
              description:
                'Enable a skill. For MCP skills this starts the bridge and waits for the handshake, so the ' +
                'return value reports the real outcome: mcpStatus, toolCount, and on failure the error ' +
                '(including the server subprocess stderr) plus any declared env vars still missing.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name (case-insensitive)' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                warning: { kind: 'primitive', primitive: 'string' },
                mcpStatus: { kind: 'primitive', primitive: 'string' },
                toolCount: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
                missingEnv: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                hint: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'disableSkill',
              description: 'Disable a skill',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'scanSkills',
              description: 'Re-scan the skills directory for new or changed SKILL.md files',
              parameters: [],
              returns: { kind: 'object', properties: { found: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'respawnLostBridges',
              description: 'Respawn the MCP bridges among the given object ids, after a worker crash took the live processes. Returns { respawned }.',
              parameters: [
                { name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Ids of objects that are gone' },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'installSkill',
              description: "Install a skill for this system by writing SKILL.md into the one skills directory this registry scans. This is what makes a skill available here — a vendor's own `<tool> skill --install` writes into other harnesses' directories, which are never scanned, so it installs nothing here. Pass the SKILL.md text; follow with enableSkill.",
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill directory name' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'SKILL.md file content' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'installSkillBundle',
              description: 'Install a multi-file skill by writing an entire tree under <skillsDir>/<name>/. Each value may be {text: string} or {base64: string} for binary files.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill directory name' },
                { name: 'entries', type: { kind: 'object', properties: {} }, description: 'path → {text | base64}' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                files: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'uninstallSkill',
              description: 'Uninstall a skill: stops its MCP server and sets its folder aside for a few days, so undo brings it back (with its enabled state; its config stays stored)',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'getEnabledSkills',
              description: 'Get summaries of all enabled skills for prompt injection',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'EnabledSkillSummary' } },
            },
            {
              name: 'getSkillConfig',
              description: 'Get the configuration (env vars) for a skill',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
              ],
              returns: { kind: 'object', properties: { env: { kind: 'object', properties: {} } } },
            },
            {
              name: 'setSkillConfig',
              description:
                'Set configuration (env vars) for a skill and persist it. This is the supported place for ' +
                'skill credentials; values live in storage, not in the SKILL.md file. If the skill is an ' +
                'enabled MCP server its bridge is restarted so the new environment takes effect, and the ' +
                'restart outcome is reported back.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name (case-insensitive)' },
                { name: 'env', type: { kind: 'object', properties: {} }, description: 'Key-value map of environment variables' },
                { name: 'merge', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Merge into existing config instead of replacing it (default false)' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                keys: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                restarted: { kind: 'primitive', primitive: 'boolean' },
                mcpStatus: { kind: 'primitive', primitive: 'string' },
                toolCount: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'getEnabledMCPServers',
              description: 'Get enabled MCP servers with their tool definitions',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'MCPServerSummary' } },
            },
            {
              name: 'getMCPBridgeInfo',
              description: 'Diagnostic lookup for a single MCP bridge by skill name. Returns rich state so callers can tell the difference between "never installed", "installed but disabled", "enabled but spawn failed", and "enabled and connected". Caller should use name-matching that tolerates case differences (the match is case-insensitive).',
              parameters: [
                { name: 'serverName', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill / MCP server name (e.g. "telegram"). Case-insensitive.' },
              ],
              returns: { kind: 'object', properties: {
                found: { kind: 'primitive', primitive: 'boolean' },
                status: { kind: 'primitive', primitive: 'string' },
                bridgeId: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
                toolCount: { kind: 'primitive', primitive: 'number' },
                hint: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'getSkillsDir',
              description: 'Return the absolute filesystem path where SKILL.md directories live. Agents should use SkillRegistry methods (getSkillConfig, setSkillConfig, listSkills) rather than poking the filesystem, but some skills reference ancillary files under this path.',
              parameters: [],
              returns: { kind: 'object', properties: {
                path: { kind: 'primitive', primitive: 'string' },
              }},
            },
            ...undoMethods('your last uninstall, enable or disable of a skill (config changes are not undoable)'),
          ],
          events: [
            ...UNDO_EVENTS,
            {
              name: 'skillsChanged',
              description: 'Emitted when skills are scanned, enabled, disabled, installed, or uninstalled',
              payload: { kind: 'object', properties: {
                reason: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        tags: ['system', 'skill'],
      },
    });

    this.skillsDir = skillsDir ?? path.resolve(process.env.ABJECTS_DATA_DIR ?? '.abjects', 'skills');
    this.trashDir = path.join(path.dirname(path.resolve(this.skillsDir)), 'skills-trash');
    this.setupHandlers();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [id, item] of this.trash) invariant(item.id === id, 'SkillRegistry: a trash item is kept under its own id');
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    // Ensure skills directory exists
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.trashDir, { recursive: true });
    await this.loadTrash();
    await this.exclusive(() => this.purgeTrash());
    this.setRecurringTimer(() => this.exclusive(() => this.purgeTrash()).catch(err =>
      log.warn(`Skill trash purge failed: ${err instanceof Error ? err.message : String(err)}`)), TRASH_PURGE_MS);

    // Scan for skills
    await this.doScan();

    // Load persisted enable/disable states and configs
    await this.loadStates();
    await this.loadConfigs();

    // Fill config gaps from SKILL.md default env values. Stored values win —
    // they came from the user or an agent through setSkillConfig — but any key
    // the store has no value for is seeded from the file.
    let seeded = false;
    for (const [name, entry] of this.skills) {
      if (this.applyDefaultEnv(name, entry.parsed.defaultEnv, 'fill')) seeded = true;
    }
    if (seeded) await this.persistConfigs();

    // Import MCP servers already configured on the host (mcporter / openclaw) as
    // disabled skills, so they can be bridged natively instead of shelled out to.
    await this.importHostMcpServers();

    this.factoryId = await this.discoverDep('Factory') ?? undefined;
    this.secretsVaultId = await this.discoverDep('SecretsVault') ?? undefined;
    await this.pushSkillStateToShell();

    // Auto-start any MCP servers that were previously enabled — in the
    // BACKGROUND. Each MCP server boots an external process (npm/npx startup
    // routinely takes seconds), and awaiting them here holds the entire
    // server boot hostage to third-party startup time. Bridges register in
    // the Registry as they come up; anything that needs one discovers it then.
    void this.startEnabledMCPBridges().catch((err) =>
      log.warn(`Background MCP bridge startup failed: ${err instanceof Error ? err.message : String(err)}`));

    log.info(`Initialized with ${this.skills.size} skills in ${this.skillsDir}`);
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SkillRegistry Usage Guide

SkillRegistry manages the lifecycle of skills (SKILL.md files). It scans the
skills directory, handles enable/disable state, configuration (env vars), and
provides enabled skill summaries for agent prompt injection.

### List all discovered skills

  const skills = await call(await dep('SkillRegistry'), 'listSkills', {});
  // Returns SkillInfo[]: { name, description, version, source, enabled, error, ... }

### Enable / disable a skill

  const res = await call(await dep('SkillRegistry'), 'enableSkill', { name: 'my-skill' });
  await call(await dep('SkillRegistry'), 'disableSkill', { name: 'my-skill' });

For an MCP skill, \`enableSkill\` waits for the server handshake and reports the
real outcome, so the reply is the diagnosis:

  { success: true, mcpStatus: 'running', toolCount: 12 }                  // working
  { success: true, mcpStatus: 'error', toolCount: 0, error: '<subprocess stderr>',
    missingEnv: ['SOME_TOKEN'], hint: 'Set them with setSkillConfig...' }  // not working

\`error\` carries the server subprocess's own stderr, which is where MCP servers
print why they refused to start. Read it before investigating anything else.

A remote server that asks for a sign-in (OAuth) answers 401; its bridge then has
OAuthHelper ask the person to approve access in their browser, and
\`enableSkill\` waits until they have:

  { success: true, mcpStatus: 'running', toolCount: 5 }                    // signed in and connected
  { success: true, mcpStatus: 'signing_in', toolCount: 0, hint: '...' }    // the person has not approved yet

Enabling a skill whose bridge failed (a crashed server, a declined sign-in)
replaces the bridge, so it is also how to try again.

### Local and remote MCP servers

A local server is started as a process; a remote one is reached at its address:

  ---
  name: my-local-server
  mcp-command: npx
  mcp-args: ["-y", "some-mcp-package"]
  ---

  ---
  name: my-remote-server
  mcp-url: https://example.com/mcp
  ---

A remote server that wants an API key rather than a sign-in gets it in a header
filled from the skill's config: \`mcp-headers: { Authorization: "Bearer \${EXAMPLE_KEY}" }\`
with \`env: { EXAMPLE_KEY: "" }\`. A server without dynamic client registration
needs \`mcp-oauth-client-id\` naming a client registered with it by hand.

### Re-scan the skills directory

  const result = await call(await dep('SkillRegistry'), 'scanSkills', {});
  // result: { found: <number> }

### Install / uninstall a skill

  await call(await dep('SkillRegistry'), 'installSkill', { name: 'my-skill', content: '---\\nname: my-skill\\n---\\nInstructions...' });
  await call(await dep('SkillRegistry'), 'uninstallSkill', { name: 'my-skill' });

\`installSkill\` takes the SKILL.md **content as a string** and writes it into
the one directory this registry scans. That call is what makes a skill exist
here: a skill is installed for this system when it appears in \`listSkills\`,
and nowhere else counts.

This matters when a tool ships its own installer. A vendor command such as
\`<tool> skill --install\` writes SKILL.md into the skill directories of other
agent harnesses, which this registry never reads — so it completes
successfully and leaves nothing installed here. To install a skill that a
vendor tool provides, obtain the SKILL.md text (the same command usually
prints it, or it can be read from wherever the vendor installer put it) and
pass that text to \`installSkill\`, then \`enableSkill\`. Call \`listSkills\` or
\`getSkill\` afterwards to confirm it landed.

### Undo an uninstall, enable or disable

  await call(await dep('SkillRegistry'), 'undo', {});   // { ok, label, reason }
  await call(await dep('SkillRegistry'), 'redo', {});

Each caller undoes its own changes. \`uninstallSkill\` sets the skill's folder
aside for a few days, so undo brings it back with its enabled state (its stored
config was never removed). Config changes (setSkillConfig) are not undoable.

### Get enabled skill summaries (for prompt injection)

  const summaries = await call(await dep('SkillRegistry'), 'getEnabledSkills', {});
  // Returns EnabledSkillSummary[]: { name, description, instructions, allowedTools, env }

### Look up a single MCP bridge with diagnostic detail

When an Abject bridges a specific MCP server (Telegram, Slack, GitHub, etc.), call \`getMCPBridgeInfo\` to resolve its bridgeId AND get a clear failure reason if the bridge is unavailable. Case-insensitive matching — "telegram", "Telegram", "TELEGRAM" all work.

  const info = await call(await dep('SkillRegistry'), 'getMCPBridgeInfo', { serverName: 'telegram' });
  // info.found === true  → use info.bridgeId to call the MCPBridge directly.
  // info.found === false → info.status explains why:
  //   'not_installed' — skill with that name is not on disk
  //   'not_mcp'       — installed but no mcpServer block in SKILL.md
  //   'disabled'      — installed but not enabled; info.hint tells the user/agent to enable it
  //   'signing_in'    — a remote server waiting for the person to approve access in their browser
  //   'error'         — enabled but spawn or runtime error; info.error has details, info.hint points at credentials
  // Always prefer this over catch-all "bridge not found" errors — surface info.hint so the caller
  // can point the user at the right setting (Installed Skills window, missing env var, etc.).

### Configure environment variables for a skill

Env vars for a skill (including BOT_TOKEN / API_KEY values for its MCP server) live inside SkillRegistry and are injected into the MCP subprocess at spawn time. Read and write them through SkillRegistry:

  await call(await dep('SkillRegistry'), 'setSkillConfig', { name: 'my-skill', env: { API_KEY: 'xxx' }, merge: true });
  const config = await call(await dep('SkillRegistry'), 'getSkillConfig', { name: 'my-skill' });

Pass \`merge: true\` when setting a subset of the keys; without it the supplied
env replaces the whole config and unrelated keys are lost. If the skill is an
enabled MCP server, the bridge restarts on the new environment and the reply
reports \`restarted\`, \`mcpStatus\`, and \`toolCount\`.

This is the supported home for skill credentials. The \`env:\` block in a
SKILL.md file supplies **defaults**, used to fill keys that have no stored
value; stored config wins for keys that are already set. Declare the env var
names there with empty values and keep live credentials out of the file: it
sits in plaintext under the skills directory, it is copied around whenever a
skill is shared or reinstalled, and a value written there is ignored once the
stored config has one.

### Where users set these values

When an agent needs to tell the user how to configure a skill, point them at one of these paths (in order of typical preference):

1. **Installed Skills window** (Settings → AI → "Installed Skills" button): each skill has a form with a row per declared env var. Paste the value, click "Save Config", and the skill re-spawns with the new environment.
2. **Chat**: the user can say something like "set TELEGRAM_BOT_TOKEN to <value> for the io.github.daedalus-mcp-telegram-bot skill" and an agent will call setSkillConfig for them.
3. **Programmatic** (from inside an agent's job code): the setSkillConfig call above.

All three paths update the same storage inside SkillRegistry; the new env is picked up on the next MCPBridge spawn.

### Locating skill files on disk

Each installed skill is a directory under the skills root. To read ancillary files from a skill (scripts, references, templates), ask for the absolute root and resolve paths yourself:

  const { path } = await call(await dep('SkillRegistry'), 'getSkillsDir', {});
  // Files for a skill named "my-skill" live under \`\${path}/my-skill/\`.

### Events

SkillRegistry emits 'skillsChanged' (with reason: enabled|disabled|scanned|installed|uninstalled|configured)
whenever the skill set changes.

### IMPORTANT
- The interface ID is '${SKILL_REGISTRY_INTERFACE}'.
- Skills are SKILL.md files in subdirectories of the skills/ folder.
- Compatible with Claude Code and OpenClaw SKILL.md formats.
- The skills directory is under the app's data directory (default \`./.abjects/skills/\`, override via the \`ABJECTS_DATA_DIR\` env var). Use \`getSkillsDir\` to resolve it at runtime.`;
  }

  private setupHandlers(): void {
    this.on('listSkills', async () => {
      return this.getSkillInfoList();
    });

    this.on('getSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const entry = this.skills.get(name);
      if (!entry) throw new Error(`Skill "${name}" not found`);
      return this.entryToInfo(entry);
    });

    this.on('enableSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const match = this.findSkillEntry(name);
      const entry = match?.entry;
      if (!entry) throw new Error(`Skill "${name}" not found`);
      const key = match!.key;
      const wasEnabled = entry.enabled;
      entry.enabled = true;
      await this.persistStates();
      await this.pushEnvToShell();
      if (!wasEnabled) await this.recordStep(msg.routing.from, `Enable ${key}`, { kind: 'enable', name: key, before: false, after: true });

      // If this is an MCP server, spawn a bridge
      let warning: string | undefined;
      if (entry.parsed.mcpServer) {
        // Enabling again is how a bridge that failed (a crashed server, a
        // declined sign-in) gets another try, so a failed one is replaced.
        if (this.mcpBridges.has(key)) {
          await this.refreshBridgeState(key).catch(() => {});
          if (this.mcpBridgeStates.get(key)?.status === 'error') await this.stopMCPBridge(key);
        }
        await this.spawnMCPBridge(key, entry);
        await this.waitForBridge(key);

        // Report what actually happened. `spawnMCPBridge` has already awaited
        // the subprocess handshake, so the outcome is known here; returning a
        // bare success made a dead server look like a working one and pushed
        // the real diagnosis a full observe cycle downstream.
        const state = this.mcpBridgeStates.get(key);
        const missing = this.missingEnvKeys(key);
        this.changed('skillsChanged', { reason: 'enabled' });

        if (state?.status === 'error') {
          const hint = missing.length > 0
            ? `Declared env vars with no value: ${missing.join(', ')}. ` +
              `Set them with setSkillConfig({ name: "${key}", env: { ... }, merge: true }).`
            : undefined;
          log.warn(`Enabled skill "${key}" but its MCP bridge failed: ${state.error ?? 'unknown error'}`);
          return {
            success: true,
            mcpStatus: 'error',
            toolCount: 0,
            error: state.error,
            missingEnv: missing.length > 0 ? missing : undefined,
            hint,
          };
        }

        if (state?.status === 'signing_in' || state?.status === 'connecting') {
          this.changed('skillsChanged', { reason: 'enabled' });
          log.info(`Enabled skill "${key}"; its server is still ${state.status === 'signing_in' ? 'waiting for the person to sign in' : 'connecting'}`);
          return {
            success: true,
            mcpStatus: state.status,
            toolCount: 0,
            hint: state.error ?? (state.status === 'signing_in'
              ? 'The server asks the person to sign in; the bridge connects once they approve.'
              : 'The bridge is still connecting to the server.'),
          };
        }

        // Connected. Zero tools is unusual but legal (a server may expose only
        // resources), so report it as a warning rather than a failure.
        const toolCount = state?.toolCount ?? 0;
        log.info(`Enabled skill: ${key} (${toolCount} tools)`);
        return {
          success: true,
          mcpStatus: 'running',
          toolCount,
          warning: toolCount === 0
            ? `MCP server "${key}" connected but exposes no tools. If you expected tools, check its configuration; ` +
              (missing.length > 0 ? `these declared env vars have no value: ${missing.join(', ')}.` : 'the server may expose resources only.')
            : undefined,
        };
      } else if (looksLikeMcpSkill(entry.parsed)) {
        // The skill declares an MCP launcher dependency (e.g. mcporter) but has no
        // mcp-command frontmatter, so no bridge will start. Surface this softly so
        // a "successful" enable does not silently fail to expose any tools.
        warning =
          `Skill "${name}" looks like it wraps an MCP server (requires ` +
          `${(entry.parsed.requiredBins ?? []).join(', ')}) but its SKILL.md has no ` +
          `"mcp-command" frontmatter, so no MCP bridge was started and no tools are exposed. ` +
          `Add mcp-command/mcp-args, or configure the server in mcporter and re-scan to import it.`;
        log.warn(warning);
      }

      this.changed('skillsChanged', { reason: 'enabled' });
      log.info(`Enabled skill: ${name}`);
      return warning ? { success: true, warning } : { success: true };
    });

    this.on('disableSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const match = this.findSkillEntry(name);
      const entry = match?.entry;
      if (!entry) throw new Error(`Skill "${name}" not found`);
      const wasEnabled = entry.enabled;
      entry.enabled = false;
      await this.persistStates();
      await this.pushEnvToShell();
      if (wasEnabled) await this.recordStep(msg.routing.from, `Disable ${match!.key}`, { kind: 'enable', name: match!.key, before: true, after: false });

      // If this is an MCP server, stop its bridge
      if (entry.parsed.mcpServer) {
        await this.stopMCPBridge(match!.key);
      }

      this.changed('skillsChanged', { reason: 'disabled' });
      log.info(`Disabled skill: ${name}`);
      return { success: true };
    });

    // MCP bridges that died with a worker thread come back under the same
    // skill name, with the same credentials, if the skill is still enabled.
    this.on('respawnLostBridges', async (msg: AbjectMessage) => {
      const { objectIds } = msg.payload as { objectIds: string[] };
      const lost = new Set(Array.isArray(objectIds) ? objectIds : []);
      let respawned = 0;
      for (const [name, bridgeId] of [...this.mcpBridges]) {
        if (!lost.has(bridgeId)) continue;
        this.mcpBridges.delete(name);
        const entry = this.skills.get(name);
        if (!entry?.enabled || !entry.parsed.mcpServer) continue;
        try {
          await this.spawnMCPBridge(name, entry);
          respawned++;
          log.info(`respawned MCP bridge "${name}" after its worker died`);
        } catch (err) {
          log.warn(`could not respawn MCP bridge "${name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { respawned };
    });

    this.on('scanSkills', async () => {
      await this.doScan();
      await this.importHostMcpServers();
      this.changed('skillsChanged', { reason: 'scanned' });
      return { found: this.skills.size };
    });

    this.on('installSkillBundle', async (msg: AbjectMessage) => {
      const { name, entries } = msg.payload as {
        name: string;
        entries: Record<string, { text?: string; base64?: string }>;
      };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      contractRequire(entries !== null && typeof entries === 'object', 'entries must be an object');

      const skillDir = path.join(this.skillsDir, name);
      await fsPromises.mkdir(skillDir, { recursive: true });

      let files = 0;
      for (const [relPath, entry] of Object.entries(entries)) {
        // Refuse absolute paths or anything that tries to escape the skill dir.
        const normalised = path.posix.normalize(relPath);
        if (path.isAbsolute(normalised) || normalised.startsWith('..') || normalised.includes('/../')) {
          log.warn(`Skipping unsafe path in bundle: ${relPath}`);
          continue;
        }
        const absPath = path.join(skillDir, normalised);
        await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
        if (typeof entry.text === 'string') {
          await fsPromises.writeFile(absPath, entry.text, 'utf-8');
        } else if (typeof entry.base64 === 'string') {
          await fsPromises.writeFile(absPath, Buffer.from(entry.base64, 'base64'));
        } else {
          continue;
        }
        files++;
      }

      // Re-scan so the new skill appears in listSkills and getEnabledSkills.
      await this.doScan();
      this.changed('skillsChanged', { reason: 'installed' });
      log.info(`Installed skill bundle: ${name} (${files} files)`);
      return { success: true, files };
    });

    this.on('installSkill', async (msg: AbjectMessage) => {
      const { name, content } = msg.payload as { name: string; content: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      contractRequire(typeof content === 'string' && content.length > 0, 'content must be non-empty');

      const skillDir = path.join(this.skillsDir, name);
      await fsPromises.mkdir(skillDir, { recursive: true });
      await fsPromises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

      // Re-scan to pick it up
      await this.doScan();
      // An install is an explicit statement of intent, so values in the new
      // file's env block take effect rather than being treated as defaults
      // that an older stored config can shadow. Parse the content we just
      // wrote so the right entry is found even when the frontmatter `name`
      // differs from the directory name.
      const installed = parseSkillMd(content, name);
      if (this.applyDefaultEnv(installed.name, installed.defaultEnv, 'overwrite')) {
        await this.persistConfigs();
        await this.pushEnvToShell();
      }
      this.changed('skillsChanged', { reason: 'installed' });
      log.info(`Installed skill: ${name}`);
      return { success: true };
    });

    this.on('uninstallSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');

      return this.exclusive(async () => {
        const match = this.findSkillEntry(name);
        if (!match) throw new Error(`Skill "${name}" not found`);
        const step = await this.setSkillAside(match.key, match.entry);
        if (step) await this.recordStep(msg.routing.from, `Uninstall ${match.key}`, step);
        log.info(`Uninstalled skill: ${match.key}`);
        return { success: true };
      });
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => this.undo.state(await this.undoCallerKey(msg.routing.from)));

    this.on('getEnabledSkills', async () => {
      return this.getEnabledSummaries();
    });

    this.on('getSkillConfig', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      return this.skillConfigs.get(name) ?? { env: {} };
    });

    this.on('setSkillConfig', async (msg: AbjectMessage) => {
      const { name, env, merge } = msg.payload as {
        name: string; env: Record<string, string>; merge?: boolean;
      };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      // Resolve through the case-insensitive lookup so a caller that types
      // "Slack-MCP-Server" configures the installed skill instead of creating
      // an orphan config entry that nothing ever reads.
      const key = this.findSkillEntry(name)?.key ?? name;
      const next: Record<string, string> = merge
        ? { ...(this.skillConfigs.get(key)?.env ?? {}), ...(env ?? {}) }
        : { ...(env ?? {}) };
      this.skillConfigs.set(key, { env: next });
      await this.persistConfigs();
      await this.pushEnvToShell();
      this.changed('skillsChanged', { reason: 'configured' });
      log.info(`Saved config for skill: ${key} (${Object.keys(env ?? {}).join(', ') || 'no keys'}${merge ? ', merged' : ''})`);
      // Restart a running bridge so the new environment actually takes effect;
      // otherwise the caller sets a credential, sees success, and keeps
      // talking to a subprocess still holding the old (or empty) value.
      let restarted = false;
      const entry = this.skills.get(key);
      if (entry?.enabled && entry.parsed.mcpServer && this.mcpBridges.has(key)) {
        await this.stopMCPBridge(key);
        await this.spawnMCPBridge(key, entry);
        await this.waitForBridge(key);
        restarted = true;
      }
      const state = this.mcpBridgeStates.get(key);
      return {
        success: true,
        keys: Object.keys(next),
        restarted,
        // Same vocabulary as enableSkill so callers can branch one way.
        ...(restarted ? {
          mcpStatus: state?.status === 'error' || state?.status === 'signing_in' ? state.status : 'running',
          toolCount: state?.toolCount ?? 0,
          error: state?.error,
        } : {}),
      };
    });

    this.on('getEnabledMCPServers', async () => {
      return await this.getEnabledMCPServerSummaries();
    });

    this.on('getMCPBridgeInfo', async (msg: AbjectMessage) => {
      const { serverName } = msg.payload as { serverName: string };
      contractRequire(typeof serverName === 'string' && serverName.length > 0, 'serverName must be non-empty');
      return this.getMCPBridgeInfo(serverName);
    });

    this.on('getSkillsDir', async () => {
      return { path: path.resolve(this.skillsDir) };
    });

    // A bridge this registry spawned reports a status change (a sign-in
    // finished, a remote server stopped accepting its token). Taken only
    // from those bridges.
    this.on('bridgeStatus', (msg: AbjectMessage) => {
      const name = [...this.mcpBridges].find(([, id]) => id === msg.routing.from)?.[0];
      if (!name) return;
      const { status, error, toolCount } = (msg.payload ?? {}) as { status?: string; error?: string; toolCount?: number };
      if (typeof status !== 'string') return;
      const previous = this.mcpBridgeStates.get(name);
      this.mcpBridgeStates.set(name, { status, error, toolCount: toolCount ?? 0, stderrTail: previous?.stderrTail });
      const entry = this.skills.get(name);
      if (entry) entry.error = status === 'error' ? error : undefined;
      if (!BRIDGE_SETTLING.has(status)) this.releaseBridgeWaiters(name);
      log.info(`MCPBridge "${name}" is now ${status}${error && status === 'error' ? `: ${error}` : ''}`);
      this.changed('skillsChanged', { reason: 'mcpStatus' });
    });
  }

  /**
   * Hold an enable (or a config change) open while the bridge settles: a
   * remote server connecting, or waiting for the person to sign in. The
   * caller then learns the outcome instead of a half-finished state. The
   * heartbeat keeps every caller behind this one alive for as long as the
   * person takes; SIGN_IN_WAIT_MS bounds a sign-in that never settles, and
   * the caller then hears it is still waiting.
   */
  private async waitForBridge(name: string): Promise<void> {
    if (!BRIDGE_SETTLING.has(this.mcpBridgeStates.get(name)?.status ?? '')) return;
    const stopBeating = this.awaitingHuman(`the "${name}" MCP server (connecting or signing in)`);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SIGN_IN_WAIT_MS);
        const waiters = this.bridgeWaiters.get(name) ?? [];
        waiters.push(() => { clearTimeout(timer); resolve(); });
        this.bridgeWaiters.set(name, waiters);
      });
    } finally {
      stopBeating();
    }
    await this.refreshBridgeState(name).catch(() => {});
  }

  private releaseBridgeWaiters(name: string): void {
    const waiters = this.bridgeWaiters.get(name);
    this.bridgeWaiters.delete(name);
    for (const release of waiters ?? []) release();
  }

  /**
   * Case-insensitive lookup for a skill entry. Lets callers pass "telegram",
   * "Telegram", or "TELEGRAM" interchangeably — the stored key is whatever
   * name the SKILL.md declared.
   */
  private findSkillEntry(serverName: string): { key: string; entry: SkillEntry } | null {
    const needle = serverName.toLowerCase();
    for (const [key, entry] of this.skills) {
      if (key.toLowerCase() === needle) return { key, entry };
    }
    return null;
  }

  /**
   * Diagnostic bridge-info lookup. Callers (typically user-generated
   * objects like TelegramBridge) use this to find their MCP bridge AND
   * get a clear failure reason when the bridge is unavailable, so the
   * caller's error log points at the real problem instead of blaming
   * unrelated logic.
   */
  private getMCPBridgeInfo(serverName: string): {
    found: boolean;
    status: 'connected' | 'connecting' | 'signing_in' | 'error' | 'disabled' | 'not_installed' | 'not_mcp';
    bridgeId?: string;
    error?: string;
    stderrTail?: string;
    toolCount?: number;
    hint?: string;
  } {
    const match = this.findSkillEntry(serverName);
    if (!match) {
      return {
        found: false,
        status: 'not_installed',
        hint: `No skill named "${serverName}" is installed. Call SkillRegistry.installSkill to add it, or scanSkills to re-check disk. Installed skills: ${[...this.skills.keys()].join(', ') || '(none)'}`,
      };
    }
    const { key, entry } = match;
    if (!entry.parsed.mcpServer) {
      return {
        found: false,
        status: 'not_mcp',
        hint: `Skill "${key}" is installed but does not declare an mcpServer block in SKILL.md — it is not bridgeable via MCPBridge.`,
      };
    }
    if (!entry.enabled) {
      return {
        found: false,
        status: 'disabled',
        hint: `Skill "${key}" is installed but disabled. Call SkillRegistry.enableSkill({ name: "${key}" }) to start its MCP bridge.`,
      };
    }
    const bridgeId = this.mcpBridges.get(key);
    const state = this.mcpBridgeStates.get(key);
    if (!bridgeId) {
      return {
        found: false,
        status: 'error',
        error: entry.error ?? 'Skill is enabled but bridge was never spawned.',
        hint: `Enable/disable the skill again, or inspect SkillRegistry state. Last error: ${entry.error ?? 'none recorded'}`,
      };
    }
    if (state?.status === 'signing_in') {
      return {
        found: false,
        status: 'signing_in',
        bridgeId,
        error: state.error,
        toolCount: 0,
        hint: `MCP server "${key}" is waiting for the person to sign in. They have been asked to approve access in their browser; the bridge connects by itself once they do.`,
      };
    }
    if (state?.status === 'error') {
      const missing = this.missingEnvKeys(key);
      return {
        found: false,
        status: 'error',
        bridgeId,
        error: state.error,
        stderrTail: state.stderrTail,
        toolCount: state.toolCount,
        hint:
          `MCPBridge spawned but is in error state: ${(state.error ?? 'unknown').replace(/\.$/, '')}.` +
          (/^Sign-in to /.test(state.error ?? '')
            ? ` Enable the skill again (SkillRegistry.enableSkill) to ask the person to sign in again.`
            : missing.length > 0
            ? ` Declared env vars with no value: ${missing.join(', ')}. Set them with SkillRegistry.setSkillConfig({ name: "${key}", env: { ... }, merge: true }).`
            : ` Check credentials (SkillRegistry.getSkillConfig/setSkillConfig) or the bridge's getStatus handler directly.`),
      };
    }
    return {
      found: true,
      status: (state?.status as 'connected' | 'connecting') ?? 'connecting',
      bridgeId,
      toolCount: state?.toolCount ?? 0,
    };
  }

  // ─── Scanning ───────────────────────────────────────────────────

  private async doScan(): Promise<void> {
    const previousEnabled = new Map<string, boolean>();
    for (const [name, entry] of this.skills) {
      previousEnabled.set(name, entry.enabled);
    }

    this.skills.clear();

    let entries: string[];
    try {
      entries = await fsPromises.readdir(this.skillsDir);
    } catch {
      log.info(`Skills directory not readable: ${this.skillsDir}`);
      return;
    }

    for (const dirName of entries) {
      const dirPath = path.join(this.skillsDir, dirName);
      const skillMdPath = path.join(dirPath, 'SKILL.md');

      try {
        const stat = await fsPromises.stat(dirPath);
        if (!stat.isDirectory()) continue;

        const content = await fsPromises.readFile(skillMdPath, 'utf-8');
        const parsed = parseSkillMd(content, dirName);

        this.skills.set(parsed.name, {
          parsed,
          enabled: previousEnabled.get(parsed.name) ?? false,
          dirName,
        });

        // Fill any unset env keys from the file's defaults.
        this.applyDefaultEnv(parsed.name, parsed.defaultEnv, 'fill');
      } catch (err) {
        // If SKILL.md doesn't exist or can't be parsed, skip this directory
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        log.info(`Error reading skill "${dirName}": ${err instanceof Error ? err.message : String(err)}`);
        this.skills.set(dirName, {
          parsed: { frontmatter: {}, name: dirName, description: '', instructions: '', source: 'unknown' },
          enabled: false,
          dirName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Reap bridges whose skill is gone from disk. A skill directory can vanish
    // without going through uninstallSkill (deleted by hand, moved, renamed),
    // and the subprocess it spawned would otherwise keep running forever with
    // no skill left to disable it.
    for (const name of [...this.mcpBridges.keys()]) {
      if (!this.skills.has(name)) {
        log.info(`Stopping MCP bridge for removed skill "${name}"`);
        await this.stopMCPBridge(name);
      }
    }

    log.info(`Scanned ${this.skills.size} skills`);
  }

  /**
   * Import MCP servers already configured on the host (mcporter / openclaw) as
   * abjects skills, so they can be bridged natively rather than shelled out to.
   *
   * Each discovered server that does not already match an existing skill (by
   * name, case-insensitive) gets a synthesised SKILL.md with proper
   * `mcp-command` / `mcp-args` frontmatter. Imported skills start DISABLED — the
   * user enables them explicitly, which is when the MCP subprocess is launched.
   * Any env carried over from the host config is seeded into skill config (not
   * baked into the SKILL.md), matching how abjects already stores skill secrets.
   *
   * Set ABJECTS_IMPORT_HOST_MCP=0 to opt out.
   */
  private async importHostMcpServers(): Promise<number> {
    if (process.env.ABJECTS_IMPORT_HOST_MCP === '0') return 0;

    let servers;
    try {
      servers = discoverHostMcpServers(os.homedir());
    } catch (err) {
      log.info(`Host MCP discovery skipped: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    let imported = 0;
    let seededConfig = false;
    for (const server of servers) {
      // Already represented by a skill (e.g. a hand-written SKILL.md) — leave it be.
      if (this.findSkillEntry(server.name)) continue;

      const dirName = sanitiseSkillName(server.name);
      const skillDir = path.join(this.skillsDir, dirName);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      // Never clobber an existing file on disk.
      if (fs.existsSync(skillMdPath)) continue;

      const content = synthesizeHostSkillMd(server);
      try {
        await fsPromises.mkdir(skillDir, { recursive: true });
        await fsPromises.writeFile(skillMdPath, content, 'utf-8');
      } catch (err) {
        log.warn(`Failed to write imported skill "${server.name}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const parsed = parseSkillMd(content, dirName);
      this.skills.set(parsed.name, { parsed, enabled: false, dirName });

      // Seed host env into skill config (kept out of the SKILL.md file).
      if (Object.keys(server.env).length > 0 && !this.skillConfigs.get(parsed.name)?.env) {
        this.skillConfigs.set(parsed.name, { env: { ...server.env } });
        seededConfig = true;
      }

      imported++;
      log.info(`Imported host MCP server "${server.name}" (${server.source}) as skill "${parsed.name}" (disabled)`);
    }

    if (seededConfig) await this.persistConfigs();
    return imported;
  }

  /**
   * Reconcile a skill's stored config with the `env:` block in its SKILL.md.
   *
   * Two modes, because the two callers mean different things:
   *
   * - `'fill'` (a passive scan): the file supplies defaults. Any key the store
   *   has no non-empty value for is seeded from the file; existing values are
   *   left alone, because they came from a user or an agent deliberately
   *   setting them and outrank a file default.
   * - `'overwrite'` (an explicit install/reinstall): the file is the newer
   *   statement of intent, so its non-empty values win. Empty values in the
   *   file never clobber a stored value — an empty env entry is a declaration
   *   that the key exists, not an instruction to erase it.
   *
   * The old behaviour re-seeded only when the stored env was entirely empty,
   * so one incidental non-secret value (a `"true"` feature flag) froze the
   * config forever and every later credential written into the SKILL.md was
   * silently discarded, leaving the server to start with no credentials at all.
   *
   * Returns true when anything changed.
   */
  private applyDefaultEnv(
    name: string,
    defaultEnv: Record<string, string> | undefined,
    mode: 'fill' | 'overwrite',
  ): boolean {
    if (!defaultEnv || Object.keys(defaultEnv).length === 0) return false;

    const existing = this.skillConfigs.get(name);
    const env: Record<string, string> = { ...(existing?.env ?? {}) };
    let changed = false;

    for (const [key, value] of Object.entries(defaultEnv)) {
      const current = env[key];
      const wantsOverwrite = mode === 'overwrite' && !!value && value !== current;
      const fillsGap = !current && value !== undefined && value !== current;
      if (wantsOverwrite || fillsGap) {
        env[key] = value;
        changed = true;
      } else if (!(key in env)) {
        // Declared but with no value anywhere: keep the key so the UI and
        // agents can see what still needs to be supplied.
        env[key] = '';
        changed = true;
      }
    }

    if (changed) this.skillConfigs.set(name, { env });
    return changed;
  }

  /**
   * Env keys a skill declares (via `env:` or OpenClaw `requires.env`) that
   * still have no value. Used to explain a failed enable before the
   * subprocess even runs.
   */
  private missingEnvKeys(name: string): string[] {
    const entry = this.skills.get(name);
    if (!entry) return [];
    const config = this.skillConfigs.get(name)?.env ?? {};
    const declared = new Set([
      ...(entry.parsed.requiredEnv ?? []),
      ...Object.keys(entry.parsed.defaultEnv ?? {}),
    ]);
    return [...declared].filter(k => !config[k]);
  }

  // ─── State Persistence ──────────────────────────────────────────

  private async loadStates(): Promise<void> {
    if (!this.storageId) return;

    try {
      const result = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY }),
      );
      if (result && typeof result === 'object') {
        const states = result as Record<string, boolean>;
        for (const [name, enabled] of Object.entries(states)) {
          const entry = this.skills.get(name);
          if (entry) entry.enabled = enabled;
        }
      }
    } catch {
      // Storage not available or key doesn't exist -- use defaults
    }
  }

  private async persistStates(): Promise<void> {
    if (!this.storageId) return;

    const states: Record<string, boolean> = {};
    for (const [name, entry] of this.skills) {
      states[name] = entry.enabled;
    }

    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: STORAGE_KEY, value: states }),
      );
    } catch {
      // Best effort persistence
    }
  }

  private async loadConfigs(): Promise<void> {
    if (!this.storageId) return;
    try {
      const result = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: CONFIG_STORAGE_KEY }),
      );
      if (result && typeof result === 'object') {
        const configs = result as Record<string, SkillConfig>;
        for (const [name, config] of Object.entries(configs)) {
          if (config && typeof config.env === 'object') {
            this.skillConfigs.set(name, config);
          }
        }
      }
    } catch { /* not available */ }
  }

  private async persistConfigs(): Promise<void> {
    if (!this.storageId) return;
    const configs: Record<string, SkillConfig> = {};
    for (const [name, config] of this.skillConfigs) {
      configs[name] = config;
    }
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: CONFIG_STORAGE_KEY, value: configs }),
      );
    } catch { /* best effort */ }
  }

  /**
   * ShellExecutor's id, resolved when it is first needed rather than once at
   * init.
   *
   * This registry initialises early, before ShellExecutor is discoverable, so
   * a single lookup at startup came back empty and every later push returned
   * at the door — silently, forever, because nothing retried. Skill
   * environment variables and skill command grants both travel this path, so
   * both were being assembled and then dropped.
   */
  private async resolveShellExecutor(): Promise<AbjectId | undefined> {
    this.shellExecutorId ??= await this.discoverDep('ShellExecutor') ?? undefined;
    return this.shellExecutorId;
  }

  /** Boot attempts before leaving the push to the next skill change. The
   *  budget is deliberately generous: ShellExecutor was measured appearing
   *  around ten seconds after this registry is ready, and a boot slower than
   *  the budget leaves every already-enabled skill ungranted for the whole
   *  session, since nothing else pushes unless the user toggles something.
   *  Each attempt stops the chain as soon as it resolves, so the only cost
   *  of a wide budget is a few timers on a machine with no shell at all. */
  private static readonly SHELL_PUSH_RETRIES = 12;
  private static readonly SHELL_PUSH_RETRY_MS = 750;

  /**
   * Send the enabled skills' environment and command grants to ShellExecutor,
   * waiting for it to exist.
   *
   * At boot this registry is ready well before ShellExecutor, so the first
   * attempt finds nothing. Retrying on a short backoff is what makes a skill
   * usable in the session it was enabled in, rather than only after the user
   * happens to toggle something.
   */
  private async pushSkillStateToShell(attempt = 0): Promise<void> {
    if (await this.pushEnvToShell()) return;
    if (attempt < SkillRegistry.SHELL_PUSH_RETRIES) {
      this.setTimer(() => { void this.pushSkillStateToShell(attempt + 1); },
        SkillRegistry.SHELL_PUSH_RETRY_MS * (attempt + 1));
    } else {
      log.warn('Could not publish skill env and command grants to ShellExecutor; skills will prompt for every command until one is enabled or disabled');
    }
  }

  /**
   * Collect env vars from all enabled skills and push to ShellExecutor.
   *
   * Returns whether the push actually landed. ShellExecutor authorises these
   * by resolving this registry's id and comparing senders, and at boot it
   * cannot resolve anything yet — so it answers `{success:false}`, which is a
   * perfectly successful REPLY and never reaches a catch block. Reading the
   * reply is the only way to tell a delivered grant from a refused one, and
   * without it the whole thing failed silently for the entire session.
   */
  private async pushEnvToShell(): Promise<boolean> {
    const shellId = await this.resolveShellExecutor();
    if (!shellId) return false;
    const merged: Record<string, string> = {};
    for (const [name, entry] of this.skills) {
      if (!entry.enabled) continue;
      const config = this.skillConfigs.get(name);
      if (config?.env) {
        Object.assign(merged, config.env);
      }
    }
    let ok = false;
    try {
      const reply = await this.request<{ success?: boolean }>(
        request(this.id, shellId, 'setSkillEnv', { env: merged }),
      );
      ok = reply?.success !== false;
    } catch { /* ShellExecutor may not be ready */ }
    return (await this.pushCommandsToShell()) && ok;
  }

  /**
   * Tell ShellExecutor which programs the enabled skills stand behind.
   *
   * Enabling a skill is the user's decision that this machine may run that
   * tool; without this the decision stopped at the registry and the first
   * command still interrupted them to ask. Sent on the same occasions as the
   * environment, so the two never disagree about what is enabled.
   */
  private async pushCommandsToShell(): Promise<boolean> {
    const shellId = await this.resolveShellExecutor();
    if (!shellId) return false;
    const skills: Array<{ name: string; commands?: string[] }> = [];
    for (const [name, entry] of this.skills) {
      if (!entry.enabled) continue;
      // The skill's own name is the program it exists to drive. Its parsed
      // `allowed-tools` are harness tool names ("Bash", "Read"), not shell
      // programs, so they are deliberately not treated as grants here.
      const mcp = entry.parsed?.mcpServer?.command;
      skills.push({ name, commands: mcp ? [mcp] : undefined });
    }
    try {
      const reply = await this.request<{ success?: boolean }>(
        request(this.id, shellId, 'setSkillCommands', { skills }),
      );
      return reply?.success !== false;
    } catch { /* ShellExecutor may not be ready */ }
    return false;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private getSkillInfoList(): SkillInfo[] {
    return [...this.skills.values()].map(e => this.entryToInfo(e));
  }

  private entryToInfo(entry: SkillEntry): SkillInfo {
    const config = this.skillConfigs.get(entry.parsed.name);
    const bridgeState = this.mcpBridgeStates.get(entry.parsed.name);
    const info: SkillInfo = {
      name: entry.parsed.name,
      description: entry.parsed.description,
      version: entry.parsed.version,
      source: entry.parsed.source,
      enabled: entry.enabled,
      error: entry.error ?? (bridgeState?.status === 'error' ? bridgeState.error : undefined),
      allowedTools: entry.parsed.allowedTools,
      requiredBins: entry.parsed.requiredBins,
      requiredEnv: entry.parsed.requiredEnv,
      configuredEnvKeys: config?.env ? Object.keys(config.env).filter(k => config.env[k]) : undefined,
    };

    if (entry.parsed.mcpServer) {
      info.isMcpServer = true;
      info.mcpCommand = entry.parsed.mcpServer.command;
      info.mcpUrl = entry.parsed.mcpServer.url;
      if (!this.mcpBridges.has(entry.parsed.name)) {
        info.mcpStatus = 'idle';
      } else if (bridgeState?.status === 'error' || bridgeState?.status === 'signing_in') {
        info.mcpStatus = bridgeState.status;
      } else {
        info.mcpStatus = 'running';
      }
    }

    if (entry.parsed.configFile) {
      info.configFile = entry.parsed.configFile;
    }

    return info;
  }

  private getEnabledSummaries(): EnabledSkillSummary[] {
    const summaries: EnabledSkillSummary[] = [];
    for (const [name, entry] of this.skills) {
      if (!entry.enabled || entry.error) continue;
      // Skip MCP servers from regular skill summaries (they get their own section)
      if (entry.parsed.mcpServer) continue;
      const config = this.skillConfigs.get(name);
      summaries.push({
        name: entry.parsed.name,
        description: entry.parsed.description,
        instructions: entry.parsed.instructions,
        allowedTools: entry.parsed.allowedTools,
        env: config?.env,
      });
    }
    return summaries;
  }

  // ─── Uninstalled skills, kept for undo ─────────────────────────

  /** Run an uninstall, undo or purge after the ones before it. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /**
   * Uninstall a skill but keep its folder: stop its MCP server (an orphaned
   * one would keep running with the skill's credentials), move the folder
   * into the trash, and forget the skill. The undo step, or null when the
   * skill had no folder to keep.
   */
  private async setSkillAside(key: string, entry: SkillEntry): Promise<SkillStep | null> {
    await this.stopMCPBridge(key);
    const skillDir = path.join(this.skillsDir, entry.dirName);
    const contentHash = await this.skillMdHash(entry.dirName);
    let trashId: string | undefined;
    if (fs.existsSync(skillDir)) {
      trashId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const bytes = await dirSize(skillDir);
      await moveDir(skillDir, path.join(this.trashDir, trashId));
      this.trash.set(trashId, { id: trashId, name: key, dirName: entry.dirName, removedAt: Date.now(), bytes });
      await this.persistTrash();
    }
    this.skills.delete(key);
    await this.persistStates();
    await this.pushEnvToShell();
    this.changed('skillsChanged', { reason: 'uninstalled' });
    return trashId ? { kind: 'uninstall', name: key, dirName: entry.dirName, enabled: entry.enabled, contentHash, trashId } : null;
  }

  /**
   * Bring an uninstalled skill back with its enabled state. When the same
   * skill is installed again meanwhile (a host MCP server imported again,
   * a reinstall of the same SKILL.md), that one stays and only the state is
   * restored, so no duplicate appears; a different skill under the name or
   * in the folder refuses.
   */
  private async restoreSkill(d: Extract<SkillStep, { kind: 'uninstall' }>): Promise<void> {
    const trashId = d.trashId;
    if (!trashId || !this.trash.has(trashId)) throw new UndoRefused(`'${d.name}' is no longer kept`);
    const existing = this.findSkillEntry(d.name);
    const target = path.join(this.skillsDir, d.dirName);
    if (existing || fs.existsSync(target)) {
      const same = existing && await this.skillMdHash(existing.entry.dirName) === d.contentHash;
      if (!same) throw new UndoRefused(`A different skill named '${d.name}' is installed now`);
      await fsPromises.rm(path.join(this.trashDir, trashId), { recursive: true, force: true });
    } else {
      await moveDir(path.join(this.trashDir, trashId), target);
      await this.doScan();
    }
    this.trash.delete(trashId);
    delete d.trashId;
    await this.persistTrash();
    const match = this.findSkillEntry(d.name);
    if (!match) throw new Error(`'${d.name}' came back but its SKILL.md did not load`);
    await this.applyEnabled(match.key, match.entry, d.enabled, 'installed');
  }

  /**
   * Set a skill's enabled flag as undo and redo do: persisted and pushed to
   * the shell like enable/disable. A bridge starts in the background, so
   * the reply does not wait on a server's start or sign-in.
   */
  private async applyEnabled(key: string, entry: SkillEntry, enabled: boolean, reason: string): Promise<void> {
    entry.enabled = enabled;
    await this.persistStates();
    await this.pushEnvToShell();
    if (entry.parsed.mcpServer) {
      if (!enabled) await this.stopMCPBridge(key);
      else void this.spawnMCPBridge(key, entry).catch((err) =>
        log.warn(`MCP bridge '${key}' failed to start: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.changed('skillsChanged', { reason });
  }

  /** A skill folder's SKILL.md by content, '' when it has none. */
  private async skillMdHash(dirName: string): Promise<string> {
    try {
      const content = await fsPromises.readFile(path.join(this.skillsDir, dirName, 'SKILL.md'));
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  private async recordStep(callerId: AbjectId, label: string, step: SkillStep): Promise<void> {
    const caller = await this.undoCallerKey(callerId);
    this.undo.for(caller).record(label, step);
    // An uninstall holds the lock; its new step may drop redo steps whose folders go too.
    if (step.kind === 'uninstall') await this.purgeTrash();
    await this.persistUndo();
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
  }

  private async undoFor(callerId: AbjectId, action: UndoAction): Promise<unknown> {
    const caller = await this.undoCallerKey(callerId);
    return this.exclusive(async () => {
      const history = this.undo.get(caller);
      if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
      const result = await history[action](step => this.applyStep(step, action));
      await this.purgeTrash();
      await this.persistUndo();
      this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
      return result;
    });
  }

  /** Take a step back (undo) or forward again (redo). */
  private async applyStep(step: UndoStep<SkillStep>, action: UndoAction): Promise<unknown> {
    const d = step.data;
    if (d.kind === 'enable') {
      const match = this.findSkillEntry(d.name);
      if (!match) throw new UndoRefused(`'${d.name}' is not installed`);
      const [from, to] = action === 'undo' ? [d.after, d.before] : [d.before, d.after];
      if (match.entry.enabled !== from) throw new UndoRefused(`'${d.name}' was ${from ? 'disabled' : 'enabled'} since`);
      await this.applyEnabled(match.key, match.entry, to, to ? 'enabled' : 'disabled');
      return { name: match.key };
    }
    if (action === 'undo') {
      await this.restoreSkill(d);
      return { name: d.name };
    }
    const match = this.findSkillEntry(d.name);
    if (!match) throw new UndoRefused(`'${d.name}' is gone already`);
    if (await this.skillMdHash(match.entry.dirName) !== d.contentHash) throw new UndoRefused(`'${d.name}' changed since`);
    const again = await this.setSkillAside(match.key, match.entry);
    if (!again || again.kind !== 'uninstall') throw new UndoRefused(`'${d.name}' has no folder to set aside`);
    Object.assign(d, { dirName: again.dirName, enabled: again.enabled, trashId: again.trashId });
    return { name: d.name };
  }

  private async loadTrash(): Promise<void> {
    try {
      const items = JSON.parse(await fsPromises.readFile(path.join(this.trashDir, 'index.json'), 'utf-8')) as SkillTrashItem[];
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.id && typeof item.dirName === 'string') this.trash.set(item.id, item);
      }
    } catch { /* no trash yet */ }
    try {
      this.undo.load(JSON.parse(await fsPromises.readFile(path.join(this.trashDir, 'undo.json'), 'utf-8')) as Record<string, UndoHistoryJSON<SkillStep>>);
    } catch { /* no history yet */ }
  }

  private async persistTrash(): Promise<void> {
    try {
      await fsPromises.writeFile(path.join(this.trashDir, 'index.json'), JSON.stringify([...this.trash.values()]), 'utf-8');
    } catch (err) {
      log.warn(`Failed to persist the skill trash index: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Only uninstall steps go to disk: they point into the trash; enable steps stay in memory. */
  private async persistUndo(): Promise<void> {
    const out: Record<string, UndoHistoryJSON<SkillStep>> = {};
    for (const [caller, h] of Object.entries(this.undo.toJSON())) {
      const keep = (s: UndoStep<SkillStep>) => s.data.kind === 'uninstall';
      const saved = { done: h.done.filter(keep), undone: h.undone.filter(keep) };
      if (saved.done.length + saved.undone.length > 0) out[caller] = saved;
    }
    try {
      await fsPromises.writeFile(path.join(this.trashDir, 'undo.json'), JSON.stringify(out), 'utf-8');
    } catch (err) {
      log.warn(`Failed to persist skill undo history: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Forget uninstalled skills past keeping: what no undo step points at any
   * more, what was set aside before this session and longer ago than
   * TRASH_KEEP_MS, and beyond the count and size caps, oldest first. Steps
   * that pointed at what went are dropped.
   */
  private async purgeTrash(): Promise<void> {
    const referenced = new Set(this.undo.steps().map(s => s.data.kind === 'uninstall' ? s.data.trashId : undefined));
    const now = Date.now();
    const items = [...this.trash.values()].sort((a, b) => a.removedAt - b.removedAt);
    const gone = new Set(items.filter(t => !referenced.has(t.id)
      || (t.removedAt < this.sessionStartedAt && now - t.removedAt > TRASH_KEEP_MS)).map(t => t.id));
    let count = items.length - gone.size;
    let bytes = items.filter(t => !gone.has(t.id)).reduce((n, t) => n + t.bytes, 0);
    for (const t of items) {
      if (count <= TRASH_MAX_ITEMS && bytes <= TRASH_MAX_BYTES) break;
      if (gone.has(t.id)) continue;
      gone.add(t.id);
      count--;
      bytes -= t.bytes;
    }
    if (gone.size > 0) {
      for (const id of gone) {
        this.trash.delete(id);
        await fsPromises.rm(path.join(this.trashDir, id), { recursive: true, force: true });
      }
      await this.persistTrash();
    }
    const before = this.undo.steps().length;
    this.undo.prune(step => step.data.kind !== 'uninstall' || !step.data.trashId || this.trash.has(step.data.trashId));
    if (this.undo.steps().length !== before) await this.persistUndo();
  }

  // ─── MCP Bridge Lifecycle ──────────────────────────────────────

  private async spawnMCPBridge(name: string, entry: SkillEntry): Promise<void> {
    if (!this.factoryId || !entry.parsed.mcpServer) return;

    // Don't double-spawn
    if (this.mcpBridges.has(name)) {
      log.info(`MCPBridge for "${name}" already running`);
      return;
    }

    const config = this.skillConfigs.get(name);
    const env: Record<string, string> = { ...(config?.env ?? {}) };

    // Resolve required-secret frontmatter via SecretsVault before spawn so the
    // subprocess gets real values in its env without them transiting prompts.
    const secretMapping = extractRequiredSecretMapping(entry.parsed.frontmatter);
    if (secretMapping && this.secretsVaultId) {
      try {
        const bound = await this.request<{ env: Record<string, string>; missing: string[] }>(
          request(this.id, this.secretsVaultId, 'bindEnv', { owner: name, mapping: secretMapping }),
          5000,
        );
        Object.assign(env, bound.env);
        if (bound.missing.length > 0) {
          log.warn(`Skill "${name}" missing secrets: ${bound.missing.join(', ')}`);
        }
      } catch (err) {
        log.warn(`Failed to bind secrets for "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const result = await this.request<{ objectId: AbjectId }>(
        request(this.id, this.factoryId, 'spawn', {
          manifest: {
            name: 'MCPBridge',
            description: `MCP bridge for "${name}"`,
            version: '1.0.0',
            interface: { id: 'abjects:mcp-bridge', name: 'MCPBridge', description: 'MCP bridge', methods: [] },
            tags: ['system', 'mcp'],
          },
          constructorArgs: {
            serverName: name,
            command: entry.parsed.mcpServer.command,
            args: entry.parsed.mcpServer.args,
            url: entry.parsed.mcpServer.url,
            headers: entry.parsed.mcpServer.headers,
            oauthClientId: entry.parsed.mcpServer.oauthClientId,
            env,
            configFile: entry.parsed.configFile,
          },
        }),
      );
      this.mcpBridges.set(name, result.objectId);
      log.info(`Spawned MCPBridge for "${name}": ${result.objectId}`);
      // Hear about status changes that come later (a sign-in finishing).
      try {
        await this.request(request(this.id, result.objectId, 'addDependent', {}), 5000);
      } catch { /* status is still read on demand */ }

      // Factory.spawn awaits the bridge's onInit, which awaits the MCP
      // handshake, so the outcome is already decided. Read it now rather than
      // leaving callers to guess for three seconds.
      await this.refreshBridgeState(name).catch(() => {});
      const state = this.mcpBridgeStates.get(name);
      if (state?.status === 'error') {
        entry.error = state.error ?? 'MCP bridge failed to start';
      } else {
        entry.error = undefined;
      }

      // A server can also connect and then discover tools slightly later
      // (some publish tools/list_changed after init), so re-check shortly.
      if ((state?.toolCount ?? 0) === 0) {
        setTimeout(() => this.refreshBridgeState(name).catch(() => {}), 3000);
      }
    } catch (err) {
      log.error(`Failed to spawn MCPBridge for "${name}":`, err instanceof Error ? err.message : String(err));
      entry.error = `MCP spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.mcpBridgeStates.set(name, { status: 'error', error: entry.error, toolCount: 0 });
    }
  }

  /** Query a bridge's getStatus and cache the result. */
  private async refreshBridgeState(name: string): Promise<void> {
    const bridgeId = this.mcpBridges.get(name);
    if (!bridgeId) return;
    try {
      const status = await this.request<{ status: string; toolCount: number; error?: string; stderrTail?: string }>(
        request(this.id, bridgeId, 'getStatus', {}),
        5000,
      );
      this.mcpBridgeStates.set(name, {
        status: status.status,
        error: status.error,
        toolCount: status.toolCount,
        stderrTail: status.stderrTail,
      });
      if (status.status === 'error') {
        log.info(`MCPBridge "${name}" in error state: ${status.error}`);
      }
    } catch {
      this.mcpBridgeStates.set(name, { status: 'error', error: 'Bridge unreachable', toolCount: 0 });
    }
  }

  private async stopMCPBridge(name: string): Promise<void> {
    const bridgeId = this.mcpBridges.get(name);
    if (!bridgeId) return;

    this.mcpBridges.delete(name);
    this.mcpBridgeStates.delete(name);
    this.releaseBridgeWaiters(name);

    try {
      // Ask Factory to kill the bridge (Factory handles cleanup via Registry)
      if (this.factoryId) {
        await this.request(
          request(this.id, this.factoryId, 'kill', { objectId: bridgeId }),
        );
      }
      log.info(`Stopped MCPBridge for "${name}"`);
    } catch (err) {
      log.error(`Failed to stop MCPBridge for "${name}":`, err instanceof Error ? err.message : String(err));
    }
  }

  private async startEnabledMCPBridges(): Promise<void> {
    // Concurrent: each bridge boots an independent external process, and
    // one slow (or wedged) server must not delay the others.
    const pending: Array<Promise<void>> = [];
    for (const [name, entry] of this.skills) {
      if (entry.enabled && entry.parsed.mcpServer && !this.mcpBridges.has(name)) {
        pending.push(
          this.spawnMCPBridge(name, entry).catch((err) =>
            log.warn(`MCP bridge '${name}' failed to start: ${err instanceof Error ? err.message : String(err)}`)),
        );
      }
    }
    await Promise.allSettled(pending);
  }

  private async getEnabledMCPServerSummaries(): Promise<Array<{
    name: string;
    description: string;
    tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    bridgeId: string;
    status?: string;
  }>> {
    const summaries: Array<{
      name: string;
      description: string;
      tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
      bridgeId: string;
      status?: string;
    }> = [];

    for (const [name, bridgeId] of this.mcpBridges) {
      const entry = this.skills.get(name);
      if (!entry) continue;

      try {
        const tools = await this.request<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>(
          request(this.id, bridgeId, 'listTools', {}),
        );
        summaries.push({
          name,
          description: entry.parsed.description,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          })),
          bridgeId,
          status: this.mcpBridgeStates.get(name)?.status,
        });
      } catch (err) {
        log.error(`Failed to list tools from MCPBridge "${name}":`, err instanceof Error ? err.message : String(err));
        summaries.push({
          name,
          description: entry.parsed.description,
          tools: [],
          bridgeId,
          status: this.mcpBridgeStates.get(name)?.status,
        });
      }
    }

    return summaries;
  }
}

/**
 * Pull `required-secret` out of SKILL.md frontmatter. We accept two shapes:
 *
 *   required-secret:
 *     GMAIL_TOKEN: gmail_oauth_access_token
 *
 *   required-secret: gmail_oauth_access_token  (env var name == secret name)
 *
 * Returns a map of envVarName → secretName, or undefined if no secrets declared.
 */
/**
 * Heuristic: does this (non-MCP-parsed) skill look like it was meant to wrap an
 * MCP server but is missing its `mcp-command` frontmatter? We only trust an
 * explicit declared dependency on a known MCP launcher (mcporter / an mcp-server
 * package) so the warning stays precise rather than firing on any skill that
 * happens to mention "mcp".
 */
function looksLikeMcpSkill(parsed: ParsedSkill): boolean {
  if (parsed.mcpServer) return false;
  const bins = parsed.requiredBins ?? [];
  return bins.some(b => /^mcporter$|mcp-server/i.test(b));
}

function extractRequiredSecretMapping(frontmatter: Record<string, unknown>): Record<string, string> | undefined {
  const raw = frontmatter['required-secret'];
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'string' && raw.length > 0) {
    return { [raw]: raw };
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [env, secret] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof secret === 'string' && secret.length > 0) {
        out[env] = secret;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return undefined;
}

/** Total size of the files under a directory. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsPromises.stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Move a directory, copying when it crosses file systems. */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fsPromises.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsPromises.cp(from, to, { recursive: true });
    await fsPromises.rm(from, { recursive: true, force: true });
  }
}

export const SKILL_REGISTRY_ID = 'abjects:skill-registry' as AbjectId;
