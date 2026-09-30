/**
 * SceneLibrary: the desktop's named 3D presets.
 *
 * A material preset (`material: 'gold'` on a mesh, model, text or line node)
 * and a look preset (`look: 'sunset'` on an environment node) are plain data:
 * a subset of the params they stand for, with the node's own params layered
 * on top. Built-ins live in `src/ui/gl/scene-presets.ts`; any Abject can
 * register more, or override a built-in name, and its registrations last
 * exactly as long as it does.
 *
 * The merged library (built-ins plus registrations) is pushed to the UIServer
 * with `setSceneLibrary` after every change, which retains it and relays it
 * to every client; presets resolve at draw time in the browser, so a
 * re-registered preset restyles every node that names it.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, ensure, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import {
  BUILTIN_SCENE_LIBRARY,
  BUILTIN_PRESET_DESCRIPTIONS,
  MATERIAL_PRESET_FIELDS,
  LOOK_PRESET_FIELDS,
  PRESET_NAME_PATTERN,
  mergeSceneLibrary,
  validateMaterialPreset,
  validateLookPreset,
  type SceneLibraryConfig,
} from '../ui/gl/scene-presets.js';

const log = new Log('SceneLibrary');

export const SCENE_LIBRARY_ID = 'abjects:scene-library' as AbjectId;
const SCENE_LIBRARY_INTERFACE = 'abjects:scene-library' as InterfaceId;

/** How often dead owners' registrations are swept (only while any exist). */
const SWEEP_INTERVAL_MS = 3000;
/**
 * A registration younger than this survives a sweep even if its owner is not
 * yet visible on this bus: liveness reaches a worker by broadcast, and a
 * freshly spawned caller's first message can arrive ahead of it.
 */
const SWEEP_GRACE_MS = 10_000;
/** Coalesce bursts of registrations (an abject registering a set at init) into one push. */
const PUSH_DELAY_MS = 20;
/** Per-owner cap for each preset kind. */
const MAX_PER_OWNER = 256;
const MAX_DESCRIPTION = 200;

type PresetKind = 'material' | 'look';

interface Registration {
  spec: Record<string, unknown>;
  owner: AbjectId;
  description?: string;
  registeredAt: number;
}

/** One row of listMaterials / listLooks. */
export interface ScenePresetInfo {
  name: string;
  description?: string;
  /** 'builtin' = shipped preset; 'registered' = added by an Abject (possibly overriding a built-in). */
  source: 'builtin' | 'registered';
  /** True when a registration replaces a built-in of the same name. */
  overridesBuiltin: boolean;
  /** The registering Abject (registered presets only). */
  owner?: AbjectId;
}

const presetParams = (kind: PresetKind) => [
  { name: 'name', type: { kind: 'primitive' as const, primitive: 'string' as const }, description: 'Preset name: a letter, then letters, digits, - or _ (up to 64). Reusing a built-in name overrides it while you run.' },
  {
    name: 'spec',
    type: { kind: 'object' as const, properties: {} },
    description: kind === 'material'
      ? `Material params (the node's own params win over these). Fields: ${MATERIAL_PRESET_FIELDS.join(', ')}. Colours are '#hex', 'rgb(a)' or $token.`
      : `Environment params (the environment node's own params win over these). Fields: ${LOOK_PRESET_FIELDS.join(', ')}. Colours are '#hex', 'rgb(a)' or $token.`,
  },
  { name: 'description', type: { kind: 'primitive' as const, primitive: 'string' as const }, description: 'One line saying what it looks like (shown in listings)', optional: true },
];

const presetInfoType = {
  kind: 'array' as const,
  elementType: {
    kind: 'object' as const,
    properties: {
      name: { kind: 'primitive' as const, primitive: 'string' as const },
      description: { kind: 'primitive' as const, primitive: 'string' as const },
      source: { kind: 'primitive' as const, primitive: 'string' as const },
      overridesBuiltin: { kind: 'primitive' as const, primitive: 'boolean' as const },
      owner: { kind: 'primitive' as const, primitive: 'string' as const },
    },
  },
};

export class SceneLibrary extends Abject {
  private materials = new Map<string, Registration>();
  private looks = new Map<string, Registration>();
  private uiServerId?: AbjectId;
  private pushTimer?: ReturnType<typeof setTimeout>;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super({
      manifest: {
        name: 'SceneLibrary',
        description:
          'Named 3D presets for scene nodes: materials (`material: \'gold\'` on a mesh, model, text or line node) and looks (`look: \'sunset\'` on an environment node). Ships built-ins and lets any Abject register its own or override a built-in; a registration lasts as long as the Abject that made it.',
        version: '1.0.0',
        interface: {
          id: SCENE_LIBRARY_INTERFACE,
          name: 'SceneLibrary',
          description: 'Register, list and read named material and look presets for the 3D scene vocabulary',
          methods: [
            {
              name: 'registerMaterial',
              description: 'Register a named material preset owned by the caller. Nodes use it with params.material = name; their own params override the preset\'s. Rejected with a message naming the problem when the spec is invalid or another live Abject owns the name. Re-registering your own name replaces it.',
              parameters: presetParams('material'),
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'unregisterMaterial',
              description: 'Remove a material preset you registered. A built-in of the same name comes back. Returns false when the name is not registered.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The preset name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listMaterials',
              description: 'Every material preset available right now (built-in and registered), with a one-line description and where it came from.',
              parameters: [],
              returns: presetInfoType,
            },
            {
              name: 'getMaterial',
              description: 'The effective params of one material preset (a registration wins over a built-in), or null when unknown. Handy for deriving a variant: { ...spec, roughness: 0.6 }.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The preset name' },
              ],
              returns: { kind: 'union', variants: [{ kind: 'object', properties: {} }, { kind: 'primitive', primitive: 'null' }] },
            },
            {
              name: 'registerLook',
              description: 'Register a named look (environment mood: sky light, tone mapping, exposure, fog, grading, bloom, post effects) owned by the caller. Environment nodes use it with params.look = name; their own params override the look\'s. Re-registering your own name replaces it.',
              parameters: presetParams('look'),
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'unregisterLook',
              description: 'Remove a look you registered. A built-in of the same name comes back. Returns false when the name is not registered.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The look name' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listLooks',
              description: 'Every look available right now (built-in and registered), with a one-line description and where it came from.',
              parameters: [],
              returns: presetInfoType,
            },
            {
              name: 'getLook',
              description: 'The effective params of one look (a registration wins over a built-in), or null when unknown.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The look name' },
              ],
              returns: { kind: 'union', variants: [{ kind: 'object', properties: {} }, { kind: 'primitive', primitive: 'null' }] },
            },
            {
              name: 'getLibrary',
              description: 'The whole merged library as the renderer sees it: { materials: { name: params }, looks: { name: params } }.',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  materials: { kind: 'object', properties: {} },
                  looks: { kind: 'object', properties: {} },
                },
              },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'scene'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('registerMaterial', async (msg: AbjectMessage) => this.register('material', msg));
    this.on('unregisterMaterial', async (msg: AbjectMessage) => this.unregister('material', msg));
    this.on('listMaterials', async () => this.list('material'));
    this.on('getMaterial', async (msg: AbjectMessage) => this.get('material', msg));

    this.on('registerLook', async (msg: AbjectMessage) => this.register('look', msg));
    this.on('unregisterLook', async (msg: AbjectMessage) => this.unregister('look', msg));
    this.on('listLooks', async () => this.list('look'));
    this.on('getLook', async (msg: AbjectMessage) => this.get('look', msg));

    this.on('getLibrary', async () => this.merged());
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.requireDep('UIServer');
    this.push();
    const problems = [
      ...Object.entries(BUILTIN_SCENE_LIBRARY.materials).map(([n, s]) => [n, validateMaterialPreset(s)] as const),
      ...Object.entries(BUILTIN_SCENE_LIBRARY.looks).map(([n, s]) => [n, validateLookPreset(s)] as const),
    ].filter(([, p]) => p.length > 0);
    for (const [name, p] of problems) log.warn(`built-in preset '${name}' does not validate: ${p.join('; ')}`);
  }

  protected override async onStop(): Promise<void> {
    // Registrations live only as long as this library does.
    this.materials.clear();
    this.looks.clear();
    this.cancelTimer(this.pushTimer);
    this.cancelTimer(this.sweepTimer);
    this.pushTimer = undefined;
    this.sweepTimer = undefined;
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  private table(kind: PresetKind): Map<string, Registration> {
    return kind === 'material' ? this.materials : this.looks;
  }

  private builtins(kind: PresetKind): Record<string, Record<string, unknown>> {
    return kind === 'material' ? BUILTIN_SCENE_LIBRARY.materials : BUILTIN_SCENE_LIBRARY.looks;
  }

  private register(kind: PresetKind, msg: AbjectMessage): boolean {
    const method = kind === 'material' ? 'registerMaterial' : 'registerLook';
    const { name, spec, description } = (msg.payload ?? {}) as { name?: unknown; spec?: unknown; description?: unknown };
    precondition(typeof name === 'string' && PRESET_NAME_PATTERN.test(name),
      `${method}: name must start with a letter (letters, digits, - and _; up to 64), e.g. '${kind === 'material' ? 'brass' : 'deepSea'}'`);
    precondition(spec !== undefined,
      `${method} '${name}': spec is required, e.g. ${kind === 'material' ? '{ color: \'#b08d57\', metalness: 1, roughness: 0.35 }' : '{ ambient: \'#223\', toneMapping: \'aces\', exposure: 1.1 }'}`);
    const problems = kind === 'material' ? validateMaterialPreset(spec) : validateLookPreset(spec);
    precondition(problems.length === 0, `${method} '${name}': ${problems.join('; ')}`);
    precondition(description === undefined || (typeof description === 'string' && description.length <= MAX_DESCRIPTION),
      `${method} '${name}': description must be a string of up to ${MAX_DESCRIPTION} characters`);

    const owner = msg.routing.from;
    const table = this.table(kind);
    const existing = table.get(name);
    precondition(!existing || existing.owner === owner || !this.bus.isRegistered(existing.owner),
      `${method}: '${name}' is registered by another Abject; pick a different name`);
    if (!existing || existing.owner !== owner) {
      let owned = 0;
      for (const r of table.values()) if (r.owner === owner) owned++;
      precondition(owned < MAX_PER_OWNER, `${method}: one Abject can register up to ${MAX_PER_OWNER} ${kind}s; unregister some first`);
    }

    table.set(name, {
      spec: structuredClone(spec as Record<string, unknown>),
      owner,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      registeredAt: Date.now(),
    });
    this.armSweep();
    this.schedulePush();
    ensure(table.get(name)?.owner === owner, `${method}: registration was not stored`);
    return true;
  }

  private unregister(kind: PresetKind, msg: AbjectMessage): boolean {
    const method = kind === 'material' ? 'unregisterMaterial' : 'unregisterLook';
    const { name } = (msg.payload ?? {}) as { name?: unknown };
    precondition(typeof name === 'string' && name.length > 0, `${method}: name is required`);
    const table = this.table(kind);
    const existing = table.get(name);
    if (!existing) return false;
    precondition(existing.owner === msg.routing.from, `${method}: '${name}' is registered by another Abject`);
    table.delete(name);
    this.schedulePush();
    return true;
  }

  private list(kind: PresetKind): ScenePresetInfo[] {
    const builtins = this.builtins(kind);
    const notes = kind === 'material' ? BUILTIN_PRESET_DESCRIPTIONS.materials : BUILTIN_PRESET_DESCRIPTIONS.looks;
    const table = this.table(kind);
    const rows: ScenePresetInfo[] = [];
    for (const name of Object.keys(builtins)) {
      const reg = table.get(name);
      if (reg) {
        rows.push({
          name, source: 'registered', overridesBuiltin: true, owner: reg.owner,
          ...(reg.description ? { description: reg.description } : notes[name] ? { description: notes[name] } : {}),
        });
      } else {
        rows.push({ name, source: 'builtin', overridesBuiltin: false, ...(notes[name] ? { description: notes[name] } : {}) });
      }
    }
    const added = [...table.keys()].filter((n) => !(n in builtins)).sort();
    for (const name of added) {
      const reg = table.get(name)!;
      rows.push({
        name, source: 'registered', overridesBuiltin: false, owner: reg.owner,
        ...(reg.description ? { description: reg.description } : {}),
      });
    }
    return rows;
  }

  private get(kind: PresetKind, msg: AbjectMessage): Record<string, unknown> | null {
    const { name } = (msg.payload ?? {}) as { name?: unknown };
    precondition(typeof name === 'string' && name.length > 0, `${kind === 'material' ? 'getMaterial' : 'getLook'}: name is required`);
    const reg = this.table(kind).get(name);
    if (reg) return structuredClone(reg.spec);
    const builtin = this.builtins(kind)[name];
    return builtin ? structuredClone(builtin) : null;
  }

  /** Built-ins with every live registration layered on top. */
  private merged(): SceneLibraryConfig {
    const overrides: SceneLibraryConfig = { materials: {}, looks: {} };
    for (const [name, r] of this.materials) overrides.materials[name] = r.spec;
    for (const [name, r] of this.looks) overrides.looks[name] = r.spec;
    return mergeSceneLibrary(BUILTIN_SCENE_LIBRARY, overrides);
  }

  // ── Push and ownership ────────────────────────────────────────────────

  /** Send the merged library to the UIServer (which retains and relays it). */
  private push(): void {
    if (!this.uiServerId) return;
    try {
      this.send(request(this.id, this.uiServerId, 'setSceneLibrary', { config: this.merged() }));
    } catch (err) {
      log.warn(`setSceneLibrary push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private schedulePush(): void {
    if (this.pushTimer !== undefined) return;
    this.pushTimer = this.setTimer(() => {
      this.pushTimer = undefined;
      this.push();
    }, PUSH_DELAY_MS);
  }

  /** Run the dead-owner sweep while any registration exists. */
  private armSweep(): void {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = this.setRecurringTimer(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Registrations die with the Abject that made them. */
  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const table of [this.materials, this.looks]) {
      for (const [name, r] of table) {
        if (now - r.registeredAt < SWEEP_GRACE_MS) continue;
        if (!this.bus.isRegistered(r.owner)) {
          table.delete(name);
          removed++;
        }
      }
    }
    if (removed > 0) this.schedulePush();
    if (this.materials.size === 0 && this.looks.size === 0) {
      this.cancelTimer(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.checkInvariants();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const table of [this.materials, this.looks]) {
      for (const [name, r] of table) {
        invariant(PRESET_NAME_PATTERN.test(name), `SceneLibrary: invalid preset name '${name}'`);
        invariant(typeof r.owner === 'string' && r.owner.length > 0, `SceneLibrary: preset '${name}' has no owner`);
        invariant(!!r.spec && typeof r.spec === 'object', `SceneLibrary: preset '${name}' has no spec`);
      }
    }
    invariant(this.materials.size + this.looks.size === 0 || this.sweepTimer !== undefined,
      'SceneLibrary: registrations exist without an owner sweep');
  }

  // ── Ask guide ─────────────────────────────────────────────────────────

  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(question: string): string {
    const mats = Object.entries(BUILTIN_PRESET_DESCRIPTIONS.materials).map(([n, d]) => `  - ${n}: ${d}`).join('\n');
    const looks = Object.entries(BUILTIN_PRESET_DESCRIPTIONS.looks).map(([n, d]) => `  - ${n}: ${d}`).join('\n');
    const added = [...this.materials.keys()].map((n) => `material '${n}'`)
      .concat([...this.looks.keys()].map((n) => `look '${n}'`));
    return `${super.askPrompt(question)}

## SceneLibrary Usage Guide

Presets are named bundles of 3D scene params. A MATERIAL preset is a set of surface params for a mesh,
model, text or line node; name it with params.material. A LOOK preset is a scene mood for an
environment node (sky light, tone mapping, exposure, fog, colour grading, bloom); name it with
params.look. The node's own params always win over the preset's, so a preset is a starting point you
can tweak per node: { material: 'gold', roughness: 0.6 } is satin gold. An unknown name renders as if
it were absent. Presets resolve in the browser at draw time, so changing a preset restyles every node
that uses it with no new scene ops.

### Built-in materials
${mats}

### Built-in looks
${looks}
${added.length > 0 ? `\nRegistered right now: ${added.join(', ')}.\n` : ''}
### Use presets on nodes

  await this.call(windowId, 'scene', { ops: [
    { op: 'add', id: 'mood', kind: 'environment', params: { look: 'sunset' } },
    { op: 'add', id: 'orb', kind: 'mesh', transform: { position: [0, 0, 40], scale: 120 },
      params: { primitive: 'sphere', material: 'gold' } },
    { op: 'add', id: 'base', kind: 'mesh', transform: { position: [0, 90, 0], scale: [240, 20, 120] },
      params: { primitive: 'box', material: 'obsidian' } },
  ] });

A mesh with a material needs no color of its own (the preset supplies it). Set color to recolour it.
Presets that glow (neon, emissive, sigil) carry an emissive colour as well: set both color and
emissive on the node to recolour the glow. Presets written with $token colours (plastic, toon,
neon, hologram, sigil, void) follow the active theme.

### Register your own

  const lib = await this.dep('SceneLibrary');
  await this.call(lib, 'registerMaterial', { name: 'brass', description: 'Aged brass',
    spec: { color: '#b08d57', metalness: 1, roughness: 0.35, clearcoat: 0.2 } });
  await this.call(lib, 'registerLook', { name: 'deepSea', description: 'Blue-green underwater haze',
    spec: { ambient: '#0a2a3a', sky: { top: '#02131f', horizon: '#0f5a73', bottom: '#010608' },
            fog: { color: '#062232', near: 0, far: 900 }, toneMapping: 'aces', exposure: 1.1 } });

Then any object can use material: 'brass' or look: 'deepSea'. Material fields: ${MATERIAL_PRESET_FIELDS.join(', ')}.
Look fields: ${LOOK_PRESET_FIELDS.join(', ')}. Shape, placement and interaction stay on the node.
A registration belongs to the object that made it and ends when that object stops, so register
in your init (or show) and it will be there whenever you are. Registering a built-in name overrides
the built-in while you run; unregistering (or stopping) brings the built-in back. A name another
running object owns is taken: pick a different one. Invalid specs are rejected with a message naming
the field to fix. Derive a variant of an existing preset with getMaterial / getLook:
  const gold = await this.call(lib, 'getMaterial', { name: 'gold' });
  await this.call(lib, 'registerMaterial', { name: 'roseGold', spec: { ...gold, color: '#f4c2b0' } });

listMaterials / listLooks return every available name with a description and its source;
getLibrary returns the whole merged library.`;
  }
}
