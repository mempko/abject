/**
 * PermissionBroker -- decides what happens without asking, and what still asks.
 *
 * The permission question used to be put to the user in a form nobody can
 * answer: "may this object run this exact 400-character shell line?" The answer
 * was never reusable, because an agent never sends the same line twice, so the
 * only honest reply was to keep clicking. Meanwhile the decision had no idea
 * *where* the command was running or *who could reach* the object running it,
 * which are the two facts that actually bound the risk.
 *
 * This object supplies both. It sits between the capability objects
 * (ShellExecutor, HostFileSystem, HttpClient, StreamClient) and the dialog,
 * holds the permissions authority on all of them, and answers in one of three
 * ways: allow silently, refuse, or forward to GlobalSettings to ask a question
 * that now names a program, an effect, and a project.
 *
 * The split matters. Capability objects stay capabilities with no opinion about
 * projects; GlobalSettings stays a settings window that owns the dialog; policy
 * lives here and nowhere else.
 *
 * Two axes decide an auto-approval, and the smaller one wins:
 *
 *   1. **Project autonomy** — how much the directory on disk is trusted, set by
 *      the user per external project (`ask`, `read`, `edit`, `full`).
 *   2. **Workspace access mode** — how reachable the calling object is. A local
 *      workspace keeps the project's level; a private one is capped at `edit`;
 *      a public one is capped at `ask`, because an exposed object there is an
 *      entry point for any peer and a stranger's message must never end in a
 *      host command nobody saw.
 *
 * Nothing an agent can say raises either axis. Levels move through the UI only.
 */

import type { PermissionReceipt } from '../core/permission-outcome.js';
import * as path from 'path';
import * as os from 'os';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import {
  analyzeCommand, checkContainment, pathsOutside, protectedWrites, describeAnalysis,
  redactCommand, isSensitivePath, effectRank,
  type CommandAnalysis, type EffectClass, type Segment, type TouchedPath,
} from '../core/command-analysis.js';
import { isInside } from '../core/path-scope.js';
import {
  ALWAYS_PROTECTED, minAutonomy, autonomyRank,
  type AutonomyLevel, type ExternalProject,
} from './external-project-registry.js';
import type { WorkspaceAccessMode } from './workspace-manager.js';

const log = new Log('PermissionBroker');

const BROKER_INTERFACE: InterfaceId = 'abjects:permissions';

export const PERMISSION_BROKER_ID = 'abjects:permission-broker' as AbjectId;

const STORAGE_KEY_RULES = 'permission-broker:rules';

/**
 * How long to wait on the dialog with no sign of life from it.
 *
 * Not a limit on the person. GlobalSettings heartbeats for as long as the
 * question is on screen, and every beat resets this, so reaching it means the
 * dialog is gone rather than that the user is slow.
 */
const PROMPT_WAIT_MS = 30 * 60 * 1000;

/** How long a "for this task" grant survives without being renewed. */
const SESSION_GRANT_MS = 30 * 60 * 1000;

/** Auto-approvals one caller may take before it has to check in again. */
const DEFAULT_BUDGET = 200;

/** Decisions this object understands, whether from a dialog or from policy. */
export type PermissionDecision =
  | 'accept_once' | 'accept_always' | 'accept_object' | 'accept_session'
  | 'accept_class' | 'accept_program' | 'accept_path'
  | 'deny' | 'deny_always' | 'deny_object';

export type RuleScope =
  | { kind: 'project'; name: string }
  | { kind: 'path'; root: string }
  | { kind: 'anywhere' };

/**
 * A durable permission rule.
 *
 * `class` and `program` rules are the point of the redesign: they survive
 * changing arguments, so one decision covers a program the agent will invoke a
 * thousand different ways. `exact` remains for the rare literal case and stores
 * a redacted line.
 */
export type Rule =
  | { kind: 'class'; caller: string; effect: EffectClass; scope: RuleScope; allow: boolean }
  | { kind: 'program'; caller: string; program: string; scope: RuleScope; allow: boolean }
  | { kind: 'exact'; caller: string; command: string; allow: boolean };

const EFFECT_CLASSES: EffectClass[] = ['read', 'write', 'exec', 'network', 'dangerous'];

/** Validate untrusted rule-editor input before it reaches persisted policy. */
function parseRule(value: unknown): Rule | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const caller = typeof input.caller === 'string' ? input.caller.trim() : '';
  if (!caller || typeof input.allow !== 'boolean') return undefined;

  if (input.kind === 'exact') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    return command ? { kind: 'exact', caller, command, allow: input.allow } : undefined;
  }

  const rawScope = input.scope;
  if (!rawScope || typeof rawScope !== 'object') return undefined;
  const scopeInput = rawScope as Record<string, unknown>;
  let scope: RuleScope;
  if (scopeInput.kind === 'anywhere') scope = { kind: 'anywhere' };
  else if (scopeInput.kind === 'project' && typeof scopeInput.name === 'string' && scopeInput.name.trim()) {
    scope = { kind: 'project', name: scopeInput.name.trim() };
  } else if (scopeInput.kind === 'path' && typeof scopeInput.root === 'string' && path.isAbsolute(scopeInput.root)) {
    scope = { kind: 'path', root: path.resolve(scopeInput.root) };
  } else return undefined;

  if (input.kind === 'program') {
    const program = typeof input.program === 'string' ? input.program.trim() : '';
    return program ? { kind: 'program', caller, program, scope, allow: input.allow } : undefined;
  }
  if (input.kind === 'class' && EFFECT_CLASSES.includes(input.effect as EffectClass)) {
    return { kind: 'class', caller, effect: input.effect as EffectClass, scope, allow: input.allow };
  }
  return undefined;
}

interface SessionGrant {
  taskId?: string;
  callerId?: AbjectId;
  caller: string;
  effect: EffectClass;
  /** Territories this grant covers. `null` means unbounded. */
  roots: string[] | null;
  /** What the user was told they were allowing, for the log. */
  label: string;
  expiresAt: number;
}

/** One line of the audit trail: what was decided, and on what grounds. */
export interface DecisionRecord {
  at: number;
  caller: string;
  type: string;
  /** Redacted. */
  resource: string;
  decision: PermissionDecision;
  /** Whether a human saw it. */
  asked: boolean;
  reason: string;
  project?: string;
  workspace?: string;
  effectiveLevel?: AutonomyLevel;
}

/** Everything the broker needs to know about who is calling. */
interface CallerContext {
  callerId?: AbjectId;
  name: string;
  workspaceId?: string;
  workspaceName?: string;
  accessMode: WorkspaceAccessMode;
  /** True when the calling object is itself addressable by remote peers. */
  exposed: boolean;
  projectRegistryId?: AbjectId;
}

/**
 * How much autonomy a workspace's access mode permits, whatever its projects
 * ask for.
 *
 * `public` collapses all the way to `ask` rather than to something slightly
 * loosened. Most restrictive here means a human sees every host command, since
 * an exposed object in a public workspace is reachable by any peer that finds
 * it.
 */
export function ceilingFor(mode: WorkspaceAccessMode): AutonomyLevel {
  switch (mode) {
    case 'local': return 'full';
    case 'shared': return 'edit';
    case 'public': return 'ask';
    default: return 'ask';
  }
}

export class PermissionBroker extends Abject {
  private storageId?: AbjectId;
  private settingsId?: AbjectId;
  private workspaceManagerId?: AbjectId;

  /** The one object allowed to push capability settings through us. */
  private settingsAuthorityId?: AbjectId;

  private rules: Rule[] = [];
  private sessionGrants: SessionGrant[] = [];
  private decisions: DecisionRecord[] = [];
  /** Auto-approvals taken per caller, against DEFAULT_BUDGET. */
  private autoCount = new Map<string, number>();

  /** Requests waiting on the dialog, oldest first. */
  private promptQueue: Array<() => void> = [];
  private promptBusy = false;

  /** Cached workspace facts; short-lived because access mode is user-editable. */
  private wsCache?: { at: number; rows: WorkspaceRow[] };



  constructor() {
    super({
      manifest: {
        name: 'PermissionBroker',
        description:
          'Decides which host operations proceed without asking and which prompt the user. ' +
          'Holds the permissions authority on ShellExecutor, HostFileSystem, HttpClient and StreamClient, ' +
          'analyses each shell command into the programs it really runs, and applies the calling ' +
          'project\'s autonomy level capped by the calling workspace\'s access mode. ' +
          'Keeps a log of everything approved without a prompt.',
        version: '1.0.0',
        icon: '🛡️',
        interface: {
          id: BROKER_INTERFACE,
          name: 'PermissionBroker',
          description: 'Permission policy and decision log',
          methods: [
            {
              name: 'requestPermission',
              description: 'Called by capability objects. Returns a decision, asking the user only when policy cannot answer.',
              parameters: [
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'shell | directory | domain | skill_shell' },
                { name: 'resource', type: { kind: 'primitive', primitive: 'string' }, description: 'The command, path, or domain' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable request', optional: true },
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Where a command would run', optional: true },
                { name: 'callerId', type: { kind: 'primitive', primitive: 'string' }, description: 'The object that wants to act', optional: true },
              ],
              returns: { kind: 'object', properties: { decision: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'getEffectiveAutonomy',
              description: 'The level actually in force for a project, and what capped it.',
              parameters: [
                { name: 'project', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'callerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object whose workspace supplies the ceiling', optional: true },
              ],
              returns: { kind: 'object', properties: {
                requested: { kind: 'primitive', primitive: 'string' },
                ceiling: { kind: 'primitive', primitive: 'string' },
                effective: { kind: 'primitive', primitive: 'string' },
                cappedBy: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'listRules',
              description: 'Every standing permission rule',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
            },
            {
              name: 'addRule',
              description: 'Propose a standing permission rule; requires user approval through the broker dialog',
              parameters: [
                { name: 'rule', type: { kind: 'object', properties: {} }, description: 'Class, program, or exact rule' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'updateRule',
              description: 'Propose replacing a standing rule; requires user approval through the broker dialog',
              parameters: [
                { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Index from listRules' },
                { name: 'rule', type: { kind: 'object', properties: {} }, description: 'Replacement rule' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'removeRule',
              description: 'Propose removing a standing rule by index; requires user approval through the broker dialog',
              parameters: [
                { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Index from listRules' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listDecisions',
              description: 'Recent permission decisions, newest first, including everything auto-approved',
              parameters: [
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'How many', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
            },
            {
              name: 'takeTheWheel',
              description:
                'Drop every project back to "ask", clear session grants and standing allow rules. ' +
                'The one-click way back to being asked about everything.',
              parameters: [],
              returns: { kind: 'object', properties: {
                projectsReset: { kind: 'primitive', primitive: 'number' },
                rulesCleared: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'clearSessionGrants',
              description: 'Drop the caller\'s "for this task" grants; called when a task finishes',
              parameters: [],
              returns: { kind: 'object', properties: { cleared: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'applyToCapability',
              description:
                'Forward a settings change to a capability object. Restricted to the settings authority, ' +
                'which exists because this object holds the permissions authority those calls need.',
              parameters: [
                { name: 'capability', type: { kind: 'primitive', primitive: 'string' }, description: 'Capability object name' },
                { name: 'method', type: { kind: 'primitive', primitive: 'string' }, description: 'Permission method to call' },
                { name: 'payload', type: { kind: 'object', properties: {} }, description: 'Method payload' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'security', 'permissions'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadRules();
    // Claim before GlobalSettings can: setPermissionsAuthority is
    // first-caller-wins, and bootstrap spawns this object earlier for exactly
    // that reason.
    await this.claimAuthority();
    this.checkInvariants();
  }

  private async claimAuthority(): Promise<void> {
    for (const name of ['ShellExecutor', 'HostFileSystem', 'HttpClient', 'StreamClient']) {
      const id = await this.discoverDep(name);
      if (!id) continue;
      try {
        await this.request(request(this.id, id, 'setPermissionsAuthority', {}), 10_000);
        log.info(`holding permissions authority on ${name}`);
      } catch (err) {
        log.warn(`could not claim authority on ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('setSettingsAuthority', async (msg: AbjectMessage) => {
      if (this.settingsAuthorityId) return { success: false, error: 'Authority already set' };
      this.settingsAuthorityId = msg.routing.from;
      return { success: true };
    });

    this.on('applyToCapability', async (msg: AbjectMessage) => {
      if (this.settingsAuthorityId && msg.routing.from !== this.settingsAuthorityId) {
        return { success: false, error: 'Unauthorized' };
      }
      const { capability, method, payload } = msg.payload as {
        capability: string; method: string; payload: Record<string, unknown>;
      };
      // A fixed method set: forwarding is a convenience for the settings
      // window, not a general remote-call facility that happens to run with
      // the permissions authority behind it.
      const allowed = ['updatePermissions', 'updateObjectPermissions', 'updateSkillPermissions'];
      if (!allowed.includes(method)) return { success: false, error: `Method "${method}" is not forwardable` };
      const id = await this.discoverDep(capability);
      if (!id) return { success: false, error: `${capability} not found` };
      try {
        await this.request(request(this.id, id, method, payload ?? {}), 15_000);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    this.on('requestPermission', (msg: AbjectMessage) => {
      let authorized: PermissionRequest | undefined;
      this.authorizeRequest(msg).then(async req => {
        authorized = req;
        const outcome = await this.decide(req);
        this.sendDeferredReply(msg, { ...outcome, receipt: req.receipt });
      }).catch(err => {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`decide failed: ${reason}`);
        this.sendDeferredReply(msg, { decision: 'deny', asked: false, restrictEnv: false,
          receipt: { authority: this.id, callerId: authorized?.callerId ?? msg.routing.from, taskId: authorized?.taskId,
            operation: authorized?.operation ?? authorized?.type ?? 'permission', resource: authorized?.resource ?? '', decision: 'deny', source: 'unavailable', reason } });
      });
      return DEFERRED_REPLY;
    });

    this.on('getEffectiveAutonomy', async (msg: AbjectMessage) => {
      const { project, callerId } = msg.payload as { project: string; callerId?: AbjectId };
      const ctx = await this.callerContext(callerId ?? msg.routing.from);
      const proj = await this.projectByName(ctx, project);
      const requested: AutonomyLevel = proj?.trusted ? proj.autonomy : 'ask';
      const ceiling = ceilingFor(ctx.accessMode);
      const effective = ctx.exposed ? 'ask' : minAutonomy(requested, ceiling);
      return {
        requested,
        ceiling,
        effective,
        cappedBy: ctx.exposed
          ? 'this object is exposed to remote peers'
          : (autonomyRank(ceiling) < autonomyRank(requested)
            ? `${ctx.accessMode} workspace${ctx.workspaceName ? ` "${ctx.workspaceName}"` : ''}`
            : ''),
      };
    });

    this.on('listRules', async () => this.rules.map((r, index) => ({ index, ...r })));

    this.on('addRule', async (msg: AbjectMessage) => {
      const rule = parseRule((msg.payload as { rule?: unknown }).rule);
      if (!rule) return { success: false, error: 'Invalid permission rule' };
      if (!await this.authorizeRuleChange('Add', rule)) return { success: false, error: 'Permission rule change denied' };
      await this.addRule(rule);
      return { success: true };
    });

    this.on('updateRule', async (msg: AbjectMessage) => {
      const { index, rule: input } = msg.payload as { index: number; rule?: unknown };
      if (!Number.isInteger(index) || index < 0 || index >= this.rules.length) {
        return { success: false, error: 'No such rule' };
      }
      const rule = parseRule(input);
      if (!rule) return { success: false, error: 'Invalid permission rule' };
      const previous = this.rules[index];
      if (!await this.authorizeRuleChange('Replace', rule, previous)) return { success: false, error: 'Permission rule change denied' };
      if (this.rules[index] !== previous) return { success: false, error: 'Rule changed while awaiting approval; refresh and retry' };
      this.rules[index] = rule;
      await this.persistRules();
      this.changed('rulesChanged', { rules: this.rules.length });
      return { success: true };
    });

    this.on('removeRule', async (msg: AbjectMessage) => {
      const { index } = msg.payload as { index: number };
      if (!Number.isInteger(index) || index < 0 || index >= this.rules.length) {
        return { success: false, error: 'No such rule' };
      }
      const previous = this.rules[index];
      if (!await this.authorizeRuleChange('Remove', previous)) return { success: false, error: 'Permission rule change denied' };
      if (this.rules[index] !== previous) return { success: false, error: 'Rule changed while awaiting approval; refresh and retry' };
      this.rules.splice(index, 1);
      await this.persistRules();
      this.changed('rulesChanged', { rules: this.rules.length });
      return { success: true };
    });

    this.on('listDecisions', async (msg: AbjectMessage) => {
      const { limit } = msg.payload as { limit?: number };
      const n = typeof limit === 'number' && limit > 0 ? limit : 100;
      return this.decisions.slice(-n).reverse();
    });

    this.on('clearSessionGrants', async (msg: AbjectMessage) => {
      const caller = await this.resolveCallerName(msg.routing.from);
      const before = this.sessionGrants.length;
      const { taskId } = (msg.payload ?? {}) as { taskId?: string };
      this.sessionGrants = this.sessionGrants.filter(g => !(g.callerId === msg.routing.from && g.taskId === taskId));
      this.autoCount.delete(caller ?? '');
      return { cleared: before - this.sessionGrants.length };
    });

    this.on('takeTheWheel', async () => this.takeTheWheel());
  }

  /**
   * Back to being asked about everything: every project drops to `ask`, every
   * session grant is dropped, every standing allow rule is removed.
   *
   * Deny rules survive, because someone who blocked a program meant it.
   */
  private async takeTheWheel(): Promise<{ projectsReset: number; rulesCleared: number }> {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => !r.allow);
    this.sessionGrants = [];
    this.autoCount.clear();
    await this.persistRules();

    let projectsReset = 0;
    for (const row of await this.workspaceRows()) {
      const regId = await this.projectRegistryFor(row);
      if (!regId) continue;
      try {
        const projects = await this.request<ExternalProject[]>(
          request(this.id, regId, 'listProjects', {}), 10_000);
        for (const p of projects) {
          if (p.autonomy === 'ask') continue;
          const r = await this.request<{ success?: boolean; error?: string }>(
            request(this.id, regId, 'setAutonomy', { name: p.name, autonomy: 'ask' }), 10_000);
          // Count what actually changed. Counting attempts would report a
          // reset that never happened, which is the worst possible lie for a
          // control whose whole job is to make you safe again.
          if (r?.success) projectsReset++;
          else log.warn(`could not reset ${p.name}: ${r?.error ?? 'unknown error'}`);
        }
      } catch { /* a workspace without a project registry is not an error */ }
    }

    this.changed('rulesChanged', { rules: this.rules.length });
    log.info(`takeTheWheel: ${projectsReset} project(s) back to ask, ${before - this.rules.length} allow rule(s) cleared`);
    return { projectsReset, rulesCleared: before - this.rules.length };
  }

  // ═══════════════════════════════════════════════════════════════════
  // The decision
  // ═══════════════════════════════════════════════════════════════════

  /** Only capability owners may attest the originating caller and local grants. */
  private async authorizeRequest(msg: AbjectMessage): Promise<PermissionRequest> {
    const req = { ...(msg.payload as PermissionRequest) };
    const ownerNames = req.type === 'shell' || req.type === 'skill_shell' ? ['ShellExecutor']
      : req.type === 'directory' ? ['HostFileSystem', 'ShellExecutor'] : ['HttpClient', 'StreamClient'];
    const owners = await Promise.all(ownerNames.map(name => this.discoverDep(name)));
    if (!owners.includes(msg.routing.from)) {
      if (req.callerId && req.callerId !== msg.routing.from) throw new Error('Only a capability owner may forward another caller');
      req.callerId = msg.routing.from;
      req.preapproved = false;
      req.skillPreapproved = false;
      delete req.physicalPaths;
    }
    delete req.receipt;
    req.skillAuthenticated = false;
    if (req.skillPreapproved && req.callerId) {
      const rows = await this.workspaceRows();
      const workspace = rows.find(row => row.childIds?.includes(req.callerId!));
      const skills = workspace ? await this.request<Array<{ id: AbjectId }>>(
        request(this.id, workspace.registryId, 'discover', { name: 'SkillAgent' }))
        : [{ id: await this.discoverDep('SkillAgent') }];
      req.skillAuthenticated = skills.some(skill => skill.id === req.callerId);
    }
    if (req.type === 'directory') {
      req.operation = req.operation === 'write' ? 'write' : 'read';
      req.resource = path.resolve(req.resource);
    }
    return req;
  }

  private async decide(req: PermissionRequest): Promise<Outcome> {
    contractRequire(typeof req?.resource === 'string', 'resource must be a string');

    const ctx = await this.callerContext(req.callerId);
    if (req.type === 'shell') return this.decideShell(req, ctx);
    if (req.type === 'directory') return this.decideDirectory(req, ctx);

    const standing = this.standingVerdict(req.type, req.resource);
    if (standing !== undefined) {
      this.record(req, ctx, standing ? 'accept_once' : 'deny', false,
        standing ? 'standing allow' : 'standing block');
      return { decision: standing ? 'accept_once' : 'deny', asked: false, restrictEnv: false };
    }
    return this.ask(req, ctx, undefined, 'no policy covers this request type');
  }

  private async decideShell(req: PermissionRequest, ctx: CallerContext): Promise<Outcome> {
    const command = req.resource;
    const cwd = req.cwd;
    const analysis = analyzeCommand(command, { cwd });
    const project = cwd ? await this.projectFor(ctx, cwd) : undefined;
    const guards = [...ALWAYS_PROTECTED, ...(project?.protectedPaths ?? [])];
    const logicalProtected = project ? protectedWrites(analysis, project.root, guards).length > 0 : false;
    if (req.physicalPaths) {
      const destinations = new Map(req.physicalPaths.map(item => [item.logical, item.physical]));
      const touched = new Set([...analysis.reads, ...analysis.writes,
        ...analysis.segments.flatMap(segment => [...segment.reads, ...segment.writes])]);
      for (const item of touched) {
        if (!item.resolved) continue;
        const physical = destinations.get(item.resolved);
        if (physical) item.resolved = physical;
        else item.unresolved = true;
      }
    }

    // 1. A deny rule is the narrowest thing the user can say, and it outranks
    //    every allow list and every autonomy level.
    const denied = this.matchingRule(analysis, command, ctx.name, project, false);
    if (denied) {
      this.record(req, ctx, 'deny_object', false, `blocked by rule: ${describeRule(denied)}`, project);
      return { decision: 'deny_object', asked: false, restrictEnv: false };
    }

    if (logicalProtected || project && protectedWrites(analysis, project.root, guards).length) {
      this.record(req, ctx, 'deny', false, 'Command writes a protected project path', project);
      return { decision: 'deny', asked: false };
    }

    // 2. A standing allow rule, or a grant made for this task.
    const allowed = this.matchingRule(analysis, command, ctx.name, project, true)
      ?? this.matchingSessionGrant(analysis, ctx.name, req.taskId, req.callerId);
    if (allowed || ((req.preapproved || req.skillPreapproved && req.skillAuthenticated) && ctx.accessMode === 'local' && (!project || project.trusted))) {
      this.record(req, ctx, 'accept_once', false,
        allowed ? ('kind' in allowed ? `rule: ${describeRule(allowed)}` : `granted for this task: ${allowed.label}`) : 'configured capability grant',
        project);
      // A rule or task grant is something the user set up deliberately, so the
      // command keeps the environment it would have had if they had clicked.
      return { decision: 'accept_once', asked: false, restrictEnv: false };
    }

    // 3. Autonomy, capped by how reachable the caller is.
    const verdict = this.autoVerdict(analysis, ctx, project);
    if (verdict.allow) {
      if (!this.spendBudget(ctx.name)) {
        return this.ask(req, ctx, analysis, 'auto-approval budget spent for this task', project);
      }
      this.record(req, ctx, 'accept_once', false, verdict.reason, project, verdict.effective);
      // Approved by policy alone: nobody has ever seen this command, so it does
      // not get the host's credentials.
      return { decision: 'accept_once', asked: false, restrictEnv: true };
    }

    return this.ask(req, ctx, analysis, verdict.reason, project, verdict.effective);
  }

  /**
   * A path request from HostFileSystem.
   *
   * Reading and writing inside a trusted project the user already registered is
   * the case that used to prompt per directory. Class rules and task grants
   * are honored here exactly as they are for commands, so "Allow file edits in
   * X" answers once for both. Everything else asks.
   */
  private async decideDirectory(req: PermissionRequest, ctx: CallerContext): Promise<Outcome> {
    const target = req.resource;
    const operation = req.operation ?? 'read';
    const effect = fileEffect(operation);
    const project = await this.projectFor(ctx, target)
      ?? (req.requestedResource ? await this.projectFor(ctx, req.requestedResource) : undefined);
    const standing = this.standingVerdict(`directory:${operation}:${ctx.name}`, target)
      ?? this.standingVerdict(`directory:${operation}`, target);
    const legacy = this.standingVerdict('directory', target);
    // The same class rules and task grants the shell path honors. "Allow file
    // edits in X" is one answer whether the edit arrives as a command or as a
    // filesystem call; before this the filesystem side asked per file anyway.
    const blocked = this.matchingPathRule(target, ctx.name, effect, project, false);
    const allowed = this.matchingPathRule(target, ctx.name, effect, project, true)
      ?? this.matchingPathSessionGrant(target, ctx.name, effect, req.taskId, req.callerId);
    const guards = [...ALWAYS_PROTECTED, ...(project?.protectedPaths ?? [])];
    const relative = project ? path.relative(project.root, target) : target;
    const requestedRelative = project && req.requestedResource ? path.relative(project.root, req.requestedResource) : req.requestedResource;
    const protectedPath = (value: string) => guards.some(guard => {
      const name = guard.replace(/\/$/, '');
      return value === name || path.basename(value) === name
        || (guard.endsWith('/') && (value.startsWith(guard) || value.split(path.sep).includes(name)));
    });
    if (standing === false || legacy === false || blocked || (operation === 'write' && (protectedPath(relative) || !!requestedRelative && protectedPath(requestedRelative)))) {
      this.record(req, ctx, 'deny', false, blocked ? `rule: ${describeRule(blocked)}` : 'Filesystem operation blocked by a rule or protected path', project);
      return { decision: 'deny', asked: false };
    }
    if (allowed) {
      this.record(req, ctx, 'accept_once', false,
        'kind' in allowed ? `rule: ${describeRule(allowed)}` : `granted for this task: ${allowed.label}`, project);
      return { decision: 'accept_once', asked: false, restrictEnv: false };
    }
    if (standing === true || (operation === 'read' && legacy === true) || (req.preapproved && ctx.accessMode === 'local' && (!project || (project.trusted && autonomyRank(this.effectiveLevel(ctx, project)) >= autonomyRank(operation === 'write' ? 'edit' : 'read'))))) {
      this.record(req, ctx, 'accept_once', false, `Standing filesystem ${operation} grant`, project);
      return { decision: 'accept_once', asked: false };
    }
    if (project) {
      const effective = this.effectiveLevel(ctx, project);
      const required = operation === 'write' ? 'edit' : 'read';
      if (autonomyRank(effective) >= autonomyRank(required) && isInside(project.root, target)) {
        this.record(req, ctx, 'accept_once', false,
          `${operation} inside trusted project "${project.name}" at ${effective}`, project, effective);
        return { decision: 'accept_once', asked: false };
      }
    }
    return this.ask(req, ctx, undefined, `No standing ${operation} permission for this path`, project);
  }

  /** The level actually in force: the project's ask, capped by reachability. */
  private effectiveLevel(ctx: CallerContext, project?: ExternalProject): AutonomyLevel {
    if (!project || !project.trusted) return 'ask';
    // An object a remote peer can address directly needs no laundering at all,
    // so it never auto-approves whatever its workspace mode says.
    if (ctx.exposed) return 'ask';
    return minAutonomy(project.autonomy, ceilingFor(ctx.accessMode));
  }

  /**
   * Whether the autonomy level covers this command.
   *
   * Every refusal carries the reason, because the reason is what the dialog
   * shows the user under "asking because".
   */
  private autoVerdict(
    analysis: CommandAnalysis,
    ctx: CallerContext,
    project?: ExternalProject,
  ): { allow: boolean; reason: string; effective: AutonomyLevel } {
    const effective = this.effectiveLevel(ctx, project);

    if (!project) {
      return { allow: false, reason: 'not running inside a registered project', effective };
    }
    if (!project.trusted) {
      return { allow: false, reason: `"${project.name}" is not trusted`, effective };
    }
    if (ctx.exposed) {
      return { allow: false, reason: 'this object is exposed to remote peers', effective };
    }
    const requested = project.autonomy;
    if (effective === 'ask') {
      const capped = autonomyRank(ceilingFor(ctx.accessMode)) < autonomyRank(requested);
      return {
        allow: false,
        effective,
        reason: capped
          ? `"${project.name}" asks for ${requested}, capped to ask by the ${ctx.accessMode} workspace${ctx.workspaceName ? ` "${ctx.workspaceName}"` : ''}`
          : `"${project.name}" is set to ask`,
      };
    }

    // Nothing below is waved through by any level.
    if (analysis.effect === 'dangerous') {
      return { allow: false, effective, reason: analysis.dangerReason ?? 'dangerous command' };
    }
    if (analysis.opaque) {
      return { allow: false, effective, reason: `cannot be read with confidence: ${analysis.opaqueReason}` };
    }

    const containment = checkContainment(analysis, [project.root]);
    if (!containment.contained) {
      const first = containment.escapes[0];
      return {
        allow: false, effective,
        reason: `touches ${first.raw}${first.unresolved ? ' (cannot tell where that points)' : ''}, outside ${project.name}`,
      };
    }

    const guards = [...ALWAYS_PROTECTED, ...(project.protectedPaths ?? [])];
    const hits = protectedWrites(analysis, project.root, guards);
    if (hits.length > 0) {
      return { allow: false, effective, reason: `writes to protected path ${hits[0].raw}` };
    }

    const ceiling: EffectClass = effective === 'read' ? 'read' : effective === 'edit' ? 'write' : 'network';
    if (effectRank(analysis.effect) > effectRank(ceiling)) {
      return {
        allow: false, effective,
        reason: `${analysis.effect} command, above what "${effective}" covers in ${project.name}`,
      };
    }

    return {
      allow: true, effective,
      reason: `${analysis.effect === 'read' ? 'read-only' : analysis.effect} in ${project.name} at ${effective}`
        + (analysis.segments.length > 1 ? ` (${analysis.segments.length} segments)` : ''),
    };
  }

  /**
   * A budget so an agent stuck in a loop cannot grind through the disk
   * unattended. Spending it forces one prompt, which resets it.
   */
  private spendBudget(caller: string): boolean {
    const used = (this.autoCount.get(caller) ?? 0) + 1;
    this.autoCount.set(caller, used);
    return used <= DEFAULT_BUDGET;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Rules
  // ═══════════════════════════════════════════════════════════════════

  /**
   * The path territory a scope speaks for, resolved against where the command
   * is actually running.
   *
   * This replaces a containment test that made grants unusable. Containment was
   * re-checked against the project root for every rule, so "always allow grep in
   * Abject", clicked on a command that asked precisely because it read outside
   * Abject, produced a rule the next such command could not match. Every
   * remembering button in the dialog was a no-op for the one case that raised
   * it, and the only working answer was to keep clicking "allow once".
   *
   * A scope now names the territory it covers and containment is judged against
   * that territory, so a button means what its label says:
   *
   *   - `null`      unbounded; "anywhere" waives containment outright
   *   - a root      the grant covers paths at or beneath it
   *   - `undefined` this scope has nothing to say about this command
   */
  private territoryOf(scope: RuleScope, project?: ExternalProject): string | null | undefined {
    if (scope.kind === 'anywhere') return null;
    if (scope.kind === 'path') return scope.root;
    return project && scope.name === project.name ? project.root : undefined;
  }

  /**
   * The territories a set of scopes grants here, or `null` if any is unbounded.
   * Scopes with nothing to say contribute nothing, so an empty array means
   * "these rules do not reach this command" rather than "anywhere".
   */
  private territories(scopes: readonly RuleScope[], project?: ExternalProject): string[] | null {
    const roots: string[] = [];
    for (const scope of scopes) {
      const t = this.territoryOf(scope, project);
      if (t === null) return null;
      if (t !== undefined) roots.push(t);
    }
    return roots;
  }

  /**
   * Whether a deny rule has anything to say about one segment.
   *
   * A block is meant to be blunt, so `anywhere` and the project the command is
   * running in both hit unconditionally. A path-scoped block hits only when the
   * segment actually touches that path, because blocking a directory should not
   * quietly become blocking a program everywhere.
   */
  private denyApplies(scope: RuleScope, seg: Segment, project?: ExternalProject): boolean {
    const territory = this.territoryOf(scope, project);
    if (territory === undefined) return false;
    if (territory === null || scope.kind === 'project') return true;
    return [...seg.reads, ...seg.writes].some(t => t.resolved && isInside(territory, t.resolved));
  }

  /** What this command touches that the project it runs in does not cover. */
  private escapesOf(analysis: CommandAnalysis, project?: ExternalProject): TouchedPath[] {
    return checkContainment(analysis, project ? [project.root] : []).escapes;
  }

  /**
   * A rule covers a compound line only if it covers every program in it, and
   * covers each program only inside the territory that program was granted.
   *
   * This is what makes a grant usable at all: `cd x && sed … | grep …` is
   * allowed when `cd`, `sed` and `grep` are each allowed, and refused the
   * moment an unlisted program joins the pipeline. Paths are judged per
   * segment, so permission to read one directory never leaks into the rest of
   * the line.
   */
  private matchingRule(
    analysis: CommandAnalysis,
    command: string,
    caller: string,
    project: ExternalProject | undefined,
    allow: boolean,
  ): Rule | undefined {
    const applicable = this.rules.filter(r => r.allow === allow && (r.caller === caller || r.caller === '*'));

    // Stored commands are redacted, so the candidate is redacted the same way
    // before comparison.
    const redacted = redactCommand(command);
    for (const r of applicable) {
      if (r.kind === 'exact' && r.command === redacted) return r;
    }

    // A deny hits when ANY program matches; an allow needs EVERY program.
    const programRules = applicable.filter((r): r is Extract<Rule, { kind: 'program' }> => r.kind === 'program');
    const classRules = applicable.filter((r): r is Extract<Rule, { kind: 'class' }> => r.kind === 'class');

    if (!allow) {
      for (const seg of analysis.segments) {
        const hit = programRules.find(r => r.program === seg.program && this.denyApplies(r.scope, seg, project));
        if (hit) return hit;
      }
      return undefined;
    }

    if (analysis.opaque || analysis.effect === 'dangerous') return undefined;
    if (analysis.segments.length === 0) return undefined;

    // A class rule answers for the whole line, so it is judged against the
    // whole line's paths, inside the territory the class was granted in.
    const coveringClass = classRules.find(r => {
      if (effectRank(analysis.effect) > effectRank(r.effect)) return false;
      const roots = this.territories([r.scope], project);
      return roots === null
        || (roots.length > 0 && checkContainment(analysis, roots).contained);
    });
    if (coveringClass) return coveringClass;

    let matched: Rule | undefined;
    for (const seg of analysis.segments) {
      const hits = programRules.filter(r =>
        r.program === seg.program && this.territoryOf(r.scope, project) !== undefined);
      if (hits.length === 0) return undefined;
      const roots = this.territories(hits.map(r => r.scope), project);
      if (roots !== null && pathsOutside([...seg.reads, ...seg.writes], roots).length > 0) {
        return undefined;
      }
      matched = hits[0];
    }
    return matched;
  }

  private matchingSessionGrant(
    analysis: CommandAnalysis,
    caller: string,
    taskId?: string,
    callerId?: AbjectId,
  ): SessionGrant | undefined {
    const now = Date.now();
    this.sessionGrants = this.sessionGrants.filter(g => g.expiresAt > now);
    if (analysis.opaque || analysis.effect === 'dangerous') return undefined;
    return this.sessionGrants.find(g =>
      g.caller === caller && !!taskId && g.taskId === taskId && g.callerId === callerId
      && effectRank(analysis.effect) <= effectRank(g.effect)
      && (g.roots === null
        || (g.roots.length > 0 && checkContainment(analysis, g.roots).contained)));
  }

  /**
   * A class rule that answers for a single path.
   *
   * A filesystem call touches one path with one effect, so containment is a
   * plain `isInside` on the rule's territory. Program rules never apply: there
   * is no program on a filesystem call to name.
   */
  private matchingPathRule(
    target: string,
    caller: string,
    effect: EffectClass,
    project: ExternalProject | undefined,
    allow: boolean,
  ): Rule | undefined {
    return this.rules.find(r => {
      if (r.kind !== 'class' || r.allow !== allow || (r.caller !== caller && r.caller !== '*')) return false;
      // An allow must be at least as wide as the request; a block bites when
      // the request is at least as wide as what was blocked.
      if (allow ? effectRank(effect) > effectRank(r.effect) : effectRank(effect) < effectRank(r.effect)) return false;
      const territory = this.territoryOf(r.scope, project);
      if (territory === undefined) return false;
      return territory === null || isInside(territory, target);
    });
  }

  private matchingPathSessionGrant(
    target: string,
    caller: string,
    effect: EffectClass,
    taskId?: string,
    callerId?: AbjectId,
  ): SessionGrant | undefined {
    const now = Date.now();
    this.sessionGrants = this.sessionGrants.filter(g => g.expiresAt > now);
    return this.sessionGrants.find(g =>
      g.caller === caller && !!taskId && g.taskId === taskId && g.callerId === callerId
      && effectRank(effect) <= effectRank(g.effect)
      && (g.roots === null || g.roots.some(root => isInside(root, target))));
  }

  /**
   * A previous "always" on this exact path or domain, if there is one.
   * Undefined means nothing has been said about it.
   */
  private standingVerdict(type: string, resource: string): boolean | undefined {
    const key = standingKey(type, resource);
    const matches = this.rules.filter(r => r.kind === 'exact' && (r.command === key
      || type.startsWith('directory') && r.command.startsWith(`${type}:`) && isInside(r.command.slice(type.length + 1), resource)));
    if (matches.some(r => !r.allow)) return false;
    return matches.some(r => r.allow) ? true : undefined;
  }

  private async addRule(rule: Rule): Promise<void> {
    const key = JSON.stringify(rule);
    if (this.rules.some(r => JSON.stringify(r) === key)) return;
    this.rules.push(rule);
    await this.persistRules();
    this.changed('rulesChanged', { rules: this.rules.length });
  }

  private async loadRules(): Promise<void> {
    if (!this.storageId) return;
    try {
      const data = await this.request<{ rules?: Rule[] } | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY_RULES }));
      if (data?.rules) this.rules = data.rules;
      if (this.rules.length > 0) log.info(`loaded ${this.rules.length} permission rule(s)`);
    } catch (err) {
      log.warn(`could not load rules: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async persistRules(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set',
        { key: STORAGE_KEY_RULES, value: { rules: this.rules } }));
    } catch (err) {
      log.warn(`could not persist rules: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Asking
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Put the question to the user, one at a time.
   *
   * Requests queue rather than being refused. The old dialog answered a second
   * concurrent request with `deny` so it would not have to stack windows, which
   * meant two agents working at once silently failed one of them.
   */
  private async ask(
    req: PermissionRequest,
    ctx: CallerContext,
    analysis: CommandAnalysis | undefined,
    why: string,
    project?: ExternalProject,
    effective?: AutonomyLevel,
  ): Promise<Outcome> {
    await this.enterPromptQueue();
    try {
      // Logged before the dialog rather than after the answer, so a prompt
      // nobody is at the keyboard for still says what it is waiting on. The
      // reason used to exist only on screen, which left a repeated prompt with
      // no trace in the log at all.
      log.info(`asking ${ctx.name} about ${req.type}: `
        + `${redactCommand(req.resource).slice(0, 160)} (${why})`);
      const decision = await this.showPrompt(req, ctx, analysis, why, project);
      await this.applyDecision(decision, req, ctx, analysis, project);
      this.record(req, ctx, decision, true, why, project, effective);
      // A prompt is a check-in, so the loop guard starts again.
      this.autoCount.set(ctx.name, 0);
      return { decision, asked: true, restrictEnv: false };
    } finally {
      this.leavePromptQueue();
    }
  }

  private async enterPromptQueue(): Promise<void> {
    if (!this.promptBusy) { this.promptBusy = true; return; }
    await new Promise<void>(resolve => this.promptQueue.push(resolve));
  }

  private leavePromptQueue(): void {
    const next = this.promptQueue.shift();
    if (next) next();
    else this.promptBusy = false;
  }

  private async showPrompt(
    req: PermissionRequest,
    ctx: CallerContext,
    analysis: CommandAnalysis | undefined,
    why: string,
    project?: ExternalProject,
  ): Promise<PermissionDecision> {
    const settingsId = await this.settings();
    if (!settingsId) throw new Error('Permission dialog is unavailable');

    const groups = this.optionsFor(req, ctx, analysis, project);
    const detail = analysis
      ? (() => {
        const d = describeAnalysis(analysis, project?.root);
        const lines = [
          `Programs   ${d.programs}`,
          `Effect     ${d.effect}`,
          `Reads      ${d.reads}`,
          `Writes     ${d.writes}`,
        ];
        if (d.note) lines.push(`Note       ${d.note}`);
        lines.push(`Asking because   ${why}`);
        return lines;
      })()
      : [`Asking because   ${why}`];

    try {
      const reply = await this.request<{ decision: string }>(
        request(this.id, settingsId, 'showPermissionPrompt', {
          type: req.type,
          title: req.type === 'shell' ? 'Shell Permission'
            : req.type === 'domain' ? 'Network Permission' : 'Filesystem Permission',
          description: `${ctx.name} wants to ${req.type === 'shell' ? 'run a command' : req.type === 'directory' ? `${req.operation ?? 'read'} files` : 'access'}`
            + (project ? ` in ${project.name}` : ''),
          resource: redactCommand(req.resource),
          detail,
          groups,
          skillName: req.skillName,
          // Rides along so the dialog's heartbeat names the task and reaches
          // every caller serving it, not just the ones with nothing else open.
          taskId: req.taskId,
        }),
        PROMPT_WAIT_MS,
      );
      return (reply?.decision as PermissionDecision) ?? 'deny';
    } catch (err) {
      log.warn(`prompt failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(`Permission dialog unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The buttons, grouped narrowest-first.
   *
   * Two rules govern what appears here. A grant names every program the line
   * runs, not just the one that set its effect, because a rule covers a line
   * only when it covers all of them. And nothing is offered that would fail to
   * cover the command on screen: a button that leaves the next identical
   * command asking is worse than no button, since the user believes they have
   * answered.
   *
   * The program named in a block is still the one that set the line's effect,
   * so an agent that opens every command with `cd` is never asked whether to
   * block `cd`.
   */
  private optionsFor(
    req: PermissionRequest,
    ctx: CallerContext,
    analysis: CommandAnalysis | undefined,
    project?: ExternalProject,
  ): PromptGroup[] {
    const groups: PromptGroup[] = [];
    const canGrantBroadly = !!analysis && !analysis.opaque && analysis.effect !== 'dangerous';
    const grantName = describePrograms(analysis?.programs ?? []);
    const escapes = analysis ? this.escapesOf(analysis, project) : [];
    const escapeRoot = grantableRoot(escapes);

    groups.push({
      label: 'This request',
      options: [
        { id: 'accept_once', label: 'Allow once', tone: 'default' },
        { id: 'deny', label: 'Deny once', tone: 'default' },
      ],
    });

    // A filesystem call has no command line to analyze, but it has the same
    // answers on offer: this task, this project, or the directory it reached
    // for. Without these the only durable answer was one file at a time.
    if (req.type === 'directory') {
      const operation = req.operation ?? 'read';
      const classLabel = operation === 'write' ? 'file edits' : 'reads';
      if (project && isInside(project.root, req.resource)) {
        const options: PromptOption[] = req.taskId && req.callerId ? [
          { id: 'accept_session', label: 'Allow for this task', tone: 'good' },
        ] : [];
        options.push({ id: 'accept_class', label: `Allow ${classLabel} in ${project.name}`, tone: 'good' });
        groups.push({ label: `In ${project.name}`, options });
      } else {
        const root = fileGrantRoot(req.resource);
        const options: PromptOption[] = [
          { id: 'accept_path', label: `Allow ${classLabel} under ${displayPath(root)}`, tone: 'good' },
        ];
        if (req.taskId && req.callerId) options.push({ id: 'accept_session', label: 'Allow for this task', tone: 'good' });
        groups.push({ label: project ? `Outside ${project.name}` : `Under ${displayPath(root)}`, options });
      }
    }

    // Everything scoped to the project answers only for a command that stays
    // inside it, so these appear only when the line does.
    if (project && canGrantBroadly && escapes.length === 0) {
      const options: PromptOption[] = req.taskId && req.callerId ? [
        { id: 'accept_session', label: 'Allow for this task', tone: 'good' },
      ] : [];
      if (analysis.effect === 'read') {
        options.push({ id: 'accept_class', label: `Allow read-only commands in ${project.name}`, tone: 'good' });
      } else if (analysis.effect === 'write') {
        options.push({ id: 'accept_class', label: `Allow file edits in ${project.name}`, tone: 'good' });
      }
      if (grantName) {
        options.push({ id: 'accept_program', label: `Always allow ${grantName} in ${project.name}`, tone: 'good' });
      }
      groups.push({ label: `In ${project.name}`, options });
    }

    // The line reaches outside the project, which is usually why it is being
    // asked about at all. A grant on the project alone can never answer that,
    // so the offer names the directory the command actually needs.
    if (canGrantBroadly && grantName && escapeRoot) {
      const options: PromptOption[] = [
        { id: 'accept_path', label: `Allow ${grantName} under ${displayPath(escapeRoot)}`, tone: 'good' },
      ];
      if (project && req.taskId && req.callerId) options.push({ id: 'accept_session', label: 'Allow for this task', tone: 'good' });
      groups.push({
        label: project ? `Outside ${project.name}` : `Under ${displayPath(escapeRoot)}`,
        options,
      });
    }

    const wide: PromptOption[] = [];
    if (grantName && canGrantBroadly) {
      wide.push({ id: 'accept_object', label: `Always allow ${grantName} anywhere`, tone: 'good' });
    }
    if (analysis?.principalProgram) {
      wide.push({ id: 'deny_object', label: `Block ${analysis.principalProgram}`, tone: 'bad' });
    }
    if (req.type !== 'shell') {
      wide.push({ id: 'accept_always', label: 'Always allow', tone: 'good' });
      wide.push({ id: 'deny_always', label: 'Never allow', tone: 'bad' });
    }
    if (wide.length > 0) groups.push({ label: 'Anywhere', options: wide });

    return groups;
  }

  /** Turn a decision into whatever standing state it implies. */
  private async applyDecision(
    decision: PermissionDecision,
    req: PermissionRequest,
    ctx: CallerContext,
    analysis: CommandAnalysis | undefined,
    project?: ExternalProject,
  ): Promise<void> {
    // A grant is written for every program the line runs, because a rule
    // covers a line only when it covers all of them. Granting the principal
    // alone left `grep … | head` asking again with the same button on offer.
    const programs = analysis?.programs.filter(Boolean) ?? [];
    const scope: RuleScope = project ? { kind: 'project', name: project.name } : { kind: 'anywhere' };
    const escapeRoot = analysis ? grantableRoot(this.escapesOf(analysis, project)) : undefined;
    const isFile = req.type === 'directory';
    const fileRoot = isFile ? fileGrantRoot(req.resource) : undefined;
    const inProject = !!project && isFile && isInside(project.root, req.resource);
    // A filesystem call's effect is its operation; there is no line to analyze.
    const effect: EffectClass | undefined = analysis?.effect ?? (isFile ? fileEffect(req.operation ?? 'read') : undefined);

    switch (decision) {
      case 'accept_session':
        if (isFile && effect && req.taskId && req.callerId) {
          const root = inProject ? project!.root : fileRoot!;
          this.sessionGrants.push({
            caller: ctx.name,
            taskId: req.taskId, callerId: req.callerId,
            effect,
            roots: [root],
            label: inProject ? `${effect} in ${project!.name}` : `${effect} under ${displayPath(root)}`,
            expiresAt: Date.now() + SESSION_GRANT_MS,
          });
          return;
        }
        if (analysis && project && req.taskId && req.callerId) {
          this.sessionGrants.push({
            caller: ctx.name,
            taskId: req.taskId, callerId: req.callerId,
            effect: analysis.effect,
            // A task grant that did not cover the path which raised the prompt
            // would be answered by the same prompt a second later.
            roots: escapeRoot ? [project.root, escapeRoot] : [project.root],
            label: escapeRoot
              ? `${analysis.effect} in ${project.name} and under ${displayPath(escapeRoot)}`
              : `${analysis.effect} in ${project.name}`,
            expiresAt: Date.now() + SESSION_GRANT_MS,
          });
        }
        return;
      case 'accept_class':
        if (effect) await this.addRule({ kind: 'class', caller: ctx.name, effect, scope, allow: true });
        return;
      case 'accept_program':
        for (const program of programs) {
          await this.addRule({ kind: 'program', caller: ctx.name, program, scope, allow: true });
        }
        return;
      case 'accept_path':
        if (isFile && effect && fileRoot) {
          await this.addRule({ kind: 'class', caller: ctx.name, effect, scope: { kind: 'path', root: fileRoot }, allow: true });
          return;
        }
        // Two rules per program: the directory the line reached for, and the
        // project it was running in. Writing only the first would leave the
        // in-project half of the same line uncovered, and it would ask again.
        if (escapeRoot) {
          for (const program of programs) {
            await this.addRule({
              kind: 'program', caller: ctx.name, program,
              scope: { kind: 'path', root: escapeRoot }, allow: true,
            });
            if (project) {
              await this.addRule({
                kind: 'program', caller: ctx.name, program,
                scope: { kind: 'project', name: project.name }, allow: true,
              });
            }
          }
        }
        return;
      case 'accept_object':
        for (const program of programs) {
          await this.addRule({ kind: 'program', caller: ctx.name, program, scope: { kind: 'anywhere' }, allow: true });
        }
        return;
      case 'deny_object':
        // A block stays on the one program the user pointed at. Widening an
        // allow across a pipeline is a convenience; widening a block across one
        // would be a far bigger answer than the button asked for.
        if (analysis?.principalProgram) {
          await this.addRule({
            kind: 'program', caller: ctx.name, program: analysis.principalProgram,
            scope: { kind: 'anywhere' }, allow: false,
          });
        }
        return;
      case 'accept_always':
        // Remembered here rather than pushed into the capability's own allow
        // list: updatePermissions REPLACES that list, so appending to it from
        // a dialog would quietly drop everything the user configured in
        // Settings. Answering from here also keeps one place to revoke.
        if (req.type !== 'shell') {
          await this.addRule({ kind: 'exact', caller: '*', command: standingKey(standingType(req, ctx), req.resource), allow: true });
        }
        return;
      case 'deny_always':
        if (req.type !== 'shell') {
          await this.addRule({ kind: 'exact', caller: '*', command: standingKey(standingType(req, ctx), req.resource), allow: false });
        }
        return;
      default:
        return;
    }
  }

  private record(
    req: PermissionRequest,
    ctx: CallerContext,
    decision: PermissionDecision,
    asked: boolean,
    reason: string,
    project?: ExternalProject,
    effectiveLevel?: AutonomyLevel,
  ): void {
    const entry: DecisionRecord = {
      at: Date.now(),
      caller: ctx.name,
      type: req.type,
      resource: redactCommand(req.resource).slice(0, 400),
      decision,
      asked,
      reason,
      project: project?.name,
      workspace: ctx.workspaceName,
      effectiveLevel,
    };
    req.receipt = { authority: this.id, callerId: req.callerId, taskId: req.taskId,
      operation: req.operation ?? req.type, resource: req.type === 'directory' ? req.resource : redactCommand(req.resource), decision,
      source: asked ? 'user' : 'policy', reason, project: project?.name };
    this.decisions.push(entry);
    if (this.decisions.length > 500) this.decisions.splice(0, this.decisions.length - 500);
    log.info(asked
      ? `answered ${decision}: ${ctx.name} (${reason})`
      : `auto ${decision}: ${ctx.name} ${reason}`);
    // Only prompted decisions are announced. An auto-approval happens as often
    // as an agent runs a command, and an event per decision is exactly the
    // shape that has flooded this bus before; anything wanting the full picture
    // reads listDecisions, which is a pull rather than a push.
    if (asked) this.changed('decisionRecorded', entry);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Who is calling, and where
  // ═══════════════════════════════════════════════════════════════════

  private async callerContext(callerId?: AbjectId): Promise<CallerContext> {
    const name = (callerId ? await this.resolveCallerName(callerId) : undefined) ?? 'an object';
    if (!callerId) {
      // An unplaceable caller gets the most restrictive treatment there is.
      return { name, accessMode: 'public', exposed: true };
    }
    const rows = await this.workspaceRows();
    const owner = rows.find(r => r.childIds?.includes(callerId));
    if (!owner) {
      // Global system objects are not in any workspace. They are not reachable
      // by a peer through a workspace either, so `local` is the honest answer.
      return { callerId, name, accessMode: 'local', exposed: false };
    }
    return {
      callerId,
      name,
      workspaceId: owner.workspaceId,
      workspaceName: owner.name,
      accessMode: owner.accessMode,
      exposed: owner.accessMode !== 'local' && owner.exposedObjectIds.includes(callerId),
      projectRegistryId: await this.projectRegistryFor(owner),
    };
  }

  private async workspaceRows(): Promise<WorkspaceRow[]> {
    const now = Date.now();
    if (this.wsCache && now - this.wsCache.at < 5_000) return this.wsCache.rows;
    this.workspaceManagerId = await this.resolveDep('WorkspaceManager', this.workspaceManagerId) ?? undefined;
    if (!this.workspaceManagerId) return [];
    try {
      const rows = await this.request<WorkspaceRow[]>(
        request(this.id, this.workspaceManagerId, 'listWorkspacesDetailed', {}), 10_000);
      this.wsCache = { at: now, rows };
      return rows;
    } catch {
      return this.wsCache?.rows ?? [];
    }
  }

  /** The ExternalProjectRegistry belonging to one workspace. */
  private async projectRegistryFor(row: WorkspaceRow): Promise<AbjectId | undefined> {
    try {
      const found = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, row.registryId, 'discover', { name: 'ExternalProjectRegistry' }), 10_000);
      return found[0]?.id;
    } catch {
      return undefined;
    }
  }

  private async projectFor(ctx: CallerContext, pathOrName: string): Promise<ExternalProject | undefined> {
    if (!ctx.projectRegistryId) return undefined;
    try {
      const p = await this.request<ExternalProject | null>(
        request(this.id, ctx.projectRegistryId, 'resolveProject', { nameOrPath: pathOrName }), 10_000);
      return p ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async projectByName(ctx: CallerContext, name: string): Promise<ExternalProject | undefined> {
    return this.projectFor(ctx, name);
  }

  /** A bus caller can propose a rule, but only the permission dialog can approve it. */
  private async authorizeRuleChange(operation: 'Add' | 'Replace' | 'Remove', rule: Rule, previous?: Rule): Promise<boolean> {
    await this.enterPromptQueue();
    try {
      const settingsId = await this.settings();
      if (!settingsId) return false;
      const reply = await this.request<{ decision: string }>(request(this.id, settingsId, 'showPermissionPrompt', {
        type: 'permission_rule', title: `${operation} permission rule?`,
        description: `This changes standing permissions for ${rule.caller === '*' ? 'all callers' : rule.caller}.`,
        resource: describeRule(rule),
        detail: previous ? [`Replaces: ${describeRule(previous)}`] : [],
        groups: [{ label: 'Standing permission', options: [
          { id: 'approve_rule_change', label: `${operation} rule`, tone: 'bad' },
          { id: 'deny', label: 'Cancel', tone: 'default' },
        ] }],
      }), PROMPT_WAIT_MS);
      return reply?.decision === 'approve_rule_change';
    } catch { return false; }
    finally { this.leavePromptQueue(); }
  }

  private async settings(): Promise<AbjectId | undefined> {
    this.settingsId = await this.resolveDep('GlobalSettings', this.settingsId) ?? undefined;
    return this.settingsId;
  }

  protected override askPrompt(question: string): string {
    const lines = [
      '## PermissionBroker',
      '',
      'Decides what runs without asking. Two axes, smaller wins:',
      '- the external project\'s autonomy level (ask / read / edit / full)',
      '- the calling workspace\'s access mode: local keeps the level, private caps at edit, public caps at ask',
      '',
      `Standing rules: ${this.rules.length}. Session grants: ${this.sessionGrants.length}.`,
      `Recent decisions: ${this.decisions.length} (see listDecisions).`,
      '',
      'Levels are set by the user through the project browser. Nothing an object sends here raises one.',
      'Call takeTheWheel to drop everything back to asking.',
    ];
    return super.askPrompt(question) + '\n\n' + lines.join('\n');
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const r of this.rules) {
      invariant(typeof r.caller === 'string' && r.caller.length > 0, 'a rule must name a caller');
      invariant(r.kind === 'exact' || r.scope.kind !== 'path' || r.scope.root.length > 0,
        'a path-scoped rule must name a root');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Shapes shared with the dialog
// ═══════════════════════════════════════════════════════════════════════

export interface PromptOption {
  id: string;
  label: string;
  tone: 'default' | 'good' | 'bad';
}

export interface PromptGroup {
  label: string;
  options: PromptOption[];
}

/**
 * What a capability object gets back.
 *
 * `restrictEnv` says the command should run without the host's credentials.
 * It is set for approvals that came from policy alone, and cleared for the two
 * cases where a person actually said yes to something: a prompt they answered,
 * and a standing rule or task grant they created earlier. An explicit grant
 * keeps the environment, because `gh` and `git push` need their tokens and
 * failing them silently would be worse than the exposure the user accepted.
 */
interface Outcome {
  decision: PermissionDecision;
  asked: boolean;
  restrictEnv?: boolean;
}

interface PermissionRequest {
  operation?: 'read' | 'write';
  requestedResource?: string;
  /** Attested only by the capability owner, for an existing user-configured grant. */
  preapproved?: boolean;
  skillPreapproved?: boolean;
  skillAuthenticated?: boolean;
  physicalPaths?: Array<{ logical: string; physical?: string }>;
  receipt?: PermissionReceipt;
  taskId?: string;
  type: 'shell' | 'directory' | 'domain' | 'skill_shell';
  resource: string;
  description?: string;
  cwd?: string;
  callerId?: AbjectId;
  objectName?: string;
  commandName?: string;
  skillName?: string;
}

interface WorkspaceRow {
  workspaceId: string;
  name: string;
  accessMode: WorkspaceAccessMode;
  whitelist: string[];
  exposedObjectIds: AbjectId[];
  childIds: AbjectId[];
  registryId: AbjectId;
}

/**
 * The stored form of a standing path or domain decision. Prefixed by type so a
 * path and a domain that happen to read the same never collide.
 */
function standingKey(type: string, resource: string): string {
  return `${type}:${resource}`;
}

/**
 * The type prefix a standing path decision is stored under.
 *
 * Path decisions carry the caller's name and operation, so "always allow" for
 * one object's reads never answers another object's writes. The name is used
 * rather than the object's id because ids are minted per run: a rule keyed on
 * the id would go dead at the next restart while still appearing in the list.
 */
function standingType(req: PermissionRequest, ctx: CallerContext): string {
  return req.type === 'directory' ? `directory:${req.operation ?? 'read'}:${ctx.name}` : req.type;
}

/** The effect class a filesystem operation belongs to. */
function fileEffect(operation: 'read' | 'write'): EffectClass {
  return operation === 'write' ? 'write' : 'read';
}

/**
 * The directory a filesystem grant names: the target's parent, since the
 * target is usually a file and a grant on a single file would ask again for
 * the file beside it.
 */
function fileGrantRoot(target: string): string {
  const parent = path.dirname(target);
  return parent === target ? target : parent;
}

/**
 * How a grant over several programs reads on a button.
 *
 * The label lists what is actually being granted. Naming one program while
 * quietly granting the rest of the pipeline would make the dialog a worse
 * record of the decision than the rules it writes.
 */
function describePrograms(programs: readonly string[]): string {
  const names = programs.filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** A path as a person would write it, with the home directory as `~`. */
function displayPath(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  return isInside(home, p) ? `~${p.slice(home.length)}` : p;
}

/**
 * A directory a grant could honestly name to cover these escapes.
 *
 * Files reduce to their parent directory, because a grant on a single file is
 * a loop waiting to happen: the next sibling asks again. Several escapes
 * reduce to their common ancestor.
 *
 * The answer is withheld, and no such button is offered, when nothing honest
 * could be granted: a path nobody can resolve is covered by no root at all,
 * and an ancestor as broad as a home directory or a top-level system directory
 * is not a permission anyone means to give from a dialog.
 */
function grantableRoot(escapes: readonly TouchedPath[]): string | undefined {
  if (escapes.length === 0) return undefined;
  if (escapes.some(e => e.unresolved || !e.resolved)) return undefined;

  let root: string | undefined = path.dirname(escapes[0].resolved!);
  for (const e of escapes.slice(1)) {
    root = commonAncestor(root!, path.dirname(e.resolved!));
    if (!root) return undefined;
  }
  if (!root || root === path.sep) return undefined;
  if (root === os.homedir()) return undefined;
  if (isSensitivePath(root)) return undefined;
  // A single segment is a top-level directory: /etc, /usr, /var.
  if (root.split(path.sep).filter(Boolean).length < 2) return undefined;
  return root;
}

/** The deepest directory that is a prefix of both paths, on path boundaries. */
function commonAncestor(a: string, b: string): string | undefined {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) break;
    shared.push(left[i]);
  }
  return shared.join(path.sep) || undefined;
}

function describeRule(r: Rule): string {
  const scope = (s: RuleScope) => s.kind === 'anywhere' ? 'anywhere' : s.kind === 'project' ? `in ${s.name}` : `under ${s.root}`;
  // A class rule covers filesystem calls as well as commands of that effect.
  if (r.kind === 'class') return `${r.caller} ${r.allow ? 'may perform' : 'is blocked from'} ${r.effect} operations ${scope(r.scope)}`;
  if (r.kind === 'program') return `${r.caller} ${r.allow ? 'may run' : 'is blocked from'} ${r.program} ${scope(r.scope)}`;
  // A standing path or domain decision is stored as `type:resource`; read it
  // back in those terms rather than as a command line.
  const standingPath = /^directory:(read|write):([^:]+):(.*)$/s.exec(r.command);
  if (standingPath) {
    return `${standingPath[2]} ${r.allow ? 'may' : 'may not'} ${standingPath[1]} "${standingPath[3]}"`;
  }
  const standing = /^(directory|domain|skill_shell):(.*)$/s.exec(r.command);
  if (standing) {
    return `${standing[1] === 'domain' ? 'Network' : 'Filesystem'} access to ` +
      `"${standing[2]}" is ${r.allow ? 'allowed' : 'blocked'}`;
  }
  return `${r.caller} ${r.allow ? 'may run' : 'is blocked from'} "${r.command}"`;
}
