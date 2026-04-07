/**
 * SkillRegistry -- manages skill lifecycle for a workspace.
 *
 * Scans ~/.abject/skills/ for SKILL.md files (compatible with Claude Code and
 * OpenClaw formats), manages enable/disable state, and provides enabled skill
 * summaries for AgentAbject to inject into LLM prompts.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { require as contractRequire } from '../core/contracts.js';
import { parseSkillMd, ParsedSkill } from '../core/skill-parser.js';
import type { SkillInfo, SkillConfig, EnabledSkillSummary } from '../core/skill-types.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SkillRegistry');

const SKILL_REGISTRY_INTERFACE: InterfaceId = 'abjects:skill-registry';
const STORAGE_KEY = 'skills:states';
const CONFIG_STORAGE_KEY = 'skills:config';

interface SkillEntry {
  parsed: ParsedSkill;
  enabled: boolean;
  error?: string;
}

export class SkillRegistry extends Abject {
  private skills = new Map<string, SkillEntry>();
  private skillConfigs = new Map<string, SkillConfig>();
  private skillsDir: string;
  private storageId?: AbjectId;
  private shellExecutorId?: AbjectId;

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
              description: 'Enable a skill',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
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
              name: 'installSkill',
              description: 'Install a skill by writing SKILL.md to disk',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill directory name' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'SKILL.md file content' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'uninstallSkill',
              description: 'Remove a skill from disk',
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
              description: 'Set configuration (env vars) for a skill and persist',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill name' },
                { name: 'env', type: { kind: 'object', properties: {} }, description: 'Key-value map of environment variables' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
          events: [
            {
              name: 'skillsChanged',
              description: 'Emitted when skills are scanned, enabled, disabled, installed, or uninstalled',
              payload: { kind: 'object', properties: {
                reason: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.SKILL_MANAGE],
        tags: ['system', 'skill'],
      },
    });

    this.skillsDir = skillsDir ?? path.join(process.cwd(), '.abjects', 'skills');
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    // Ensure skills directory exists
    fs.mkdirSync(this.skillsDir, { recursive: true });

    // Scan for skills
    await this.doScan();

    // Load persisted enable/disable states and configs
    await this.loadStates();
    await this.loadConfigs();

    this.shellExecutorId = await this.discoverDep('ShellExecutor') ?? undefined;
    await this.pushEnvToShell();

    log.info(`Initialized with ${this.skills.size} skills in ${this.skillsDir}`);
  }

  protected override getSourceForAsk(): string | undefined {
    return `## SkillRegistry Usage Guide

SkillRegistry manages the lifecycle of skills (SKILL.md files). It scans the
skills directory, handles enable/disable state, configuration (env vars), and
provides enabled skill summaries for agent prompt injection.

### List all discovered skills

  const skills = await call(await dep('SkillRegistry'), 'listSkills', {});
  // Returns SkillInfo[]: { name, description, version, source, enabled, error, ... }

### Enable / disable a skill

  await call(await dep('SkillRegistry'), 'enableSkill', { name: 'my-skill' });
  await call(await dep('SkillRegistry'), 'disableSkill', { name: 'my-skill' });

### Re-scan the skills directory

  const result = await call(await dep('SkillRegistry'), 'scanSkills', {});
  // result: { found: <number> }

### Install / uninstall a skill

  await call(await dep('SkillRegistry'), 'installSkill', { name: 'my-skill', content: '---\\nname: my-skill\\n---\\nInstructions...' });
  await call(await dep('SkillRegistry'), 'uninstallSkill', { name: 'my-skill' });

### Get enabled skill summaries (for prompt injection)

  const summaries = await call(await dep('SkillRegistry'), 'getEnabledSkills', {});
  // Returns EnabledSkillSummary[]: { name, description, instructions, allowedTools, env }

### Configure environment variables for a skill

  await call(await dep('SkillRegistry'), 'setSkillConfig', { name: 'my-skill', env: { API_KEY: 'xxx' } });
  const config = await call(await dep('SkillRegistry'), 'getSkillConfig', { name: 'my-skill' });

### Events

SkillRegistry emits 'skillsChanged' (with reason: enabled|disabled|scanned|installed|uninstalled|configured)
whenever the skill set changes.

### IMPORTANT
- The interface ID is '${SKILL_REGISTRY_INTERFACE}'.
- Skills are SKILL.md files in subdirectories of the skills/ folder.
- Compatible with Claude Code and OpenClaw SKILL.md formats.`;
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
      const entry = this.skills.get(name);
      if (!entry) throw new Error(`Skill "${name}" not found`);
      entry.enabled = true;
      await this.persistStates();
      await this.pushEnvToShell();
      this.changed('skillsChanged', { reason: 'enabled' });
      log.info(`Enabled skill: ${name}`);
      return { success: true };
    });

    this.on('disableSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const entry = this.skills.get(name);
      if (!entry) throw new Error(`Skill "${name}" not found`);
      entry.enabled = false;
      await this.persistStates();
      await this.pushEnvToShell();
      this.changed('skillsChanged', { reason: 'disabled' });
      log.info(`Disabled skill: ${name}`);
      return { success: true };
    });

    this.on('scanSkills', async () => {
      await this.doScan();
      this.changed('skillsChanged', { reason: 'scanned' });
      return { found: this.skills.size };
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
      this.changed('skillsChanged', { reason: 'installed' });
      log.info(`Installed skill: ${name}`);
      return { success: true };
    });

    this.on('uninstallSkill', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');

      const entry = this.skills.get(name);
      if (!entry) throw new Error(`Skill "${name}" not found`);

      const skillDir = path.join(this.skillsDir, name);
      await fsPromises.rm(skillDir, { recursive: true, force: true });
      this.skills.delete(name);
      await this.persistStates();
      this.changed('skillsChanged', { reason: 'uninstalled' });
      log.info(`Uninstalled skill: ${name}`);
      return { success: true };
    });

    this.on('getEnabledSkills', async () => {
      return this.getEnabledSummaries();
    });

    this.on('getSkillConfig', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      return this.skillConfigs.get(name) ?? { env: {} };
    });

    this.on('setSkillConfig', async (msg: AbjectMessage) => {
      const { name, env } = msg.payload as { name: string; env: Record<string, string> };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      this.skillConfigs.set(name, { env: env ?? {} });
      await this.persistConfigs();
      await this.pushEnvToShell();
      this.changed('skillsChanged', { reason: 'configured' });
      log.info(`Saved config for skill: ${name}`);
      return { success: true };
    });
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
        });
      } catch (err) {
        // If SKILL.md doesn't exist or can't be parsed, skip this directory
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        log.info(`Error reading skill "${dirName}": ${err instanceof Error ? err.message : String(err)}`);
        this.skills.set(dirName, {
          parsed: { frontmatter: {}, name: dirName, description: '', instructions: '', source: 'unknown' },
          enabled: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info(`Scanned ${this.skills.size} skills`);
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

  /** Collect env vars from all enabled skills and push to ShellExecutor. */
  private async pushEnvToShell(): Promise<void> {
    if (!this.shellExecutorId) return;
    const merged: Record<string, string> = {};
    for (const [name, entry] of this.skills) {
      if (!entry.enabled) continue;
      const config = this.skillConfigs.get(name);
      if (config?.env) {
        Object.assign(merged, config.env);
      }
    }
    try {
      await this.request(
        request(this.id, this.shellExecutorId, 'setSkillEnv', { env: merged }),
      );
    } catch { /* ShellExecutor may not be ready */ }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private getSkillInfoList(): SkillInfo[] {
    return [...this.skills.values()].map(e => this.entryToInfo(e));
  }

  private entryToInfo(entry: SkillEntry): SkillInfo {
    const config = this.skillConfigs.get(entry.parsed.name);
    return {
      name: entry.parsed.name,
      description: entry.parsed.description,
      version: entry.parsed.version,
      source: entry.parsed.source,
      enabled: entry.enabled,
      error: entry.error,
      allowedTools: entry.parsed.allowedTools,
      requiredBins: entry.parsed.requiredBins,
      requiredEnv: entry.parsed.requiredEnv,
      configuredEnvKeys: config?.env ? Object.keys(config.env).filter(k => config.env[k]) : undefined,
    };
  }

  private getEnabledSummaries(): EnabledSkillSummary[] {
    const summaries: EnabledSkillSummary[] = [];
    for (const [name, entry] of this.skills) {
      if (!entry.enabled || entry.error) continue;
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
}

export const SKILL_REGISTRY_ID = 'abjects:skill-registry' as AbjectId;
