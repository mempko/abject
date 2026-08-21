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

import * as path from 'path';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { require as precondition, invariant } from '../core/contracts.js';
import type { AgentAction } from './agent-abject.js';
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
const BASELINE_KEY = 'externalcreator:baseline';

/** Long enough for a real build; short enough that a hung command is noticed. */
const BASH_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 900_000;

// ══════════════════════════════════════════════════════════════════════
// 1. INFRASTRUCTURE
// ══════════════════════════════════════════════════════════════════════

/** One run of a project-declared command, reduced to something comparable. */
interface CheckOutcome {
  command: string;
  exitCode: number;
  /**
   * Diagnostic lines with their volatile parts removed, so the same underlying
   * failure produces the same string across runs. Line numbers are stripped on
   * purpose: inserting a line at the top of a file must not make every
   * pre-existing error in it look new.
   */
  signatures: string[];
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
  /** Failures this task introduced. Empty means nothing was made worse. */
  newFailures: string[];
  /** Pre-existing failures still present. Advisory, never blocking. */
  preExisting: number;
  passed: boolean;
  /** Set when there was no baseline to compare against. */
  unbaselined?: boolean;
}

interface TaskExtra {
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
  /** Writes and edits since the last passing verify. Drives the gate. */
  mutationsSinceVerify: number;
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
- Changing, adding, or removing files in a registered external project
- Investigating a repository or directory on disk and reporting what is there
- Running a project's build, tests, linter, formatter, or any shell command in it
- Fixing something that a compiler, test suite, or linter reports
- Anything phrased as work on a repo, a checkout, a codebase, or a directory path

### I answer PASS to
- Creating or modifying Abjects inside this system: objects, their source, their
  windows, their handlers. Those live in the Registry, not on disk, and belong to
  the object-authoring agent.
- Interactive web browsing, and installed skill flows.
- Work in a directory that is not a registered external project, unless the task
  names the path — I will ask for it to be registered rather than guess.

### What I promise about verification
When a project declares a check or verify command, I run it and compare against a
baseline captured before I touched anything, so I am accountable for failures I
introduced and not for the ones already there. When a project declares nothing to
run, I say plainly what I changed and what I could not verify. I never report a
clean result I did not observe.`;
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
    return this.request<T>(request(this.id, target, method, payload), timeoutMs);
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
      return await this.call<ExternalProject[]>(reg, 'listProjects', {}, 15_000);
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
    const hint = typeof data?.project === 'string' ? data.project
      : typeof data?.projectPath === 'string' ? data.projectPath
      : undefined;
    if (hint) {
      const byHint = await this.resolveProject(hint);
      if (byHint) return byHint;
    }

    const all = await this.listProjects();
    if (all.length === 0) return undefined;

    // An absolute path in the task text is as explicit as a hint.
    const pathMatch = taskText.match(/(?:^|\s)(~?\/[\w.\-/]+)/);
    if (pathMatch) {
      const byPath = await this.resolveProject(pathMatch[1]);
      if (byPath) return byPath;
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
        `use bash if you genuinely need to reach outside it.`,
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
      { command: `git ${args}`, shell: true, cwd: cwd ?? extra.workRoot, timeout: timeoutMs },
      timeoutMs + 15_000,
    );
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated?: unknown }> {
    const shellId = await this.shell();
    return this.call<{ stdout: string; stderr: string; exitCode: number; truncated?: unknown }>(
      shellId, 'exec',
      { command, shell: true, cwd: cwd ?? extra.workRoot, timeout: timeoutMs },
      timeoutMs + 30_000,
    );
  }

  private async captureOutcome(extra: TaskExtra, command: string, timeoutMs: number): Promise<CheckOutcome> {
    const r = await this.runCommand(extra, command, timeoutMs);
    const output = [r.stdout, r.stderr].filter(s => s && s.length > 0).join('\n');
    return {
      command,
      exitCode: r.exitCode,
      signatures: ExternalCreator.signaturesOf(output, extra.workRoot),
      at: Date.now(),
      output,
    };
  }

  /**
   * Judge a run against the baseline.
   *
   * The rule that makes this usable on a real repository: a project that was
   * already failing stays failing without blocking anything. Only a failure
   * the baseline does not have counts against this task. A baseline that was
   * green makes any failure new by definition.
   */
  private judge(outcome: CheckOutcome, baseline: CheckOutcome | undefined): CheckVerdict {
    if (outcome.exitCode === 0) {
      return { outcome, newFailures: [], preExisting: baseline?.signatures.length ?? 0, passed: true };
    }
    if (!baseline) {
      return { outcome, newFailures: outcome.signatures, preExisting: 0, passed: false, unbaselined: true };
    }
    if (baseline.exitCode === 0) {
      return { outcome, newFailures: outcome.signatures, preExisting: 0, passed: false };
    }
    const known = new Set(baseline.signatures);
    const newFailures = outcome.signatures.filter(s => !known.has(s));
    return {
      outcome,
      newFailures,
      preExisting: outcome.signatures.length - newFailures.length,
      passed: newFailures.length === 0,
    };
  }

  private renderVerdict(v: CheckVerdict): string {
    const head = `\`${v.outcome.command}\` exited ${v.outcome.exitCode}`;
    if (v.passed && v.outcome.exitCode === 0) {
      return `${head} — clean.`;
    }
    if (v.passed) {
      return `${head}, but every failure was already there before this task ` +
        `(${v.preExisting} pre-existing). Nothing new was introduced.`;
    }
    const lines = v.newFailures.slice(0, 25).map(s => `  ${s}`).join('\n');
    const more = v.newFailures.length > 25 ? `\n  … and ${v.newFailures.length - 25} more` : '';
    const caveat = v.unbaselined
      ? ' (no baseline was captured, so these may or may not predate this task)'
      : ` (${v.preExisting} other failures predate this task and are not yours)`;
    return `${head} — ${v.newFailures.length} failure(s) attributable to this task${caveat}:\n${lines}${more}`;
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
    if (cached && cached.project === project.name && cached.head === head) {
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

    if (project.verifyCommand && project.verifyCommand !== project.checkCommand) {
      this.reportProgress(extra, 'observing', `baseline: ${project.verifyCommand}`);
      try {
        baseline.verify = await this.captureOutcome(extra, project.verifyCommand, VERIFY_TIMEOUT_MS);
        this.audit(extra, `baseline verify exit=${baseline.verify.exitCode} (${baseline.verify.signatures.length} known failures)`);
      } catch (err) {
        this.audit(extra, `baseline verify could not run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    extra.baseline = baseline;
    await this.writeGoalData(extra, BASELINE_KEY, baseline);
  }

  private baselineSummary(extra: TaskExtra): string {
    const b = extra.baseline;
    if (!b) {
      return extra.project && (extra.project.checkCommand || extra.project.verifyCommand)
        ? 'Baseline: not captured.'
        : 'Baseline: this project declares no commands, so there is nothing to run and nothing to compare against.';
    }
    const bits: string[] = [];
    if (b.check) bits.push(`${b.check.command} → exit ${b.check.exitCode}, ${b.check.signatures.length} known failure(s)`);
    if (b.verify) bits.push(`${b.verify.command} → exit ${b.verify.exitCode}, ${b.verify.signatures.length} known failure(s)`);
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

  private async opRead(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
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
    const header = `${this.displayPath(extra, abs)} (${r.totalLines} lines)\n`;
    return bulkAwareResult(header + r.content);
  }

  private async opWrite(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const abs = this.resolveWorkPath(extra, String(action.path ?? ''));
    const content = action.content;
    if (typeof content !== 'string') return { success: false, error: 'write requires a "content" string' };
    this.assertWritable(extra, abs);

    await this.rememberPreImage(extra, abs);
    const fs = await this.hostFs();
    await this.call(fs, 'writeFile', { path: abs, content }, 60_000);

    extra.filesModified.add(abs);
    extra.mutationsSinceVerify++;
    this.audit(extra, `write ${this.displayPath(extra, abs)} (${content.length} chars)`);
    return this.afterMutation(extra, action, `Wrote ${this.displayPath(extra, abs)} (${content.split('\n').length} lines).`);
  }

  private async opEdit(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const abs = this.resolveWorkPath(extra, String(action.path ?? ''));
    const edits = action.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return { success: false, error: 'edit requires a non-empty "edits" array of { oldText, newText }' };
    }
    this.assertWritable(extra, abs);

    await this.rememberPreImage(extra, abs);
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

    extra.filesModified.add(abs);
    extra.mutationsSinceVerify++;
    this.audit(extra, `edit ${this.displayPath(extra, abs)} applied ${r.applied}`);
    const summary = `Applied ${r.applied} edit(s) to ${this.displayPath(extra, abs)}:\n${r.diff ?? ''}`;
    return this.afterMutation(extra, action, summary, abs);
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
      verdict = this.judge(await this.captureOutcome(extra, cmd, VERIFY_TIMEOUT_MS), extra.baseline?.check);
    } catch (err) {
      return { success: true, data: `${summary}\n\nCheck could not run: ${err instanceof Error ? err.message : String(err)}` };
    }
    extra.lastCheck = verdict;
    this.audit(extra, `check exit=${verdict.outcome.exitCode} new=${verdict.newFailures.length}`);

    // A file this task just edited that no longer parses is a mechanical
    // failure with a known cause and a known undo. Restoring it beats leaving
    // source no one authored on disk while the agent works out what happened.
    if (!verdict.passed && editedPath && this.looksLikeParseFailure(verdict, editedPath, extra)) {
      const restored = await this.rollback(extra, editedPath);
      if (restored) {
        return {
          success: false,
          error:
            `${summary}\n\nThat edit left ${this.displayPath(extra, editedPath)} unparseable, so it was ` +
            `REVERTED to its state at the start of this task. Nothing is half-written.\n\n${this.renderVerdict(verdict)}`,
        };
      }
    }

    return { success: true, data: `${summary}\n\n${this.renderVerdict(verdict)}` };
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

  private async rollback(extra: TaskExtra, abs: string): Promise<boolean> {
    const pre = extra.preImages.get(abs);
    if (pre === undefined) return false;
    try {
      const fs = await this.hostFs();
      await this.call(fs, 'writeFile', { path: abs, content: pre }, 60_000);
      extra.filesModified.delete(abs);
      extra.mutationsSinceVerify = Math.max(0, extra.mutationsSinceVerify - 1);
      this.audit(extra, `rolled back ${this.displayPath(extra, abs)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async opBash(extra: TaskExtra, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string; payload?: string }> {
    const command = String(action.command ?? '');
    if (!command) return { success: false, error: 'bash requires a "command" string' };
    const timeout = typeof action.timeout === 'number' ? action.timeout : BASH_TIMEOUT_MS;
    const cwd = action.cwd ? this.resolveWorkPath(extra, String(action.cwd)) : extra.workRoot;

    this.reportProgress(extra, 'acting', command.slice(0, 80));
    const r = await this.runCommand(extra, command, timeout, cwd);
    this.audit(extra, `bash exit=${r.exitCode}: ${command.slice(0, 160)}`);

    const body = [
      `exit ${r.exitCode}`,
      r.stdout ? `stdout:\n${r.stdout}` : '',
      r.stderr ? `stderr:\n${r.stderr}` : '',
    ].filter(Boolean).join('\n');

    // A non-zero exit is information, not a failure of the action: the agent
    // asked what happens and now knows. Reporting it as an error would put it
    // in the failure path and skew loop-detection.
    return bulkAwareResult(body);
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

    this.reportProgress(extra, 'acting', `verify: ${command}`);
    const outcome = await this.captureOutcome(extra, command, VERIFY_TIMEOUT_MS);
    const baseline = full ? (extra.baseline?.verify ?? extra.baseline?.check) : extra.baseline?.check;
    const verdict = this.judge(outcome, baseline);

    if (full) extra.lastVerify = verdict; else extra.lastCheck = verdict;
    if (verdict.passed) extra.mutationsSinceVerify = 0;
    this.audit(extra, `verify(${full ? 'full' : 'check'}) exit=${outcome.exitCode} new=${verdict.newFailures.length}`);

    return { success: true, data: this.renderVerdict(verdict) };
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
    extra.project = project;
    await this.setupIsolation(extra);
    await this.setDefaultCwd(extra);
    await this.captureBaseline(extra);
    await this.checkpoint(extra, 'task start');
    return { success: true, data: `Working in ${project.name} at ${extra.workRoot}.\n${this.baselineSummary(extra)}` };
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
    const response = await this.call<unknown>(targetId, method, action.payload ?? {}, timeout);
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
    if (changed === 0) {
      return { ok: true, note: 'No files were changed.' };
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

    const latest = extra.lastVerify ?? extra.lastCheck;
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

    if (!latest.passed) {
      return {
        ok: false,
        reason:
          `${latest.newFailures.length} failure(s) were introduced by this task and are still present:\n` +
          latest.newFailures.slice(0, 15).map(s => `  ${s}`).join('\n'),
        note: `${changed} file(s) changed, ${latest.newFailures.length} new failure(s).`,
      };
    }

    return {
      ok: true,
      note:
        `${changed} file(s) changed; \`${latest.outcome.command}\` exited ${latest.outcome.exitCode}` +
        (latest.preExisting > 0 ? ` with ${latest.preExisting} pre-existing failure(s) untouched` : '') +
        `, no new failures.`,
    };
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
  private async writeSessionSummary(extra: TaskExtra, report: string, gate: { ok: boolean; note: string }): Promise<void> {
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
      `## Progress`,
      `### Done`,
      report ? `- [x] ${report.split('\n')[0]}` : `- [x] (no report)`,
      gate.ok ? `- [x] ${gate.note}` : '',
      `### In Progress`,
      gate.ok ? `- (nothing outstanding)` : `- [ ] ${gate.note}`,
      `### Blocked`,
      gate.ok ? `(none)` : gate.note,
      ``,
      `## Key Decisions`,
      extra.decisions.length > 0 ? extra.decisions.map(d => `- ${d}`).join('\n') : '- (none recorded)',
      ``,
      `## Next Steps`,
      gate.ok ? `1. (task reported complete)` : `1. ${gate.note}`,
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
      previous: prev?.summary ? prev.summary.slice(0, 4000) : undefined,
      audit: extra.audit.slice(-200),
      at: Date.now(),
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. AGENT SHELL
  // ══════════════════════════════════════════════════════════════════

  private async registerWithAgentAbject(): Promise<void> {
    if (!this.agentAbjectId) return;
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'ExternalCreator',
      description:
        'Works on files on the host: reads, writes, and edits them in a registered external project, ' +
        'runs shell commands there, and runs the project\'s own check and verify commands, comparing ' +
        'against a baseline so it reports only the failures it introduced. Handles software, prose, ' +
        'notes, and data alike. Changing Abjects inside this system belongs to an object-authoring ' +
        'agent; interactive web browsing and installed skill flows belong elsewhere.',
      config: {
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result', 'report'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `external-creator-${this.id}`,
        maxSteps: 50,
      },
    }));
  }

  private setupHandlers(): void {
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, taskId: explicitTaskId, goalId, description, data, approach, failureHistory } =
        msg.payload as {
          tupleId?: string; taskId?: string; goalId?: string; description: string;
          data?: Record<string, unknown>; approach?: string;
          failureHistory?: Array<{ agent: string; error: string }>;
        };

      const taskId = explicitTaskId ?? tupleId ?? `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return this.runLoop({ taskId, taskText: description, goalId, data, tupleId, approach, failureHistory });
    });

    this.on('runTask', async (msg: AbjectMessage) => {
      const { task, project } = msg.payload as { task: string; project?: string };
      const taskId = `ext-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return this.runLoop({
        taskId,
        taskText: task,
        data: project ? { project } : undefined,
      });
    });

    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      this.pendingTickets.get(payload.ticketId)?.resolve(payload);
    });

    this.on('progress', (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      // Progress arrives untagged, so it cannot be attributed to one task by
      // inspection. With several running, every live goal is genuinely being
      // worked on and each needs its timer reset, so all of them hear about it
      // — but the message itself belongs to whichever task emitted it, so it
      // is only quoted when there is no ambiguity about whose it is.
      if (this.goalManagerId) {
        const payload = msg.payload as { phase?: string; message?: string } | undefined;
        const goals = new Set<string>();
        for (const e of this.taskExtras.values()) if (e.goalId) goals.add(e.goalId);
        if (goals.size === 0 && this._currentGoalId) goals.add(this._currentGoalId);
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
    this.on('agentObserve', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId } = msg.payload as { taskId: string };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId, action } = msg.payload as { taskId: string; action: AgentAction };
      // A verify can legitimately run for many minutes; without a heartbeat the
      // pending ticket would time out while real work is happening.
      const heartbeat = setInterval(() => this.resetPendingTicketTimeouts(), 30_000);
      try {
        return await this.handleAct(taskId, action);
      } finally {
        clearInterval(heartbeat);
      }
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { newPhase } = msg.payload as { newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { this.resetPendingTicketTimeouts(); });
    this.on('agentActionResult', async () => { this.resetPendingTicketTimeouts(); });
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
      mutationsSinceVerify: 0,
      checkpoints: [],
      audit: [],
      decisions: [],
    };
    this.taskExtras.set(args.taskId, extra);
    this._currentGoalId = args.goalId;

    try {
      extra.project = await this.pickProject(args.taskText, args.data);
      if (extra.project) {
        await this.setupIsolation(extra);
        await this.setDefaultCwd(extra);
        await this.captureBaseline(extra);
        await this.checkpoint(extra, 'task start');
      }

      const initialMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
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

      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId: args.taskId,
          task: args.taskText,
          systemPrompt: this.buildSystemPrompt(),
          taskPrompt: await this.buildTaskPrompt(extra),
          goalId: args.goalId,
          dispatchTupleId: args.tupleId,
          initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
          config: {
            maxSteps: 50,
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
      try { await this.teardownIsolation(extra); } catch { /* leave the worktree in place */ }
      // Permissions granted "for this task" end with the task. They also time
      // out on their own, but a task that finishes should not leave a standing
      // grant behind for the next one to inherit.
      try {
        const brokerId = await this.discoverDep('PermissionBroker');
        if (brokerId) this.send(request(this.id, brokerId, 'clearSessionGrants', {}));
      } catch { /* best effort */ }
      this.taskExtras.delete(args.taskId);
      if (this._currentGoalId === args.goalId) this._currentGoalId = undefined;
    }
  }

  /**
   * Turn the loop's claim into an honest result.
   *
   * The gate runs here because the agent runtime finishes a task the instant a
   * terminal action is parsed — there is no point between "the model said done"
   * and "the task is done" for this object to stand in. So it stands after:
   * a claim that does not survive the gate is downgraded to a failure carrying
   * the precise reason, which is what the caller and the user actually need.
   */
  private async finalize(
    extra: TaskExtra,
    loop: { success: boolean; result?: unknown; error?: string },
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const gate = this.gateVerdict(extra);
    const worktreeNote = await this.teardownIsolation(extra);
    extra.worktree = undefined; // teardown is idempotent; do not repeat it in finally

    const reportText = typeof loop.result === 'string'
      ? loop.result
      : loop.result !== undefined ? JSON.stringify(loop.result) : (loop.error ?? '');

    const evidence = [
      gate.note,
      extra.lastVerify ? this.renderVerdict(extra.lastVerify)
        : extra.lastCheck ? this.renderVerdict(extra.lastCheck) : '',
      extra.checkpoints.length > 0
        ? `Checkpoints: ${extra.checkpoints.map(c => c.ref.slice(0, 10)).join(', ')} (restore with \`git stash apply <ref>\`)`
        : '',
      worktreeNote ?? '',
    ].filter(Boolean).join('\n');

    await this.writeSessionSummary(extra, reportText, gate);

    if (!loop.success) {
      return { success: false, error: `${loop.error ?? 'task failed'}\n\n${evidence}` };
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
        lines.push(this.baselineSummary(extra));

        const status = extra.project.vcs === 'git' ? await this.gitStatusLine(extra) : undefined;
        if (status) lines.push(status);

        const prior = await this.readGoalData<{ summary?: string }>(extra, SESSION_KEY);
        if (prior?.summary) {
          lines.push(`\nWhere the previous task in this goal left off:\n${prior.summary.slice(0, 4000)}`);
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
      lines.push(extra.lastResult);
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
        : `Working tree already has ${n} uncommitted change(s) — they are not yours; leave them alone.`;
    } catch {
      return undefined;
    }
  }

  // ─── Act ────────────────────────────────────────────────────────

  private static readonly ACTIONS = [
    'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls',
    'verify', 'set_project', 'call', 'reply', 'ask_user', 'done', 'fail',
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
      return { success: false, error: message };
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

Emit ONE JSON action per turn in a \`\`\`json code block, and nothing else. Independent actions may be batched as several blocks in one response; anything depending on an earlier result belongs in a later turn. Emit done, fail, and ask_user alone.

# Actions

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
4. **You are judged against a baseline.** Failures that existed before you started are not yours and never block you. Failures you introduce do.
5. **done has to be earned.** A claim of done with unverified changes is rejected and handed back. Run verify first.
6. **Say what you did not verify.** When a project declares no commands, there is nothing to run — report exactly what you changed and that it was not verified. Never let silence imply a pass.
7. **Keep oldText small.** Just enough context to be unique, no padding.

Report in your done result: what changed, which command proved it, and anything you could not check.`;
  }

  /**
   * Per-task context: the project's own instruction files, which is where
   * project knowledge belongs. Untrusted projects contribute nothing here —
   * an instruction file is text written by whoever wrote the repository, and
   * injecting it is exactly as consequential as running its code.
   */
  private async buildTaskPrompt(extra: TaskExtra): Promise<string | undefined> {
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

  private resetPendingTicketTimeouts(): void {
    for (const [ticketId, entry] of this.pendingTickets) {
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
