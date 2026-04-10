/**
 * CompositeAbject — Symbogenesis for Abjects.
 *
 * Encapsulates multiple child Abjects behind a single AbjectId.
 * External callers see one object with one manifest. Internally, messages
 * are routed to children by a configurable routing table.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceDeclaration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { ScriptableAbject } from './scriptable-abject.js';

// ── Spec types ──────────────────────────────────────────────────────

export interface CompositeChildSpec {
  role: string;
  source: string;
  manifest: AbjectManifest;
  observes?: string[];
}

export interface RouteEntry {
  strategy: 'delegate' | 'fanout' | 'orchestrate';
  target?: string;
  targets?: string[];
  aggregate?: 'array' | 'first';
}

export interface CompositeSpec {
  name: string;
  description: string;
  version?: string;
  interface: InterfaceDeclaration;
  children: CompositeChildSpec[];
  routes: Record<string, RouteEntry>;
  orchestrationSource?: string;
  exposeChildren?: boolean;
  tags?: string[];
}

// ── Constants ───────────────────────────────────────────────────────

export const COMPOSITE_ABJECT_ID = 'abjects:composite' as AbjectId;

// ── Class ───────────────────────────────────────────────────────────

export class CompositeAbject extends Abject {
  private spec: CompositeSpec;
  private childrenByRole: Map<string, AbjectId> = new Map();
  private childObjects: Map<string, Abject> = new Map();
  private orchestrationHandlers: Record<string, Function> = {};
  private _compositeSource: string;

  constructor(spec: CompositeSpec) {
    contractRequire(spec.name !== '', 'CompositeSpec name must not be empty');
    contractRequire(spec.children.length > 0, 'CompositeSpec must have at least one child');

    const tags = [...(spec.tags ?? [])];
    if (!tags.includes('composite')) {
      tags.push('composite');
    }

    super({
      manifest: {
        name: spec.name,
        description: spec.description,
        version: spec.version ?? '1.0.0',
        interface: spec.interface,
        requiredCapabilities: [],
        tags,
      },
    });

    this.spec = spec;
    this._compositeSource = JSON.stringify(spec);

    if (spec.orchestrationSource) {
      this.compileOrchestration(spec.orchestrationSource);
    }

    this.setupRouting();
  }

  get compositeSource(): string {
    return this._compositeSource;
  }

  // ── Routing setup ───────────────────────────────────────────────

  private setupRouting(): void {
    for (const method of this.spec.interface.methods) {
        const routeKey = method.name;
        const route = this.spec.routes[routeKey];

        if (!route) continue;

        switch (route.strategy) {
          case 'delegate':
            contractRequire(
              route.target !== undefined,
              `delegate route '${routeKey}' must have a target`
            );
            this.on(method.name, (msg: AbjectMessage) => {
              return this.routeDelegate(route.target!, msg);
            });
            break;

          case 'fanout':
            contractRequire(
              route.targets !== undefined && route.targets.length > 0,
              `fanout route '${routeKey}' must have targets`
            );
            this.on(method.name, (msg: AbjectMessage) => {
              return this.routeFanout(
                route.targets!,
                route.aggregate ?? 'array',
                msg
              );
            });
            break;

          case 'orchestrate': {
            const handler = this.orchestrationHandlers[method.name];
            contractRequire(
              handler !== undefined,
              `orchestrate route '${routeKey}' has no compiled handler for '${method.name}'`
            );
            this.on(method.name, (msg: AbjectMessage) => {
              return handler(msg);
            });
            break;
          }
        }
    }
  }

  // ── Routing strategies ──────────────────────────────────────────

  private async routeDelegate(
    role: string,
    msg: AbjectMessage
  ): Promise<unknown> {
    const childId = this.childrenByRole.get(role);
    contractRequire(
      childId !== undefined,
      `No child with role '${role}' in composite '${this.spec.name}'`
    );

    return this.request(
      request(
        this.id,
        childId!,
        msg.routing.method ?? '',
        msg.payload
      )
    );
  }

  private async routeFanout(
    roles: string[],
    aggregate: 'array' | 'first',
    msg: AbjectMessage
  ): Promise<unknown> {
    const promises = roles.map((role) => {
      const childId = this.childrenByRole.get(role);
      contractRequire(
        childId !== undefined,
        `No child with role '${role}' in composite '${this.spec.name}'`
      );

      return this.request(
        request(
          this.id,
          childId!,
          msg.routing.method ?? '',
          msg.payload
        )
      );
    });

    const results = await Promise.all(promises);
    return aggregate === 'first' ? results[0] : results;
  }

  // ── Child helper for orchestration ──────────────────────────────

  private async child(
    role: string,
    method: string,
    payload: unknown
  ): Promise<unknown> {
    const childId = this.childrenByRole.get(role);
    contractRequire(
      childId !== undefined,
      `No child with role '${role}' in composite '${this.spec.name}'`
    );

    return this.request(
      request(this.id, childId!, method, payload)
    );
  }

  // ── Orchestration compilation ───────────────────────────────────

  private compileOrchestration(source: string): void {
    const handlerMap = new Function('return ' + source)() as Record<
      string,
      Function
    >;
    contractRequire(
      typeof handlerMap === 'object' && handlerMap !== null,
      'Orchestration source must evaluate to a non-null object'
    );

    for (const [key, value] of Object.entries(handlerMap)) {
      if (typeof value === 'function') {
        this.orchestrationHandlers[key] = value.bind(this);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  protected override async onInit(): Promise<void> {
    // Spawn children directly on the bus to avoid deadlock with Factory.
    // (Factory is likely handling our own spawn when onInit runs.)
    for (const childSpec of this.spec.children) {
      const child = new ScriptableAbject(
        childSpec.manifest,
        childSpec.source,
        this.id
      );
      child.setRegistryHint(
        (await this.resolveRegistryId()) ?? ('' as AbjectId)
      );
      await child.init(this.bus, this.id);

      this.childrenByRole.set(childSpec.role, child.id);
      this.childObjects.set(childSpec.role, child);
    }

    // Wire inter-child observes links via addDependent messages.
    // We send from this.id (composite) so the reply comes back to us,
    // but the observed child registers the observer child (from the payload).
    for (const childSpec of this.spec.children) {
      if (!childSpec.observes || childSpec.observes.length === 0) continue;

      const observerId = this.childrenByRole.get(childSpec.role)!;
      for (const observedRole of childSpec.observes) {
        const observedId = this.childrenByRole.get(observedRole);
        contractRequire(
          observedId !== undefined,
          `observes target role '${observedRole}' not found in composite`
        );

        // Send addDependent FROM the observer child TO the observed child.
        // Use bus.send directly since we need the 'from' to be the observer.
        this.bus.send(
          request(
            observerId,
            observedId!,
            'addDependent',
            {}
          )
        );
        // Small delay to let the message be processed
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  protected override async onStop(): Promise<void> {
    // Stop children directly — they are not tracked by Factory
    for (const [, child] of this.childObjects) {
      try {
        await child.stop();
      } catch {
        // Child may already be stopped
      }
    }
    this.childrenByRole.clear();
    this.childObjects.clear();
  }

  // ── Ask support ─────────────────────────────────────────────────

  protected override askPrompt(_question: string): string {
    const roles = this.spec.children
      .map((c) => `  - ${c.role}: ${c.manifest.name} — ${c.manifest.description}`)
      .join('\n');
    const routes = Object.entries(this.spec.routes)
      .map(([key, r]) => {
        if (r.strategy === 'delegate') return `  - ${key} → delegate to ${r.target}`;
        if (r.strategy === 'fanout') return `  - ${key} → fanout to [${r.targets?.join(', ')}]`;
        return `  - ${key} → orchestrate`;
      })
      .join('\n');

    return super.askPrompt(_question) + `\n\nComposite: ${this.spec.name}\nDescription: ${this.spec.description}\n\nRoles:\n${roles}\n\nRoutes:\n${routes}`;
  }

  // ── Invariants ──────────────────────────────────────────────────

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.spec !== undefined, 'spec must be defined');
    // Only check child count when all children have been spawned (ready state after onInit)
    if (this.childrenByRole.size > 0) {
      invariant(
        this.childrenByRole.size === this.spec.children.length,
        `childrenByRole.size (${this.childrenByRole.size}) must match spec.children.length (${this.spec.children.length})`
      );
    }
  }
}
