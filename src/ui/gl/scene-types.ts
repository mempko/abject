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

import { EASING_NAMES, isEasingSpec } from './anim-tracks.js';
import { MAX_GPU_PARTICLES } from './gpu-particles.js';

export const SCENE_NODE_KINDS = ['group', 'mesh', 'light', 'environment', 'canvas', 'particles', 'camera', 'model', 'text', 'label', 'line', 'sky'] as const;
export type SceneNodeKind = typeof SCENE_NODE_KINDS[number];

export const MESH_PRIMITIVES = [
  'plane', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'icosphere', 'ring',
  // Parametric: options in params.shape (see SHAPE_PARAM_HELP).
  'capsule', 'roundedBox', 'grid', 'tube', 'lathe', 'extrude',
] as const;
export type MeshPrimitive = typeof MESH_PRIMITIVES[number];

export const LIGHT_TYPES = ['point', 'directional', 'spot', 'hemisphere'] as const;

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

/** How a material turns light into colour (mesh, model, text and line nodes). */
export const SHADING_MODES = ['standard', 'unlit', 'toon', 'matcap', 'rim'] as const;
/** 'additive' adds light over what is behind (glows, holograms) instead of covering it. */
export const BLEND_MODES = ['normal', 'additive'] as const;
/** Environment tone mapping; 'neutral' (the default) keeps colours exact below a soft highlight knee. */
export const TONE_MAPPINGS = ['neutral', 'aces', 'agx', 'none'] as const;
export const FOG_MODES = ['linear', 'exp', 'exp2'] as const;
export const SHADOW_MAP_SIZES = [512, 1024, 2048, 4096] as const;
/** Material texture maps: URL, data-URI, or 'surface:<surfaceId>'. */
export const MATERIAL_MAPS = ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'matcap'] as const;
/** Node kinds that carry a material. */
export const MATERIAL_NODE_KINDS = ['mesh', 'model', 'text', 'line'] as const;

/** Declarative animation channels and presets carried in an 'animate' op's params. */
export const ANIM_CHANNELS = ['position', 'rotation', 'scale', 'color', 'emissive', 'opacity'] as const;
/**
 * spin/orbit/bob/pulse loop; shake (a decaying jolt), flash (emissive to
 * params.color, default the living light, and back) and float (a slow drift
 * with a gentle turn) are the game-UI additions. wobble (a jelly twist after
 * a hit), breathe (a slow living swell) and hover (lift toward the viewer)
 * are data presets (MOTION_PRESETS in anim-tracks.ts). All run client-side.
 */
export const ANIM_PRESETS = ['spin', 'orbit', 'bob', 'pulse', 'shake', 'flash', 'float', 'wobble', 'breathe', 'hover'] as const;

/** Mouse buttons a camera node's orbit can take. */
export const CAMERA_BUTTONS = ['left', 'middle', 'right'] as const;

/**
 * World-scope layers. 'back' draws behind every window, 'front' above them,
 * and 'stack' puts a ROOT world node (with its subtree) into the window
 * stacking order at its params.zIndex, so it sits between windows.
 */
export const WORLD_LAYERS = ['back', 'front', 'stack'] as const;

/**
 * Window-scope clipping. 'content' (the default) clips to the content rect
 * below the title bar, 'window' to the whole window including the title
 * bar, and 'none' pops the node out (unclipped, depth-tested against the
 * windows above). `occlude: false` is the older spelling of 'none'.
 */
export const CLIP_MODES = ['content', 'window', 'none'] as const;
export type ClipMode = typeof CLIP_MODES[number];

/** Drag planes (in the dragged node's parent space) and single-axis constraints. */
export const DRAG_PLANES = ['xy', 'xz', 'yz'] as const;
export const DRAG_AXES = ['x', 'y', 'z'] as const;

/**
 * Stacked world objects stay below this zIndex: system rails (the dock,
 * dialogs, the command palette, notifications) live at or above it.
 */
export const RAIL_Z_THRESHOLD = 999;

/**
 * Where a window may pin itself on a zoomable camera (the phone): the
 * window keeps to this spot of the SCREEN at a readable scale while the
 * camera pans and zooms over the desktop (toasts, HUDs). The desktop at
 * zoom 1 ignores it. Pinned windows sharing an anchor keep their layout
 * relative to each other (a stack of toasts stays a stack).
 */
export const SCREEN_ANCHORS = [
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
] as const;
export type ScreenAnchor = typeof SCREEN_ANCHORS[number];

/** Whether a value names a screen anchor (see SCREEN_ANCHORS). */
export function isScreenAnchor(v: unknown): v is ScreenAnchor {
  return typeof v === 'string' && (SCREEN_ANCHORS as readonly string[]).includes(v);
}

/** Parsed `draggable` param (true = every default). */
export interface DragSpec {
  plane: 'xy' | 'xz' | 'yz';
  axis?: 'x' | 'y' | 'z';
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  snap?: number;
  inertia: boolean;
}

/** Parse a node's own `draggable` param; undefined when the node is not draggable. */
export function parseDraggable(v: unknown): DragSpec | undefined {
  if (v === true) return { plane: 'xy', inertia: false };
  if (!v || typeof v !== 'object') return undefined;
  const d = v as Record<string, unknown>;
  const b = d.bounds as { min?: unknown; max?: unknown } | undefined;
  return {
    plane: (DRAG_PLANES as readonly string[]).includes(d.plane as string) ? d.plane as DragSpec['plane'] : 'xy',
    axis: (DRAG_AXES as readonly string[]).includes(d.axis as string) ? d.axis as DragSpec['axis'] : undefined,
    bounds: b && isVec3(b.min) && isVec3(b.max)
      ? { min: b.min as [number, number, number], max: b.max as [number, number, number] } : undefined,
    snap: typeof d.snap === 'number' && d.snap > 0 ? d.snap : undefined,
    inertia: d.inertia === true,
  };
}

/** Effective clip mode from resolved params (`clip` wins, then `occlude: false`). */
export function clipModeOf(params: Record<string, unknown>): ClipMode {
  const c = params.clip;
  if (c === 'content' || c === 'window' || c === 'none') return c;
  return params.occlude === false ? 'none' : 'content';
}

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
   * - mesh primitives capsule, roundedBox, grid, tube, lathe, extrude take
   *          their options in params.shape (see SHAPE_PARAM_HELP).
   * - model: { src (URL, data-URI, or abx:sha256 ref), animation?, loop?,
   *          speed?, playing?, fit?, material overrides } glTF 2.0 / GLB.
   * - text:  { text, font?, size?, depth?, bevel?, align?, lineHeight? } plus
   *          material params: extruded 3D text.
   * - label: { text, font?, size?, color?, background?, padding?, radius?,
   *          maxWidth?, align?, screenSpace?, anchor? }: crisp 2D text facing
   *          the camera.
   * - line:  { points, width?, color?, colors?, widths?, closed?, dashed?,
   *          join?, cap?, blend?, ribbon? }: thick lines (screen px wide).
   * - sky:   { top?, horizon?, bottom?, sun?, stars?, texture?, rotation? }:
   *          a dome behind the rest of its subtree.
   * - any node: trail?: true | { length?, width?, color?, lifetime?,
   *          minDistance? } leaves a fading ribbon behind it.
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
  /**
   * Shape language subset (mirrors tokens.shape). Optional: absent means the
   * soft legacy chrome (blurred shadows, accent focus halo, abyss backdrop).
   */
  shape?: {
    shadowStyle: 'soft' | 'block';
    blockShadowOffset: number;
    blockShadowColor: string;
    blockFocusColor: string;
    ruleWidth: number;
    ornament: 'none' | 'constructivist' | 'sigil';
    backdrop: 'abyss' | 'constructivist' | 'sigil';
  };
  /** Font families for client-drawn chrome text (overview cards). Optional. */
  fonts?: { body: string; display: string; mono: string };
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
  material: 'nest a preset name under params: { material: \'gold\' }, or put the color in params.color',
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

/** Validate an animate op's `keyframes`: [{ t (ms from start), value, easing? }, ...]. */
function validateKeyframes(id: string, channel: string, keyframes: unknown): Array<[string, string]> {
  const shape = channel === 'color' || channel === 'emissive' ? 'a color or $token'
    : channel === 'opacity' ? 'a number 0..1'
    : channel === 'scale' ? 'a number or [x, y, z]'
    : '[x, y, z]';
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    return [[`${id}:keyframes`, `'${id}': animate keyframes must be a non-empty array of { t (ms from the start), value (${shape}), easing? }`]];
  }
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i] as Record<string, unknown> | null;
    if (!k || typeof k !== 'object' || typeof k.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) {
      return [[`${id}:keyframes`, `'${id}': keyframes[${i}] needs t: a number of ms from the start (>= 0)`]];
    }
    const v = k.value;
    const ok = channel === 'color' || channel === 'emissive' ? isSceneColor(v)
      : channel === 'opacity' ? typeof v === 'number'
      : channel === 'scale' ? (typeof v === 'number' || isVec3(v))
      : isVec3(v);
    if (!ok) return [[`${id}:keyframes`, `'${id}': keyframes[${i}].value for channel '${channel}' must be ${shape}`]];
    if (k.easing !== undefined && !isEasingSpec(k.easing)) {
      return [[`${id}:keyframes`, `'${id}': keyframes[${i}].easing must be one of ${EASING_NAMES.join(', ')} or a cubic-bezier [x1, y1, x2, y2] (it shapes the segment starting at this key)`]];
    }
  }
  return [];
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
    const hasKeyframes = params.keyframes !== undefined;
    const hasTarget = params.to !== undefined || Array.isArray(params.path) || hasKeyframes;
    if (!hasTarget) {
      out.push([`${id}:to`, `'${id}': animate channel '${String(params.channel)}' needs a 'to' value (or a 'path' for position, or 'keyframes': [{ t, value, easing? }])`]);
    }
    if (params.to !== undefined && isColorCh && !isSceneColor(params.to)) {
      out.push([`${id}:to`, `'${id}': animate ${String(params.channel)} 'to' must be a color or $token`]);
    }
    if (hasKeyframes) for (const p of validateKeyframes(id, params.channel as string, params.keyframes)) out.push(p);
    if (params.spring !== undefined) {
      const sp = params.spring as Record<string, unknown> | null;
      const num = (k: string, min: number) => sp![k] === undefined || (typeof sp![k] === 'number' && Number.isFinite(sp![k]) && (sp![k] as number) >= min);
      if (params.spring !== true && !(sp && typeof sp === 'object' && !Array.isArray(sp)
        && num('stiffness', 0.001) && num('damping', 0) && num('mass', 0.001))) {
        out.push([`${id}:spring`, `'${id}': animate spring must be true or { stiffness? (170), damping? (26), mass? (1) } with positive numbers; it moves the channel to 'to' with spring physics, and a new 'to' retargets it keeping its speed`]);
      }
      if (params.to === undefined) {
        out.push([`${id}:springTo`, `'${id}': a spring animate needs a 'to' value (the target it springs toward)`]);
      }
    }
  }
  if (params.duration !== undefined && (typeof params.duration !== 'number' || params.duration <= 0)) {
    out.push([`${id}:duration`, `'${id}': animate duration must be a positive number (ms)`]);
  }
  return out;
}

/**
 * Validate the constraint params any node may carry (lookAt, follow) and a
 * camera node's params. Only these NEW params are checked, so inputs that
 * validated before still do.
 */
function validateMotionParams(id: string, params: Record<string, unknown>, kind: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const la = params.lookAt;
  if (la !== undefined && la !== null && !isVec3(la)
    && !(typeof la === 'object' && !Array.isArray(la) && typeof (la as Record<string, unknown>).node === 'string')) {
    out.push([`${id}:lookAt`, `'${id}': params.lookAt must be [x, y, z] (in the node's parent space) or { node: '<id>' } (another node of the same scene); the node turns so its local +z points at it. null clears it`]);
  }
  const f = params.follow as Record<string, unknown> | null | undefined;
  if (f !== undefined && f !== null) {
    if (typeof f !== 'object' || Array.isArray(f) || typeof f.node !== 'string'
      || (f.offset !== undefined && !isVec3(f.offset))
      || (f.stiffness !== undefined && !(isFiniteNum(f.stiffness) && f.stiffness > 0 && f.stiffness <= 1))) {
      out.push([`${id}:follow`, `'${id}': params.follow must be { node: '<id>', offset?: [x, y, z], stiffness?: 0..1 (share of the gap closed per 60 fps frame, default 0.15) }; null clears it`]);
    }
  }
  if (kind === 'camera') {
    if (params.fov !== undefined && !(isFiniteNum(params.fov) && params.fov >= 1 && params.fov <= 170)) {
      out.push([`${id}:fov`, `'${id}': camera params.fov must be the vertical field of view in DEGREES, 1..170 (the desktop uses 30)`]);
    }
    if (params.target !== undefined && !isVec3(params.target)) {
      out.push([`${id}:target`, `'${id}': camera params.target must be [x, y, z], the point it looks at (window px from the window centre, same space as transform.position)`]);
    }
    const orbit = params.orbit;
    if (orbit !== undefined && typeof orbit !== 'boolean') {
      const ob = orbit as Record<string, unknown> | null;
      const okNum = (k: string) => ob![k] === undefined || isFiniteNum(ob![k]);
      if (!ob || typeof ob !== 'object' || Array.isArray(ob)
        || (ob.button !== undefined && !(CAMERA_BUTTONS as readonly string[]).includes(ob.button as string))
        || !['minDistance', 'maxDistance', 'minPitch', 'maxPitch', 'damping'].every(okNum)) {
        out.push([`${id}:orbit`, `'${id}': camera params.orbit must be true or { button?: ${CAMERA_BUTTONS.join('|')} ('left'), minDistance?, maxDistance? (px), minPitch?, maxPitch? (radians, + looks down from above), damping? (0..1 coasting loss per frame, 1 = none) }`]);
      }
    }
    if (params.zoom !== undefined && typeof params.zoom !== 'boolean') {
      out.push([`${id}:zoom`, `'${id}': camera params.zoom must be true|false (true: the mouse wheel dollies the camera)`]);
    }
    const vp = params.viewport as Record<string, unknown> | undefined;
    if (vp !== undefined && !(vp && typeof vp === 'object' && isFiniteNum(vp.x) && isFiniteNum(vp.y)
      && isFiniteNum(vp.width) && vp.width > 0 && isFiniteNum(vp.height) && vp.height > 0)) {
      out.push([`${id}:viewport`, `'${id}': camera params.viewport must be { x, y, width, height } in window px from the top-left (where drags orbit; default the content area)`]);
    }
  }
  return out;
}

/**
 * Validate the interaction and placement params any node kind may carry
 * (draggable, raiseOnClick, focusable, cursor, clip, zIndex). Returns
 * [key, message] pairs. Only these NEW params are checked here, so inputs
 * that validated before still do.
 */
function validateInteraction(id: string, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const d = params.draggable;
  if (d !== undefined && typeof d !== 'boolean') {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      out.push([`${id}:draggable`, `'${id}': params.draggable must be true, false, or { plane?: 'xy'|'xz'|'yz', axis?: 'x'|'y'|'z', bounds?: { min: [x,y,z], max: [x,y,z] }, snap?: px, inertia?: boolean } (positions are in the node's parent space)`]);
    } else {
      const o = d as Record<string, unknown>;
      const known = new Set(['plane', 'axis', 'bounds', 'snap', 'inertia']);
      for (const k of Object.keys(o)) {
        if (!known.has(k)) out.push([`${id}:draggable.${k}`, `'${id}': params.draggable.${k} is not part of the drag vocabulary (plane, axis, bounds, snap, inertia)`]);
      }
      if (o.plane !== undefined && !(DRAG_PLANES as readonly string[]).includes(o.plane as string)) {
        out.push([`${id}:draggable.plane`, `'${id}': params.draggable.plane must be one of ${DRAG_PLANES.join(', ')} (the plane in the node's parent space that the node slides on; 'xy' faces the viewer)`]);
      }
      if (o.axis !== undefined && !(DRAG_AXES as readonly string[]).includes(o.axis as string)) {
        out.push([`${id}:draggable.axis`, `'${id}': params.draggable.axis must be one of ${DRAG_AXES.join(', ')} (locks the drag to one parent-space axis)`]);
      }
      if (o.bounds !== undefined) {
        const b = o.bounds as Record<string, unknown> | null;
        const ok = !!b && typeof b === 'object' && isVec3(b.min) && isVec3(b.max)
          && (b.min as number[]).every((v, i) => v <= (b.max as number[])[i]);
        if (!ok) out.push([`${id}:draggable.bounds`, `'${id}': params.draggable.bounds must be { min: [x, y, z], max: [x, y, z] } with min <= max on every axis (parent-space px the node's position stays within)`]);
      }
      if (o.snap !== undefined && !(typeof o.snap === 'number' && Number.isFinite(o.snap) && o.snap > 0)) {
        out.push([`${id}:draggable.snap`, `'${id}': params.draggable.snap must be a positive number (grid size in px the dropped position rounds to)`]);
      }
      if (o.inertia !== undefined && typeof o.inertia !== 'boolean') {
        out.push([`${id}:draggable.inertia`, `'${id}': params.draggable.inertia must be true|false (true: a flick keeps the node gliding after release)`]);
      }
    }
  }
  for (const k of ['raiseOnClick', 'focusable'] as const) {
    if (params[k] !== undefined && typeof params[k] !== 'boolean') {
      out.push([`${id}:${k}`, `'${id}': params.${k} must be true|false`]);
    }
  }
  if (params.cursor !== undefined
    && !(typeof params.cursor === 'string' && /^[a-z][a-z0-9-]*$/.test(params.cursor))) {
    out.push([`${id}:cursor`, `'${id}': params.cursor must be a CSS cursor keyword such as 'pointer', 'grab', 'move', 'crosshair', 'text' or 'not-allowed'`]);
  }
  if (params.clip !== undefined && !(CLIP_MODES as readonly string[]).includes(params.clip as string)) {
    out.push([`${id}:clip`, `'${id}': params.clip must be one of ${CLIP_MODES.join(', ')} ('content' = clipped below the title bar, the default; 'window' = clipped to the whole window; 'none' = pops out of the window). Window scope only`]);
  }
  if (params.zIndex !== undefined
    && !(typeof params.zIndex === 'number' && Number.isFinite(params.zIndex) && params.zIndex < RAIL_Z_THRESHOLD)) {
    out.push([`${id}:zIndex`, `'${id}': params.zIndex must be a number below ${RAIL_Z_THRESHOLD} (stacking position among windows for a layer:'stack' root; system rails stay above). Omit it to place the node just above the current windows`]);
  }
  return out;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a node's material params (mesh, model, text and line nodes, and
 * updates of any node). Only params new to the vocabulary are checked here,
 * so inputs that validated before still do. Returns [key, message] pairs.
 */
function validateMaterial(id: string, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const bad = (k: string, msg: string) => out.push([`${id}:${k}`, `'${id}': params.${k} ${msg}`]);
  if (params.material !== undefined && !(typeof params.material === 'string' && params.material.length > 0)) {
    bad('material', `must be the NAME of a material preset, e.g. 'gold', 'glass', 'neon' (list them with the SceneLibrary's listMaterials); put colours and numbers on the node itself`);
  }
  if (params.shading !== undefined && !(SHADING_MODES as readonly string[]).includes(params.shading as string)) {
    bad('shading', `must be one of ${SHADING_MODES.join(', ')} ('unlit' = flat colour, 'toon' = cel bands, 'matcap' = sphere-mapped studio look, 'rim' = see-through hologram glow)`);
  }
  if (params.blend !== undefined && !(BLEND_MODES as readonly string[]).includes(params.blend as string)) {
    bad('blend', `must be 'normal' or 'additive' (additive adds light over what is behind, for glows)`);
  }
  for (const k of MATERIAL_MAPS) {
    if (params[k] !== undefined && !(typeof params[k] === 'string' && (params[k] as string).length > 0)) {
      bad(k, `must be an image URL, a data-URI, or 'surface:<surfaceId>'`);
    }
  }
  for (const k of ['uvRepeat', 'uvOffset'] as const) {
    const v = params[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every(isFiniteNum))) {
      bad(k, `must be [u, v] numbers (${k === 'uvRepeat' ? 'tiles across the surface, e.g. [4, 4]' : 'shift in texture widths, e.g. [0.5, 0]'})`);
    }
  }
  if (params.normalScale !== undefined && !isFiniteNum(params.normalScale)) bad('normalScale', 'must be a number (1 = the map as drawn, 0 = flat, negative inverts the bumps)');
  for (const k of ['clearcoat', 'clearcoatRoughness', 'sheen', 'transmission'] as const) {
    const v = params[k];
    if (v !== undefined && !(isFiniteNum(v) && v >= 0 && v <= 1)) bad(k, 'must be a number 0..1');
  }
  for (const k of ['sheenColor', 'rimColor'] as const) {
    if (params[k] !== undefined && !isSceneColor(params[k])) bad(k, 'must be a color or $token');
  }
  if (params.ior !== undefined && !(isFiniteNum(params.ior) && params.ior >= 1 && params.ior <= 3)) bad('ior', 'must be a number 1..3 (glass 1.5, water 1.33, diamond 2.4)');
  if (params.envIntensity !== undefined && !(isFiniteNum(params.envIntensity) && params.envIntensity >= 0 && params.envIntensity <= 10)) {
    bad('envIntensity', 'must be a number 0..10 (how strongly the environment reflects; 1 = as lit)');
  }
  if (params.toonSteps !== undefined && !(Number.isInteger(params.toonSteps) && (params.toonSteps as number) >= 1 && (params.toonSteps as number) <= 16)) {
    bad('toonSteps', 'must be a whole number 1..16 (light bands for shading: toon)');
  }
  if (params.outline !== undefined && typeof params.outline !== 'boolean') {
    const o = params.outline;
    const ok = isPlainObject(o) && Object.keys(o).every((k) => k === 'color' || k === 'width')
      && (o.color === undefined || isSceneColor(o.color))
      && (o.width === undefined || (isFiniteNum(o.width) && o.width >= 0 && o.width <= 64));
    if (!ok) bad('outline', 'must be true, false, or { color?, width? (screen px 0..64) }');
  }
  if (params.rimPower !== undefined && !(isFiniteNum(params.rimPower) && params.rimPower > 0 && params.rimPower <= 16)) {
    bad('rimPower', 'must be a number above 0 (up to 16; higher = a thinner rim)');
  }
  if (params.receiveShadow !== undefined && typeof params.receiveShadow !== 'boolean') bad('receiveShadow', 'must be true|false');
  if (params.castShadow !== undefined && typeof params.castShadow !== 'boolean') bad('castShadow', 'must be true|false');
  return out;
}

/** Validate the light params new to the vocabulary (hemisphere ground colour, shadow settings). */
function validateLightExtras(id: string, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (params.groundColor !== undefined && !isSceneColor(params.groundColor)) {
    out.push([`${id}:groundColor`, `'${id}': light params.groundColor must be a color or $token (the hemisphere light's colour from below)`]);
  }
  if (params.shadow !== undefined) {
    const sh = params.shadow;
    const msg = `'${id}': light params.shadow must be { size?: ${SHADOW_MAP_SIZES.join('|')}, softness?: px 0..32, bias?: number -0.05..0.05 } (set castShadow: true to turn shadows on)`;
    if (!isPlainObject(sh) || !Object.keys(sh).every((k) => k === 'size' || k === 'softness' || k === 'bias')
      || (sh.size !== undefined && !(SHADOW_MAP_SIZES as readonly number[]).includes(sh.size as number))
      || (sh.softness !== undefined && !(isFiniteNum(sh.softness) && sh.softness >= 0 && sh.softness <= 32))
      || (sh.bias !== undefined && !(isFiniteNum(sh.bias) && Math.abs(sh.bias) <= 0.05))) {
      out.push([`${id}:shadow`, msg]);
    }
  }
  return out;
}

/** Validate an environment node's mood params (look, tone mapping, sky, env map, grading). */
function validateEnvironmentMood(id: string, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const bad = (k: string, msg: string) => out.push([`${id}:${k}`, `'${id}': environment params.${k} ${msg}`]);
  if (params.look !== undefined && !(typeof params.look === 'string' && params.look.length > 0)) {
    bad('look', `must be the NAME of a look preset, e.g. 'studio', 'sunset', 'night' (list them with the SceneLibrary's listLooks)`);
  }
  if (params.toneMapping !== undefined && !(TONE_MAPPINGS as readonly string[]).includes(params.toneMapping as string)) {
    bad('toneMapping', `must be one of ${TONE_MAPPINGS.join(', ')} ('neutral', the default, keeps colours exact below a soft highlight knee; 'aces' and 'agx' are filmic)`);
  }
  if (params.exposure !== undefined && !(isFiniteNum(params.exposure) && params.exposure > 0 && params.exposure <= 16)) {
    bad('exposure', 'must be a number above 0 (up to 16; 1 = unchanged, 2 = twice the light)');
  }
  if (params.envMap !== undefined && !(typeof params.envMap === 'string' && params.envMap.length > 0)) {
    bad('envMap', 'must be an equirectangular image URL or data-URI');
  }
  if (params.envIntensity !== undefined && !(isFiniteNum(params.envIntensity) && params.envIntensity >= 0 && params.envIntensity <= 10)) {
    bad('envIntensity', 'must be a number 0..10 (1 = as given)');
  }
  if (params.sky !== undefined) {
    const sky = params.sky;
    const skyMsg = `must be { top?, horizon?, bottom? (colors), sun?: { direction: [x, y, z] toward the sun (y-down: negative y is up), color?, intensity? 0..10, size? degrees 0..90 } }`;
    if (!isPlainObject(sky) || !Object.keys(sky).every((k) => ['top', 'horizon', 'bottom', 'sun'].includes(k))
      || ['top', 'horizon', 'bottom'].some((k) => sky[k] !== undefined && !isSceneColor(sky[k]))) {
      bad('sky', skyMsg);
    } else if (sky.sun !== undefined) {
      const sun = sky.sun;
      if (!isPlainObject(sun) || !isVec3(sun.direction)
        || !Object.keys(sun).every((k) => ['direction', 'color', 'intensity', 'size'].includes(k))
        || (sun.color !== undefined && !isSceneColor(sun.color))
        || (sun.intensity !== undefined && !(isFiniteNum(sun.intensity) && sun.intensity >= 0 && sun.intensity <= 10))
        || (sun.size !== undefined && !(isFiniteNum(sun.size) && sun.size >= 0 && sun.size <= 90))) {
        bad('sky', skyMsg);
      }
    }
  }
  // Post effects: each turns on just by being set.
  const onOrObject = (k: string, fields: Record<string, (v: unknown) => boolean>, shape: string) => {
    const v = params[k];
    if (v === undefined || typeof v === 'boolean') return;
    if (!isPlainObject(v) || !Object.keys(v).every((f) => f in fields && (v[f] === undefined || fields[f](v[f])))) {
      bad(k, `must be true or ${shape}`);
    }
  };
  const inRange = (lo: number, hi: number) => (v: unknown) => isFiniteNum(v) && v >= lo && v <= hi;
  onOrObject('ao', { radius: inRange(1, 500), intensity: inRange(0, 10) }, '{ radius? (world px the occlusion reaches, e.g. 28), intensity? (0..10, 1 = natural) }');
  onOrObject('outline', { color: (v) => isSceneColor(v), width: inRange(0, 8) }, '{ color?, width? (screen px 0..8) } (edge lines where depth jumps or folds)');
  onOrObject('lightShafts', { intensity: inRange(0, 10), decay: inRange(0, 1) }, '{ intensity? (0..10), decay? (0..1, how fast the rays fade) } (rays from the sky sun or the brightest light)');
  if (params.dof !== undefined) {
    const d = params.dof;
    if (!isPlainObject(d) || !Object.keys(d).every((k) => ['focus', 'range', 'aperture'].includes(k))
      || (d.focus !== undefined && !isFiniteNum(d.focus))
      || (d.range !== undefined && !(isFiniteNum(d.range) && d.range > 0))
      || (d.aperture !== undefined && !(isFiniteNum(d.aperture) && d.aperture >= 0 && d.aperture <= 64))) {
      bad('dof', 'must be { focus? (px behind the content plane that stays sharp; 0 = the window\'s own plane), range? (px of depth around it that stays sharp), aperture? (max blur in screen px, 0..64) }');
    }
  }
  if (params.chromaticAberration !== undefined && !(isFiniteNum(params.chromaticAberration) && params.chromaticAberration >= 0 && params.chromaticAberration <= 32)) {
    bad('chromaticAberration', 'must be a number 0..32 (screen px of colour fringing at the corners)');
  }
  if (params.fxaa !== undefined && typeof params.fxaa !== 'boolean') bad('fxaa', 'must be true|false');
  if (isPlainObject(params.bloom)) {
    const b = params.bloom;
    if ((b.radius !== undefined && !(isFiniteNum(b.radius) && b.radius >= 0.25 && b.radius <= 8))
      || (b.quality !== undefined && !(['low', 'medium', 'high'].includes(b.quality as string) || (Number.isInteger(b.quality) && (b.quality as number) >= 1 && (b.quality as number) <= 8)))) {
      bad('bloom', 'radius must be 0.25..8 (glow spread) and quality \'low\' | \'medium\' | \'high\' or 1..8 (how far the glow reaches)');
    }
  }
  if (params.grading !== undefined) {
    const g = params.grading;
    const ok = isPlainObject(g)
      && Object.keys(g).every((k) => ['contrast', 'saturation', 'temperature', 'tint', 'vignette', 'grain'].includes(k))
      && ['contrast', 'saturation'].every((k) => g[k] === undefined || (isFiniteNum(g[k]) && (g[k] as number) >= 0 && (g[k] as number) <= 4))
      && ['temperature', 'tint'].every((k) => g[k] === undefined || (isFiniteNum(g[k]) && Math.abs(g[k] as number) <= 2))
      && ['vignette', 'grain'].every((k) => g[k] === undefined || (isFiniteNum(g[k]) && (g[k] as number) >= 0 && (g[k] as number) <= 1));
    if (!ok) {
      bad('grading', 'must be { contrast?, saturation? (1 = unchanged, 0..4), temperature? (-1 cool .. 1 warm), tint? (-1 green .. 1 magenta), vignette?, grain? (0..1) }');
    }
  }
  return out;
}

/** Options each parametric mesh primitive takes in params.shape (also the help text). */
export const SHAPE_PARAM_HELP: Record<string, string> = {
  capsule: '{ radius? (0.25), length? (0.5), segments? } (scaled to a total height of 1; radius and length set proportions)',
  roundedBox: '{ radius? (0..0.5, 0.1), segments? (1..16) }',
  grid: '{ segments?: [x, y] ([16, 16]) } (a subdivided plane facing +z)',
  tube: '{ path: [[x, y, z], ...] (unit space, 2+ points), radius? (0.05), segments? (64), radialSegments? (12), closed? }',
  lathe: '{ points: [[radius, y], ...] (2+ points, revolved around y), segments? (48) }',
  extrude: '{ outline: [[x, y], ...] (3+ points), holes?: [[[x, y], ...]], depth? (0.2), bevel? (0), bevelSegments? }',
};
const SHAPE_KEYS: Record<string, string[]> = {
  capsule: ['radius', 'length', 'segments'],
  roundedBox: ['radius', 'segments'],
  grid: ['segments'],
  tube: ['path', 'radius', 'segments', 'radialSegments', 'closed'],
  lathe: ['points', 'segments'],
  extrude: ['outline', 'holes', 'depth', 'bevel', 'bevelSegments'],
};
/** Text alignment for 3D text and labels. */
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export const LINE_JOINS = ['miter', 'round'] as const;
export const LINE_CAPS = ['butt', 'round'] as const;
/** Model sources: a URL, a data-URI (GLB or glTF), or a content ref the UIServer made from one. */
export const MODEL_SRC_HELP = `a .glb/.gltf URL, a data-URI (data:model/gltf-binary;base64,...), or an 'abx:sha256:' ref (16 MB max)`;

const isPoint = (v: unknown, dims: number[]): boolean =>
  Array.isArray(v) && dims.includes(v.length) && v.every(isFiniteNum);

/**
 * Validate the params of the content kinds (model, text, label, line, sky),
 * mesh `shape` options and the `trail` param any node may carry. Only params
 * new to the vocabulary are checked, so inputs that validated before still do.
 */
function validateContent(id: string, op: SceneOp['op'], kind: string | undefined, params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const bad = (k: string, msg: string) => out.push([`${id}:${k}`, `'${id}': ${msg}`]);
  const add = op === 'add';
  const num = (k: string, lo: number, hi: number, what: string) => {
    const v = params[k];
    if (v !== undefined && !(isFiniteNum(v) && v >= lo && v <= hi)) bad(k, `params.${k} must be a number ${lo}..${hi} (${what})`);
  };
  const bool = (k: string, what: string) => {
    if (params[k] !== undefined && typeof params[k] !== 'boolean') bad(k, `params.${k} must be true|false (${what})`);
  };
  const colour = (k: string) => {
    if (params[k] !== undefined && !isSceneColor(params[k])) bad(k, `params.${k} must be a color ('#hex', 'rgb(a)') or a $token`);
  };
  const str = (k: string, max: number, what: string) => {
    const v = params[k];
    if (v !== undefined && !(typeof v === 'string' && v.length > 0 && v.length <= max)) bad(k, `params.${k} must be a non-empty string up to ${max} characters (${what})`);
  };

  // Mesh shape options (parametric primitives).
  const prim = params.primitive as string | undefined;
  if ((kind === 'mesh' || (!kind && isPlainObject(params.shape))) && params.shape !== undefined) {
    const sh = params.shape;
    const keys = prim ? SHAPE_KEYS[prim] : undefined;
    if (!isPlainObject(sh)) {
      bad('shape', `params.shape must be an object of options for the primitive, e.g. capsule ${SHAPE_PARAM_HELP.capsule}`);
    } else if (prim && !keys) {
      bad('shape', `params.shape applies to the parametric primitives (${Object.keys(SHAPE_KEYS).join(', ')}); '${prim}' takes none`);
    } else if (keys) {
      const help = `${prim} params.shape is ${SHAPE_PARAM_HELP[prim!]}`;
      for (const k of Object.keys(sh)) if (!keys.includes(k)) bad('shape', `params.shape.${k} is not a ${prim} option; ${help}`);
      for (const k of ['radius', 'length', 'depth', 'bevel'] as const) {
        if (sh[k] !== undefined && !(isFiniteNum(sh[k]) && (sh[k] as number) >= 0 && (sh[k] as number) <= 1000)) bad('shape', `params.shape.${k} must be a number >= 0; ${help}`);
      }
      for (const k of ['segments', 'radialSegments', 'bevelSegments'] as const) {
        const v = sh[k];
        if (v === undefined || (k === 'segments' && prim === 'grid')) continue;
        if (!(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 2048)) bad('shape', `params.shape.${k} must be a whole number 1..2048; ${help}`);
      }
      if (prim === 'grid' && sh.segments !== undefined) {
        const g = sh.segments;
        const ok = (Number.isInteger(g) && (g as number) >= 1 && (g as number) <= 512)
          || (Array.isArray(g) && g.length === 2 && g.every((n) => Number.isInteger(n) && n >= 1 && n <= 512));
        if (!ok) bad('shape', `params.shape.segments must be [x, y] whole numbers 1..512; ${help}`);
      }
      if (sh.closed !== undefined && typeof sh.closed !== 'boolean') bad('shape', `params.shape.closed must be true|false; ${help}`);
      if (prim === 'tube' && !(Array.isArray(sh.path) && sh.path.length >= 2 && sh.path.length <= 1024 && sh.path.every((p) => isPoint(p, [3])))) {
        bad('shape', `tube needs params.shape.path: 2..1024 points [x, y, z] in unit space (the tube's centre line); ${help}`);
      }
      if (prim === 'lathe' && !(Array.isArray(sh.points) && sh.points.length >= 2 && sh.points.length <= 1024
        && sh.points.every((p) => isPoint(p, [2]) && (p as number[])[0] >= 0))) {
        bad('shape', `lathe needs params.shape.points: 2..1024 profile points [radius >= 0, y]; ${help}`);
      }
      if (prim === 'extrude') {
        const ring = (r: unknown) => Array.isArray(r) && r.length >= 3 && r.length <= 8192 && r.every((p) => isPoint(p, [2]));
        if (!ring(sh.outline)) bad('shape', `extrude needs params.shape.outline: 3..8192 points [x, y] (unit space, y grows downward); ${help}`);
        if (sh.holes !== undefined && !(Array.isArray(sh.holes) && sh.holes.every(ring))) bad('shape', `params.shape.holes must be a list of rings, each 3+ points [x, y] inside the outline; ${help}`);
      }
    }
  } else if (kind === 'mesh' && add && prim && (prim === 'tube' || prim === 'lathe' || prim === 'extrude')) {
    bad('shape', `mesh primitive '${prim}' needs params.shape: ${SHAPE_PARAM_HELP[prim]}`);
  }

  // Trail: a fading ribbon behind any moving node.
  if (params.trail !== undefined && params.trail !== true && params.trail !== false) {
    const t = params.trail;
    const help = `params.trail must be true or { length? (points kept, 2..512), width? (px, world), color?, lifetime? (ms a point lasts), minDistance? (px between points) }`;
    if (!isPlainObject(t) || !Object.keys(t).every((k) => ['length', 'width', 'color', 'lifetime', 'minDistance', 'blend', 'opacity'].includes(k))
      || (t.length !== undefined && !(Number.isInteger(t.length) && (t.length as number) >= 2 && (t.length as number) <= 512))
      || (t.width !== undefined && !(isFiniteNum(t.width) && t.width > 0 && t.width <= 512))
      || (t.color !== undefined && !isSceneColor(t.color))
      || (t.lifetime !== undefined && !(isFiniteNum(t.lifetime) && t.lifetime >= 0 && t.lifetime <= 60000))
      || (t.minDistance !== undefined && !(isFiniteNum(t.minDistance) && t.minDistance >= 0))
      || (t.opacity !== undefined && !(isFiniteNum(t.opacity) && t.opacity >= 0 && t.opacity <= 1))
      || (t.blend !== undefined && !(BLEND_MODES as readonly string[]).includes(t.blend as string))) {
      bad('trail', help);
    }
  }

  if (kind === 'model' || (!kind && params.src !== undefined)) {
    if (add || params.src !== undefined) {
      const src = params.src;
      if (!(typeof src === 'string' && src.length > 0)) bad('src', `model needs params.src: ${MODEL_SRC_HELP}`);
    }
    const a = params.animation;
    if (a !== undefined && !((typeof a === 'string' && a.length > 0) || (Number.isInteger(a) && (a as number) >= 0))) {
      bad('animation', `params.animation must be a clip name or index (0 = the first clip) from the model`);
    }
    bool('loop', 'repeat the animation');
    bool('playing', 'false pauses the animation where it is');
    num('speed', -16, 16, 'playback rate; 1 = as authored, negative plays backwards');
    num('fit', 0.001, 100000, 'scale the model so its largest side is this many px, centred on the node');
  }

  if (kind === 'text' || kind === 'label') {
    const what = kind === 'text' ? '3D text' : 'label';
    if (add || params.text !== undefined) {
      const v = params.text;
      const max = kind === 'text' ? 512 : 2000;
      if (!(typeof v === 'string' && v.length > 0 && v.length <= max)) bad('text', `${what} needs params.text: a non-empty string up to ${max} characters ('\\n' breaks lines)`);
    }
    str('font', 200, `a CSS font family, optionally led by a weight or style, e.g. 'bold Georgia' or 'Inter'`);
    num('size', 1, kind === 'text' ? 2048 : 512, 'font size in px');
    if (params.align !== undefined && !(TEXT_ALIGNS as readonly string[]).includes(params.align as string)) {
      bad('align', `params.align must be one of ${TEXT_ALIGNS.join(', ')}`);
    }
    num('lineHeight', 0.5, 4, 'line spacing as a multiple of size');
    colour('color');
    num('opacity', 0, 1, 'see-through');
  }
  if (kind === 'text') {
    num('depth', 0, 2048, 'extrusion depth in px');
    num('bevel', 0, 256, 'rounded edge size in px');
  }
  if (kind === 'label') {
    colour('background');
    num('padding', 0, 256, 'px around the text');
    num('radius', 0, 256, 'background corner radius in px');
    num('maxWidth', 1, 4096, 'wrap width in px');
    bool('screenSpace', 'true keeps a constant on-screen size at any depth');
    if (params.anchor !== undefined && !isPoint(params.anchor, [2])) {
      bad('anchor', `params.anchor must be [ax, ay]: which point of the label sits on its position ([0, 0] top-left, [0.5, 0.5] centre)`);
    }
  }

  if (kind === 'line' || (!kind && Array.isArray(params.points))) {
    const pts = params.points;
    if (add || pts !== undefined) {
      if (!(Array.isArray(pts) && pts.length >= 2 && pts.length <= 10000 && pts.every((p) => isPoint(p, [2, 3])))) {
        bad('points', `line needs params.points: 2..10000 points [x, y, z] (z optional) in the node's local px`);
      }
    }
    if (kind === 'line') {
      num('width', 0.1, 512, 'px on screen; world px for a ribbon');
      colour('color');
      num('opacity', 0, 1, 'see-through');
      bool('closed', 'join the last point back to the first');
      bool('ribbon', 'true = a camera-facing strip of world-space width');
      if (params.colors !== undefined && !(Array.isArray(params.colors) && params.colors.every(isSceneColor)
        && (!Array.isArray(pts) || params.colors.length === pts.length))) {
        bad('colors', `params.colors must be one color per point (${Array.isArray(pts) ? pts.length : 'same count as points'})`);
      }
      if (params.widths !== undefined && !(Array.isArray(params.widths) && params.widths.every((w) => isFiniteNum(w) && w >= 0)
        && (!Array.isArray(pts) || params.widths.length === pts.length))) {
        bad('widths', `params.widths must be one width multiplier (>= 0) per point`);
      }
      if (params.dashed !== undefined) {
        const d = params.dashed;
        if (!(isPlainObject(d) && isFiniteNum(d.dash) && d.dash > 0 && (d.gap === undefined || (isFiniteNum(d.gap) && d.gap >= 0)))) {
          bad('dashed', `params.dashed must be { dash: px > 0, gap: px >= 0 }`);
        }
      }
      if (params.join !== undefined && !(LINE_JOINS as readonly string[]).includes(params.join as string)) bad('join', `params.join must be one of ${LINE_JOINS.join(', ')}`);
      if (params.cap !== undefined && !(LINE_CAPS as readonly string[]).includes(params.cap as string)) bad('cap', `params.cap must be one of ${LINE_CAPS.join(', ')}`);
    }
  }

  if (kind === 'sky') {
    for (const k of ['top', 'horizon', 'bottom'] as const) colour(k);
    if (params.sun !== undefined) {
      const sun = params.sun;
      if (!isPlainObject(sun) || !isVec3(sun.direction)
        || !Object.keys(sun).every((k) => ['direction', 'color', 'intensity', 'size'].includes(k))
        || (sun.color !== undefined && !isSceneColor(sun.color))
        || (sun.intensity !== undefined && !(isFiniteNum(sun.intensity) && sun.intensity >= 0 && sun.intensity <= 10))
        || (sun.size !== undefined && !(isFiniteNum(sun.size) && sun.size >= 0 && sun.size <= 90))) {
        bad('sun', `sky params.sun must be { direction: [x, y, z] toward the sun (y-down: negative y is up), color?, intensity? 0..10, size? (disk radius, degrees 0..90) }`);
      }
    }
    if (params.stars !== undefined && !(typeof params.stars === 'boolean' || (isFiniteNum(params.stars) && params.stars >= 0 && params.stars <= 1))) {
      bad('stars', `sky params.stars must be true|false or a density 0..1`);
    }
    if (params.texture !== undefined && !(typeof params.texture === 'string' && params.texture.length > 0)) {
      bad('texture', `sky params.texture must be an equirectangular image URL or data-URI`);
    }
    num('opacity', 0, 1, 'see-through');
    if (params.rotation !== undefined && !isFiniteNum(params.rotation)) bad('rotation', `sky params.rotation must be a number (radians around the vertical axis)`);
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
    for (const p of validateInteraction(o.id, params)) problems.set(p[0], p[1]);
    for (const p of validateContent(o.id, o.op, kind, params)) problems.set(p[0], p[1]);
    for (const p of validateMotionParams(o.id, params, kind)) problems.set(p[0], p[1]);
    if (!kind || (MATERIAL_NODE_KINDS as readonly string[]).includes(kind)) {
      for (const p of validateMaterial(o.id, params)) problems.set(p[0], p[1]);
    }
    if (!kind || kind === 'environment') {
      for (const p of validateEnvironmentMood(o.id, params)) problems.set(p[0], p[1]);
    }
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
      // A named material preset supplies the colour, so `material` alone is enough.
      const presetColour = params.color === undefined && typeof params.material === 'string' && params.material.length > 0;
      if (o.op === 'add' && !presetColour && !isSceneColor(params.color)) {
        problems.set(`${o.id}:color`, `'${o.id}': mesh needs params.color — '#hex', 'rgb(a)', or a theme token ($${SCENE_THEME_TOKENS.join(', $')}), or params.material naming a preset (which supplies the colour)`);
      }
      if (params.emissive !== undefined && !isSceneColor(params.emissive)) {
        problems.set(`${o.id}:emissive`, `'${o.id}': params.emissive must be a color or $token`);
      }
      if (params.opacity !== undefined && typeof params.opacity !== 'number') {
        problems.set(`${o.id}:opacity`, `'${o.id}': params.opacity must be a number 0..1`);
      }
      if (params.layer !== undefined && !(WORLD_LAYERS as readonly string[]).includes(params.layer as string)) {
        problems.set(`${o.id}:layer`, `'${o.id}': params.layer must be 'back' (behind windows), 'front' (above windows) or 'stack' (a root node joining the window stacking order by params.zIndex); world scope only`);
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
        problems.set(`${o.id}:castShadow`, `'${o.id}': light params.castShadow must be true|false (directional and spot lights; one of each per subtree casts)`);
      }
      for (const p of validateLightExtras(o.id, params)) problems.set(p[0], p[1]);
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
          const expFog = fog.mode === 'exp' || fog.mode === 'exp2';
          if (fog.mode !== undefined && !(FOG_MODES as readonly string[]).includes(fog.mode as string)) {
            problems.set(`${o.id}:fogMode`, `'${o.id}': fog.mode must be one of ${FOG_MODES.join(', ')} ('linear' uses near/far; 'exp' and 'exp2' use density)`);
          } else if (expFog) {
            if (!(isFiniteNum(fog.density) && fog.density >= 0 && fog.density <= 1)) {
              problems.set(`${o.id}:fogDensity`, `'${o.id}': fog mode '${String(fog.mode)}' needs a numeric density 0..1, per px of scene depth (thin haze 0.001, thick 0.01)`);
            }
          } else if (typeof fog.near !== 'number' || typeof fog.far !== 'number') {
            problems.set(`${o.id}:fogRange`, `'${o.id}': fog needs numeric near and far — SCENE-relative depth in px behind the content (small values, e.g. near 0, far 400), NOT camera distance (or mode: 'exp' | 'exp2' with a density)`);
          }
          if (fog.height !== undefined && !isFiniteNum(fog.height)) {
            problems.set(`${o.id}:fogHeight`, `'${o.id}': fog.height must be a number: the y (px, same space as the nodes; y grows downward) of the fog's top surface, above which it thins`);
          }
          if (fog.heightFalloff !== undefined && !(isFiniteNum(fog.heightFalloff) && fog.heightFalloff >= 0)) {
            problems.set(`${o.id}:fogFalloff`, `'${o.id}': fog.heightFalloff must be a number >= 0 (how fast height fog thins per px above fog.height, e.g. 0.01)`);
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

    // Particle emitters: a continuous stream (rate) and/or a burst.
    if (kind === 'particles') {
      const nonNeg = (k: string, max: number) => {
        const v = params[k];
        if (v !== undefined && (typeof v !== 'number' || !(v >= 0) || v > max)) {
          problems.set(`${o.id}:${k}`, `'${o.id}': particles params.${k} must be a number 0..${max}`);
        }
      };
      nonNeg('rate', MAX_GPU_PARTICLES);
      nonNeg('burst', MAX_GPU_PARTICLES);
      nonNeg('lifetime', 20000);
      nonNeg('maxParticles', MAX_GPU_PARTICLES);
      nonNeg('spread', Math.PI);
      nonNeg('turbulence', 10000);
      nonNeg('drag', 1);
      nonNeg('opacityEnd', 1);
      const numOrRange = (k: string, what: string) => {
        const v = params[k];
        if (v !== undefined && !(isFiniteNum(v) || (Array.isArray(v) && v.length === 2 && v.every(isFiniteNum)))) {
          problems.set(`${o.id}:${k}`, `'${o.id}': particles params.${k} must be a number or [min, max] (${what})`);
        }
      };
      numOrRange('sizeEnd', 'px at the end of life; a range picks per particle');
      numOrRange('spin', 'radians per second; a range like [-6, 6] varies it per particle');
      if (params.blend !== undefined && !(BLEND_MODES as readonly string[]).includes(params.blend as string)) {
        problems.set(`${o.id}:blend`, `'${o.id}': particles params.blend must be 'additive' (light that adds up) or 'normal' (covers); default: light colours glow additively, darker ones cover`);
      }
      if (params.texture !== undefined && typeof params.texture !== 'string') {
        problems.set(`${o.id}:texture`, `'${o.id}': particles params.texture must be a URL, data-URI, or 'surface:<surfaceId>' (a sprite drawn on every particle, tinted by color)`);
      }
      for (const k of ['speed', 'size'] as const) {
        const v = params[k];
        if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'))) {
          problems.set(`${o.id}:${k}`, `'${o.id}': particles params.${k} must be [min, max]`);
        }
      }
      for (const k of ['direction', 'emitterSize'] as const) {
        const v = params[k];
        if (v !== undefined && !(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number'))) {
          problems.set(`${o.id}:${k}`, `'${o.id}': particles params.${k} must be [x, y, z]`);
        }
      }
      for (const k of ['color', 'colorEnd'] as const) {
        if (params[k] !== undefined && !isSceneColor(params[k])) {
          problems.set(`${o.id}:${k}`, `'${o.id}': particles params.${k} must be a color or $token`);
        }
      }
      if (params.shape !== undefined && params.shape !== 'glow' && params.shape !== 'square') {
        problems.set(`${o.id}:shape`, `'${o.id}': particles params.shape must be 'glow' or 'square'`);
      }
      if (params.gravity !== undefined && typeof params.gravity !== 'number') {
        problems.set(`${o.id}:gravity`, `'${o.id}': particles params.gravity must be a number (px/s², +y down)`);
      }
    }
  }
  return [...problems.values()];
}
