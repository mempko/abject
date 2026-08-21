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

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import {
  analyzeCommand, checkContainment, protectedWrites, describeAnalysis, redactCommand,
  effectRank, type CommandAnalysis, type EffectClass,
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

/** How long a request may wait for a human before it gives up. */
const PROMPT_WAIT_MS = 30 * 60 * 1000;

/** How long a "for this task" grant survives without being renewed. */
const SESSION_GRANT_MS = 30 * 60 * 1000;

/** Auto-approvals one caller may take before it has to check in again. */
const DEFAULT_BUDGET = 200;

/** Decisions this object understands, whether from a dialog or from policy. */
export type PermissionDecision =
  | 'accept_once' | 'accept_always' | 'accept_object' | 'accept_session'
  | 'accept_class' | 'accept_program'
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

interface SessionGrant {
  caller: string;
  effect: EffectClass;
  scope: RuleScope;
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
    case 'private': return 'edit';
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
              name: 'removeRule',
              description: 'Drop a standing rule by its index in listRules',
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
      this.decide(msg.payload as PermissionRequest).then(
        (outcome) => this.sendDeferredReply(msg, outcome),
        (err) => {
          log.warn(`decide failed: ${err instanceof Error ? err.message : String(err)}`);
          this.sendDeferredReply(msg, { decision: 'deny', asked: false, restrictEnv: false });
        },
      );
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

    this.on('removeRule', async (msg: AbjectMessage) => {
      const { index } = msg.payload as { index: number };
      if (!Number.isInteger(index) || index < 0 || index >= this.rules.length) {
        return { success: false, error: 'No such rule' };
      }
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
      this.sessionGrants = caller
        ? this.sessionGrants.filter(g => g.caller !== caller)
        : [];
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

    // 1. A deny rule is the narrowest thing the user can say, and it outranks
    //    every allow list and every autonomy level.
    const denied = this.matchingRule(analysis, command, ctx.name, project, false);
    if (denied) {
      this.record(req, ctx, 'deny_object', false, `blocked by rule: ${describeRule(denied)}`, project);
      return { decision: 'deny_object', asked: false, restrictEnv: false };
    }

    // 2. A standing allow rule, or a grant made for this task.
    const allowed = this.matchingRule(analysis, command, ctx.name, project, true)
      ?? this.matchingSessionGrant(analysis, ctx.name, project);
    if (allowed) {
      this.record(req, ctx, 'accept_once', false,
        typeof allowed === 'object' && 'kind' in allowed ? `rule: ${describeRule(allowed)}` : 'granted for this task',
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
   * the case that used to prompt per directory. Everything else asks.
   */
  private async decideDirectory(req: PermissionRequest, ctx: CallerContext): Promise<Outcome> {
    const target = req.resource;
    const standing = this.standingVerdict(req.type, target);
    if (standing !== undefined) {
      this.record(req, ctx, standing ? 'accept_once' : 'deny', false,
        standing ? 'standing allow for this path' : 'standing block for this path');
      return { decision: standing ? 'accept_once' : 'deny', asked: false, restrictEnv: false };
    }
    const project = await this.projectFor(ctx, target);
    if (project) {
      const effective = this.effectiveLevel(ctx, project);
      if (autonomyRank(effective) >= autonomyRank('read') && isInside(project.root, target)) {
        this.record(req, ctx, 'accept_once', false,
          `inside trusted project "${project.name}" at ${effective}`, project, effective);
        return { decision: 'accept_once', asked: false, restrictEnv: false };
      }
    }
    return this.ask(req, ctx, undefined, 'path is not inside a project with standing access', project);
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

  private scopeMatches(scope: RuleScope, project?: ExternalProject): boolean {
    if (scope.kind === 'anywhere') return true;
    if (!project) return false;
    if (scope.kind === 'project') return scope.name === project.name;
    return isInside(scope.root, project.root) || isInside(project.root, scope.root);
  }

  /**
   * A rule covers a compound line only if it covers every program in it.
   *
   * This is what makes a grant usable at all: `cd x && sed … | grep …` is
   * allowed when `cd`, `sed` and `grep` are each allowed, and refused the
   * moment an unlisted program joins the pipeline.
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
        const hit = programRules.find(r => r.program === seg.program && this.scopeMatches(r.scope, project));
        if (hit) return hit;
      }
      return undefined;
    }

    if (analysis.opaque || analysis.effect === 'dangerous') return undefined;
    if (analysis.segments.length === 0) return undefined;

    // A class rule has to cover the containment question too, or it would be a
    // blanket grant for anything the program can reach.
    const coveringClass = classRules.find(r =>
      this.scopeMatches(r.scope, project)
      && effectRank(analysis.effect) <= effectRank(r.effect)
      && project !== undefined
      && checkContainment(analysis, [project.root]).contained);
    if (coveringClass) return coveringClass;

    let matched: Rule | undefined;
    for (const seg of analysis.segments) {
      const hit = programRules.find(r => r.program === seg.program && this.scopeMatches(r.scope, project));
      if (!hit) return undefined;
      matched = hit;
    }
    if (matched && project && !checkContainment(analysis, [project.root]).contained) return undefined;
    return matched;
  }

  private matchingSessionGrant(
    analysis: CommandAnalysis,
    caller: string,
    project?: ExternalProject,
  ): SessionGrant | undefined {
    const now = Date.now();
    this.sessionGrants = this.sessionGrants.filter(g => g.expiresAt > now);
    if (analysis.opaque || analysis.effect === 'dangerous') return undefined;
    return this.sessionGrants.find(g =>
      g.caller === caller
      && this.scopeMatches(g.scope, project)
      && effectRank(analysis.effect) <= effectRank(g.effect)
      && !!project
      && checkContainment(analysis, [project.root]).contained);
  }

  /**
   * A previous "always" on this exact path or domain, if there is one.
   * Undefined means nothing has been said about it.
   */
  private standingVerdict(type: string, resource: string): boolean | undefined {
    const key = standingKey(type, resource);
    const hit = this.rules.find(r => r.kind === 'exact' && r.command === key);
    return hit ? hit.allow : undefined;
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
    if (!settingsId) return 'deny';

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
          description: `${ctx.name} wants to ${req.type === 'shell' ? 'run a command' : 'access'}`
            + (project ? ` in ${project.name}` : ''),
          resource: redactCommand(req.resource),
          detail,
          groups,
          skillName: req.skillName,
        }),
        PROMPT_WAIT_MS,
      );
      return (reply?.decision as PermissionDecision) ?? 'deny';
    } catch (err) {
      log.warn(`prompt failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
      return 'deny';
    }
  }

  /**
   * The buttons, grouped narrowest-first.
   *
   * The program offered is the one that set the line's effect, not the first
   * word, so an agent that opens every command with `cd` is never asked whether
   * to block `cd`.
   */
  private optionsFor(
    req: PermissionRequest,
    ctx: CallerContext,
    analysis: CommandAnalysis | undefined,
    project?: ExternalProject,
  ): PromptGroup[] {
    const groups: PromptGroup[] = [];
    const program = analysis?.principalProgram;
    const canGrantBroadly = !!analysis && !analysis.opaque && analysis.effect !== 'dangerous';

    groups.push({
      label: 'This request',
      options: [
        { id: 'accept_once', label: 'Allow once', tone: 'default' },
        { id: 'deny', label: 'Deny once', tone: 'default' },
      ],
    });

    if (project && canGrantBroadly) {
      const options: PromptOption[] = [
        { id: 'accept_session', label: 'Allow for this task', tone: 'good' },
      ];
      if (analysis.effect === 'read') {
        options.push({ id: 'accept_class', label: `Allow read-only commands in ${project.name}`, tone: 'good' });
      } else if (analysis.effect === 'write') {
        options.push({ id: 'accept_class', label: `Allow file edits in ${project.name}`, tone: 'good' });
      }
      if (program) {
        options.push({ id: 'accept_program', label: `Always allow ${program} in ${project.name}`, tone: 'good' });
      }
      groups.push({ label: `In ${project.name}`, options });
    }

    const wide: PromptOption[] = [];
    if (program && canGrantBroadly) {
      wide.push({ id: 'accept_object', label: `Always allow ${program} anywhere`, tone: 'good' });
    }
    if (program) {
      wide.push({ id: 'deny_object', label: `Block ${program}`, tone: 'bad' });
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
    const program = analysis?.principalProgram;
    const scope: RuleScope = project ? { kind: 'project', name: project.name } : { kind: 'anywhere' };

    switch (decision) {
      case 'accept_session':
        if (analysis) {
          this.sessionGrants.push({
            caller: ctx.name,
            effect: analysis.effect,
            scope,
            expiresAt: Date.now() + SESSION_GRANT_MS,
          });
        }
        return;
      case 'accept_class':
        if (analysis) await this.addRule({ kind: 'class', caller: ctx.name, effect: analysis.effect, scope, allow: true });
        return;
      case 'accept_program':
        if (program) await this.addRule({ kind: 'program', caller: ctx.name, program, scope, allow: true });
        return;
      case 'accept_object':
        if (program) await this.addRule({ kind: 'program', caller: ctx.name, program, scope: { kind: 'anywhere' }, allow: true });
        return;
      case 'deny_object':
        if (program) await this.addRule({ kind: 'program', caller: ctx.name, program, scope: { kind: 'anywhere' }, allow: false });
        return;
      case 'accept_always':
        // Remembered here rather than pushed into the capability's own allow
        // list: updatePermissions REPLACES that list, so appending to it from
        // a dialog would quietly drop everything the user configured in
        // Settings. Answering from here also keeps one place to revoke.
        if (req.type !== 'shell') {
          await this.addRule({ kind: 'exact', caller: '*', command: standingKey(req.type, req.resource), allow: true });
        }
        return;
      case 'deny_always':
        if (req.type !== 'shell') {
          await this.addRule({ kind: 'exact', caller: '*', command: standingKey(req.type, req.resource), allow: false });
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
    this.decisions.push(entry);
    if (this.decisions.length > 500) this.decisions.splice(0, this.decisions.length - 500);
    if (!asked) log.info(`auto ${decision}: ${ctx.name} ${reason}`);
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

function describeRule(r: Rule): string {
  const scope = (s: RuleScope) => s.kind === 'anywhere' ? 'anywhere' : s.kind === 'project' ? `in ${s.name}` : `under ${s.root}`;
  if (r.kind === 'class') return `${r.caller} may run ${r.effect} commands ${scope(r.scope)}`;
  if (r.kind === 'program') return `${r.caller} ${r.allow ? 'may run' : 'is blocked from'} ${r.program} ${scope(r.scope)}`;
  // A standing path or domain decision is stored as `type:resource`; read it
  // back in those terms rather than as a command line.
  const standing = /^(directory|domain|skill_shell):(.*)$/s.exec(r.command);
  if (standing) {
    return `${standing[1] === 'domain' ? 'Network' : 'Filesystem'} access to ` +
      `"${standing[2]}" is ${r.allow ? 'allowed' : 'blocked'}`;
  }
  return `${r.caller} ${r.allow ? 'may run' : 'is blocked from'} "${r.command}"`;
}
