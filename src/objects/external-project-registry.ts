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
  /** Default isolation for tasks working here. */
  isolation: IsolationMode;
  createdAt: number;
  updatedAt: number;
}

/** Paths no agent writes, whatever the project says. */
export const ALWAYS_PROTECTED = ['.git/', '.env', 'node_modules/', '.ssh/'];

export const EXTERNAL_PROJECT_REGISTRY_ID = 'abjects:external-project-registry' as AbjectId;

export class ExternalProjectRegistry extends Abject {
  private storageId?: AbjectId;
  private hostFsId?: AbjectId;
  private projects = new Map<string, ExternalProject>();

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
                { name: 'trusted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Trust immediately (default true when a user adds it)', optional: true },
                { name: 'vcs', type: { kind: 'primitive', primitive: 'string' }, description: "'git' or 'none'. Detected from the directory when omitted.", optional: true },
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
          ],
          events: [
            { name: 'projectsChanged', description: 'The set of registered projects changed', payload: { kind: 'object' } },
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
        bits.push(`  vcs: ${p.vcs}, isolation: ${p.isolation}, trusted: ${p.trusted}`);
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

### Answering questions
- "which project is X?" → resolveProject accepts a handle or any path inside one.
- "how do I build X?" → the project's checkCommand / verifyCommand above, verbatim.
- "can I use X's conventions?" → only when trusted is true.`;
  }

  private setupHandlers(): void {
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
      return this.addProject({ ...(raw as Partial<ExternalProject>), name, root });
    });

    this.on('updateProject', async (msg: AbjectMessage) => {
      const { name, changes } = msg.payload as { name: string; changes: Partial<ExternalProject> };
      requireNonEmpty(name, 'name');
      const existing = this.projects.get(name);
      if (!existing) return { success: false, error: `No external project named "${name}"` };

      // name and createdAt are identity, not settings.
      const { name: _n, createdAt: _c, ...allowed } = changes as Record<string, unknown>;
      const updated: ExternalProject = { ...existing, ...(allowed as Partial<ExternalProject>), updatedAt: Date.now() };
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

    this.on('listProjects', async () => this.list());

    this.on('getProject', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.projects.get(name) ?? null;
    });

    this.on('resolveProject', async (msg: AbjectMessage) => {
      const { nameOrPath } = msg.payload as { nameOrPath: string };
      return this.resolve(nameOrPath);
    });

    this.on('setTrusted', async (msg: AbjectMessage) => {
      const { name, trusted } = msg.payload as { name: string; trusted: boolean };
      const p = this.projects.get(name);
      if (!p) return { success: false, error: `No external project named "${name}"` };
      p.trusted = trusted !== false;
      p.updatedAt = Date.now();
      await this.persist();
      this.changed('projectsChanged', { projects: this.list() });
      log.info(`${name} is now ${p.trusted ? 'trusted' : 'untrusted'}`);
      return { success: true };
    });

    this.on('protectedPathsFor', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      const p = this.projects.get(name);
      return [...ALWAYS_PROTECTED, ...(p?.protectedPaths ?? [])];
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Core
  // ═══════════════════════════════════════════════════════════════════

  private async addProject(
    input: Partial<ExternalProject> & { name: string; root: string },
  ): Promise<{ success: boolean; project?: ExternalProject; error?: string }> {
    requireNonEmpty(input.name, 'name');
    requireNonEmpty(input.root, 'root');
    precondition(!input.name.includes('/'), 'project name must not contain a slash');

    const root = this.resolveRoot(input.root);
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
      // default is trusted; a caller adding one on an agent's behalf passes
      // false and leaves the decision to the user.
      trusted: input.trusted !== false,
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
   * A handle, or any path inside a project. Path matching prefers the deepest
   * root, so a project nested inside another resolves to the inner one.
   */
  private resolve(nameOrPath: string): ExternalProject | null {
    if (!nameOrPath) return null;
    const direct = this.projects.get(nameOrPath);
    if (direct) return direct;

    const candidate = this.resolveRoot(nameOrPath);
    let best: ExternalProject | null = null;
    for (const p of this.projects.values()) {
      const rel = path.relative(p.root, candidate);
      const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (inside && (!best || p.root.length > best.root.length)) best = p;
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
        // Tolerate records written before a field existed.
        this.projects.set(p.name, { ...p, isolation: p.isolation ?? 'none', vcs: p.vcs ?? 'none' });
      }
      if (this.projects.size > 0) log.info(`loaded ${this.projects.size} external project(s)`);
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
    }
  }
}
