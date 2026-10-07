/**
 * Settings for commune: reading, showing and changing the global settings
 * (SettingsManager, through CliServer) and the per-workspace ones, by path.
 *
 * A path names a field: `<section>.<field>` for global settings, where the
 * field may itself be dotted (`ai.credentials.anthropic`, `ai.tiers.smart`,
 * `shell.objectRules.Builder`), and `<section>.<field>` for a workspace
 * (`general.description`, `access.accessMode`, `web.entries.Portal`). Values
 * are typed as text and parsed by the field's type. Shared by the tabbed TUI
 * and the plain REPL.
 */

import type { CommuneClient } from './client.js';
import type { Line } from './tui.js';
import type { SettingField } from '../src/objects/settings-manager.js';

export type { SettingField };

/** A section of settings: SettingsManager's global ones, or a workspace's. */
export interface SettingsSectionSchema { id: string; label: string; description: string; fields: SettingField[] }

/** Every global section's values, keyed by section id. */
export type GlobalValues = Record<string, Record<string, unknown>>;

/** A workspace's settings as CliServer's getWorkspaceSettings returns them. */
export interface WorkspaceSettings {
  general: { name: string; description: string; tags: string[] };
  access: { accessMode: string; whitelist: string[]; exposedObjectIds: string[]; joined: boolean };
  web: { enabled: boolean; entries: Record<string, { access: string; methods?: string[] | null; mode?: string; handler?: string }> } | null;
  appearance: { active: string; presets: Array<{ id: string; name: string }> } | null;
}

/** The workspace fields commune edits, in the same shape as the global schema. */
export function workspaceSchema(ws: WorkspaceSettings): SettingsSectionSchema[] {
  const sections = [
    {
      id: 'general', label: 'General', description: 'Name, description and tags.',
      fields: [
        { key: 'name', label: 'Name', type: 'string' },
        { key: 'description', label: 'Description', type: 'string' },
        { key: 'tags', label: 'Tags', type: 'list' },
      ],
    },
    {
      id: 'access', label: 'Access', description: 'Who may join this workspace.',
      fields: [
        { key: 'accessMode', label: 'Access mode', type: 'enum', options: ['local', 'shared', 'public'] },
        { key: 'whitelist', label: 'Whitelist (peer ids)', type: 'list' },
      ],
    },
  ] as SettingsSectionSchema[];
  if (ws.web) {
    sections.push({
      id: 'web', label: 'Web', description: 'Serve this workspace\'s abjects over HTTP.',
      fields: [
        { key: 'enabled', label: 'Serve over HTTP', type: 'boolean' },
        { key: 'entries', label: 'Exposed abjects', type: 'rules', description: 'Abject name to access (public or authenticated); edit with /wset web.entries.<Name> public|authenticated|none' },
      ],
    });
  }
  if (ws.appearance) {
    sections.push({
      id: 'appearance', label: 'Appearance', description: 'The workspace theme.',
      fields: [{ key: 'theme', label: 'Theme', type: 'enum', options: ws.appearance.presets.map(p => p.id) }],
    });
  }
  return sections;
}

/** The values the workspace schema reads, keyed like the global ones. */
export function workspaceValues(ws: WorkspaceSettings): GlobalValues {
  return {
    general: { ...ws.general },
    access: { accessMode: ws.access.accessMode, whitelist: ws.access.whitelist },
    ...(ws.web ? { web: { enabled: ws.web.enabled, entries: ws.web.entries } } : {}),
    ...(ws.appearance ? { appearance: { theme: ws.appearance.active } } : {}),
  };
}

// ── Paths ────────────────────────────────────────────────────────────────

export interface ResolvedPath {
  section: SettingsSectionSchema;
  field: SettingField;
  /** The map key after a rules/grants field (`shell.objectRules.Builder` → `Builder`). */
  subKey?: string;
}

/** Find the field a path names: the longest field key that prefixes what follows the section. */
export function resolvePath(schema: SettingsSectionSchema[], path: string): ResolvedPath {
  const dot = path.indexOf('.');
  const sectionId = dot < 0 ? path : path.slice(0, dot);
  const rest = dot < 0 ? '' : path.slice(dot + 1);
  const section = schema.find(s => s.id === sectionId);
  if (!section) throw new Error(`no settings section "${sectionId}" (sections: ${schema.map(s => s.id).join(', ')})`);
  if (!rest) throw new Error(`name a field: ${section.fields.map(f => `${section.id}.${f.key}`).join(', ')}`);
  const fields = [...section.fields].sort((a, b) => b.key.length - a.key.length);
  for (const field of fields) {
    if (rest === field.key) return { section, field };
    if ((field.type === 'rules' || field.type === 'grants') && rest.startsWith(`${field.key}.`)) {
      return { section, field, subKey: rest.slice(field.key.length + 1) };
    }
  }
  throw new Error(`no field "${rest}" in ${section.id} (fields: ${section.fields.map(f => f.key).join(', ')})`);
}

/** Read a dotted key out of a section's values (`credentials.anthropic`). */
export function readField(values: Record<string, unknown> | undefined, key: string): unknown {
  let cur: unknown = values;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ── Formatting ───────────────────────────────────────────────────────────

/** One value as a short line of text. */
export function formatValue(field: SettingField, value: unknown): string {
  if (value === undefined || value === null) return '(unset)';
  switch (field.type) {
    case 'secret': {
      const v = value as { set?: boolean };
      return v.set ? 'set (hidden)' : 'not set';
    }
    case 'string':
      if (typeof value === 'object') {
        const v = value as { set?: boolean; value?: string };
        return v.value ?? (v.set ? 'set' : 'not set');
      }
      return String(value) === '' ? '(empty)' : String(value);
    case 'boolean': return value ? 'on' : 'off';
    case 'list': {
      const list = value as string[];
      return list.length === 0 ? '(none)' : list.join(', ');
    }
    case 'model': {
      const v = value as { provider: string; model: string; effort?: string };
      return `${v.provider} / ${v.model}${v.effort ? ` (effort ${v.effort})` : ''}`;
    }
    case 'rules': {
      const map = value as Record<string, { allow?: string[]; deny?: string[]; access?: string }>;
      const names = Object.keys(map);
      if (names.length === 0) return '(none)';
      return names.map(n => {
        const r = map[n];
        if (r.access !== undefined) return `${n}: ${r.access}`;
        const parts = [r.allow?.length ? `allow ${r.allow.join(',')}` : '', r.deny?.length ? `deny ${r.deny.join(',')}` : ''].filter(Boolean);
        return `${n}: ${parts.join(' ') || '(nothing)'}`;
      }).join('; ');
    }
    case 'grants': {
      const map = value as Record<string, string[]>;
      const names = Object.keys(map);
      return names.length === 0 ? '(none)' : names.map(n => `${n}: ${map[n].join(',')}`).join('; ');
    }
    default: return String(value);
  }
}

/** The text an edit starts from (secrets start empty). */
export function editText(field: SettingField, value: unknown, subKey?: string): string {
  if (value === undefined || value === null) return '';
  switch (field.type) {
    case 'secret': return '';
    case 'string': return typeof value === 'object' ? ((value as { value?: string }).value ?? '') : String(value);
    case 'boolean': return value ? 'on' : 'off';
    case 'list': return (value as string[]).join(', ');
    case 'model': {
      const v = value as { provider: string; model: string; effort?: string };
      return `${v.provider} ${v.model}${v.effort ? ` ${v.effort}` : ''}`;
    }
    case 'rules': {
      if (!subKey) return '';
      const r = (value as Record<string, { allow?: string[]; deny?: string[]; access?: string }>)[subKey];
      if (!r) return '';
      if (r.access !== undefined) return r.access;
      return [r.allow?.length ? `allow ${r.allow.join(',')}` : '', r.deny?.length ? `deny ${r.deny.join(',')}` : ''].filter(Boolean).join(' ');
    }
    case 'grants': return subKey ? ((value as Record<string, string[]>)[subKey] ?? []).join(',') : '';
    default: return String(value);
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────

const CLEAR_WORDS = new Set(['none', 'null', 'unset', '-']);

function splitList(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * The setSettings values for one field set from text, merged into what a
 * map-valued field already holds (rules, grants) so the rest survives.
 */
export function buildUpdate(target: ResolvedPath, text: string, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const { field, subKey } = target;
  const raw = text.trim();
  const clear = CLEAR_WORDS.has(raw.toLowerCase());
  let value: unknown;
  switch (field.type) {
    case 'boolean': {
      const t = raw.toLowerCase();
      if (['on', 'true', 'yes', '1'].includes(t)) value = true;
      else if (['off', 'false', 'no', '0'].includes(t)) value = false;
      else throw new Error(`${field.key} takes on or off`);
      break;
    }
    case 'enum':
      if (!field.options?.includes(raw)) throw new Error(`${field.key} takes one of: ${field.options?.join(', ')}`);
      value = raw;
      break;
    case 'list':
      value = clear ? [] : splitList(raw);
      break;
    case 'secret':
    case 'string':
      value = clear && field.nullable ? null : raw;
      break;
    case 'model': {
      if (clear) {
        if (!field.nullable) throw new Error(`${field.key} cannot be unset`);
        value = null;
        break;
      }
      const [provider, model, effort] = raw.split(/\s+/);
      if (!provider || !model) throw new Error(`${field.key} takes "<provider> <model> [effort]" or none`);
      if (field.options && !field.options.includes(provider)) throw new Error(`unknown provider "${provider}" (providers: ${field.options.join(', ')})`);
      value = { provider, model, ...(effort ? { effort } : {}) };
      break;
    }
    case 'rules': {
      if (!subKey) throw new Error(`name the entry: ${field.key}.<Name>`);
      const map = { ...((readField(current, field.key) as Record<string, unknown>) ?? {}) };
      if (clear) {
        if (field.key === 'entries') { value = { [subKey]: null }; break; }
        delete map[subKey];
      } else if (field.key === 'entries') {
        // A workspace web entry: an access level, the rest of the entry kept.
        if (raw !== 'public' && raw !== 'authenticated') throw new Error('web entries take public, authenticated, or none');
        const existing = (map[subKey] as Record<string, unknown> | undefined) ?? {};
        value = { [subKey]: { ...existing, access: raw } };
        break;
      } else {
        const allow = /allow\s+([^\s]+)/i.exec(raw)?.[1];
        const deny = /deny\s+([^\s]+)/i.exec(raw)?.[1];
        if (!allow && !deny) throw new Error('rules take "allow a,b deny c" (either part) or none');
        map[subKey] = { allow: allow ? splitList(allow) : [], deny: deny ? splitList(deny) : [] };
      }
      value = map;
      break;
    }
    case 'grants': {
      if (!subKey) throw new Error(`name the skill: ${field.key}.<skill>`);
      const map = { ...((readField(current, field.key) as Record<string, unknown>) ?? {}) };
      if (clear) delete map[subKey]; else map[subKey] = splitList(raw);
      value = map;
      break;
    }
    default:
      value = raw;
  }
  // Dotted keys become nested objects: credentials.anthropic → { credentials: { anthropic } }.
  const parts = field.key.split('.');
  let out: Record<string, unknown> = { [parts[parts.length - 1]]: value };
  for (let i = parts.length - 2; i >= 0; i--) out = { [parts[i]]: out };
  return out;
}

/** A list field with one item added or removed. */
export function listEdit(target: ResolvedPath, current: Record<string, unknown> | undefined, item: string, add: boolean): Record<string, unknown> {
  if (target.field.type !== 'list') throw new Error(`${target.field.key} is not a list`);
  const list = [...((readField(current, target.field.key) as string[]) ?? [])];
  const next = add ? (list.includes(item) ? list : [...list, item]) : list.filter(x => x !== item);
  return { [target.field.key]: next };
}

/** A settings refusal as a sentence: the transport and contract prefixes dropped. */
export function settingsErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^.*\[(REQUIRE|ENSURE|INVARIANT)\]\s*/, '').replace(/^(Error:\s*)+/, '');
}

// ── Reading everything ───────────────────────────────────────────────────

export interface SettingsSnapshot {
  schema: SettingsSectionSchema[];
  values: GlobalValues;
  workspace?: { id: string; name: string; schema: SettingsSectionSchema[]; values: GlobalValues };
}

export async function loadSettings(client: CommuneClient, workspace?: { id: string; name: string }): Promise<SettingsSnapshot> {
  const [schema, values] = await Promise.all([
    client.request<SettingsSectionSchema[]>('getSettingsSchema'),
    client.request<GlobalValues>('getSettings'),
  ]);
  const snapshot: SettingsSnapshot = { schema, values };
  if (workspace) {
    const ws = await client.request<WorkspaceSettings>('getWorkspaceSettings', { workspaceId: workspace.id });
    snapshot.workspace = { id: workspace.id, name: workspace.name, schema: workspaceSchema(ws), values: workspaceValues(ws) };
  }
  return snapshot;
}

/** Help for the settings commands, shared by both modes. */
export const SETTINGS_HELP: string[] = [
  'settings:',
  '  /settings              browse and edit every setting (↑/↓ select, Enter edits, Esc leaves)',
  '  /get [path]            show settings: /get, /get shell, /get ai.tiers.smart',
  '  /set <path> <value>    change one: /set shell.enabled off, /set ai.tiers.smart anthropic claude-sonnet-4-5',
  '                         /set ai.credentials.anthropic sk-...   /set shell.objectRules.Builder allow make deny rm',
  '  /add /remove <path> <item>   one item of a list: /add web.allowedDomains example.com',
  '  /wget, /wset <path> <value>  this workspace: /wset general.description …, /wset appearance.theme agitprop',
  '  /presets, /preset apply|save|delete <name>, /models <provider>',
  '  /packages, /package enable|disable <name>, /skills, /skill enable|disable <name>',
  '  /update [check|download|restart|auto on|off]   software updates (desktop app)',
  '  values: on/off for switches, a,b,c for lists, none to clear',
];

// ── Commands ─────────────────────────────────────────────────────────────

const SETTINGS_COMMANDS = new Set(['get', 'set', 'add', 'remove', 'wget', 'wset', 'presets', 'preset', 'models', 'packages', 'package', 'skills', 'skill', 'update']);

export function isSettingsCommand(cmd: string): boolean {
  return SETTINGS_COMMANDS.has(cmd);
}

/** One section as lines: a heading, then each field and its value. */
export function sectionLines(section: SettingsSectionSchema, values: Record<string, unknown> | undefined, prefix = ''): Line[] {
  const lines: Line[] = [{ text: `${prefix}${section.label} (${section.id}): ${section.description}`, color: 'bold' }];
  for (const field of section.fields) {
    lines.push({ text: `  ${section.id}.${field.key}  ${formatValue(field, readField(values, field.key))}`, color: 'normal' });
  }
  return lines;
}

/**
 * Run one settings command (without its slash) and return what to print.
 * `workspace` is the workspace the terminal is pointed at, for /wget and /wset.
 */
export async function runSettingsCommand(
  client: CommuneClient, cmd: string, args: string[], workspace?: { id: string; name: string },
): Promise<Line[]> {
  const arg = args.join(' ').trim();
  const ok = (text: string): Line[] => [{ text, color: 'green' }];
  switch (cmd) {
    case 'get': {
      const snap = await loadSettings(client);
      if (!arg) return snap.schema.flatMap(s => sectionLines(s, snap.values[s.id]));
      const section = snap.schema.find(s => s.id === arg);
      if (section) return sectionLines(section, snap.values[section.id]);
      const target = resolvePath(snap.schema, arg);
      return [{ text: `${arg}  ${formatValue(target.field, readField(snap.values[target.section.id], target.field.key))}`, color: 'normal' }];
    }
    case 'set': {
      const [path, ...rest] = args;
      if (!path || rest.length === 0) throw new Error('usage: /set <path> <value>   (none clears)');
      const snap = await loadSettings(client);
      const target = resolvePath(snap.schema, path);
      const values = buildUpdate(target, rest.join(' '), snap.values[target.section.id]);
      const after = await client.request<Record<string, unknown>>('setSettings', { section: target.section.id, values }, 60_000);
      return ok(`${path} = ${formatValue(target.field, readField(after, target.field.key))}`);
    }
    case 'add':
    case 'remove': {
      const [path, ...rest] = args;
      const item = rest.join(' ').trim();
      if (!path || !item) throw new Error(`usage: /${cmd} <path> <item>`);
      const snap = await loadSettings(client);
      const target = resolvePath(snap.schema, path);
      const values = listEdit(target, snap.values[target.section.id], item, cmd === 'add');
      const after = await client.request<Record<string, unknown>>('setSettings', { section: target.section.id, values }, 60_000);
      return ok(`${path} = ${formatValue(target.field, readField(after, target.field.key))}`);
    }
    case 'wget':
    case 'wset': {
      if (!workspace) throw new Error('no workspace: open a chat tab first');
      const snap = await loadSettings(client, workspace);
      const ws = snap.workspace!;
      if (cmd === 'wget') {
        if (!arg) return ws.schema.flatMap(s => sectionLines(s, ws.values[s.id], `${ws.name} · `));
        const section = ws.schema.find(s => s.id === arg);
        if (section) return sectionLines(section, ws.values[section.id], `${ws.name} · `);
        const target = resolvePath(ws.schema, arg);
        return [{ text: `${arg}  ${formatValue(target.field, readField(ws.values[target.section.id], target.field.key))}`, color: 'normal' }];
      }
      const [path, ...rest] = args;
      if (!path || rest.length === 0) throw new Error('usage: /wset <path> <value>');
      const target = resolvePath(ws.schema, path);
      const values = target.section.id === 'appearance' && target.field.key === 'theme'
        ? { theme: rest.join(' ').trim() }
        : buildUpdate(target, rest.join(' '), ws.values[target.section.id]);
      if (target.section.id === 'appearance' && !target.field.options?.includes(String(values.theme))) {
        throw new Error(`themes: ${target.field.options?.join(', ')}`);
      }
      await client.request('setWorkspaceSettings', { workspaceId: ws.id, section: target.section.id, values }, 60_000);
      const after = (await loadSettings(client, workspace)).workspace!.values[target.section.id];
      const shown = target.subKey ? editText(target.field, readField(after, target.field.key), target.subKey) || '(removed)'
        : formatValue(target.field, readField(after, target.field.key));
      return ok(`${ws.name}: ${path} = ${shown}`);
    }
    case 'presets': {
      const list = await client.request<Array<{ name: string; builtin: boolean }>>('listPresets', {}, 60_000);
      return [
        { text: 'presets (saved first, then built-in):', color: 'bold' },
        ...list.map(p => ({ text: `  ${p.name}${p.builtin ? '' : '  (saved)'}`, color: 'normal' as const })),
      ];
    }
    case 'preset': {
      const [action, ...rest] = args;
      const name = rest.join(' ').trim();
      if (!['apply', 'save', 'delete'].includes(action ?? '') || !name) throw new Error('usage: /preset apply|save|delete <name>');
      const op = action === 'apply' ? 'applyPreset' : action === 'save' ? 'savePreset' : 'deletePreset';
      await client.request(op, { name }, 60_000);
      return ok(`preset ${action === 'apply' ? 'applied' : action === 'save' ? 'saved' : 'deleted'}: ${name}`);
    }
    case 'models': {
      if (!arg) throw new Error('usage: /models <provider>');
      const models = await client.request<Array<{ id: string; name: string; vision?: boolean }>>('listModels', { provider: arg }, 60_000);
      return [
        { text: `${arg} models:`, color: 'bold' },
        ...models.slice(0, 200).map(m => ({ text: `  ${m.id}${m.name && m.name !== m.id ? `  (${m.name})` : ''}${m.vision ? '  vision' : ''}`, color: 'normal' as const })),
      ];
    }
    case 'packages': {
      const r = await client.request<{ packages: Array<{ name: string; version: string; status: string; loaded: boolean }> }>('listPackages');
      return [
        { text: 'packages:', color: 'bold' },
        ...r.packages.map(p => ({ text: `  ${p.name} ${p.version}  ${p.status}${p.loaded ? ', running' : ''}`, color: 'normal' as const })),
      ];
    }
    case 'package': {
      const [action, name] = args;
      if (!['enable', 'disable'].includes(action ?? '') || !name) throw new Error('usage: /package enable|disable <name>');
      await client.request('setPackageEnabled', { name, enabled: action === 'enable' });
      return ok(`package ${name} ${action}d (takes effect when Abject restarts)`);
    }
    case 'skills': {
      const list = await client.request<Array<{ name: string; enabled: boolean; source?: string }>>('listSkills');
      return [
        { text: 'skills:', color: 'bold' },
        ...list.map(sk => ({ text: `  ${sk.name}  ${sk.enabled ? 'enabled' : 'disabled'}${sk.source ? `  (${sk.source})` : ''}`, color: 'normal' as const })),
      ];
    }
    case 'skill': {
      const [action, name] = args;
      if (!['enable', 'disable'].includes(action ?? '') || !name) throw new Error('usage: /skill enable|disable <name>');
      await client.request('setSkillEnabled', { name, enabled: action === 'enable' }, 60_000);
      return ok(`skill ${name} ${action}d`);
    }
    case 'update': {
      const [action, value] = args;
      if (!action) {
        const s = await client.request<{ state: string; currentVersion: string; latestVersion?: string; percent?: number; error?: string; installKind: string }>('getUpdateStatus');
        return [{ text: `Abject ${s.currentVersion}: ${s.state}${s.latestVersion && s.latestVersion !== s.currentVersion ? `, version ${s.latestVersion}` : ''}${s.state === 'downloading' ? ` ${s.percent ?? 0}%` : ''}${s.error ? ` (${s.error})` : ''}`, color: 'normal' }];
      }
      if (action === 'restart' && value !== 'now') {
        return [{ text: 'Restarting interrupts any running goals. Type /update restart now to go ahead.', color: 'yellow' }];
      }
      if (action === 'auto') {
        if (value !== 'on' && value !== 'off') throw new Error('usage: /update auto on|off');
        await client.request('updateAction', { action: 'autoDownload', enabled: value === 'on' });
        return ok(`automatic downloads ${value}`);
      }
      if (!['check', 'download', 'restart'].includes(action)) throw new Error('usage: /update [check|download|restart|auto on|off]');
      await client.request('updateAction', { action }, 300_000);
      return ok(action === 'restart' ? 'restarting into the new version' : `update ${action} started`);
    }
  }
  throw new Error(`not a settings command: /${cmd}`);
}
