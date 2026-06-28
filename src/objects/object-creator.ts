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

import { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, ObjectRegistration, SpawnRequest, SpawnResult } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { IntrospectResult } from '../core/introspect.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage } from '../llm/provider.js';
import type { AgentAction } from './agent-abject.js';
import { Log } from '../core/timed-log.js';
import { applyDiff, parseSearchReplaceBlocks, levenshtein } from './source-diff.js';

const log = new Log('OBJECT-CREATOR');

/** Methods provided by the Abject / ScriptableAbject framework; valid on every object. */
const FRAMEWORK_PROVIDED_METHODS = ScriptableAbject.PROTECTED_HANDLERS;

export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
const OBJECT_CREATOR_INTERFACE = 'abjects:object-creator' as InterfaceId;

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
  kind: 'unknown-dep' | 'unknown-method' | 'name-string-recipient';
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
  deployedViaUpdateSource?: boolean;
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
  /** Reverse index: AgentAbject's ticketId → our taskId, for taskResult lookup. */
  private taskIdByTicket = new Map<string, string>();

  constructor() {
    super({
      manifest: {
        name: 'ObjectCreator',
        description:
          'Creates new Abjects and modifies existing ones through a ReAct loop over message passing. ' +
          'Investigates targets and dependencies via the universal ask protocol and describe introspection, drafts code, validates drafts against live manifests, deploys, and verifies behavior. ' +
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

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ObjectCreator — Abject Authoring & Modification Agent

I author and modify Abject source code via an LLM-driven loop that reads existing source from the Registry, drafts diffs, validates calls, reviews semantics, and deploys updates through the standard ScriptableAbject update path.

What I handle:
- Single-object authoring (new widgets, apps, bridges, proxies, MCP wrappers).
- Modifying existing Abject source — adding methods, events, manifest entries; fixing handlers; refactoring an Abject's implementation.
- Investigation that ends in code edits (read source, diagnose, fix).

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
    const manifest = action.manifest as AbjectManifest | undefined;
    if (!manifest || typeof manifest !== 'object' || !manifest.name || !manifest.interface) {
      return { ok: false, summary: 'draft_manifest: malformed', error: 'manifest must be an AbjectManifest with name and interface' };
    }
    state.draftManifest = manifest;
    const usedObjects = action.usedObjects;
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
    const envelopes = [action, action.params, action.arguments, action.input]
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
    'call', 'draft_manifest', 'draft_source', 'draft_diff', 'load_target', 'draft_via_llm',
    'compile', 'validate_calls', 'review_semantics', 'deploy_spawn', 'deploy_update',
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
      return { ok: false, summary: 'draft_source: missing source', error: 'source must be a non-empty string (pass it as the `source` field)' };
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
  private async opDraftDiff(state: LoopState, action: AgentAction): Promise<{ ok: boolean; summary: string; error?: string }> {
    const blocksText = this.actionField(action, ['blocks', 'diff', 'search_replace', 'searchReplace', 'patch', 'edits']) as string | undefined;
    if (typeof blocksText !== 'string' || blocksText.length === 0) {
      return { ok: false, summary: 'draft_diff: missing blocks', error: 'blocks must be a non-empty string of SEARCH/REPLACE blocks, passed as the `blocks` field. Format: <<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE. For a full rewrite use draft_source instead.' };
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
        error: `Some SEARCH/REPLACE blocks could not be applied:\n${errorLines}${parseNote}\n\nFix the failing blocks and call draft_diff again with a fresh blocks payload. If a block stays hard to match, fall back to draft_source with the full corrected source.`,
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
    const nameOrId = (action.objectId ?? action.target ?? action.targetName ?? action.objectName) as string | undefined;
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
    const kind = action.kind as 'manifest' | 'source' | undefined;
    const instructions = (action.instructions as string | undefined) ?? '';
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
        { messages: [systemMessage(sys), userMessage(user)] as LLMMessage[], options: { tier: 'smart', maxTokens: 16384, cacheKey: state.goal.slice(0, 64) } },
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
   * Augment a raw compile error with a likely location. JS engine messages like
   * "Unexpected token '}'" carry no position for sandboxed source, so we locate
   * the first bracket imbalance ourselves and show the surrounding lines. The
   * original error is preserved; this only adds a hint plus a draft_source
   * fallback note for errors that resist localization.
   */
  private augmentCompileError(source: string, err: string): string {
    const lines = source.split('\n');
    const imbalance = this.findBracketImbalance(source);
    let detail = '';
    if (imbalance) {
      const ctxStart = Math.max(0, imbalance.line - 3);
      const ctxEnd = Math.min(lines.length, imbalance.line + 2);
      const ctx = lines.slice(ctxStart, ctxEnd)
        .map((l, k) => `  ${ctxStart + k + 1 === imbalance.line ? '>' : ' '} ${ctxStart + k + 1}: ${l}`)
        .join('\n');
      detail = `\n\nLikely bracket problem: ${imbalance.message} (near line ${imbalance.line}):\n${ctx}`;
    }
    detail += `\n\nSource is ${lines.length} lines. If the syntax error is hard to localize, regenerate the whole object with draft_source rather than patching around it.`;
    return `${err}${detail}`;
  }

  /**
   * Lightweight bracket/paren/brace balance scanner. Skips string literals,
   * template literals, and comments so their contents don't count. Returns the
   * first imbalance (or the earliest unclosed opener at EOF), or null when
   * balanced. Best-effort — regex literals are treated as division, so a hint
   * may occasionally be off, but the original error is always preserved.
   */
  private findBracketImbalance(source: string): { line: number; message: string } | null {
    const stack: { ch: string; line: number }[] = [];
    const closerToOpener: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    let line = 1;
    let inStr: string | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      const prev = source[i - 1];
      if (c === '\n') { line++; inLineComment = false; continue; }
      if (inLineComment) continue;
      if (inBlockComment) { if (prev === '*' && c === '/') inBlockComment = false; continue; }
      if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
      if (c === '/' && source[i + 1] === '/') { inLineComment = true; continue; }
      if (c === '/' && source[i + 1] === '*') { inBlockComment = true; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '(' || c === '[' || c === '{') { stack.push({ ch: c, line }); continue; }
      if (c === ')' || c === ']' || c === '}') {
        const open = stack.pop();
        if (!open) return { line, message: `unexpected closing '${c}' with no matching opener` };
        if (open.ch !== closerToOpener[c]) return { line, message: `'${c}' closes a '${open.ch}' opened on line ${open.line}` };
      }
    }
    if (stack.length > 0) {
      const last = stack[stack.length - 1];
      return { line: last.line, message: `'${last.ch}' opened on line ${last.line} is never closed` };
    }
    return null;
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

    state.lastValidation = { ...(state.lastValidation ?? {}), calls: errors };

    if (errors.length === 0) {
      return { ok: true, summary: 'validate_calls: 0 issues' };
    }

    const summary = `validate_calls: ${errors.length} issue${errors.length === 1 ? '' : 's'} — ` +
      errors.slice(0, 3).map(e => `${e.depName ?? '?'}.${e.methodName}`).join(', ') +
      (errors.length > 3 ? ', …' : '');
    return { ok: false, summary, issues: errors, error: this.formatCallErrors(errors) };
  }

  /**
   * LLM semantic review against the staged drafts. Reads manifests + usage
   * guides + drafts; returns VERIFIED or a structured issue list with optional
   * follow-up questions for specific deps. Balanced tier, 4k tokens.
   */
  private async opReviewSemantics(state: LoopState): Promise<{ ok: boolean; summary: string; error?: string; result?: SemanticReviewResult }> {
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
    const summary = result.verified
      ? 'review_semantics: VERIFIED'
      : `review_semantics: ${errs} error${errs === 1 ? '' : 's'}, ${result.questions.length} question${result.questions.length === 1 ? '' : 's'}`;
    return { ok: result.verified, summary, result, error: result.verified ? undefined : this.formatSemanticIssues(result) };
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

    return {
      ok: true,
      summary: `deploy_spawn: ${state.draftManifest.name} spawned as ${result.objectId.slice(0, 8)}`,
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
    const explicitId = action.objectId;
    const explicitName = action.targetName ?? action.targetObjectName;
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
    state.targetObjectId = targetId; // Stamp so finalizeLoop emits objectModified correctly.
    if (targetLabel && !state.targetName) state.targetName = targetLabel;

    return {
      ok: true,
      summary: `deploy_update: ${targetLabel ?? targetId.slice(0, 8)} updated (${state.draftSource.split('\n').length} lines)`,
      data: { objectId: targetId },
    };
  }

  /** Send an intermediate user-visible chat bubble. Loop continues. */
  private async opReply(_state: LoopState, action: AgentAction, callerId?: AbjectId): Promise<{ ok: boolean; summary: string }> {
    const text = (action.text as string | undefined) ?? '';
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
    const question = (action.question as string | undefined) ?? '';
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
    ].join('\n');
  }

  private draftSourceSystemPrompt(): string {
    return [
      'You are drafting handler-map JavaScript for a ScriptableAbject. Output ONE ```javascript code block.',
      'Format: a single parenthesized object literal: ({ method(msg) { ... }, ... }).',
      'Each handler takes a single `msg` argument; payload is `msg.payload`. Inter-object work is `await this.call(target, method, payload)` where `target` is a RESOLVED AbjectId.',
      'In generated handler code, `this.call(target, …)` routes by AbjectId only — the bus does NOT resolve names on the send path. Resolve a dependency to its id first: `const id = await this.dep("Name")` (or `this.find("Name")`), then `await this.call(id, method, payload)` — or inline `await this.call(this.dep("Name"), method, payload)`. NEVER pass a bare name string as the recipient (e.g. `this.call("WidgetManager", …)`); that call is delivered nowhere and times out. (This differs from the ObjectCreator `call` ACTION you use to investigate, which DOES accept a bare name — generated code does not.) Ids returned at runtime (window/canvas/layout ids from create*) are already resolved; pass them directly.',
      'Build windows/canvas from an async handler and AWAIT each step in order. Awaiting an inter-object call inside your own handler is correct and does NOT deadlock — the reply is delivered while the handler is suspended. A build that times out means a wrong recipient or a missing await, never the awaiting itself; do not detach the build into a fire-and-forget chain to "avoid a deadlock". Ask the window/canvas factory for its build recipe before drafting.',
      'Use ONLY methods listed in the provided dependency manifests / usage guides. Do not invent method names.',
      'Method names that are not in the framework or in a dependency\'s manifest do not exist — pick a real one or restructure.',
      'When a dependency\'s usage guide documents a higher-level building block that fits the need, compose it rather than re-implementing equivalent behavior from low-level primitives. Reuse the building blocks; drop to primitives only for what the building blocks do not cover.',
      'Prefer composing high-level building blocks over hand-writing equivalents — e.g. render markdown with a markdown-capable label/widget rather than writing your own parser and text-layout engine on a canvas. This keeps the object small and the formatting correct.',
      'Keep each object focused. When a single object would grow very large (many hundreds of lines) or bundles a reusable sub-capability (a parser, a layout engine, a data store), split that capability into its own Abject and call it. Smaller, composed objects are easier to verify and keep the build loop fast (a huge source blows the context budget and makes the loop lose track of what it already tried).',
    ].join('\n');
  }

  private semanticReviewerSystemPrompt(): string {
    return [
      'You are a strict code reviewer for an Abject handler map. You receive: the new object\'s manifest, the drafted source, and for each known dependency its manifest methods + usage guide.',
      'Flag SEMANTIC issues that a static method-name check cannot catch: wrong payload shape, enum-like string values not listed in the usage guide (including MCP toolName values), missing await on consumed results, event handler name / payload shape mismatches, cached dep IDs in state.',
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
    const lines = ['validate_calls flagged the following — fix using ONLY methods listed in the dependency manifests:'];
    for (const e of errors) {
      if (e.kind === 'unknown-method') {
        lines.push(`- ${e.depName}.${e.methodName} is not a method. Available: ${(e.availableMethods ?? []).join(', ')}`);
      } else if (e.kind === 'name-string-recipient') {
        lines.push(`- this.call("${e.depName}", "${e.methodName}", …) addresses a recipient by name. Message recipients are AbjectIds; the bus does not resolve names on the send path, so this call is delivered nowhere and times out. Resolve the id first: const id = await this.dep("${e.depName}"); await this.call(id, "${e.methodName}", …) — or inline await this.call(this.dep("${e.depName}"), "${e.methodName}", …). (Ids returned at runtime — window/canvas/layout ids from create* — are already resolved and fine to pass directly.)`);
      } else {
        lines.push(`- Dependency "${e.depName}" was not discovered yet. Call describe / ask on it before calling its methods.`);
      }
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
    state.terminal = { kind: 'done', result: action.result };
    return { ok: true, summary: 'done', terminal: true };
  }

  private opFail(state: LoopState, action: AgentAction): { ok: boolean; summary: string; terminal: true } {
    const reason = typeof action.reason === 'string' ? action.reason : 'unspecified';
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
    const timeout = typeof action.timeout === 'number' ? action.timeout : 30000;

    if (!target || typeof target !== 'string') {
      return { ok: false, summary: 'call: missing target', error: 'target is required and must be a string (UUID or registered name)' };
    }
    if (!method || typeof method !== 'string') {
      return { ok: false, summary: 'call: missing method', error: 'method is required and must be a string' };
    }

    const resolvedId = await this.resolveTarget(target);
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
      summary: summary ?? `call ${target}.${method}: ok`,
      data: response,
    };
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
            maxSteps: 30,
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

  // ── Observe / Act ─────────────────────────────────────────────────────

  private async handleObserve(taskId: string): Promise<{ observation: string; tier: string }> {
    // Look up by AgentAbject-assigned ticketId; AgentAbject calls back with the
    // taskId we sent on startTask, so look for an entry whose state matches.
    // Since we keyed by ticketId, find by taskId-in-context: AgentAbject passes
    // the original taskId we provided. That's the same as our ticketId.
    const extra = this.tasks.get(taskId);
    if (!extra) {
      return { observation: 'No active task. Reply with done({result: "no task"}).', tier: 'smart' };
    }
    extra.state.turn += 1;
    return { observation: this.renderObservation(extra.state), tier: 'smart' };
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
      lines.push(`  target: ${state.targetName ?? '?'}${state.targetObjectId ? ` (${state.targetObjectId.slice(0, 8)})` : ''}`);
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
        lines.push(`  ### ${dep.depName}${dep.depId ? ` (${dep.depId.slice(0, 8)})` : ''}`);
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
    lines.push(`  source:   ${state.draftSource ? `${state.draftSource.split('\n').length} lines` : '(not drafted)'}`);
    lines.push('');

    if (state.lastValidation) {
      lines.push('LAST VALIDATION');
      const v = state.lastValidation;
      if (v.compile !== undefined) lines.push(`  compile:          ${v.compile === '' ? 'OK' : v.compile.slice(0, 120)}`);
      if (v.calls) lines.push(`  validate_calls:   ${v.calls.length} issue${v.calls.length === 1 ? '' : 's'}`);
      if (v.semantics) {
        const errs = v.semantics.issues.filter(i => i.severity === 'error').length;
        lines.push(`  review_semantics: ${v.semantics.verified ? 'VERIFIED' : `${errs} error${errs === 1 ? '' : 's'}`}`);
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
    return `You are ObjectCreator, a code-writing agent inside the Abjects distributed message-passing system. You create new Abjects, modify existing ones, and answer diagnostic questions about Abjects.

# The system

Every Abject answers two protocols:
- \`describe\` returns its manifest — the authoritative list of methods, events, and tags.
- \`ask\` answers ANY natural-language question about how to use it, what it does, or what it is currently doing.

The ask protocol is universal — no object is exempt. The Registry answers questions about what objects exist ("is there an object that handles email?"). Each user object answers questions about its own API and behavior ("how do I add a button?", "what does your getState return?", "why is your status degraded?"). Every MCP server, capability, skill, and system service answers the same way.

There are no "tool calls" in this system. There is one inter-object operation: send a message via \`call(target, method, payload)\`. Every reachable object — every MCP server, capability, skill, system service, and user object — is a message target.

# Response format

Emit EXACTLY ONE JSON action per turn, wrapped in a \`\`\`json code block. Nothing else in the response.

# Actions

## The primitive: call

\`\`\`json
{ "action": "call", "target": "<name-or-uuid>", "method": "<method>", "payload": { ... }, "timeout": 30000 }
\`\`\`

\`target\` is either a UUID, a registered object name (e.g. "Registry", "ChatManager", "TelegramBridge"), or a system-service name (e.g. "Console", "GoalManager", "KnowledgeBase"). \`payload\` defaults to {}. \`timeout\` defaults to 30000ms; raise for long operations like Factory.spawn.

## Local operations (no message target)

- \`load_target({objectId?, targetName?})\` — adopt an EXISTING object as this loop's modify target: resolves the name/UUID, loads its current source into loop state, and switches the loop to a modify. Use this when the loop started without a target (kind \`create\`) but you discovered — via \`call("Registry", "ask"/"discover", …)\` or \`describe\` — that the goal is really about an object that already exists (e.g. "fix the GraphViewer window" → GraphViewer is already registered). After \`load_target\`, edit with \`draft_diff\` and ship with \`deploy_update\` (no need to repeat the id). For a genuinely new object, skip this and use \`draft_source\` instead.
- \`draft_manifest({manifest, usedObjects?})\` — stage a manifest you've authored. Used before \`deploy_spawn\`. Include an \`icon\` (a single emoji that fits the object, e.g. 🌤 / 📝 / 🎮) — it appears next to the object's name in launchers.
- \`draft_source({source})\` — stage handler-map source you've authored. The format is a single parenthesized object literal: \`({ method(msg) { ... } })\`. Use this for new objects (create flow).
- \`draft_diff({blocks})\` — apply SEARCH/REPLACE blocks to the existing source. **Strongly prefer this for any modification of an existing object** — it lets you edit a few lines without re-emitting the whole file. Each block:

  \`\`\`
  <<<<<<< SEARCH
  exact lines from the current source, including indentation
  =======
  the replacement lines
  >>>>>>> REPLACE
  \`\`\`

  Multiple blocks may appear in one \`blocks\` payload and are applied in order. SEARCH must match a UNIQUE location in the current source — include 2–3 lines of surrounding context if a snippet would otherwise match in more than one place. Whitespace is forgiven (line-trimmed match), but matching the indentation exactly is safer. Successive \`draft_diff\` calls stack on the prior result, so you can layer fixes. To insert new code, use a SEARCH that matches a nearby anchor and include both the anchor and your insertion in REPLACE.
- \`draft_via_llm({kind: "manifest" | "source", instructions})\` — ask an LLM to draft for you. It sees current loop state. Use when authoring a brand-new manifest or source from scratch is too large for one think-step. Do NOT use this for modifications of existing objects — use \`draft_diff\` instead, since the LLM consistently truncates "preserve everything else" rewrites.
- \`compile()\` — run a syntax check on the staged source. Fails fast on parse errors.
- \`validate_calls()\` — static check: every \`this.call(x, "method", …)\` site is checked against the live manifest of the target dep. Run AFTER compile.
- \`review_semantics()\` — LLM reviewer reads the drafts plus all known dependency manifests + usage guides and flags semantic issues (wrong payload shape, enum-like values not in the guide, missing await, etc.). May emit follow-up \`questions\` for specific deps.
- \`deploy_spawn({})\` — deploy the staged drafts as a NEW Abject. Internally messages Factory.spawn with the manifest, source, and the right owner / parent / registryHint. Use for create flows. No payload: the staged drafts are read from loop state.
- \`deploy_update({objectId?, targetName?})\` — deploy the staged source onto an EXISTING object. Internally hot-swaps the live object via its \`updateSource\` handler, then updates Registry's cached source + manifest, then persists via AbjectStore so the change survives a restart. The target is taken from \`objectId\` (UUID) or \`targetName\` (registered name) in the action payload, or from the task's target if it was started as a modify. If you investigated and discovered you should be modifying an existing object even though the loop kind is \`create\`, pass \`{objectId: "<id>"}\` here.
- \`reply({text})\` — send an intermediate user-visible chat bubble. Loop continues.
- \`ask_user({question, assumptions?})\` — surface a clarifying question. The user's answer arrives as a new task with the answer in the prompt; finish the current loop with \`done\` after this.

## Terminals

- \`done({result})\` — terminal success. \`result\` is a string (becomes \`report\`), an object (merged into the result), or omitted.
- \`fail({reason})\` — terminal failure. \`reason\` is a precise string describing what couldn't be done and why.

# Recipes

Investigation:
- Discover: \`call("Registry", "ask", {question: "which object handles X?"})\`
- Inspect: \`call("<Name>", "describe", {})\` — returns the manifest.
- Learn: \`call("<Name>", "ask", {question: "how do I call Y?"})\` — returns prose usage.
- Read source: \`call("Registry", "getSource", {objectId: "<id>"})\`
- Read state: \`call("<Name>", "getState", {})\`
- Read logs: \`call("Console", "getObjectLogs", {objectId: "<id-or-name>", count: 20})\`

Deployment (use the local actions — they read your staged drafts and run the proper multi-message sequence):
- Spawn a new object: \`{ "action": "deploy_spawn" }\` after both \`draft_manifest\` (or \`draft_via_llm({kind: "manifest"})\`) and \`draft_source\` (or \`draft_via_llm({kind: "source"})\`).
- Update an existing object: \`{ "action": "deploy_update" }\` after \`draft_diff\` (preferred for surgical edits) or after \`draft_source\` (only when wholesale rewrite is intended). If the loop started as a modify, the target source is preloaded into \`state.targetSource\` and the deploy target is set automatically. If the loop started as create but you discovered the user actually wanted to modify an existing object (e.g. "fix the Pong game" → you found Pong already exists), pass the target explicitly: \`{ "action": "deploy_update", "objectId": "<id>" }\` or \`{ "action": "deploy_update", "targetName": "Pong" }\`. **deploy_update hot-swaps source ONLY** — it does not rerun \`show()\` or recreate widgets the object already spawned. If the change touches \`show()\`, \`createCanvas\`, or any other widget wiring, also call \`hide()\` then \`show()\` on the target after deploy_update so the new wiring takes effect, OR tell the user to close and re-open the window. An idempotent \`show()\` will silently keep the OLD widgets otherwise, and your fix won't be observable.
- Probe: \`call("<Name>", "probe", {})\` — verifies dep references resolve in the deployed object.

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

# Discipline

1. **Ask before guessing.** When you don't know whether an object exists, what its API is, what its state means, or what method to call — \`ask\`. The Registry, the target object, or any candidate dep will answer.
2. **Investigate before drafting.** For modifications: \`describe\` the target, \`ask\` it any open questions, \`getSource\` to see its current code, \`getState\` if relevant. For creations: \`ask\` the Registry for what's available, \`describe\` likely deps, \`ask\` each chosen dep for usage examples. Only draft when the call surface is known.
3. **Validate before deploying.** After any \`draft_source\`, \`draft_diff\`, or \`draft_via_llm\`: always \`compile\`; then \`validate_calls\`; for non-trivial logic also \`review_semantics\`. Deploy only when compile is clean and validators agree.
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

   **A timeout is a routing/await bug, not a deadlock.** If \`show\`, a window build, or any call times out, the cause is almost always a recipient addressed by a bare name instead of a resolved AbjectId (resolve via \`this.dep(name)\` first), or a result that was never awaited — NOT the act of awaiting inside a handler, which is correct and supported. Do not "fix" a timeout by detaching the build into a fire-and-forget chain; fix the recipient or the missing await. When verifying a window opened, drive \`show\` with a short timeout and then poll \`getState\` for the window/canvas ids, rather than sitting on a long blocking call.

   **Clean up probe artifacts before finishing.** Anything you create purely to explore or verify — probe windows, scratch widgets, throwaway objects — must be destroyed once it has served its purpose (e.g. \`destroyWindowAbject\` for a window you opened to test rendering). The user's desktop should end the loop containing only what they asked for.
5. **Diagnostic prompts terminate with a report.** If the user asked HOW something works, WHY it's failing, or to EXPLAIN behavior — answer with \`done({result: "<written report>"})\` after enough read-only calls (\`describe\`, \`ask\`, \`getState\`, \`getObjectLogs\`). Do not draft, do not deploy.
6. **Never invent method names or payload keys.** If a method isn't on the target's \`describe\` output and isn't in its \`ask\` answer, it doesn't exist. Either \`ask\` again with a sharper question, or \`fail\` with a precise reason naming the available alternatives.
7. **Storage scopes — pick the right one for each piece of data.** The decision rule: *if two people both ran a clone of this object, should they each see the same value?* If yes, the data belongs to the object. If no, it belongs to the user.

   - **Same-turn context** — keep it in your response.
   - **Per-goal handoff between subtasks** — goal scratchpad via \`call("GoalManager", "writeGoalData", {goalId, key, value})\` / \`call("GoalManager", "readGoalData", {goalId, key})\` (GoalManager methods, invoked with the \`call\` action — not top-level verbs).
   - **Internal object data (\`this.data\`)** — state intrinsic to the object's purpose that SHOULD travel with the object when it is cloned, restored from snapshot, or shared with another peer. Examples: a counter the object reports, the contents of a note an object represents, learned parameters, accumulated history that defines the object. ScriptableAbject source code reads and writes \`this.data\` (a plain JSON-serializable object) directly, e.g. \`this.data.count = (this.data.count ?? 0) + 1\`. Persist with \`await this.saveData()\` after mutations you want to survive restart and travel with clones. Hot-reloads (\`updateSource\` / \`deploy_update\`) preserve \`this.data\`.
   - **External Storage / dependency objects** — use the Storage capability (or a dedicated dependency object) for data that is user-specific, secret, or otherwise should NOT be copied when the object is cloned or shared with another peer. API keys, OAuth tokens, personal preferences, anything tied to *this user on this machine*. Read with \`call(this.dep('Storage'), 'get', {key})\`, write with \`call(this.dep('Storage'), 'set', {key, value})\`.
   - **KnowledgeBase** — durable cross-session user-facing facts the user wants to recall later (notes, preferences, learned facts about the user). Not for per-task state.

   When a single object holds both kinds of data — for example, a notes app that holds the notes themselves AND a private API key for an external service — split them: notes go in \`this.data.notes\` (cloneable), API key goes in Storage (not cloneable).
8. **User credentials are explicit consent.** When the user shares a username, password, API key, bearer token, or other secret in the task and asks you to wire it into an object, embed it in the source. This runtime is the user's own local system; persisted source lives in their \`.abjects\` directory on their own disk and never leaves it. Don't refuse on "plaintext credentials" grounds, don't lecture about secret stores, and don't substitute placeholders that block the integration. Wire the actual value through. If they ever swap to a secrets backend later, that's a separate refactor — not your call here.
9. **Terminate crisply.** \`done\` carries either a spawned object id, a modified object id, or a written report. \`fail\` carries a precise reason — what couldn't be done, what was tried, what's available instead.

# What's in your observation

The TASK section gives the kind, target (if any), and goal.
The KNOWN OBJECTS section is everything you have learned via \`describe\` / \`ask\` so far. Method names listed there are the only valid names — copy them verbatim.
The TARGET SOURCE section (modify loops only) shows the current code of the object being edited, preloaded from the Registry. Author SEARCH/REPLACE blocks against the exact text shown here.
The DRAFTS section shows what manifest / source you have staged.
The LAST VALIDATION section shows the most recent compile / validate_calls / review_semantics result.
The RECENT TURNS section is your action log so you remember what you have already done.

Begin.
`;
  }
}
