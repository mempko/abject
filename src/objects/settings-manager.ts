/**
 * SettingsManager: the system's global settings, as data.
 *
 * Owns what the Settings window edits: model credentials and tier routing,
 * tier presets, the login that guards the UI and CLI sockets, and the
 * permissions the capability objects enforce. It loads them from global
 * Storage at boot, applies them (LLM `configure`, AuthGate `updateAuth`,
 * capability permissions and the prompt mode through PermissionBroker), validates and persists
 * every change, and announces it with a `settingsChanged` aspect.
 *
 * The Settings window (GlobalSettings) and the terminal client (through
 * CliServer) are two views of it; neither keeps settings of its own. Changes
 * are taken from those two only, and secrets (API keys, the login password)
 * are read back by the Settings window alone: every other reader sees whether
 * a secret is set, never its value.
 *
 * Storage keys keep their `global-settings:` prefix, so settings saved before
 * this object existed load unchanged.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { LLMProviderDescription, servesChat } from '../llm/provider.js';
import { LATEST_MODEL, aliasLadders, freezeModel, hasTierRules, resolveTier } from '../llm/tier-resolver.js';
import type { DecisionGates } from '../core/decision-sites.js';
import { parsePrivateHost } from './capabilities/address-policy.js';
import { PROMPT_MODES, type PromptMode } from './permission-broker.js';

const log = new Log('SettingsManager');

// ── Shapes ──────────────────────────────────────────────────────────────

export type ModelTierName = 'smart' | 'balanced' | 'fast' | 'code';
export const TIER_NAMES: ModelTierName[] = ['smart', 'balanced', 'fast', 'code'];
export const TIER_LABELS: Record<ModelTierName, string> = { smart: 'Smart', balanced: 'Balanced', fast: 'Fast', code: 'Code' };

/**
 * The single-model rows under the tiers: the model that stands in on
 * image-bearing steps when a tier's model is text-only, the one that stands
 * in for any tier whose own model has failed, and the decision route (Auto
 * when unset: a keyed decision provider, else emulation on the Fast tier).
 */
export type AuxRowKey = 'vision' | 'fallback' | 'decision';
export const AUX_ROW_KEYS: AuxRowKey[] = ['vision', 'fallback', 'decision'];

export interface TierRoute { provider: string; model: string; effort?: string }
export interface ModelRef { provider: string; model: string }
export interface ModelInfo { id: string; name: string; vision?: boolean; efforts?: string[]; created?: number; pricing?: { inputPerMTok: number; outputPerMTok: number } }

/** A named bundle of tier routing and the single-model rows. */
export interface TierPreset {
  routing: Partial<Record<ModelTierName, TierRoute>>;
  vision: ModelRef | null;
  /** Optional so presets saved before the row existed still load. */
  fallback?: ModelRef | null;
  /** Undefined (a preset saved before presets carried it) leaves the row as it is. */
  decision?: ModelRef | null;
}

/** A secret as readers see it; `value` only for the Settings window (or a value that is not secret). */
export interface SecretValue { set: boolean; value?: string }

export interface ObjectCommandRules { allow: string[]; deny: string[] }

export interface AiSettings {
  credentials: Record<string, SecretValue>;
  tiers: Record<ModelTierName, TierRoute | null>;
  vision: ModelRef | null;
  fallback: ModelRef | null;
  decision: ModelRef | null;
  decisionGates: DecisionGates;
  cacheKeepalive: boolean;
}
export interface AuthSettings { enabled: boolean; username: string; password: SecretValue }
export interface FilesystemSettings { allowedPaths: string[]; readOnly: boolean }
export interface ShellSettings {
  enabled: boolean;
  allowedCommands: string[];
  deniedCommands: string[];
  /** Per-object rules by object name: programs it may run, and programs it may not. */
  objectRules: Record<string, ObjectCommandRules>;
  /** Commands each skill was allowed to run (granted from a permission prompt). */
  skillGrants: Record<string, string[]>;
}
export interface WebSettings { enabled: boolean; allowedDomains: string[]; deniedDomains: string[]; privateHosts: string[] }
export interface PermissionsSettings { mode: PromptMode }

export interface SettingsBySection {
  ai: AiSettings;
  auth: AuthSettings;
  filesystem: FilesystemSettings;
  shell: ShellSettings;
  web: WebSettings;
  permissions: PermissionsSettings;
}
export type SettingsSectionId = keyof SettingsBySection;
export const SETTINGS_SECTIONS: SettingsSectionId[] = ['ai', 'auth', 'filesystem', 'shell', 'web', 'permissions'];

/** One field of the schema clients render settings from. */
export interface SettingField {
  /** Path inside the section's values, e.g. `credentials.anthropic`, `tiers.smart`. */
  key: string;
  label: string;
  /**
   * string, secret (write-only outside the Settings window), boolean, enum
   * (one of `options`), list (of strings), model ({ provider, model, effort? }
   * or null; `options` are the providers), rules (object name to allow/deny
   * program lists), grants (skill name to commands).
   */
  type: 'string' | 'secret' | 'boolean' | 'enum' | 'list' | 'model' | 'rules' | 'grants';
  description?: string;
  options?: string[];
  /** Whether null (unset) is accepted. */
  nullable?: boolean;
}
export interface SettingsSectionSchema { id: SettingsSectionId; label: string; description: string; fields: SettingField[] }

// ── Storage keys (the `global-settings:` prefix predates this object) ──

const STORAGE_PREFIX = 'global-settings:';
const storageKeyFor = (suffix: string): string => `${STORAGE_PREFIX}${suffix}`;
const STORAGE_KEY_AUTH_ENABLED = 'global-settings:authEnabled';
const STORAGE_KEY_AUTH_USER = 'global-settings:authUser';
const STORAGE_KEY_AUTH_PASS = 'global-settings:authPass';
const STORAGE_KEY_FS_ALLOWED_PATHS = 'global-settings:fsAllowedPaths';
const STORAGE_KEY_FS_READ_ONLY = 'global-settings:fsReadOnly';
const STORAGE_KEY_SHELL_ENABLED = 'global-settings:shellEnabled';
const STORAGE_KEY_SHELL_ALLOWED_CMDS = 'global-settings:shellAllowedCmds';
const STORAGE_KEY_SHELL_DENIED_CMDS = 'global-settings:shellDeniedCmds';
const STORAGE_KEY_WEB_ENABLED = 'global-settings:webEnabled';
const STORAGE_KEY_WEB_ALLOWED_DOMAINS = 'global-settings:webAllowedDomains';
const STORAGE_KEY_WEB_DENIED_DOMAINS = 'global-settings:webDeniedDomains';
const STORAGE_KEY_WEB_PRIVATE_HOSTS = 'global-settings:webPrivateHosts';
const STORAGE_KEY_PROMPT_MODE = 'global-settings:permissionPromptMode';
const STORAGE_KEY_OBJECT_PERM_NAMES = 'global-settings:objectPermNames';
const objectPermKey = (objectName: string): string => `global-settings:objectPerms:${objectName}`;
const STORAGE_KEY_SKILL_PERM_NAMES = 'global-settings:skillPermNames';
const skillPermKey = (skillName: string): string => `global-settings:skillPerms:${skillName}`;
const TIER_STORAGE_KEYS: Record<ModelTierName, { provider: string; model: string; effort: string }> = {
  smart: { provider: 'global-settings:tierSmartProvider', model: 'global-settings:tierSmartModel', effort: 'global-settings:tierSmartEffort' },
  balanced: { provider: 'global-settings:tierBalancedProvider', model: 'global-settings:tierBalancedModel', effort: 'global-settings:tierBalancedEffort' },
  fast: { provider: 'global-settings:tierFastProvider', model: 'global-settings:tierFastModel', effort: 'global-settings:tierFastEffort' },
  code: { provider: 'global-settings:tierCodeProvider', model: 'global-settings:tierCodeModel', effort: 'global-settings:tierCodeEffort' },
};
const AUX_ROWS: Record<AuxRowKey, { label: string; storageProvider: string; storageModel: string; decision?: boolean }> = {
  vision: { label: 'Vision fallback', storageProvider: 'global-settings:tierVisionProvider', storageModel: 'global-settings:tierVisionModel' },
  fallback: { label: 'Tier fallback', storageProvider: 'global-settings:tierFallbackProvider', storageModel: 'global-settings:tierFallbackModel' },
  decision: { label: 'Decision model', storageProvider: 'global-settings:decisionProvider', storageModel: 'global-settings:decisionModel', decision: true },
};
const STORAGE_KEY_CACHE_KEEPALIVE = 'global-settings:cacheKeepalive';
const STORAGE_KEY_DECISION_GATES = 'global-settings:decisionGates';
const STORAGE_KEY_TIER_PRESETS = 'global-settings:tierPresets';
// Legacy keys, migrated once at boot
const LEGACY_KEY_ANTHROPIC = 'settings:anthropicApiKey';
const LEGACY_KEY_OPENAI = 'settings:openaiApiKey';
const LEGACY_KEY_PROVIDER = 'global-settings:llmProvider';
const LEGACY_KEY_OLLAMA_MODEL = 'global-settings:ollamaModel';
const LEGACY_KEY_OLLAMA_MODEL_SMART = 'global-settings:ollamaModelSmart';
const LEGACY_KEY_OLLAMA_MODEL_BALANCED = 'global-settings:ollamaModelBalanced';
const LEGACY_KEY_OLLAMA_MODEL_FAST = 'global-settings:ollamaModelFast';

const DECISION_GATES: DecisionGates[] = ['on', 'off'];

/** Who may change settings by name: the Settings window and the terminal client's gateway. */
const WRITERS = ['GlobalSettings', 'CliServer'] as const;
/** Who may read secrets back. */
const SECRET_READERS = ['GlobalSettings'] as const;

/** Read a stored rules record, tolerating the plain allow-array first written. */
function parseObjectRules(json: string): ObjectCommandRules {
  const parsed = JSON.parse(json) as unknown;
  if (Array.isArray(parsed)) return { allow: parsed as string[], deny: [] };
  const record = parsed as Partial<ObjectCommandRules>;
  return {
    allow: Array.isArray(record.allow) ? record.allow : [],
    deny: Array.isArray(record.deny) ? record.deny : [],
  };
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

/** Trimmed, non-empty, de-duplicated, in order. */
function cleanList(list: string[]): string[] {
  const out: string[] = [];
  for (const s of list.map(x => x.trim())) if (s && !out.includes(s)) out.push(s);
  return out;
}

const emptyTiers = (): Record<ModelTierName, TierRoute | null> => ({ smart: null, balanced: null, fast: null, code: null });
const emptyAux = (): Record<AuxRowKey, ModelRef | null> => ({ vision: null, fallback: null, decision: null });

export class SettingsManager extends Abject {
  private llmId?: AbjectId;
  private storageId?: AbjectId;
  /** Applies the login to every socket that checks it (UI, terminal, HTTP gateway). */
  private authGateId?: AbjectId;

  /**
   * What the LLM object describes: the built-in providers, then those other
   * abjects registered. Reloaded whenever the LLM object announces
   * `providersChanged`, so a provider registered after boot can be routed.
   */
  private providerDescriptions: LLMProviderDescription[] = [];
  private providerDescById = new Map<string, LLMProviderDescription>();
  /** Reloads issued and the newest one applied: an older answer never replaces a newer one. */
  private providerLoadsIssued = 0;
  private providerLoadApplied = 0;
  /** Live model lists by provider; a provider's description seeds it. */
  private modelCatalog = new Map<string, ModelInfo[]>();

  // AI
  private credentials: Record<string, string> = {};
  private tiers = emptyTiers();
  private aux = emptyAux();
  private decisionGates: DecisionGates = 'on';
  private cacheKeepalive = false;
  private savedPresets: Record<string, TierPreset> = {};

  // Auth (applied over the environment's only once saved here)
  private auth = { enabled: false, username: '', password: '' };

  // Permissions
  private fs: FilesystemSettings = { allowedPaths: [], readOnly: false };
  private shell = { enabled: true, allowedCommands: [] as string[], deniedCommands: [] as string[] };
  private objectRules = new Map<string, ObjectCommandRules>();
  private skillGrants = new Map<string, string[]>();
  private web: WebSettings = { enabled: true, allowedDomains: [], deniedDomains: [], privateHosts: [] };
  private promptMode: PromptMode = 'ask';

  private permissionBrokerId?: AbjectId;
  private authorityClaimed = false;

  constructor() {
    super({
      manifest: {
        name: 'SettingsManager',
        description:
          'The global settings as data: model credentials and tier routing, tier presets, the UI and CLI login, and the permissions ' +
          '(filesystem, shell, web, what happens to a request no rule decides). Ask it for the schema and the current values; secrets show only as set or not set.',
        version: '1.0.0',
        interface: {
          id: 'abjects:settings-manager' as InterfaceId,
          name: 'SettingsManager',
          description: 'Global settings: read, validate, persist and apply',
          methods: [
            { name: 'getSettingsSchema', description: 'Every settings section and its fields (key, label, type, options).', parameters: [], returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SettingsSectionSchema' } } },
            {
              name: 'getSettings', description: 'Current values of one section (ai, auth, filesystem, shell, web, objects, permissions), or of every section when none is named. Secrets read as { set }.',
              parameters: [{ name: 'section', type: { kind: 'primitive', primitive: 'string' }, description: 'Section id', optional: true }],
              returns: { kind: 'reference', reference: 'SettingsBySection[section]' },
            },
            {
              name: 'setSettings', description: 'Change some fields of one section. Validates the result, persists it and applies it. Taken from the Settings window, the terminal client, and abjects inside a local workspace only.',
              parameters: [
                { name: 'section', type: { kind: 'primitive', primitive: 'string' }, description: 'Section id' },
                { name: 'values', type: { kind: 'object', properties: {} }, description: 'The fields to change; lists replace the whole list' },
              ],
              returns: { kind: 'reference', reference: 'SettingsBySection[section]' },
            },
            { name: 'listPresets', description: 'Tier presets: saved ones first, then the built-ins derived from each provider.', parameters: [], returns: { kind: 'array', elementType: { kind: 'reference', reference: '{ name, builtin, preset }' } } },
            { name: 'applyPreset', description: 'Route the tiers (and single-model rows) as a preset says, then save.', parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Preset name' }], returns: { kind: 'reference', reference: 'AiSettings' } },
            {
              name: 'savePreset', description: 'Save a preset under a name: the given routing, or the current one. "Latest" is saved as the model it resolves to today; any other model id, a moving alias included, is saved as given.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Preset name' },
                { name: 'preset', type: { kind: 'reference', reference: 'TierPreset' }, description: 'Routing to save; omit for the current routing', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            { name: 'deletePreset', description: 'Delete a saved preset (built-ins stay).', parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Preset name' }], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'listModels', description: 'Models one provider offers (its live catalog when reachable).', parameters: [{ name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider id' }], returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ModelInfo' } } },
            { name: 'isConfigured', description: 'True once any model credential or tier is set.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
          ],
          events: [
            { name: 'settingsChanged', description: 'A section changed (changed aspect, value: { section }). Section "presets" also announces a provider registered or withdrawn by another abject, which changes the built-in presets and the provider options in the schema.', payload: { kind: 'object', properties: { section: { kind: 'primitive', primitive: 'string' } } } },
          ],
        },
        tags: ['system', 'settings'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
    this.storageId = await this.requireDep('Storage');
    this.authGateId = await this.requireDep('AuthGate');
    // Abjects register providers with the LLM object after boot and may
    // withdraw them; follow its providersChanged announcements. Subscribed
    // before the first load, so a change in between is not missed.
    try {
      await this.request(request(this.id, this.llmId, 'addDependent', {}));
    } catch (err) {
      log.warn(`Could not follow LLM provider changes: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.loadProviderDescriptions();
    await this.loadAi();
    this.savedPresets = await this.loadSavedPresets();
    await this.loadAndApplyAuth();
    await this.loadAndApplyPermissions();
    if (this.isConfigured()) {
      await this.configureProviders();
      log.info('Loaded saved provider configuration');
    }
    this.checkInvariants();
  }

  protected override async onStop(): Promise<void> {
    // Sent, not awaited: a stopping object takes no replies.
    if (this.llmId) {
      try { this.send(request(this.id, this.llmId, 'removeDependent', {})); } catch { /* LLM gone */ }
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(DECISION_GATES.includes(this.decisionGates), 'SettingsManager: unknown decision gates');
    invariant(PROMPT_MODES.includes(this.promptMode), 'SettingsManager: unknown permission prompt mode');
    invariant(!this.auth.enabled || (this.auth.username !== '' && this.auth.password !== ''), 'SettingsManager: login enabled without credentials');
    invariant(this.providerDescById.size === new Set(this.providerDescriptions.map(d => d.id)).size, 'SettingsManager: provider index out of step with the descriptions');
  }

  private setupHandlers(): void {
    this.on('getSettingsSchema', () => this.schema());

    this.on('getSettings', async (msg: AbjectMessage) => {
      const { section, reveal } = (msg.payload ?? {}) as { section?: string; reveal?: boolean };
      if (reveal) await this.admit(msg, SECRET_READERS);
      if (section === undefined) {
        return Object.fromEntries(SETTINGS_SECTIONS.map(s => [s, this.view(s, !!reveal)]));
      }
      precondition(SETTINGS_SECTIONS.includes(section as SettingsSectionId), `Unknown settings section: ${section}. Sections: ${SETTINGS_SECTIONS.join(', ')}`);
      return this.view(section as SettingsSectionId, !!reveal);
    });

    this.on('setSettings', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { section, values } = (msg.payload ?? {}) as { section?: string; values?: Record<string, unknown> };
      precondition(SETTINGS_SECTIONS.includes(section as SettingsSectionId), `Unknown settings section: ${section}. Sections: ${SETTINGS_SECTIONS.join(', ')}`);
      precondition(!!values && typeof values === 'object' && !Array.isArray(values), 'values must be an object of the fields to change');
      await this.setSection(section as SettingsSectionId, values!);
      return this.view(section as SettingsSectionId, false);
    });

    this.on('listPresets', async () => {
      await this.refreshKeyedCatalogs();
      return [
        ...Object.keys(this.savedPresets).sort().map(name => ({ name, builtin: false, preset: this.savedPresets[name] })),
        ...this.builtinPresets().filter(b => !this.savedPresets[b.name]).map(b => ({ name: b.name, builtin: true, preset: b.preset })),
      ];
    });

    this.on('applyPreset', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { name } = (msg.payload ?? {}) as { name?: string };
      precondition(typeof name === 'string' && name.trim() !== '', 'name must be a preset name');
      await this.refreshKeyedCatalogs();
      const preset = this.savedPresets[name!] ?? this.builtinPresets().find(b => b.name === name)?.preset;
      precondition(!!preset, `No preset named "${name}"`);
      await this.knowProviders([
        ...Object.values(preset!.routing).map(r => r?.provider),
        preset!.vision?.provider, preset!.fallback?.provider, preset!.decision?.provider,
      ]);
      const update: Record<string, unknown> = { tiers: { ...emptyTiers(), ...preset!.routing } };
      update.vision = preset!.vision ?? null;
      if (preset!.fallback !== undefined) update.fallback = preset!.fallback;
      if (preset!.decision !== undefined) update.decision = preset!.decision;
      // A provider this build does not know leaves its tier as it is.
      const tiers = update.tiers as Record<string, TierRoute | null>;
      for (const tier of TIER_NAMES) {
        const route = tiers[tier];
        if (!route || !this.providerDescById.has(route.provider)) tiers[tier] = this.tiers[tier];
      }
      await this.setSection('ai', update);
      return this.view('ai', false);
    });

    this.on('savePreset', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { name, preset } = (msg.payload ?? {}) as { name?: string; preset?: TierPreset };
      precondition(typeof name === 'string' && name.trim() !== '', 'Give the preset a name first.');
      const source: TierPreset = preset ?? {
        routing: Object.fromEntries(TIER_NAMES.filter(t => this.tiers[t]).map(t => [t, this.tiers[t]!])),
        vision: this.aux.vision, fallback: this.aux.fallback, decision: this.aux.decision,
      };
      precondition(!!source.routing && Object.keys(source.routing).length > 0, 'Configure at least one tier before saving a preset.');
      await this.refreshKeyedCatalogs();
      // A saved preset pins "Latest" to the model it resolves to today, so
      // that tier never drifts. Every other model id is kept as chosen,
      // including a catalog's own moving alias (OpenRouter's
      // `~vendor/line-latest`): catalogs do not say which release an alias
      // points at, so it stays an alias.
      const routing: TierPreset['routing'] = {};
      for (const tier of TIER_NAMES) {
        const route = source.routing[tier];
        if (!route) continue;
        const desc = this.providerDescById.get(route.provider);
        const model = desc ? freezeModel(desc, this.catalogFor(route.provider), tier, route.model) : route.model;
        routing[tier] = { provider: route.provider, model, ...(route.effort ? { effort: route.effort } : {}) };
      }
      this.savedPresets[name!.trim()] = { routing, vision: source.vision ?? null, fallback: source.fallback ?? null, decision: source.decision ?? null };
      await this.store('set', STORAGE_KEY_TIER_PRESETS, JSON.stringify(this.savedPresets));
      this.changed('settingsChanged', { section: 'presets' });
      return true;
    });

    this.on('deletePreset', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { name } = (msg.payload ?? {}) as { name?: string };
      precondition(typeof name === 'string' && !!this.savedPresets[name], 'Only saved presets can be deleted (built-ins stay).');
      delete this.savedPresets[name!];
      await this.store('set', STORAGE_KEY_TIER_PRESETS, JSON.stringify(this.savedPresets));
      this.changed('settingsChanged', { section: 'presets' });
      return true;
    });

    this.on('listModels', async (msg: AbjectMessage) => {
      const { provider } = (msg.payload ?? {}) as { provider?: string };
      if (typeof provider === 'string') await this.knowProviders([provider]);
      precondition(typeof provider === 'string' && this.providerDescById.has(provider), `Unknown provider: ${provider}`);
      await this.refreshCatalog(provider!);
      const desc = this.providerDescById.get(provider!)!;
      const decisionModels = (desc.decisionModels ?? []) as ModelInfo[];
      const chat = servesChat(desc) ? this.catalogFor(provider!) : [];
      return [...decisionModels, ...chat.filter(m => !decisionModels.some(d => d.id === m.id))];
    });

    this.on('isConfigured', () => this.isConfigured());

    // The LLM object announces a provider another abject registered, updated
    // or withdrew. Reload the descriptions: the schema's provider options,
    // what tier writes accept, and the built-in presets all come from them.
    this.on('providersChanged', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.llmId) return;
      const { name } = (msg.payload ?? {}) as { name?: unknown };
      // Its models may have changed with it: the next read refetches.
      if (typeof name === 'string') this.modelCatalog.delete(name);
      await this.loadProviderDescriptions();
      this.checkInvariants();
      // Built-in presets follow the providers; clients showing the schema reload it on this.
      this.changed('settingsChanged', { section: 'presets' });
    });

    // Prompt answers that change a rule: the Settings window raises the
    // prompts, and records an "always" answer here.
    this.on('setObjectCommandRule', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { objectName, commandName, rule } = (msg.payload ?? {}) as { objectName?: string; commandName?: string; rule?: string };
      precondition(typeof objectName === 'string' && objectName.trim() !== '', 'objectName must be a non-empty string');
      precondition(typeof commandName === 'string' && /^[^\s/\\]+$/.test(commandName), 'commandName must be a program name (no spaces or path separators)');
      precondition(rule === 'allow' || rule === 'deny', "rule must be 'allow' or 'deny'");
      const rules = Object.fromEntries(this.objectRules);
      const record = { allow: [...(rules[objectName!]?.allow ?? [])], deny: [...(rules[objectName!]?.deny ?? [])] };
      const [into, outOf] = rule === 'allow' ? ['allow', 'deny'] as const : ['deny', 'allow'] as const;
      if (!record[into].includes(commandName!)) record[into].push(commandName!);
      record[outOf] = record[outOf].filter(c => c !== commandName);
      await this.setSection('shell', { objectRules: { ...rules, [objectName!]: record } });
      return true;
    });

    this.on('addSkillGrant', async (msg: AbjectMessage) => {
      await this.admit(msg, WRITERS, { allowLocalWorkspace: true });
      const { skillName, command } = (msg.payload ?? {}) as { skillName?: string; command?: string };
      precondition(typeof skillName === 'string' && skillName.trim() !== '', 'skillName must be a non-empty string');
      precondition(typeof command === 'string' && command.trim() !== '', 'command must be a non-empty string');
      const grants = Object.fromEntries(this.skillGrants);
      const cmds = grants[skillName!] ?? [];
      await this.setSection('shell', { skillGrants: { ...grants, [skillName!]: cmds.includes(command!) ? cmds : [...cmds, command!] } });
      return true;
    });
  }

  /**
   * Changes come from the Settings window and the terminal client's gateway,
   * both system objects (a user object calling itself one of them carries a
   * namespaced typeId and is refused). Writes additionally admit abjects and
   * agents running inside a LOCAL workspace this peer hosts: the person
   * created that workspace and everything in it, so its abjects may change
   * settings. Shared and public workspaces are refused, as are joined
   * mirrors of remote workspaces (they keep accessMode 'local', so the
   * joined flag decides, not the mode). Secret reads stay name-gated: no
   * workspace abject may read credentials back.
   */
  private async admit(
    msg: AbjectMessage,
    allowed: readonly string[],
    opts: { allowLocalWorkspace?: boolean } = {},
  ): Promise<void> {
    const identity = await this.resolveCallerIdentity(msg.routing.from);
    const typeSegments = identity?.typeId ? String(identity.typeId).split('/').length : 0;
    if (identity && allowed.includes(identity.name) && typeSegments <= 3) return;
    if (opts.allowLocalWorkspace && identity && (await this.callerInLocalWorkspace(msg.routing.from))) return;
    precondition(
      false,
      `SettingsManager takes this request from ${allowed.join(' or ')}` +
        (opts.allowLocalWorkspace ? ', or an abject in a local workspace' : '') + ' only',
    );
  }

  /**
   * True when the caller is registered inside a workspace this peer hosts in
   * local mode, per WorkspaceManager's registry-backed lookup. Any lookup
   * failure denies: without a trustworthy workspace answer there is no
   * allowance.
   */
  private async callerInLocalWorkspace(callerId: AbjectId): Promise<boolean> {
    const wmId = await this.discoverDep('WorkspaceManager');
    if (!wmId) return false;
    try {
      const ws = await this.request<{ accessMode: string; joined?: boolean } | null>(
        request(this.id, wmId, 'findWorkspaceForObject', { objectId: callerId }),
        5000,
      );
      return !!ws && ws.accessMode === 'local' && ws.joined !== true;
    } catch {
      return false;
    }
  }

  private isConfigured(): boolean {
    return Object.keys(this.credentials).length > 0 || TIER_NAMES.some(t => this.tiers[t] !== null);
  }

  // ===========================================================================
  // Views and schema
  // ===========================================================================

  private view<S extends SettingsSectionId>(section: S, reveal: boolean): SettingsBySection[S] {
    const secret = (value: string, notSecret = false): SecretValue =>
      ({ set: value !== '', ...((reveal || notSecret) && value !== '' ? { value } : {}) });
    switch (section) {
      case 'ai': {
        const credentials: Record<string, SecretValue> = {};
        for (const desc of this.providerDescriptions) {
          if (desc.credentialMode === 'cli' || desc.credentialMode === 'none') continue;
          credentials[desc.id] = secret(this.credentials[desc.id] ?? '', desc.credentialMode === 'url');
        }
        return {
          credentials,
          tiers: Object.fromEntries(TIER_NAMES.map(t => [t, this.tiers[t] ? { ...this.tiers[t]! } : null])) as AiSettings['tiers'],
          vision: this.aux.vision, fallback: this.aux.fallback, decision: this.aux.decision,
          decisionGates: this.decisionGates,
          cacheKeepalive: this.cacheKeepalive,
        } as SettingsBySection[S];
      }
      case 'auth':
        return { enabled: this.auth.enabled, username: this.auth.username, password: secret(this.auth.password) } as SettingsBySection[S];
      case 'filesystem':
        return { allowedPaths: [...this.fs.allowedPaths], readOnly: this.fs.readOnly } as SettingsBySection[S];
      case 'shell':
        return {
          enabled: this.shell.enabled,
          allowedCommands: [...this.shell.allowedCommands],
          deniedCommands: [...this.shell.deniedCommands],
          objectRules: Object.fromEntries([...this.objectRules].map(([k, v]) => [k, { allow: [...v.allow], deny: [...v.deny] }])),
          skillGrants: Object.fromEntries([...this.skillGrants].map(([k, v]) => [k, [...v]])),
        } as SettingsBySection[S];
      case 'web':
        return { enabled: this.web.enabled, allowedDomains: [...this.web.allowedDomains], deniedDomains: [...this.web.deniedDomains], privateHosts: [...this.web.privateHosts] } as SettingsBySection[S];
      case 'permissions':
        return { mode: this.promptMode } as SettingsBySection[S];
    }
    throw new Error(`Unknown section ${String(section)}`);
  }

  private schema(): SettingsSectionSchema[] {
    const chatProviders = this.providerDescriptions.filter(servesChat).map(d => d.id);
    const allProviders = this.providerDescriptions.map(d => d.id);
    const credentialFields: SettingField[] = this.providerDescriptions
      .filter(d => d.credentialMode !== 'cli' && d.credentialMode !== 'none')
      .map(d => ({
        key: `credentials.${d.id}`,
        label: d.credentialLabel ?? `${d.label} ${d.credentialMode === 'url' ? 'URL' : 'API key'}`,
        type: d.credentialMode === 'url' ? 'string' as const : 'secret' as const,
        ...(d.credentialPlaceholder ? { description: d.credentialPlaceholder } : {}),
        nullable: true,
      }));
    return [
      {
        id: 'ai', label: 'AI', description: 'Model credentials, which model serves each tier, and the single-model rows.',
        fields: [
          ...credentialFields,
          ...TIER_NAMES.map(t => ({
            key: `tiers.${t}`, label: `${TIER_LABELS[t]} tier`, type: 'model' as const, options: chatProviders, nullable: true,
            description: t === 'code' ? 'Code generation; rides Smart when unset.' : `Model for ${t} work. "${LATEST_MODEL}" follows the provider's newest.`,
          })),
          { key: 'vision', label: 'Vision fallback', type: 'model', options: chatProviders, nullable: true, description: 'Stands in on image-bearing steps when a tier model is text-only.' },
          { key: 'fallback', label: 'Tier fallback', type: 'model', options: chatProviders, nullable: true, description: 'Stands in for any tier whose own model fails.' },
          { key: 'decision', label: 'Decision model', type: 'model', options: allProviders, nullable: true, description: 'Unset is Auto: a keyed decision provider, else emulation on the Fast tier.' },
          { key: 'decisionGates', label: 'Decision gates', type: 'enum', options: DECISION_GATES, description: 'on: built-in decision sites advise and act live; off: they do not run.' },
          { key: 'cacheKeepalive', label: 'Prompt-cache keepalive', type: 'boolean', description: 'Pings large prompt prefixes between agent steps to keep provider caches warm (costs cached reads).' },
        ],
      },
      {
        id: 'auth', label: 'Auth', description: 'A login for the UI and CLI sockets. Changing it signs browser clients out; terminal clients log in on their next connection.',
        fields: [
          { key: 'enabled', label: 'Require login', type: 'boolean' },
          { key: 'username', label: 'Username', type: 'string' },
          { key: 'password', label: 'Password', type: 'secret' },
        ],
      },
      {
        id: 'filesystem', label: 'Filesystem', description: 'Host folders objects may reach.',
        fields: [
          { key: 'allowedPaths', label: 'Allowed paths', type: 'list' },
          { key: 'readOnly', label: 'Read-only', type: 'boolean' },
        ],
      },
      {
        id: 'shell', label: 'Shell', description: 'Commands objects may run on the host.',
        fields: [
          { key: 'enabled', label: 'Shell enabled', type: 'boolean' },
          { key: 'allowedCommands', label: 'Allowed commands', type: 'list' },
          { key: 'deniedCommands', label: 'Denied commands', type: 'list' },
          { key: 'objectRules', label: 'Per-object rules', type: 'rules', description: 'Object name to the programs it may (allow) or may not (deny) run, whatever the arguments.' },
          { key: 'skillGrants', label: 'Skill grants', type: 'grants', description: 'Commands each skill was allowed to run.' },
        ],
      },
      {
        id: 'web', label: 'Web', description: 'Web and stream access.',
        fields: [
          { key: 'enabled', label: 'Web enabled', type: 'boolean' },
          { key: 'allowedDomains', label: 'Allowed domains', type: 'list' },
          { key: 'deniedDomains', label: 'Denied domains', type: 'list' },
          { key: 'privateHosts', label: 'Private hosts', type: 'list', description: 'Private or loopback hosts objects may reach, as host or host:port.' },
        ],
      },
      {
        id: 'permissions', label: 'Permissions', description: 'What happens to a request no rule, grant or project autonomy decides.',
        fields: [{
          key: 'mode', label: 'Permission prompts', type: 'enum', options: [...PROMPT_MODES],
          description: 'ask: wait for you to answer, on the desktop or in the terminal. allow: allow it once without asking (dangerous commands still ask). deny: deny it without asking.',
        }],
      },
    ];
  }

  // ===========================================================================
  // Changing a section
  // ===========================================================================

  private async setSection(section: SettingsSectionId, values: Record<string, unknown>): Promise<void> {
    switch (section) {
      case 'ai': await this.setAi(values); break;
      case 'auth': await this.setAuth(values); break;
      case 'filesystem': case 'shell': case 'web': await this.setPermissions(section, values); break;
      case 'permissions': await this.setPromptMode(values); break;
    }
    this.checkInvariants();
    this.changed('settingsChanged', { section });
  }

  private knownKeys(values: Record<string, unknown>, allowed: string[], section: string): void {
    const unknown = Object.keys(values).filter(k => !allowed.includes(k));
    precondition(unknown.length === 0, `Unknown ${section} setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }

  /**
   * A route's provider must be one the LLM object describes now, or the one
   * the row already routes to: an abject-backed provider is away until it
   * registers (at startup, or after being withdrawn), and its saved route
   * stays acceptable meanwhile, so a save that keeps it still goes through.
   */
  private checkModelRef(value: unknown, what: string, providers: string[], current?: ModelRef | null): ModelRef & { effort?: string } {
    precondition(!!value && typeof value === 'object', `${what} must be { provider, model } or null`);
    const v = value as { provider?: unknown; model?: unknown; effort?: unknown };
    precondition(typeof v.provider === 'string' && (providers.includes(v.provider) || v.provider === current?.provider),
      `${what}: unknown provider ${String(v.provider)}. Providers: ${providers.join(', ')}`);
    precondition(typeof v.model === 'string' && v.model.trim() !== '', `${what}: model must be a non-empty string`);
    precondition(v.effort === undefined || v.effort === null || typeof v.effort === 'string', `${what}: effort must be a string`);
    return { provider: v.provider as string, model: (v.model as string).trim(), ...(typeof v.effort === 'string' && v.effort ? { effort: v.effort } : {}) };
  }

  private async setAi(values: Record<string, unknown>): Promise<void> {
    this.knownKeys(values, ['credentials', 'tiers', 'vision', 'fallback', 'decision', 'decisionGates', 'cacheKeepalive'], 'AI');
    const providerOf = (ref: unknown): string | undefined =>
      ref && typeof ref === 'object' ? (ref as { provider?: unknown }).provider as string | undefined : undefined;
    await this.knowProviders([
      ...(values.credentials && typeof values.credentials === 'object' ? Object.keys(values.credentials) : []),
      ...(values.tiers && typeof values.tiers === 'object' ? Object.values(values.tiers as Record<string, unknown>).map(providerOf) : []),
      ...AUX_ROW_KEYS.map(key => providerOf(values[key])),
    ]);
    const chatProviders = this.providerDescriptions.filter(servesChat).map(d => d.id);
    const credentials = { ...this.credentials };
    if (values.credentials !== undefined) {
      precondition(!!values.credentials && typeof values.credentials === 'object', 'credentials must map provider id to a key (null clears it)');
      for (const [id, value] of Object.entries(values.credentials as Record<string, unknown>)) {
        const desc = this.providerDescById.get(id);
        precondition(!!desc, `Unknown provider: ${id}`);
        precondition(desc!.credentialMode !== 'cli' && desc!.credentialMode !== 'none', `${desc!.label} has no credential to set`);
        precondition(value === null || typeof value === 'string', `credentials.${id} must be a string or null`);
        const v = (value as string | null)?.trim() ?? '';
        if (v) credentials[id] = v; else delete credentials[id];
      }
    }
    const tiers = { ...this.tiers };
    if (values.tiers !== undefined) {
      precondition(!!values.tiers && typeof values.tiers === 'object', 'tiers must map tier name to { provider, model, effort? } or null');
      for (const [tier, route] of Object.entries(values.tiers as Record<string, unknown>)) {
        precondition(TIER_NAMES.includes(tier as ModelTierName), `Unknown tier: ${tier}. Tiers: ${TIER_NAMES.join(', ')}`);
        tiers[tier as ModelTierName] = route === null ? null : this.checkModelRef(route, `tiers.${tier}`, chatProviders, this.tiers[tier as ModelTierName]);
      }
    }
    const aux = { ...this.aux };
    for (const key of AUX_ROW_KEYS) {
      if (values[key] === undefined) continue;
      const providers = AUX_ROWS[key].decision ? this.providerDescriptions.map(d => d.id) : chatProviders;
      const ref = values[key] === null ? null : this.checkModelRef(values[key], key, providers, this.aux[key]);
      aux[key] = ref ? { provider: ref.provider, model: ref.model } : null;
    }
    let decisionGates = this.decisionGates;
    if (values.decisionGates !== undefined) {
      precondition(DECISION_GATES.includes(values.decisionGates as DecisionGates), `decisionGates must be one of ${DECISION_GATES.join(', ')}`);
      decisionGates = values.decisionGates as DecisionGates;
    }
    let cacheKeepalive = this.cacheKeepalive;
    if (values.cacheKeepalive !== undefined) {
      precondition(typeof values.cacheKeepalive === 'boolean', 'cacheKeepalive must be true or false');
      cacheKeepalive = values.cacheKeepalive as boolean;
    }

    // The result must work: a tier configured, and a key for every provider
    // that needs one. A local-URL provider gets its default address.
    if (values.tiers !== undefined) precondition(TIER_NAMES.some(t => tiers[t] !== null), 'Configure at least one model tier.');
    for (const desc of this.providerDescriptions) {
      if (desc.credentialMode === 'url' && !credentials[desc.id] && desc.credentialPlaceholder) credentials[desc.id] = desc.credentialPlaceholder;
    }
    for (const tier of TIER_NAMES) {
      const route = tiers[tier];
      const desc = route ? this.providerDescById.get(route.provider) : undefined;
      if (desc?.credentialMode === 'apiKey') {
        precondition(!!credentials[desc.id], `${TIER_LABELS[tier]} tier uses ${desc.label} but no API key provided.`);
      }
    }
    for (const key of AUX_ROW_KEYS) {
      const ref = aux[key];
      const desc = ref ? this.providerDescById.get(ref.provider) : undefined;
      if (desc?.credentialMode === 'apiKey') {
        precondition(!!credentials[desc.id], `${AUX_ROWS[key].label} uses ${desc.label} but no API key provided.`);
      }
    }

    const removedCredentials = Object.keys(this.credentials).filter(id => !credentials[id]);
    this.credentials = credentials;
    this.tiers = tiers;
    this.aux = aux;
    this.decisionGates = decisionGates;
    this.cacheKeepalive = cacheKeepalive;

    for (const desc of this.providerDescriptions) {
      if (desc.credentialMode === 'cli' || desc.credentialMode === 'none') continue;
      const value = this.credentials[desc.id];
      if (value) await this.store('set', storageKeyFor(desc.storageSuffix), value);
      else if (removedCredentials.includes(desc.id)) await this.store('delete', storageKeyFor(desc.storageSuffix));
    }
    await this.persistTiers();
    for (const key of AUX_ROW_KEYS) {
      const ref = this.aux[key];
      if (ref) {
        await this.store('set', AUX_ROWS[key].storageProvider, ref.provider);
        await this.store('set', AUX_ROWS[key].storageModel, ref.model);
      } else {
        await this.store('delete', AUX_ROWS[key].storageProvider);
        await this.store('delete', AUX_ROWS[key].storageModel);
      }
    }
    await this.store('set', STORAGE_KEY_CACHE_KEEPALIVE, this.cacheKeepalive);
    await this.store('set', STORAGE_KEY_DECISION_GATES, this.decisionGates);
    await this.configureProviders();
    log.info('Saved provider settings');
  }

  private async setAuth(values: Record<string, unknown>): Promise<void> {
    this.knownKeys(values, ['enabled', 'username', 'password'], 'auth');
    const next = { ...this.auth };
    if (values.enabled !== undefined) { precondition(typeof values.enabled === 'boolean', 'enabled must be true or false'); next.enabled = values.enabled as boolean; }
    if (values.username !== undefined) { precondition(typeof values.username === 'string', 'username must be a string'); next.username = (values.username as string).trim(); }
    if (values.password !== undefined) { precondition(typeof values.password === 'string', 'password must be a string'); next.password = values.password as string; }
    precondition(!next.enabled || (next.username !== '' && next.password !== ''), 'Username and password are required.');
    this.auth = next;
    await this.store('set', STORAGE_KEY_AUTH_ENABLED, String(next.enabled));
    await this.store('set', STORAGE_KEY_AUTH_USER, next.username);
    await this.store('set', STORAGE_KEY_AUTH_PASS, next.password);
    // Clears the sessions and signs browser clients out; terminals log in on their next connection.
    if (this.authGateId) await this.request(request(this.id, this.authGateId, 'updateAuth', { ...next }));
    log.info(`Auth settings saved (enabled=${next.enabled})`);
  }

  private async setPermissions(section: 'filesystem' | 'shell' | 'web', values: Record<string, unknown>): Promise<void> {
    if (section === 'filesystem') {
      this.knownKeys(values, ['allowedPaths', 'readOnly'], 'filesystem');
      const next = { ...this.fs };
      if (values.allowedPaths !== undefined) { precondition(isStringList(values.allowedPaths), 'allowedPaths must be a list of paths'); next.allowedPaths = cleanList(values.allowedPaths as string[]); }
      if (values.readOnly !== undefined) { precondition(typeof values.readOnly === 'boolean', 'readOnly must be true or false'); next.readOnly = values.readOnly as boolean; }
      this.fs = next;
    } else if (section === 'web') {
      this.knownKeys(values, ['enabled', 'allowedDomains', 'deniedDomains', 'privateHosts'], 'web');
      const next = { ...this.web };
      if (values.enabled !== undefined) { precondition(typeof values.enabled === 'boolean', 'enabled must be true or false'); next.enabled = values.enabled as boolean; }
      for (const key of ['allowedDomains', 'deniedDomains', 'privateHosts'] as const) {
        if (values[key] === undefined) continue;
        precondition(isStringList(values[key]), `${key} must be a list of strings`);
        next[key] = cleanList(values[key] as string[]);
      }
      next.privateHosts = next.privateHosts.map(h => h.toLowerCase());
      for (const host of next.privateHosts) {
        precondition(!!parsePrivateHost(host), `"${host}" is not a host, host:port, address, or address range (e.g. 10.0.0.0/8)`);
      }
      this.web = next;
    } else {
      this.knownKeys(values, ['enabled', 'allowedCommands', 'deniedCommands', 'objectRules', 'skillGrants'], 'shell');
      const next = { ...this.shell };
      if (values.enabled !== undefined) { precondition(typeof values.enabled === 'boolean', 'enabled must be true or false'); next.enabled = values.enabled as boolean; }
      for (const key of ['allowedCommands', 'deniedCommands'] as const) {
        if (values[key] === undefined) continue;
        precondition(isStringList(values[key]), `${key} must be a list of commands`);
        next[key] = cleanList(values[key] as string[]);
      }
      this.shell = next;
      if (values.objectRules !== undefined) await this.replaceObjectRules(values.objectRules);
      if (values.skillGrants !== undefined) await this.replaceSkillGrants(values.skillGrants);
    }
    await this.persistPermissions();
    await this.propagatePermissions();
  }

  private async setPromptMode(values: Record<string, unknown>): Promise<void> {
    this.knownKeys(values, ['mode'], 'permissions');
    if (values.mode === undefined) return;
    precondition(PROMPT_MODES.includes(values.mode as PromptMode), `mode must be one of ${PROMPT_MODES.join(', ')}`);
    this.promptMode = values.mode as PromptMode;
    await this.store('set', STORAGE_KEY_PROMPT_MODE, this.promptMode);
    await this.applyPromptMode();
  }

  /** Push the prompt mode to PermissionBroker, which holds it as policy. */
  private async applyPromptMode(): Promise<void> {
    await this.claimAuthority();
    if (!this.permissionBrokerId) return;
    const r = await this.request<{ success?: boolean; error?: string }>(
      request(this.id, this.permissionBrokerId, 'setPromptMode', { mode: this.promptMode }));
    if (r && r.success === false) throw new Error(r.error ?? 'PermissionBroker refused the prompt mode');
  }

  // ===========================================================================
  // AI: load, persist, apply
  // ===========================================================================

  /**
   * Ask the LLM object for its provider descriptions. A failed reload keeps
   * the list already held, and an answer older than one already applied is
   * dropped (reloads can overlap when providers change in quick succession).
   */
  private async loadProviderDescriptions(): Promise<void> {
    precondition(!!this.llmId, 'SettingsManager: provider descriptions come from the LLM object');
    const load = ++this.providerLoadsIssued;
    let descriptions: LLMProviderDescription[];
    try {
      descriptions = await this.request<LLMProviderDescription[]>(request(this.id, this.llmId!, 'listProviderDescriptions', {}));
    } catch (err) {
      log.warn(`Failed to load provider descriptions: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(descriptions) || load < this.providerLoadApplied) return;
    this.providerLoadApplied = load;
    this.providerDescriptions = descriptions;
    this.providerDescById = new Map(descriptions.map(d => [d.id, d]));
  }

  /**
   * Reload the descriptions when a write names a provider not yet known. A
   * provider registered by another abject is announced by an event, and a
   * write naming it can arrive before that event is handled.
   */
  private async knowProviders(names: ReadonlyArray<string | undefined>): Promise<void> {
    if (names.some(n => typeof n === 'string' && n !== '' && !this.providerDescById.has(n))) {
      await this.loadProviderDescriptions();
    }
  }

  private async loadAi(): Promise<void> {
    for (const desc of this.providerDescriptions) {
      if (desc.credentialMode === 'cli' || desc.credentialMode === 'none') continue;
      const value = await this.fetch<string>(storageKeyFor(desc.storageSuffix));
      if (value) this.credentials[desc.id] = value;
    }
    for (const tier of TIER_NAMES) {
      const provider = await this.fetch<string>(TIER_STORAGE_KEYS[tier].provider);
      let model = await this.fetch<string>(TIER_STORAGE_KEYS[tier].model);
      const effort = await this.fetch<string>(TIER_STORAGE_KEYS[tier].effort);
      if (!provider || !model) continue;
      // A provider's own model migrations (an upstream API dropping a name).
      const migrated = this.providerDescById.get(provider)?.modelMigrations?.[model];
      if (migrated && migrated !== model) {
        log.info(`Migrated ${provider} ${tier} tier model "${model}" → "${migrated}"`);
        model = migrated;
        await this.store('set', TIER_STORAGE_KEYS[tier].model, migrated);
      }
      this.tiers[tier] = { provider, model, ...(effort ? { effort } : {}) };
    }
    for (const key of AUX_ROW_KEYS) {
      const provider = await this.fetch<string>(AUX_ROWS[key].storageProvider);
      const model = await this.fetch<string>(AUX_ROWS[key].storageModel);
      this.aux[key] = provider && model ? { provider, model } : null;
    }
    const gates = await this.fetch<string>(STORAGE_KEY_DECISION_GATES);
    if (gates && DECISION_GATES.includes(gates as DecisionGates)) this.decisionGates = gates as DecisionGates;
    this.cacheKeepalive = (await this.fetch<boolean>(STORAGE_KEY_CACHE_KEEPALIVE)) === true;
    await this.migrateLegacyAi();
  }

  /** Keys saved before per-provider credentials and per-tier routing. */
  private async migrateLegacyAi(): Promise<void> {
    const anthropic = this.providerDescById.get('anthropic');
    const openai = this.providerDescById.get('openai');
    if (!this.credentials.anthropic && !this.credentials.openai && anthropic && openai) {
      const legacyAnthropic = await this.fetch<string>(LEGACY_KEY_ANTHROPIC);
      const legacyOpenai = await this.fetch<string>(LEGACY_KEY_OPENAI);
      if (legacyAnthropic) { this.credentials.anthropic = legacyAnthropic; await this.store('set', storageKeyFor(anthropic.storageSuffix), legacyAnthropic); }
      if (legacyOpenai) { this.credentials.openai = legacyOpenai; await this.store('set', storageKeyFor(openai.storageSuffix), legacyOpenai); }
      if (legacyAnthropic || legacyOpenai) log.info('Migrated API keys from legacy storage');
    }
    if (TIER_NAMES.some(t => this.tiers[t])) return;
    const oldProvider = await this.fetch<string>(LEGACY_KEY_PROVIDER);
    const oldDesc = oldProvider ? this.providerDescById.get(oldProvider) : undefined;
    if (!oldProvider || !oldDesc) return;
    if (oldDesc.credentialMode === 'url') {
      const legacyModel = await this.fetch<string>(LEGACY_KEY_OLLAMA_MODEL);
      const smart = (await this.fetch<string>(LEGACY_KEY_OLLAMA_MODEL_SMART)) || legacyModel || '';
      const balanced = (await this.fetch<string>(LEGACY_KEY_OLLAMA_MODEL_BALANCED)) || legacyModel || '';
      const fast = (await this.fetch<string>(LEGACY_KEY_OLLAMA_MODEL_FAST)) || legacyModel || '';
      if (smart) this.tiers.smart = { provider: oldProvider, model: smart };
      if (balanced) this.tiers.balanced = { provider: oldProvider, model: balanced };
      if (fast) this.tiers.fast = { provider: oldProvider, model: fast };
    } else {
      for (const tier of TIER_NAMES) {
        const model = oldDesc.defaultTierModels[tier];
        if (model) this.tiers[tier] = { provider: oldProvider, model };
      }
    }
    await this.persistTiers();
    log.info(`Migrated single-provider '${oldProvider}' to per-tier routing`);
  }

  private async persistTiers(): Promise<void> {
    for (const tier of TIER_NAMES) {
      const route = this.tiers[tier];
      const keys = TIER_STORAGE_KEYS[tier];
      if (route) {
        await this.store('set', keys.provider, route.provider);
        await this.store('set', keys.model, route.model);
      } else {
        await this.store('delete', keys.provider);
        await this.store('delete', keys.model);
      }
      // Absence is meaningful for the effort: the provider's default.
      if (route?.effort) await this.store('set', keys.effort, route.effort);
      else await this.store('delete', keys.effort);
    }
  }

  /** One LLM configure carrying credentials, routing, the single-model rows and the policies. */
  private async configureProviders(): Promise<void> {
    const routing: Record<string, TierRoute> = {};
    for (const tier of TIER_NAMES) if (this.tiers[tier]) routing[tier] = { ...this.tiers[tier]! };
    const fallback = this.aux.fallback;
    await this.request(request(this.id, this.llmId!, 'configure', {
      credentials: { ...this.credentials },
      tierRouting: Object.keys(routing).length > 0 ? routing : undefined,
      // One fallback model covers every tier: outage cover, not per-tier routing.
      tierFallbacks: fallback ? Object.fromEntries(TIER_NAMES.map(tier => [tier, [fallback]])) : null,
      visionFallback: this.aux.vision,
      cacheKeepalive: { enabled: this.cacheKeepalive },
      decisionRoute: this.aux.decision,
      decisionPolicy: { gates: this.decisionGates },
    }));
  }

  // ===========================================================================
  // Presets and model catalogs
  // ===========================================================================

  private catalogFor(provider: string): ModelInfo[] {
    return this.modelCatalog.get(provider) ?? ((this.providerDescById.get(provider)?.models ?? []) as ModelInfo[]);
  }

  /** Fetch one provider's live catalog, when it can be reached. Best effort. */
  private async refreshCatalog(provider: string): Promise<void> {
    const desc = this.providerDescById.get(provider);
    if (!desc || !servesChat(desc)) return;
    const reachable = desc.credentialMode === 'url' || desc.credentialMode === 'cli' || !!this.credentials[provider];
    if (!reachable || this.modelCatalog.has(provider)) return;
    try {
      const payload: Record<string, unknown> = { provider };
      if (desc.credentialMode === 'url') payload.ollamaUrl = this.credentials[provider] || desc.credentialPlaceholder || '';
      const models = await this.request<ModelInfo[]>(request(this.id, this.llmId!, 'listProviderModels', payload), 20_000);
      if (models.length > 0) this.modelCatalog.set(provider, models);
    } catch (err) {
      log.warn(`live model list for ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refreshKeyedCatalogs(): Promise<void> {
    await Promise.all(this.providerDescriptions.map(d => this.refreshCatalog(d.id)));
  }

  /**
   * Built-in presets, derived from each provider's description and catalog:
   * "<Provider> recommended" (every tier on Latest where the provider can
   * recommend it, else its default model), and one "<Provider> · <Vendor>"
   * ladder per vendor for catalogs that publish moving aliases.
   */
  private builtinPresets(): Array<{ name: string; preset: TierPreset }> {
    const out: Array<{ name: string; preset: TierPreset }> = [];
    for (const desc of this.providerDescriptions) {
      const d = desc.defaultTierModels;
      if (!d || !d.smart) continue;
      const catalog = this.catalogFor(desc.id);
      const routing: TierPreset['routing'] = {};
      for (const tier of TIER_NAMES) {
        routing[tier] = { provider: desc.id, model: hasTierRules(desc, tier) ? LATEST_MODEL : (d[tier] || d.smart) };
      }
      const recommended = TIER_NAMES.map(t => resolveTier(desc, catalog, t).model);
      const visionModel = recommended.map(id => catalog.find(m => m.id === id)).find(m => m?.vision === true)
        ?? catalog.find(m => m.vision === true);
      out.push({ name: `${desc.label} recommended`, preset: { routing, vision: visionModel ? { provider: desc.id, model: visionModel.id } : null, fallback: null, decision: null } });
      for (const ladder of aliasLadders(desc, catalog)) {
        const ladderRouting: TierPreset['routing'] = {};
        for (const tier of TIER_NAMES) ladderRouting[tier] = { provider: desc.id, model: ladder.tiers[tier] };
        out.push({ name: `${desc.label} · ${ladder.label}`, preset: { routing: ladderRouting, vision: ladder.vision ? { provider: desc.id, model: ladder.vision } : null, fallback: null, decision: null } });
      }
    }
    return out;
  }

  private async loadSavedPresets(): Promise<Record<string, TierPreset>> {
    const raw = await this.fetch<string>(STORAGE_KEY_TIER_PRESETS);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, TierPreset>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  /** Saved login, applied over the environment's only once saved here. */
  private async loadAndApplyAuth(): Promise<void> {
    const enabled = await this.fetch<string>(STORAGE_KEY_AUTH_ENABLED);
    if (enabled === null) return;
    this.auth = {
      enabled: enabled === 'true',
      username: (await this.fetch<string>(STORAGE_KEY_AUTH_USER)) ?? '',
      password: (await this.fetch<string>(STORAGE_KEY_AUTH_PASS)) ?? '',
    };
    if (this.auth.enabled && (!this.auth.username || !this.auth.password)) this.auth.enabled = false;
    if (this.authGateId) await this.request(request(this.id, this.authGateId, 'updateAuth', { ...this.auth }));
    log.info(`Applied saved auth config (enabled=${this.auth.enabled})`);
  }

  // ===========================================================================
  // Permissions
  // ===========================================================================

  private async loadAndApplyPermissions(): Promise<void> {
    await this.claimAuthority();
    const promptMode = await this.fetch<string>(STORAGE_KEY_PROMPT_MODE);
    if (PROMPT_MODES.includes(promptMode as PromptMode)) {
      this.promptMode = promptMode as PromptMode;
      try { await this.applyPromptMode(); } catch (e) { log.warn(`Failed to apply the permission prompt mode: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Per-object rules and skill grants are written on their own, apart from
    // the rest of the permission set, so they load whether or not it was saved.
    const objectNames = this.parseJson<string[]>(await this.fetch<string>(STORAGE_KEY_OBJECT_PERM_NAMES)) ?? [];
    for (const name of objectNames) {
      const json = await this.fetch<string>(objectPermKey(name));
      if (!json) continue;
      try {
        const record = parseObjectRules(json);
        if (record.allow.length > 0 || record.deny.length > 0) this.objectRules.set(name, record);
      } catch { /* unreadable record */ }
    }
    for (const [objectName, record] of this.objectRules) {
      await this.applyCapabilityQuietly('ShellExecutor', 'updateObjectPermissions', { objectName, allowedCommands: record.allow, deniedCommands: record.deny });
    }
    const skillNames = this.parseJson<string[]>(await this.fetch<string>(STORAGE_KEY_SKILL_PERM_NAMES)) ?? [];
    for (const name of skillNames) {
      const cmds = this.parseJson<string[]>(await this.fetch<string>(skillPermKey(name)));
      if (isStringList(cmds) && cmds.length > 0) this.skillGrants.set(name, cmds);
    }
    for (const [skillName, cmds] of this.skillGrants) {
      await this.applyCapabilityQuietly('ShellExecutor', 'updateSkillPermissions', { skillName, allowedCommands: cmds });
    }

    // The rest applies only once something was saved: until then each
    // capability object keeps its own defaults.
    const fsRo = await this.fetch<string>(STORAGE_KEY_FS_READ_ONLY);
    const shellEn = await this.fetch<string>(STORAGE_KEY_SHELL_ENABLED);
    const webEn = await this.fetch<string>(STORAGE_KEY_WEB_ENABLED);
    if (fsRo === null && shellEn === null && webEn === null) return;
    if (fsRo !== null) this.fs.readOnly = fsRo === 'true';
    if (shellEn !== null) this.shell.enabled = shellEn === 'true';
    if (webEn !== null) this.web.enabled = webEn === 'true';
    const list = async (key: string): Promise<string[] | undefined> => {
      const parsed = this.parseJson<unknown>(await this.fetch<string>(key));
      return isStringList(parsed) ? parsed : undefined;
    };
    this.fs.allowedPaths = (await list(STORAGE_KEY_FS_ALLOWED_PATHS)) ?? this.fs.allowedPaths;
    this.shell.allowedCommands = (await list(STORAGE_KEY_SHELL_ALLOWED_CMDS)) ?? this.shell.allowedCommands;
    this.shell.deniedCommands = (await list(STORAGE_KEY_SHELL_DENIED_CMDS)) ?? this.shell.deniedCommands;
    this.web.allowedDomains = (await list(STORAGE_KEY_WEB_ALLOWED_DOMAINS)) ?? this.web.allowedDomains;
    this.web.deniedDomains = (await list(STORAGE_KEY_WEB_DENIED_DOMAINS)) ?? this.web.deniedDomains;
    this.web.privateHosts = (await list(STORAGE_KEY_WEB_PRIVATE_HOSTS)) ?? this.web.privateHosts;
    await this.propagatePermissions();
    log.info('Applied saved permissions');
  }

  private async persistPermissions(): Promise<void> {
    await this.store('set', STORAGE_KEY_FS_ALLOWED_PATHS, JSON.stringify(this.fs.allowedPaths));
    await this.store('set', STORAGE_KEY_FS_READ_ONLY, String(this.fs.readOnly));
    await this.store('set', STORAGE_KEY_SHELL_ENABLED, String(this.shell.enabled));
    await this.store('set', STORAGE_KEY_SHELL_ALLOWED_CMDS, JSON.stringify(this.shell.allowedCommands));
    await this.store('set', STORAGE_KEY_SHELL_DENIED_CMDS, JSON.stringify(this.shell.deniedCommands));
    await this.store('set', STORAGE_KEY_WEB_ENABLED, String(this.web.enabled));
    await this.store('set', STORAGE_KEY_WEB_ALLOWED_DOMAINS, JSON.stringify(this.web.allowedDomains));
    await this.store('set', STORAGE_KEY_WEB_DENIED_DOMAINS, JSON.stringify(this.web.deniedDomains));
    await this.store('set', STORAGE_KEY_WEB_PRIVATE_HOSTS, JSON.stringify(this.web.privateHosts));
  }

  /** Replace the per-object rules: persist each, and push every change (an emptied name included) to ShellExecutor. */
  private async replaceObjectRules(value: unknown): Promise<void> {
    precondition(!!value && typeof value === 'object' && !Array.isArray(value), 'objectRules must map object name to { allow, deny }');
    const next = new Map<string, ObjectCommandRules>();
    for (const [name, rules] of Object.entries(value as Record<string, unknown>)) {
      precondition(name.trim() !== '', 'objectRules: object names must be non-empty');
      const r = rules as Partial<ObjectCommandRules> | null;
      precondition(!!r && (r.allow === undefined || isStringList(r.allow)) && (r.deny === undefined || isStringList(r.deny)),
        `objectRules.${name} must be { allow: [...], deny: [...] }`);
      const allow = cleanList(r!.allow ?? []);
      const deny = cleanList(r!.deny ?? []).filter(c => !allow.includes(c));
      for (const cmd of [...allow, ...deny]) precondition(/^[^\s/\\]+$/.test(cmd), `objectRules.${name}: "${cmd}" is not a program name`);
      if (allow.length > 0 || deny.length > 0) next.set(name.trim(), { allow, deny });
    }
    const dropped = [...this.objectRules.keys()].filter(name => !next.has(name));
    this.objectRules = next;
    for (const [name, record] of next) await this.store('set', objectPermKey(name), JSON.stringify(record));
    // A dropped name keeps its key and its live rules in ShellExecutor: both get empty lists.
    for (const name of dropped) await this.store('set', objectPermKey(name), JSON.stringify({ allow: [], deny: [] }));
    await this.store('set', STORAGE_KEY_OBJECT_PERM_NAMES, JSON.stringify([...next.keys()]));
    for (const [objectName, record] of [...next, ...dropped.map(n => [n, { allow: [], deny: [] }] as [string, ObjectCommandRules])]) {
      await this.applyCapabilityQuietly('ShellExecutor', 'updateObjectPermissions', { objectName, allowedCommands: record.allow, deniedCommands: record.deny });
    }
  }

  private async replaceSkillGrants(value: unknown): Promise<void> {
    precondition(!!value && typeof value === 'object' && !Array.isArray(value), 'skillGrants must map skill name to a list of commands');
    const next = new Map<string, string[]>();
    for (const [name, cmds] of Object.entries(value as Record<string, unknown>)) {
      precondition(name.trim() !== '' && isStringList(cmds), `skillGrants.${name} must be a list of commands`);
      const list = cleanList(cmds as string[]);
      if (list.length > 0) next.set(name.trim(), list);
    }
    const dropped = [...this.skillGrants.keys()].filter(name => !next.has(name));
    this.skillGrants = next;
    for (const [name, cmds] of next) await this.store('set', skillPermKey(name), JSON.stringify(cmds));
    for (const name of dropped) await this.store('delete', skillPermKey(name));
    await this.store('set', STORAGE_KEY_SKILL_PERM_NAMES, JSON.stringify([...next.keys()]));
    for (const [skillName, cmds] of [...next, ...dropped.map(n => [n, []] as [string, string[]])]) {
      await this.applyCapabilityQuietly('ShellExecutor', 'updateSkillPermissions', { skillName, allowedCommands: cmds });
    }
  }

  /**
   * Register with PermissionBroker as the object allowed to push capability
   * settings. The broker holds the permissions authority on the capability
   * objects (policy lives there); changes made here are forwarded through it.
   */
  private async claimAuthority(): Promise<void> {
    if (this.authorityClaimed) return;
    this.authorityClaimed = true;
    this.permissionBrokerId = await this.discoverDep('PermissionBroker') ?? undefined;
    if (this.permissionBrokerId) {
      try {
        const r = await this.request<{ success?: boolean; error?: string }>(request(this.id, this.permissionBrokerId, 'setSettingsAuthority', {}));
        if (r && r.success === false) log.warn(`PermissionBroker refused the settings authority: ${r.error ?? 'unknown'}`);
      } catch { /* may already be claimed on restart */ }
      return;
    }
    // No broker (a stripped bootstrap): talk to the capability objects directly.
    log.warn('PermissionBroker not found; claiming capability authority directly');
    for (const name of ['HostFileSystem', 'ShellExecutor', 'HttpClient', 'StreamClient']) {
      const id = await this.discoverDep(name);
      if (!id) continue;
      try { await this.request(request(this.id, id, 'setPermissionsAuthority', {})); } catch { /* already claimed */ }
    }
  }

  private async applyCapability(capability: string, method: string, payload: Record<string, unknown>): Promise<void> {
    await this.claimAuthority();
    if (this.permissionBrokerId) {
      const r = await this.request<{ success?: boolean; error?: string }>(request(this.id, this.permissionBrokerId, 'applyToCapability', { capability, method, payload }));
      if (r && r.success === false) throw new Error(r.error ?? `${capability}.${method} was refused`);
      return;
    }
    const id = await this.discoverDep(capability);
    if (id) await this.request(request(this.id, id, method, payload));
  }

  private async applyCapabilityQuietly(capability: string, method: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.applyCapability(capability, method, payload); }
    catch (e) { log.warn(`Failed to apply ${capability}.${method}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  private async propagatePermissions(): Promise<void> {
    await this.applyCapabilityQuietly('HostFileSystem', 'updatePermissions', { allowedPaths: this.fs.allowedPaths, readOnly: this.fs.readOnly });
    await this.applyCapabilityQuietly('ShellExecutor', 'updatePermissions', {
      enabled: this.shell.enabled, allowedCommands: this.shell.allowedCommands, deniedCommands: this.shell.deniedCommands,
    });
    // Streams are web access held open: one switch and one domain list govern both.
    for (const capability of ['HttpClient', 'StreamClient']) {
      await this.applyCapabilityQuietly(capability, 'updatePermissions', {
        enabled: this.web.enabled, allowedDomains: this.web.allowedDomains, deniedDomains: this.web.deniedDomains, privateHosts: this.web.privateHosts,
      });
    }
  }

  // ===========================================================================
  // Storage
  // ===========================================================================

  private async fetch<T>(key: string): Promise<T | null> {
    if (!this.storageId) return null;
    return await this.request<T | null>(request(this.id, this.storageId, 'get', { key }));
  }

  private async store(op: 'set' | 'delete', key: string, value?: unknown): Promise<void> {
    if (!this.storageId) return;
    if (op === 'set') await this.request(request(this.id, this.storageId, 'set', { key, value }));
    else await this.request(request(this.id, this.storageId, 'delete', { key })).catch(() => undefined);
  }

  private parseJson<T>(raw: string | null): T | undefined {
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SettingsManager Usage Guide

The global settings as data. The Settings window and the terminal client edit them through this object.

### Read
- getSettingsSchema(): sections (ai, auth, filesystem, shell, web, permissions) and their fields.
- getSettings({ section? }): current values; secrets read as { set: true|false }.
- listPresets(), listModels({ provider }), isConfigured().

### Change
setSettings, applyPreset, savePreset and deletePreset are taken from the Settings window, the terminal client, and objects in a local workspace this machine hosts (never from shared or public workspaces):
changing settings is the person's call. To change something, open the Settings window (GlobalSettings.show) or ask the user.

### Events
- settingsChanged { section } after every change.`;
  }
}

export const SETTINGS_MANAGER_ID = 'abjects:settings-manager' as AbjectId;
