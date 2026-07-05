/**
 * Organism -- Symbiogenesis for Abjects.
 *
 * An Organism is a composite Abject with its own internal registry.
 * Like a biological cell, it has organelles (internal ScriptableAbjects)
 * hidden behind an interface (the membrane). External callers see one
 * object; internally, organelles discover each other through the
 * organism's registry and communicate via message passing.
 *
 * Organelles self-organize through registry-based discovery -- the same
 * pattern workspaces use.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { INTROSPECT_METHODS, INTROSPECT_EVENTS } from '../core/introspect.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { WorkspaceRegistry } from './workspace-registry.js';

// ── Spec types ──────────────────────────────────────────────────────

export interface OrganelleSpec {
  name: string;
  manifest: AbjectManifest;
  source: string;
}

export interface OrganismSpec {
  name: string;
  description: string;
  version?: string;
  interface: OrganelleSpec;
  organelles: OrganelleSpec[];
  tags?: string[];
}

// ── Constants ───────────────────────────────────────────────────────

export const ORGANISM_INTERFACE = 'abjects:organism' as InterfaceId;

/** Methods handled by Abject itself -- never delegate to the interface. */
const BUILTIN_METHODS = new Set([
  'describe', 'ask', 'getRegistry', 'ping',
  'addDependent', 'removeDependent', 'changed',
  'progress', 'getSource', 'updateSource', 'probe',
  'getOrganelleSource',
]);

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build the merged manifest for an Organism from its spec.
 * Used by Factory to register the organism in the registry from the main thread
 * when the organism itself is spawned in a worker.
 */
export function buildOrganismManifest(spec: OrganismSpec): AbjectManifest {
  const tags = [...(spec.tags ?? [])];
  if (!tags.includes('organism')) tags.push('organism');

  const ifaceManifest = spec.interface.manifest;
  const iface = {
    ...ifaceManifest.interface,
    id: ORGANISM_INTERFACE,
  };

  // Merge introspect methods/events (same as Abject constructor)
  const hasDescribe = iface.methods.some(m => m.name === 'describe');
  const methods = hasDescribe ? iface.methods : [...iface.methods, ...INTROSPECT_METHODS];
  const hasChildReady = (iface.events ?? []).some(e => e.name === 'childReady');
  const events = hasChildReady ? iface.events : [...(iface.events ?? []), ...INTROSPECT_EVENTS];

  return {
    name: spec.name,
    description: spec.description,
    version: spec.version ?? '1.0.0',
    interface: { ...iface, methods, events },
    requiredCapabilities: ifaceManifest.requiredCapabilities,
    tags,
  };
}

// ── Class ───────────────────────────────────────────────────────────

export class Organism extends Abject {
  private spec: OrganismSpec;
  private _organismSource: string;

  private internalRegistry?: WorkspaceRegistry;
  private internalRegistryId: AbjectId = '' as AbjectId;
  private interfaceAbject?: ScriptableAbject;
  private interfaceId: AbjectId = '' as AbjectId;
  private organelleIds: Map<string, AbjectId> = new Map();
  private childObjects: Map<string, Abject> = new Map();

  constructor(spec: OrganismSpec) {
    contractRequire(spec.name !== '', 'OrganismSpec name must not be empty');
    contractRequire(
      spec.interface !== undefined,
      'OrganismSpec must have an interface'
    );

    const tags = [...(spec.tags ?? [])];
    if (!tags.includes('organism')) {
      tags.push('organism');
    }

    // Build the organism's manifest from the interface organelle's manifest.
    // The organism presents the interface's methods as its own.
    const ifaceManifest = spec.interface.manifest;
    super({
      manifest: {
        name: spec.name,
        description: spec.description,
        version: spec.version ?? '1.0.0',
        interface: {
          ...ifaceManifest.interface,
          id: ORGANISM_INTERFACE,
        },
        requiredCapabilities: ifaceManifest.requiredCapabilities,
        tags,
      },
    });

    this.spec = spec;
    this._organismSource = JSON.stringify(spec);
    this.setupIntrospectionHandlers();
  }

  /**
   * Read-only introspection beyond the membrane: expose one organelle's spec
   * plus a live data snapshot so tooling (ObjectCreator's extract_organelle)
   * can deploy it as a standalone object. The organism itself is untouched.
   * Listed in BUILTIN_METHODS so interface delegation never shadows it.
   */
  private setupIntrospectionHandlers(): void {
    this.on('getOrganelleSource', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(
        typeof name === 'string' && name.length > 0,
        'getOrganelleSource requires a name'
      );

      const spec = name === '__interface__'
        ? this.spec.interface
        : this.spec.organelles.find((o) => o.name === name);
      if (!spec) {
        const names = this.spec.organelles.map((o) => o.name).join(', ');
        throw new Error(
          `No organelle named '${name}'. Organelles: ${names}. ` +
          `Pass '__interface__' for the membrane interface organelle.`
        );
      }

      // Live data snapshot when the organelle is running; empty otherwise.
      let data: Record<string, unknown> = {};
      const liveId = name === '__interface__'
        ? this.interfaceId
        : this.organelleIds.get(name);
      if (liveId) {
        try {
          data = await this.request<Record<string, unknown>>(
            request(this.id, liveId, 'getData', {}),
            10000
          );
        } catch {
          // Organelle busy or stopped; manifest + source still replicate.
        }
      }

      return { manifest: spec.manifest, source: spec.source, data };
    });
  }

  get organismSource(): string {
    return this._organismSource;
  }

  // ── Delegation setup ────────────────────────────────────────────

  /**
   * Register delegate handlers for each method in the interface manifest.
   * External calls to these methods are forwarded to the Interface organelle.
   */
  private setupDelegation(): void {
    for (const method of this.spec.interface.manifest.interface.methods) {
      if (BUILTIN_METHODS.has(method.name)) continue;

      this.on(method.name, (msg: AbjectMessage) => {
        return this.delegateToInterface(msg);
      });
    }
  }

  private async delegateToInterface(msg: AbjectMessage): Promise<unknown> {
    contractRequire(
      this.interfaceId !== ('' as AbjectId),
      'Interface organelle not initialized'
    );

    return this.request(
      request(
        this.id,
        this.interfaceId,
        msg.routing.method ?? '',
        msg.payload
      )
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    // Spawn all children directly on the bus to avoid deadlock with Factory.
    // (Factory is likely handling our own spawn when onInit runs.)

    // 1. Spawn internal WorkspaceRegistry
    const registry = new WorkspaceRegistry();
    await registry.init(this.bus, this.id);
    this.internalRegistry = registry;
    this.internalRegistryId = registry.id as AbjectId;
    this.childObjects.set('__registry__', registry);

    // Configure fallback: organism registry --> workspace registry
    const parentRegistryId = await this.resolveRegistryId();
    if (parentRegistryId) {
      registry.setFallback(parentRegistryId);
    }

    // Register the registry with itself so organelles can discover "Registry"
    this.bus.send(
      request(this.id, this.internalRegistryId, 'register', {
        objectId: this.internalRegistryId,
        manifest: {
          name: 'Registry',
          description: `Internal registry for organism '${this.spec.name}'`,
          version: '1.0.0',
          interface: {
            id: 'abjects:registry' as InterfaceId,
            name: 'Registry',
            description: 'Object registration and discovery',
            methods: [],
          },
          requiredCapabilities: [],
          tags: ['system', 'core'],
        },
      })
    );
    // Let the registration message be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 2. Spawn organelles
    for (const organelleSpec of this.spec.organelles) {
      const organelle = new ScriptableAbject(
        organelleSpec.manifest,
        organelleSpec.source,
        this.id
      );
      organelle.setRegistryHint(this.internalRegistryId);
      await organelle.init(this.bus, this.id);

      this.organelleIds.set(organelleSpec.name, organelle.id);
      this.childObjects.set(organelleSpec.name, organelle);

      // Register organelle with internal registry
      this.bus.send(
        request(this.id, this.internalRegistryId, 'register', {
          objectId: organelle.id,
          manifest: organelle.manifest,
          source: organelleSpec.source,
          owner: this.id,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 3. Spawn the Interface organelle
    const iface = new ScriptableAbject(
      this.spec.interface.manifest,
      this.spec.interface.source,
      this.id
    );
    iface.setRegistryHint(this.internalRegistryId);
    await iface.init(this.bus, this.id);

    this.interfaceAbject = iface;
    this.interfaceId = iface.id;
    this.childObjects.set('__interface__', iface);

    // Register interface with internal registry
    this.bus.send(
      request(this.id, this.internalRegistryId, 'register', {
        objectId: iface.id,
        manifest: iface.manifest,
        source: this.spec.interface.source,
        owner: this.id,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. Set up delegation from organism to interface
    this.setupDelegation();
  }

  protected override async onStop(): Promise<void> {
    // Stop all children directly -- they are not tracked by Factory.
    // Stop organelles + interface first, then the registry.
    for (const [name, child] of this.childObjects) {
      if (name === '__registry__') continue;
      try {
        await child.stop();
      } catch {
        // Child may already be stopped
      }
    }

    // Stop the internal registry last
    if (this.internalRegistry) {
      try {
        await this.internalRegistry.stop();
      } catch {
        // Registry may already be stopped
      }
    }

    this.organelleIds.clear();
    this.childObjects.clear();
    this.interfaceAbject = undefined;
    this.internalRegistry = undefined;
    this.interfaceId = '' as AbjectId;
    this.internalRegistryId = '' as AbjectId;
  }

  // ── Ask support ─────────────────────────────────────────────────

  protected override askPrompt(_question: string): string {
    const organelles = this.spec.organelles
      .map((o) => `  - ${o.name}: ${o.manifest.name} -- ${o.manifest.description}`)
      .join('\n');

    const iface = this.spec.interface;

    return (
      super.askPrompt(_question) +
      `\n\nOrganism: ${this.spec.name}` +
      `\nDescription: ${this.spec.description}` +
      `\n\nInterface (membrane): ${iface.name} -- ${iface.manifest.description}` +
      `\n\nOrganelles (internal components):\n${organelles}` +
      `\n\nOrganelles discover each other through the organism's internal registry.` +
      ` External callers only see the interface methods. The internal registry` +
      ` chains to the workspace registry, so organelles can also access` +
      ` workspace and system objects.`
    );
  }

  protected override async handleAsk(question: string): Promise<string> {
    // Ask the organism itself first
    const prompt = this.askPrompt(question);
    const organismAnswer = await this.askLlm(prompt, question);

    // Also ask the interface organelle for internal knowledge
    if (this.interfaceId !== ('' as AbjectId)) {
      try {
        const ifaceAnswer = await this.request<string>(
          request(this.id, this.interfaceId, 'ask', { question }),
          15000
        );
        if (ifaceAnswer) {
          // Combine: organism context + interface knowledge
          const combined = await this.askLlm(
            prompt +
              `\n\nThe interface organelle answered this same question as follows:\n${ifaceAnswer}` +
              `\n\nSynthesize a complete answer combining both perspectives.`,
            question
          );
          return combined;
        }
      } catch {
        // Interface may not be able to answer -- fall back to organism answer
      }
    }

    return organismAnswer;
  }

  // ── Invariants ──────────────────────────────────────────────────

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.spec !== undefined, 'spec must be defined');
    // Only check child count after onInit has completed
    if (this.organelleIds.size > 0) {
      invariant(
        this.organelleIds.size === this.spec.organelles.length,
        `organelleIds.size (${this.organelleIds.size}) must match spec.organelles.length (${this.spec.organelles.length})`
      );
    }
  }
}
