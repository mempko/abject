/**
 * Scene presets: named materials and looks any abject can use by name
 * (`material: 'gold'` on a mesh, `look: 'sunset'` on an environment node)
 * and register more of through the SceneLibrary Abject.
 *
 * A preset is plain data, a subset of the node params it stands for. The
 * node's own params override the preset's fields, so `{ material: 'gold',
 * roughness: 0.6 }` is brushed gold. The SceneLibrary pushes the merged
 * library (built-ins plus registrations) to the UIServer, which relays it to
 * every client; before the first push the client uses the built-ins below.
 *
 * Shared by the server (validation, the SceneLibrary) and the client
 * (resolution at draw time), so it stays free of DOM and GL.
 */

import { validateSceneOps, isSceneColor } from './scene-types.js';

/** A named material: a subset of mesh params (see SCENE3D vocabulary in scene-types.ts). */
export type MaterialPreset = Record<string, unknown>;

/** A named look: a subset of environment-node params. */
export type LookPreset = Record<string, unknown>;

export interface SceneLibraryConfig {
  materials: Record<string, MaterialPreset>;
  looks: Record<string, LookPreset>;
}

/**
 * The params a material preset may carry: the material subset shared by
 * mesh, model, text and line nodes. Shape, placement and interaction belong
 * on the node itself.
 */
export const MATERIAL_PRESET_FIELDS = [
  'color', 'emissive', 'opacity', 'metalness', 'roughness', 'texture',
  'shading', 'blend',
  'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'normalScale', 'uvRepeat', 'uvOffset',
  'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenColor', 'transmission', 'ior', 'envIntensity',
  'toonSteps', 'outline', 'matcap', 'rimColor', 'rimPower',
  'castShadow', 'receiveShadow',
] as const;

/** The params a look preset may carry: the mood subset of environment-node params. */
export const LOOK_PRESET_FIELDS = [
  'ambient', 'fog', 'bloom', 'toneMapping', 'exposure', 'sky', 'envMap', 'envIntensity', 'grading',
  'ao', 'dof', 'outline', 'lightShafts', 'chromaticAberration', 'fxaa',
] as const;

/** Preset names: a letter, then letters, digits, `-` or `_` (up to 64). */
export const PRESET_NAME_PATTERN = /^[A-Za-z][\w-]{0,63}$/;

/** Largest serialized preset accepted (big data-URI maps belong at a URL). */
export const MAX_PRESET_BYTES = 256 * 1024;

// ── Built-ins ──────────────────────────────────────────────────────────
//
// Colours are sRGB. Metals carry their measured reflectance (F0) as colour.
// `$token` colours follow the active theme. For looks: `sky.sun.direction`
// points from the scene toward the sun (y-down, so negative y is up);
// grading uses contrast/saturation 1 = unchanged, temperature/tint 0 =
// unchanged (-1 cool/green .. +1 warm/magenta), vignette/grain 0 = off;
// fog near/far are scene-relative depth in px behind the content, like any
// environment node's fog.

/** Built-in presets. Registrations with the same name override these. */
export const BUILTIN_SCENE_LIBRARY: SceneLibraryConfig = {
  materials: {
    gold: { color: '#ffe29b', metalness: 1, roughness: 0.22, envIntensity: 1.2 },
    chrome: { color: '#dcdfe2', metalness: 1, roughness: 0.04, envIntensity: 1.3 },
    brushedMetal: { color: '#c9ccd1', metalness: 1, roughness: 0.42, envIntensity: 1 },
    copper: { color: '#fad0c0', metalness: 1, roughness: 0.28, envIntensity: 1.15 },
    glass: {
      color: '#f4f8fc', metalness: 0, roughness: 0.03, transmission: 0.95, ior: 1.5,
      envIntensity: 1.2, castShadow: false,
    },
    frostedGlass: {
      color: '#eef3f8', metalness: 0, roughness: 0.5, transmission: 0.8, ior: 1.5,
      envIntensity: 0.9, castShadow: false,
    },
    neon: {
      color: '$accent', emissive: '$accent', shading: 'unlit', blend: 'additive',
      castShadow: false, receiveShadow: false,
    },
    ceramic: { color: '#f3efe6', metalness: 0, roughness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.06 },
    plastic: { color: '$accent', metalness: 0, roughness: 0.32, clearcoat: 0.25, clearcoatRoughness: 0.25 },
    rubber: { color: '#232428', metalness: 0, roughness: 0.92, envIntensity: 0.35 },
    hologram: {
      color: '$accentSecondary', shading: 'rim', rimColor: '$accentSecondary', rimPower: 2.2,
      blend: 'additive', opacity: 0.85, castShadow: false, receiveShadow: false,
    },
    toon: {
      color: '$accent', shading: 'toon', toonSteps: 3, outline: { color: '#141218', width: 2 },
      metalness: 0, roughness: 0.7,
    },
    emissive: { color: '$accent', emissive: '$accent', metalness: 0, roughness: 0.6 },
    obsidian: {
      color: '#0e0b14', metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02,
      envIntensity: 1.3,
    },
    bone: { color: '#e6dcc4', metalness: 0, roughness: 0.72, sheen: 0.3, sheenColor: '#fff3da', envIntensity: 0.8 },
    sigil: {
      color: '$accentSecondary', emissive: '$accentSecondary', metalness: 0, roughness: 0.9,
      envIntensity: 0.4, castShadow: false,
    },
  },
  looks: {
    studio: {
      ambient: '#7a7f88',
      sky: {
        top: '#8e939b', horizon: '#6b7179', bottom: '#222428',
        sun: { direction: [0.35, -0.8, 0.5], color: '#fff5e8', intensity: 0.7 },
      },
      toneMapping: 'neutral', exposure: 1, envIntensity: 1,
    },
    sunset: {
      ambient: '#4e3346',
      sky: {
        top: '#29306b', horizon: '#ff8c52', bottom: '#2c1a28',
        sun: { direction: [-0.78, -0.14, -0.6], color: '#ffb26a', intensity: 1.5 },
      },
      fog: { color: '#d9826a', near: 250, far: 2000 },
      bloom: { threshold: 0.75, intensity: 0.6 },
      toneMapping: 'aces', exposure: 1.1,
      grading: { temperature: 0.3, saturation: 1.12, contrast: 1.05, vignette: 0.25 },
      lightShafts: { intensity: 0.35 },
    },
    night: {
      ambient: '#1b2133',
      sky: {
        top: '#04060e', horizon: '#18203d', bottom: '#020307',
        sun: { direction: [0.3, -0.65, -0.7], color: '#a9bcff', intensity: 0.45 },
      },
      fog: { color: '#0a0f1f', near: 150, far: 1600 },
      bloom: { threshold: 0.6, intensity: 0.8 },
      toneMapping: 'aces', exposure: 0.95,
      grading: { temperature: -0.3, saturation: 0.85, vignette: 0.35 },
    },
    // Red Sigil: a void ground with a blood-red horizon and phosphor light
    // rising from below, all from the palette so it follows the theme.
    void: {
      ambient: '$windowBg',
      sky: {
        top: '$canvasBg', horizon: '$accent', bottom: '$canvasBg',
        sun: { direction: [0, 0.85, 0.5], color: '$accentSecondary', intensity: 0.7 },
      },
      envIntensity: 0.7,
      fog: { color: '$canvasBg', near: 100, far: 1400 },
      bloom: { threshold: 0.55, intensity: 0.9 },
      toneMapping: 'agx', exposure: 0.9,
      grading: { contrast: 1.12, saturation: 0.95, vignette: 0.45, grain: 0.05 },
    },
    neon: {
      ambient: '#1a1030',
      sky: {
        top: '#0a0620', horizon: '#b81f9c', bottom: '#062a3d',
        sun: { direction: [-0.5, -0.3, -0.8], color: '#27e7ff', intensity: 0.8 },
      },
      fog: { color: '#1a0b33', near: 120, far: 1500 },
      bloom: { threshold: 0.45, intensity: 1.2 },
      toneMapping: 'aces', exposure: 0.95,
      grading: { saturation: 1.25, contrast: 1.1, tint: 0.1, vignette: 0.3 },
    },
    overcast: {
      ambient: '#8d939b',
      sky: { top: '#cfd4da', horizon: '#b7bdc4', bottom: '#5b6066' },
      fog: { color: '#b0b6bd', near: 200, far: 2200 },
      toneMapping: 'neutral', exposure: 1,
      grading: { saturation: 0.85, contrast: 0.95 },
    },
    dawn: {
      ambient: '#67677f',
      sky: {
        top: '#6d8ecb', horizon: '#ffc8a2', bottom: '#44405c',
        sun: { direction: [0.8, -0.22, -0.55], color: '#ffd6ae', intensity: 1 },
      },
      fog: { color: '#e6c3bd', near: 250, far: 2400 },
      bloom: { threshold: 0.8, intensity: 0.4 },
      toneMapping: 'agx', exposure: 1.05,
      grading: { temperature: 0.12, saturation: 1.05 },
    },
  },
};

/** One-line descriptions of the built-ins, for listings and guides. */
export const BUILTIN_PRESET_DESCRIPTIONS: { materials: Record<string, string>; looks: Record<string, string> } = {
  materials: {
    gold: 'Polished gold metal',
    chrome: 'Mirror-like chrome',
    brushedMetal: 'Satin brushed steel',
    copper: 'Warm polished copper',
    glass: 'Clear glass: see-through with reflections at glancing angles',
    frostedGlass: 'Frosted glass: blurred, softly see-through',
    neon: 'Glowing neon tube in the theme accent (additive, unlit)',
    ceramic: 'Glazed ceramic with a clear gloss coat',
    plastic: 'Glossy plastic in the theme accent',
    rubber: 'Matte dark rubber',
    hologram: 'See-through hologram: a fresnel rim glow in the theme\'s secondary accent',
    toon: 'Cel-shaded bands with an ink outline, in the theme accent',
    emissive: 'Self-lit body glowing in the theme accent',
    obsidian: 'Glossy black volcanic glass',
    bone: 'Aged bone: warm, matte, soft sheen',
    sigil: 'Living light: a phosphor glow in the theme\'s secondary accent',
  },
  looks: {
    studio: 'Neutral photo studio: soft top light, clean reflections',
    sunset: 'Low warm sun, violet sky, golden haze',
    night: 'Cool moonlight, deep blue haze',
    void: 'Void ground, accent horizon, secondary-accent light from below (follows the theme)',
    neon: 'Magenta and cyan glow, strong bloom',
    overcast: 'Soft sunless daylight, muted colour',
    dawn: 'Pastel sky, gentle warm sun',
  },
};

// ── Merge ──────────────────────────────────────────────────────────────

/**
 * Layer `overrides` over `base`, name by name (an override replaces the whole
 * preset of the same name). Neither input is mutated.
 */
export function mergeSceneLibrary(
  base: SceneLibraryConfig,
  overrides?: Partial<SceneLibraryConfig> | null,
): SceneLibraryConfig {
  return {
    materials: { ...base.materials, ...(overrides?.materials ?? {}) },
    looks: { ...base.looks, ...(overrides?.looks ?? {}) },
  };
}

// ── Validation ─────────────────────────────────────────────────────────
//
// A preset is checked two ways. First it is run through the scene-op
// validator as the params of a synthetic node (so every param check the
// vocabulary has applies to presets automatically, now and as it grows).
// Then a local table covers the preset fields that validator does not check
// yet; a field it already reported is left to its message.

type FieldCheck = (v: unknown) => string | null;

const SHADING_MODES = ['standard', 'unlit', 'toon', 'matcap', 'rim'];
const BLEND_MODES = ['normal', 'additive'];
const TONE_MAPPINGS = ['aces', 'agx', 'neutral', 'none'];
const FOG_MODES = ['linear', 'exp', 'exp2'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isVec = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(isNum);

const colour: FieldCheck = (v) => isSceneColor(v) ? null : 'must be a colour: \'#hex\', \'rgb(a)\', or a $token';
const unit: FieldCheck = (v) => isNum(v) && v >= 0 && v <= 1 ? null : 'must be a number 0..1';
const nonNeg = (max: number): FieldCheck => (v) => isNum(v) && v >= 0 && v <= max ? null : `must be a number 0..${max}`;
const finite: FieldCheck = (v) => isNum(v) ? null : 'must be a number';
const bool: FieldCheck = (v) => typeof v === 'boolean' ? null : 'must be true or false';
const map: FieldCheck = (v) => typeof v === 'string' && v.length > 0 ? null : 'must be a URL, data-URI, or \'surface:<surfaceId>\'';
const oneOf = (options: string[]): FieldCheck => (v) => options.includes(v as string) ? null : `must be one of ${options.join(', ')}`;
const uv: FieldCheck = (v) => isVec(v, 2) ? null : 'must be [u, v] numbers';

/**
 * An object whose listed sub-fields each pass their check (unknown sub-fields
 * are named). `allowTrue` accepts a bare `true` meaning "on with defaults".
 */
function shape(fields: Record<string, FieldCheck>, allowTrue: boolean, example: string): FieldCheck {
  return (v) => {
    if (allowTrue && (v === true || v === false)) return null;
    if (!isObj(v)) return `must be ${allowTrue ? 'true or ' : ''}${example}`;
    for (const [k, sub] of Object.entries(v)) {
      const check = fields[k];
      if (!check) return `has an unknown field '${k}' (fields: ${Object.keys(fields).join(', ')})`;
      if (sub === undefined) continue;
      const problem = check(sub);
      if (problem) return `.${k} ${problem}`;
    }
    return null;
  };
}

const MATERIAL_CHECKS: Record<string, FieldCheck> = {
  color: colour, emissive: colour, sheenColor: colour, rimColor: colour,
  opacity: unit, metalness: unit, roughness: unit,
  clearcoat: unit, clearcoatRoughness: unit, sheen: unit, transmission: unit,
  texture: map, normalMap: map, roughnessMap: map, metalnessMap: map, aoMap: map, emissiveMap: map, matcap: map,
  shading: oneOf(SHADING_MODES),
  blend: oneOf(BLEND_MODES),
  normalScale: finite,
  uvRepeat: uv, uvOffset: uv,
  ior: (v) => isNum(v) && v >= 1 && v <= 3 ? null : 'must be a number 1..3 (glass 1.5, water 1.33)',
  envIntensity: nonNeg(10),
  toonSteps: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 16 ? null : 'must be a whole number 1..16',
  outline: shape({ color: colour, width: nonNeg(64) }, true, '{ color?, width? (px) }'),
  rimPower: (v) => isNum(v) && v > 0 && v <= 16 ? null : 'must be a number above 0 (up to 16)',
  castShadow: bool, receiveShadow: bool,
};

const LOOK_CHECKS: Record<string, FieldCheck> = {
  ambient: colour,
  fog: shape({
    color: colour, near: finite, far: finite, mode: oneOf(FOG_MODES),
    density: nonNeg(1), height: finite, heightFalloff: nonNeg(1000),
  }, false, '{ color?, near, far } or { mode: \'exp\' | \'exp2\', density }'),
  bloom: shape({
    threshold: finite, intensity: finite, radius: finite,
    quality: (v) => typeof v === 'number' || typeof v === 'string' ? null : 'must be a number or a name',
  }, true, '{ threshold?, intensity?, radius?, quality? }'),
  toneMapping: oneOf(TONE_MAPPINGS),
  exposure: (v) => isNum(v) && v > 0 && v <= 16 ? null : 'must be a number above 0 (up to 16)',
  sky: shape({
    top: colour, horizon: colour, bottom: colour,
    sun: (v) => {
      if (!isObj(v) || !isVec(v.direction, 3)) return 'must be { direction: [x, y, z], color?, intensity?, size? }';
      return shape({ direction: () => null, color: colour, intensity: nonNeg(10), size: nonNeg(90) }, false, '')(v);
    },
  }, false, '{ top?, horizon?, bottom?, sun? }'),
  envMap: map,
  envIntensity: nonNeg(10),
  grading: shape({
    contrast: nonNeg(4), saturation: nonNeg(4), temperature: finite, tint: finite, vignette: unit, grain: unit,
  }, false, '{ contrast?, saturation?, temperature?, tint?, vignette?, grain? }'),
  ao: shape({ radius: nonNeg(1000), intensity: nonNeg(10) }, true, '{ radius?, intensity? }'),
  dof: shape({ focus: finite, range: nonNeg(100000), aperture: nonNeg(100) }, false, '{ focus?, range?, aperture? }'),
  outline: shape({ color: colour, width: nonNeg(64) }, true, '{ color?, width? }'),
  lightShafts: shape({ intensity: nonNeg(10), decay: unit }, true, '{ intensity?, decay? }'),
  chromaticAberration: nonNeg(100),
  fxaa: bool,
};

/** Where a field that is not preset material belongs, for the rejection message. */
const MATERIAL_FIELD_HINTS: Record<string, string> = {
  material: 'a preset cannot name another preset; copy the fields you want instead',
  primitive: 'the shape belongs on the node, next to material',
  geometry: 'the shape belongs on the node, next to material',
  shape: 'the shape belongs on the node, next to material',
  transform: 'placement belongs on the node',
  instances: 'instances belong on the node',
  emissiveIntensity: 'emissive is a colour: use a brighter emissive colour, or bloom on the environment',
};

const LOOK_FIELD_HINTS: Record<string, string> = {
  look: 'a look cannot name another look; copy the fields you want instead',
  lightType: 'lights are their own nodes; a look sets the environment only',
  stars: 'stars belong on a sky node; a look\'s sky lights and reflects the scene',
};

function presetBase(kind: 'material' | 'look', spec: unknown, example: string): string[] | null {
  if (!isObj(spec)) return [`a ${kind} preset must be an object of ${kind === 'material' ? 'material' : 'environment'} params, e.g. ${example}`];
  if (Object.keys(spec).length === 0) return [`the ${kind} preset is empty; give it at least one field, e.g. ${example}`];
  let bytes = 0;
  try { bytes = JSON.stringify(spec).length; } catch { return [`the ${kind} preset must be plain JSON data`]; }
  if (bytes > MAX_PRESET_BYTES) {
    return [`the ${kind} preset is ${Math.round(bytes / 1024)} KB; keep it under ${MAX_PRESET_BYTES / 1024} KB (serve large texture maps from a URL instead of a data-URI)`];
  }
  return null;
}

function runChecks(
  spec: Record<string, unknown>,
  allowed: readonly string[],
  hints: Record<string, string>,
  checks: Record<string, FieldCheck>,
  kind: 'mesh' | 'environment',
): string[] {
  const out: string[] = [];
  const allowedSet = new Set<string>(allowed);
  const known: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (!allowedSet.has(k)) {
      out.push(`'${k}' is not a preset field: ${hints[k] ?? `use ${allowed.join(', ')}`}`);
    } else if (v !== undefined) {
      known[k] = v;
    }
  }
  // Reuse the scene vocabulary's own param checks on a synthetic node. Its
  // required shape and colour are stand-ins (a preset's colour is checked by
  // the local table, since a preset need not carry one).
  const params = kind === 'mesh' ? { primitive: 'sphere', ...known, color: '#ffffff' } : known;
  const delegated = validateSceneOps([{ op: 'add', id: 'preset', kind, params }])
    .map((m) => m.replace(/^'preset': /, '').replace(/params\./g, ''));
  out.push(...delegated);
  for (const [k, v] of Object.entries(known)) {
    const check = checks[k];
    if (!check) continue;
    if (delegated.some((m) => new RegExp(`\\b${k}\\b`).test(m))) continue;
    const problem = check(v);
    if (problem) out.push(problem.startsWith('.') ? `${k}${problem}` : `${k} ${problem}`);
  }
  return out;
}

/**
 * Check a material preset. Returns human-actionable problems (empty when
 * valid) naming the vocabulary, so an abject can fix its registration.
 */
export function validateMaterialPreset(spec: unknown): string[] {
  const base = presetBase('material', spec, '{ color: \'#b08d57\', metalness: 1, roughness: 0.35 }');
  if (base) return base;
  return runChecks(spec as Record<string, unknown>, MATERIAL_PRESET_FIELDS, MATERIAL_FIELD_HINTS, MATERIAL_CHECKS, 'mesh');
}

/**
 * Check a look preset (environment mood). Returns human-actionable problems
 * (empty when valid).
 */
export function validateLookPreset(spec: unknown): string[] {
  const base = presetBase('look', spec, '{ ambient: \'#223\', sky: { top: \'#123\', horizon: \'#f85\' }, toneMapping: \'aces\' }');
  if (base) return base;
  return runChecks(spec as Record<string, unknown>, LOOK_PRESET_FIELDS, LOOK_FIELD_HINTS, LOOK_CHECKS, 'environment');
}

/**
 * Keep only the valid presets of a library (for relays that must never pass
 * on a bad preset). Returns the cleaned library and one problem line per
 * dropped preset.
 */
export function sanitizeSceneLibrary(config: unknown): { config: SceneLibraryConfig; problems: string[] } {
  const out: SceneLibraryConfig = { materials: {}, looks: {} };
  const problems: string[] = [];
  const src = isObj(config) ? config : {};
  const sections: Array<['materials' | 'looks', (s: unknown) => string[]]> = [
    ['materials', validateMaterialPreset],
    ['looks', validateLookPreset],
  ];
  for (const [section, validate] of sections) {
    const entries = src[section];
    if (entries === undefined) continue;
    if (!isObj(entries)) {
      problems.push(`${section} must be an object of name: preset`);
      continue;
    }
    for (const [name, spec] of Object.entries(entries)) {
      const issues = PRESET_NAME_PATTERN.test(name)
        ? validate(spec)
        : ['name must start with a letter (letters, digits, - and _; up to 64)'];
      if (issues.length === 0) out[section][name] = spec as Record<string, unknown>;
      else problems.push(`${section === 'materials' ? 'material' : 'look'} '${name}': ${issues.join('; ')}`);
    }
  }
  return { config: out, problems };
}
