/**
 * Host MCP server import -- discovers MCP servers already configured on the
 * host machine by other tools (mcporter, openclaw/"clawdbot") and synthesises
 * abjects SKILL.md files for them.
 *
 * Why this exists: a user may already have working MCP servers wired up through
 * mcporter or openclaw. Rather than asking them to re-declare each server as a
 * SKILL.md by hand, we read those host configs and generate the correct
 * `mcp-command` / `mcp-args` frontmatter so abjects can bridge the server
 * natively (its own MCPBridge, message-passing, capability gating) instead of
 * shelling out to the host tool.
 *
 * Source roles:
 *  - mcporter  -- authoritative command source: `{ command, args, env }` per server.
 *  - openclaw  -- credential source only: stores `{ enabled, env }` per skill name,
 *                 not command/args. We merge its env into a matching mcporter server.
 *
 * Cross-platform path resolution mirrors how each tool resolves its own paths,
 * so this works the same on Windows, macOS, and Linux (we ship apps for all
 * three). Node's `path`/`os` already adapt to the host, so the only real
 * per-OS variance is what `os.homedir()` returns and the env overrides below:
 *
 *   mcporter home config (first existing wins):
 *     1. $MCPORTER_CONFIG                                   (exact file, highest priority)
 *     2. $XDG_CONFIG_HOME/mcporter/mcporter.json[c]         (only if XDG set & absolute)
 *     3. <homedir>/.mcporter/mcporter.json[c]               (legacy default, all OSes)
 *   openclaw config:
 *     <$OPENCLAW_HOME | $HOME | homedir>/.openclaw/openclaw.json
 *
 * Notably mcporter does NOT use %APPDATA% for its OWN config on Windows (that is
 * only used when it imports other editors' configs); it is `.mcporter` under the
 * home directory, which on Windows is C:\Users\<name>\.mcporter.
 *
 * This module is pure (filesystem + env reads + string synthesis) so it carries
 * no Abject state and is easy to reason about.
 */

import * as fs from 'fs';
import * as path from 'path';

type Env = Record<string, string | undefined>;

/** A bridgeable MCP server discovered from a host tool's config. */
export interface HostMcpServer {
  /** Server / skill name as the host tool knows it. */
  name: string;
  /** Launch command (e.g. "npx"). */
  command: string;
  /** Launch arguments (e.g. ["-y", "@presto-ai/google-workspace-mcp"]). */
  args: string[];
  /** Environment variables the server needs (merged from mcporter + openclaw). */
  env: Record<string, string>;
  /** Which host tool the command came from. */
  source: 'mcporter' | 'openclaw';
}

/** Expand a leading `~` to the home directory (matches mcporter's expandHome). */
function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

/**
 * Strip `//` line and block comments from a JSONC string in a string-aware way
 * (so URLs like "http://..." inside values survive). Trailing commas are left
 * alone -- a plain JSON.parse of the de-commented text covers the common case.
 */
function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && input[i + 1] === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Read and parse a JSON or JSONC file, returning undefined on any error. */
function safeReadJson(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  for (const text of [raw, stripJsonComments(raw)]) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      // try the comment-stripped form next
    }
  }
  return undefined;
}

/** Pick the string-valued entries out of an arbitrary env object. */
function stringEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/** Return the first path that exists on disk, or undefined. */
function firstExisting(paths: string[]): string | undefined {
  return paths.find(p => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Candidate paths for mcporter's home-scope config, in priority order, matching
 * mcporter's own resolver (`MCPORTER_CONFIG` → `XDG_CONFIG_HOME` → `~/.mcporter`,
 * each with `.json` and `.jsonc` variants).
 */
export function mcporterConfigCandidates(homeDir: string, env: Env): string[] {
  const explicit = env.MCPORTER_CONFIG?.trim();
  if (explicit) return [path.resolve(expandHome(explicit, homeDir))];

  const candidates: string[] = [];
  const legacyDir = path.join(homeDir, '.mcporter');

  const xdgRaw = env.XDG_CONFIG_HOME?.trim();
  if (xdgRaw) {
    const xdg = expandHome(xdgRaw, homeDir);
    if (path.isAbsolute(xdg)) {
      const xdgDir = path.join(xdg, 'mcporter');
      if (xdgDir !== legacyDir) {
        candidates.push(path.join(xdgDir, 'mcporter.json'), path.join(xdgDir, 'mcporter.jsonc'));
      }
    }
  }

  candidates.push(path.join(legacyDir, 'mcporter.json'), path.join(legacyDir, 'mcporter.jsonc'));
  return candidates;
}

/** Path to openclaw's config file, matching openclaw's own resolver. */
export function openclawConfigPath(homeDir: string, env: Env): string {
  const base = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homeDir;
  return path.join(base, '.openclaw', 'openclaw.json');
}

/**
 * Read mcporter's home-scope config, whose shape is
 * `{ mcpServers: { <name>: { command, args, env } } }`.
 */
export function readMcporterServers(homeDir: string, env: Env = process.env): HostMcpServer[] {
  const configPath = firstExisting(mcporterConfigCandidates(homeDir, env));
  if (!configPath) return [];
  const json = safeReadJson(configPath);
  const mcpServers = json?.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') return [];

  const out: HostMcpServer[] = [];
  for (const [name, cfgRaw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!cfgRaw || typeof cfgRaw !== 'object') continue;
    const cfg = cfgRaw as Record<string, unknown>;
    const command = typeof cfg.command === 'string' ? cfg.command : '';
    if (!command) continue; // skip remote (url-only) servers — not subprocess-bridgeable here
    const args = Array.isArray(cfg.args)
      ? cfg.args.filter((a): a is string => typeof a === 'string')
      : [];
    out.push({ name, command, args, env: stringEnv(cfg.env), source: 'mcporter' });
  }
  return out;
}

/**
 * Read openclaw's per-skill env (`openclaw.json` → `skills.entries.<name>.env`).
 * openclaw does not record a launch command here, so this only yields
 * credentials keyed by skill name.
 */
export function readOpenclawSkillEnv(homeDir: string, env: Env = process.env): Record<string, Record<string, string>> {
  const json = safeReadJson(openclawConfigPath(homeDir, env));
  const skills = json?.skills;
  const entries = skills && typeof skills === 'object'
    ? (skills as Record<string, unknown>).entries
    : undefined;
  if (!entries || typeof entries !== 'object') return {};

  const out: Record<string, Record<string, string>> = {};
  for (const [name, entryRaw] of Object.entries(entries as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object') continue;
    const skillEnv = stringEnv((entryRaw as Record<string, unknown>).env);
    if (Object.keys(skillEnv).length > 0) out[name] = skillEnv;
  }
  return out;
}

/**
 * Discover all bridgeable MCP servers configured on the host. Commands come from
 * mcporter; openclaw env is merged in by matching name (mcporter env wins on a
 * key conflict, since it is closer to the actual launch config).
 */
export function discoverHostMcpServers(homeDir: string, env: Env = process.env): HostMcpServer[] {
  const servers = readMcporterServers(homeDir, env);
  const openclawEnv = readOpenclawSkillEnv(homeDir, env);
  for (const server of servers) {
    const extra = openclawEnv[server.name];
    if (extra) server.env = { ...extra, ...server.env };
  }
  return servers;
}

/**
 * Synthesise a SKILL.md for a discovered host server. The launch command lives
 * in `mcp-command` / `mcp-args` frontmatter (so SkillRegistry spawns an MCPBridge
 * on enable). Secrets are NOT baked into the file -- the caller seeds those into
 * skill config separately, keeping the same storage path abjects already uses.
 */
export function synthesizeHostSkillMd(server: HostMcpServer): string {
  const frontmatter = [
    '---',
    `name: ${server.name}`,
    `description: ${JSON.stringify(`MCP server imported from host ${server.source} config.`)}`,
    `mcp-command: ${server.command}`,
    `mcp-args: ${JSON.stringify(server.args)}`,
    '---',
  ].join('\n');

  const envKeys = Object.keys(server.env);
  const envNote = envKeys.length > 0
    ? `\nEnvironment variables (${envKeys.join(', ')}) were carried over from your `
      + `${server.source} config. Manage them via the Installed Skills window or `
      + `SkillRegistry.setSkillConfig.\n`
    : '';

  const body = `# ${server.name}\n\n`
    + `Imported automatically from your host ${server.source} configuration `
    + `(\`${server.command} ${server.args.join(' ')}\`). Abjects bridges this MCP `
    + `server directly through its own MCPBridge, so the host tool does not need to `
    + `be running. Enable the skill to start the bridge.\n${envNote}`;

  return `${frontmatter}\n\n${body}`;
}
