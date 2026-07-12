/**
 * ObjectCreator — LLM-driven agent for creating and modifying Abjects.
 *
 * This is a full rewrite. The old 9-phase pipeline is gone. What's here is a
 * small class that registers with AgentAbject and drives a single ReAct loop
 * whose only inter-object primitive is `call(target, method, payload)`. All
 * discovery, deployment, persistence, and behavioral verification happen by
 * sending messages to ordinary Abjects — every object answers `describe` and
 * `ask`, so the effective tool surface is the entire running Registry.
 *
 * Plan: /home/mempko/.claude/plans/maybe-what-we-should-swirling-stonebraker.md
 *
 * Three banner-delimited sections below:
 *   1. INFRASTRUCTURE   — types, dep resolution, message wrappers, progress.
 *   2. LOCAL OPERATIONS — tools that touch agent-local state (drafts,
 *                         compile, validate, review, terminals).
 *   3. AGENT SHELL      — AgentAbject registration, observe/act handlers,
 *                         system prompt, task lifecycle, finalization.
 */

import { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, InterfaceDeclaration, MethodDeclaration, EventDeclaration, ParameterDeclaration, TypeDeclaration, ObjectRegistration, SpawnRequest, SpawnResult } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { IntrospectResult } from '../core/introspect.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage } from '../llm/provider.js';
import type { ContentPart } from '../llm/provider.js';
import type { AgentAction } from './agent-abject.js';
import { buildOrganismManifest } from './organism.js';
import type { OrganismSpec, OrganelleSpec } from './organism.js';
import { Log } from '../core/timed-log.js';
import { applyDiff, parseSearchReplaceBlocks, levenshtein } from './source-diff.js';
import * as acorn from 'acorn';

const log = new Log('OBJECT-CREATOR');

/** Minimal structural view of an acorn/ESTree node (acorn's own types omit the
 *  ESTree node shapes; we read only type/start/end and a few fields). */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** Methods provided by the Abject / ScriptableAbject framework; valid on every object. */
const FRAMEWORK_PROVIDED_METHODS = ScriptableAbject.PROTECTED_HANDLERS;

export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
const OBJECT_CREATOR_INTERFACE = 'abjects:object-creator' as InterfaceId;

/**
 * Goal-scratchpad key where a task that ends WITHOUT deploying persists its
 * staged draft, so the follow-up task in the same goal resumes from the
 * authored source instead of re-writing it from the failure prose.
 */
const GOAL_DRAFT_KEY = 'objectcreator:staged-draft';

// ── Manifest normalization ────────────────────────────────────────────────
// LLMs frequently draft an interface with `methods`/`events` as bare string
// arrays (e.g. ["show","hide"]) or partial objects, but the schema wants
// MethodDeclaration/EventDeclaration objects. Left unnormalized, every
// downstream `.name` is undefined and the Abject Explorer / introspect render
// "undefined" for every method and event. Coerce to well-formed shapes so a
// name always survives, whatever the model emitted.

/** Coerce a type hint (already a TypeDeclaration, or a string like "string"/"Foo[]"/"object"). */
function coerceType(x: unknown): TypeDeclaration | undefined {
  if (x && typeof x === 'object' && typeof (x as { kind?: unknown }).kind === 'string') {
    return x as TypeDeclaration;
  }
  if (typeof x === 'string') {
    const t = x.trim();
    const lower = t.toLowerCase();
    if (!t || lower === 'void' || lower === 'any' || lower === 'unknown') return undefined;
    if (lower === 'string' || lower === 'number' || lower === 'boolean' || lower === 'null' || lower === 'undefined') {
      return { kind: 'primitive', primitive: lower as NonNullable<TypeDeclaration['primitive']> };
    }
    if (t.endsWith('[]')) return { kind: 'array', elementType: coerceType(t.slice(0, -2)) };
    if (lower === 'object') return { kind: 'object' };
    return { kind: 'reference', reference: t };
  }
  return undefined;
}

/** Coerce a parameter entry (a ParameterDeclaration, or a string like "url" / "url: string"). */
function coerceParam(p: unknown): ParameterDeclaration | null {
  if (typeof p === 'string') {
    const [rawName, ...rest] = p.split(':');
    const name = rawName.trim();
    if (!name) return null;
    return { name, type: coerceType(rest.join(':')) ?? { kind: 'object' }, description: '' };
  }
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) return null;
    return {
      name,
      type: coerceType(o.type) ?? { kind: 'object' },
      description: typeof o.description === 'string' ? o.description : '',
      ...(o.optional === true ? { optional: true } : {}),
    };
  }
  return null;
}

/** Coerce a method entry (a MethodDeclaration, or a bare method-name string). */
function coerceMethod(m: unknown): MethodDeclaration | null {
  if (typeof m === 'string') {
    const name = m.trim();
    return name ? { name, description: '', parameters: [] } : null;
  }
  if (m && typeof m === 'object') {
    const o = m as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) return null;
    const rawParams = Array.isArray(o.parameters) ? o.parameters : Array.isArray(o.params) ? o.params : [];
    const method: MethodDeclaration = {
      name,
      description: typeof o.description === 'string' ? o.description : '',
      parameters: rawParams.map(coerceParam).filter((x): x is ParameterDeclaration => x !== null),
    };
    const returns = coerceType(o.returns);
    if (returns) method.returns = returns;
    return method;
  }
  return null;
}

/** Coerce an event entry (an EventDeclaration, or a bare event-name string). */
function coerceEvent(e: unknown): EventDeclaration | null {
  if (typeof e === 'string') {
    const name = e.trim();
    return name ? { name, description: '', payload: { kind: 'object' } } : null;
  }
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) return null;
    return {
      name,
      description: typeof o.description === 'string' ? o.description : '',
      payload: coerceType(o.payload) ?? { kind: 'object' },
    };
  }
  return null;
}

/**
 * Normalize a drafted manifest's interface in place so method/event names are
 * never undefined, regardless of whether the model emitted strings or objects.
 * Also backfills a missing interface id/name/description from the manifest.
 * Tolerates the plural `interfaces: [...]` form (the shape system manifests
 * use in source) by adopting the first entry and folding the rest's
 * methods/events into it.
 */
function normalizeDraftManifest(manifest: AbjectManifest): AbjectManifest {
  const plural = (manifest as unknown as Record<string, unknown>).interfaces;
  if (!manifest.interface && Array.isArray(plural) && plural.length > 0) {
    const [first, ...rest] = plural.filter((x): x is InterfaceDeclaration => !!x && typeof x === 'object');
    if (first) {
      for (const extra of rest) {
        if (Array.isArray(extra.methods)) first.methods = [...(first.methods ?? []), ...extra.methods];
        if (Array.isArray(extra.events)) first.events = [...(first.events ?? []), ...extra.events];
      }
      manifest.interface = first;
      delete (manifest as unknown as Record<string, unknown>).interfaces;
    }
  }

  const iface = manifest.interface as InterfaceDeclaration | undefined;
  if (!iface || typeof iface !== 'object') return manifest;

  iface.methods = (Array.isArray(iface.methods) ? iface.methods : [])
    .map(coerceMethod)
    .filter((x): x is MethodDeclaration => x !== null);
  iface.events = (Array.isArray(iface.events) ? iface.events : [])
    .map(coerceEvent)
    .filter((x): x is EventDeclaration => x !== null);

  const slug = String(manifest.name ?? 'object').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'object';
  if (typeof iface.id !== 'string' || !iface.id) iface.id = `abjects:${slug}` as InterfaceId;
  if (typeof iface.name !== 'string' || !iface.name) iface.name = `${manifest.name ?? 'Object'}Interface`;
  if (typeof iface.description !== 'string') iface.description = manifest.description ?? '';

  return manifest;
}

// ════════════════════════════════════════════════════════════════════════
// 1. INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════════════

/** External result shape. Callers check `success` first, then `objectId` / `error` / `report`. */
export interface CreationResult {
  success: boolean;
  objectId?: AbjectId;
  manifest?: AbjectManifest;
  code?: string;
  error?: string;
  usedObjects?: string[];
  /** Present when the task was diagnostic-only — the agent's written answer. */
  report?: string;
}

/** One method's signature, rendered for observation + validator use. */
interface MethodSignature {
  name: string;
  description?: string;
  params: Array<{ name: string; optional?: boolean; typeHint?: string }>;
  returns?: string;
}

/** Authoritative per-dep view built from `describe` manifests + `ask` guides. */
interface DepMethodIndex {
  depName: string;
  depId: AbjectId;
  methods: Map<string, MethodSignature>;
  events: Set<string>;
  usageGuide: string;
}

/** Output from the static call-name walker. */
interface CallValidationError {
  kind: 'unknown-dep' | 'unknown-method' | 'name-string-recipient' | 'hardcoded-id';
  callSite: { line: number; snippet: string };
  depName?: string;
  methodName?: string;
  availableMethods?: string[];
}

/** Output from the LLM semantic reviewer. */
interface SemanticReviewResult {
  verified: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; callSite?: string }>;
  questions: Array<{ dep: string; question: string }>;
}

/** State carried across turns of a single agent task. */
interface LoopState {
  kind: 'create' | 'modify' | 'investigate';
  goal: string;
  targetObjectId?: AbjectId;
  targetName?: string;

  deps: Map<string, DepMethodIndex>;
  targetSource?: string;
  targetState?: unknown;

  draftManifest?: AbjectManifest;
  draftSource?: string;
  usedObjects: string[];

  turn: number;
  turnLog: Array<{ turn: number; action: string; ok: boolean; summary: string }>;
  lastValidation?: {
    calls?: CallValidationError[];
    semantics?: SemanticReviewResult;
    compile?: string;
  };

  terminal?: { kind: 'done' | 'fail'; result?: unknown; error?: string };
  spawnedObjectId?: AbjectId;
  /**
   * Set when deploy_spawn found ANOTHER live object already holding the
   * draft's name. Registry uniquifies duplicate registration names, so
   * name-based discovery keeps resolving to this pre-existing object — a
   * verification call routed by name would exercise the wrong instance and
   * report a false positive. opCall pins name calls to spawnedObjectId and
   * the observation warns until the duplicate is dealt with.
   */
  nameCollisionId?: AbjectId;
  deployedViaUpdateSource?: boolean;
  /**
   * Snapshot of `draftSource` as it was at the last successful deploy
   * (deploy_spawn / deploy_update). When `draftSource` differs from this, the
   * live object is running stale code — the observation flags it and the loop
   * is told not to finish until it is deployed. Compiling is not deploying.
   */
  lastDeployedSource?: string;
}

/** Per-task bookkeeping: the caller's message to deferred-reply to, plus loop state. */
interface TaskExtra {
  taskId: string;       // what AgentAbject calls back with on agentObserve / agentAct
  ticketId?: string;    // what AgentAbject returns from startTask; appears on taskResult
  prompt: string;
  context?: string;
  callerId?: AbjectId;
  goalId?: string;
  deferredMsg?: AbjectMessage;
  state: LoopState;
  /**
   * Multimodal content (an image part) staged by the previous `act` to ride
   * into the NEXT observation — e.g. a screenshot captured via
   * Screenshot.captureWindow, so the agent can visually inspect what it
   * rendered. Consumed (and cleared) by handleObserve.
   */
  lastLlmContent?: ContentPart[];
}

/**
 * ObjectCreator — create, modify, or investigate Abjects by driving a
 * ReAct loop over a single `call` primitive plus a handful of local ops.
 */
export class ObjectCreator extends Abject {
  private llmId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private abjectStoreId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private goalManagerId?: AbjectId;
  private knowledgeBaseId?: AbjectId;
  private consoleId?: AbjectId;

  /** Active tasks keyed by the taskId we hand to AgentAbject. */
  private tasks = new Map<string, TaskExtra>();

  /**
   * Cached vision availability from the LLM service (see refreshVisionCapability).
   * true/unknown = the visual-verification loop works; false = every configured
   * model is text-only, so screenshots can be captured but never inspected —
   * the loop must say so instead of pretending to look.
   */
  private visionCapable: boolean | undefined;
  private visionCheckedAt = 0;
  private static readonly VISION_TTL_MS = 60_000;
  /** Reverse index: AgentAbject's ticketId → our taskId, for taskResult lookup. */
  private taskIdByTicket = new Map<string, string>();

  constructor() {
    super({
      manifest: {
        name: 'ObjectCreator',
        description:
          'Creates new Abjects and modifies existing ones through a ReAct loop over message passing. ' +
          'Learns how to use targets and dependencies primarily through the universal ask protocol (prose usage, examples, design guidance), drafts code, validates drafts against live manifests, deploys, and verifies behavior. ' +
          'Handles any task about building, authoring, fixing, changing, updating, modifying, redesigning, or improving an Abject — including bridges, proxies, relays, wrappers, adapters, and integrations. ' +
          'Diagnostic questions about an object terminate with a written report instead of a modification.',
        version: '2.0.0',
        interface: {
          id: OBJECT_CREATOR_INTERFACE,
          name: 'ObjectCreator',
          description: 'Abject creation, modification, and investigation via an LLM-driven agent loop',
          methods: [
            {
              name: 'create',
              description: 'Create a new Abject from a natural-language description',
              parameters: [
                { name: 'prompt', type: { kind: 'primitive', primitive: 'string' }, description: 'Description of what to create' },
                { name: 'context', type: { kind: 'primitive', primitive: 'string' }, description: 'Additional context', optional: true },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal to link progress to', optional: true },
              ],
              returns: { kind: 'reference', reference: 'CreationResult' },
            },
            {
              name: 'modify',
              description: 'Modify an existing Abject',
              parameters: [
                { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target object (UUID or registered name)' },
                { name: 'prompt', type: { kind: 'primitive', primitive: 'string' }, description: 'What to change or investigate' },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal to link progress to', optional: true },
              ],
              returns: { kind: 'reference', reference: 'CreationResult' },
            },
            {
              name: 'executeTask',
              description: 'Execute a task dispatched by AgentAbject (create, modify, or investigate)',
              parameters: [
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'TupleSpace tuple ID' },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID', optional: true },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Hint: create, modify, or investigate', optional: true },
                { name: 'data', type: { kind: 'object', properties: {} }, description: 'Task-specific data', optional: true },
                { name: 'callerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Upstream caller for progress events', optional: true },
              ],
              returns: { kind: 'reference', reference: 'CreationResult' },
            },
          ],
          events: [
            {
              name: 'objectCreated',
              description: 'New object was spawned',
              payload: { kind: 'reference', reference: 'CreationResult' },
            },
            {
              name: 'objectModified',
              description: 'Existing object had its source updated',
              payload: { kind: 'reference', reference: 'CreationResult' },
            },
            {
              name: 'progress',
              description: 'Progress update during an agent loop',
              payload: {
                kind: 'object',
                properties: {
                  phase: { kind: 'primitive', primitive: 'string' },
                  message: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'creation'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
    this.registryId = await this.requireDep('Registry');
    // Prime the vision check so the (synchronous) prompt builder has an
    // answer by the time the first task starts.
    void this.refreshVisionCapability();
    this.factoryId = await this.requireDep('Factory');
    this.systemRegistryId = (await this.discoverDep('SystemRegistry')) ?? undefined;
    this.abjectStoreId = (await this.discoverDep('AbjectStore')) ?? undefined;
    this.agentAbjectId = (await this.discoverDep('AgentAbject')) ?? undefined;
    this.goalManagerId = (await this.discoverDep('GoalManager')) ?? undefined;
    this.knowledgeBaseId = (await this.discoverDep('KnowledgeBase')) ?? undefined;
    this.consoleId = (await this.discoverDep('Console')) ?? undefined;

    if (this.agentAbjectId) {
      try {
        await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
          name: 'ObjectCreator',
          description:
            'Creates new objects and modifies existing objects via an LLM-driven agent loop. ' +
            'Handles creation, modification, investigation, fixing, redesigning, and integration tasks — any work involving building, changing, or explaining an Abject\'s behavior. ' +
            'Uses the universal ask protocol to discover and learn about objects dynamically.',
          canExecute: true,
          config: {
            maxSteps: 30,
            terminalActions: {
              done: { type: 'success', resultFields: ['result'] },
              fail: { type: 'error', resultFields: ['reason'] },
            },
            intermediateActions: [],
            queueName: `object-creator-${this.id}`,
          },
        }));
      } catch (err) {
        log.warn('Failed to register with AgentAbject:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  protected override askBusyStatus(): string | undefined {
    return this.tasks.size > 0
      ? `authoring/modifying objects (${this.tasks.size} task${this.tasks.size === 1 ? '' : 's'} in flight)`
      : undefined;
  }

  /**
   * Refresh the cached vision answer from the LLM service. Models can be
   * reconfigured at any time, so re-check on a short TTL. Errors leave the
   * cache as-is and an unknown capability stays optimistic — only a definite
   * "every configured model is text-only" (getVisionModel → null) flips the
   * loop into no-vision mode.
   */
  private async refreshVisionCapability(): Promise<boolean | undefined> {
    const now = Date.now();
    if (now - this.visionCheckedAt < ObjectCreator.VISION_TTL_MS) return this.visionCapable;
    this.visionCheckedAt = now;
    try {
      if (!this.llmId) return this.visionCapable;
      const vm = await this.sendRequest<{ tier: string } | null>(this.llmId, 'getVisionModel', {}, 10000);
      this.visionCapable = vm !== null;
    } catch { /* keep previous answer */ }
    return this.visionCapable;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ObjectCreator — Abject Authoring & Modification Agent

I author and modify Abject source code via an LLM-driven loop that reads existing source from the Registry, drafts diffs, validates calls, reviews semantics, and deploys updates through the standard ScriptableAbject update path.

What I handle:
- Single-object authoring (new widgets, apps, bridges, proxies, MCP wrappers).
- Modifying existing Abject source — adding methods, events, manifest entries; fixing handlers; refactoring an Abject's implementation.
- Investigation that ends in code edits (read source, diagnose, fix).
- Composing existing source-backed objects into one Organism behind a single membrane interface, and extracting an organelle back out as a standalone object.

What I don't handle:
- Multi-object autonomous-system composition (agent + scheduler + watcher) — that's AgentCreator.
- Runtime method calls on existing objects — that's ObjectAgent.
- Public-web browsing — that's WebAgent.
- Installed skill use at runtime — that's SkillAgent.

When invited to a Sprint Plan, describe the concrete authoring or modification I'd perform, the target Abject (by name), and what would change. If the goal is purely runtime (open a window, call a method, send a Slack message), reply PASS.`;
  }

  // ── Message-passing helpers (thin wrappers over request/event) ─────────

  private async sendRequest<T = unknown>(target: AbjectId, method: string, payload: unknown, timeoutMs = 30000): Promise<T> {
    return this.request<T>(request(this.id, target, method, payload), timeoutMs);
  }

  /**
   * Resolve a reference (live AbjectId, durable TypeId, or registered name) to
   * the CURRENT live AbjectId.
   *
   * An id-shaped string is NOT trusted blindly: AbjectIds are ephemeral and
   * churn every time AbjectStore restores an object on restart, so a stale id
   * captured in a prior session (or baked into a goal / KnowledgeBase entry)
   * must be verified against the live registry before use. If it isn't live,
   * we fall through to TypeId and name resolution rather than silently adopting
   * a dead id (which is exactly what made getSource return nothing earlier).
   */
  private async resolveTarget(nameOrId: string): Promise<AbjectId | undefined> {
    if (!nameOrId) return undefined;
    const idShaped = nameOrId.includes('-') && nameOrId.length > 20;

    // Fast path: an id-shaped string that is a live registration.
    if (idShaped && await this.isLiveRegistration(nameOrId as AbjectId)) {
      return nameOrId as AbjectId;
    }

    for (const registryId of [this.registryId, this.systemRegistryId]) {
      if (!registryId) continue;
      // Durable TypeId → current AbjectId.
      try {
        const live = await this.sendRequest<AbjectId | null>(registryId, 'resolveType', { typeId: nameOrId });
        if (live) return live;
      } catch { /* fall through */ }
      // Registered name → first live AbjectId.
      try {
        const hits = await this.sendRequest<ObjectRegistration[]>(registryId, 'discover', { name: nameOrId });
        if (hits && hits.length > 0) return hits[0].id;
      } catch { /* fall through */ }
    }
    return undefined;
  }

  /** True if `id` is a currently-registered object in either registry. */
  private async isLiveRegistration(id: AbjectId): Promise<boolean> {
    for (const registryId of [this.registryId, this.systemRegistryId]) {
      if (!registryId) continue;
      try {
        const reg = await this.sendRequest<ObjectRegistration | null>(registryId, 'lookup', { objectId: id });
        if (reg) return true;
      } catch { /* fall through */ }
    }
    return false;
  }

  /** Report progress to an upstream caller (for GoalManager / JobBrowser visibility). */
  private reportProgress(callerId: AbjectId | undefined, phase: string, message: string): void {
    if (!callerId || callerId === this.id) return;
    this.send(event(this.id, callerId, 'progress', { phase, message }));
    if (this.goalManagerId) {
      const goalId = this.findCurrentGoalId(callerId);
      if (goalId) {
        this.send(event(this.id, this.goalManagerId, 'updateProgress', {
          goalId,
          message,
          phase,
          agentName: 'ObjectCreator',
        }));
      }
    }
  }

  /** Look up the goalId associated with the current caller, if we're in a task. */
  private findCurrentGoalId(callerId: AbjectId): string | undefined {
    for (const extra of this.tasks.values()) {
      if (extra.callerId === callerId && extra.goalId) return extra.goalId;
    }
    return undefined;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. LOCAL OPERATIONS (tools with no message target)
  // ════════════════════════════════════════════════════════════════════════

  /** Stage a manifest draft. The agent typically writes one before drafting source. */
  private async opDraftManifest(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    const manifest = this.actionField(action, ['manifest', 'draftManifest']) as AbjectManifest | undefined;
    if (!manifest || typeof manifest !== 'object') {
      const got = Object.keys(action).filter(k => k !== 'action' && k !== 'reasoning').join(', ') || '(none)';
      return {
        ok: false,
        summary: 'draft_manifest: missing manifest',
        error: `No manifest object found in the action (got fields: ${got}). Pass it as the \`manifest\` field: {"action":"draft_manifest","manifest":{ name, description, version, icon, interface: { id, name, description, methods, events? }, requiredCapabilities: [], tags: [] },"usedObjects":[...]}`,
      };
    }
    normalizeDraftManifest(manifest);
    if (!manifest.name || !manifest.interface) {
      const missing = [!manifest.name && 'name', !manifest.interface && 'interface'].filter(Boolean).join(' and ');
      return { ok: false, summary: 'draft_manifest: malformed', error: `manifest is missing ${missing}. Required shape: { name, description, version, interface: { id, name, description, methods, events? }, requiredCapabilities: [], tags: [] }` };
    }
    state.draftManifest = manifest;
    const usedObjects = this.actionField(action, ['usedObjects', 'dependencies', 'deps']);
    if (Array.isArray(usedObjects)) {
      state.usedObjects = usedObjects.filter((x): x is string => typeof x === 'string');
    }
    return { ok: true, summary: `draft_manifest: ${manifest.name} (${(manifest.interface.methods ?? []).length} method${(manifest.interface.methods ?? []).length === 1 ? '' : 's'})` };
  }

  /** Stage a source draft. */
  /**
   * Pull a field from an action, tolerant of the model wrapping args in a
   * `params`/`arguments`/`input` envelope and of common field aliases. Keeps
   * a single mis-keyed payload from wasting a whole step on a "missing X" error.
   */
  private actionField(action: AgentAction, keys: string[]): unknown {
    // `payload`/`args` are included because the `call` action nests its fields
    // under `payload`, and models carry that habit to local actions — emitting
    // e.g. {"action":"draft_diff","payload":{"blocks":"..."}}. Reading the
    // wrapper here lets those flat-vs-nested variants both resolve.
    const envelopes = [action, action.payload, action.params, action.arguments, action.args, action.input]
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
    for (const env of envelopes) {
      for (const k of keys) {
        const v = env[k];
        if (v !== undefined && v !== null) return v;
      }
    }
    return undefined;
  }

  /** Valid action verbs this loop dispatches, for unknown-action recovery. */
  private static readonly VALID_ACTIONS = [
    'call', 'draft_manifest', 'draft_source', 'draft_diff', 'read_draft',
    'replace_handler', 'add_handler', 'remove_handler', 'load_target', 'draft_via_llm',
    'compile', 'validate_calls', 'review_semantics', 'deploy_spawn', 'deploy_update',
    'compose_organism', 'extract_organelle',
    'reply', 'ask_user', 'done', 'fail',
  ];

  /**
   * Build a recovery message for an unrecognized action. The most common cause
   * is the model emitting another object's METHOD as a top-level action verb
   * (e.g. `writeGoalData`, which is a real GoalManager method) — redirect that
   * to the `call` action. Otherwise list the valid verbs and suggest the closest.
   */
  private unknownActionError(got: string, state: LoopState): string {
    const valid = ObjectCreator.VALID_ACTIONS;

    // Did the model use a discovered object's method name as the action?
    // Steer it to the call form against the owning object.
    const owners: string[] = [];
    for (const [name, dep] of state.deps) {
      if (dep.methods.has(got)) owners.push(name);
    }
    if (owners.length > 0) {
      const target = owners[0];
      return `"${got}" is a method on ${owners.map(o => `"${o}"`).join(' / ')}, not a loop action. ` +
        `Invoke it with the call action: {"action":"call","target":"${target}","method":"${got}","payload":{ ... }}.`;
    }

    const lower = (got ?? '').toLowerCase();
    let suggestion: string | undefined;
    let best = Infinity;
    for (const v of valid) {
      const d = levenshtein(lower, v);
      if (d < best) { best = d; suggestion = v; }
    }
    const hint = suggestion && best <= Math.ceil(suggestion.length / 2) ? ` Did you mean "${suggestion}"?` : '';
    return `Unknown action "${got}". Valid actions: ${valid.join(', ')}.${hint} ` +
      `If "${got}" is a method on another object (for example writeGoalData/readGoalData on GoalManager), call it via {"action":"call","target":"<object>","method":"${got}","payload":{ ... }}.`;
  }

  private async opDraftSource(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    const source = this.actionField(action, ['source', 'code', 'draftSource', 'src']) as string | undefined;
    if (typeof source !== 'string' || source.length === 0) {
      const editingExisting = !!state.targetSource;
      const steer = editingExisting
        ? ' You are modifying an existing object, so a whole-object draft_source is rarely needed — and a large source often gets truncated out of the action (the model runs out of output length). Prefer a TARGETED edit: replace_handler({name, body}) to swap one method (name-addressed, no SEARCH matching), or draft_diff for a small span. Only fall back to draft_source for a genuine full rewrite.'
        : ' If the source is large and keeps getting dropped, draft it out-of-band with draft_via_llm({kind:"source"}) instead of inlining it in the action.';
      return { ok: false, summary: 'draft_source: missing source', error: `source must be a non-empty string (pass it as the \`source\` field).${steer}` };
    }
    state.draftSource = source;
    return { ok: true, summary: `draft_source: ${source.split('\n').length} lines staged` };
  }

  /**
   * Apply SEARCH/REPLACE blocks to the current source. Bases off
   * `state.draftSource` if present (so multiple diff calls stack), otherwise
   * `state.targetSource` (the existing object's source for a modify loop).
   * Result is staged as the new draftSource.
   *
   * On any block failure, draftSource is left untouched and the failure
   * details are returned so the LLM can correct course on the next turn.
   * Common failure causes: SEARCH text doesn't match (whitespace mismatch
   * or wrong snippet), or SEARCH matches multiple locations (need more
   * surrounding context).
   */
  /**
   * Coerce whatever the model passed for `blocks` into SEARCH/REPLACE text.
   * Accepts a ready-made string, an array of block strings, or structured
   * edits ({search, replace} objects — the shape a model naturally reaches for)
   * either as a single object or an array. Returns '' when nothing usable.
   */
  private normalizeDiffBlocks(raw: unknown): string {
    const toBlock = (o: Record<string, unknown>): string | null => {
      const search = o.search ?? o.find ?? o.old ?? o.before ?? o.from ?? o.original;
      const replace = o.replace ?? o.replacement ?? o.new ?? o.after ?? o.to ?? o.updated;
      if (typeof search === 'string' && typeof replace === 'string') {
        return `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
      }
      return null;
    };
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      const parts: string[] = [];
      for (const item of raw) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object') {
          const b = toBlock(item as Record<string, unknown>);
          if (b) parts.push(b);
        }
      }
      return parts.join('\n');
    }
    if (raw && typeof raw === 'object') return toBlock(raw as Record<string, unknown>) ?? '';
    return '';
  }

  private async opDraftDiff(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    const rawBlocks = this.actionField(action, ['blocks', 'diff', 'search_replace', 'searchReplace', 'patch', 'edits']);
    const blocksText = this.normalizeDiffBlocks(rawBlocks);
    if (typeof blocksText !== 'string' || blocksText.length === 0) {
      return { ok: false, summary: 'draft_diff: missing blocks', error: 'blocks must be a non-empty string of SEARCH/REPLACE blocks, passed as the `blocks` field. Format: <<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE. For editing one method, prefer replace_handler({name, body}) — name-addressed, no SEARCH text to match. To rewrite the whole object use draft_source.' };
    }
    const base = state.draftSource ?? state.targetSource;
    if (!base) {
      return {
        ok: false,
        summary: 'draft_diff: no base source',
        error: 'draft_diff requires an existing source to edit. For modify loops the target source is loaded automatically. If you discovered the goal is about an existing object, call load_target({objectId|targetName}) to adopt it and load its source, then draft_diff. For a brand-new object, use draft_source instead.',
      };
    }

    const parsed = parseSearchReplaceBlocks(blocksText);
    if (parsed.blocks.length === 0) {
      const detail = parsed.parseErrors.length > 0 ? parsed.parseErrors.join('; ') : 'no blocks recognized';
      return {
        ok: false,
        summary: `draft_diff: parse failed (${detail.slice(0, 80)})`,
        error: `Could not parse any SEARCH/REPLACE blocks. ${detail}. Format: each block is\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE`,
      };
    }

    const result = applyDiff(base, parsed.blocks);
    if (!result.ok) {
      const errorLines = result.errors.map((e) => {
        let line = `  - ${e.message}`;
        // Show the closest region actually in the source so the next attempt can
        // copy it verbatim instead of guessing at whitespace again.
        if (e.nearest) {
          line += `\n    Closest text in source (around line ${e.nearest.line}) — copy this EXACTLY into your SEARCH:\n` +
            e.nearest.text.split('\n').map((l) => `    | ${l}`).join('\n');
        }
        return line;
      }).join('\n');
      const parseNote = parsed.parseErrors.length > 0 ? `\nParse warnings: ${parsed.parseErrors.join('; ')}` : '';
      return {
        ok: false,
        summary: `draft_diff: ${result.applied}/${parsed.blocks.length} applied, ${result.errors.length} failed`,
        error: `Some SEARCH/REPLACE blocks could not be applied:\n${errorLines}${parseNote}\n\nFix the failing blocks and call draft_diff again. If the edit is one method, the robust path is read_draft({handler:"<name>"}) to see its exact current text, then replace_handler({name:"<name>", body:"<full method>"}) — no SEARCH matching. For a whole-object rewrite use draft_source.`,
      };
    }

    state.draftSource = result.source;
    const stackedNote = state.draftSource && base !== state.targetSource ? ' (stacked on prior draft)' : '';
    const parseNote = parsed.parseErrors.length > 0 ? ` [parse warnings: ${parsed.parseErrors.length}]` : '';
    return {
      ok: true,
      summary: `draft_diff: ${parsed.blocks.length} block${parsed.blocks.length === 1 ? '' : 's'} applied${stackedNote}, source now ${result.source!.split('\n').length} lines${parseNote}`,
    };
  }

  // ── Structure-aware editing of the staged handler-map object literal ──────
  //
  // Generated objects are a single `({ name(msg){...}, _helper(){...}, prop: v })`
  // literal, so the natural — and whitespace-proof — edit unit is a top-level
  // member addressed by NAME. These ops parse that literal and replace / add /
  // remove one member, avoiding the SEARCH-text matching that makes draft_diff
  // fragile on large files. read_draft lets the agent edit against ground truth
  // (the current stage) instead of reconstructing it from memory.

  /**
   * Parse the top-level members of the `({ ... })` handler map with a real JS
   * parser (acorn), so regexes, template literals, comments, and nested syntax
   * are handled exactly — no hand-rolled scanning. Returns the object literal's
   * brace span (objStart = index of `{`, objEnd = index of `}`) plus each
   * top-level member's name and [start, end) source span. Returns null when the
   * source doesn't parse or has no top-level object literal (callers then fall
   * back to draft_diff / draft_source).
   */
  private parseHandlerMembers(source: string): {
    objStart: number; objEnd: number;
    members: Array<{ name: string; start: number; end: number }>;
  } | null {
    let program: AstNode;
    try {
      program = acorn.parse(source, { ecmaVersion: 'latest' }) as unknown as AstNode;
    } catch {
      return null;
    }

    // The handler map is `({ ... })` → an ExpressionStatement whose expression
    // is the ObjectExpression. Find it among the top-level statements.
    let obj: AstNode | null = null;
    for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
      const expr = stmt.expression as AstNode | undefined;
      if (stmt.type === 'ExpressionStatement' && expr?.type === 'ObjectExpression') {
        obj = expr;
        break;
      }
    }
    if (!obj) return null;

    const members: Array<{ name: string; start: number; end: number }> = [];
    for (const prop of (obj.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== 'Property') continue; // skip SpreadElement etc.
      let name = '';
      if (!prop.computed) {
        const key = prop.key as AstNode | undefined;
        if (key?.type === 'Identifier') name = String(key.name);
        else if (key?.type === 'Literal') name = String(key.value);
      }
      members.push({ name, start: prop.start, end: prop.end });
    }
    // acorn's node.end is one past the last char; the closing `}` sits at end-1.
    return { objStart: obj.start, objEnd: obj.end - 1, members };
  }

  private opReadDraft(state: LoopState, action: AgentAction): { ok: boolean; summary: string; error?: string; data?: unknown } {
    const base = state.draftSource ?? state.targetSource;
    if (!base) {
      return { ok: false, summary: 'read_draft: nothing staged', error: 'No staged or target source yet. Use draft_source for a new object, or load_target to adopt an existing one.' };
    }
    const numbered = (text: string, startLine = 1): string =>
      text.split('\n').map((l, i) => `${startLine + i}\t${l}`).join('\n');

    const handler = this.actionField(action, ['handler', 'name', 'method']) as string | undefined;
    const grep = this.actionField(action, ['grep', 'search', 'pattern']) as string | undefined;
    const lineRange = this.actionField(action, ['lineRange', 'lines', 'range']);

    if (handler) {
      const parsed = this.parseHandlerMembers(base);
      const m = parsed?.members.find(x => x.name === handler);
      if (!m) {
        return { ok: false, summary: `read_draft: no handler "${handler}"`, error: `No top-level member named "${handler}". Available: ${parsed ? parsed.members.map(x => x.name).join(', ') : '(could not parse object literal)'}.` };
      }
      const startLine = base.slice(0, m.start).split('\n').length;
      return { ok: true, summary: `read_draft: ${handler}`, data: numbered(base.slice(m.start, m.end), startLine) };
    }

    if (lineRange) {
      let a = 0;
      let b = 0;
      if (typeof lineRange === 'string') {
        const mm = lineRange.match(/(\d+)\s*-\s*(\d+)/);
        if (mm) { a = parseInt(mm[1], 10); b = parseInt(mm[2], 10); }
      } else if (lineRange && typeof lineRange === 'object') {
        const lr = lineRange as { start?: number; end?: number };
        a = lr.start ?? 0; b = lr.end ?? 0;
      }
      if (a > 0 && b >= a) {
        const lines = base.split('\n').slice(a - 1, b);
        return { ok: true, summary: `read_draft: lines ${a}-${b}`, data: numbered(lines.join('\n'), a) };
      }
      return { ok: false, summary: 'read_draft: bad lineRange', error: 'lineRange must be "start-end" or { start, end } with start>=1.' };
    }

    if (grep) {
      // Treat the pattern as a regex, but fall back to a literal substring
      // search when it isn't valid regex — agents routinely pass code snippets
      // like "_handlePaste(session" whose unbalanced parens aren't valid regex.
      let test: (line: string) => boolean;
      try {
        const re = new RegExp(grep, 'i');
        test = (line) => re.test(line);
      } catch {
        const needle = grep.toLowerCase();
        test = (line) => line.toLowerCase().includes(needle);
      }
      const hits = base.split('\n')
        .map((l, i) => ({ n: i + 1, l }))
        .filter(x => test(x.l))
        .slice(0, 60)
        .map(x => `${x.n}\t${x.l}`)
        .join('\n');
      return { ok: true, summary: `read_draft: grep "${grep}"`, data: hits || '(no matches)' };
    }

    // Default: a compact outline (member names + line ranges) so the agent can
    // navigate without pulling the whole file into context, then read one member.
    const parsed = this.parseHandlerMembers(base);
    const total = base.split('\n').length;
    if (!parsed || parsed.members.length === 0) {
      return { ok: true, summary: `read_draft: ${total} lines`, data: numbered(base) };
    }
    const outline = parsed.members.map(m => {
      const sl = base.slice(0, m.start).split('\n').length;
      const el = base.slice(0, m.end).split('\n').length;
      return `  ${m.name}  (lines ${sl}-${el}, ${el - sl + 1} ln)`;
    }).join('\n');
    return {
      ok: true,
      summary: `read_draft: outline (${parsed.members.length} members, ${total} lines)`,
      data: `Staged source: ${total} lines, ${parsed.members.length} top-level members. Read one with read_draft({handler:"name"}), or read_draft({lineRange:"a-b"}) / read_draft({grep:"..."}).\n${outline}`,
    };
  }

  private opReplaceHandler(state: LoopState, action: AgentAction): { ok: boolean; summary: string; error?: string } {
    const base = state.draftSource ?? state.targetSource;
    if (!base) return { ok: false, summary: 'replace_handler: no source', error: 'Nothing staged. Use draft_source for a new object, or load_target to adopt an existing one.' };
    const name = this.actionField(action, ['name', 'handler', 'method']) as string | undefined;
    const body = this.actionField(action, ['body', 'source', 'member', 'text', 'code']) as string | undefined;
    if (!name) return { ok: false, summary: 'replace_handler: missing name', error: 'replace_handler requires {name} — the existing member to replace.' };
    if (typeof body !== 'string' || !body.trim()) return { ok: false, summary: 'replace_handler: missing body', error: 'replace_handler requires {body} — the FULL member text including its signature, e.g. "openMap(msg) { ... }".' };
    const parsed = this.parseHandlerMembers(base);
    if (!parsed) return { ok: false, summary: 'replace_handler: unparseable', error: 'Could not locate the handler-map object literal. Use draft_diff or draft_source instead.' };
    const m = parsed.members.find(x => x.name === name);
    if (!m) return { ok: false, summary: `replace_handler: no "${name}"`, error: `No top-level member named "${name}". Available: ${parsed.members.map(x => x.name).join(', ')}. To add a new member use add_handler.` };
    const next = base.slice(0, m.start) + body.trim() + base.slice(m.end);
    state.draftSource = next;
    return { ok: true, summary: `replace_handler: "${name}" replaced, source now ${next.split('\n').length} lines. Run compile next.` };
  }

  private opAddHandler(state: LoopState, action: AgentAction): { ok: boolean; summary: string; error?: string } {
    const base = state.draftSource ?? state.targetSource;
    if (!base) return { ok: false, summary: 'add_handler: no source', error: 'Nothing staged. Use draft_source for a new object, or load_target to adopt an existing one.' };
    const name = this.actionField(action, ['name', 'handler', 'method']) as string | undefined;
    const body = this.actionField(action, ['body', 'source', 'member', 'text', 'code']) as string | undefined;
    if (!name) return { ok: false, summary: 'add_handler: missing name', error: 'add_handler requires {name}.' };
    if (typeof body !== 'string' || !body.trim()) return { ok: false, summary: 'add_handler: missing body', error: 'add_handler requires {body} — the full member text, e.g. "myMethod(msg) { ... }".' };
    const parsed = this.parseHandlerMembers(base);
    if (!parsed) return { ok: false, summary: 'add_handler: unparseable', error: 'Could not locate the handler-map object literal. Use draft_diff or draft_source instead.' };
    if (parsed.members.some(x => x.name === name)) {
      return { ok: false, summary: `add_handler: "${name}" exists`, error: `A member named "${name}" already exists — use replace_handler to change it.` };
    }
    let j = parsed.objEnd - 1;
    while (j > parsed.objStart && /\s/.test(base[j])) j--;
    const needsComma = base[j] !== ',' && base[j] !== '{';
    const insertion = (needsComma ? ',' : '') + '\n\n  ' + body.trim() + '\n';
    const next = base.slice(0, parsed.objEnd) + insertion + base.slice(parsed.objEnd);
    state.draftSource = next;
    return { ok: true, summary: `add_handler: "${name}" added, source now ${next.split('\n').length} lines. Run compile next.` };
  }

  private opRemoveHandler(state: LoopState, action: AgentAction): { ok: boolean; summary: string; error?: string } {
    const base = state.draftSource ?? state.targetSource;
    if (!base) return { ok: false, summary: 'remove_handler: no source', error: 'Nothing staged. Use draft_source or load_target first.' };
    const name = this.actionField(action, ['name', 'handler', 'method']) as string | undefined;
    if (!name) return { ok: false, summary: 'remove_handler: missing name', error: 'remove_handler requires {name}.' };
    const parsed = this.parseHandlerMembers(base);
    if (!parsed) return { ok: false, summary: 'remove_handler: unparseable', error: 'Could not locate the handler-map object literal. Use draft_diff or draft_source instead.' };
    const m = parsed.members.find(x => x.name === name);
    if (!m) return { ok: false, summary: `remove_handler: no "${name}"`, error: `No top-level member named "${name}". Available: ${parsed.members.map(x => x.name).join(', ')}.` };
    let s = m.start;
    let e = m.end;
    // Absorb one trailing comma, or (for the last member) the preceding comma.
    let k = e;
    while (k < parsed.objEnd && /\s/.test(base[k])) k++;
    if (base[k] === ',') {
      e = k + 1;
    } else {
      let p = s - 1;
      while (p > parsed.objStart && /\s/.test(base[p])) p--;
      if (base[p] === ',') s = p;
    }
    const next = base.slice(0, s) + base.slice(e);
    state.draftSource = next;
    return { ok: true, summary: `remove_handler: "${name}" removed, source now ${next.split('\n').length} lines. Run compile next.` };
  }

  /**
   * Adopt an existing object as the loop's modify target. Resolves a UUID or
   * registered name, loads its current source into `state.targetSource`, and
   * pivots the loop to a modify (so `draft_diff` has a base and `deploy_update`
   * has a target). This is how a loop that began as a create — because no
   * target was supplied at dispatch — recovers once it discovers (via ask /
   * describe / discover) that the goal is really about an existing Abject.
   * Idempotent: calling it again with the same target is a no-op refresh.
   */
  private async opLoadTarget(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    const nameOrId = this.actionField(action, ['objectId', 'target', 'targetName', 'objectName', 'name']) as string | undefined;
    if (typeof nameOrId !== 'string' || nameOrId.length === 0) {
      return { ok: false, summary: 'load_target: missing target', error: 'pass {objectId} or {targetName} naming the existing object to modify' };
    }
    const resolvedId = await this.resolveTarget(nameOrId);
    if (!resolvedId) {
      return {
        ok: false,
        summary: `load_target: not found: ${nameOrId}`,
        error: `Could not resolve target "${nameOrId}". Use call("Registry", "ask", {question: "is there an object that handles X?"}) or call("Registry", "discover", {name: "..."}) to find it first.`,
      };
    }

    let source: string | undefined;
    if (this.registryId) {
      try {
        const src = await this.sendRequest<string | null>(this.registryId, 'getSource', { objectId: resolvedId }, 5000);
        if (typeof src === 'string' && src.length > 0) source = src;
      } catch { /* best effort */ }
    }

    state.targetObjectId = resolvedId;
    state.targetName = nameOrId.includes('-') && nameOrId.length > 20 ? undefined : nameOrId;
    if (source !== undefined) state.targetSource = source;
    // Pivot the loop: from here this is a modification of an existing object.
    if (state.kind === 'create') state.kind = 'modify';

    const label = state.targetName ?? resolvedId.slice(0, 8);
    if (source === undefined) {
      return {
        ok: true,
        summary: `load_target: ${label} adopted as modify target (no source on file — fetch via call("Registry", "getSource") if needed, or draft fresh source)`,
      };
    }
    return {
      ok: true,
      summary: `load_target: ${label} adopted as modify target, ${source.split('\n').length} lines of source loaded (edit with draft_diff, deploy with deploy_update)`,
    };
  }

  /**
   * Ask an LLM to write the requested draft using the loop state as context.
   * Smart tier, 16k tokens. The instructions field gives the writer model
   * specific guidance (e.g. "make it idempotent", "preserve the existing
   * messageAdded handler").
   */
  private async opDraftViaLlm(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    if (!this.llmId) return { ok: false, summary: 'draft_via_llm: LLM unavailable', error: 'LLM not resolved' };
    const kind = this.actionField(action, ['kind', 'type']) as 'manifest' | 'source' | undefined;
    const instructions = (this.actionField(action, ['instructions', 'prompt', 'guidance']) as string | undefined) ?? '';
    if (kind !== 'manifest' && kind !== 'source') {
      return { ok: false, summary: 'draft_via_llm: kind must be manifest or source', error: 'kind missing or invalid' };
    }

    const sys = kind === 'manifest'
      ? this.draftManifestSystemPrompt()
      : this.draftSourceSystemPrompt();

    const user = this.buildDrafterUserPrompt(state, kind, instructions);

    let raw: string;
    try {
      const resp = await this.sendRequest<{ content: string }>(
        this.llmId,
        'complete',
        { messages: [systemMessage(sys), userMessage(user)] as LLMMessage[], options: { tier: 'code', maxTokens: 16384, cacheKey: state.goal.slice(0, 64) } },
        300000,
      );
      raw = resp.content ?? '';
    } catch (err) {
      return { ok: false, summary: 'draft_via_llm: LLM call failed', error: err instanceof Error ? err.message : String(err) };
    }

    if (kind === 'manifest') {
      const manifestMatch = raw.match(/```json\s*([\s\S]*?)```/);
      const jsonStr = manifestMatch ? manifestMatch[1].trim() : raw.trim();
      try {
        const parsed = JSON.parse(jsonStr) as { manifest?: AbjectManifest; usedObjects?: string[] };
        const manifest = parsed.manifest ?? (parsed as unknown as AbjectManifest);
        if (manifest && typeof manifest === 'object') normalizeDraftManifest(manifest);
        if (!manifest?.name || !manifest?.interface) {
          return { ok: false, summary: 'draft_via_llm manifest: malformed JSON', error: 'parsed JSON missing name or interface' };
        }
        state.draftManifest = manifest;
        if (Array.isArray(parsed.usedObjects)) {
          state.usedObjects = parsed.usedObjects.filter((x): x is string => typeof x === 'string');
        }
        return { ok: true, summary: `draft_via_llm manifest: ${manifest.name} (${(manifest.interface.methods ?? []).length} methods)` };
      } catch (err) {
        return { ok: false, summary: 'draft_via_llm manifest: parse error', error: err instanceof Error ? err.message : String(err) };
      }
    }

    // source kind
    const codeMatch = raw.match(/```(?:javascript|js)\s*([\s\S]*?)```/);
    const code = codeMatch ? codeMatch[1].trim() : raw.trim();
    if (!code) return { ok: false, summary: 'draft_via_llm source: empty', error: 'no code block in LLM response' };
    state.draftSource = code;
    return { ok: true, summary: `draft_via_llm source: ${code.split('\n').length} lines` };
  }

  /** Run ScriptableAbject.tryCompile against the staged source. */
  private opCompile(state: LoopState): { ok: boolean; summary: string; error?: string } {
    if (!state.draftSource) {
      return { ok: false, summary: 'compile: no source drafted', error: 'call draft_source, draft_diff, or draft_via_llm first' };
    }
    const err = ScriptableAbject.tryCompile(state.draftSource);
    state.lastValidation = { ...(state.lastValidation ?? {}), compile: err ?? '' };
    if (err) {
      return { ok: false, summary: `compile: ${err.slice(0, 120)}`, error: this.augmentCompileError(state.draftSource, err) };
    }
    return { ok: true, summary: 'compile: OK' };
  }

  /**
   * Augment a raw compile error with a precise location. JS engine messages
   * like "Unexpected token '}'" carry no position for sandboxed source, so we
   * re-parse with acorn to get the exact line/column of the syntax error and
   * show the surrounding lines. The original error is always preserved.
   */
  private augmentCompileError(source: string, err: string): string {
    const lines = source.split('\n');
    let detail = '';
    try {
      acorn.parse(source, { ecmaVersion: 'latest' });
      // acorn parsed cleanly — the vm failure is something other than syntax.
    } catch (e) {
      const loc = (e as { loc?: { line: number; column: number } }).loc;
      if (loc) {
        const ctxStart = Math.max(0, loc.line - 3);
        const ctxEnd = Math.min(lines.length, loc.line + 2);
        const ctx = lines.slice(ctxStart, ctxEnd)
          .map((l, k) => `  ${ctxStart + k + 1 === loc.line ? '>' : ' '} ${ctxStart + k + 1}: ${l}`)
          .join('\n');
        detail = `\n\nSyntax error near line ${loc.line}:${loc.column}:\n${ctx}`;
      }
    }
    detail += `\n\nSource is ${lines.length} lines. The failing line and its surrounding context are shown above; you already have the exact location, so do NOT use read_draft to find it again. Fix it in place: replace_handler to rewrite the single member that contains it, or draft_diff for a one-line change; or regenerate the whole object with draft_source. A syntax error at or near the last line is almost always an unbalanced brace/paren/bracket, so check the object literal's closing.`;
    return `${err}${detail}`;
  }

  /**
   * Static walker over the staged source. Extracts every `this.call(x, 'method', ...)`
   * site, resolves `x` to a name from `state.deps` via a tiny var-flow table per
   * handler, and checks `method` against that dep's manifest-declared methods.
   * Methods not in the manifest and not in FRAMEWORK_PROVIDED_METHODS are flagged.
   *
   * Generic over every Abject — the only ground truth is the live manifest.
   * Fails open on unresolvable expressions (better to miss a check than false-flag).
   */
  private opValidateCalls(state: LoopState): { ok: boolean; summary: string; error?: string; issues?: CallValidationError[] } {
    if (!state.draftSource) {
      return { ok: false, summary: 'validate_calls: no source drafted', error: 'call draft_source, draft_diff, or draft_via_llm first' };
    }

    const errors: CallValidationError[] = [];
    const source = state.draftSource;

    // Per-source var-flow scan. The handler-map syntax in our system is one
    // top-level object literal, so a single global pass is good enough; per-
    // handler scoping would only catch truly local re-bindings, which the
    // generated code doesn't tend to use.
    const varToDep = new Map<string, string>();
    const varDeclPattern =
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?this\.(?:dep|find)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let mv: RegExpExecArray | null;
    while ((mv = varDeclPattern.exec(source)) !== null) {
      varToDep.set(mv[1], mv[2]);
    }

    const inlineDepPattern =
      /^(?:await\s+)?this\.(?:dep|find)\s*\(\s*['"]([^'"]+)['"]\s*\)$/;
    const stringLiteralPattern = /^['"]([^'"]*)['"]$/;
    // A literal AbjectId (UUID) or scoped TypeId (peer/ws/Name) is a valid
    // recipient; a bare registered name is not — see name-string-recipient below.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const callPattern =
      /this\.call\s*\(\s*([^,]+?)\s*,\s*['"]([^'"]+)['"]\s*,/g;

    let mc: RegExpExecArray | null;
    while ((mc = callPattern.exec(source)) !== null) {
      const rawArg = mc[1].trim();
      const methodName = mc[2];

      let depName: string | undefined;
      const inline = rawArg.match(inlineDepPattern);
      if (inline) {
        depName = inline[1];
      } else if (/^\w+$/.test(rawArg)) {
        depName = varToDep.get(rawArg);
      } else {
        // Bare string literal as the recipient. `this.call(target, …)` routes
        // by AbjectId and the bus does NOT resolve names on the send path, so a
        // bare name like this.call("WidgetManager", …) is sent to a recipient
        // that never exists — the request gets no reply and times out. Resolve
        // it first via this.dep(name)/this.find(name). A literal UUID or scoped
        // TypeId (containing "/") is a real id, so allow those.
        const strLit = rawArg.match(stringLiteralPattern);
        if (strLit) {
          const literal = strLit[1];
          const isRoutableId = uuidPattern.test(literal) || literal.includes('/');
          if (literal.length > 0 && !isRoutableId) {
            const before = source.slice(0, mc.index);
            const line = before.split('\n').length;
            const snippet = source.slice(mc.index, Math.min(source.length, mc.index + mc[0].length + 30));
            errors.push({ kind: 'name-string-recipient', callSite: { line, snippet }, depName: literal, methodName });
          }
          continue;
        }
      }
      // this._field, function results, and complex expressions: skip silently.
      if (!depName) continue;

      // Framework-provided methods are valid on every Abject.
      if (FRAMEWORK_PROVIDED_METHODS.has(methodName)) continue;

      // Snippet + rough line number for the error.
      const before = source.slice(0, mc.index);
      const line = before.split('\n').length;
      const snippet = source.slice(mc.index, Math.min(source.length, mc.index + mc[0].length + 30));

      const dep = state.deps.get(depName);
      if (!dep) {
        errors.push({ kind: 'unknown-dep', callSite: { line, snippet }, depName, methodName });
        continue;
      }
      // Fail open when the dep's method surface was never introspected. A dep
      // learned via `ask` (prose usage guide) carries an empty methods map, so
      // an empty set means "unknown surface", not "no methods" — flagging every
      // call against it would false-flag legitimate, working calls (the exact
      // failure mode this validator's doc promises to avoid). Skip; the agent
      // can `describe` the dep to populate methods and get real checking.
      if (dep.methods.size === 0) continue;
      if (!dep.methods.has(methodName)) {
        errors.push({
          kind: 'unknown-method',
          callSite: { line, snippet },
          depName,
          methodName,
          availableMethods: [...dep.methods.keys()].sort(),
        });
      }
    }

    // Hardcoded AbjectId literals: a baked-in UUID is an ephemeral runtime id
    // that changes on every restart, so it is stale and unroutable next boot.
    // There is no legitimate reason for generated source to embed one — ids must
    // be resolved at runtime (dep/find/discover). Flag each distinct literal.
    const uuidLiteral = /['"]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]/gi;
    const seenIds = new Set<string>();
    let mu: RegExpExecArray | null;
    while ((mu = uuidLiteral.exec(source)) !== null) {
      const id = mu[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const before = source.slice(0, mu.index);
      const line = before.split('\n').length;
      const snippet = source.slice(mu.index, Math.min(source.length, mu.index + mu[0].length + 20));
      errors.push({ kind: 'hardcoded-id', callSite: { line, snippet }, depName: id });
    }

    state.lastValidation = { ...(state.lastValidation ?? {}), calls: errors };

    if (errors.length === 0) {
      return { ok: true, summary: 'validate_calls: 0 issues' };
    }

    const summary = `validate_calls: ${errors.length} issue${errors.length === 1 ? '' : 's'} — ` +
      errors.slice(0, 3).map(e => e.kind === 'hardcoded-id'
        ? `hardcoded id ${(e.depName ?? '').slice(0, 8)}…`
        : `${e.depName ?? '?'}.${e.methodName}`).join(', ') +
      (errors.length > 3 ? ', …' : '');
    return { ok: false, summary, issues: errors, error: this.formatCallErrors(errors) };
  }

  /**
   * LLM semantic review against the staged drafts. Reads manifests + usage
   * guides + drafts; returns VERIFIED or a structured issue list with optional
   * follow-up questions for specific deps. Balanced tier, 4k tokens.
   */
  private async opReviewSemantics(state: LoopState): Promise<{ ok: boolean; summary: string; error?: string; data?: string; result?: SemanticReviewResult }> {
    if (!state.draftSource) {
      return { ok: false, summary: 'review_semantics: no source drafted', error: 'call draft_source, draft_diff, or draft_via_llm first' };
    }
    if (!this.llmId) return { ok: false, summary: 'review_semantics: LLM unavailable', error: 'LLM not resolved' };

    const sys = this.semanticReviewerSystemPrompt();
    const user = this.buildReviewerUserPrompt(state);

    let raw: string;
    try {
      const resp = await this.sendRequest<{ content: string }>(
        this.llmId,
        'complete',
        { messages: [systemMessage(sys), userMessage(user)] as LLMMessage[], options: { tier: 'balanced', maxTokens: 4096 } },
        120000,
      );
      raw = (resp.content ?? '').trim();
    } catch (err) {
      return { ok: false, summary: 'review_semantics: LLM call failed', error: err instanceof Error ? err.message : String(err) };
    }

    let result: SemanticReviewResult;
    if (/^VERIFIED\b/.test(raw)) {
      result = { verified: true, issues: [], questions: [] };
    } else {
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : raw;
      try {
        const parsed = JSON.parse(jsonStr) as { issues?: SemanticReviewResult['issues']; questions?: SemanticReviewResult['questions'] };
        const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
        const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
        const hasError = issues.some(i => i.severity === 'error');
        result = { verified: !hasError, issues, questions };
      } catch {
        // Reviewer malfunction — treat as VERIFIED so we don't block the loop.
        log.warn('review_semantics: unparseable reviewer output, treating as VERIFIED');
        result = { verified: true, issues: [], questions: [] };
      }
    }

    state.lastValidation = { ...(state.lastValidation ?? {}), semantics: result };
    const errs = result.issues.filter(i => i.severity === 'error').length;
    const warns = result.issues.filter(i => i.severity === 'warning').length;
    const summary = result.verified
      ? `review_semantics: VERIFIED${warns > 0 ? ` (${warns} advisory warning${warns === 1 ? '' : 's'})` : ''}`
      : `review_semantics: ${errs} error${errs === 1 ? '' : 's'}, ${result.questions.length} question${result.questions.length === 1 ? '' : 's'}`;
    // Warnings on a verified draft are advisory: the action SUCCEEDS (so a
    // batched deploy behind it still runs) and the findings ride along as
    // data for the agent to weigh — fix the cheap ones, ship, note the rest.
    const advisory = result.verified && warns > 0
      ? `Advisory findings (verified — deploy proceeds; address these where cheap, otherwise note them in your report):\n${this.formatSemanticIssues(result)}`
      : undefined;
    return { ok: result.verified, summary, result, data: advisory, error: result.verified ? undefined : this.formatSemanticIssues(result) };
  }

  /**
   * Deploy a CREATE: read the staged manifest + source from the loop state
   * and send Factory.spawn server-side. Still pure message passing — this
   * dispatches `request(this.id, factoryId, 'spawn', payload)` — but the
   * LLM emits a no-payload action so it doesn't have to inline kilobytes of
   * source or supply `owner` / `parentId` (which it can't know).
   */
  private async opDeploySpawn(state: LoopState): Promise<{ ok: boolean; summary: string; error?: string; data?: unknown }> {
    if (!this.factoryId) return { ok: false, summary: 'deploy_spawn: Factory unavailable', error: 'Factory not resolved' };
    if (!state.draftManifest) return { ok: false, summary: 'deploy_spawn: no manifest drafted', error: 'call draft_manifest or draft_via_llm({kind: "manifest"}) first' };
    if (!state.draftSource) return { ok: false, summary: 'deploy_spawn: no source drafted', error: 'call draft_source, draft_diff, or draft_via_llm({kind: "source"}) first' };

    const spawnReq: SpawnRequest = {
      manifest: state.draftManifest,
      source: state.draftSource,
      owner: this.id,
      parentId: this.id,
      registryHint: this.registryId,
    };

    let result: SpawnResult;
    try {
      result = await this.sendRequest<SpawnResult>(this.factoryId, 'spawn', spawnReq, 120000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `deploy_spawn: ${msg.slice(0, 120)}`, error: msg };
    }

    if (!result?.objectId) {
      return { ok: false, summary: 'deploy_spawn: Factory returned no objectId', error: 'unexpected Factory response' };
    }

    state.spawnedObjectId = result.objectId;

    // Persist to AbjectStore so the spawned object survives a restart.
    // Use request+catch so save failures show up in logs instead of vanishing.
    if (this.abjectStoreId) {
      this.sendRequest<unknown>(
        this.abjectStoreId,
        'save',
        {
          objectId: result.objectId,
          manifest: state.draftManifest,
          source: state.draftSource,
          owner: this.id,
        },
        15000,
      ).catch(err => log.warn('deploy_spawn: AbjectStore.save failed:', err instanceof Error ? err.message : String(err)));
    }

    state.lastDeployedSource = state.draftSource;

    // Detect a live name collision. Registry uniquifies duplicate registration
    // names (Name → Name-2), so discover({name}) keeps resolving to the
    // PRE-EXISTING holder — verification calls routed by name would exercise
    // the old instance and report false positives (e.g. show() → 'Already
    // open'). Record it so opCall pins name calls to the new instance and the
    // observation tells the agent to resolve the duplicate.
    for (const registryId of [this.registryId, this.systemRegistryId]) {
      if (!registryId) continue;
      try {
        const hits = await this.sendRequest<ObjectRegistration[]>(
          registryId, 'discover', { name: state.draftManifest.name }, 10000);
        const other = (hits ?? []).find(h => h.id !== result.objectId);
        if (other) { state.nameCollisionId = other.id; break; }
      } catch { /* best effort */ }
    }

    const collisionNote = state.nameCollisionId
      ? ` — WARNING: another live object already holds the name "${state.draftManifest.name}" (${state.nameCollisionId}). Name-based calls resolve to THAT older object; your own calls to "${state.draftManifest.name}" are auto-routed to the new instance. Decide what to do about the duplicate: usually the older object should have been modified instead of spawning a twin, or it should be destroyed.`
      : '';

    return {
      ok: true,
      summary: `deploy_spawn: ${state.draftManifest.name} spawned as ${result.objectId}${collisionNote}`,
      data: { objectId: result.objectId, manifest: state.draftManifest },
    };
  }

  /**
   * Deploy a MODIFY: read the staged source from the loop state and run the
   * full hot-swap sequence — message the live object's `updateSource` (which
   * triggers hide → applySource → show), then update the Registry's cached
   * source and manifest, then persist via AbjectStore. Same shape the old
   * pipeline used; still pure message passing through the bus.
   *
   * The target can be specified three ways, in order of precedence:
   *   1. `action.objectId` — explicit UUID in the action payload.
   *   2. `action.targetName` — registered name in the action payload.
   *   3. `state.targetObjectId` — set when the task was started as a modify.
   *
   * (3) lets the natural modify flow work without ceremony. (1)/(2) let the
   * agent pivot mid-loop when Chat dispatched the task as a `kind: create`
   * but the goal turned out to be a modify of an existing object.
   */
  private async opDeployUpdate(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string; data?: unknown }> {
    if (!this.registryId) return { ok: false, summary: 'deploy_update: Registry unavailable', error: 'Registry not resolved' };
    if (!state.draftSource) return { ok: false, summary: 'deploy_update: no source drafted', error: 'call draft_source, draft_diff, or draft_via_llm({kind: "source"}) first' };

    // Resolve target: explicit objectId / targetName from action wins, else
    // fall back to the kind:modify state target.
    let targetId: AbjectId | undefined;
    let targetLabel: string | undefined;
    const explicitId = this.actionField(action, ['objectId']);
    const explicitName = this.actionField(action, ['targetName', 'targetObjectName', 'target']);
    if (typeof explicitId === 'string' && explicitId.length > 0) {
      const resolved = await this.resolveTarget(explicitId);
      if (!resolved) return { ok: false, summary: `deploy_update: target not found: ${explicitId}`, error: `Could not resolve target "${explicitId}"` };
      targetId = resolved;
      targetLabel = explicitId.includes('-') && explicitId.length > 20 ? undefined : explicitId;
    } else if (typeof explicitName === 'string' && explicitName.length > 0) {
      const resolved = await this.resolveTarget(explicitName);
      if (!resolved) return { ok: false, summary: `deploy_update: target not found: ${explicitName}`, error: `Could not resolve target "${explicitName}"` };
      targetId = resolved;
      targetLabel = explicitName;
    } else if (state.targetObjectId) {
      targetId = state.targetObjectId;
      targetLabel = state.targetName;
    } else {
      return { ok: false, summary: 'deploy_update: no target', error: 'pass {objectId} or {targetName} in the action payload, or use deploy_spawn for new objects' };
    }

    // 1. Hot-swap on the live ScriptableAbject.
    try {
      const updateRes = await this.sendRequest<{ success: boolean; error?: string }>(
        targetId,
        'updateSource',
        { source: state.draftSource },
        60000,
      );
      if (updateRes && updateRes.success === false) {
        return { ok: false, summary: 'deploy_update: live updateSource refused', error: updateRes.error ?? 'updateSource returned success=false' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `deploy_update: live updateSource failed: ${msg.slice(0, 120)}`, error: msg };
    }

    // 2. Update Registry's cached source.
    try {
      await this.sendRequest<unknown>(this.registryId, 'updateSource', {
        objectId: targetId,
        source: state.draftSource,
      }, 30000);
    } catch (err) {
      log.warn('deploy_update: Registry.updateSource failed:', err instanceof Error ? err.message : String(err));
      // Non-fatal — the live object already swapped.
    }

    // 3. If we have a manifest draft, update Registry's cached manifest too.
    if (state.draftManifest) {
      try {
        await this.sendRequest<unknown>(this.registryId, 'updateManifest', {
          objectId: targetId,
          manifest: state.draftManifest,
        }, 30000);
      } catch (err) {
        log.warn('deploy_update: Registry.updateManifest failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // 4. Persist to AbjectStore so the modification survives a restart.
    //    Without this step the live update + Registry caches are in-memory
    //    only; on next launch AbjectStore.restoreAll replays the OLD
    //    snapshot and silently rolls back the change.
    //
    //    Two subtleties:
    //    - AbjectStore.saveSnapshot dereferences `manifest.name`, so a
    //      missing manifest crashes the handler. Source-only modifies leave
    //      state.draftManifest undefined; in that case look up the current
    //      manifest from Registry and persist with it unchanged.
    //    - The old code used `this.request(...).catch(log)` (not `this.send`)
    //      so save failures are visible. Match that.
    if (this.abjectStoreId) {
      let manifestForPersist = state.draftManifest;
      if (!manifestForPersist && this.registryId) {
        try {
          const reg = await this.sendRequest<{ manifest: AbjectManifest } | null>(
            this.registryId,
            'lookup',
            { objectId: targetId },
            10000,
          );
          if (reg?.manifest) manifestForPersist = reg.manifest;
        } catch (err) {
          log.warn('deploy_update: Registry.lookup for persist failed:', err instanceof Error ? err.message : String(err));
        }
      }
      if (manifestForPersist) {
        this.sendRequest<unknown>(
          this.abjectStoreId,
          'save',
          {
            objectId: targetId,
            manifest: manifestForPersist,
            source: state.draftSource,
            owner: this.id,
          },
          15000,
        ).catch(err => log.warn('deploy_update: AbjectStore.save failed:', err instanceof Error ? err.message : String(err)));
      } else {
        log.warn(`deploy_update: no manifest available for AbjectStore.save (targetId=${targetId.slice(0, 8)}); modification will not survive restart`);
      }
    }

    state.deployedViaUpdateSource = true;
    state.lastDeployedSource = state.draftSource;
    state.targetObjectId = targetId; // Stamp so finalizeLoop emits objectModified correctly.
    if (targetLabel && !state.targetName) state.targetName = targetLabel;

    return {
      ok: true,
      summary: `deploy_update: ${targetLabel ?? targetId} updated (${state.draftSource.split('\n').length} lines)`,
      data: { objectId: targetId },
    };
  }

  /**
   * Compose existing source-backed objects into one Organism. Each named
   * object's manifest and source are captured from its registration and become
   * an organelle spec; the staged drafts (draft_manifest for the public
   * surface, draft_source or the explicit interfaceSource for the forwarding
   * handler map) become the membrane interface organelle; the whole spec
   * deploys through Factory.spawn with the organism tag. When no membrane is
   * staged, both parts are drafted via the existing LLM draft machinery with
   * the organelle manifests as context. The free-living originals keep
   * running: composition copies them, so the organism's organelles diverge
   * from their ancestors independently (endosymbiosis by copy, never capture).
   */
  private async opComposeOrganism(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string; data?: unknown }> {
    if (!this.factoryId) return { ok: false, summary: 'compose_organism: Factory unavailable', error: 'Factory not resolved' };
    if (!this.registryId) return { ok: false, summary: 'compose_organism: Registry unavailable', error: 'Registry not resolved' };

    const name = this.actionField(action, ['name']) as string | undefined;
    const description = this.actionField(action, ['description']) as string | undefined;
    const organelleNames = this.actionField(action, ['organelleNames', 'organelles']) as string[] | undefined;
    const interfaceSource = this.actionField(action, ['interfaceSource']) as string | undefined;

    if (!name || !description) {
      return { ok: false, summary: 'compose_organism: missing name/description', error: 'pass {name, description, organelleNames: ["A", "B"]}' };
    }
    if (!Array.isArray(organelleNames) || organelleNames.length === 0 || !organelleNames.every(n => typeof n === 'string' && n.length > 0)) {
      return { ok: false, summary: 'compose_organism: no organelles', error: 'organelleNames must be a non-empty array of registered object names' };
    }

    // 1. Capture each organelle's manifest + source from its registration.
    const organelles: OrganelleSpec[] = [];
    for (const oName of organelleNames) {
      const id = await this.resolveTarget(oName);
      if (!id) {
        return {
          ok: false,
          summary: `compose_organism: not found: ${oName}`,
          error: `"${oName}" is not a registered object. Find the exact name first via call("Registry", "discover", {name: "..."}) or call("Registry", "ask", {question: "..."}).`,
        };
      }
      let reg: ObjectRegistration | null = null;
      try {
        reg = await this.sendRequest<ObjectRegistration | null>(this.registryId, 'lookup', { objectId: id }, 10000);
      } catch { /* handled below */ }
      if (!reg?.source) {
        return {
          ok: false,
          summary: `compose_organism: no source: ${oName}`,
          error: `"${oName}" has no source on file. Only source-backed objects (ScriptableAbjects) can become organelles. System objects stay outside the membrane; organelles reach them through the organism's registry fallback.`,
        };
      }
      organelles.push({ name: oName, manifest: reg.manifest, source: reg.source });
    }

    // 2. Membrane interface. Staged drafts win; an explicit interfaceSource
    //    overrides the staged source; anything missing is drafted via LLM with
    //    the organelle surfaces as context.
    const organelleContext = organelles
      .map(o => `- ${o.name}: ${o.manifest.description}; methods: ${(o.manifest.interface.methods ?? []).map(m => m.name).join(', ') || '(none declared)'}`)
      .join('\n');
    if (!state.draftManifest) {
      const r = await this.opDraftViaLlm(state, {
        action: 'draft_via_llm',
        kind: 'manifest',
        instructions:
          `Manifest for "${name}": ${description}. This is the PUBLIC face of an organism (a composite object). ` +
          `Declare a small curated interface covering the use cases; implementation is forwarded to these internal organelles ` +
          `(reachable by name through the organism's internal registry):\n${organelleContext}`,
      } as AgentAction);
      if (!r.ok) return { ok: false, summary: 'compose_organism: membrane manifest draft failed', error: r.error };
    }
    if (interfaceSource) {
      state.draftSource = interfaceSource;
    } else if (!state.draftSource) {
      const publicMethods = (state.draftManifest!.interface.methods ?? []).map(m => m.name).join(', ');
      const r = await this.opDraftViaLlm(state, {
        action: 'draft_via_llm',
        kind: 'source',
        instructions:
          `Handler map for the membrane interface organelle of organism "${name}". ` +
          `Implement each public method (${publicMethods}) as a thin forwarder to the right internal organelle: ` +
          `await this.call(await this.dep('<OrganelleName>'), '<method>', msg.payload). ` +
          `Organelles (discoverable by these exact names through the internal registry):\n${organelleContext}\n` +
          `Keep contracts (this.ensure) at handler entry; keep domain logic in the organelles.`,
      } as AgentAction);
      if (!r.ok) return { ok: false, summary: 'compose_organism: membrane source draft failed', error: r.error };
    }

    const membraneSource = state.draftSource!;
    const compileErr = ScriptableAbject.tryCompile(membraneSource);
    if (compileErr) {
      return {
        ok: false,
        summary: `compose_organism: membrane source does not compile: ${compileErr.slice(0, 100)}`,
        error: `Fix the staged source (replace_handler / draft_diff / draft_source), run compile, then rerun compose_organism. Error: ${compileErr}`,
      };
    }

    // 3. Assemble the spec and deploy through Factory (organism tag + JSON
    //    OrganismSpec source is the established organism spawn path).
    const spec: OrganismSpec = {
      name,
      description,
      interface: { name: `${name}Interface`, manifest: state.draftManifest!, source: membraneSource },
      organelles,
      tags: ['organism'],
    };
    const organismSource = JSON.stringify(spec);
    const manifest = buildOrganismManifest(spec);
    const spawnReq: SpawnRequest = {
      manifest,
      source: organismSource,
      owner: this.id,
      parentId: this.id,
      registryHint: this.registryId,
    };

    let result: SpawnResult;
    try {
      result = await this.sendRequest<SpawnResult>(this.factoryId, 'spawn', spawnReq, 120000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `compose_organism: spawn failed: ${msg.slice(0, 120)}`, error: msg };
    }
    if (!result?.objectId) {
      return { ok: false, summary: 'compose_organism: Factory returned no objectId', error: 'unexpected Factory response' };
    }

    state.spawnedObjectId = result.objectId;
    // The staged membrane drafts are now live inside the organism.
    state.lastDeployedSource = state.draftSource;

    // Persist so the organism survives a restart (same path deploy_spawn uses;
    // Factory re-detects the organism tag + JSON spec on restore).
    if (this.abjectStoreId) {
      this.sendRequest<unknown>(
        this.abjectStoreId,
        'save',
        { objectId: result.objectId, manifest, source: organismSource, owner: this.id },
        15000,
      ).catch(err => log.warn('compose_organism: AbjectStore.save failed:', err instanceof Error ? err.message : String(err)));
    }

    return {
      ok: true,
      summary: `compose_organism: ${name} spawned as ${result.objectId} with organelles [${organelleNames.join(', ')}] (originals keep running)`,
      data: { objectId: result.objectId, name, organelles: organelleNames },
    };
  }

  /**
   * Extract one organelle from an organism and deploy it as a standalone
   * ScriptableAbject, carrying a snapshot of its live data. The organism is
   * read, never modified: its internal copy keeps running.
   */
  private async opExtractOrganelle(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string; data?: unknown }> {
    if (!this.factoryId) return { ok: false, summary: 'extract_organelle: Factory unavailable', error: 'Factory not resolved' };

    const targetRef = this.actionField(action, ['target', 'objectId', 'organismName', 'targetName']) as string | undefined;
    const organelleName = this.actionField(action, ['organelleName', 'name']) as string | undefined;
    if (!targetRef || !organelleName) {
      return { ok: false, summary: 'extract_organelle: missing args', error: 'pass {target: "<organism name or id>", organelleName: "<name>"}' };
    }

    const organismId = await this.resolveTarget(targetRef);
    if (!organismId) {
      return { ok: false, summary: `extract_organelle: organism not found: ${targetRef}`, error: `Could not resolve "${targetRef}". Discover it via call("Registry", "discover", {name: "..."}).` };
    }

    let payload: { manifest: AbjectManifest; source: string; data?: Record<string, unknown> };
    try {
      payload = await this.sendRequest<{ manifest: AbjectManifest; source: string; data?: Record<string, unknown> }>(
        organismId, 'getOrganelleSource', { name: organelleName }, 15000,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `extract_organelle: ${msg.slice(0, 120)}`, error: msg };
    }

    const spawnReq: SpawnRequest = {
      manifest: payload.manifest,
      source: payload.source,
      data: payload.data,
      owner: this.id,
      parentId: this.id,
      registryHint: this.registryId,
    };
    let result: SpawnResult;
    try {
      result = await this.sendRequest<SpawnResult>(this.factoryId, 'spawn', spawnReq, 120000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: `extract_organelle: spawn failed: ${msg.slice(0, 120)}`, error: msg };
    }
    if (!result?.objectId) {
      return { ok: false, summary: 'extract_organelle: Factory returned no objectId', error: 'unexpected Factory response' };
    }

    state.spawnedObjectId = result.objectId;

    if (this.abjectStoreId) {
      this.sendRequest<unknown>(
        this.abjectStoreId,
        'save',
        { objectId: result.objectId, manifest: payload.manifest, source: payload.source, owner: this.id },
        15000,
      ).catch(err => log.warn('extract_organelle: AbjectStore.save failed:', err instanceof Error ? err.message : String(err)));
    }

    return {
      ok: true,
      summary: `extract_organelle: ${organelleName} extracted from ${targetRef} as standalone ${result.objectId} (the organism keeps its internal copy)`,
      data: { objectId: result.objectId, organelleName },
    };
  }

  /** Send an intermediate user-visible chat bubble. Loop continues. */
  private async opReply(_state: LoopState, action: AgentAction, callerId?: AbjectId): Promise<{ ok: boolean; summary: string }> {
    const text = (this.actionField(action, ['text', 'message', 'content']) as string | undefined) ?? '';
    if (callerId && callerId !== this.id && text) {
      this.send(event(this.id, callerId, 'agentIntermediateAction', {
        action: { action: 'reply', text },
      }));
    }
    return { ok: true, summary: `reply: ${text.slice(0, 120).replace(/\n+/g, ' ')}${text.length > 120 ? '…' : ''}` };
  }

  /**
   * Surface a clarifying question. We can't pause the AgentAbject loop from
   * inside agentAct, so we post the question as an intermediate reply and
   * let the user respond via the standard Chat re-dispatch. The agent should
   * then call `done` after recording the question — the user's reply spawns
   * a new task with the answer in the prompt.
   */
  private async opAskUser(_state: LoopState, action: AgentAction, callerId?: AbjectId): Promise<{ ok: boolean; summary: string }> {
    const question = (this.actionField(action, ['question', 'text', 'message']) as string | undefined) ?? '';
    if (callerId && callerId !== this.id && question) {
      this.send(event(this.id, callerId, 'agentIntermediateAction', {
        action: { action: 'reply', text: question },
      }));
    }
    return { ok: true, summary: `ask_user: ${question.slice(0, 120).replace(/\n+/g, ' ')}${question.length > 120 ? '…' : ''}` };
  }

  // ── Drafter / reviewer prompt helpers ─────────────────────────────────

  private draftManifestSystemPrompt(): string {
    return [
      'You are drafting an AbjectManifest in JSON. Output ONE ```json code block, nothing else.',
      'Required shape: { manifest: { name, description, version, icon, interface: { id, name, description, methods, events? }, requiredCapabilities: [], providedCapabilities: [], tags: [] }, usedObjects: string[] }.',
      'Each method has { name, description, parameters: [{ name, type: { kind: "primitive"|"reference"|"array"|"object", … }, description, optional? }], returns }.',
      'Set `icon` to a single emoji that best represents the object, shown next to its name in launchers (e.g. weather → 🌤, notes → 📝, a game → 🎮, a chart → 📊). Pick something distinctive and relevant.',
      'Use the provided usage guides verbatim — do not invent method names on dependencies.',
      'Name interface methods for the user-facing use cases they perform (the DCI contexts) rather than generic CRUD. When the object is the model half of a Model-View split, keep its interface to domain operations and a getState/changed surface, with no window/show/draw methods on a model.',
    ].join('\n');
  }

  private draftSourceSystemPrompt(): string {
    return [
      'You are drafting handler-map JavaScript for a ScriptableAbject. Output ONE ```javascript code block.',
      'Format: a single parenthesized object literal: ({ method(msg) { ... }, ... }).',
      'Each handler takes a single `msg` argument; payload is `msg.payload`. Inter-object work is `await this.call(target, method, payload)` where `target` is a RESOLVED AbjectId.',
      // Execution environment — the single most common source of dead code.
      'RUNTIME: handler code runs in a sandboxed backend (a Node vm inside a worker thread), NOT in a browser. There is NO `window`, `document`, `navigator`, `localStorage`, `fetch`, `WebSocket`, `AudioContext`, `Image`, DOM, or `setTimeout`/`setInterval` as globals. The only ambient globals are `Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp` plus your `this.*` helpers (`this.call`, `this.dep`, `this.data`, `this.changed`, `this.ensure`, `this.invariant`). Reaching for a browser API silently does nothing (or is caught and dropped), so the feature never runs — do not write it.',
      'Every capability a browser would give you — sound, speech, HTTP, persistence, files, timers/scheduling, clipboard, drawing — is instead provided by some other Abject you reach by message. You do not know their names a priori: discover the right object and how to drive it through the ask/discover protocol (`call("Registry", "discover", { ... })` to find it, `call("<object>", "ask", { question })` to learn its methods and read its usage guide), then `await this.call(id, method, payload)`. When a goal needs a capability, discover its provider first rather than assuming a browser API exists or hardcoding an object name.',
      'In generated handler code, `this.call(target, …)` routes by AbjectId only — the bus does NOT resolve names on the send path. Resolve a dependency to its id first: `const id = await this.dep("Name")` (or `this.find("Name")`), then `await this.call(id, method, payload)` — or inline `await this.call(this.dep("Name"), method, payload)`. NEVER pass a bare name string as the recipient (e.g. `this.call("WidgetManager", …)`); that call is delivered nowhere and times out. (This differs from the ObjectCreator `call` ACTION you use to investigate, which DOES accept a bare name — generated code does not.) Ids returned at runtime (window/canvas/layout ids from create*) are already resolved; pass them directly.',
      'Build windows/canvas from an async handler and AWAIT each step in order. Awaiting an inter-object call inside your own handler is correct and does NOT deadlock — the reply is delivered while the handler is suspended. A build that times out means a wrong recipient or a missing await, never the awaiting itself; do not detach the build into a fire-and-forget chain to "avoid a deadlock". Ask the window/canvas factory for its build recipe before drafting.',
      'Use ONLY methods listed in the provided dependency manifests / usage guides. Do not invent method names.',
      'Method names that are not in the framework or in a dependency\'s manifest do not exist — pick a real one or restructure.',
      'When a dependency\'s usage guide documents a higher-level building block that fits the need, compose it rather than re-implementing equivalent behavior from low-level primitives. Reuse the building blocks; drop to primitives only for what the building blocks do not cover.',
      'Prefer composing high-level building blocks over hand-writing equivalents — e.g. render markdown with a markdown-capable label/widget rather than writing your own parser and text-layout engine on a canvas. This keeps the object small and the formatting correct.',
      'Keep each object focused. When a single object would grow very large (many hundreds of lines) or bundles a reusable sub-capability (a parser, a layout engine, a data store), split that capability into its own Abject and call it. Smaller, composed objects are easier to verify and keep the build loop fast (a huge source blows the context budget and makes the loop lose track of what it already tried).',
      // Architecture for objects with a UI: Model-View (Smalltalk sense), DCI, Design by Contract.
      'Structure any object that has a UI as Model and View, in the original Smalltalk sense.',
      'MODEL: this.data holds the domain document (the plain data the object IS), and pure helper methods hold the domain rules (validate input, compute results, apply a change to this.data). The model never draws and never references a window, canvas, or widget. Keep transient/view state (window/canvas/layout ids, hover, scroll, cursor, drag, animation clocks) in this._ instance fields, out of this.data.',
      'VIEW: one render method (e.g. _draw / _render) DISPLAYS the model, and the input/event handlers HANDLE the user\'s interaction with that display. In this sense the view both shows the model and handles interaction; input handling belongs to the view, not to a separate controller. On an interaction, apply the change through a model helper, then re-render. The view carries no domain rules of its own.',
      'CONTROLLER (only when there is more than one view or mode): a controller selects the KIND of view of the model (which view/mode is shown, switching modes, coordinating multiple views over one model). It is NOT the input path; that is the view\'s job. A single-view object needs no controller, so do not invent one.',
      'Keep the flow one-directional: interaction in the view leads to a model helper mutating this.data, then a re-display. For any other view or observer, the model announces a change with this.changed(aspect, value); the model never calls into a view.',
      'DCI: name each user-facing use case as the handler that performs that scenario (the context), and express behavior as small role helpers (what the object DOES), while this.data stays plain data (what the object IS). Prefer scenario names over generic CRUD.',
      'Design by Contract on every public handler: open with a precondition using this.ensure(condition, message) (the caller\'s obligation); guarantee a result with a postcondition this.ensure(...) before returning; keep object-state invariants in a _checkInvariants() helper that uses this.invariant(condition, message), and call _checkInvariants() after each mutation. this.ensure and this.invariant are provided and throw a clear ContractViolation when the condition is false. Use these, because the sandbox forbids the require() token.',
      'Make UI look designed, not like a debug view. Before drawing a window/canvas UI, ask the rendering object (the window/canvas factory) "how do I make this look good?" to get its design guide, and use theme colors so the app is cohesive with the user\'s desktop — for canvas draws this means theme tokens like fill: "$accent" / "$textPrimary" / "$windowBg" rather than hardcoded hex. Reserve hand-picked colors for genuine illustration the theme can\'t express.',
    ].join('\n');
  }

  private semanticReviewerSystemPrompt(): string {
    return [
      'You are a strict code reviewer for an Abject handler map. You receive: the new object\'s manifest, the drafted source, and for each known dependency its manifest methods + usage guide.',
      'Flag SEMANTIC issues that a static method-name check cannot catch: wrong payload shape, enum-like string values not listed in the usage guide (including MCP toolName values), missing await on consumed results, event handler name / payload shape mismatches, cached dep IDs in state.',
      'For objects with a UI, also flag STRUCTURAL issues against Model-View (Smalltalk sense) plus Design by Contract: domain rules living in the render/view code instead of the model; the model drawing or referencing a window/canvas/widget; this.data holding transient view state (window/canvas/layout ids, hover, scroll, animation) that belongs in this._ fields; input handling pulled out of the view into a separate "controller" (in this architecture the view handles interaction, and a controller only selects the kind of view of the model); public handlers with no precondition this.ensure(...) check; mutations with no _checkInvariants() / this.invariant(...) follow-up. Note: a view that drives model changes from its input handlers is CORRECT, so do not flag that.',
      'SEVERITY CALIBRATION — this decides whether a deploy proceeds, so apply it exactly:',
      '- "error" is reserved for code that will MISBEHAVE AT RUNTIME: a payload shape or method/enum value the usage guide contradicts, a missing await whose result is consumed, an event name/shape mismatch, or logic that defeats the stated requirements (e.g. physics constants that make a game unplayable).',
      '- Structural and craftsmanship findings — Model-View layering, Design by Contract coverage (this.ensure preconditions, _checkInvariants follow-ups), naming, style — are ALWAYS "warning". They are guidance toward a well-crafted object, never grounds to hold a runtime-correct draft back from deploying.',
      'Trust the usage guide. If a value is not listed there, it is wrong — regardless of how reasonable it looks.',
      'Guide precedence: the dependency that OWNS a call is authoritative for that call. A factory\'s guide also governs the objects it creates (e.g. a window/canvas id returned at runtime — methods documented in the factory\'s guide for those ids are valid). Catalog or registry summaries of OTHER objects are weaker evidence: a registry answer saying "no object has X" does not override a first-party guide that documents X on itself or on the objects it creates.',
      '',
      'Output ONE of:',
      '- The literal string VERIFIED (nothing else) when the drafts are correct.',
      '- A single ```json code block matching:',
      '  {',
      '    "issues": [{ "severity": "error" | "warning", "message": "...", "callSite": "snippet" }],',
      '    "questions": [{ "dep": "DependencyName", "question": "specific ask-protocol question" }]',
      '  }',
      'Only include questions whose answers will change your decision.',
    ].join('\n');
  }

  private buildDrafterUserPrompt(state: LoopState, kind: 'manifest' | 'source', instructions: string): string {
    const lines: string[] = [];
    lines.push(`Goal: ${state.goal.slice(0, 1200)}`);
    lines.push(`Kind: ${state.kind}`);
    if (state.targetName || state.targetObjectId) {
      lines.push(`Target: ${state.targetName ?? state.targetObjectId ?? '?'}`);
    }
    if (state.targetSource && kind === 'source') {
      lines.push(`Existing source (preserve working logic, change only what the goal requires):`);
      lines.push('```javascript');
      lines.push(state.targetSource);
      lines.push('```');
    }
    if (state.draftManifest && kind === 'source') {
      lines.push('Manifest to implement:');
      lines.push('```json');
      lines.push(JSON.stringify(state.draftManifest, null, 2));
      lines.push('```');
    }
    lines.push('');
    lines.push('Available dependencies (authoritative — method names below are the ONLY valid names):');
    lines.push('The same goes for string enums INSIDE payloads (widget/type names, kinds, modes): use exactly the vocabulary the dependency\'s guide documents. Do not substitute names remembered from other toolkits — an unknown enum value fails at runtime, often mid-build, and is not caught by validators.');
    lines.push(this.formatStructuredDeps(state.deps));
    if (instructions) {
      lines.push('');
      lines.push(`Specific instructions: ${instructions}`);
    }
    return lines.join('\n');
  }

  private buildReviewerUserPrompt(state: LoopState): string {
    const lines: string[] = [];
    lines.push(`Goal: ${state.goal.slice(0, 800)}`);
    if (state.draftManifest) {
      lines.push('Manifest:');
      lines.push('```json');
      lines.push(JSON.stringify(state.draftManifest, null, 2));
      lines.push('```');
    }
    lines.push('Source draft:');
    lines.push('```javascript');
    lines.push(state.draftSource ?? '');
    lines.push('```');
    lines.push('');
    lines.push('Known dependencies:');
    lines.push(this.formatStructuredDeps(state.deps));
    return lines.join('\n');
  }

  private formatStructuredDeps(deps: Map<string, DepMethodIndex>): string {
    if (deps.size === 0) return '(none discovered yet)';
    const sections: string[] = [];
    for (const dep of deps.values()) {
      const lines: string[] = [];
      lines.push(`### ${dep.depName}`);
      if (dep.methods.size > 0) {
        lines.push('Methods:');
        for (const m of dep.methods.values()) {
          const params = m.params.map(p => `${p.name}${p.optional ? '?' : ''}${p.typeHint ? `: ${p.typeHint}` : ''}`).join(', ');
          const ret = m.returns ? ` -> ${m.returns}` : '';
          lines.push(`  - ${m.name}(${params})${ret}`);
        }
      }
      if (dep.events.size > 0) {
        lines.push(`Events: ${[...dep.events].join(', ')}`);
      }
      if (dep.usageGuide) {
        lines.push('Usage guide:');
        lines.push(dep.usageGuide.slice(0, 1600));
      }
      sections.push(lines.join('\n'));
    }
    return sections.join('\n\n---\n\n');
  }

  private formatCallErrors(errors: CallValidationError[]): string {
    // One dependency used at many call sites produces many identical flags;
    // collapse them so the LLM sees "(N call sites)" instead of N copies.
    const counts = new Map<string, number>();
    for (const e of errors) {
      let line: string;
      if (e.kind === 'unknown-method') {
        line = `- ${e.depName}.${e.methodName} is not a method. Available: ${(e.availableMethods ?? []).join(', ')}`;
      } else if (e.kind === 'name-string-recipient') {
        line = `- this.call("${e.depName}", "${e.methodName}", …) addresses a recipient by name. Message recipients are AbjectIds; the bus does not resolve names on the send path, so this call is delivered nowhere and times out. Resolve the id first: const id = await this.dep("${e.depName}"); await this.call(id, "${e.methodName}", …) — or inline await this.call(this.dep("${e.depName}"), "${e.methodName}", …). (Ids returned at runtime — window/canvas/layout ids from create* — are already resolved and fine to pass directly.)`;
      } else if (e.kind === 'hardcoded-id') {
        line = `- Hardcoded AbjectId literal "${e.depName}" at line ${e.callSite.line}. AbjectIds are ephemeral — they change on every restart, so a baked-in id is stale and unroutable next boot (a frequent cause of "works now, broken after restart"). Resolve the object at runtime instead: const id = await this.dep("<Name>") (system/dependency objects), or this.find("<Name>"), or call("Registry", "discover", { name: "<Name>" }). Never store a literal AbjectId in source or this.data.`;
      } else {
        line = `- Dependency "${e.depName}" was not discovered yet. Call describe / ask on it before calling its methods.`;
      }
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const lines = ['validate_calls flagged the following — fix using ONLY methods listed in the dependency manifests:'];
    for (const [line, n] of counts) {
      lines.push(n > 1 ? `${line} (${n} call sites)` : line);
    }
    return lines.join('\n');
  }

  private formatSemanticIssues(result: SemanticReviewResult): string {
    const lines = ['review_semantics flagged the following — the usage guide is the source of truth:'];
    for (const i of result.issues) {
      lines.push(`- [${i.severity}] ${i.message}${i.callSite ? `  (at: ${i.callSite})` : ''}`);
    }
    for (const q of result.questions) {
      lines.push(`- The reviewer wants you to ask ${q.dep}: ${q.question}`);
    }
    return lines.join('\n');
  }

  // ── Terminals ─────────────────────────────────────────────────────────

  private opDone(state: LoopState, action: AgentAction): { ok: boolean; summary: string; terminal: true } {
    state.terminal = { kind: 'done', result: action.result ?? this.actionField(action, ['result', 'report']) };
    return { ok: true, summary: 'done', terminal: true };
  }

  private opFail(state: LoopState, action: AgentAction): { ok: boolean; summary: string; terminal: true } {
    const rawReason = this.actionField(action, ['reason', 'error', 'message']);
    const reason = typeof rawReason === 'string' ? rawReason : 'unspecified';
    state.terminal = { kind: 'fail', error: reason };
    return { ok: true, summary: `fail: ${reason.slice(0, 120)}`, terminal: true };
  }

  // ── call dispatcher ───────────────────────────────────────────────────

  /**
   * The single inter-object primitive. Sends `request(target, method, payload)`
   * and returns the response. When the method is `describe` or `ask`, the
   * result is also merged into `state.deps` so subsequent `validate_calls` and
   * the observation renderer see the discovered surface.
   */
  private async opCall(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; data?: unknown; error?: string }> {
    const target = action.target as string | undefined;
    const method = action.method as string | undefined;
    const payload = (action.payload as Record<string, unknown> | undefined) ?? {};
    // `ask` answers are LLM-synthesized by the target (WidgetManager's build
    // guide runs at the smart tier and regularly takes 30-60s+). A 30s default
    // made agents lose the guide exactly when they needed it and build UIs
    // from memory instead.
    const defaultTimeout = method === 'ask' ? 120000 : 30000;
    const timeout = typeof action.timeout === 'number' ? action.timeout : defaultTimeout;

    if (!target || typeof target !== 'string') {
      return { ok: false, summary: 'call: missing target', error: 'target is required and must be a string (UUID or registered name)' };
    }
    if (!method || typeof method !== 'string') {
      return { ok: false, summary: 'call: missing method', error: 'method is required and must be a string' };
    }

    // Calls addressed by the draft's NAME must hit the instance this task
    // spawned. Name discovery returns the oldest registration, so when a
    // pre-existing object holds the same name, a name-routed verification
    // call would silently exercise the stale duplicate and pass on its
    // behavior (e.g. show() → 'Already open') instead of the new code's.
    let resolvedId: AbjectId | undefined;
    let pinnedToSpawn = false;
    if (state.spawnedObjectId && state.draftManifest?.name === target) {
      resolvedId = state.spawnedObjectId;
      pinnedToSpawn = true;
    } else {
      resolvedId = await this.resolveTarget(target);
    }
    if (!resolvedId) {
      return {
        ok: false,
        summary: `call ${target}.${method}: target not found`,
        error: `Could not resolve target "${target}". Try call(Registry, 'ask', {question: "is there an object that handles X?"}) to discover.`,
      };
    }

    let response: unknown;
    try {
      response = await this.sendRequest<unknown>(resolvedId, method, payload, timeout);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: `call ${target}.${method}: ${errMsg.slice(0, 120)}`,
        error: errMsg,
      };
    }

    // Merge discovery results into state.deps so validators and the
    // observation renderer see what's been learned.
    const summary = this.mergeDiscoveryIntoDeps(state, target, resolvedId, method, response);

    // Backfill the dep's structured method surface when it isn't known yet
    // (e.g. learned via `ask`, which records prose, not methods). One describe
    // per distinct dep; gives validate_calls real coverage instead of an empty
    // set. Skipped for describe (already populated) and the modify target's own
    // id (its source is loaded, not a call dependency).
    if (method !== 'describe' && resolvedId !== state.targetObjectId) {
      await this.ensureDepMethods(state, target, resolvedId);
    }

    // Detect deploy lifecycle so finalizeLoop can build the right
    // CreationResult shape and the agent shell can emit objectCreated /
    // objectModified events.
    this.recordDeployLifecycle(state, target, method, response);

    return {
      ok: true,
      summary: (summary ?? `call ${target}.${method}: ok`)
        + (pinnedToSpawn ? ` [routed to just-spawned ${resolvedId}]` : ''),
      data: response,
    };
  }

  /**
   * When a `call` returns image bytes — the shape Screenshot.captureWindow /
   * captureDesktop reply with ({ imageBase64, width, height }) — feed the
   * actual pixels to the NEXT think as an image part so the agent can SEE what
   * it rendered, and scrub the base64 out of the textual action result so a
   * ~50KB blob never bloats the transcript. The agent verifies layout, color,
   * spacing, and polish visually instead of guessing from getState numbers.
   */
  private async captureVisionFromCall(
    extra: TaskExtra,
    action: AgentAction,
    res: { ok: boolean; summary: string; data?: unknown; error?: string },
  ): Promise<void> {
    if (!res.ok) return;
    const method = String(action.method ?? '');
    const img = (res.data && typeof res.data === 'object')
      ? res.data as { imageBase64?: string; width?: number; height?: number; error?: string }
      : undefined;

    if (img && typeof img.imageBase64 === 'string' && img.imageBase64.length > 0) {
      const dims = `${img.width ?? '?'}x${img.height ?? '?'}`;

      // An image is only worth attaching if some configured model can see it.
      // Otherwise AgentAbject strips it to a text note downstream and the
      // agent is left guessing — say plainly that visual inspection is
      // impossible in this configuration instead.
      if (await this.refreshVisionCapability() === false) {
        res.data = `Screenshot captured (${dims}), which proves a visible window exists — but every configured LLM model is text-only, so YOU CANNOT SEE IT and neither visual inspection nor visual verification is possible. Verify what you can through code review (every layout child needs sizePolicy + preferredSize) and state/method checks, and say in your final result that the UI was not visually inspected because no vision-capable model is configured.`;
        res.summary = `call ${action.target}.${action.method}: screenshot ${dims} captured but NOT inspectable (no vision-capable model configured)`;
        return;
      }

      extra.lastLlmContent = [{ type: 'image', mediaType: 'image/png', data: img.imageBase64 }];
      res.data = `Screenshot captured (${dims}). The rendered image is attached to the next observation — inspect it visually: judge centering, alignment, spacing, color cohesion, typographic hierarchy, and overall polish against the goal, and note any specific element that looks off so you can fix it.`;
      res.summary = `call ${action.target}.${action.method}: screenshot ${dims} (attached for visual review)`;
      return;
    }

    // A capture call that produced no image bytes is a FAILED verification,
    // even though the message round-trip succeeded. Historically this came
    // back as a bare `null` inside an ok result, agents read it as success,
    // and "verified" UIs shipped that no one had ever seen. Make the summary
    // unmissable and point at the fix.
    if (/capture/i.test(method)) {
      const why = img?.error ?? 'the capture returned no image';
      res.ok = false;
      res.error = why;
      res.data = undefined;
      res.summary = `call ${action.target}.${action.method}: NO IMAGE — ${why}. You have NOT seen the UI; do not claim visual verification. Pass the FULL owner objectId or the windowId from show(), or use Screenshot.listWindows to find the window.`;
    }
  }

  /**
   * If `call` deployed a draft (spawn / updateSource), stamp the loop state
   * so `finalizeLoop` returns the right CreationResult shape and so the
   * objectCreated / objectModified events fire on `done`.
   */
  private recordDeployLifecycle(state: LoopState, target: string, method: string, response: unknown): void {
    if (target === 'Factory' && method === 'spawn' && response && typeof response === 'object') {
      const r = response as Partial<SpawnResult>;
      if (r.objectId) {
        state.spawnedObjectId = r.objectId;
      }
    }
    if (target === 'Registry' && method === 'updateSource' && state.targetObjectId) {
      // Registry.updateSource doesn't return a structured success marker —
      // the absence of an exception is the signal. Mark deployed so we
      // emit objectModified on done.
      state.deployedViaUpdateSource = true;
    }
  }

  /**
   * If `method` is `describe`, parse the IntrospectResult and add a fresh
   * DepMethodIndex entry. If `method` is `ask`, append the prose answer to
   * an existing entry's usageGuide (creating the entry if missing). Returns
   * a one-line summary suitable for the turn log; null for unrelated methods.
   */
  private mergeDiscoveryIntoDeps(
    state: LoopState,
    targetName: string,
    targetId: AbjectId,
    method: string,
    response: unknown,
  ): string | null {
    if (method === 'describe' && response && typeof response === 'object') {
      const ir = response as Partial<IntrospectResult>;
      const manifest = ir.manifest;
      if (!manifest) return null;
      const { methods, events } = this.methodsFromManifest(manifest);
      const key = manifest.name ?? targetName;
      const existing = state.deps.get(key);
      state.deps.set(key, {
        depName: key,
        depId: targetId,
        methods,
        events,
        usageGuide: existing?.usageGuide ?? '',
      });
      return `call ${targetName}.describe: ${manifest.name} (${methods.size} method${methods.size === 1 ? '' : 's'}, ${events.size} event${events.size === 1 ? '' : 's'})`;
    }

    if (method === 'ask' && typeof response === 'string') {
      const key = targetName;
      const existing = state.deps.get(key);
      const guide = existing?.usageGuide ?? '';
      const merged = guide ? `${guide}\n\n${response}` : response;
      state.deps.set(key, {
        depName: key,
        depId: existing?.depId ?? targetId,
        methods: existing?.methods ?? new Map(),
        events: existing?.events ?? new Set(),
        usageGuide: merged,
      });
      return `call ${targetName}.ask: ${response.slice(0, 120).replace(/\n+/g, ' ')}${response.length > 120 ? '…' : ''}`;
    }

    return null;
  }

  /** Convert a manifest's interface into the dep-record method/event shape. */
  private methodsFromManifest(manifest: AbjectManifest): { methods: Map<string, MethodSignature>; events: Set<string> } {
    const methods = new Map<string, MethodSignature>();
    for (const m of manifest.interface?.methods ?? []) {
      methods.set(m.name, {
        name: m.name,
        description: m.description,
        params: (m.parameters ?? []).map(p => ({
          name: p.name,
          optional: p.optional,
          typeHint: this.renderTypeHint(p.type),
        })),
        returns: this.renderTypeHint(m.returns),
      });
    }
    const events = new Set<string>((manifest.interface?.events ?? []).map(e => e.name));
    return { methods, events };
  }

  /**
   * Backfill a touched dependency's structured method surface from its live
   * manifest. The agent often learns a dep via `ask` (prose how-to), which
   * records a usage guide but leaves `methods` empty — so validate_calls has
   * nothing to check and either skips (fail-open) or, before that, false-flags.
   * Here we have the resolved id, so fetch the manifest once via `describe` and
   * merge the methods in, giving the validator real coverage (it can now catch
   * genuine wrong-method-name mistakes). Best-effort and idempotent: only
   * fetches when the dep's method surface is still empty.
   */
  private async ensureDepMethods(state: LoopState, depName: string, depId: AbjectId): Promise<void> {
    if (!depName) return;
    const existing = state.deps.get(depName);
    if (existing && existing.methods.size > 0) return; // surface already known
    let manifest: AbjectManifest | undefined;
    try {
      const ir = await this.sendRequest<Partial<IntrospectResult>>(depId, 'describe', {}, 5000);
      manifest = ir?.manifest as AbjectManifest | undefined;
    } catch { /* best effort — leave empty, validate_calls fails open */ }
    if (!manifest?.interface) return;
    const { methods, events } = this.methodsFromManifest(manifest);
    if (methods.size === 0) return;
    state.deps.set(depName, {
      depName,
      depId,
      methods,
      events: existing?.events && existing.events.size > 0 ? existing.events : events,
      usageGuide: existing?.usageGuide ?? '',
    });
  }

  /** Best-effort English type rendering for the structured methods block. */
  private renderTypeHint(t: unknown): string | undefined {
    if (!t || typeof t !== 'object') return undefined;
    const ty = t as { kind?: string; primitive?: string; reference?: string; elementType?: unknown };
    if (ty.kind === 'primitive' && ty.primitive) return ty.primitive;
    if (ty.kind === 'reference' && ty.reference) return ty.reference;
    if (ty.kind === 'array') return `${this.renderTypeHint(ty.elementType) ?? 'unknown'}[]`;
    if (ty.kind === 'object') return 'object';
    return ty.kind;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. AGENT SHELL (registration, observe/act, system prompt, lifecycle)
  // ════════════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    // ── Manifest methods (entry points) ──
    this.on('create', (msg: AbjectMessage) => {
      const { prompt, context, goalId } = msg.payload as { prompt: string; context?: string; goalId?: string };
      this.startAgentTask({
        kind: 'create',
        prompt,
        context,
        goalId,
        callerId: msg.routing.from,
        deferredMsg: msg,
      });
      return DEFERRED_REPLY;
    });

    this.on('modify', (msg: AbjectMessage) => {
      const { objectId, prompt, goalId } = msg.payload as { objectId: string; prompt: string; goalId?: string };
      this.startAgentTask({
        kind: 'modify',
        prompt,
        targetIdOrName: objectId,
        goalId,
        callerId: msg.routing.from,
        deferredMsg: msg,
      });
      return DEFERRED_REPLY;
    });

    this.on('executeTask', (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description, type, data, callerId: explicitCaller } = msg.payload as {
        tupleId?: string;
        taskId?: string;
        goalId?: string;
        description: string;
        type?: string;
        data?: Record<string, unknown>;
        callerId?: string;
      };
      const callerId = (explicitCaller as AbjectId) ?? msg.routing.from;
      const targetIdOrName = (data?.objectId as string | undefined)
        ?? (data?.target as string | undefined)
        ?? (data?.objectName as string | undefined);
      const kind: 'create' | 'modify' | 'investigate' =
        type === 'create' ? 'create'
          : type === 'modify' ? 'modify'
            : type === 'investigate' ? 'investigate'
              : (targetIdOrName ? 'modify' : 'create');
      // Use the queue-runner-supplied taskId so AgentAbject's TaskEntry,
      // ObjectCreator's TaskExtra, and the queue's inFlight slot all share
      // one ID. Falls back to a fresh oc-${...} for legacy direct callers.
      this.startAgentTask({
        kind,
        prompt: description,
        targetIdOrName,
        goalId,
        dispatchTupleId: tupleId ?? explicitTaskId,
        callerId,
        deferredMsg: msg,
        explicitTaskId: explicitTaskId ?? tupleId,
      });
      return DEFERRED_REPLY;
    });

    // ── AgentAbject callbacks ──
    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAct(taskId, action, msg.routing.from);
    });

    this.on('agentPhaseChanged', async () => { /* no-op */ });
    this.on('agentIntermediateAction', async () => { /* no-op */ });
    this.on('agentActionResult', async () => { /* no-op */ });

    // ── Receive task results from AgentAbject ──
    this.on('taskResult', async (msg: AbjectMessage) => {
      const { ticketId, success, result, error } = msg.payload as {
        ticketId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        steps: number;
      };
      const taskId = this.taskIdByTicket.get(ticketId);
      if (!taskId) return;
      const extra = this.tasks.get(taskId);
      if (!extra) return;

      const finalResult = this.finalizeLoop(extra.state, success, result, error);

      // Preserve authored-but-undeployed work across the task boundary. A
      // step-budget death (or any failure) that leaves a staged draft would
      // otherwise force the follow-up task to re-author hundreds of lines
      // from the failure prose alone; persisting the draft lets it resume.
      if (extra.goalId) {
        if (!finalResult.success && extra.state.draftSource
            && extra.state.draftSource !== extra.state.lastDeployedSource) {
          const saved = await this.persistDraftToGoal(extra);
          if (saved) {
            finalResult.error = `${finalResult.error ?? 'Task failed'} [The staged draft (manifest + source) is preserved in the goal scratchpad under '${GOAL_DRAFT_KEY}'; the next ObjectCreator task in this goal adopts it automatically — plan a finish-and-deploy task, not a rewrite.]`;
          }
        } else if (finalResult.success) {
          void this.clearPersistedDraft(extra.goalId);
        }
      }

      // Emit lifecycle events
      if (finalResult.success) {
        if (extra.state.kind === 'create' && finalResult.objectId) {
          this.send(event(this.id, this.id, 'objectCreated', finalResult));
        } else if (extra.state.kind === 'modify' && finalResult.objectId) {
          this.send(event(this.id, this.id, 'objectModified', finalResult));
        }
      }

      // Resolve the deferred reply to the original caller
      if (extra.deferredMsg) {
        this.sendDeferredReply(extra.deferredMsg, finalResult);
      }
      this.tasks.delete(taskId);
      this.taskIdByTicket.delete(ticketId);
    });
  }

  /** Build a fresh LoopState and submit a ticket to AgentAbject. */
  private async startAgentTask(args: {
    kind: 'create' | 'modify' | 'investigate';
    prompt: string;
    context?: string;
    targetIdOrName?: string;
    goalId?: string;
    /**
     * TupleSpace tuple id (or queued task id) when this task came from
     * AgentAbject's task queue. Forwarded to startTask so the TaskEntry's
     * dispatchTupleId tells runTaskAsync to call completeTask/failTask on
     * the originating tuple — which is how ScrumMaster's goalReadyForCompletion
     * trigger fires.
     */
    dispatchTupleId?: string;
    /**
     * Explicit taskId to use for the AgentAbject startTask. When supplied
     * (by the queue runner), AgentAbject's TaskEntry, ObjectCreator's
     * TaskExtra, and AgentAbject's queue inFlight slot all share this ID
     * so the queue runner can match `entry.state.id` and pop the next
     * pending task on completion. When omitted (legacy direct callers),
     * we generate a fresh `oc-${...}`.
     */
    explicitTaskId?: string;
    callerId?: AbjectId;
    deferredMsg?: AbjectMessage;
  }): Promise<void> {
    if (!this.agentAbjectId) {
      const result: CreationResult = { success: false, error: 'AgentAbject not available' };
      if (args.deferredMsg) this.sendDeferredReply(args.deferredMsg, result);
      return;
    }

    let targetObjectId: AbjectId | undefined;
    let targetName: string | undefined;
    if (args.targetIdOrName) {
      const resolved = await this.resolveTarget(args.targetIdOrName);
      if (resolved) {
        targetObjectId = resolved;
        targetName = args.targetIdOrName.includes('-') && args.targetIdOrName.length > 20 ? undefined : args.targetIdOrName;
      }
    }

    // Preload existing source for modify loops so the agent can author
    // draft_diff blocks without burning a turn on Registry.getSource. Best
    // effort — if this fails (object not yet registered, no source on file),
    // the agent falls back to fetching it explicitly.
    let targetSource: string | undefined;
    if (args.kind === 'modify' && targetObjectId && this.registryId) {
      try {
        const src = await this.sendRequest<string | null>(
          this.registryId, 'getSource', { objectId: targetObjectId }, 5000,
        );
        if (typeof src === 'string' && src.length > 0) targetSource = src;
      } catch {
        /* preload is opportunistic */
      }
    }

    const state: LoopState = {
      kind: args.kind,
      goal: args.prompt,
      targetObjectId,
      targetName,
      targetSource,
      deps: new Map(),
      usedObjects: [],
      turn: 0,
      turnLog: [],
    };

    // Resume authored work from a prior task in this goal, if any: a
    // persisted draft means a previous loop ended before deploying, and
    // adopting it turns "re-author from failure prose" into "finish and ship".
    if (args.goalId && args.kind !== 'investigate') {
      await this.loadPersistedDraft(args.goalId, state);
    }

    const taskId = args.explicitTaskId ?? `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskExtra: TaskExtra = {
      taskId,
      prompt: args.prompt,
      context: args.context,
      callerId: args.callerId,
      goalId: args.goalId,
      deferredMsg: args.deferredMsg,
      state,
    };
    // Register before submitting so the first agentObserve callback (which can
    // race the startTask reply) finds the task.
    this.tasks.set(taskId, taskExtra);

    try {
      const { ticketId } = await this.sendRequest<{ ticketId: string }>(
        this.agentAbjectId,
        'startTask',
        {
          taskId,
          task: args.prompt,
          systemPrompt: this.buildSystemPrompt(),
          goalId: args.goalId,
          dispatchTupleId: args.dispatchTupleId,
          config: {
            // Authoring loops legitimately need more room than generic
            // call-orchestration tasks: discovery + drafting + validate
            // cycles + deploy + behavioral/visual verification. AgentAbject
            // additionally grants progress-aware extensions at the cap.
            maxSteps: 45,
            timeout: 600000,
            queueName: `object-creator-${this.id}`,
          },
        },
        15000,
      );
      taskExtra.ticketId = ticketId;
      this.taskIdByTicket.set(ticketId, taskId);
    } catch (err) {
      this.tasks.delete(taskId);
      const result: CreationResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      if (args.deferredMsg) this.sendDeferredReply(args.deferredMsg, result);
    }
  }

  // ── Draft persistence across task boundaries ──────────────────────────

  /**
   * Persist the staged (undeployed) draft to the goal scratchpad so the next
   * ObjectCreator task in this goal resumes it instead of re-authoring.
   */
  private async persistDraftToGoal(extra: TaskExtra): Promise<boolean> {
    const s = extra.state;
    if (!extra.goalId || !s.draftSource || !this.goalManagerId) return false;
    try {
      const payload = {
        savedAt: Date.now(),
        taskId: extra.taskId,
        kind: s.kind,
        targetName: s.targetName ?? s.draftManifest?.name,
        targetObjectId: s.targetObjectId,
        manifest: s.draftManifest,
        source: s.draftSource,
      };
      await this.sendRequest(this.goalManagerId, 'writeGoalData', {
        goalId: extra.goalId, key: GOAL_DRAFT_KEY, value: JSON.stringify(payload),
      }, 10000);
      log.info(`Preserved undeployed draft (${s.draftSource.split('\n').length} lines) in goal ${extra.goalId.slice(0, 8)} scratchpad`);
      return true;
    } catch (err) {
      log.warn(`Failed to persist draft to goal scratchpad: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A successful (deployed) result makes any persisted draft stale — clear it. */
  private async clearPersistedDraft(goalId: string): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      await this.sendRequest(this.goalManagerId, 'writeGoalData', {
        goalId, key: GOAL_DRAFT_KEY, value: '',
      }, 10000);
    } catch { /* best effort */ }
  }

  /**
   * Adopt a draft persisted by a prior task in this goal. The observation's
   * DRAFTS section then shows it (flagged as not yet deployed) and a turn-log
   * entry steers the loop to finish + deploy rather than re-author.
   */
  private async loadPersistedDraft(goalId: string, state: LoopState): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      const raw = await this.sendRequest<string | null>(this.goalManagerId, 'readGoalData', {
        goalId, key: GOAL_DRAFT_KEY,
      }, 10000);
      if (!raw || typeof raw !== 'string') return;
      const payload = JSON.parse(raw) as {
        taskId?: string; kind?: string; targetName?: string;
        manifest?: AbjectManifest; source?: string;
      };
      if (!payload.source) return;
      // A draft authored for a DIFFERENT named target is not ours to adopt.
      if (payload.targetName && state.targetName && payload.targetName !== state.targetName) return;
      state.draftSource = payload.source;
      if (payload.manifest && !state.draftManifest) state.draftManifest = payload.manifest;
      state.turnLog.push({
        turn: 0,
        action: 'resume_draft',
        ok: true,
        summary: `Adopted the staged draft a previous task in this goal persisted before it ended (${payload.source.split('\n').length} lines${payload.manifest ? `, manifest ${payload.manifest.name}` : ''}). It is staged but NOT deployed: address the findings named in the task description, compile, validate, then deploy and verify — no re-authoring needed.`,
      });
      log.info(`Resumed persisted draft for goal ${goalId.slice(0, 8)} (${payload.source.split('\n').length} lines)`);
    } catch { /* absence of a persisted draft is the normal case */ }
  }

  // ── Observe / Act ─────────────────────────────────────────────────────

  private async handleObserve(taskId: string): Promise<{ observation: string; tier: string; llmContent?: ContentPart[] }> {
    // Look up by AgentAbject-assigned ticketId; AgentAbject calls back with the
    // taskId we sent on startTask, so look for an entry whose state matches.
    // Since we keyed by ticketId, find by taskId-in-context: AgentAbject passes
    // the original taskId we provided. That's the same as our ticketId.
    const extra = this.tasks.get(taskId);
    if (!extra) {
      return { observation: 'No active task. Reply with done({result: "no task"}).', tier: 'smart' };
    }
    extra.state.turn += 1;
    const observation = this.renderObservation(extra.state);

    // A screenshot staged by the previous act rides in as an image part, and
    // judging a rendered image is a reasoning step — force the smart tier so
    // the visual critique isn't done on a cheaper model.
    if (extra.lastLlmContent) {
      const llmContent: ContentPart[] = [
        { type: 'text', text: observation },
        ...extra.lastLlmContent,
      ];
      extra.lastLlmContent = undefined;
      return { observation, tier: 'smart', llmContent };
    }

    return { observation, tier: this.chooseObserveTier(extra.state) };
  }

  /**
   * Per-state model tier for the next think decision. Mechanical, error-free
   * progress — compiling, validating, deploying, and verifying a healthy
   * object — decides its (trivial) next step on 'balanced'. Steps in the
   * code pipeline — writing/editing source, or fixing what compile /
   * validate_calls / review_semantics flagged — run on 'code' (the explicit
   * code-generation tier; it rides smart when unrouted). Everything else
   * that needs real reasoning — the initial architecture, runtime error
   * diagnosis, a verification call that surfaced a problem — stays on
   * 'smart'. The OTA loop floors thinking at balanced, so 'fast' is never
   * used here.
   */
  private chooseObserveTier(state: LoopState): 'smart' | 'balanced' | 'code' {
    const log = state.turnLog ?? [];
    const last = log[log.length - 1];
    if (!last) return 'smart'; // first step → architecture / investigation
    const CODE_PIPELINE = new Set([
      'draft_source', 'draft_diff', 'draft_via_llm',
      'replace_handler', 'add_handler', 'remove_handler',
      'compile', 'validate_calls', 'review_semantics', 'read_draft',
    ]);
    if (!last.ok) {
      // A failed code-pipeline step gets fixed by writing code; other
      // failures need diagnostic reasoning first.
      return CODE_PIPELINE.has(last.action) ? 'code' : 'smart';
    }
    const ROUTINE = new Set([
      'compile', 'validate_calls', 'deploy_spawn', 'deploy_update',
      'call', 'read_draft', 'getState', 'ask', 'discover', 'load_target',
    ]);
    if (!ROUTINE.has(last.action)) {
      // Just drafted/edited successfully → the next step continues the code
      // work (more edits, or deciding validation) on the code tier.
      return CODE_PIPELINE.has(last.action) ? 'code' : 'smart';
    }
    // A "successful" verification call can still surface a runtime problem —
    // that needs reasoning even though the action itself succeeded.
    if (/\b(error|exception|fail|threw|cannot read|undefined|not found|not registered)\b/i.test(last.summary)) {
      return 'smart';
    }
    return 'balanced';
  }

  private async handleAct(taskId: string, action: AgentAction, _callerId: AbjectId): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.tasks.get(taskId);
    if (!extra) {
      return { success: false, error: 'No active task' };
    }
    const state = extra.state;
    const callerId = extra.callerId;

    let res: { ok: boolean; summary: string; data?: unknown; error?: string; terminal?: boolean };
    try {
      switch (action.action) {
        case 'call':
          res = await this.opCall(state, action);
          await this.captureVisionFromCall(extra, action, res);
          break;
        case 'draft_manifest':
          res = await this.opDraftManifest(state, action);
          break;
        case 'draft_source':
          res = await this.opDraftSource(state, action);
          break;
        case 'draft_diff':
          res = await this.opDraftDiff(state, action);
          break;
        case 'read_draft':
          res = this.opReadDraft(state, action);
          break;
        case 'replace_handler':
          res = this.opReplaceHandler(state, action);
          break;
        case 'add_handler':
          res = this.opAddHandler(state, action);
          break;
        case 'remove_handler':
          res = this.opRemoveHandler(state, action);
          break;
        case 'load_target':
          res = await this.opLoadTarget(state, action);
          break;
        case 'draft_via_llm':
          res = await this.opDraftViaLlm(state, action);
          break;
        case 'compile':
          res = this.opCompile(state);
          break;
        case 'validate_calls':
          res = this.opValidateCalls(state);
          break;
        case 'review_semantics':
          res = await this.opReviewSemantics(state);
          break;
        case 'deploy_spawn':
          res = await this.opDeploySpawn(state);
          break;
        case 'deploy_update':
          res = await this.opDeployUpdate(state, action);
          break;
        case 'compose_organism':
          res = await this.opComposeOrganism(state, action);
          break;
        case 'extract_organelle':
          res = await this.opExtractOrganelle(state, action);
          break;
        case 'reply':
          res = await this.opReply(state, action, callerId);
          break;
        case 'ask_user':
          res = await this.opAskUser(state, action, callerId);
          break;
        case 'done':
          res = this.opDone(state, action);
          break;
        case 'fail':
          res = this.opFail(state, action);
          break;
        default:
          res = { ok: false, summary: `unknown action: ${action.action}`, error: this.unknownActionError(action.action, state) };
      }
    } catch (err) {
      res = { ok: false, summary: 'action threw', error: err instanceof Error ? err.message : String(err) };
    }

    state.turnLog.push({
      turn: state.turn,
      action: action.action,
      ok: res.ok,
      summary: res.summary.slice(0, 200),
    });

    if (res.terminal) {
      // Surface the terminal back to AgentAbject in the shape it expects
      // (terminalActions config maps `done` -> success and `fail` -> error).
      if (state.terminal?.kind === 'done') {
        return { success: true, data: state.terminal.result };
      }
      return { success: false, error: state.terminal?.error ?? 'failed' };
    }

    return { success: res.ok, data: res.data, error: res.error };
  }

  // ── Observation renderer ──────────────────────────────────────────────

  private renderObservation(state: LoopState): string {
    const lines: string[] = [];

    lines.push('TASK');
    lines.push(`  kind:   ${state.kind}`);
    if (state.targetName || state.targetObjectId) {
      // Full id, never truncated: agents copy ids straight out of this text
      // into call payloads (e.g. Screenshot.captureWindow), and a shortened
      // id silently matches nothing.
      lines.push(`  target: ${state.targetName ?? '?'}${state.targetObjectId ? ` (${state.targetObjectId})` : ''}`);
    } else {
      lines.push(`  target: (new object)`);
    }
    lines.push(`  goal:   "${state.goal.slice(0, 400).replace(/\n/g, ' ')}"`);
    lines.push('');

    lines.push('KNOWN OBJECTS (from describe / ask so far)');
    if (state.deps.size === 0) {
      lines.push('  (none yet — use call(<name>, "describe") or call(<name>, "ask", {question}) to discover)');
    } else {
      for (const dep of state.deps.values()) {
        lines.push(`  ### ${dep.depName}${dep.depId ? ` (${dep.depId})` : ''}`);
        if (dep.methods.size > 0) {
          lines.push('  Methods:');
          for (const m of dep.methods.values()) {
            const params = m.params.map(p => `${p.name}${p.optional ? '?' : ''}${p.typeHint ? `: ${p.typeHint}` : ''}`).join(', ');
            const ret = m.returns ? ` -> ${m.returns}` : '';
            lines.push(`    - ${m.name}(${params})${ret}`);
          }
        }
        if (dep.events.size > 0) {
          lines.push(`  Events: ${[...dep.events].join(', ')}`);
        }
        if (dep.usageGuide) {
          const excerpt = dep.usageGuide.slice(0, 600).replace(/\n+/g, ' ');
          lines.push(`  Usage guide excerpt: ${excerpt}${dep.usageGuide.length > 600 ? '…' : ''}`);
        }
      }
    }
    lines.push('');

    if (state.targetSource) {
      lines.push(`TARGET SOURCE (${state.targetSource.split('\n').length} lines — current code of ${state.targetName ?? state.targetObjectId?.slice(0, 8) ?? 'target'}; use draft_diff to edit)`);
      lines.push('```javascript');
      lines.push(state.targetSource);
      lines.push('```');
      lines.push('');
    }

    lines.push('DRAFTS');
    lines.push(`  manifest: ${state.draftManifest ? state.draftManifest.name : '(not drafted)'}`);
    const hasUndeployed = !!state.draftSource && state.draftSource !== state.lastDeployedSource;
    const deployState = !state.draftSource
      ? '(not drafted)'
      : hasUndeployed
        ? `${state.draftSource.split('\n').length} lines — ⚠️ NOT YET DEPLOYED (live object still runs old code)`
        : `${state.draftSource.split('\n').length} lines — deployed (live)`;
    lines.push(`  source:   ${deployState}`);
    lines.push('');

    if (hasUndeployed) {
      const deployVerb = state.kind === 'create' && !state.spawnedObjectId ? 'deploy_spawn' : 'deploy_update';
      lines.push('⚠️ UNDEPLOYED EDITS — your staged source differs from what is live. Compiling is NOT deploying.');
      lines.push(`   Run ${deployVerb} to make these edits live before you finish. Do NOT call done with an undeployed draft —`);
      lines.push('   the loop would report success while the user still sees the old object.');
      lines.push('   If your edit touched show() / createCanvas / widget wiring, also hide() then show() the target after deploy so the new wiring takes effect.');
      lines.push('');
    }

    if (state.nameCollisionId) {
      lines.push(`⚠️ NAME COLLISION — a pre-existing live object (${state.nameCollisionId}) also answers to "${state.draftManifest?.name}".`);
      lines.push(`   Name-based routing resolves to that OLDER object, so verifying "by name" would test the wrong instance. Your call actions targeting the name are auto-routed to the instance you spawned (${state.spawnedObjectId ?? '?'}).`);
      lines.push('   Before finishing, resolve the duplicate: if the older object is a stale/previous version of the same thing, destroy it or fold your changes into it — the user should not end up with two identically-named objects.');
      lines.push('');
    }

    if (state.lastValidation) {
      lines.push('LAST VALIDATION');
      const v = state.lastValidation;
      if (v.compile !== undefined) lines.push(`  compile:          ${v.compile === '' ? 'OK' : v.compile.slice(0, 120)}`);
      if (v.calls) lines.push(`  validate_calls:   ${v.calls.length} issue${v.calls.length === 1 ? '' : 's'}`);
      if (v.semantics) {
        const errs = v.semantics.issues.filter(i => i.severity === 'error').length;
        const warns = v.semantics.issues.filter(i => i.severity === 'warning').length;
        lines.push(`  review_semantics: ${v.semantics.verified
          ? `VERIFIED${warns > 0 ? ` (${warns} advisory warning${warns === 1 ? '' : 's'} — deployable)` : ''}`
          : `${errs} error${errs === 1 ? '' : 's'}`}`);
      }
      lines.push('');
    }

    // Stop-reading steer: read_draft is read-only and makes no progress.
    // Count how many read_drafts run back-to-back with no productive action
    // between them; two in a row is already a stall (reading→editing→reading is
    // fine, this only fires on reading→reading). Point straight at the fix.
    let consecutiveReads = 0;
    for (let i = state.turnLog.length - 1; i >= 0; i--) {
      if (state.turnLog[i].action === 'read_draft') consecutiveReads++;
      else break;
    }
    if (consecutiveReads >= 2) {
      const compileErr = typeof state.lastValidation?.compile === 'string' && state.lastValidation.compile !== '';
      lines.push(`⚠️ You have called read_draft ${consecutiveReads}× in a row without changing anything. read_draft is read-only, so it makes no progress.`);
      if (compileErr) {
        lines.push('   The compile error above already names the exact failing line and shows its context, so you HAVE the location. Do NOT read_draft again to find it. Fix it now: replace_handler to rewrite the one member that contains it, or draft_diff for a small change, or draft_source to regenerate the whole object.');
      } else {
        lines.push('   Act now instead of reading again: compile to validate the draft, then deploy_update — or make a targeted replace_handler / draft_diff edit. One more read will not move the build forward.');
      }
      lines.push('');
    }

    const recent = state.turnLog.slice(-8);
    if (recent.length > 0) {
      lines.push(`RECENT TURNS (last ${recent.length})`);
      for (const t of recent) {
        lines.push(`  turn ${t.turn}  ${t.action.padEnd(18)} ok=${t.ok}  ${t.summary}`);
      }
    }

    return lines.join('\n');
  }

  // ── Finalization: LoopState -> CreationResult ─────────────────────────

  private finalizeLoop(state: LoopState, agentSuccess: boolean, agentResult: unknown, agentError?: string): CreationResult {
    if (!agentSuccess || state.terminal?.kind === 'fail') {
      return {
        success: false,
        error: state.terminal?.error ?? agentError ?? 'Agent loop failed',
      };
    }

    if (state.spawnedObjectId) {
      return {
        success: true,
        objectId: state.spawnedObjectId,
        manifest: state.draftManifest,
        code: state.draftSource,
        usedObjects: state.usedObjects,
      };
    }

    if (state.deployedViaUpdateSource && state.targetObjectId) {
      return {
        success: true,
        objectId: state.targetObjectId,
        code: state.draftSource,
      };
    }

    // Investigative result — coerce to a string report.
    let report: string;
    if (typeof agentResult === 'string') {
      report = agentResult;
    } else if (typeof agentResult === 'object' && agentResult !== null) {
      report = JSON.stringify(agentResult, null, 2);
    } else {
      report = String(agentResult ?? '');
    }
    return {
      success: true,
      report,
    };
  }

  // ── System prompt ─────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    // Keep the cached vision answer fresh for the next build; this call is
    // TTL-gated and non-blocking (the current build uses the cached value).
    void this.refreshVisionCapability();
    return `You are ObjectCreator, a code-writing agent inside the Abjects distributed message-passing system. You create new Abjects, modify existing ones, and answer diagnostic questions about Abjects.

# The system

Every Abject answers two protocols:
- \`describe\` returns its manifest — the authoritative list of methods, events, and tags.
- \`ask\` answers ANY natural-language question about how to use it, what it does, or what it is currently doing.

The ask protocol is universal — no object is exempt. The Registry answers questions about what objects exist ("is there an object that handles email?"). Each user object answers questions about its own API and behavior ("how do I add a button?", "what does your getState return?", "why is your status degraded?"). Every MCP server, capability, skill, and system service answers the same way.

There are no "tool calls" in this system. There is one inter-object operation: send a message via \`call(target, method, payload)\`. Every reachable object — every MCP server, capability, skill, system service, and user object — is a message target.

# Runtime environment

Abjects run in a **sandboxed backend** (a Node vm inside a worker thread), **not in a browser**. The source you write for a ScriptableAbject has no \`window\`, \`document\`, \`navigator\`, \`fetch\`, \`WebSocket\`, \`AudioContext\`, \`Image\`, DOM, or global \`setTimeout\`/\`setInterval\`. Browser APIs are not merely unavailable — using one silently no-ops (often swallowed by a try/catch), so the feature ships as dead code that never runs. This is the single most common reason a "finished" object does nothing.

Anything a browser would give you — sound, speech, HTTP, persistence, files, timing/scheduling, clipboard, drawing — is instead provided by some **other Abject reached by message**, not by a global API. Do not assume which object provides a capability or hardcode its name: use the ask protocol to discover it. \`call("Registry", "discover", { ... })\` or \`call("Registry", "ask", { question })\` to find the object that provides what you need, then \`call(thatObject, "ask", { question })\` to learn its methods and read its usage guide, then \`call(id, method, payload)\`.

So when a goal needs a capability the browser would normally supply (playing sound, speaking, fetching a URL, saving data, running on a timer, …), your first move is to discover its provider through the Registry — never reach for a browser API and never guess an object name.

# Response format

Emit ONE JSON action per turn, wrapped in a \`\`\`json code block. Nothing else in the response.

When several actions are fully independent of each other — e.g. several discovery \`ask\`/\`describe\` calls to different objects — you may emit them as multiple \`\`\`json blocks in one response. They execute strictly in order without you seeing intermediate results, a failure cancels the ones after it, and at most 5 are honored. Batch only actions whose payloads are already fully known; anything that depends on an earlier action's result belongs in a later turn. Emit \`done\`, \`fail\`, \`replan\`, \`remember\`, and \`ask_user\` alone, as the only action in the response.

# Actions

## The primitive: call

\`\`\`json
{ "action": "call", "target": "<name-or-uuid>", "method": "<method>", "payload": { ... }, "timeout": 30000 }
\`\`\`

\`target\` is either a UUID, a registered object name (e.g. "Registry", "ChatManager", "TelegramBridge"), or a system-service name (e.g. "Console", "GoalManager", "KnowledgeBase"). \`payload\` defaults to {}. \`timeout\` defaults to 30000ms; raise for long operations like Factory.spawn.

## Local operations (no message target)

Local-operation fields sit at the TOP LEVEL of the action, beside \`"action"\` — only \`call\` has a \`payload\` wrapper. So \`draft_manifest\` is \`{"action":"draft_manifest","manifest":{...}}\`, \`draft_source\` is \`{"action":"draft_source","source":"..."}\`, and so on.

- \`load_target({objectId?, targetName?})\` — adopt an EXISTING object as this loop's modify target: resolves the name/UUID, loads its current source into loop state, and switches the loop to a modify. Use this when the loop started without a target (kind \`create\`) but you discovered — via \`call("Registry", "ask"/"discover", …)\` or \`describe\` — that the goal is really about an object that already exists (e.g. "fix the GraphViewer window" → GraphViewer is already registered). After \`load_target\`, inspect with \`read_draft\`, edit with \`replace_handler\` / \`add_handler\` / \`remove_handler\` (or \`draft_diff\` for sub-method edits), then ship with \`deploy_update\` (no need to repeat the id). For a genuinely new object, skip this and use \`draft_source\` instead.
- \`draft_manifest({manifest, usedObjects?})\` — stage a manifest you've authored. Used before \`deploy_spawn\`. Shape: \`{ name, description, version, icon, interface: { id, name, description, methods, events? }, requiredCapabilities: [], providedCapabilities: [], tags: [] }\`. \`methods\` and \`events\` are arrays of OBJECTS, never bare name strings: each method is \`{ name, description, parameters: [{ name, type: { kind: "primitive"|"reference"|"array"|"object", … }, description, optional? }], returns? }\` and each event is \`{ name, description, payload }\`. Emitting a plain string like \`"show"\` leaves the method nameless in the Explorer — always use the object form. Include an \`icon\` (a single emoji that fits the object, e.g. 🌤 / 📝 / 🎮) — it appears next to the object's name in launchers.
- \`draft_source({source})\` — stage handler-map source you've authored. The format is a single parenthesized object literal: \`({ method(msg) { ... } })\`. Use this for NEW objects (create flow) or a genuine full rewrite. When MODIFYING an existing object, prefer \`replace_handler\`/\`draft_diff\` — re-emitting a large whole-object source in one action risks being truncated by the output-length limit (the source silently gets dropped and the action fails with "missing source").
- \`draft_diff({blocks})\` — apply SEARCH/REPLACE blocks to the existing source. Good for small edits that span or sit inside members; for replacing a whole method prefer \`replace_handler\` (no SEARCH matching). Either way you edit without re-emitting the whole file. Each block:

  \`\`\`
  <<<<<<< SEARCH
  exact lines from the current source, including indentation
  =======
  the replacement lines
  >>>>>>> REPLACE
  \`\`\`

  Multiple blocks may appear in one \`blocks\` payload and are applied in order. SEARCH must match a UNIQUE location in the current source — include 2–3 lines of surrounding context if a snippet would otherwise match in more than one place. Whitespace is forgiven (line-trimmed match), but matching the indentation exactly is safer. Successive \`draft_diff\` calls stack on the prior result, so you can layer fixes. To insert new code, use a SEARCH that matches a nearby anchor and include both the anchor and your insertion in REPLACE.
- \`read_draft({handler? , lineRange?, grep?})\` — read the CURRENT staged source so you edit against ground truth instead of memory. No args → a compact outline (each top-level member with its line range). \`{handler:"name"}\` → that member's exact current text (line-numbered). \`{lineRange:"a-b"}\` → those lines. \`{grep:"pattern"}\` → matching lines. Editing nothing, read-only. Use it to orient in an EXISTING large object BEFORE editing it (a modify flow): one read of the one member you're about to change. It is NOT for re-reviewing source you just generated: after \`draft_source\`/\`draft_via_llm\`, go straight to \`compile\` (it points to the one broken spot), and only \`read_draft\` the specific member/line a validation error names, once. read_draft is read-only, so repeating it makes no progress; never call it two turns in a row without an edit or a compile between them.
- \`replace_handler({name, body})\` — replace the ENTIRE top-level member named \`name\` (a method or property of the \`({ … })\` literal) with \`body\` (the full member text, including its signature, e.g. \`"openMap(msg) { … }"\`). Located by name via the object literal's structure — no SEARCH text, whitespace-proof, unaffected by file size. **This is the preferred way to modify one method**; reach for it before \`draft_diff\`. Run \`compile\` after.
- \`add_handler({name, body})\` — insert a NEW top-level member (full member text). Errors if \`name\` already exists (use replace_handler then). Run \`compile\` after.
- \`remove_handler({name})\` — delete the top-level member named \`name\` (and its separating comma). Run \`compile\` after.
- \`draft_via_llm({kind: "manifest" | "source", instructions})\` — ask an LLM to draft for you. It sees current loop state. Use when authoring a brand-new manifest or source from scratch is too large for one think-step. Do NOT use this for modifications of existing objects — use \`draft_diff\` instead, since the LLM consistently truncates "preserve everything else" rewrites.
- \`compile()\` — run a syntax check on the staged source. Fails fast on parse errors.
- \`validate_calls()\` — static check: every \`this.call(x, "method", …)\` site is checked against the live manifest of the target dep. Run AFTER compile.
- \`review_semantics()\` — LLM reviewer reads the drafts plus all known dependency manifests + usage guides and flags semantic issues (wrong payload shape, enum-like values not in the guide, missing await, etc.). May emit follow-up \`questions\` for specific deps.
- \`deploy_spawn({})\` — deploy the staged drafts as a NEW Abject. Internally messages Factory.spawn with the manifest, source, and the right owner / parent / registryHint. Use for create flows. No payload: the staged drafts are read from loop state.
- \`deploy_update({objectId?, targetName?})\` — deploy the staged source onto an EXISTING object. Internally hot-swaps the live object via its \`updateSource\` handler, then updates Registry's cached source + manifest, then persists via AbjectStore so the change survives a restart. The target is taken from \`objectId\` (UUID) or \`targetName\` (registered name) in the action payload, or from the task's target if it was started as a modify. If you investigated and discovered you should be modifying an existing object even though the loop kind is \`create\`, pass \`{objectId: "<id>"}\` here.
- \`compose_organism({name, description, organelleNames, interfaceSource?})\` packages EXISTING source-backed objects into ONE Organism: a composite Abject whose organelles (independent internal copies of the named objects) cooperate behind a membrane interface, while external callers see a single object with a single curated surface. The staged drafts define the membrane: \`draft_manifest\` is the organism's public surface and \`draft_source\` (or the explicit \`interfaceSource\`) is the forwarding handler map; when either is missing it is drafted automatically from the organelle manifests. The originals keep running, so remove them afterwards (or tell the user) when the organism replaces them.
- \`extract_organelle({target, organelleName})\` deploys one organelle of an existing organism as a standalone object, carrying a snapshot of its live data. The organism keeps its internal copy and is never modified. Pass \`organelleName: "__interface__"\` for the membrane itself.
- \`reply({text})\` — send an intermediate user-visible chat bubble. Loop continues.
- \`ask_user({question, assumptions?})\` — surface a clarifying question. The user's answer arrives as a new task with the answer in the prompt; finish the current loop with \`done\` after this.

## Terminals

- \`done({result})\` — terminal success. \`result\` is a string (becomes \`report\`), an object (merged into the result), or omitted.
- \`fail({reason})\` — terminal failure. \`reason\` is a precise string describing what couldn't be done and why.

# Recipes

Investigation:
- Discover: \`call("Registry", "ask", {question: "which object handles X?"})\`
- Learn how to use it (PRIMARY): \`call("<Name>", "ask", {question: "how do I call Y? how do I build a good Z? how do I make it look good?"})\` — returns prose usage, examples, and design guidance. This is how you understand an object.
- Reflect (raw, rarely needed): \`call("<Name>", "describe", {})\` — the structured manifest only; it does not teach usage, and asking a dependency already fetches its manifest for validation, so you seldom need this.
- Read source: \`call("Registry", "getSource", {objectId: "<id>"})\`
- Read state: \`call("<Name>", "getState", {})\`
- Read logs: \`call("Console", "getObjectLogs", {objectId: "<id-or-name>", count: 20})\`

Deployment (use the local actions — they read your staged drafts and run the proper multi-message sequence):
- Spawn a new object: \`{ "action": "deploy_spawn" }\` after both \`draft_manifest\` (or \`draft_via_llm({kind: "manifest"})\`) and \`draft_source\` (or \`draft_via_llm({kind: "source"})\`).
- Update an existing object: \`{ "action": "deploy_update" }\` after \`draft_diff\` (preferred for surgical edits) or after \`draft_source\` (only when wholesale rewrite is intended). If the loop started as a modify, the target source is preloaded into \`state.targetSource\` and the deploy target is set automatically. If the loop started as create but you discovered the user actually wanted to modify an existing object (e.g. "fix the Pong game" → you found Pong already exists), pass the target explicitly: \`{ "action": "deploy_update", "objectId": "<id>" }\` or \`{ "action": "deploy_update", "targetName": "Pong" }\`. **deploy_update hot-swaps source ONLY** — it does not rerun \`show()\` or recreate widgets the object already spawned. If the change touches \`show()\`, \`createCanvas\`, or any other widget wiring, also call \`hide()\` then \`show()\` on the target after deploy_update so the new wiring takes effect, OR tell the user to close and re-open the window. An idempotent \`show()\` will silently keep the OLD widgets otherwise, and your fix won't be observable.
- Probe: \`call("<Name>", "probe", {})\` — verifies dep references resolve in the deployed object.

Organism composition:
- Stage the membrane yourself for a curated surface: \`draft_manifest\` (the public methods) and \`draft_source\` (thin forwarders), then \`{ "action": "compose_organism", "name": "...", "description": "...", "organelleNames": ["A", "B"] }\`.
- Or let compose_organism draft the membrane: pass only name, description, and organelleNames.
- Reverse: \`{ "action": "extract_organelle", "target": "<organism>", "organelleName": "A" }\` deploys a standalone copy and leaves the organism intact.

ScrumMaster owns multi-task planning. If the assigned creation/modification task is too broad or needs another specialist first, use \`fail({reason})\` with a concise proposed next scrum rather than trying to split the work locally.

ANTI-PATTERNS — do not do these:
- \`call("Factory", "spawn", ...)\` — you cannot supply the right owner / parentId, and you cannot inline the drafted manifest+source through a JSON action payload. Use \`deploy_spawn\`.
- \`call("Registry", "updateSource", ...)\` — Registry alone won't hot-swap the live object. Use \`deploy_update\`.
- \`call("<DeployedObject>", "updateSource", {source: "<inlined source>"})\` — this hot-swaps the live object but skips Registry's cached source/manifest and AbjectStore persistence, so YOUR FIX WILL BE LOST ON THE NEXT RESTART. Always go through \`deploy_update\`. Inlining tens of kilobytes of source into a JSON action is also wasteful — \`deploy_update\` reads the staged draft directly.

Verification (after deploy):
- Behavioral test: \`call("<DeployedName>", "<method>", <payload>)\` — invoke a real method and check the response.

Persistence:
- Goal scratchpad (per-goal handoff): \`call("GoalManager", "writeGoalData", {goalId, key, value})\` / \`readGoalData\`. This is also how you fulfill your task's declared \`produces\` keys — write each one to the scratchpad with this call (it is a GoalManager method invoked via \`call\`, NOT a top-level action verb).
- KnowledgeBase (cross-session facts): \`call("KnowledgeBase", "remember", {title, content, type, tags})\` / \`recall\`.

# Event emission

Use \`this.changed(aspect, value)\` to publish events to observing Abjects:

\`\`\`js
this.changed('progress', { processed, total });
this.changed('completed', { resultCount });
\`\`\`

\`this.changed\` broadcasts to every Abject that subscribed via \`await this.observe(targetId)\` (a thin helper that sends the universal \`addDependent\` protocol message — both forms are equivalent and you'll see either in existing source). Subscribers implement either \`changed(msg)\` (dispatch by \`msg.payload.aspect\`) or a method named after each aspect (\`progress(msg)\`, \`completed(msg)\`). Both delivery shapes carry the same value.

\`this.emit(toId, eventName, payload)\` is a separate primitive: it sends a single event to one specific recipient whose id you already hold — the first argument is the recipient, the second is the event name. Choose \`this.changed\` for broadcasting to observers (the typical case); choose \`this.emit\` only when targeting a known recipient.

# Architecture for objects with a UI

Author UI objects as **Model-View in the original Smalltalk sense**, with **DCI** and **Design by Contract**:
- **Model**: \`this.data\` is the domain document (plain data: what the object IS) and pure helper methods hold the domain rules. The model never draws and never touches a window/canvas/widget. Transient view state (window/canvas/layout ids, hover, scroll, animation) lives in \`this._\` fields, never in \`this.data\`.
- **View**: one render method displays the model AND the input/event handlers handle the user's interaction with it. The view both shows and controls interaction; on an interaction it applies a model helper then re-renders. No domain rules in the view.
- **Controller**: only when there is more than one view/mode. It selects the KIND of view of the model (which view, switching modes, coordinating views). It is NOT the input path. A single-view object needs no controller.
- **DCI**: name handlers for the use case they perform (the context); express behavior as small role helpers; keep \`this.data\` dumb.
- **Design by Contract**: \`this.ensure(cond, msg)\` for pre/postconditions on every public handler; \`this.invariant(cond, msg)\` inside a \`_checkInvariants()\` helper called after each mutation. Both are provided and throw on failure; the sandbox forbids \`require()\`.

For a complex, stateful UI this Model-View split is often two cooperating Abjects (a model object plus a view object that observes it); for a small app it is two clearly separated sections of one handler map. The detailed drafting rules are applied when you draft source.

# Organisms (composing objects into one)

An Organism is one Abject with an internal registry: organelles (internal ScriptableAbjects) discover each other by name and cooperate behind a membrane interface, and external callers meet a single object with a single curated surface. Reach for \`compose_organism\` when several cooperating objects form one coherent thing and their interplay is an implementation detail: the user should see one name and one interface (a model object plus its view object that always travel together, a pipeline of steps used only as a whole). Keep objects separate when each part is independently useful to the user or to other objects; free-living objects compose through the registry and the ask protocol just fine. Author the membrane thin: each public method forwards to the right organelle via \`await this.call(await this.dep('<OrganelleName>'), '<method>', msg.payload)\`, with contracts at entry and domain logic staying in the organelles. Composition copies the originals (endosymbiosis by copy), so they keep running until deliberately removed; \`extract_organelle\` is the reverse move and leaves the organism intact.

# Discipline

1. **Ask before guessing.** When you don't know whether an object exists, what its API is, what its state means, or what method to call — \`ask\`. The Registry, the target object, or any candidate dep will answer.
2. **Investigate before drafting — \`ask\` is how you learn to use an object.** \`ask\` returns prose usage: examples, patterns, design guidance, the right way to call something. \`describe\` is programmatic reflection (the raw manifest) — it lists method names/params but does NOT teach usage, so it is rarely what you want, and you almost never need to call it yourself: asking a dependency automatically fetches its manifest for call-validation. So: for CREATIONS, \`ask\` the Registry what's available, then \`ask\` each chosen dependency open questions — "how do I use you?", "how do I build a good X?", "how do I make this look good?" — and only \`draft\` once you understand the surface. For MODIFICATIONS, \`ask\` the target your open questions, \`getSource\` to read its current code, \`getState\` if relevant. Prefer \`ask\` over \`describe\` everywhere; reach for \`describe\` only when you specifically need the raw structured manifest.

   **Let the goal's named requirements drive OPEN questions before you commit to an approach.** When the goal names a quality or capability — a presentation style ("3D", "animated"), an input modality (mouse, voice), sound, persistence, networking — your first question to the providing dependency is "what do you offer for <that requirement>?", asked before you settle on how to build it. A modify loop makes this easy to skip: the existing source suggests an approach, and questions shaped as "confirm the commands I already plan to use" get exactly the narrow answer they asked for, leaving a purpose-built capability undiscovered while you hand-roll an imitation on the surface the old code happened to use. One open capability question per named requirement is cheap; rework after shipping the imitation is not.
3. **Validate before deploying; compile first, don't re-read.** After any \`draft_source\`, \`draft_diff\`, or \`draft_via_llm\`: go straight to \`compile\` (it localizes the one broken spot far faster than re-reading), then \`validate_calls\`; for non-trivial logic also \`review_semantics\`. When compile reports a syntax error it already shows the failing line and context, so fix it with \`replace_handler\`/\`draft_diff\` at that line or regenerate with \`draft_source\`; do NOT \`read_draft\` to relocate it. Reading the draft repeatedly with no edit between reads is a stall that burns your step budget and leaves nothing to verify.

   **Once compile is clean and validate_calls reports zero issues, review_semantics is ADVISORY — ship and verify live instead of polishing blind.** Fix its findings when they name a real wrong-payload/wrong-method bug, but cap yourself at TWO review_semantics rounds: a deployed object answering real calls teaches you more per step than a third blind review pass, and behavioral verification catches what matters. Budget the endgame explicitly — deploy + behavioral checks + a screenshot need ~5 steps, so start deploying while you still have them. A task that dies polishing an undeployed draft delivered nothing.
4. **Verify behavior after deploying — really test what the user asked for.** After deploy, you must exercise the specific behavior the user requested, not just check that the object exists. \`call show\` and reading \`getState\` are not enough by themselves.

   For each behavior the user mentioned, send a \`call\` that drives it and check the result via \`getState\` or the response. Examples:
   - User said "keyboard controls W/S move the paddle" → \`call("<canvasId>", "input", { type: "keydown", code: "KeyS" })\` then \`call("<obj>", "getState")\` and confirm the paddle Y changed.
   - User said "click the button to reset" → send a synthetic mousedown/mouseup at the button's coordinates via \`input\`.
   - User said "fetches data on a timer" → wait briefly (one or two \`getState\` calls separated by a real action), confirm the state advanced.
   - User said "responds to peer messages" → send the message yourself via \`call\` and check the response.

   If the requested behavior is keyboard input, mouse input, or any input event, the canvas widget id is in your draft source — find it from \`state.draftSource\` (look for the \`createCanvas\` call), or read the running object's state for the canvas id, then \`call(<canvasId>, "input", { type, code | x | y, ... })\`.

   **Synthetic input is a partial test, not full verification.** A passing \`call(<canvasId>, "input", payload)\` only proves the input-target's handler logic works. It does NOT exercise the real compositor → window → layout → canvas → inputTargetId chain (the synthetic call dispatches straight to the handler). Before declaring input wired correctly, ALSO check that:
   1. The drafted source passes \`inputTargetId: this.id\` explicitly to \`createCanvas\` — never rely on the \`msg.routing.from\` default for canvas apps.
   2. The handler reads fields from \`msg.payload\` (the real shape and the synthetic shape are identical — both wrap fields under \`msg.payload\`). Do NOT add a "top-level fallback" — there is no top-level event shape.

   "I called \`getState\` and the numbers look fine" is NOT verification. \`done\` only after at least one synthetic exercise of each user-requested behavior produced the expected change.

   **State your own draft sets is a claim, not evidence.** A mode/style/flag field your source writes (e.g. \`presentation: '3d'\`) merely restates the code's intent — checking it verifies nothing. Verify each requirement against what the user literally asked for, using evidence the draft cannot fabricate: exercised behavior, or the rendered image for visual requirements.

   ${this.visionCapable === false
    ? `**Visual verification is UNAVAILABLE in this configuration.** Every LLM model currently configured is text-only — screenshots can be captured (proving a window exists) but neither you nor any tier can see them, so never describe or judge how a UI looks. Verify what you can without eyes: review the layout code (every layout child needs sizePolicy + preferredSize; every widget must be added to a layout), check behavior via \`getState\` and method calls, and state plainly in your final result that the UI was NOT visually inspected because no vision-capable model is configured — the user can enable one to get visual verification.`
    : `**See what you built — visual work needs a visual check.** \`getState\` proves logic; it says nothing about whether the thing looks right. For ANY object with a window, canvas, or drawn UI — and ALWAYS when the goal mentions look, layout, alignment, spacing, color, "beautiful", "polished", or a redesign — capture a screenshot and inspect it before finishing: \`call("Screenshot", "captureWindow", { objectId: "<the object's FULL id — never truncate>" })\`. The capture shows the window as composited on screen, INCLUDING its 3D scene nodes — so for a 3D goal, judge the meshes/lighting/depth in the image itself (an empty court where meshes should be means the scene did not render). It is a screen crop, so raise the window first if another window overlaps it. The rendered image is attached to your next observation; judge it against the goal — centering, alignment, spacing (no accidental empty voids), color cohesion, typographic hierarchy, legibility of every state (e.g. used/disabled vs active), and overall polish. If anything looks off, edit, redeploy, and screenshot again. Do NOT declare a visual goal done on the strength of \`getState\` alone — Round-after-round rework happens precisely when an agent reports "looks beautiful" without ever looking. (Make sure the window is actually shown first. A capture that comes back with NO IMAGE means the verification did NOT happen — fix the capture — pass the full owner id or the windowId from show(), or find the window via Screenshot.listWindows — and only claim visual results after you have actually seen an image.)`}

   **Verify once, don't grind.** Each behavior needs ONE representative check, not a sweep. A single correct guess and a single wrong guess prove the guess handler; you do not need to play the whole game. Repeating the same \`call\` (e.g. guessing letter after letter, or polling \`getState\` over and over) burns steps and triggers loop-steering without adding confidence. Drive each distinct behavior once, take one screenshot for the visual, then \`done\`.

   **A timeout is a routing/await bug, not a deadlock.** If \`show\`, a window build, or any call times out, the cause is almost always a recipient addressed by a bare name instead of a resolved AbjectId (resolve via \`this.dep(name)\` first), or a result that was never awaited — NOT the act of awaiting inside a handler, which is correct and supported. Do not "fix" a timeout by detaching the build into a fire-and-forget chain; fix the recipient or the missing await. When verifying a window opened, drive \`show\` with a short timeout and then poll \`getState\` for the window/canvas ids, rather than sitting on a long blocking call.

   **Clean up probe artifacts before finishing.** Anything you create purely to explore or verify — probe windows, scratch widgets, throwaway objects — must be destroyed once it has served its purpose (e.g. \`destroyWindowAbject\` for a window you opened to test rendering). The user's desktop should end the loop containing only what they asked for.
5. **Diagnostic prompts terminate with a report.** If the user asked HOW something works, WHY it's failing, or to EXPLAIN behavior — answer with \`done({result: "<written report>"})\` after enough read-only calls (\`describe\`, \`ask\`, \`getState\`, \`getObjectLogs\`). Do not draft, do not deploy.
6. **Never invent method names or payload keys.** If a method isn't on the target's \`describe\` output and isn't in its \`ask\` answer, it doesn't exist. Either \`ask\` again with a sharper question, or \`fail\` with a precise reason naming the available alternatives.
7. **Storage scopes — pick the right one for each piece of data.** The decision rule: *if two people both ran a clone of this object, should they each see the same value?* If yes, the data belongs to the object. If no, it belongs to the user.

   - **Same-turn context** — keep it in your response.
   - **Per-goal handoff between subtasks** — goal scratchpad via \`call("GoalManager", "writeGoalData", {goalId, key, value})\` / \`call("GoalManager", "readGoalData", {goalId, key})\` (GoalManager methods, invoked with the \`call\` action — not top-level verbs).
   - **Shared structured records** — when the data is records other objects or the user may care about later (entries a tracker collects, rows a logger appends, results an analysis produces), prefer the workspace's shared collection store over private \`this.data\`. Discover it via the registry and \`ask\` it for current usage: collections are created with an optional schema, written through insert/update/remove (each write emits a record change event other objects can react to), and read back with find or SQL-style query. Data in a collection is queryable and composable by objects that have never heard of yours; data in \`this.data\` is visible only to your object. Keep \`this.data\` for the object's own document.
   - **Internal object data (\`this.data\`)** — state intrinsic to the object's purpose that SHOULD travel with the object when it is cloned, restored from snapshot, or shared with another peer. Examples: a counter the object reports, the contents of a note an object represents, learned parameters, accumulated history that defines the object. ScriptableAbject source code reads and writes \`this.data\` (a plain JSON-serializable object) directly, e.g. \`this.data.count = (this.data.count ?? 0) + 1\`. Persist with \`await this.saveData()\` after mutations you want to survive restart and travel with clones. Hot-reloads (\`updateSource\` / \`deploy_update\`) preserve \`this.data\`. Keep \`this.data\` to the DOCUMENT — the content the object represents — and nothing more.
   - **Transient runtime state stays OUT of \`this.data\`** — window/canvas/layout ids, in-progress edit buffers and cursor position, pan/zoom, selection, drag state, hit-test caches, and anything tied to a currently-open window are ephemeral. Hold them in plain instance fields (\`this._sessions\`, \`this._cursor\`, …), NOT \`this.data\`. Instance fields are not persisted and not cloned, which is exactly right: they are meaningless after a restart and are rebuilt when a window (re)opens. Persisting them instead bloats every snapshot and ties saved documents to dead window ids. (A multi-window editor keeps its per-window sessions in \`this._sessions\`; only the maps/notes/documents go in \`this.data\`.)
   - **Persist at commit granularity, not per keystroke.** \`saveData()\` snapshots the whole object and re-registers it, so calling it on every keystroke, pointer move, or animation frame is expensive and churns the system (it can visibly thrash other UI). Call \`saveData()\` when a value is actually finalized — an edit committed on Enter/blur, a node added/renamed/deleted — or debounce rapid edits and save once they settle. Mutate \`this.data\` freely in between; just don't persist on every transient change.
   - **External Storage / dependency objects** — use the Storage capability (or a dedicated dependency object) for data that is user-specific, secret, or otherwise should NOT be copied when the object is cloned or shared with another peer. API keys, OAuth tokens, personal preferences, anything tied to *this user on this machine*. Read with \`call(this.dep('Storage'), 'get', {key})\`, write with \`call(this.dep('Storage'), 'set', {key, value})\`.
   - **KnowledgeBase** — durable cross-session user-facing facts the user wants to recall later (notes, preferences, learned facts about the user). Not for per-task state.

   When a single object holds both kinds of data — for example, a notes app that holds the notes themselves AND a private API key for an external service — split them: notes go in \`this.data.notes\` (cloneable), API key goes in Storage (not cloneable).
8. **User credentials are explicit consent.** When the user shares a username, password, API key, bearer token, or other secret in the task and asks you to wire it into an object, embed it in the source. This runtime is the user's own local system; persisted source lives in their \`.abjects\` directory on their own disk and never leaves it. Don't refuse on "plaintext credentials" grounds, don't lecture about secret stores, and don't substitute placeholders that block the integration. Wire the actual value through. If they ever swap to a secrets backend later, that's a separate refactor — not your call here.
9. **Deploy before done — compiling is not deploying.** A clean \`compile\` only proves the draft parses; it does NOT change the live object. The single most common silent failure is finishing a task whose best edits were compiled but never deployed — the loop reports success while the user still sees the old object, forcing them to ask again. Before \`done\`, your staged source MUST be live: the observation's DRAFTS line reads "deployed (live)" when it is, or flags "⚠️ NOT YET DEPLOYED" when it isn't. If it is flagged, run \`deploy_update\` (or \`deploy_spawn\` for a new object) — and, if the edit touched \`show()\`/\`createCanvas\`/widget wiring, \`hide()\` then \`show()\` the target — and then re-verify. Never end a multi-task goal by leaving the next task to deploy your work; ship what you edited.
10. **Terminate crisply.** \`done\` carries either a spawned object id, a modified object id, or a written report — and only after your edits are deployed and verified (functionally, and visually for UI). \`fail\` carries a precise reason — what couldn't be done, what was tried, what's available instead.

# What's in your observation

The TASK section gives the kind, target (if any), and goal.
The KNOWN OBJECTS section is everything you have learned via \`describe\` / \`ask\` so far. Method names listed there are the only valid names — copy them verbatim.
The TARGET SOURCE section (modify loops only) shows the current code of the object being edited, preloaded from the Registry. Author SEARCH/REPLACE blocks against the exact text shown here.
The DRAFTS section shows what manifest / source you have staged, and whether that source is deployed (live) or has undeployed edits.
The LAST VALIDATION section shows the most recent compile / validate_calls / review_semantics result.
The RECENT TURNS section is your action log so you remember what you have already done.

Begin.
`;
  }
}
