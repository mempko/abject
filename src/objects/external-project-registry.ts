/**
 * ExternalProjectRegistry -- the names of work areas that live on disk.
 *
 * The system has two kinds of project and only ever had a name for one of
 * them. A **workspace** is your project inside Abject: a scope holding objects,
 * with its own Registry, KnowledgeBase, and privacy boundary. An **external
 * project** is your project outside Abject: a directory on the host holding
 * files. Source, prose, notes, data, design assets — nothing here assumes the
 * files are code.
 *
 * What this object stores about a project is deliberately thin: a name, a root,
 * a description, and optional commands the project declares about itself. It
 * runs none of them and interprets none of them; ExternalCreator does that. A
 * TypeScript service declares a typecheck and a test run; a manuscript may
 * declare only a prose linter; a folder of notes declares nothing and is still
 * a first-class project.
 *
 * Registering a project is also the moment the host capabilities learn about
 * it: the root is added to HostFileSystem's allowed paths, so the user approves
 * a directory once instead of once per file.
 *
 * Trust is separate from registration. An untrusted project's CLAUDE.md /
 * AGENTS.md are NOT injected into any prompt and its own scripts are not run,
 * because both are text and code written by whoever wrote the repo. Trust is a
 * deliberate act by the user, recorded here.
 */

import { describeMessages, protocolText, protocolNumber, protocolObject } from '../core/protocol-description.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, requireNonEmpty, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ExternalProjectRegistry');

const EXTERNAL_PROJECT_REGISTRY_INTERFACE: InterfaceId = 'abjects:external-projects';
const STORAGE_KEY = 'external-projects:registry';

/** How a task's file changes are kept apart from the user's working tree. */
export type IsolationMode = 'none' | 'worktree';

/**
 * How much work in a project may proceed without asking the user.
 *
 * This is what the project *asks for*. What it gets is capped by the access
 * mode of the workspace the calling object lives in, which PermissionBroker
 * applies: a public workspace is reachable by any peer, so nothing in it runs
 * a host command unseen however trusted the directory is.
 */
export type AutonomyLevel = 'ask' | 'read' | 'edit' | 'full';

export const AUTONOMY_LEVELS: AutonomyLevel[] = ['ask', 'read', 'edit', 'full'];

/** Ascending, so two levels can be compared and the smaller one taken. */
export function autonomyRank(level: AutonomyLevel): number {
  return Math.max(0, AUTONOMY_LEVELS.indexOf(level));
}

export function minAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return autonomyRank(a) <= autonomyRank(b) ? a : b;
}

/**
 * Objects whose word is taken for a change to trust or autonomy.
 *
 * Everything else may register a project, but registers it untrusted and at
 * `ask`.
 *
 * Matched on the caller's **typeId**, not its registered name. A name is only
 * unique while its holder exists, and a workspace that has not spawned its UI
 * objects leaves those names free for anything to claim; a typeId is stamped by
 * the Factory at spawn and puts user objects in their own `user/` namespace, so
 * it cannot be claimed at all.
 */
const TRUST_AUTHORITIES = ['ExternalProjectBrowser', 'GlobalSettings', 'PermissionBroker'];

export interface ExternalProject {
  /** Short handle used everywhere else ("abjects", "novel"). */
  name: string;
  /** Absolute path to the project root. */
  root: string;
  /** What the project is, in the user's words. */
  description: string;
  /**
   * Fast check, run after every closed edit set. Cheap enough to run often:
   * `pnpm tsc --noEmit`, `vale docs/`, a link checker. Optional.
   */
  checkCommand?: string;
  /**
   * Authoritative verification, run at the gate before a task reports done:
   * build plus tests, a full render, whatever "it still works" means here.
   * Optional.
   */
  verifyCommand?: string;
  /** Formatter, run on request rather than automatically. Optional. */
  formatCommand?: string;
  /**
   * Run once after a worktree is created, to make it usable
   * (`pnpm install --frozen-lockfile`). Only consulted in worktree isolation.
   */
  setupCommand?: string;
  /**
   * Directories symlinked from the main checkout into a new worktree instead
   * of being rebuilt (`node_modules`, `.venv`). Cheaper than setupCommand and
   * correct more often than it sounds, though not for every toolchain.
   */
  sharedPaths?: string[];
  /** Version control in use. Isolation and checkpoints need 'git'. */
  vcs: 'git' | 'none';
  /** Relative paths never written by an agent, on top of the built-in set. */
  protectedPaths?: string[];
  /** Whether this project's instruction files and scripts may be used. */
  trusted: boolean;
  /**
   * How much may happen here without a prompt. Only ever raised by the user;
   * see AutonomyLevel. Requires `trusted`, since untrusted forces `ask`.
   */
  autonomy: AutonomyLevel;
  /** Default isolation for tasks working here. */
  isolation: IsolationMode;
  createdAt: number;
  updatedAt: number;
  /**
   * Set on listed projects whose root is not on disk right now. Computed at
   * list time, never persisted: the record is kept so the user can fix or
   * remove it, but no task starts against it.
   */
  rootMissing?: boolean;
}

/** Paths no agent writes, whatever the project says. */
export const ALWAYS_PROTECTED = ['.git/', '.env', 'node_modules/', '.ssh/'];

function isAutonomy(v: unknown): v is AutonomyLevel {
  return typeof v === 'string' && (AUTONOMY_LEVELS as string[]).includes(v);
}

/** A task currently working in a project, as its siblings see it. */
export interface ActiveTask {
  taskId: string;
  goalId?: string;
  description?: string;
  /** Project-relative paths the task has written so far. */
  files: string[];
  startedAt: number;
  lastSeenAt: number;
}

export const EXTERNAL_PROJECT_REGISTRY_ID = 'abjects:external-project-registry' as AbjectId;

export class ExternalProjectRegistry extends Abject {
  private storageId?: AbjectId;
  private hostFsId?: AbjectId;
  private projects = new Map<string, ExternalProject>();
  /**
   * Who is working where right now. In memory only: a task that outlives the
   * process is not working any more. Several tasks may run in one project at
   * once (a scrum round stages them that way); this is what lets each of them
   * see the others, and it is the whole of the coordination — no lock.
   */
  private activeTasks = new Map<string, Map<string, ActiveTask>>();
  /** A task that has said nothing for this long is presumed gone. */
  private static readonly ACTIVE_TASK_TTL_MS = 2 * 60 * 60_000;

  constructor() {
    super({
      manifest: {
        name: 'ExternalProjectRegistry',
        description:
          'Registry of external projects: named directories on the host holding a body of work. ' +
          'An external project is your project OUTSIDE Abject (files on disk); a workspace is your ' +
          'project INSIDE Abject (objects). Stores each project\'s root, description, optional check ' +
          'and verify commands, protected paths, isolation mode, and whether it is trusted. ' +
          'Projects are not assumed to be code.',
        version: '1.0.0',
        icon: '📁',
        interface: {
          id: EXTERNAL_PROJECT_REGISTRY_INTERFACE,
          name: 'ExternalProjectRegistry',
          description: 'Named on-disk work areas',
          methods: [
            {
              name: 'addProject',
              description: 'Register an external project. The root is granted to HostFileSystem.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Short handle' },
                { name: 'root', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute path to the project root (also accepted as "path")' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'What this project is', optional: true },
                { name: 'checkCommand', type: { kind: 'primitive', primitive: 'string' }, description: 'Fast check command', optional: true },
                { name: 'verifyCommand', type: { kind: 'primitive', primitive: 'string' }, description: 'Authoritative verify command', optional: true },
                { name: 'formatCommand', type: { kind: 'primitive', primitive: 'string' }, description: 'Formatter command', optional: true },
                { name: 'setupCommand', type: { kind: 'primitive', primitive: 'string' }, description: 'Run once after a worktree is created', optional: true },
                { name: 'sharedPaths', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Dirs symlinked into a worktree', optional: true },
                { name: 'protectedPaths', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Relative paths agents must not write', optional: true },
                { name: 'isolation', type: { kind: 'primitive', primitive: 'string' }, description: "'none' (default) or 'worktree'", optional: true },
                { name: 'trusted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Trust immediately. Honored only for the user acting through the UI; any other caller registers an untrusted project.', optional: true },
                { name: 'vcs', type: { kind: 'primitive', primitive: 'string' }, description: "'git' or 'none'. Detected from the directory when omitted.", optional: true },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                project: { kind: 'object' },
              }},
            },
            {
              name: 'setAutonomy',
              description:
                'Set how much work in this project may proceed without prompting the user: ' +
                '"ask" (prompt for every command), "read" (read-only commands inside the project), ' +
                '"edit" (also writes inside the project), or "full". Requires the project to be trusted, ' +
                'and can only be set by the user through the UI. The workspace access mode caps this: ' +
                'a public workspace holds every project at "ask".',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'autonomy', type: { kind: 'primitive', primitive: 'string' }, description: 'ask | read | edit | full' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                project: { kind: 'object' },
              }},
            },
            {
              name: 'updateProject',
              description: 'Change fields on a registered project',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'changes', type: { kind: 'object' }, description: 'Fields to change' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'removeProject',
              description: 'Forget a project. Nothing on disk is touched.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listProjects',
              description: 'Every registered external project',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object' } },
            },
            {
              name: 'getProject',
              description: 'One project by name',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
              ],
              returns: { kind: 'object' },
            },
            {
              name: 'resolveProject',
              description:
                'Find the project a name or path belongs to. A path resolves to the project whose ' +
                'root contains it, so a file path is enough to identify the project.',
              parameters: [
                { name: 'nameOrPath', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle or any path inside it' },
              ],
              returns: { kind: 'object' },
            },
            {
              name: 'setTrusted',
              description:
                'Trust or untrust a project. A trusted project may have its CLAUDE.md / AGENTS.md ' +
                'injected into agent prompts and its declared commands run.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'trusted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Trust state' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'protectedPathsFor',
              description: 'The full protected-path set for a project, built-ins included',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
              ],
              returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
            },
            {
              name: 'taskStarted',
              description: 'An agent began a task in a project. Several tasks may work in one project at once; this is how they learn of each other.',
              parameters: [
                { name: 'project', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The task' },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal the task belongs to', optional: true },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'What the task is doing', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'filesTouched',
              description: 'A running task has written these project-relative paths so far',
              parameters: [
                { name: 'project', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The task' },
                { name: 'files', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Project-relative paths' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'taskFinished',
              description: 'A task in a project ended (any outcome)',
              parameters: [
                { name: 'project', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The task' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'activeTasks',
              description: 'Tasks currently working in a project: [{ taskId, goalId, description, files, startedAt }]',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Project handle' },
              ],
              returns: { kind: 'array', elementType: { kind: 'object' } },
            },
          ],
          events: [
            { name: 'projectsChanged', description: 'The set of registered projects changed', payload: { kind: 'object' } },
            { name: 'activeTasksChanged', description: 'The set of tasks working in a project changed', payload: { kind: 'object' } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'projects'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.hostFsId = await this.discoverDep('HostFileSystem') ?? undefined;
    await this.loadFromStorage();
    // Grant every remembered root up front, so a restored project does not
    // prompt again on first use.
    for (const p of this.projects.values()) await this.grantRoot(p.root);
    this.checkInvariants();
  }

  protected override askBusyStatus(): string | undefined {
    return undefined;
  }

  protected override askPrompt(question: string): string {
    const list = [...this.projects.values()]
      .map(p => {
        const bits = [`- **${p.name}** — ${p.root}`];
        if (p.description) bits.push(`  ${p.description}`);
        bits.push(`  vcs: ${p.vcs}, isolation: ${p.isolation}, trusted: ${p.trusted}, autonomy: ${p.autonomy}`);
        if (p.checkCommand) bits.push(`  check: \`${p.checkCommand}\``);
        if (p.verifyCommand) bits.push(`  verify: \`${p.verifyCommand}\``);
        if (!p.checkCommand && !p.verifyCommand) bits.push(`  (no commands declared — nothing to run automatically)`);
        return bits.join('\n');
      })
      .join('\n');

    return super.askPrompt(question) + `\n\n## ExternalProjectRegistry

I hold the **external projects**: named directories on the host holding a body of
work. That is the counterpart to a workspace, which is the project *inside* this
system. An external project is not assumed to be code — a manuscript, a notes
folder, or a data directory is a project on the same terms as a service.

For each project I store a root, a description, optional commands the project
declares about itself (check, verify, format, setup), protected paths, an
isolation mode, and whether it is trusted. I run none of those commands.

### Registered projects
${list || '(none registered yet)'}

### Registering a project
\`addProject({ name, root, description?, checkCommand?, verifyCommand?, protectedPaths?, isolation?, trusted? })\`
\`root\` is the absolute path; \`path\` is accepted as an alias for it. Whether the
directory is a git checkout is detected here, so \`vcs\` rarely needs passing.

### Who is working where
Several tasks may work in one project at once. \`activeTasks({ name })\` lists them
with the files each has written so far; agents report through \`taskStarted\`,
\`filesTouched\`, and \`taskFinished\`. This is awareness, not a lock.

### Answering questions
- "which project is X?" → resolveProject accepts a handle or any path inside one.
- "how do I build X?" → the project's checkCommand / verifyCommand above, verbatim.
- "can I use X's conventions?" → only when trusted is true.`;
  }

  private projectSessions = new Map<string, { owner: AbjectId; project: string; root: string; revision?: string; files?: Record<string, string> }>();

  private setupHandlers(): void {
    describeMessages(this.manifest, [
      { name: "openSession", description: "Open a task-owned project session; returns commands to check and verify.", parameters: { "project": protocolText, "taskId": protocolText, "root?": protocolText } },
      { name: "captureRevision", description: "Snapshot project inputs via HostFileSystem, respecting ignore rules plus explicit edits. Returns {revision, complete, changed, excludes, issues, scope, project, root}.", parameters: { "taskId": protocolText, "includePaths?": { kind: 'array', elementType: protocolText } } },
    ]);
    this.on('openSession', async (msg: AbjectMessage) => {
      const { project, taskId, root } = msg.payload as { project: string; taskId: string; root?: string };
      const configured = this.projects.get(project);
      if (!configured || !taskId) throw new Error('Registered project and taskId required');
      const previous = this.projectSessions.get(taskId);
      if (previous && previous.owner !== msg.routing.from) throw new Error('Project session belongs to another caller');
      // The caller may use a worktree, but all file access still passes through HostFileSystem's path authority.
      this.projectSessions.set(taskId, { owner: msg.routing.from, project, root: root ?? configured.root });
      return { taskId, project, root: root ?? configured.root, commands: { check: configured.checkCommand, verify: configured.verifyCommand } };
    });
    this.on('captureRevision', async (msg: AbjectMessage) => {
      const { taskId, includePaths = [] } = msg.payload as { taskId: string; includePaths?: string[] };
      const session = this.projectSessions.get(taskId);
      if (!session || session.owner !== msg.routing.from) throw new Error('Project session unavailable or owned by another caller');
      const fsId = await this.discoverDep('HostFileSystem');
      if (!fsId) throw new Error('HostFileSystem unavailable');
      const current = await this.request<{ revision: string; files: Record<string, string>; complete: boolean; excludes?: string[]; issues?: string[]; scope?: string }>(request(this.id, fsId, 'snapshotTree', { root: session.root, scope: 'project', includePaths }), 120000);
      const changed = session.files ? [...new Set([...Object.keys(session.files), ...Object.keys(current.files)])].filter(p => session.files![p] !== current.files[p]) : [];
      session.revision = current.revision; session.files = current.files;
      return { revision: current.revision, complete: current.complete, changed, excludes: current.excludes, issues: current.issues, scope: current.scope, project: session.project, root: session.root };
    });

    this.on('addProject', async (msg: AbjectMessage) => {
      const raw = msg.payload as Record<string, unknown>;
      // `path` is what a caller reaches for first, so accept it as an alias for
      // `root` rather than making them guess. Anything else missing gets an
      // error that names the field and shows what arrived, because the
      // alternative — a TypeError from deep inside — costs the caller several
      // turns of guessing at the shape.
      const root = (raw.root ?? raw.path) as string | undefined;
      const name = raw.name as string | undefined;
      if (typeof name !== 'string' || name.trim() === '') {
        return { success: false, error: `addProject requires "name" (a short handle). Received: ${JSON.stringify(raw).slice(0, 200)}` };
      }
      if (typeof root !== 'string' || root.trim() === '') {
        return { success: false, error: `addProject requires "root" (absolute path to the directory; "path" is accepted too). Received: ${JSON.stringify(raw).slice(0, 200)}` };
      }
      const byAuthority = await this.isTrustAuthority(msg.routing.from);
      return this.addProject({ ...(raw as Partial<ExternalProject>), name, root }, byAuthority);
    });

    this.on('updateProject', async (msg: AbjectMessage) => {
      const { name, changes } = msg.payload as { name: string; changes: Partial<ExternalProject> };
      requireNonEmpty(name, 'name');
      const existing = this.projects.get(name);
      if (!existing) return { success: false, error: `No external project named "${name}"` };

      // name and createdAt are identity, not settings.
      const { name: _n, createdAt: _c, ...allowed } = changes as Record<string, unknown>;
      // Trust and autonomy do not ride in on a general-purpose update. Dropping
      // them silently rather than failing the call keeps an agent's legitimate
      // edit (a check command, a description) working.
      if (!(await this.isTrustAuthority(msg.routing.from))) {
        delete (allowed as Record<string, unknown>).trusted;
        delete (allowed as Record<string, unknown>).autonomy;
      }
      const updated: ExternalProject = { ...existing, ...(allowed as Partial<ExternalProject>), updatedAt: Date.now() };
      // Losing trust drops the level with it: an untrusted project is `ask`.
      if (!updated.trusted) updated.autonomy = 'ask';
      if (updated.root !== existing.root) {
        updated.root = this.resolveRoot(updated.root);
        await this.grantRoot(updated.root);
      }
      this.projects.set(name, updated);
      await this.persist();
      this.changed('projectsChanged', { projects: this.list() });
      this.checkInvariants();
      return { success: true, project: updated };
    });

    this.on('removeProject', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      requireNonEmpty(name, 'name');
      const had = this.projects.delete(name);
      if (had) {
        await this.persist();
        this.changed('projectsChanged', { projects: this.list() });
      }
      this.checkInvariants();
      return { success: had };
    });

    this.on('listProjects', async () => this.listAnnotated());

    this.on('getProject', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.projects.get(name) ?? null;
    });

    this.on('resolveProject', async (msg: AbjectMessage) => {
      const { nameOrPath } = msg.payload as { nameOrPath: string };
      return await this.resolve(nameOrPath);
    });

    this.on('setTrusted', async (msg: AbjectMessage) => {
      if (!(await this.isTrustAuthority(msg.routing.from))) {
        return { success: false, error: 'Only the user can change whether a project is trusted' };
      }
      const { name, trusted } = msg.payload as { name: string; trusted: boolean };
      const p = this.projects.get(name);
      if (!p) return { success: false, error: `No external project named "${name}"` };
      p.trusted = trusted !== false;
      // Trust is the floor autonomy stands on.
      if (!p.trusted) p.autonomy = 'ask';
      p.updatedAt = Date.now();
      await this.persist();
      this.changed('projectsChanged', { projects: this.list() });
      log.info(`${name} is now ${p.trusted ? 'trusted' : 'untrusted'}`);
      return { success: true };
    });

    this.on('setAutonomy', async (msg: AbjectMessage) => {
      if (!(await this.isTrustAuthority(msg.routing.from))) {
        return { success: false, error: 'Only the user can change a project\'s autonomy level' };
      }
      const { name, autonomy } = msg.payload as { name: string; autonomy: string };
      const p = this.projects.get(name);
      if (!p) return { success: false, error: `No external project named "${name}"` };
      if (!isAutonomy(autonomy)) {
        return { success: false, error: `autonomy must be one of ${AUTONOMY_LEVELS.join(', ')}` };
      }
      if (autonomy !== 'ask' && !p.trusted) {
        return { success: false, error: `"${name}" is not trusted, so it stays at "ask"` };
      }
      p.autonomy = autonomy;
      p.updatedAt = Date.now();
      await this.persist();
      this.changed('projectsChanged', { projects: this.list() });
      log.info(`${name} autonomy is now ${autonomy}`);
      return { success: true, project: p };
    });

    this.on('protectedPathsFor', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const p = this.projects.get(name);
      return [...ALWAYS_PROTECTED, ...(p?.protectedPaths ?? [])];
    });

    // ── Who is working where ──
    this.on('taskStarted', async (msg: AbjectMessage) => {
      const { project, taskId, goalId, description } = msg.payload as {
        project: string; taskId: string; goalId?: string; description?: string;
      };
      requireNonEmpty(project, 'project');
      requireNonEmpty(taskId, 'taskId');
      const now = Date.now();
      this.tasksFor(project).set(taskId, {
        taskId, goalId, description: description?.slice(0, 200), files: [], startedAt: now, lastSeenAt: now,
      });
      this.changed('activeTasksChanged', { project, tasks: this.listActive(project) });
      return { success: true };
    });

    this.on('filesTouched', async (msg: AbjectMessage) => {
      const { project, taskId, files } = msg.payload as { project: string; taskId: string; files: string[] };
      requireNonEmpty(project, 'project');
      requireNonEmpty(taskId, 'taskId');
      const t = this.tasksFor(project).get(taskId);
      if (!t) return { success: false, error: 'unknown task' };
      const seen = new Set(t.files);
      for (const f of Array.isArray(files) ? files : []) {
        if (typeof f === 'string' && f && !seen.has(f)) { seen.add(f); t.files.push(f); }
      }
      t.lastSeenAt = Date.now();
      this.changed('activeTasksChanged', { project, tasks: this.listActive(project) });
      return { success: true };
    });

    this.on('taskFinished', async (msg: AbjectMessage) => {
      const { project, taskId } = msg.payload as { project: string; taskId: string };
      requireNonEmpty(project, 'project');
      requireNonEmpty(taskId, 'taskId');
      const had = this.tasksFor(project).delete(taskId);
      if (had) this.changed('activeTasksChanged', { project, tasks: this.listActive(project) });
      return { success: had };
    });

    this.on('activeTasks', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.listActive(name);
    });
  }

  private tasksFor(project: string): Map<string, ActiveTask> {
    let m = this.activeTasks.get(project);
    if (!m) { m = new Map(); this.activeTasks.set(project, m); }
    return m;
  }

  /** Live tasks in a project, oldest first, with silent ones expired. */
  private listActive(project: string): ActiveTask[] {
    const m = this.activeTasks.get(project);
    if (!m) return [];
    const cutoff = Date.now() - ExternalProjectRegistry.ACTIVE_TASK_TTL_MS;
    for (const [id, t] of m) if (t.lastSeenAt < cutoff) m.delete(id);
    return [...m.values()].sort((a, b) => a.startedAt - b.startedAt).map(t => ({ ...t, files: [...t.files] }));
  }

  /**
   * Whether a caller may speak for the user about trust and autonomy.
   *
   * An unresolvable caller is not an authority: not knowing who is asking is
   * not the same as knowing it is the user.
   */
  private async isTrustAuthority(callerId: AbjectId): Promise<boolean> {
    const identity = await this.resolveCallerIdentity(callerId);
    if (!identity?.typeId) return false;
    const segments = String(identity.typeId).split('/');
    const last = segments[segments.length - 1];
    // `{peer}/{workspace}/{Name}` is a built-in. Anything longer is namespaced
    // (`.../user/Name`) and is not one, whatever it calls itself.
    return segments.length === 3 && TRUST_AUTHORITIES.includes(last);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Core
  // ═══════════════════════════════════════════════════════════════════

  private async addProject(
    input: Partial<ExternalProject> & { name: string; root: string },
    byAuthority = false,
  ): Promise<{ success: boolean; project?: ExternalProject; error?: string }> {
    requireNonEmpty(input.name, 'name');
    requireNonEmpty(input.root, 'root');
    precondition(!input.name.includes('/'), 'project name must not contain a slash');

    const root = this.resolveRoot(input.root);
    // A temp directory is a scratch area that the OS or the process that made
    // it will clear, so a project registered there dangles the moment its
    // owner is gone and then turns every task that lands on it into a setup
    // failure. Projects live where the user keeps their work.
    const tmp = path.resolve(os.tmpdir());
    const relTmp = path.relative(tmp, root);
    if (relTmp === '' || (!relTmp.startsWith('..') && !path.isAbsolute(relTmp))) {
      return { success: false, error: `"${root}" is inside the temp directory (${tmp}); register a directory the user keeps` };
    }
    try {
      await fs.access(root);
    } catch {
      return { success: false, error: `"${root}" does not exist on this machine` };
    }
    const isolation: IsolationMode = input.isolation === 'worktree' ? 'worktree' : 'none';
    // Look for the checkout rather than asking. A caller that forgets to say
    // `vcs: 'git'` would silently lose checkpoints and worktree isolation on a
    // real repository, and the answer is sitting right there on disk.
    const vcs = input.vcs ?? (await this.detectVcs(root));

    const project: ExternalProject = {
      name: input.name,
      root,
      description: input.description ?? '',
      checkCommand: input.checkCommand,
      verifyCommand: input.verifyCommand,
      formatCommand: input.formatCommand,
      setupCommand: input.setupCommand,
      sharedPaths: input.sharedPaths,
      vcs,
      protectedPaths: input.protectedPaths,
      // A user adding a project through the UI chose it deliberately, so the
      // default is trusted. A caller that is not an authority gets an untrusted
      // project whatever it asked for: registering a directory is not the same
      // act as vouching for it, and an agent that could do both could grant
      // itself the run of the disk.
      trusted: byAuthority ? input.trusted !== false : false,
      autonomy: byAuthority
        ? (isAutonomy(input.autonomy) ? input.autonomy : 'read')
        : 'ask',
      isolation,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.projects.set(project.name, project);
    await this.grantRoot(root);
    await this.persist();
    this.changed('projectsChanged', { projects: this.list() });
    this.checkInvariants();
    log.info(`registered ${project.name} at ${root} (vcs=${project.vcs}, isolation=${isolation})`);
    return { success: true, project };
  }

  private list(): ExternalProject[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Whether the project's root is currently on disk. A root can go missing
   * without the record being wrong: an unmounted drive, a checkout the user
   * moved. The record stays so the user can fix or remove it; what changes
   * is that no task is started against it.
   */
  private async rootPresent(p: ExternalProject): Promise<boolean> {
    try {
      await fs.access(p.root);
      return true;
    } catch {
      return false;
    }
  }

  /** Every project, each annotated with whether its root is on disk right now. */
  private async listAnnotated(): Promise<ExternalProject[]> {
    return Promise.all(this.list().map(async p => ({ ...p, rootMissing: !(await this.rootPresent(p)) })));
  }

  /**
   * A handle, or any path inside a project, resolved to a project whose root
   * is on disk. Path matching prefers the deepest root, so a project nested
   * inside another resolves to the inner one.
   */
  private async resolve(nameOrPath: string): Promise<ExternalProject | null> {
    if (!nameOrPath) return null;
    const direct = this.projects.get(nameOrPath);
    if (direct) return (await this.rootPresent(direct)) ? direct : null;

    const candidate = this.resolveRoot(nameOrPath);
    let best: ExternalProject | null = null;
    for (const p of this.projects.values()) {
      const rel = path.relative(p.root, candidate);
      const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (inside && (!best || p.root.length > best.root.length)) best = p;
    }
    if (best && !(await this.rootPresent(best))) {
      log.warn(`project ${best.name} matches ${nameOrPath} but its root ${best.root} is missing`);
      return null;
    }
    return best;
  }

  /** Whether the root is a git checkout. A worktree's `.git` is a file, not a directory. */
  private async detectVcs(root: string): Promise<'git' | 'none'> {
    try {
      await fs.access(path.join(root, '.git'));
      return 'git';
    } catch {
      return 'none';
    }
  }

  private resolveRoot(p: string): string {
    if (p.startsWith('~/') || p === '~') return path.resolve(path.join(os.homedir(), p.slice(1)));
    return path.resolve(p);
  }

  /**
   * Widen HostFileSystem's allow list to include this root. Without it every
   * first touch of a file in a freshly registered project would prompt.
   */
  private async grantRoot(root: string): Promise<void> {
    if (!this.hostFsId) {
      this.hostFsId = await this.discoverDep('HostFileSystem') ?? undefined;
      if (!this.hostFsId) return;
    }
    try {
      await this.request(request(this.id, this.hostFsId, 'grantPath', { path: root }), 10000);
    } catch (err) {
      // A capability that refuses the grant is not fatal: the user is simply
      // prompted per path the first time, which is the old behavior.
      log.warn(`could not pre-grant ${root}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════

  private async persist(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY,
        value: { projects: this.list() },
      }));
    } catch (err) {
      log.warn(`failed to persist projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.storageId) return;
    try {
      const data = await this.request<{ projects: ExternalProject[] } | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY }),
      );
      for (const p of data?.projects ?? []) {
        // Tolerate records written before a field existed. A project saved
        // before autonomy existed was one the user had already trusted, so it
        // lands on the same default a freshly added project gets rather than
        // being demoted for having been registered early.
        this.projects.set(p.name, {
          ...p,
          isolation: p.isolation ?? 'none',
          vcs: p.vcs ?? 'none',
          autonomy: isAutonomy(p.autonomy) ? p.autonomy : (p.trusted ? 'read' : 'ask'),
        });
      }
      if (this.projects.size > 0) log.info(`loaded ${this.projects.size} external project(s)`);
      for (const p of this.projects.values()) {
        if (!(await this.rootPresent(p))) log.warn(`project ${p.name} root ${p.root} is missing; it stays registered but no task will start there`);
      }
    } catch (err) {
      log.warn(`failed to load projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [key, p] of this.projects) {
      invariant(key === p.name, 'project map key must equal the project name');
      invariant(path.isAbsolute(p.root), `project ${p.name} root must be absolute`);
      invariant(p.isolation === 'none' || p.isolation === 'worktree', `project ${p.name} has an unknown isolation mode`);
      invariant(p.isolation !== 'worktree' || p.vcs === 'git', `project ${p.name} cannot use worktree isolation without git`);
      invariant((AUTONOMY_LEVELS as string[]).includes(p.autonomy), `project ${p.name} has an unknown autonomy level`);
      invariant(p.trusted || p.autonomy === 'ask', `untrusted project ${p.name} must sit at autonomy "ask"`);
    }
    for (const [project, tasks] of this.activeTasks) {
      for (const [id, t] of tasks) {
        invariant(id === t.taskId, `active task map key must equal the task id (${project})`);
      }
    }
  }
}
