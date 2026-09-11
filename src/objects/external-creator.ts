import { domainFailure, type ResultContract } from '../core/result-contract.js';
/**
 * ExternalCreator — an on-disk authoring agent.
 *
 * ObjectCreator authors Abjects: its workspace is the live Registry, its file
 * is one handler-map source string, and its gate is deploy. ExternalCreator is
 * the same shape pointed at the host filesystem: its workspace is an external
 * project (a named directory), its file is a file, and its gate is whatever
 * that project declares about how to check itself.
 *
 * Two things are deliberately inverted relative to ObjectCreator.
 *
 * **The prompt is small.** ObjectCreator needs ~200 lines because it teaches a
 * world the model has never seen. Outside this system the model already knows
 * Node, git, and TypeScript better than any prompt could explain them, so the
 * instructions here are a tool contract and a handful of rules; everything
 * project-specific arrives from the project's own CLAUDE.md / AGENTS.md.
 *
 * **Nothing assumes the files are code.** An external project may be a
 * manuscript with a prose linter, or a folder of notes with no commands at all.
 * The action kernel (read / write / edit / bash / grep / find / ls) is
 * domain-neutral, and the gate degrades to honest reporting when a project
 * declares nothing to run.
 *
 * Three banner-delimited sections below:
 *   1. INFRASTRUCTURE   — types, deps, project + path resolution, checkpoints.
 *   2. OPERATIONS       — the action kernel, the checks, the gate, isolation.
 *   3. AGENT SHELL      — registration, observe/act, prompt, task lifecycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { errorDetails, type PermissionReceipt } from '../core/permission-outcome.js';
import { encodeAgentState } from '../core/agent-session-codec.js';
import * as path from 'path';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { require as precondition, invariant } from '../core/contracts.js';
import type { AgentAction, AgentActionResult } from './agent-abject.js';
import { bulkAwareResult, resultEcho } from './agent-abject.js';
import type { ExternalProject } from './external-project-registry.js';
import { ALWAYS_PROTECTED } from './external-project-registry.js';
import type { FileEdit } from '../core/file-edit.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ExternalCreator');

const EXTERNAL_CREATOR_INTERFACE: InterfaceId = 'abjects:external-creator';
export const EXTERNAL_CREATOR_ID = 'abjects:external-creator' as AbjectId;

/** Goal-scratchpad keys: how one task hands off to the next in the same goal. */
const SESSION_KEY = 'externalcreator:session';

/**
 * Steps a code task gets before the budget check. Reading a file in pages,
 * editing, and running two verifications comfortably takes 60 steps; the old
 * 50 had both tasks of a two-round goal finishing on step 49 and calling it
 * "the last step". Progress-based extensions still apply on top.
 */
export const DEFAULT_TASK_STEPS = 80;
const MIN_TASK_STEPS = 20;
const MAX_TASK_STEPS = 120;

/** A planner-requested budget, clamped; anything unusable means the default. */
export function taskStepBudget(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_TASK_STEPS;
  return Math.min(MAX_TASK_STEPS, Math.max(MIN_TASK_STEPS, Math.round(n)));
}
/** Goal scratchpad prefix for structured verification receipts, one per task. */
export const VERIFICATION_KEY_PREFIX = 'verification/';

/** One run of a project-declared command, as recorded on the goal scratchpad. */
export interface VerificationRun {
  command: string;
  exitCode: number;
  at: number;
  passed: boolean;
  testSummary?: { tests?: number; passed?: number; failed?: number };
  failureCount?: number;
  newFailures: number;
  foreignFailures: number;
  preExisting: number;
}

/** What a task's verification actually was, written when the task ends. */
export interface VerificationReceipt {
  taskId: string;
  agent: string;
  project?: string;
  at: number;
  outcome: 'complete' | 'incomplete' | 'cancelled';
  filesModified: number;
  mutationsSinceVerify: number;
  gate: { ok: boolean; note: string };
  verify?: VerificationRun;
  check?: VerificationRun;
}
const BASELINE_KEY = 'externalcreator:baseline';

/** Long enough for a real build; short enough that a hung command is noticed. */
const BASH_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 900_000;

// ══════════════════════════════════════════════════════════════════════
// 1. INFRASTRUCTURE
// ══════════════════════════════════════════════════════════════════════

/** One run of a project-declared command, reduced to something comparable. */
interface CheckOutcome {
  taskId?: string;
  workRoot?: string;
  revision?: string;
  stable?: boolean;
  snapshotNote?: string;
  outputObjectId?: AbjectId;
  outputTruncated?: unknown;
  testSummary?: { tests?: number; passed?: number; failed?: number };
  command: string;
  exitCode: number;
  /**
   * Diagnostic lines with their volatile parts removed, so the same underlying
   * failure produces the same string across runs. Line numbers are stripped on
   * purpose: inserting a line at the top of a file must not make every
   * pre-existing error in it look new.
   */
  signatures: string[];
  /**
   * The runner's own failure count, when its summary line states one
   * ("Found 3 errors", "Tests: 2 failed", "2 failed", "--- FAIL:"). A second
   * signal beside the signatures: a count that grew while no new signature
   * was recognized means the output format escaped the regexes, and the run
   * is judged inconclusive rather than clean.
   */
  failureCount?: number;
  at: number;
  /** Bounded output, for reporting. */
  output: string;
}

/** What the project already failed at before this task touched anything. */
interface Baseline {
  project: string;
  /** git HEAD at capture, so a baseline from a different commit is discarded. */
  head?: string;
  check?: CheckOutcome;
  verify?: CheckOutcome;
  capturedAt: number;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  /** False when we adopted an existing worktree rather than creating it. */
  created: boolean;
}

/** A check run against its baseline. */
interface CheckVerdict {
  outcome: CheckOutcome;
  /**
   * New failures in files THIS task wrote. These block `done`. When the task
   * has written nothing yet, every new failure counts here.
   */
  newFailures: string[];
  /**
   * New failures in files this task did not touch. Several tasks may work in
   * one checkout at once, so these are reported as concurrent work and never
   * block this task; the round's review sees the combined state.
   */
  foreignFailures: string[];
  /** Pre-existing failures still present. Advisory, never blocking. */
  preExisting: number;
  passed: boolean;
  /** Set when there was no baseline to compare against. */
  unbaselined?: boolean;
  /**
   * The command failed but nothing in its output was recognized as a failure
   * line, or its own failure count grew with no new signature to show for it.
   * The verdict cannot say whose failure it is, so it never passes.
   */
  inconclusive?: boolean;
}

interface TaskExtra {
  permissionEvidence?: PermissionReceipt[];
  taskId: string;
  taskText: string;
  goalId?: string;
  project?: ExternalProject;
  /** Where edits actually land: the project root, or its worktree. */
  workRoot?: string;
  worktree?: WorktreeInfo;
  baseline?: Baseline;
  lastResult?: string;
  /** True while an edit set is open (`more: true`), so checks hold off. */
  editSetOpen: boolean;
  filesRead: Set<string>;
  filesModified: Set<string>;
  /** Pre-edit content, so a mechanical failure can be undone precisely. */
  preImages: Map<string, string>;
  /**
   * What this task last wrote to each file. A rollback restores the pre-image
   * only while the file still holds exactly this; anything else means another
   * task has edited it since, and overwriting their work to undo ours is the
   * one thing a rollback must never do.
   */
  postImages: Map<string, string>;
  /**
   * The verify baseline being captured in the background (see
   * captureBaseline). `tainted` flips the moment this task writes a file
   * while the capture is still running: a baseline taken over a tree that was
   * changing under it cannot say what pre-existed, so it is discarded.
   */
  verifyBaseline?: { promise: Promise<void>; tainted: boolean; done: boolean };
  /** Directories whose own instruction files were already shown this task. */
  instructionDirsSeen: Set<string>;
  /** Writes and edits since the last passing verify. Drives the gate. */
  mutationsSinceVerify: number;
  unknownEffects?: boolean;
  projectSession?: boolean;
  commandOutputs?: Set<AbjectId>;
  cancelled?: boolean;
  lastCheck?: CheckVerdict;
  lastVerify?: CheckVerdict;
  checkpoints: Array<{ ref: string; at: number; note: string }>;
  /** Full action record. Stays out of the conversation; goes to the report. */
  audit: string[];
  /** The agent's own intermediate remarks, kept for the session summary. */
  decisions: string[];
}

export class ExternalCreator extends Abject {
  private agentAbjectId?: AbjectId;
  private projectsId?: AbjectId;
  private hostFsId?: AbjectId;
  private shellId?: AbjectId;
  private goalManagerId?: AbjectId;
  private jobManagerId?: AbjectId;
  private verificationRuns = new Map<string, Promise<CheckOutcome>>();

  private readonly operationTask = new AsyncLocalStorage<string>();
  private taskExtras = new Map<string, TaskExtra>();
  private _currentGoalId?: string;

  constructor() {
    super({
      manifest: {
        name: 'ExternalCreator',
        description:
          'Authoring agent for external projects: named directories of files on the host. ' +
          'Reads, writes, and edits files, runs shell commands, and runs whatever check and ' +
          'verify commands the project declares, reporting exactly what it verified and what it ' +
          'could not. Works on software, prose, notes, or data — nothing assumes the files are code. ' +
          'Changes to Abjects inside this system belong to a different agent.',
        version: '1.0.0',
        icon: '🛠',
        interface: {
          id: EXTERNAL_CREATOR_INTERFACE,
          name: 'ExternalCreator',
          description: 'On-disk authoring agent',
          methods: [
            {
              name: 'runTask',
              description: 'Do a piece of work in an external project',
              parameters: [
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'What to do' },
                { name: 'project', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle or a path inside it', optional: true },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.LLM_QUERY, reason: 'Drives the authoring loop', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'agent', 'external', 'files'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.projectsId = await this.discoverDep('ExternalProjectRegistry') ?? undefined;
    this.hostFsId = await this.discoverDep('HostFileSystem') ?? undefined;
    this.shellId = await this.discoverDep('ShellExecutor') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;

    await this.registerWithAgentAbject();
    log.info('Registered with AgentAbject');
  }

  protected override askBusyStatus(): string | undefined {
    return this.taskExtras.size > 0
      ? `working in ${this.taskExtras.size} external project task${this.taskExtras.size === 1 ? '' : 's'}`
      : undefined;
  }

  protected override askPrompt(question: string): string {
    return super.askPrompt(question) + `\n\n## ExternalCreator — files on disk

I work inside **external projects**: named directories on the host holding a body
of work. That is the counterpart to a workspace, which is the project *inside*
this system. I read, write, and edit files, run shell commands in the project,
and run whatever check and verify commands the project declares about itself.

An external project is not assumed to be code. Source, prose, notes, data,
configuration — same tools, same discipline.

### I answer YES to
- Changing, adding, or removing files inside a registered external project
- Investigating a registered project and reporting what is there
- Running a project's build, tests, linter, formatter, or any shell command in it
- Fixing something that a compiler, test suite, or linter reports
- Anything naming a path that lies inside a registered project whose root is on disk

### I answer PASS to
- Creating or modifying Abjects inside this system: objects, their source, their
  windows, their handlers. Those live in the Registry, not on disk, and belong to
  the object-authoring agent.
- Interactive web browsing, and installed skill flows.
- Reading, inspecting, or summarizing files that lie outside every registered
  project: a download, a sample export, a config file, a loose directory. The
  agent that reads files anywhere on this machine and runs shell commands
  handles those. I say which registered project, if any, the path is near, and
  I do not pick a project the task did not name.
- Work in a registered project whose root is missing on disk. I say so and PASS
  rather than start a task that cannot be prepared.

The list of registered projects below is live. Check the paths in the question
against it before answering; a path inside no registered root is a PASS.

### Working beside other tasks
Several of my tasks may work in one project at once; a scrum round stages them
that way. Each one sees the others and the files they have written, and is judged
only on failures in files it wrote itself. Partition parallel tasks by area so they
do not edit the same files.

### What I promise about verification
When a project declares a check or verify command, I run it and compare against a
baseline captured before I touched anything, so I am accountable for failures I
introduced and not for the ones already there. When a project declares nothing to
run, I say plainly what I changed and what I could not verify. I never report a
clean result I did not observe.`;
  }

  /**
   * Ask answers are grounded in the live project list: which roots exist,
   * which are missing on disk. Without it the model would answer YES to any
   * path that sounds like a directory, which is how loose files in a download
   * folder ended up dispatched here.
   */
  protected override async handleAsk(question: string, _callerId?: AbjectId): Promise<string> {
    return this.askLlm(this.askPrompt(question) + await this.askAvailabilityContext(), question, this.askTier());
  }

  protected override async askAvailabilityContext(): Promise<string> {
    const reg = await this.projects();
    if (!reg) return '\n\n### Registered external projects right now\nNone: the project registry is not available.';
    let all: ExternalProject[] = [];
    try {
      all = await this.call<ExternalProject[]>(reg, 'listProjects', {}, 15_000);
    } catch {
      return '\n\n### Registered external projects right now\nUnknown: the project registry did not answer.';
    }
    if (all.length === 0) return '\n\n### Registered external projects right now\nNone. Every path is outside a registered project.';
    const lines = all.map(p =>
      `- ${p.name}: ${p.root}${p.rootMissing ? ' (root MISSING on disk; no task can start here)' : ''}`);
    return `\n\n### Registered external projects right now\n${lines.join('\n')}`;
  }

  private async hostFs(): Promise<AbjectId> {
    this.hostFsId = await this.resolveDep('HostFileSystem', this.hostFsId);
    if (!this.hostFsId) throw new Error('HostFileSystem is not available');
    return this.hostFsId;
  }

  private async shell(): Promise<AbjectId> {
    this.shellId = await this.resolveDep('ShellExecutor', this.shellId);
    if (!this.shellId) throw new Error('ShellExecutor is not available');
    return this.shellId;
  }

  private async projects(): Promise<AbjectId | undefined> {
    this.projectsId = await this.resolveDep('ExternalProjectRegistry', this.projectsId);
    return this.projectsId;
  }

  private async call<T = unknown>(
    target: AbjectId,
    method: string,
    payload: unknown,
    timeoutMs = 60_000,
  ): Promise<T> {
    const taskId = this.operationTask.getStore();
    if (taskId && payload && typeof payload === 'object' && (target === this.hostFsId || target === this.shellId)) {
      payload = { ...payload, taskId };
    }
    const retain = (permission?: PermissionReceipt) => {
      const extra = taskId ? this.taskExtras.get(taskId) : undefined;
      if (extra && permission) {
        (extra.permissionEvidence ??= []).push(permission);
        if (extra.permissionEvidence.length > 30) extra.permissionEvidence.splice(0, extra.permissionEvidence.length - 30);
      }
    };
    try {
      const result = await this.request<T>(request(this.id, target, method, payload), timeoutMs);
      retain((result as any)?.permission);
      return result;
    } catch (error) {
      retain((errorDetails(error) as any)?.permission);
      throw error;
    }
  }

  private reportProgress(extra: TaskExtra, phase: string, message: string): void {
    if (!this.goalManagerId || !extra.goalId) return;
    this.send(event(this.id, this.goalManagerId, 'updateProgress', {
      goalId: extra.goalId,
      message,
      phase,
      agentName: 'ExternalCreator',
    }));
  }

  // ─── Project and path resolution ────────────────────────────────

  private async listProjects(): Promise<ExternalProject[]> {
    const reg = await this.projects();
    if (!reg) return [];
    try {
      const all = await this.call<ExternalProject[]>(reg, 'listProjects', {}, 15_000);
      // A project whose root is gone is not somewhere a task can start; it
      // stays registered for the user to fix, not for the agent to pick.
      const missing = all.filter(p => p.rootMissing);
      if (missing.length > 0) log.warn(`skipping ${missing.map(p => `${p.name} (${p.root})`).join(', ')}: root missing`);
      return all.filter(p => !p.rootMissing);
    } catch {
      return [];
    }
  }

  private async resolveProject(nameOrPath: string): Promise<ExternalProject | undefined> {
    const reg = await this.projects();
    if (!reg || !nameOrPath) return undefined;
    try {
      return await this.call<ExternalProject | null>(reg, 'resolveProject', { nameOrPath }, 15_000) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Work out which project a task belongs to, in decreasing order of how
   * explicit the evidence is. Guessing wrong here means editing the wrong
   * repository, so a weak signal loses to no answer at all: with nothing
   * conclusive the loop starts unset and the agent picks.
   */
  private async pickProject(taskText: string, data?: Record<string, unknown>): Promise<ExternalProject | undefined> {
    // `target` is what a planner sends when it means "work here"; the other
    // two are older spellings of the same intent.
    const hint = typeof data?.project === 'string' ? data.project
      : typeof data?.projectPath === 'string' ? data.projectPath
      : typeof data?.target === 'string' ? data.target
      : undefined;
    const hintIsPath = hint !== undefined && /^~?\//.test(hint);
    if (hint) {
      const byHint = await this.resolveProject(hint);
      if (byHint) return byHint;
      // A path that lies in no registered project is a clear answer: the
      // task is about somewhere else, and guessing a project would run the
      // task against the wrong directory.
      if (hintIsPath) return undefined;
    }

    const all = await this.listProjects();
    if (all.length === 0) return undefined;

    // An absolute path in the task text is as explicit as a hint, in both
    // directions: inside a project selects it, outside every project rules
    // them all out.
    const pathMatch = taskText.match(/(?:^|\s)(~?\/[\w.\-/]+)/);
    if (pathMatch) {
      const byPath = await this.resolveProject(pathMatch[1]);
      return byPath ?? undefined;
    }

    // A project named in the text, matched on a word boundary so "abjects"
    // does not match inside an unrelated word.
    const named = all.filter(p => new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(taskText));
    if (named.length === 1) return named[0];

    if (all.length === 1) return all[0];
    return undefined;
  }

  /**
   * Turn an agent-supplied path into an absolute one inside the work root.
   *
   * Relative paths are the normal case and resolve against the work root.
   * An absolute path is accepted only if it lands inside that root: an agent
   * working in one project has no business writing into another, and in
   * worktree isolation an absolute path into the main checkout would silently
   * defeat the isolation.
   */
  private resolveWorkPath(extra: TaskExtra, p: string): string {
    precondition(typeof p === 'string' && p.length > 0, 'path must be a non-empty string');
    const root = extra.workRoot;
    if (!root) throw new Error('No project selected. Use set_project first.');

    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `"${p}" is outside the project (${root}). Paths are relative to the project root; ` +
        `Ask the capability owner about access to another location.`,
      );
    }
    return abs;
  }

  /** Path as the agent should see it in reports: relative to the work root. */
  private displayPath(extra: TaskExtra, abs: string): string {
    return extra.workRoot ? path.relative(extra.workRoot, abs) || '.' : abs;
  }

  private protectedPathsFor(extra: TaskExtra): string[] {
    return [...ALWAYS_PROTECTED, ...(extra.project?.protectedPaths ?? [])];
  }

  /**
   * Refuse a write to something the project declared off-limits. This lives
   * here rather than in a general guard because it is about a project's own
   * declared boundaries, and because the useful outcome is a precise message
   * back to the agent rather than a silent block.
   */
  private assertWritable(extra: TaskExtra, abs: string): void {
    const rel = this.displayPath(extra, abs).split(path.sep).join('/');
    for (const guard of this.protectedPathsFor(extra)) {
      const g = guard.split(path.sep).join('/');
      const hit = g.endsWith('/')
        ? rel === g.slice(0, -1) || rel.startsWith(g)
        : rel === g || path.basename(rel) === g;
      if (hit) {
        throw new Error(
          `"${rel}" is a protected path in this project and will not be written. ` +
          `Protected: ${this.protectedPathsFor(extra).join(', ')}`,
        );
      }
    }
  }

  // ─── git helpers ────────────────────────────────────────────────

  private async git(
    extra: TaskExtra,
    args: string,
    cwd?: string,
    timeoutMs = 60_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const shellId = await this.shell();
    return this.call<{ stdout: string; stderr: string; exitCode: number }>(
      shellId, 'exec',
      { command: `git ${args}`, taskId: extra.taskId, shell: true, cwd: cwd ?? extra.workRoot, timeout: timeoutMs, untrusted: this.isUntrusted(extra) },
      timeoutMs + 15_000,
    );
  }

  /**
   * Trust is a statement about the directory, and it has to reach the object
   * that actually runs commands. ShellExecutor skips its standing grants for
   * an untrusted project, so every command there goes to the permission
   * authority, which knows the project's autonomy is "ask" and prompts.
   */
  private isUntrusted(extra: TaskExtra): boolean {
    return extra.project !== undefined && !extra.project.trusted;
  }

  private async gitHead(extra: TaskExtra): Promise<string | undefined> {
    if (extra.project?.vcs !== 'git') return undefined;
    try {
      const r = await this.git(extra, 'rev-parse HEAD');
      return r.exitCode === 0 ? r.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A restorable snapshot that does NOT disturb the working tree.
   *
   * `git stash create` builds the stash commit and prints its sha without
   * touching the index, the tree, or the stash list — so a checkpoint costs
   * the user nothing and can be taken as often as is useful. An empty result
   * means there was nothing to snapshot, which is not a failure.
   */
  private async checkpoint(extra: TaskExtra, note: string): Promise<void> {
    if (extra.project?.vcs !== 'git') return;
    try {
      const r = await this.git(extra, 'stash create');
      const ref = r.stdout.trim();
      if (r.exitCode === 0 && ref) {
        extra.checkpoints.push({ ref, at: Date.now(), note });
        this.audit(extra, `checkpoint ${ref.slice(0, 10)} (${note})`);
      }
    } catch (err) {
      log.warn(`checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private audit(extra: TaskExtra, line: string): void {
    extra.audit.push(`${new Date().toISOString()} ${line}`);
    // The audit trail is for the report and the object log, never for the
    // conversation: it is exactly the kind of bulk that crowds out reasoning.
    this.logInfo(`[${extra.taskId.slice(0, 8)}] ${line}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. OPERATIONS
  // ══════════════════════════════════════════════════════════════════

  // ─── Diagnostics: turning output into something comparable ──────

  /** Strip ANSI colour so a signature does not depend on terminal detection. */
  private static stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\[[0-9;]*m/g, '');
  }

  /**
   * Reduce a command's output to a set of stable failure signatures.
   *
   * Line and column numbers are deliberately removed: they move whenever a
   * line is inserted above, and a baseline that shifts under every edit would
   * report every pre-existing error as newly introduced. What is left — the
   * file, the code, and the message — identifies the same failure across runs.
   */
  private static signaturesOf(output: string, root?: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const looksLikeFailure =
      /(^|\s)(error|Error|ERROR|FAIL|FAILED|Failed|failing|✕|✗|×|●|panic:|Exception|Traceback)\b|error\s+TS\d+|:\s*error\s*:/;

    for (const raw of ExternalCreator.stripAnsi(output).split('\n')) {
      const line = raw.trimEnd();
      if (line.trim().length === 0) continue;
      if (!looksLikeFailure.test(line)) continue;

      let sig = line.trim();
      if (root) sig = sig.split(root).join('').replace(/^[/\\]+/, '');
      sig = sig
        .replace(/\((\d+),\s*(\d+)\)/g, '')      // tsc's (line,col)
        .replace(/:\d+:\d+/g, '')                 // eslint / rustc file:line:col
        .replace(/:\d+(?=[:\s]|$)/g, '')          // file:line
        .replace(/\b\d+(\.\d+)?\s*m?s\b/g, '')    // timings
        .replace(/\s+/g, ' ')
        .trim();
      if (sig.length < 4) continue;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(sig);
      // A wall of identical-shaped failures teaches nothing past the first few
      // dozen, and the comparison only needs enough to spot a new one.
      if (out.length >= 200) break;
    }
    return out;
  }

  private async runCommand(
    extra: TaskExtra,
    command: string,
    timeoutMs: number,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated?: unknown; outputObjectId?: AbjectId }> {
    if (extra.cancelled) throw new Error('Task cancelled');
    const shellId = await this.shell();
    if (extra.cancelled) throw new Error('Task cancelled');
    const result = await this.call<{ stdout: string; stderr: string; exitCode: number; truncated?: unknown; outputObjectId?: AbjectId }>(
      shellId, 'exec',
      { command, taskId: extra.taskId, shell: true, cwd: cwd ?? extra.workRoot, timeout: timeoutMs, untrusted: this.isUntrusted(extra) },
      timeoutMs + 30_000,
    );
    if (result.outputObjectId) (extra.commandOutputs ??= new Set()).add(result.outputObjectId);
    return result;
  }

  /**
   * The failure count a runner states about itself, when it states one.
   * Covers the summaries of tsc, vitest/jest, mocha, pytest, cargo test, and
   * go test. Absent when no summary is recognized; that is not zero.
   */
  private static failureCountOf(output: string): number | undefined {
    const text = ExternalCreator.stripAnsi(output);
    const counts: number[] = [];
    const take = (re: RegExp): void => {
      for (const m of text.matchAll(re)) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) counts.push(n);
      }
    };
    take(/^(?:ℹ|#)\s+fail\s+(\d+)\s*$/gm);              // Node test runner
    take(/Found (\d+) errors?/g);                          // tsc
    take(/Tests?:\s+(\d+) failed/g);                       // jest / vitest
    take(/\b(\d+) failing\b/g);                            // mocha
    take(/^={3,}.*?\b(\d+) failed\b.*?={3,}$/gm);           // pytest summary line
    take(/test result: \w+\. \d+ passed; (\d+) failed/g);  // cargo test
    const goFails = (text.match(/^--- FAIL:/gm) ?? []).length;
    if (goFails > 0) counts.push(goFails);
    if (counts.length === 0) return undefined;
    return Math.max(...counts);
  }

  private async projectRevision(extra: TaskExtra): Promise<{ revision?: string; complete: boolean; changed?: string[]; issues?: string[] }> {
    const registry = await this.projects();
    if (!registry || !extra.project) return { complete: false };
    if (!extra.projectSession) {
      await this.call(registry, 'openSession', { project: extra.project.name, taskId: extra.taskId, root: extra.workRoot });
      extra.projectSession = true;
    }
    const revision = await this.call<{ revision: string; complete: boolean; changed: string[]; issues?: string[] }>(registry, 'captureRevision', { taskId: extra.taskId, includePaths: [...extra.filesModified] }, 120000);
    for (const rel of revision.changed) extra.filesModified.add(path.resolve(extra.workRoot!, rel));
    return revision;
  }

  private async verificationSnapshot(extra: TaskExtra): Promise<{ revision?: string; complete: boolean; changed?: string[]; issues?: string[] }> {
    try { return await this.projectRevision(extra); }
    catch (err) { return { complete: false, issues: [`Snapshot unavailable: ${err instanceof Error ? err.message : String(err)}`] }; }
  }

  private checkOutcome(extra: TaskExtra, command: string, r: { stdout: string; stderr: string; exitCode: number; truncated?: unknown; outputObjectId?: AbjectId }, before: { revision?: string; complete: boolean; issues?: string[] }, after: { revision?: string; complete: boolean; issues?: string[]; changed?: string[] }): CheckOutcome {
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const stable = before.complete && after.complete && before.revision === after.revision;
    const snapshotNote = !before.complete || !after.complete
      ? `Snapshot coverage was incomplete: ${[...(before.issues ?? []), ...(after.issues ?? [])].slice(0, 5).join('; ') || 'not all project inputs could be read'}.`
      : !stable ? `Project inputs changed during the command${after.changed?.length ? `: ${after.changed.slice(0, 8).join(', ')}` : ''}. The exit status is valid, but it does not establish an unchanged input revision.` : undefined;
    const counts: Record<string, number> = {};
    for (const match of output.matchAll(/^(?:ℹ|#)\s+(tests|pass|fail)\s+(\d+)\s*$/gm)) counts[match[1]] = Number(match[2]);
    const testSummary = Object.keys(counts).length ? { tests: counts.tests, passed: counts.pass, failed: counts.fail } : undefined;
    return { command, taskId: extra.taskId, workRoot: extra.workRoot, testSummary, revision: after.revision, stable, snapshotNote, exitCode: r.exitCode, outputObjectId: r.outputObjectId, outputTruncated: r.truncated,
      signatures: r.exitCode === 0 ? [] : ExternalCreator.signaturesOf(output, extra.workRoot), failureCount: ExternalCreator.failureCountOf(output), at: Date.now(), output };
  }

  private async captureOutcome(extra: TaskExtra, command: string, timeoutMs: number): Promise<CheckOutcome> {
    const key = `${extra.taskId}:${command}`;
    const running = this.verificationRuns.get(key);
    if (running) return running;
    const run = (async () => {
      const before = await this.verificationSnapshot(extra);
      const r = await this.runCommand(extra, command, timeoutMs);
      const after = await this.verificationSnapshot(extra);
      return this.checkOutcome(extra, command, r, before, after);
    })();
    this.verificationRuns.set(key, run);
    try { return await run; } finally { if (this.verificationRuns.get(key) === run) this.verificationRuns.delete(key); }
  }

  /**
   * Judge a run against the baseline.
   *
   * The rule that makes this usable on a real repository: a project that was
   * already failing stays failing without blocking anything. Only a failure
   * the baseline does not have counts against this task. A baseline that was
   * green makes any failure new by definition.
   */
  private judge(outcome: CheckOutcome, baseline: CheckOutcome | undefined, touched: string[] = []): CheckVerdict {
    if (outcome.exitCode === 0) {
      return { outcome, newFailures: [], foreignFailures: [], preExisting: baseline?.signatures.length ?? 0, passed: true };
    }
    if (outcome.stable === false) return { outcome, newFailures: outcome.signatures, foreignFailures: [], preExisting: 0, passed: false, inconclusive: true };
    if (!baseline || baseline.stable === false || baseline.command !== outcome.command) {
      return { outcome, newFailures: outcome.signatures, foreignFailures: [], preExisting: 0, passed: false, unbaselined: true };
    }
    if (baseline.exitCode === 0) {
      const split = ExternalCreator.attribute(outcome.signatures, touched);
      return { outcome, ...split, preExisting: 0, passed: false, inconclusive: outcome.signatures.length === 0 };
    }

    const known = new Set(baseline.signatures);
    const fresh = outcome.signatures.filter(s => !known.has(s));
    const preExisting = outcome.signatures.length - fresh.length;

    // The command failed and nothing new was recognized. Two readings, both
    // untrustworthy as a pass: the output format escaped the regexes (no
    // signatures at all), or the runner's own count grew while its failure
    // lines look like the old ones. Say so rather than declare it clean.
    const countGrew = outcome.failureCount !== undefined
      && baseline.failureCount !== undefined
      && outcome.failureCount > baseline.failureCount;
    if (fresh.length === 0 && (outcome.signatures.length === 0 || countGrew)) {
      return { outcome, newFailures: [], foreignFailures: [], preExisting, passed: false, inconclusive: true };
    }

    const split = ExternalCreator.attribute(fresh, touched);
    return {
      outcome,
      ...split,
      preExisting,
      passed: fresh.length === 0,
    };
  }

  /**
   * Split new failures into ours and someone else's by file. A signature
   * naming a file this task wrote is ours; one naming only other files is a
   * concurrent task's (or a knock-on effect the round's review will see).
   * With nothing written yet there is no basis to split, and everything is
   * ours.
   */
  private static attribute(fresh: string[], touched: string[]): { newFailures: string[]; foreignFailures: string[] } {
    if (touched.length === 0 || fresh.length === 0) return { newFailures: fresh, foreignFailures: [] };
    const names = touched.map(t => t.split(path.sep).join('/'));
    const newFailures: string[] = [];
    const foreignFailures: string[] = [];
    for (const sig of fresh) {
      const mentionsFile = /[\w./-]+\.[a-z]{1,8}\b/i.test(sig);
      const ours = names.some(n => sig.includes(n) || sig.includes(path.basename(n)));
      // A failure that names no file at all (a runner-level error) cannot be
      // attributed away; it stays ours.
      if (ours || !mentionsFile) newFailures.push(sig);
      else foreignFailures.push(sig);
    }
    return { newFailures, foreignFailures };
  }

  private renderVerdict(v: CheckVerdict): string {
    const head = `\`${v.outcome.command}\` exited ${v.outcome.exitCode}`;
    const foreign = v.foreignFailures.length > 0
      ? `\n${v.foreignFailures.length} new failure(s) are in files this task did not write — other tasks are working in this ` +
        `project, so these are unexplained and block completion until their cause is established:\n` +
        v.foreignFailures.slice(0, 10).map(s => `  ${s}`).join('\n') +
        (v.foreignFailures.length > 10 ? `\n  … and ${v.foreignFailures.length - 10} more` : '')
      : '';
    if (v.passed && v.outcome.exitCode === 0) {
      return `${head} — passed.${v.outcome.snapshotNote ? `\nVerification limitation: ${v.outcome.snapshotNote} Do not rerun solely to obtain identical snapshots; report this limitation.` : ''}`;
    }
    if (v.inconclusive) {
      const tail = (v.outcome.output ?? '').trim().split('\n').slice(-12).join('\n');
      if (v.outcome.stable === false) return `${head} — failed; comparison with the baseline is uncertain. ${v.outcome.snapshotNote ?? 'Project inputs were not stable during the command.'}\n${tail}`;
      return `${head} — INCONCLUSIVE: the command failed but no failure line was recognized as new` +
        (v.outcome.failureCount !== undefined ? ` while its own failure count is ${v.outcome.failureCount}` : '') +
        `. This does not pass. Read the output and decide what failed; the last lines were:\n${tail}`;
    }
    if (v.passed) {
      return `${head}, but every failure was already there before this task ` +
        `(${v.preExisting} pre-existing). Nothing new was introduced by you.${foreign}`;
    }
    const lines = v.newFailures.slice(0, 25).map(s => `  ${s}`).join('\n');
    const more = v.newFailures.length > 25 ? `\n  … and ${v.newFailures.length - 25} more` : '';
    const caveat = v.unbaselined
      ? ' (no baseline was captured, so these may or may not predate this task)'
      : ` (${v.preExisting} other failures predate this task and are not yours)`;
    return `${head} — ${v.newFailures.length} failure(s) attributable to this task${caveat}:\n${lines}${more}${foreign}`;
  }

  // ─── Baseline ───────────────────────────────────────────────────

  /**
   * Capture what the project already fails at, before anything is touched.
   *
   * Cached in the goal scratchpad and keyed by git HEAD, so the first task in a
   * goal pays for it and the rest inherit it — and a baseline captured against
   * a different commit is thrown away rather than quietly misleading the delta.
   */
  private async captureBaseline(extra: TaskExtra): Promise<void> {
    const project = extra.project;
    if (!project) return;
    if (!project.checkCommand && !project.verifyCommand) return;

    const head = await this.gitHead(extra);
    const cached = await this.readGoalData<Baseline>(extra, BASELINE_KEY);
    const revision = await this.projectRevision(extra);
    if (cached && revision.complete && cached.project === project.name && cached.head === head
        && (!project.checkCommand || (cached.check?.command === project.checkCommand && cached.check.revision === revision.revision))
        && (!project.verifyCommand || (cached.verify?.command === project.verifyCommand && cached.verify.revision === revision.revision))) {
      extra.baseline = cached;
      this.audit(extra, `baseline reused from goal (head ${head?.slice(0, 8) ?? 'n/a'})`);
      return;
    }

    const baseline: Baseline = { project: project.name, head, capturedAt: Date.now() };

    if (project.checkCommand) {
      this.reportProgress(extra, 'observing', `baseline: ${project.checkCommand}`);
      try {
        baseline.check = await this.captureOutcome(extra, project.checkCommand, VERIFY_TIMEOUT_MS);
        this.audit(extra, `baseline check exit=${baseline.check.exitCode} (${baseline.check.signatures.length} known failures)`);
      } catch (err) {
        this.audit(extra, `baseline check could not run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    extra.baseline = baseline;
    await this.writeGoalData(extra, BASELINE_KEY, baseline);

    // The verify command can take minutes, and the task should not wait for
    // it: the agent reads and plans first, and the first `verify` action is
    // usually well after that. So it runs in the background against the tree
    // as it stands now. If this task writes a file before the run finishes,
    // the run was over a changing tree and is discarded (see `taint`); the
    // check baseline then stands in, as it did before this existed.
    if (project.verifyCommand && project.verifyCommand !== project.checkCommand) {
      const state = { tainted: false, done: false, promise: Promise.resolve() };
      state.promise = (async () => {
        this.reportProgress(extra, 'observing', `baseline (background): ${project.verifyCommand}`);
        try {
          const outcome = await this.captureOutcome(extra, project.verifyCommand!, VERIFY_TIMEOUT_MS);
          if (state.tainted) {
            this.audit(extra, 'baseline verify discarded — this task wrote files while it ran');
          } else if (extra.baseline) {
            extra.baseline.verify = outcome;
            this.audit(extra, `baseline verify exit=${outcome.exitCode} (${outcome.signatures.length} known failures)`);
            await this.writeGoalData(extra, BASELINE_KEY, extra.baseline);
          }
        } catch (err) {
          this.audit(extra, `baseline verify could not run: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          state.done = true;
        }
      })();
      extra.verifyBaseline = state;
    }
  }

  /** A write while the background verify baseline is still running spoils it. */
  private taintVerifyBaseline(extra: TaskExtra): void {
    const vb = extra.verifyBaseline;
    if (vb && !vb.done) vb.tainted = true;
  }

  private baselineSummary(extra: TaskExtra): string {
    const b = extra.baseline;
    if (!b) {
      return extra.project && (extra.project.checkCommand || extra.project.verifyCommand)
        ? 'Baseline: not captured.'
        : 'Baseline: this project declares no commands, so there is nothing to run and nothing to compare against.';
    }
    const bits: string[] = [];
    if (b.check) bits.push(`${b.check.command} → exit ${b.check.exitCode}, ${(b.check.exitCode === 0 ? 0 : b.check.failureCount ?? b.check.signatures.length)} known failure(s)`);
    if (b.verify) bits.push(`${b.verify.command} → exit ${b.verify.exitCode}, ${(b.verify.exitCode === 0 ? 0 : b.verify.failureCount ?? b.verify.signatures.length)} known failure(s)`);
    return bits.length > 0
      ? `Baseline at task start (you are NOT accountable for these): ${bits.join('; ')}`
      : 'Baseline: nothing could be captured.';
  }

  // ─── Isolation ──────────────────────────────────────────────────

  private static slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  }

  /**
   * Put this task's changes in their own worktree when the project asks for it.
   *
   * The worktree lives beside the checkout rather than inside it, so `git
   * status` in the main tree stays clean. Build artifacts do not come along
   * with a fresh worktree, which is the whole reason this is opt-in: the
   * project declares either directories to share or a setup command to run,
   * and without one of those a typecheck in a new worktree will fail for
   * reasons that have nothing to do with the task.
   */
  private async setupIsolation(extra: TaskExtra): Promise<void> {
    const project = extra.project;
    if (!project) return;
    extra.workRoot = project.root;

    if (project.isolation !== 'worktree') return;
    if (project.vcs !== 'git') {
      this.audit(extra, 'worktree isolation requested but the project is not a git checkout — working in place');
      return;
    }

    const slug = ExternalCreator.slug(extra.goalId ?? extra.taskText);
    const branch = `abjects/${slug}`;
    const dir = path.join(path.dirname(project.root), '.abjects-worktrees', `${project.name}-${slug}`);

    const add = await this.git(extra, `worktree add -B ${branch} ${JSON.stringify(dir)}`, project.root, 120_000);
    if (add.exitCode !== 0) {
      // An existing worktree at that path is fine to adopt: a follow-up task in
      // the same goal should land beside the first one's work, not beside it.
      const exists = /already exists|is already checked out/i.test(`${add.stdout}${add.stderr}`);
      if (!exists) {
        this.audit(extra, `worktree add failed (${add.stderr.trim().slice(0, 200)}) — working in place`);
        return;
      }
      extra.worktree = { path: dir, branch, created: false };
    } else {
      extra.worktree = { path: dir, branch, created: true };
    }

    extra.workRoot = dir;
    this.audit(extra, `worktree ${extra.worktree.created ? 'created' : 'adopted'} at ${dir} on ${branch}`);

    // The registry granted the project root; the worktree is a different path.
    try {
      const fs = await this.hostFs();
      await this.call(fs, 'grantPath', { path: dir }, 130_000);
    } catch { /* first file access will prompt instead */ }

    for (const shared of project.sharedPaths ?? []) {
      const from = path.join(project.root, shared);
      const to = path.join(dir, shared);
      const r = await this.runCommand(
        extra,
        `test -e ${JSON.stringify(from)} && ln -sfn ${JSON.stringify(from)} ${JSON.stringify(to)}`,
        30_000, dir,
      );
      this.audit(extra, `shared ${shared}: ${r.exitCode === 0 ? 'linked' : 'skipped'}`);
    }

    if (project.setupCommand) {
      this.reportProgress(extra, 'acting', `worktree setup: ${project.setupCommand}`);
      const r = await this.runCommand(extra, project.setupCommand, VERIFY_TIMEOUT_MS, dir);
      this.audit(extra, `setup exit=${r.exitCode}`);
    }
  }

  /**
   * Remove a worktree that has nothing in it. A worktree with commits is the
   * deliverable and is left alone; an empty one is litter, and litter that
   * accumulates one directory per abandoned task becomes its own problem.
   */
  private async teardownIsolation(extra: TaskExtra): Promise<string | undefined> {
    const wt = extra.worktree;
    if (!wt || !extra.project) return undefined;

    let dirty = true;
    try {
      const status = await this.git(extra, 'status --porcelain', wt.path);
      const ahead = await this.git(extra, `rev-list --count ${wt.branch} ^HEAD`, extra.project.root);
      const hasCommits = (parseInt(ahead.stdout.trim(), 10) || 0) > 0;
      dirty = status.stdout.trim().length > 0 || hasCommits;
    } catch { /* assume dirty, which keeps the worktree */ }

    if (dirty) {
      return `Changes are in a worktree: ${wt.path} (branch ${wt.branch}). ` +
        `They are NOT in your main checkout. Merge or cherry-pick when you are happy with them.`;
    }

    if (wt.created) {
      try {
        await this.git(extra, `worktree remove --force ${JSON.stringify(wt.path)}`, extra.project.root);
        this.audit(extra, 'empty worktree removed');
      } catch { /* leave it; prune will collect it later */ }
    }
    return undefined;
  }

  // ─── The action kernel ──────────────────────────────────────────

  private async opRead(extra: TaskExtra, action: AgentAction): Promise<AgentActionResult> {
    const p = String(action.path ?? '');
    const abs = this.resolveWorkPath(extra, p);
    const fs = await this.hostFs();
    const r = await this.call<{ content: string; lines: number; totalLines: number; truncated: boolean; nextOffset?: number }>(
      fs, 'readFile',
      { path: abs, offset: action.offset as number | undefined, limit: action.limit as number | undefined },
      60_000,
    );
    extra.filesRead.add(abs);
    this.audit(extra, `read ${this.displayPath(extra, abs)} (${r.lines}/${r.totalLines} lines)`);
    const instructions = await this.nestedInstructionsFor(extra, abs);
    const header = `${instructions}${this.displayPath(extra, abs)} (${r.totalLines} lines)\n`;
    const body = header + r.content;
    return { success: true, data: { path: abs, offset: Math.max(1, Number(action.offset ?? 1)), lines: r.lines,
      totalLines: r.totalLines, truncated: r.truncated, nextOffset: r.nextOffset }, payload: body, payloadMode: 'page' };
  }

  private async opWrite(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const abs = this.resolveWorkPath(extra, String(action.path ?? ''));
    const content = action.content;
    if (typeof content !== 'string') return { success: false, error: 'write requires a "content" string' };
    this.assertWritable(extra, abs);
    const instructions = await this.nestedInstructionsFor(extra, abs);
    if (instructions) return { success: false, error: `Read these instructions before resubmitting the mutation. No file was changed.\n${instructions}` };

    const siblingNote = await this.siblingNoteFor(extra, abs);
    await this.rememberPreImage(extra, abs);
    this.taintVerifyBaseline(extra);
    const fs = await this.hostFs();
    const written = await this.call<{ success: boolean; error?: string }>(fs, 'conditionalWrite', { path: abs, content, expectedContent: extra.postImages.get(abs) ?? extra.preImages.get(abs) ?? null }, 60_000);
    if (!written.success) return { success: false, error: written.error ?? 'File changed; read it again before editing' };
    extra.postImages.set(abs, content);

    extra.filesModified.add(abs);
    extra.mutationsSinceVerify++;
    this.audit(extra, `write ${this.displayPath(extra, abs)} (${content.length} chars)`);
    this.announceFilesTouched(extra);
    return this.afterMutation(extra, action,
      `${instructions}Wrote ${this.displayPath(extra, abs)} (${content.split('\n').length} lines).${siblingNote}`);
  }

  private async opEdit(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const abs = this.resolveWorkPath(extra, String(action.path ?? ''));
    const edits = action.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return { success: false, error: 'edit requires a non-empty "edits" array of { oldText, newText }' };
    }
    this.assertWritable(extra, abs);
    const instructions = await this.nestedInstructionsFor(extra, abs);
    if (instructions) return { success: false, error: `Read these instructions before resubmitting the mutation. No file was changed.\n${instructions}` };

    const siblingNote = await this.siblingNoteFor(extra, abs);
    await this.rememberPreImage(extra, abs);
    this.taintVerifyBaseline(extra);
    const fs = await this.hostFs();
    const r = await this.call<{ success: boolean; applied: number; diff?: string; error?: string; changedLines?: number[] }>(
      fs, 'edit', { path: abs, edits: edits as FileEdit[] }, 60_000,
    );

    if (!r.success) {
      this.audit(extra, `edit ${this.displayPath(extra, abs)} REJECTED: ${r.error}`);
      return {
        success: false,
        error: `No edit was applied — the file is unchanged.\n${r.error}`,
      };
    }

    // Record what the file holds now, so a later rollback can tell our
    // version from a sibling task's.
    try {
      const after = await this.call<{ content: string }>(fs, 'readFile', { path: abs, maxBytes: 0 }, 60_000);
      extra.postImages.set(abs, after.content);
    } catch { /* a missing post-image only disables rollback for this file */ }

    extra.filesModified.add(abs);
    extra.mutationsSinceVerify++;
    this.audit(extra, `edit ${this.displayPath(extra, abs)} applied ${r.applied}`);
    this.announceFilesTouched(extra);
    const summary = `${instructions}Applied ${r.applied} edit(s) to ${this.displayPath(extra, abs)}:\n${r.diff ?? ''}${siblingNote}`;
    return this.afterMutation(extra, action, summary, abs);
  }

  // ─── Working beside other tasks ─────────────────────────────────

  private async siblings(extra: TaskExtra): Promise<Array<{ taskId: string; goalId?: string; description?: string; files: string[]; startedAt: number }>> {
    const reg = await this.projects();
    if (!reg || !extra.project) return [];
    try {
      const all = await this.call<Array<{ taskId: string; goalId?: string; description?: string; files: string[]; startedAt: number }>>(
        reg, 'activeTasks', { name: extra.project.name }, 10_000,
      );
      return (all ?? []).filter(t => t.taskId !== extra.taskId);
    } catch {
      return [];
    }
  }

  /** One line when another task has already written the file about to change. */
  private async siblingNoteFor(extra: TaskExtra, abs: string): Promise<string> {
    const rel = this.displayPath(extra, abs).split(path.sep).join('/');
    const others = (await this.siblings(extra)).filter(t => t.files.includes(rel));
    if (others.length === 0) return '';
    const who = others.map(t => `${t.taskId.slice(0, 8)}${t.description ? ` (${t.description.slice(0, 60)})` : ''}`).join(', ');
    return `\n\nNote: ${rel} was also written by concurrent task(s) ${who} in this project. Your edit matched the file as it is now, so nothing was lost — but coordinate through the goal scratchpad if you are both changing the same thing.`;
  }

  private announceTaskStarted(extra: TaskExtra): void {
    void this.projects().then(reg => {
      if (!reg || !extra.project) return;
      this.send(event(this.id, reg, 'taskStarted', {
        project: extra.project.name,
        taskId: extra.taskId,
        goalId: extra.goalId,
        description: extra.taskText.slice(0, 200),
      }));
    }).catch(() => { /* awareness is best effort */ });
  }

  private announceFilesTouched(extra: TaskExtra): void {
    void this.projects().then(reg => {
      if (!reg || !extra.project) return;
      this.send(event(this.id, reg, 'filesTouched', {
        project: extra.project.name,
        taskId: extra.taskId,
        files: [...extra.filesModified].map(f => this.displayPath(extra, f).split(path.sep).join('/')),
      }));
    }).catch(() => { /* best effort */ });
  }

  private announceTaskFinished(extra: TaskExtra): void {
    void this.projects().then(reg => {
      if (!reg || !extra.project) return;
      this.send(event(this.id, reg, 'taskFinished', { project: extra.project.name, taskId: extra.taskId }));
    }).catch(() => { /* best effort */ });
  }

  /**
   * A subdirectory's own AGENTS.md / CLAUDE.md, shown once, the first time a
   * file under it is read or written. The root files arrive with the prompt;
   * a monorepo's per-package conventions live one level down and would
   * otherwise never be seen. Untrusted projects contribute nothing here, for
   * the same reason their root files are withheld.
   */
  private async nestedInstructionsFor(extra: TaskExtra, abs: string): Promise<string> {
    const root = extra.workRoot;
    if (!root || !extra.project?.trusted) return '';
    const blocks: string[] = [];
    let dir = path.dirname(abs);
    while (dir.startsWith(root) && dir !== root) {
      if (!extra.instructionDirsSeen.has(dir)) {
        extra.instructionDirsSeen.add(dir);
        for (const name of ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']) {
          try {
            const fs = await this.hostFs();
            const r = await this.call<{ content: string }>(
              fs, 'readFile', { path: path.join(dir, name), maxBytes: 32 * 1024 }, 15_000,
            );
            if (r.content) {
              const rel = path.relative(root, path.join(dir, name));
              blocks.push(`<project_instructions path="${rel}">\n${r.content}\n</project_instructions>`);
              this.audit(extra, `instructions ${rel}`);
              if (name === 'AGENTS.override.md') break;
            }
          } catch { /* absent, the common case */ }
        }
      }
      dir = path.dirname(dir);
    }
    return blocks.length > 0
      ? `This directory has its own instructions (shown once):\n${blocks.join('\n')}\n\n`
      : '';
  }

  /** Keep the first version of a file this task saw, for a precise undo. */
  private async rememberPreImage(extra: TaskExtra, abs: string): Promise<void> {
    if (extra.preImages.has(abs)) return;
    try {
      const fs = await this.hostFs();
      const r = await this.call<{ content: string }>(fs, 'readFile', { path: abs, maxBytes: 0 }, 60_000);
      extra.preImages.set(abs, r.content);
    } catch {
      // A file that does not exist yet has no pre-image; creating it is not
      // something we can undo by restoring content, and should not be.
    }
  }

  /**
   * What happens the moment a mutation lands: the checks run themselves.
   *
   * An open edit set (`more: true`) is work in progress and is left alone —
   * judging a half-written change is how an agent ends up chasing errors it was
   * about to fix anyway. When the set closes, the project's fast check runs and
   * its verdict rides back on this same action, so the agent never spends a
   * step asking whether its edit compiled.
   */
  private async afterMutation(
    extra: TaskExtra,
    action: AgentAction,
    summary: string,
    editedPath?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    extra.editSetOpen = action.more === true;
    if (extra.editSetOpen) {
      return { success: true, data: `${summary}\n\n(edit set still open — checks will run when you drop "more")` };
    }

    await this.checkpoint(extra, 'after edit set');

    const cmd = extra.project?.checkCommand;
    if (!cmd) {
      return {
        success: true,
        data: `${summary}\n\nThis project declares no check command, so nothing ran. ` +
          `Say so in your report rather than implying the change was verified.`,
      };
    }

    this.reportProgress(extra, 'acting', `check: ${cmd}`);
    let verdict: CheckVerdict;
    try {
      verdict = this.judge(await this.captureOutcome(extra, cmd, VERIFY_TIMEOUT_MS), extra.baseline?.check, this.touchedFiles(extra));
    } catch (err) {
      return { success: true, data: `${summary}\n\nCheck could not run: ${err instanceof Error ? err.message : String(err)}` };
    }
    extra.lastCheck = verdict;
    this.audit(extra, `check exit=${verdict.outcome.exitCode} new=${verdict.newFailures.length} foreign=${verdict.foreignFailures.length}${verdict.inconclusive ? ' inconclusive' : ''}`);

    // When the project's check IS its verification (no separate verify
    // command, or the same one), a passing check is the verification: the
    // gate is satisfied here and no `verify` step is owed. A heavier verify
    // command still has to be run explicitly.
    const project = extra.project!;
    const checkIsVerify = !project.verifyCommand || project.verifyCommand === project.checkCommand;
    if (verdict.passed && checkIsVerify) {
      extra.lastVerify = verdict;
      extra.mutationsSinceVerify = 0;
    }

    // A file this task just edited that no longer parses is a mechanical
    // failure with a known cause and a known undo. Restoring it beats leaving
    // source no one authored on disk while the agent works out what happened.
    if (!verdict.passed && editedPath && this.looksLikeParseFailure(verdict, editedPath, extra)) {
      const restored = await this.rollback(extra, editedPath);
      if (restored === 'restored') {
        return {
          success: false,
          error:
            `${summary}\n\nThat edit left ${this.displayPath(extra, editedPath)} unparseable, so it was ` +
            `REVERTED to its state at the start of this task. Nothing is half-written.\n\n${this.renderVerdict(verdict)}`,
        };
      }
      if (restored === 'changed-by-other') {
        return {
          success: false,
          error:
            `${summary}\n\nThat edit left ${this.displayPath(extra, editedPath)} unparseable, but the file has since been ` +
            `changed by another task working in this project, so it was NOT reverted (that would erase their work). ` +
            `Read it as it stands now and fix the syntax with a fresh edit.\n\n${this.renderVerdict(verdict)}`,
        };
      }
    }

    const verifiedNote = verdict.passed && checkIsVerify && extra.filesModified.size > 0
      ? '\n\nThis check is the project\'s verification, so the gate is satisfied; no separate verify step is needed.'
      : '';
    return { success: true, data: `${summary}\n\n${this.renderVerdict(verdict)}${verifiedNote}` };
  }

  /** Files this task has written, as project-relative paths (for attribution). */
  private touchedFiles(extra: TaskExtra): string[] {
    return [...extra.filesModified].map(f => this.displayPath(extra, f));
  }

  /**
   * Whether a failed check is the "you broke the syntax of the file you just
   * edited" kind. Deliberately narrow: a type error is a real finding the agent
   * should work on, while an unparseable file is noise that hides everything
   * else the check would have said.
   */
  private looksLikeParseFailure(verdict: CheckVerdict, editedPath: string, extra: TaskExtra): boolean {
    const rel = this.displayPath(extra, editedPath).split(path.sep).join('/');
    const syntaxish = /syntax|unexpected token|unterminated|parse error|expected|unbalanced/i;
    return verdict.newFailures.some(s => s.includes(rel) && syntaxish.test(s));
  }

  /**
   * Restore a file to its state at the start of this task — but only if it
   * still holds exactly what this task last wrote. Several tasks may be
   * working in the checkout at once; a file that has moved on since our edit
   * belongs to whoever moved it, and overwriting that with our pre-image would
   * erase their work to undo ours.
   */
  private async rollback(extra: TaskExtra, abs: string): Promise<'restored' | 'changed-by-other' | 'unavailable'> {
    const pre = extra.preImages.get(abs);
    const post = extra.postImages.get(abs);
    if (pre === undefined || post === undefined) return 'unavailable';
    try {
      const fs = await this.hostFs();
      const restored = await this.call<{ success: boolean }>(fs, 'conditionalWrite', {
        path: abs, expectedContent: post, content: pre,
      }, 60_000);
      if (!restored.success) return 'changed-by-other';
      extra.postImages.set(abs, pre);
      extra.filesModified.delete(abs);
      extra.mutationsSinceVerify++;
      extra.lastVerify = undefined;
      this.audit(extra, `rolled back ${this.displayPath(extra, abs)}`);
      this.announceFilesTouched(extra);
      return 'restored';
    } catch {
      return 'unavailable';
    }
  }

  private async opBash(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const command = String(action.command ?? '');
    if (!command) return { success: false, error: 'bash requires a "command" string' };
    const timeout = typeof action.timeout === 'number' ? action.timeout : BASH_TIMEOUT_MS;
    const cwd = action.cwd ? this.resolveWorkPath(extra, String(action.cwd)) : extra.workRoot;

    // A declared check has the same evidence/reuse rules regardless of which
    // action requested it. Do not guess equivalence for arbitrary shell code.
    if (cwd === extra.workRoot && [extra.project?.checkCommand, extra.project?.verifyCommand].includes(command.trim())) {
      const verified = await this.opVerify(extra, { ...action, timeout, full: command.trim() === extra.project?.verifyCommand });
      const data = verified.data as { exitCode?: number } | undefined;
      return { ...verified, success: verified.success && data?.exitCode === 0,
        ...(data?.exitCode !== 0 ? { error: `Command exited ${data?.exitCode}; inspect verification evidence.` } : {}) };
    }

    this.reportProgress(extra, 'acting', command.slice(0, 80));
    const before = await this.verificationSnapshot(extra);
    let r: { stdout: string; stderr: string; exitCode: number; truncated?: unknown; outputObjectId?: AbjectId };
    try { r = await this.runCommand(extra, command, timeout, cwd); }
    catch (err) {
      extra.unknownEffects = true; extra.mutationsSinceVerify++; this.taintVerifyBaseline(extra);
      throw err;
    }
    const after = await this.verificationSnapshot(extra);
    if (before.revision !== after.revision) {
      this.taintVerifyBaseline(extra);
      extra.unknownEffects = true;
      extra.mutationsSinceVerify++;
    } else if (!before.complete || !after.complete) {
      extra.unknownEffects = true;
    }
    this.audit(extra, `bash exit=${r.exitCode}: ${command.slice(0, 160)}`);

    const body = [
      `exit ${r.exitCode}`,
      r.stdout ? `stdout:\n${r.stdout}` : '',
      r.stderr ? `stderr:\n${r.stderr}` : '',
    ].filter(Boolean).join('\n');

    // Preserve the real command outcome and its output reference on both paths.
    const summary = { exitCode: r.exitCode, outputObjectId: r.outputObjectId, truncated: r.truncated,
      continuation: r.truncated && r.outputObjectId ? 'The command preview omitted output. Read retained output from offset 0 before rerunning a diff or inspection command; continue at nextOffset until totalBytes.' : undefined,
      stdoutTail: r.stdout.slice(-2000), stderrTail: r.stderr.slice(-2000),
      readOutput: r.outputObjectId ? { action: 'read_output', id: r.outputObjectId, offset: 0, length: 30000 } : undefined };
    return { ...bulkAwareResult(body), success: r.exitCode === 0,
      data: body.length > 8000 ? summary : { ...summary, output: body },
      ...(r.exitCode !== 0 ? { error: `Command exited ${r.exitCode}; inspect output and truncation metadata.` } : {}) };
  }

  private async opGrep(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const pattern = String(action.pattern ?? '');
    if (!pattern) return { success: false, error: 'grep requires a "pattern"' };
    const searchPath = action.path ? this.resolveWorkPath(extra, String(action.path)) : extra.workRoot;
    const fs = await this.hostFs();
    const r = await this.call<{
      matches: Array<{ file: string; line: number; content: string; before?: string[]; after?: string[] }>;
      truncated: boolean; filesSearched: number;
    }>(fs, 'grep', {
      pattern,
      path: searchPath,
      glob: action.glob,
      maxResults: action.maxResults,
      ignoreCase: action.ignoreCase,
      context: action.context,
    }, 120_000);

    const lines = r.matches.map(m => {
      const head = `${this.displayPath(extra, m.file)}:${m.line}: ${m.content}`;
      if (!m.before && !m.after) return head;
      return [
        ...(m.before ?? []).map(b => `  | ${b}`),
        head,
        ...(m.after ?? []).map(a => `  | ${a}`),
      ].join('\n');
    });
    const note = r.truncated ? `\n[truncated — narrow the pattern or pass a glob]` : '';
    this.audit(extra, `grep "${pattern.slice(0, 60)}" → ${r.matches.length} match(es)`);
    return bulkAwareResult(
      `${r.matches.length} match(es) in ${r.filesSearched} file(s):\n${lines.join('\n')}${note}`,
    );
  }

  private async opFind(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const pattern = String(action.pattern ?? '');
    if (!pattern) return { success: false, error: 'find requires a glob "pattern"' };
    const base = action.path ? this.resolveWorkPath(extra, String(action.path)) : extra.workRoot;
    const fs = await this.hostFs();
    const r = await this.call<{ files: string[]; truncated: boolean }>(
      fs, 'glob', { pattern, cwd: base, limit: action.limit }, 120_000,
    );
    const list = r.files.map(f => this.displayPath(extra, f)).join('\n');
    this.audit(extra, `find "${pattern}" → ${r.files.length} file(s)`);
    return bulkAwareResult(`${r.files.length} file(s)${r.truncated ? ' (truncated)' : ''}:\n${list}`);
  }

  private async opLs(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const dir = action.path ? this.resolveWorkPath(extra, String(action.path)) : extra.workRoot!;
    const fs = await this.hostFs();
    const r = await this.call<{ entries: string[]; truncated: boolean }>(
      fs, 'ls', { path: dir, limit: action.limit }, 60_000,
    );
    return {
      success: true,
      data: `${this.displayPath(extra, dir)}:\n${r.entries.join('\n')}${r.truncated ? '\n[truncated]' : ''}`,
    };
  }

  /**
   * Run the project's own verification and record it.
   *
   * This is a named action rather than "just bash" because the report needs a
   * canonical answer to "what was verified, when, and against what" — a bash
   * invocation that happens to run the tests is indistinguishable from one that
   * does not, and a claim of verification has to point at something.
   */
  private async opVerify(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const project = extra.project;
    if (!project) return { success: false, error: 'No project selected.' };

    const full = action.full !== false;
    const command = (full ? project.verifyCommand : project.checkCommand)
      ?? project.verifyCommand ?? project.checkCommand;

    if (!command) {
      return {
        success: true,
        data:
          `This project declares no ${full ? 'verify' : 'check'} command, so there is nothing to run. ` +
          `Your report must say what you changed and that it could not be verified automatically. ` +
          `If a sensible command exists, propose it to the user rather than inventing one now.`,
      };
    }

    // The verify baseline may still be running in the background; a verdict
    // needs it, so this is the one place that waits for it.
    if (full && extra.verifyBaseline && !extra.verifyBaseline.done) {
      this.reportProgress(extra, 'acting', 'waiting for the baseline verify run to finish');
      await extra.verifyBaseline.promise;
    }

    const current = await this.verificationSnapshot(extra);
    const candidates = [extra.lastVerify?.outcome, extra.lastCheck?.outcome, extra.baseline?.verify, extra.baseline?.check]
      .filter((v): v is CheckOutcome => !!v && v.command === command)
      .sort((a, b) => b.at - a.at);
    const newest = candidates[0];
    const reusable = action.force !== true && current.complete && extra.mutationsSinceVerify === 0
      && newest?.taskId === extra.taskId && newest.workRoot === extra.workRoot
      && newest.exitCode === 0 && newest.stable === true && newest.revision === current.revision ? newest : undefined;
    this.reportProgress(extra, 'acting', `${reusable ? 'reusing' : 'verify:'} ${command}`);
    const outcome = reusable ?? await this.captureOutcome(extra, command, typeof action.timeout === 'number' ? action.timeout : VERIFY_TIMEOUT_MS);
    const baseline = command === extra.baseline?.verify?.command ? extra.baseline.verify
      : command === extra.baseline?.check?.command ? extra.baseline.check : undefined;
    const verdict = this.judge(outcome, baseline, this.touchedFiles(extra));

    if (full) extra.lastVerify = verdict; else extra.lastCheck = verdict;
    if (verdict.passed && command === (project.verifyCommand ?? project.checkCommand)) extra.mutationsSinceVerify = 0;
    this.audit(extra, `verify(${full ? 'full' : 'check'}) exit=${outcome.exitCode} new=${verdict.newFailures.length} foreign=${verdict.foreignFailures.length}${verdict.inconclusive ? ' inconclusive' : ''}`);

    return { success: true, data: { verification: this.renderVerdict(verdict), command, exitCode: outcome.exitCode,
      reused: !!reusable, testSummary: outcome.testSummary, revision: outcome.revision, snapshotNote: outcome.snapshotNote,
      outputObjectId: outcome.outputObjectId, outputTruncated: outcome.outputTruncated,
      readOutput: outcome.outputObjectId ? { action: 'read_output', id: outcome.outputObjectId, offset: 0, length: 30000 } : undefined } };
  }

  private async opReadOutput(extra: TaskExtra, action: AgentAction): Promise<import('./agent-abject.js').AgentActionResult> {
    const id = String(action.id ?? '') as AbjectId;
    if (!extra.commandOutputs?.has(id)) throw new Error('Output does not belong to this task, or its process has expired');
    const output = await this.call<{ text: string; offset: number; nextOffset: number; totalBytes: number }>(id, 'readOutput', { offset: action.offset, length: typeof action.length === 'number' && Number.isFinite(action.length) ? Math.max(1, Math.min(30000, Math.floor(action.length))) : 30000 }, 30000);
    // This is a requested page, not unsolicited bulk. The runtime must show
    // its body before offering the next byte offset.
    return { success: true, payload: output.text, payloadMode: 'page', data: { outputObjectId: id, offset: output.offset, nextOffset: output.nextOffset, totalBytes: output.totalBytes,
      readOutput: output.nextOffset < output.totalBytes ? { action: 'read_output', id, offset: output.nextOffset, length: 30000 } : undefined } };

  }

  private async opSetProject(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const name = String(action.name ?? action.project ?? '');
    if (!name) return { success: false, error: 'set_project requires a "name" (a project handle or a path inside one)' };
    const project = await this.resolveProject(name);
    if (!project) {
      const all = await this.listProjects();
      return {
        success: false,
        error: `No external project matches "${name}". Registered: ${all.map(p => p.name).join(', ') || '(none)'}. ` +
          `A directory has to be registered before I work in it — ask the user to add it.`,
      };
    }
    if (extra.project?.name === project.name) return { success: true, data: `Already working in ${project.name} at ${extra.workRoot}. Project instructions and baseline evidence are unchanged; continue from the existing context.` };
    if (extra.project && !this.gateVerdict(extra).ok) return { success: false, error: 'Finish verification in the current project before switching projects.' };
    if (extra.project) {
      await this.writeSessionSummary(extra, 'Project session suspended for switch', this.gateVerdict(extra));
      this.announceTaskFinished(extra);
    }
    extra.filesRead.clear(); extra.filesModified.clear(); extra.preImages.clear(); extra.postImages.clear();
    extra.instructionDirsSeen.clear(); extra.mutationsSinceVerify = 0; extra.unknownEffects = false;
    extra.lastCheck = undefined; extra.lastVerify = undefined; extra.baseline = undefined;
    extra.verifyBaseline = undefined; extra.workRoot = undefined; extra.worktree = undefined;
    extra.checkpoints = []; extra.editSetOpen = false;
    extra.projectSession = false;
    extra.project = project;
    await this.setupIsolation(extra);
    await this.setDefaultCwd(extra);
    await this.captureBaseline(extra);
    await this.checkpoint(extra, 'task start');
    this.announceTaskStarted(extra);
    const others = await this.siblings(extra);
    const projectInstructions = await this.buildProjectBlock(extra);
    await this.request(request(this.id, this.agentAbjectId!, 'setTaskProject', { taskId: extra.taskId, name: project.name, systemPrompt: `${this.buildSystemPrompt()}\n\n${projectInstructions}` }));
    const siblingLine = others.length > 0 ? `\n${this.renderSiblings(others)}` : '';
    return { success: true, data: `Working in ${project.name} at ${extra.workRoot}.\n${projectInstructions}\n${this.baselineSummary(extra)}${siblingLine}` };
  }

  private renderSiblings(others: Array<{ taskId: string; goalId?: string; description?: string; files: string[] }>): string {
    const lines = others.map(t => {
      const files = t.files.length > 0 ? ` — has written: ${t.files.slice(0, 12).join(', ')}${t.files.length > 12 ? ', …' : ''}` : ' — no files written yet';
      return `- ${t.taskId.slice(0, 8)}${t.goalId ? ` (goal ${t.goalId.slice(0, 8)})` : ''}: ${t.description ?? '(no description)'}${files}`;
    });
    return `${others.length} other task(s) are working in this project right now. Stay out of the files they have written unless your task requires it; diagnostic location alone does not establish which task caused a failure.\n${lines.join('\n')}`;
  }

  private async opCall(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const target = String(action.target ?? '');
    const method = String(action.method ?? '');
    if (!target || !method) return { success: false, error: 'call requires "target" and "method"' };

    let targetId = target as AbjectId;
    if (!/^[0-9a-f]{8}-/i.test(target)) {
      const found = await this.discoverDep(target);
      if (!found) return { success: false, error: `No object named "${target}" is registered` };
      targetId = found;
    }
    const timeout = typeof action.timeout === 'number' ? action.timeout : 30_000;
    const supplied = (action.payload ?? {}) as Record<string, unknown>;
    const shellId = await this.discoverDep('ShellExecutor');
    const fsId = await this.discoverDep('HostFileSystem');
    // Convenience actions and generic owner messages share the same safeguards.
    if (targetId === shellId && method === 'exec' && supplied.shell === true && typeof supplied.command === 'string' && !supplied.args && !supplied.env) {
      return this.opBash(extra, { ...action, action: 'bash', command: supplied.command, timeout: supplied.timeout, cwd: supplied.cwd });
    }
    const mutatesFile = targetId === fsId && ['writeFile', 'conditionalWrite', 'editFile', 'edit', 'mkdir', 'deleteFile'].includes(method);
    let mutationPath: string | undefined;
    if (mutatesFile) {
      mutationPath = this.resolveWorkPath(extra, String(supplied.path ?? ''));
      this.assertWritable(extra, mutationPath);
    }
    const payload = targetId === shellId ? { ...supplied, taskId: extra.taskId, cwd: extra.workRoot, untrusted: this.isUntrusted(extra) }
      : targetId === fsId ? { ...supplied, ...(mutationPath ? { path: mutationPath } : {}), taskId: extra.taskId } : supplied;
    const before = targetId === shellId ? await this.verificationSnapshot(extra) : undefined;
    let response: unknown;
    try { response = await this.call<unknown>(targetId, method, payload, timeout); }
    catch (error) {
      if (targetId === shellId && !errorDetails(error)) { extra.unknownEffects = true; extra.mutationsSinceVerify++; this.taintVerifyBaseline(extra); }
      throw error;
    }
    if (mutationPath && (response as any)?.success !== false) {
      extra.filesModified.add(mutationPath);
      extra.mutationsSinceVerify++;
      this.taintVerifyBaseline(extra);
      this.announceFilesTouched(extra);
    }
    if (before) {
      const after = await this.verificationSnapshot(extra);
      if (method === 'start' || !before.complete || !after.complete || before.revision !== after.revision) {
        extra.unknownEffects = true; extra.mutationsSinceVerify++; this.taintVerifyBaseline(extra);
      }
    }
    const contract = await this.call<ResultContract|null>(targetId,'getResultContract',{method},10000).catch(()=>null);
    const rejected=domainFailure(response,contract);
    if(rejected)return {success:false,data:response,error:rejected};
    this.audit(extra, `call ${target}.${method}`);
    const text = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
    return bulkAwareResult(text ?? 'null');
  }

  // ─── The gate ───────────────────────────────────────────────────

  /**
   * Whether this task may honestly claim to be done.
   *
   * The framework decides a task is finished the moment the agent emits its
   * terminal action, so this is not an interception — it is the check applied
   * to the result before it leaves this object. An agent that says "done" with
   * unverified changes gets its claim downgraded, with the precise reason, and
   * the caller sees the truth rather than the claim.
   */
  private gateVerdict(extra: TaskExtra): { ok: boolean; reason?: string; note: string } {
    const project = extra.project;
    if (!project) return { ok: true, note: 'No project was selected, so nothing was changed on disk.' };

    const changed = extra.filesModified.size;
    if (changed === 0 && !extra.unknownEffects) {
      return { ok: true, note: 'Source edits made by this task: 0.' };
    }

    const hasCommands = Boolean(project.checkCommand || project.verifyCommand);
    if (!hasCommands) {
      // Nothing to run means nothing to block on — but the absence of
      // verification is reported as absence, never as a pass.
      return {
        ok: true,
        note:
          `${changed} file(s) changed. This project declares no check or verify command, ` +
          `so NOTHING was verified automatically.`,
      };
    }

    const requiredCommand = project.verifyCommand ?? project.checkCommand;
    const latest = [extra.lastVerify, extra.lastCheck]
      .filter((v): v is CheckVerdict => !!v && v.outcome.command === requiredCommand)
      .sort((a, b) => b.outcome.at - a.outcome.at)[0];
    if (!latest || extra.mutationsSinceVerify > 0) {
      return {
        ok: false,
        reason:
          `${changed} file(s) were changed and ${extra.mutationsSinceVerify} mutation(s) have not been ` +
          `verified since. Run \`${project.verifyCommand ?? project.checkCommand}\` (the verify action) ` +
          `and address anything it newly reports before claiming this is done.`,
        note: `${changed} file(s) changed, unverified.`,
      };
    }

    if (latest.inconclusive) {
      return {
        ok: false,
        reason: `${this.renderVerdict(latest)}\nInspect the command failure before deciding whether another run is useful.`,
        note: `${changed} file(s) changed, verification inconclusive.`,
      };
    }

    if (!latest.passed) {
      return {
        ok: false,
        reason:
          `\`${latest.outcome.command}\` exited ${latest.outcome.exitCode} and did not pass. ` +
          (latest.newFailures.length ? `${latest.newFailures.length} new diagnostic(s):\n` : 'No diagnostic line was recognized; inspect the command output.\n') +
          latest.newFailures.slice(0, 15).map(s => `  ${s}`).join('\n'),
        note: `${changed} file(s) changed, ${latest.newFailures.length} new failure(s).`,
      };
    }

    const foreign = latest.foreignFailures.length > 0
      ? ` ${latest.foreignFailures.length} new failure(s) in files this task did not write are attributed to concurrent work.`
      : '';
    return {
      ok: true,
      note:
        `${changed} file(s) changed; \`${latest.outcome.command}\` exited ${latest.outcome.exitCode}` +
        (latest.preExisting > 0 ? ` with ${latest.preExisting} pre-existing failure(s) untouched` : '') +
        `, no new failures in files this task wrote.${foreign}${latest.outcome.snapshotNote ? ` Verification limitation: ${latest.outcome.snapshotNote}` : ''}`,
    };
  }

  /** Describe checks against the live inputs, including a commit-only task's baseline. */
  private async completionChecks(extra: TaskExtra, current?: { revision?: string; complete: boolean }): Promise<string> {
    if (!extra.project) return '';
    current ??= await this.verificationSnapshot(extra);
    const commands = [...new Set([extra.project.checkCommand, extra.project.verifyCommand].filter((c): c is string => !!c))];
    const outcomes = [extra.lastVerify?.outcome, extra.lastCheck?.outcome, extra.baseline?.verify, extra.baseline?.check]
      .filter((v): v is CheckOutcome => !!v).sort((a, b) => b.at - a.at);
    return commands.map(command => {
      const outcome = outcomes.find(o => o.command === command);
      if (!outcome) return `${command}: ${extra.verifyBaseline && !extra.verifyBaseline.done && command === extra.project?.verifyCommand ? 'still running; no completed result' : 'no completed result'}.`;
      const applicable = current.complete && outcome.stable === true && outcome.taskId === extra.taskId
        && outcome.workRoot === extra.workRoot && outcome.revision === current.revision && extra.mutationsSinceVerify === 0;
      const tests = outcome.testSummary;
      const summary = tests ? `; tests: ${tests.passed ?? '?'} passed, ${tests.failed ?? '?'} failed, ${tests.tests ?? '?'} total` : '';
      return `${command}: exit ${outcome.exitCode}${summary}; ${applicable ? 'applies to the current project inputs' : 'historical result; current coverage is not established'}.${outcome.snapshotNote ? ` ${outcome.snapshotNote}` : ''}`;
    }).join('\n');
  }

  // ─── Goal scratchpad ────────────────────────────────────────────

  private async readGoalData<T>(extra: TaskExtra, key: string): Promise<T | undefined> {
    if (!extra.goalId) return undefined;
    this.goalManagerId = await this.resolveDep('GoalManager', this.goalManagerId);
    if (!this.goalManagerId) return undefined;
    try {
      return await this.call<T>(this.goalManagerId, 'readGoalData', { goalId: extra.goalId, key }, 15_000) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async writeGoalData(extra: TaskExtra, key: string, value: unknown): Promise<void> {
    if (!extra.goalId) return;
    this.goalManagerId = await this.resolveDep('GoalManager', this.goalManagerId);
    if (!this.goalManagerId) return;
    try {
      await this.call(this.goalManagerId, 'writeGoalData', { goalId: extra.goalId, key, value }, 15_000);
    } catch { /* the summary is a convenience, never a correctness requirement */ }
  }

  /**
   * The handoff to whatever runs next in this goal.
   *
   * Built from what actually happened rather than asked of a model: the file
   * lists, the commands run, and their exit codes are facts this object already
   * holds, and a summary assembled from them cannot hallucinate a step that was
   * never taken.
   */
  private async writeSessionSummary(extra: TaskExtra, report: string, gate: { ok: boolean; note: string }, outcome: { success: boolean; error?: string } = { success: false }): Promise<void> {
    if (!extra.goalId) return;
    const prev = await this.readGoalData<{ summary?: string }>(extra, SESSION_KEY);

    const rel = (s: Set<string>) => [...s].map(f => this.displayPath(extra, f)).sort();
    const modified = rel(extra.filesModified);
    const read = rel(extra.filesRead).filter(f => !modified.includes(f));

    const summary = [
      `## Goal`,
      extra.taskText,
      ``,
      `## Constraints & Preferences`,
      extra.project
        ? `- Project ${extra.project.name} at ${extra.workRoot}` +
          (extra.worktree ? ` (worktree on ${extra.worktree.branch})` : '')
        : `- (no project selected)`,
      extra.project?.checkCommand ? `- check: \`${extra.project.checkCommand}\`` : '',
      extra.project?.verifyCommand ? `- verify: \`${extra.project.verifyCommand}\`` : '',
      ``,
      `## Outcome`,
      outcome.success && gate.ok ? 'Completed' : extra.cancelled ? 'Cancelled; work remains' : 'Incomplete; work remains',
      `## Report`,
      report || '(no report)',
      outcome.error ? `Stop reason: ${outcome.error}` : '',
      `## Verification`,
      gate.note,
      `Permission explanations are worker claims unless supported by a capability response. Provider sandbox restrictions do not establish Abject permissions; Ask the owner when access is uncertain.`,
      `## Key Decisions`,
      extra.decisions.length > 0 ? extra.decisions.map(d => `- ${d}`).join('\n') : '- (none recorded)',
      `## Next Steps`,
      outcome.success && gate.ok ? 'Task reported complete; use the retained report and evidence for follow-up work.'
        : `Continue from the findings above. ${outcome.error || (!gate.ok ? gate.note : 'Execution stopped before completing the requested outcome.')}`,
      ``,
      `## Critical Context`,
      extra.checkpoints.length > 0
        ? `- Checkpoints (restore with \`git stash apply <ref>\`): ${extra.checkpoints.map(c => c.ref.slice(0, 10)).join(', ')}`
        : `- No checkpoints (project is not a git checkout)`,
      extra.baseline ? `- ${this.baselineSummary(extra)}` : '',
      ``,
      modified.length > 0 ? `<modified-files>\n${modified.join('\n')}\n</modified-files>` : '',
      read.length > 0 ? `<read-files>\n${read.join('\n')}\n</read-files>` : '',
    ].filter(l => l !== '').join('\n');

    await this.writeGoalData(extra, SESSION_KEY, {
      summary,
      taskId: extra.taskId,
      outcome: { success: outcome.success && gate.ok, error: outcome.error, cancelled: extra.cancelled === true },
      report, verification: gate, decisions: [...extra.decisions], permissionEvidence: extra.permissionEvidence ?? [],
      previous: prev?.summary ? prev.summary.slice(0, 4000) : undefined,
      audit: extra.audit.slice(-200),
      at: Date.now(),
    });
    await this.writeGoalData(extra, `${VERIFICATION_KEY_PREFIX}${extra.taskId}`, this.verificationReceipt(extra, gate, outcome, modified.length));
  }

  /**
   * The task's verification as data: which commands ran, when, with what exit
   * code and test counts, next to the gate that judged them. Written beside
   * the narrative report so whoever summarizes the goal can quote the newest
   * run instead of whichever figure a prose entry happened to mention.
   */
  private verificationReceipt(
    extra: TaskExtra,
    gate: { ok: boolean; note: string },
    outcome: { success: boolean; error?: string },
    filesModified: number,
  ): VerificationReceipt {
    const run = (v?: CheckVerdict): VerificationRun | undefined => v ? {
      command: v.outcome.command,
      exitCode: v.outcome.exitCode,
      at: v.outcome.at,
      passed: v.passed,
      testSummary: v.outcome.testSummary,
      failureCount: v.outcome.failureCount,
      newFailures: v.newFailures.length,
      foreignFailures: v.foreignFailures.length,
      preExisting: v.preExisting,
    } : undefined;
    return {
      taskId: extra.taskId,
      agent: this.manifest.name,
      project: extra.project?.name,
      at: Date.now(),
      outcome: outcome.success && gate.ok ? 'complete' : extra.cancelled ? 'cancelled' : 'incomplete',
      filesModified,
      mutationsSinceVerify: extra.mutationsSinceVerify,
      gate: { ok: gate.ok, note: gate.note },
      verify: run(extra.lastVerify),
      check: run(extra.lastCheck),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. AGENT SHELL
  // ══════════════════════════════════════════════════════════════════

  private async registerWithAgentAbject(): Promise<void> {
    if (!this.agentAbjectId) return;
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'ExternalCreator',
      description:
        'Works inside registered external projects on the host: a repository, a manuscript folder, a ' +
        'data directory the user has registered. Reads, writes, and edits files there, runs shell ' +
        'commands there, and runs the project\'s own check and verify commands, comparing against a ' +
        'baseline so it reports only the failures it introduced. Handles software, prose, notes, and ' +
        'data alike. Restricted to registered projects: reading or inspecting loose files elsewhere on ' +
        'the machine (a download, a sample export, a config file) belongs elsewhere, as do changing ' +
        'Abjects inside this system, interactive web browsing, and installed skill flows.',
      config: {
        completionMethod: 'candidateComplete',
            snapshotMethod: 'snapshotTask', restoreMethod: 'restoreTask',
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result', 'report'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `external-creator-${this.id}`,
        maxSteps: DEFAULT_TASK_STEPS,
      },
    }));
  }

  private onTaskMessage(method: string, handler: MessageHandlerFn): void {
    this.on(method, message => {
      const taskId = (message.payload as any)?.taskId;
      return typeof taskId === 'string' ? this.operationTask.run(taskId, () => handler(message)) : handler(message);
    });
  }

  private setupHandlers(): void {
    this.onTaskMessage('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description, data, approach, failureHistory } =
        msg.payload as {
          tupleId?: string; taskId?: string; goalId?: string; description: string;
          data?: Record<string, unknown>; approach?: string;
          failureHistory?: Array<{ agent: string; error: string }>;
        };

      const taskId = explicitTaskId ?? tupleId ?? `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return this.operationTask.run(taskId, () => this.runLoop({ taskId, taskText: description, goalId, data, tupleId, approach, failureHistory }));
    });

    this.onTaskMessage('runTask', async (msg: AbjectMessage) => {
      const { task, project } = msg.payload as { task: string; project?: string };
      const taskId = `ext-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return this.operationTask.run(taskId, () => this.runLoop({
        taskId, taskText: task, data: project ? { project } : undefined,
      }));
    });

    this.onDelivery('taskResult', async (msg: AbjectMessage) => {
      if(msg.routing.from!==this.agentAbjectId)throw new Error('Task result must come from AgentAbject');
      this.retainTaskResult(msg.payload);
      const payload = msg.payload as { ticketId: string };
      this.pendingTickets.get(payload.ticketId)?.resolve(payload);
    });

    this.onTaskMessage('progress', (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      // Progress arrives untagged, so it cannot be attributed to one task by
      // inspection. With several running, every live goal is genuinely being
      // worked on and each needs its timer reset, so all of them hear about it
      // — but the message itself belongs to whichever task emitted it, so it
      // is only quoted when there is no ambiguity about whose it is.
      if (this.goalManagerId) {
        const payload = msg.payload as { taskId?: string; phase?: string; message?: string } | undefined;
        const goals = new Set<string>();
        const task = payload?.taskId ? this.taskExtras.get(payload.taskId) : undefined;
        if (task?.goalId) goals.add(task.goalId);

        const attributable = goals.size === 1;
        for (const goalId of goals) {
          this.send(event(this.id, this.goalManagerId, 'updateProgress', {
            goalId,
            message: attributable ? (payload?.message ?? 'working...') : 'working...',
            phase: payload?.phase ?? 'acting',
            agentName: 'ExternalCreator',
          }));
        }
      }
    });

    // ── AgentAbject callbacks ──
    this.onTaskMessage('agentObserve', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { taskId } = msg.payload as { taskId: string };
      return this.handleObserve(taskId);
    });

    this.onTaskMessage('snapshotTask', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only the task runtime can snapshot this task');
      const extra = this.taskExtras.get((msg.payload as { taskId: string }).taskId);
      return extra ? encodeAgentState(extra) : null;
    });
    this.onTaskMessage('restoreTask', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only the task runtime can restore this task');
      const { taskId, snapshot } = msg.payload as { taskId: string; snapshot: unknown };
      // AgentAbject decodes the session before sending this message.
      const extra = structuredClone(snapshot) as TaskExtra;
      if (!extra) throw new Error('No specialist checkpoint');
      extra.taskId = taskId;
      extra.projectSession = false;
      extra.commandOutputs = new Set();
      extra.cancelled = false;
      extra.lastVerify = undefined; extra.lastCheck = undefined; extra.verifyBaseline = undefined;
      extra.mutationsSinceVerify++;
      this.taskExtras.set(taskId, extra);
      return { success: true };
    });

    this.onTaskMessage('candidateComplete', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.agentAbjectId) throw new Error('Only the task runtime can settle this candidate');
      const { taskId, result } = msg.payload as { taskId: string; result?: unknown };
      const extra = this.taskExtras.get(taskId);
      if (!extra) return { accepted: false, reason: 'Task state is unavailable' };
      let snapshotWarning: string | undefined;
      let currentSnapshot: { revision?: string; complete: boolean } | undefined;
      if (extra.project) {
        const current = await this.verificationSnapshot(extra);
        currentSnapshot = current;
        const required = extra.project.verifyCommand ?? extra.project.checkCommand;
        const latest = [extra.lastVerify, extra.lastCheck].filter((v): v is CheckVerdict => !!v && v.outcome.command === required).sort((a, b) => b.outcome.at - a.outcome.at)[0];
        if (latest?.passed && current.complete && latest.outcome.revision && current.revision !== latest.outcome.revision) {
          return { accepted: false, reason: `Project inputs changed after ${required}. Review ${current.changed?.slice(0, 8).join(', ') || 'the changed inputs'} and verify once after those edits.` };
        }
        if (!current.complete) snapshotWarning = `Current snapshot coverage is incomplete. ${current.issues?.slice(0, 3).join('; ') ?? ''}`;
      }
      const gate = this.gateVerdict(extra);
      const note = [gate.note, await this.completionChecks(extra, currentSnapshot), snapshotWarning].filter(Boolean).join('\n');
      return { accepted: gate.ok, reason: gate.reason, evidence: { taskId, note },
        ...(gate.ok && typeof result === 'string' ? { result: `${result}\n\nVerification: ${note}` } : {}) };
    });

    this.onTaskMessage('taskCancelled', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.agentAbjectId) return;
      const { taskId } = msg.payload as { taskId: string };
      const extra = this.taskExtras.get(taskId);
      if (extra) extra.cancelled = true;
      const shell = await this.shell();
      await this.request(request(this.id, shell, 'stopTaskProcesses', { taskId }));
    });

    this.onTaskMessage('agentAct', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg,this.agentAbjectId);
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { taskId, action } = msg.payload as { taskId: string; action: AgentAction };
      // A verify can legitimately run for many minutes; without a heartbeat the
      // pending ticket would time out while real work is happening.
      const heartbeat = setInterval(() => this.resetPendingTicketTimeouts((msg.payload as { taskId?: string }).taskId), 30_000);
      try {
        return await this.operationTask.run(taskId, () => this.handleAct(taskId, action));
      } finally {
        clearInterval(heartbeat);
      }
    });

    this.onTaskMessage('agentPhaseChanged', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts((msg.payload as { taskId?: string } | undefined)?.taskId);
      const { newPhase } = msg.payload as { newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.onTaskMessage('agentIntermediateAction', async (msg: AbjectMessage) => {
      await this.requireTaskRuntime(msg, this.agentAbjectId);
      const { taskId, action } = msg.payload as { taskId: string; action?: AgentAction };
      this.resetPendingTicketTimeouts(taskId);
      const extra = this.taskExtras.get(taskId);
      const text = action?.message ?? action?.text;
      if (extra && action?.action === 'reply' && typeof text === 'string' && text.trim()) extra.decisions.push(text);
    });
    this.onTaskMessage('agentActionResult', async (msg: AbjectMessage) => { this.resetPendingTicketTimeouts((msg.payload as { taskId?: string }).taskId); });
  }

  // ─── Task lifecycle ─────────────────────────────────────────────

  private async runLoop(args: {
    taskId: string;
    taskText: string;
    goalId?: string;
    data?: Record<string, unknown>;
    tupleId?: string;
    approach?: string;
    failureHistory?: Array<{ agent: string; error: string }>;
  }): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const extra: TaskExtra = {
      taskId: args.taskId,
      taskText: args.taskText,
      goalId: args.goalId,
      editSetOpen: false,
      filesRead: new Set(),
      filesModified: new Set(),
      preImages: new Map(),
      postImages: new Map(),
      instructionDirsSeen: new Set(),
      mutationsSinceVerify: 0,
      checkpoints: [],
      audit: [],
      decisions: [],
    };
    this.taskExtras.set(args.taskId, extra);
    this._currentGoalId = args.goalId;

    try {
      extra.project = await this.pickProject(args.taskText, args.data);
      let projectSetupNote: string | undefined;
      if (extra.project) {
        try {
          await this.setupIsolation(extra);
          await this.setDefaultCwd(extra);
          await this.projectRevision(extra);
          await this.captureBaseline(extra);
          await this.checkpoint(extra, 'task start');
          this.announceTaskStarted(extra);
        } catch (err) {
          // A project that cannot be prepared (root gone, snapshot failing)
          // is a fact about that project, not about the task. The loop starts
          // unset and the agent decides: pick another project, or fail with
          // the real reason. Failing here would blame the runner for it.
          const why = err instanceof Error ? err.message : String(err);
          const { name, root } = extra.project;
          this.audit(extra, `project ${name} at ${root} could not be prepared (${why.slice(0, 200)}); starting without a project`);
          log.warn(`task ${args.taskId}: project ${name} could not be prepared: ${why}`);
          try { await this.teardownIsolation(extra); } catch { /* best effort */ }
          projectSetupNote =
            `The project "${name}" at ${root} could not be prepared: ${why}\n` +
            `No project is selected. Use set_project to choose another registered project if the task belongs there, ` +
            `otherwise fail with this reason so the goal can route the work elsewhere.`;
          extra.project = undefined;
          extra.workRoot = undefined;
          extra.worktree = undefined;
          extra.projectSession = undefined;
        }
      }

      const initialMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (projectSetupNote) initialMessages.push({ role: 'user', content: projectSetupNote });
      if (args.failureHistory && args.failureHistory.length > 0) {
        initialMessages.push({
          role: 'user',
          content:
            `Task: ${args.taskText}\n\nPrevious attempts failed:\n` +
            args.failureHistory.map(f => `- ${f.agent}: ${f.error}`).join('\n') +
            `\n\nTake a different approach.`,
        });
      }
      if (args.approach) {
        initialMessages.push({ role: 'assistant', content: `I will proceed as follows: ${args.approach}` });
      }

      // The project block (commands, trust, the project's own instruction
      // files) is identical for every task in the same project, so it rides
      // in the system prompt, ahead of the cache breakpoint, and is read once
      // per project per cache window rather than once per task.
      const projectBlock = await this.buildProjectBlock(extra);
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId: args.taskId,
          task: args.taskText,
          systemPrompt: projectBlock ? `${this.buildSystemPrompt()}\n\n${projectBlock}` : this.buildSystemPrompt(),
          goalId: args.goalId,
          dispatchTupleId: args.tupleId,
          initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
          config: {
            maxSteps: taskStepBudget(args.data?.maxSteps),
            knowledgeScope: extra.project ? `project:${extra.project.name}` : undefined,
            timeout: 1_800_000,
            queueName: `external-creator-${args.taskId}`,
          },
        }),
      );

      const loop = await this.waitForTaskResult(ticketId, 900_000);
      return await this.finalize(extra, loop);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { await this.writeSessionSummary(extra, message, { ok: false, note: message }); } catch { /* best effort */ }
      return { success: false, error: message };
    } finally {
      this.announceTaskFinished(extra);
      try { await this.teardownIsolation(extra); } catch { /* leave the worktree in place */ }
      // Permissions granted "for this task" end with the task. They also time
      // out on their own, but a task that finishes should not leave a standing
      // grant behind for the next one to inherit.
      try {
        const brokerId = await this.discoverDep('PermissionBroker');
        if (brokerId) this.send(request(this.id, brokerId, 'clearSessionGrants', { taskId: args.taskId }));
      } catch { /* best effort */ }
      this.taskExtras.delete(args.taskId);
      if (this._currentGoalId === args.goalId) this._currentGoalId = undefined;
    }
  }

  /**
   * Turn the loop's claim into an honest result.
   *
   * candidateComplete supplies verification before the runtime settles the task.
   * Finalization preserves that evidence alongside the actual execution outcome
   * and cleans up the project session.
   */
  private async finalize(
    extra: TaskExtra,
    loop: { success: boolean; result?: unknown; error?: string },
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const gate = this.gateVerdict(extra);
    const checks = await this.completionChecks(extra);
    const worktreeNote = await this.teardownIsolation(extra);
    extra.worktree = undefined; // teardown is idempotent; do not repeat it in finally

    const reportText = typeof loop.result === 'string'
      ? loop.result
      : loop.result !== undefined ? JSON.stringify(loop.result) : (loop.error ?? '');

    const evidence = [
      gate.note,
      checks,
      extra.lastVerify ? this.renderVerdict(extra.lastVerify)
        : extra.lastCheck ? this.renderVerdict(extra.lastCheck) : '',
      extra.checkpoints.length > 0
        ? `Checkpoints: ${extra.checkpoints.map(c => c.ref.slice(0, 10)).join(', ')} (restore with \`git stash apply <ref>\`)`
        : '',
      worktreeNote ?? '',
    ].filter(Boolean).join('\n');

    await this.writeSessionSummary(extra, reportText, gate, loop);

    if (!loop.success) {
      const denials = (extra.permissionEvidence ?? []).filter(p => !p.decision.startsWith('accept'));
      const permissionNote = /permission|read.only|sandbox|approval/i.test(loop.error ?? '')
        ? `\nPermission evidence: ${denials.length ? JSON.stringify(denials) : 'No capability denial was recorded. The worker explanation is unverified; Ask the owner before treating access as unavailable.'}` : '';
      return { success: false, error: `${loop.error ?? 'task failed'}\n\n${evidence}${permissionNote}` };
    }

    if (!gate.ok) {
      log.info(`[${extra.taskId.slice(0, 8)}] gate refused a done claim: ${gate.reason}`);
      // On a dispatched task the runtime has already marked the tuple done by
      // the time this runs — it finishes a task the instant it parses a
      // terminal action. So the downgraded result is not the only place this
      // can be said: surface it to the user directly, or an unverified change
      // would read as a success in the one place they are looking.
      void this.notify(
        `ExternalCreator reported done without verifying: ${gate.note}`,
        'warning',
        12_000,
      ).catch(() => { /* no UI is not a reason to fail the task */ });
      this.reportProgress(extra, 'error', `unverified: ${gate.note}`);
      return {
        success: false,
        error:
          `Reported complete, but the change is not verified, so this is not done.\n` +
          `${gate.reason}\n\nWhat the agent reported:\n${reportText}\n\n${evidence}`,
      };
    }

    return { success: true, result: `${reportText}\n\n${evidence}` };
  }

  /**
   * Deliberately does nothing to ShellExecutor's per-caller default cwd.
   *
   * That default is keyed by calling object, not by task, so two concurrent
   * tasks in different projects would overwrite each other's — and the one
   * that lost would run its commands in the other project's root, which is
   * the kind of failure that looks like a mystery rather than a bug. Every
   * command this agent runs carries an explicit cwd from its own task state
   * (see runCommand), so nothing here needs the default.
   */
  private async setDefaultCwd(_extra: TaskExtra): Promise<void> {
    return;
  }

  // ─── Observe ────────────────────────────────────────────────────

  private async handleObserve(taskId: string): Promise<{ observation: string; tier?: string }> {
    const extra = this.taskExtras.get(taskId);
    if (!extra) return { observation: 'Task state is gone.', tier: 'code' };

    const lines: string[] = [];

    if (!extra.lastResult) {
      // First turn: everything the agent needs to stop asking.
      if (extra.project) {
        lines.push(`Project: ${extra.project.name} at ${extra.workRoot}`);
        if (extra.project.description) lines.push(extra.project.description);
        if (extra.worktree) {
          lines.push(`Isolation: worktree on branch ${extra.worktree.branch}. Your changes are NOT in the main checkout.`);
        }
        lines.push(`Trusted: ${extra.project.trusted}${extra.project.trusted ? '' : ' — this project\'s own instruction files are NOT loaded'}`);
        lines.push(`Protected paths (will not be written): ${this.protectedPathsFor(extra).join(', ')}`);
        const status = extra.project.vcs === 'git' ? await this.gitStatusLine(extra) : undefined;
        if (status) lines.push(status);

        const others = await this.siblings(extra);
        if (others.length > 0) lines.push(`\n${this.renderSiblings(others)}`);

        const prior = await this.readGoalData<{ summary?: string }>(extra, SESSION_KEY);
        if (prior?.summary) {
          lines.push(`\nWhere the previous task in this goal left off:\n${prior.summary.slice(0, 4000)}${prior.summary.length > 4000 ? `\n[Handoff excerpt. Read the complete report, decisions and audit with read_scratchpad key=${SESSION_KEY}.]` : ''}`);
        }
      } else {
        const all = await this.listProjects();
        lines.push(
          all.length === 0
            ? 'No external projects are registered. I cannot work on a directory until one is registered — ' +
              'use ask_user to ask for the path, or call ExternalProjectRegistry.addProject if the user gave you one.'
            : `No project selected yet. Registered projects:\n` +
              all.map(p => `- ${p.name} — ${p.root}${p.description ? ` (${p.description})` : ''}`).join('\n') +
              `\nUse {"action":"set_project","name":"<one of these>"} before touching files.`,
        );
      }
    } else {
      lines.push('The previous action result is already in the conversation above.');
    }

    if (extra.baseline) {
      lines.push(this.baselineSummary(extra));
      if (extra.verifyBaseline && !extra.verifyBaseline.done) lines.push('Declared verification is already running; verify will await that run.');
      else lines.push('Use verify to reuse applicable passing evidence; force: true explicitly requests a fresh run.');
    }

    // The gate is stated every turn once anything has changed, so "done" is
    // never a surprise refusal.
    if (extra.filesModified.size > 0) {
      const gate = this.gateVerdict(extra);
      lines.push(gate.ok
        ? `\nGate: ${gate.note}`
        : `\nGate: NOT satisfied. ${gate.reason}`);
    }

    // Recovery is where the strongest model earns its cost; ordinary file work
    // is what the code tier is for.
    const tier = extra.lastResult?.startsWith('Error:') ? 'smart' : 'code';
    return { observation: lines.join('\n'), tier };
  }

  private async gitStatusLine(extra: TaskExtra): Promise<string | undefined> {
    try {
      const r = await this.git(extra, 'status --porcelain');
      if (r.exitCode !== 0) return undefined;
      const n = r.stdout.trim().split('\n').filter(Boolean).length;
      return n === 0
        ? 'Working tree is clean.'
        : `Working tree already has ${n} uncommitted change(s) — preserve existing work except where this task explicitly asks you to review, modify, or commit it.`;
    } catch {
      return undefined;
    }
  }

  // ─── Act ────────────────────────────────────────────────────────

  private static readonly ACTIONS = [
    'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls',
    'verify', 'read_output', 'set_project', 'call', 'reply', 'ask_user', 'done', 'fail',
  ];

  private async handleAct(
    taskId: string,
    action: AgentAction,
  ): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const extra = this.taskExtras.get(taskId);
    if (!extra) return { success: false, error: 'Task state is gone.' };

    const needsProject = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'verify'];
    if (needsProject.includes(action.action) && !extra.workRoot) {
      return {
        success: false,
        error: 'No project selected. Use {"action":"set_project","name":"<handle or path>"} first.',
      };
    }

    try {
      let result: { success: boolean; data?: unknown; error?: string; payload?: string };

      switch (action.action) {
        case 'read':        result = await this.opRead(extra, action); break;
        case 'write':       result = await this.opWrite(extra, action); break;
        case 'edit':        result = await this.opEdit(extra, action); break;
        case 'bash':        result = await this.opBash(extra, action); break;
        case 'grep':        result = await this.opGrep(extra, action); break;
        case 'find':        result = await this.opFind(extra, action); break;
        case 'ls':          result = await this.opLs(extra, action); break;
        case 'verify':      result = await this.opVerify(extra, action); break;
        case 'read_output': result = await this.opReadOutput(extra, action); break;
        case 'set_project': result = await this.opSetProject(extra, action); break;
        case 'call':        result = await this.opCall(extra, action); break;

        case 'reply': {
          const text = String(action.text ?? action.message ?? '');
          extra.decisions.push(text.slice(0, 300));
          result = { success: true, data: 'Sent.' };
          break;
        }

        case 'ask_user': {
          const question = String(action.question ?? '');
          result = { success: true, data: `Asked: ${question}` };
          break;
        }

        default:
          result = {
            success: false,
            error: `Unknown action "${action.action}". Available: ${ExternalCreator.ACTIONS.join(', ')}.`,
          };
      }

      // Echo the result into the next observation without paying for it twice:
      // a large result is already in the conversation as a searchable handle.
      const rendered = result.payload ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
      extra.lastResult = result.success
        ? resultEcho(rendered ?? '(no output)')
        : `Error: ${result.error}`;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      extra.lastResult = `Error: ${message}`;
      this.audit(extra, `action ${action.action} threw: ${message}`);
      return { success: false, error: message, ...(errorDetails(err) ? { data: errorDetails(err) } : {}) };
    }
  }

  // ─── Prompts ────────────────────────────────────────────────────

  /**
   * Deliberately short.
   *
   * The model already knows how to program, how git works, and what a test
   * runner does. What it cannot know is this object's action shapes and the
   * two or three rules that make the loop economical, and that is all this
   * says. Project-specific knowledge arrives in the task prompt from the
   * project's own instruction files, where the user can edit it.
   */
  private buildSystemPrompt(): string {
    return `You are ExternalCreator. You work on real files on this host, inside one external project.

An external project is a named directory holding a body of work. It may be software, prose, notes, or data — read what is there rather than assuming.

# Response format

Emit JSON actions in \`\`\`json code blocks, and nothing else. Batch independent checks in one response. For a short mechanical sequence whose only dependency is successful exit, one bash command may use && to stop on failure; report its combined status honestly. Inspect results before decisions that depend on their content. Emit done, fail, and ask_user alone.

For a fresh Git review, group status, diff statistics, and recent commit conventions into the initial inspection, then review the changes and applicable validation evidence. For execution of an approved proposal, retrieve and reuse that review, grouping, and complete commit messages; do not automatically read the full diff again. Batch independent freshness checks. Staging and staged inspection can share one command, but inspect their results before committing. Commit creation followed by commit metadata and final status can share one command with &&. Keep named verification commands separate so their own exit status and evidence can be reused.

For a proposal, retain execution details under a descriptive goal scratchpad key through GoalManager.writeGoalData: ordered commits with full subjects/bodies, whole-file selections, exact patches for files split across commits, observed input state, validation evidence, and remaining uncertainties. Specify the base and order for each patch. Save patch contents or durable references, not interactive hunk numbers or expiring output handles alone. Preparing a proposal should not change the user's index. The answer must still contain the complete proposal the user is approving.

Before executing, compare the relevant current inputs with the saved state: Git HEAD, index contents, working-tree contents, and relevant untracked file contents. File names, diff statistics, or a clean-looking status alone do not establish equality. Content fingerprints can establish equality without rereading the diff semantically; any owner snapshot has only its declared coverage and may exclude Git metadata or ignored files. If unchanged, proceed with the saved selections. If changed, inspect the affected delta and retain unaffected decisions. If an old proposal lacks exact patches or state evidence, reconstruct only the missing selections from the retained review and focused reads. If its intended selection cannot be recovered unambiguously, report that gap before mutation.

Stage deterministically from the saved whole-file selections or exact patches, checking applicability against the current index. Do not feed a fixed sequence of y/n answers into git add -p: hunk boundaries and order can change. Preserve unrelated staged changes. Compare the actual staged patch with the intended patch before EACH commit, including missing or extra hunks, and check the resulting commit and remaining changes afterwards. A successful staging command, git diff --check, or matching statistics does not establish semantic agreement. Do not claim each intermediate commit was tested when verification covered only the combined working tree. Reuse passing verification only for the command, inputs, and environment it actually covered; use the owner's verify results to establish current applicability.

Live project configuration and observed results take precedence over historical knowledge about scripts or capabilities. Recalled command suggestions are not user requirements. Use verify (full:false for the check command) to reuse passing evidence on unchanged inputs, unless the user explicitly requests a fresh run or an additional distinct check. An exact declared command requested through bash follows the same reuse rules; force:true requests execution again. Do not rerun an equivalent compiler invocation merely because an old memory spells it differently.

# Actions

- {"action":"read_output","id":"<outputObjectId>","offset":0,"length":30000} — inspect retained command output through its owner (expires after an hour or restart). A truncated command preview omits earlier bytes: start at offset 0 and continue at nextOffset up to totalBytes. Read these pages before rerunning an inspection command; payload previews alone do not cover the original output.
- {"action":"read","path":"src/x.ts","offset":1,"limit":200} — read a file. Paths are relative to the project root. A truncated read tells you the offset to continue from.
- {"action":"write","path":"src/x.ts","content":"..."} — create a file or replace one wholesale.
- {"action":"edit","path":"src/x.ts","edits":[{"oldText":"...","newText":"..."}],"more":false} — the normal way to change a file. Every oldText is matched against the file as it is now, must be unique, and must not overlap another edit in the same call. If any fails, NOTHING is written and you get every failure at once.
- {"action":"bash","command":"pnpm build","timeout":120000} — run a command in the project. A non-zero exit is information, not an error.
- {"action":"grep","pattern":"foo","glob":"*.ts","context":2} — search contents; returns file:line.
- {"action":"find","pattern":"**/*.ts"} — find files by glob.
- {"action":"ls","path":"src"} — list a directory.
- {"action":"verify","full":true} — run the project's verify command (full:false runs the fast check). This is what a claim of "it works" has to point at.
- {"action":"set_project","name":"<handle or path>"} — choose which project to work in.
- {"action":"call","target":"KnowledgeBase","method":"recall","payload":{}} — message any object in this system.
- {"action":"reply","text":"..."} — a note to the user mid-task.
- {"action":"ask_user","question":"..."} — ask, then finish this task with done.
- {"action":"done","result":"..."} / {"action":"fail","reason":"..."} — terminal.

# How to work

1. **Find before reading.** grep and find cost one step and point at exact lines; reading whole files to look for something costs many.
2. **Write the whole change, then let it be checked.** Put every edit to a file in ONE edit call. Across turns, mark every edit but the last with "more": true to keep the set open, then drop it on the last one.
3. **Checks run themselves.** When an edit set closes, this project's check command runs automatically and its verdict comes back on that same action. Do not spend a step running it yourself.
4. **You are judged against a baseline, on the files you wrote.** Failures that existed before you started are not yours and never block you. Failures you introduce in files you wrote do. Other tasks may be working in this project at the same time: your first observation lists them and what they have written, and new diagnostic location alone does not establish which task caused a failure.
5. **Use verification evidence.** Run the declared check after relevant edits; a distinct full verification command must also run when required. Use verify (full: false for check, full: true for verification) to obtain structured results and reuse applicable evidence. force: true requests a fresh run. The exact declared command counts through either verify or bash; shell pipelines and compound commands do not provide individual verification status. Filter output through read_output after execution, not through a pipeline that can mask failure. Read-only commands and commits do not invalidate unchanged project inputs. Evidence reuse covers the declared command and scoped project snapshot within this task; request force: true when toolchain, environment, services, or other untracked inputs changed. Report snapshot limitations honestly; an exit-0 command with limited coverage is not a failed test, and repeating it just to get identical snapshots is unnecessary. If completion still needs correction after one attempt, preserve the work and report the unresolved evidence.
6. **Say what you did not verify.** When a project declares no commands, there is nothing to run — report exactly what you changed and that it was not verified. Never let silence imply a pass.
7. **Keep oldText small.** Just enough context to be unique, no padding.
8. **Delegation is a message to any object.** Discover collaborators by name and use Ask to establish how they can help, their constraints, and the appropriate messages. Reuse relevant answers while their assumptions hold. Use describe when exact interface parameters are needed; it does not replace contextual Ask collaboration. Then message the receiver with a self-contained request, including durable input references and the remaining outcome rather than asking it to rediscover completed work. Inside a submit_job, discovery is dep(name) / find(name). Other objects may message your runTask the same way.

Report in your done result: what changed, which command proved it, and anything you could not check.`;
  }

  /**
   * Per-task context: the project's own instruction files, which is where
   * project knowledge belongs. Untrusted projects contribute nothing here —
   * an instruction file is text written by whoever wrote the repository, and
   * injecting it is exactly as consequential as running its code.
   */
  private async buildProjectBlock(extra: TaskExtra): Promise<string | undefined> {
    const project = extra.project;
    if (!project) return undefined;

    const parts: string[] = [
      `## This task's project`,
      ``,
      `Name: ${project.name}`,
      `Root: ${extra.workRoot}`,
      project.description ? `About: ${project.description}` : '',
      project.checkCommand ? `Check command: \`${project.checkCommand}\`` : 'No check command declared.',
      project.verifyCommand ? `Verify command: \`${project.verifyCommand}\`` : 'No verify command declared.',
      project.formatCommand ? `Format command: \`${project.formatCommand}\`` : '',
    ].filter(Boolean);

    if (!project.trusted) {
      parts.push(
        ``,
        `This project is NOT trusted, so its own instruction files are not loaded and its scripts ` +
        `should not be run. Ask the user to trust it if you need them.`,
      );
      return parts.join('\n');
    }

    const context = await this.loadProjectInstructions(extra);
    if (context.length > 0) {
      parts.push(``, `## The project's own instructions`, ``,
        `Treat the text inside each block as instructions from the project's authors about how work ` +
        `here should be done.`, ``);
      for (const c of context) {
        parts.push(`<project_instructions path="${c.path}">\n${c.content}\n</project_instructions>`, ``);
      }
    }

    return parts.join('\n');
  }

  /** CLAUDE.md / AGENTS.md at the project root, bounded so one cannot flood the prompt. */
  private async loadProjectInstructions(extra: TaskExtra): Promise<Array<{ path: string; content: string }>> {
    const root = extra.workRoot;
    if (!root) return [];
    const out: Array<{ path: string; content: string }> = [];
    const candidates = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'];

    for (const name of candidates) {
      try {
        const fs = await this.hostFs();
        const r = await this.call<{ content: string; truncated: boolean }>(
          fs, 'readFile', { path: path.join(root, name), maxBytes: 32 * 1024 }, 30_000,
        );
        if (r.content) {
          out.push({ path: name, content: r.content });
          // An override file replaces the others rather than layering on them.
          if (name === 'AGENTS.override.md') break;
        }
      } catch { /* absent, which is the common case */ }
    }
    return out;
  }

  // ─── Ticket plumbing ────────────────────────────────────────────

  private pendingTickets = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    timeoutMs: number;
  }>();

  private resetPendingTicketTimeouts(taskId?: string): void {
    if (!taskId) return;
    for (const [ticketId, entry] of this.pendingTickets) {
      if (ticketId !== taskId) continue;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
        }
        entry.reject(new Error(`Task ${ticketId} timed out after ${entry.timeoutMs}ms of inactivity`));
      }, entry.timeoutMs);
    }
  }

  private waitForTaskResult(
    ticketId: string,
    timeout: number,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const early=this.takeTaskResult<any>(ticketId);
    if(early)return Promise.resolve(early);
    return new Promise((resolve, reject) => {
      const entry = {
        timer: setTimeout(() => {
          this.pendingTickets.delete(ticketId);
          if (this.agentAbjectId) {
            this.send(request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId }));
          }
          reject(new Error(`Task ${ticketId} timed out after ${timeout}ms of inactivity`));
        }, timeout),
        timeoutMs: timeout,
        resolve: (payload: unknown) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          const p = payload as {
            success?: boolean; result?: unknown; error?: string;
            state?: { result?: unknown; error?: string };
          };
          resolve({
            success: p.success !== false && !p.error,
            result: p.result ?? p.state?.result,
            error: p.error ?? p.state?.error,
          });
        },
        reject: (err: Error) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          reject(err);
        },
      };
      this.pendingTickets.set(ticketId, entry);
    });
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [id, extra] of this.taskExtras) {
      invariant(extra.taskId === id, 'task map key must equal the task id');
      invariant(extra.mutationsSinceVerify >= 0, 'mutation count cannot go negative');
    }
  }
}
