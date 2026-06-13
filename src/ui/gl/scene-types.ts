/**
 * The retained 3D scene vocabulary — the native way visual state is
 * expressed. Mirrors the canvas draw-command pattern: a single source of
 * truth for node kinds and required params, loud validation with
 * human-actionable messages, and theme-token color references so nothing
 * bakes hardcoded colors into the scene.
 *
 * Scene ops are RETAINED: nodes persist until removed or their owning
 * surface is destroyed. Every window surface is itself a node in the scene
 * (kind 'surface', managed automatically); vocabulary nodes attach to a
 * window's subtree and inherit its transform, so 3D content travels with
 * its window.
 */

export const SCENE_NODE_KINDS = ['group', 'mesh', 'light'] as const;
export type SceneNodeKind = typeof SCENE_NODE_KINDS[number];

export const MESH_PRIMITIVES = ['plane', 'box', 'sphere', 'cylinder'] as const;
export type MeshPrimitive = typeof MESH_PRIMITIVES[number];

export const LIGHT_TYPES = ['point', 'directional'] as const;

/**
 * Theme tokens accepted as `$token` color references in scene params.
 * Resolved client-side against the active scene theme and re-resolved on
 * every theme change — like 2D widgets re-deriving colors at draw time.
 */
export const SCENE_THEME_TOKENS = [
  'accent', 'accentSecondary', 'accentTertiary',
  'windowBg', 'windowBorder', 'canvasBg', 'shadowColor',
  'textPrimary', 'textSecondary',
  'statusSuccess', 'statusError', 'statusWarning', 'statusInfo',
] as const;

export interface SceneTransform {
  /** px offsets; for nodes under a window, relative to the slab center (z toward viewer). */
  position?: [number, number, number];
  /** Euler radians, applied X then Y then Z. */
  rotation?: [number, number, number];
  /** px (primitives are unit-sized); a single number scales uniformly. */
  scale?: [number, number, number] | number;
}

export interface SceneOp {
  op: 'add' | 'update' | 'remove';
  /** Node id, unique within the owning window's subtree. */
  id: string;
  /** Parent node id; omitted = direct child of the window's slab. */
  parentId?: string;
  /** Required for 'add'. */
  kind?: SceneNodeKind;
  transform?: SceneTransform;
  /**
   * Per-kind params:
   * - mesh:  { primitive, color, emissive?, opacity? }   colors: '#hex' or '$token'
   * - light: { lightType: 'point'|'directional', color?, direction? [x,y,z] }
   * - group: {}
   */
  params?: Record<string, unknown>;
}

/** The theme subset the 3D scene renders from (pushed via setSceneTheme). */
export interface SceneTheme {
  /** Token name → CSS color, keys = SCENE_THEME_TOKENS. */
  colors: Record<string, string>;
  windowRadius: number;
  /** Depth-treatment intensity, mirroring tokens.surface (0 = flat slabs). */
  surface: { gradient: number; bevel: number; gloss: number };
  glow: { focusBlur: number; focusColor: string; accentBlur: number; accentColor: string };
  shadow: { color: string; blur: number; offsetY: number };
}

const TOKEN_SET = new Set<string>(SCENE_THEME_TOKENS);

/** Recognized op-level fields. Anything else is a mistake worth flagging. */
const OP_FIELDS = new Set(['op', 'id', 'parentId', 'kind', 'transform', 'params']);

/**
 * Op-level field aliases: forgiving renames for the field names generators
 * most often guess wrong, mirroring the canvas vocabulary's param aliases.
 * `parent` → `parentId` is by far the most common (it reads naturally), and
 * silently dropping it detaches every child from its group.
 */
const OP_FIELD_ALIASES: Record<string, string> = {
  parent: 'parentId',
};

/**
 * Hints for unknown op-level fields that name a real concept living somewhere
 * else in the vocabulary, so the rejection message points the right way.
 */
const OP_FIELD_HINTS: Record<string, string> = {
  mesh: 'put the shape in params.primitive (one of ' + MESH_PRIMITIVES.join(', ') + ')',
  primitive: 'nest it under params: { primitive: ... }',
  material: 'put the color in params.color',
  color: 'nest it under params: { color: ... }',
  position: 'nest it under transform: { position: [x, y, z] }',
  rotation: 'nest it under transform: { rotation: [rx, ry, rz] }',
  scale: 'nest it under transform: { scale: n | [x, y, z] }',
};

/**
 * Rewrite op-level field aliases to their canonical names (e.g. `parent` →
 * `parentId`). Input ops are not mutated; only ops needing a rename are
 * cloned. Apply this before validateSceneOps and before storing.
 */
export function normalizeSceneOps(ops: unknown[]): unknown[] {
  if (!Array.isArray(ops)) return ops;
  return ops.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const o = raw as Record<string, unknown>;
    let renamed: Record<string, unknown> | undefined;
    for (const [alias, canonical] of Object.entries(OP_FIELD_ALIASES)) {
      if (o[alias] !== undefined && o[canonical] === undefined) {
        renamed ??= { ...o };
        renamed[canonical] = renamed[alias];
        delete renamed[alias];
      }
    }
    return renamed ?? raw;
  });
}

/** True for '#hex', 'rgb(a)', or a known '$token' reference. */
export function isSceneColor(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('$')) return TOKEN_SET.has(value.slice(1));
  return value.startsWith('#') || value.startsWith('rgb');
}

/** Resolve a possibly-token color against the current theme. */
export function resolveSceneColor(value: string, theme: SceneTheme | undefined): string {
  if (value.startsWith('$')) {
    return theme?.colors[value.slice(1)] ?? '#ffffff';
  }
  return value;
}

function isVec3(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function validTransform(t: unknown): string | null {
  if (t === undefined) return null;
  const tr = t as SceneTransform;
  if (typeof tr !== 'object' || tr === null) return 'transform must be an object';
  if (tr.position !== undefined && !isVec3(tr.position)) return 'transform.position must be [x, y, z] numbers';
  if (tr.rotation !== undefined && !isVec3(tr.rotation)) return 'transform.rotation must be [rx, ry, rz] radians';
  if (tr.scale !== undefined && !(typeof tr.scale === 'number' || isVec3(tr.scale))) return 'transform.scale must be a number or [sx, sy, sz]';
  return null;
}

/**
 * Validate a scene op batch. Returns human-actionable problems (empty when
 * valid), deduplicated, naming the vocabulary — same philosophy as the
 * canvas draw-command validator.
 */
export function validateSceneOps(ops: unknown[]): string[] {
  const problems = new Map<string, string>();
  if (!Array.isArray(ops)) return ['ops must be an array of { op, id, ... } scene operations'];
  for (const raw of ops) {
    const o = raw as SceneOp;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id) {
      problems.set('<id>', 'every op needs a string `id`');
      continue;
    }
    if (o.op !== 'add' && o.op !== 'update' && o.op !== 'remove') {
      problems.set('<op>', `op must be 'add' | 'update' | 'remove'`);
      continue;
    }
    // Loudly reject stray op-level fields — generators routinely guess names
    // like `parent`, `mesh`, `material`, or a bare `position`, and a silently
    // ignored field (e.g. `parent` instead of `parentId`) detaches children
    // from their group with no error. (`parent` is auto-aliased upstream by
    // normalizeSceneOps, so it only reaches here when normalization was skipped.)
    for (const key of Object.keys(o as unknown as Record<string, unknown>)) {
      if (OP_FIELDS.has(key)) continue;
      const alias = OP_FIELD_ALIASES[key];
      const hint = alias ? `use '${alias}'` : (OP_FIELD_HINTS[key] ?? `not part of the scene-op vocabulary (fields: ${[...OP_FIELDS].join(', ')})`);
      problems.set(`${o.id}:${key}`, `'${o.id}': unknown field '${key}' — ${hint}`);
    }
    const tErr = validTransform(o.transform);
    if (tErr) problems.set(`${o.id}:transform`, `'${o.id}': ${tErr}`);
    if (o.op === 'remove') continue;

    if (o.op === 'add') {
      if (!o.kind || !(SCENE_NODE_KINDS as readonly string[]).includes(o.kind)) {
        problems.set(`${o.id}:kind`, `'${o.id}': add needs kind — one of ${SCENE_NODE_KINDS.join(', ')}`);
        continue;
      }
    }
    const params = o.params ?? {};
    const kind = o.kind;
    if (kind === 'mesh' || (o.op === 'update' && params.primitive !== undefined)) {
      if (o.op === 'add' && !(MESH_PRIMITIVES as readonly string[]).includes(params.primitive as string)) {
        problems.set(`${o.id}:primitive`, `'${o.id}': mesh needs params.primitive — one of ${MESH_PRIMITIVES.join(', ')}`);
      }
      if (o.op === 'add' && !isSceneColor(params.color)) {
        problems.set(`${o.id}:color`, `'${o.id}': mesh needs params.color — '#hex', 'rgb(a)', or a theme token ($${SCENE_THEME_TOKENS.join(', $')})`);
      }
      if (params.emissive !== undefined && !isSceneColor(params.emissive)) {
        problems.set(`${o.id}:emissive`, `'${o.id}': params.emissive must be a color or $token`);
      }
      if (params.opacity !== undefined && typeof params.opacity !== 'number') {
        problems.set(`${o.id}:opacity`, `'${o.id}': params.opacity must be a number 0..1`);
      }
      if (params.layer !== undefined && params.layer !== 'back' && params.layer !== 'front') {
        problems.set(`${o.id}:layer`, `'${o.id}': params.layer must be 'back' (behind windows) or 'front' (above windows) — world scope only`);
      }
    }
    if (kind === 'light') {
      if (o.op === 'add' && !(LIGHT_TYPES as readonly string[]).includes(params.lightType as string)) {
        problems.set(`${o.id}:lightType`, `'${o.id}': light needs params.lightType — 'point' or 'directional'`);
      }
      if (params.color !== undefined && !isSceneColor(params.color)) {
        problems.set(`${o.id}:lightColor`, `'${o.id}': light params.color must be a color or $token`);
      }
      if (params.direction !== undefined && !isVec3(params.direction)) {
        problems.set(`${o.id}:direction`, `'${o.id}': light params.direction must be [x, y, z]`);
      }
    }
  }
  return [...problems.values()];
}
