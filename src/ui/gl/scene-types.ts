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

export const SCENE_NODE_KINDS = ['group', 'mesh', 'light', 'environment', 'canvas'] as const;
export type SceneNodeKind = typeof SCENE_NODE_KINDS[number];

export const MESH_PRIMITIVES = ['plane', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'icosphere'] as const;
export type MeshPrimitive = typeof MESH_PRIMITIVES[number];

export const LIGHT_TYPES = ['point', 'directional', 'spot'] as const;

/**
 * Upper bound on a light's `intensity`. Intensity multiplies the light's
 * color linearly (1 = the color at full strength), so anything much above a
 * few blows every channel past white and erases every mesh's albedo. Real
 * scenes here use 0.3-1.6; the cap leaves generous headroom while catching
 * the photometric-units mistake (intensity: 1600) that renders an all-white
 * scene. Reach is controlled by `range`, not intensity.
 */
export const MAX_LIGHT_INTENSITY = 10;

export const DRAW_MODES = ['triangles', 'lines', 'points'] as const;

/** Declarative animation channels and presets carried in an 'animate' op's params. */
export const ANIM_CHANNELS = ['position', 'rotation', 'scale', 'color', 'emissive', 'opacity'] as const;
export const ANIM_PRESETS = ['spin', 'orbit', 'bob', 'pulse'] as const;

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
  op: 'add' | 'update' | 'remove' | 'animate';
  /** Node id, unique within the owning window's subtree. */
  id: string;
  /** Parent node id; omitted = direct child of the window's slab. */
  parentId?: string;
  /** Required for 'add'. */
  kind?: SceneNodeKind;
  transform?: SceneTransform;
  /**
   * Per-kind params:
   * - mesh:  { primitive, color, emissive?, opacity?, metalness?, roughness?,
   *           texture?, billboard?, drawMode?, pointSize? }   colors: '#hex' or '$token'
   *          OR custom polygonal geometry instead of a primitive:
   *          { geometry: { positions, indices?, normals?, colors?, uvs? }, color, ... }
   *          `positions` is a flat [x,y,z,...] list; `indices` a flat triangle
   *          list (defaults to a sequential triangle soup); `normals` are
   *          computed smooth when omitted; `colors` flat [r,g,b,...] (0..1) per
   *          vertex; `uvs` flat [u,v,...] per vertex. Re-send geometry in an
   *          'update' op to deform the mesh dynamically.
   *          metalness/roughness (0..1) drive the PBR look; texture is a URL/
   *          data-URI or 'surface:<surfaceId>'; billboard:true faces the camera;
   *          drawMode 'lines'|'points' renders vertices as a strip/cloud.
   *          instances: [{ position, scale?, rotation?, color? }, ...] draws the
   *          mesh once per instance in a single GPU call (particles, fields).
   * - light: { lightType: 'point'|'directional'|'spot', color?, intensity?,
   *           direction? [x,y,z], range?, angle?, penumbra? }
   * - environment: { ambient?, fog?: { color?, near, far } } — scene-wide mood.
   * - canvas: { width, height, rect?, backdrop?, commands?, opacity?,
   *          radius?, occlude?, interactive? } — a 2D drawing layer living in
   *          the scene graph: a rectangle painted by the standard 2D
   *          draw-command vocabulary. Placement: width/height px at the
   *          node's transform (scale multiplies), OR rect { x, y, width,
   *          height } window-absolute px from the top-left. Painting:
   *          params.commands (an update supplying commands replaces the
   *          batch and repaints) or, preferred for incremental apps, the
   *          draw channel — window 'draw' with { nodeId } — where commands
   *          accumulate and 'clear' restarts. The layer starts transparent —
   *          unpainted areas show the scene behind it. Canvas layers slice
   *          the subtree's meshes by depth: meshes behind the layer's z draw
   *          under it, meshes in front draw over it, so 2D and 3D content
   *          stack freely (2D → 3D → 2D → 3D → …). backdrop:true pins the
   *          layer behind ALL meshes regardless of z (window backgrounds,
   *          layout-managed widget canvases).
   * - group: {}
   *
   * For op:'animate', params is the animation spec:
   *   { channel?: 'position'|'rotation'|'scale'|'color'|'emissive'|'opacity',
   *     to?, from?, duration?, easing?, loop?, yoyo?, delay?,
   *     preset?: 'spin'|'orbit'|'bob'|'pulse', path?: number[][], stop?: boolean }
   */
  params?: Record<string, unknown>;
}

/** A mesh node's params carry custom geometry rather than a named primitive. */
export interface CustomGeometryParam {
  positions: number[];
  indices?: number[];
  normals?: number[];
  colors?: number[];
  uvs?: number[];
}

/** True when a mesh node's params define custom polygonal geometry. */
export function hasCustomGeometry(params: Record<string, unknown> | undefined): boolean {
  const g = params?.geometry as { positions?: unknown } | undefined;
  return !!g && typeof g === 'object' && Array.isArray((g as { positions?: unknown }).positions);
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
  mesh: 'put the shape in params.primitive (one of ' + MESH_PRIMITIVES.join(', ') + ') or params.geometry for a custom mesh',
  primitive: 'nest it under params: { primitive: ... }',
  geometry: 'nest it under params: { geometry: { positions, indices?, normals? } }',
  positions: 'nest it under params: { geometry: { positions: [...] } }',
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

/** True for a flat numeric array (every entry a finite number). */
function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Validate a mesh node's custom geometry. Returns [problemKey, message]
 * pairs (empty when valid). Keeps the same loud, human-actionable tone as
 * the rest of the vocabulary so a generator that ships a ragged array or
 * out-of-range index learns exactly what to fix.
 */
function validateGeometry(id: string, geometry: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const g = geometry as Record<string, unknown> | null;
  if (!g || typeof g !== 'object') {
    return [[`${id}:geometry`, `'${id}': params.geometry must be an object { positions, indices?, normals? }`]];
  }
  if (!isNumberArray(g.positions)) {
    return [[`${id}:positions`, `'${id}': params.geometry.positions must be a flat [x, y, z, ...] number array`]];
  }
  const positions = g.positions;
  if (positions.length < 9 || positions.length % 3 !== 0) {
    out.push([`${id}:positions`, `'${id}': params.geometry.positions length must be a multiple of 3 and describe at least one triangle (≥ 9 numbers); got ${positions.length}`]);
  }
  const vertexCount = Math.floor(positions.length / 3);
  if (g.indices !== undefined) {
    if (!isNumberArray(g.indices)) {
      out.push([`${id}:indices`, `'${id}': params.geometry.indices must be a flat number array of triangle vertex indices`]);
    } else {
      const idx = g.indices;
      if (idx.length % 3 !== 0) {
        out.push([`${id}:indices`, `'${id}': params.geometry.indices length must be a multiple of 3 (triangle list); got ${idx.length}`]);
      }
      for (let i = 0; i < idx.length; i++) {
        if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= vertexCount) {
          out.push([`${id}:indices`, `'${id}': params.geometry.indices[${i}] = ${idx[i]} is out of range (0..${vertexCount - 1})`]);
          break;
        }
      }
    }
  }
  if (g.normals !== undefined) {
    if (!isNumberArray(g.normals)) {
      out.push([`${id}:normals`, `'${id}': params.geometry.normals must be a flat [x, y, z, ...] number array`]);
    } else if (g.normals.length !== positions.length) {
      out.push([`${id}:normals`, `'${id}': params.geometry.normals length (${g.normals.length}) must equal positions length (${positions.length}); omit it to auto-compute`]);
    }
  }
  if (g.colors !== undefined) {
    if (!isNumberArray(g.colors)) {
      out.push([`${id}:colors`, `'${id}': params.geometry.colors must be a flat [r, g, b, ...] number array (0..1 per channel)`]);
    } else if (g.colors.length !== vertexCount * 3) {
      out.push([`${id}:colors`, `'${id}': params.geometry.colors length (${g.colors.length}) must be 3 per vertex (${vertexCount * 3})`]);
    }
  }
  if (g.uvs !== undefined) {
    if (!isNumberArray(g.uvs)) {
      out.push([`${id}:uvs`, `'${id}': params.geometry.uvs must be a flat [u, v, ...] number array`]);
    } else if (g.uvs.length !== vertexCount * 2) {
      out.push([`${id}:uvs`, `'${id}': params.geometry.uvs length (${g.uvs.length}) must be 2 per vertex (${vertexCount * 2})`]);
    }
  }
  return out;
}

/** Validate the params of an op:'animate'. Returns [key, message] pairs. */
function validateAnimate(id: string, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (params.stop === true) return out; // a stop request needs nothing else
  const hasPreset = typeof params.preset === 'string';
  const hasChannel = typeof params.channel === 'string';
  if (!hasPreset && !hasChannel) {
    out.push([`${id}:animate`, `'${id}': animate needs a 'preset' (${ANIM_PRESETS.join('|')}) or a 'channel' (${ANIM_CHANNELS.join('|')}) — or { stop: true } to cancel`]);
    return out;
  }
  if (hasPreset && !(ANIM_PRESETS as readonly string[]).includes(params.preset as string)) {
    out.push([`${id}:preset`, `'${id}': animate preset must be one of ${ANIM_PRESETS.join(', ')}`]);
  }
  if (hasChannel) {
    if (!(ANIM_CHANNELS as readonly string[]).includes(params.channel as string)) {
      out.push([`${id}:channel`, `'${id}': animate channel must be one of ${ANIM_CHANNELS.join(', ')}`]);
    }
    const isColorCh = params.channel === 'color' || params.channel === 'emissive';
    const hasTarget = params.to !== undefined || Array.isArray(params.path);
    if (!hasTarget) {
      out.push([`${id}:to`, `'${id}': animate channel '${String(params.channel)}' needs a 'to' value (or a 'path' for position)`]);
    }
    if (params.to !== undefined && isColorCh && !isSceneColor(params.to)) {
      out.push([`${id}:to`, `'${id}': animate ${String(params.channel)} 'to' must be a color or $token`]);
    }
  }
  if (params.duration !== undefined && (typeof params.duration !== 'number' || params.duration <= 0)) {
    out.push([`${id}:duration`, `'${id}': animate duration must be a positive number (ms)`]);
  }
  return out;
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
    if (o.op !== 'add' && o.op !== 'update' && o.op !== 'remove' && o.op !== 'animate') {
      problems.set('<op>', `op must be 'add' | 'update' | 'remove' | 'animate'`);
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
    if (o.op === 'animate') {
      for (const p of validateAnimate(o.id, o.params ?? {})) problems.set(p[0], p[1]);
      continue;
    }

    if (o.op === 'add') {
      if (!o.kind || !(SCENE_NODE_KINDS as readonly string[]).includes(o.kind)) {
        problems.set(`${o.id}:kind`, `'${o.id}': add needs kind — one of ${SCENE_NODE_KINDS.join(', ')}`);
        continue;
      }
    }
    const params = o.params ?? {};
    const kind = o.kind;
    const touchesGeometry = params.geometry !== undefined;
    if (kind === 'mesh' || (o.op === 'update' && (params.primitive !== undefined || touchesGeometry))) {
      const custom = hasCustomGeometry(params);
      // An 'add' mesh needs a shape: a named primitive OR custom geometry.
      if (o.op === 'add' && !custom && !(MESH_PRIMITIVES as readonly string[]).includes(params.primitive as string)) {
        problems.set(`${o.id}:primitive`, `'${o.id}': mesh needs params.primitive — one of ${MESH_PRIMITIVES.join(', ')} — or params.geometry: { positions, indices?, normals? }`);
      }
      // Validate custom geometry whenever it is present (add or deforming update).
      if (touchesGeometry) {
        for (const p of validateGeometry(o.id, params.geometry)) problems.set(p[0], p[1]);
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
      for (const k of ['metalness', 'roughness'] as const) {
        if (params[k] !== undefined && (typeof params[k] !== 'number' || (params[k] as number) < 0 || (params[k] as number) > 1)) {
          problems.set(`${o.id}:${k}`, `'${o.id}': params.${k} must be a number 0..1`);
        }
      }
      if (params.texture !== undefined && typeof params.texture !== 'string') {
        problems.set(`${o.id}:texture`, `'${o.id}': params.texture must be a URL, data-URI, or 'surface:<surfaceId>'`);
      }
      if (params.billboard !== undefined && typeof params.billboard !== 'boolean') {
        problems.set(`${o.id}:billboard`, `'${o.id}': params.billboard must be true|false`);
      }
      if (params.occlude !== undefined && typeof params.occlude !== 'boolean') {
        problems.set(`${o.id}:occlude`, `'${o.id}': params.occlude must be true|false (false = draw on top, not clipped to the window)`);
      }
      if (params.drawMode !== undefined && !(DRAW_MODES as readonly string[]).includes(params.drawMode as string)) {
        problems.set(`${o.id}:drawMode`, `'${o.id}': params.drawMode must be one of ${DRAW_MODES.join(', ')}`);
      }
      if (params.pointSize !== undefined && typeof params.pointSize !== 'number') {
        problems.set(`${o.id}:pointSize`, `'${o.id}': params.pointSize must be a number (px)`);
      }
      if (params.instances !== undefined) {
        if (!Array.isArray(params.instances)) {
          problems.set(`${o.id}:instances`, `'${o.id}': params.instances must be an array of { position, scale?, rotation?, color? }`);
        } else {
          for (let i = 0; i < params.instances.length; i++) {
            const inst = params.instances[i] as Record<string, unknown>;
            if (!inst || typeof inst !== 'object' || !isVec3(inst.position)) {
              problems.set(`${o.id}:instances`, `'${o.id}': instances[${i}] needs a position [x, y, z]`);
              break;
            }
          }
        }
      }
    }
    if (kind === 'canvas' || (o.op === 'update' && (params.commands !== undefined || params.rect !== undefined))) {
      const rect = params.rect as Record<string, unknown> | undefined;
      if (rect !== undefined) {
        if (!rect || typeof rect !== 'object'
          || typeof rect.x !== 'number' || typeof rect.y !== 'number'
          || typeof rect.width !== 'number' || (rect.width as number) <= 0
          || typeof rect.height !== 'number' || (rect.height as number) <= 0) {
          problems.set(`${o.id}:rect`, `'${o.id}': canvas params.rect must be { x, y, width > 0, height > 0 } in window px from the top-left`);
        }
      } else if (o.op === 'add') {
        for (const dim of ['width', 'height'] as const) {
          if (typeof params[dim] !== 'number' || (params[dim] as number) <= 0) {
            problems.set(`${o.id}:${dim}`, `'${o.id}': canvas needs numeric params.${dim} > 0 (the layer's pixel size; transform.scale multiplies it) — or params.rect { x, y, width, height } for window-absolute placement`);
          }
        }
      }
      if (params.backdrop !== undefined && typeof params.backdrop !== 'boolean') {
        problems.set(`${o.id}:backdrop`, `'${o.id}': params.backdrop must be true|false (true pins the layer behind ALL meshes, like the window's own content plane)`);
      }
      if (params.commands !== undefined) {
        if (!Array.isArray(params.commands)) {
          problems.set(`${o.id}:commands`, `'${o.id}': params.commands must be an array of { type, params } 2D draw commands (same vocabulary as a canvas widget's draw)`);
        } else {
          for (let i = 0; i < params.commands.length; i++) {
            const c = params.commands[i] as Record<string, unknown> | null;
            if (!c || typeof c !== 'object' || typeof c.type !== 'string') {
              problems.set(`${o.id}:commands`, `'${o.id}': params.commands[${i}] must be an object with a string 'type' (e.g. { type: 'text', params: { x, y, text, fill } })`);
              break;
            }
          }
        }
      }
      if (params.opacity !== undefined && typeof params.opacity !== 'number') {
        problems.set(`${o.id}:opacity`, `'${o.id}': params.opacity must be a number 0..1`);
      }
      if (params.radius !== undefined && typeof params.radius !== 'number') {
        problems.set(`${o.id}:radius`, `'${o.id}': params.radius must be a number (px corner rounding)`);
      }
      if (params.occlude !== undefined && typeof params.occlude !== 'boolean') {
        problems.set(`${o.id}:occlude`, `'${o.id}': params.occlude must be true|false (false = draw on top, not clipped to the window)`);
      }
    }
    if (kind === 'light') {
      if (o.op === 'add' && !(LIGHT_TYPES as readonly string[]).includes(params.lightType as string)) {
        problems.set(`${o.id}:lightType`, `'${o.id}': light needs params.lightType — one of ${LIGHT_TYPES.join(', ')}`);
      }
      if (params.color !== undefined && !isSceneColor(params.color)) {
        problems.set(`${o.id}:lightColor`, `'${o.id}': light params.color must be a color or $token`);
      }
      if (params.direction !== undefined && !isVec3(params.direction)) {
        problems.set(`${o.id}:direction`, `'${o.id}': light params.direction must be [x, y, z]`);
      }
      for (const k of ['intensity', 'range', 'angle', 'penumbra'] as const) {
        if (params[k] !== undefined && typeof params[k] !== 'number') {
          problems.set(`${o.id}:${k}`, `'${o.id}': light params.${k} must be a number`);
        }
      }
      // Intensity is a LINEAR MULTIPLIER on the light's color, not a
      // photometric quantity. Generators reach for watts/lumens/candela
      // (intensity: 1600) which multiplies every channel far past white, so
      // every lit mesh clips to pure white regardless of its own color — the
      // albedo is simply gone. Reject loudly rather than render a white scene.
      if (typeof params.intensity === 'number'
        && (params.intensity < 0 || params.intensity > MAX_LIGHT_INTENSITY)) {
        problems.set(
          `${o.id}:intensity`,
          `'${o.id}': light params.intensity must be 0..${MAX_LIGHT_INTENSITY} — it is a LINEAR MULTIPLIER on params.color (1 = the color at full strength; typical keys 0.8-1.6, fills 0.3-0.6), NOT watts/lumens/candela. Got ${params.intensity}, which multiplies every channel past white and renders every lit mesh pure white. To light a LARGER scene use params.range (how far the light reaches, in world px) — never a bigger intensity.`,
        );
      }
      if (params.castShadow !== undefined && typeof params.castShadow !== 'boolean') {
        problems.set(`${o.id}:castShadow`, `'${o.id}': light params.castShadow must be true|false (directional lights only)`);
      }
    }
    if (kind === 'environment') {
      if (params.ambient !== undefined && !isSceneColor(params.ambient)) {
        problems.set(`${o.id}:ambient`, `'${o.id}': environment params.ambient must be a color or $token`);
      }
      if (params.fog !== undefined) {
        const fog = params.fog as Record<string, unknown> | null;
        if (!fog || typeof fog !== 'object') {
          problems.set(`${o.id}:fog`, `'${o.id}': environment params.fog must be { color?, near, far }`);
        } else {
          if (fog.color !== undefined && !isSceneColor(fog.color)) {
            problems.set(`${o.id}:fogColor`, `'${o.id}': fog.color must be a color or $token`);
          }
          if (typeof fog.near !== 'number' || typeof fog.far !== 'number') {
            problems.set(`${o.id}:fogRange`, `'${o.id}': fog needs numeric near and far — SCENE-relative depth in px behind the content (small values, e.g. near 0, far 400), NOT camera distance`);
          }
        }
      }
      if (params.bloom !== undefined && params.bloom !== true && params.bloom !== false) {
        const b = params.bloom as Record<string, unknown> | null;
        if (!b || typeof b !== 'object'
          || (b.threshold !== undefined && typeof b.threshold !== 'number')
          || (b.intensity !== undefined && typeof b.intensity !== 'number')) {
          problems.set(`${o.id}:bloom`, `'${o.id}': environment params.bloom must be true or { threshold?, intensity? }`);
        }
      }
    }
  }
  return [...problems.values()];
}
