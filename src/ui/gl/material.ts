/**
 * Material and environment resolution: pure functions that turn a node's
 * resolved params (after SceneStore.resolveParams), the scene theme and the
 * preset library into the renderer's draw options.
 *
 * Presets merge UNDER the node: `{ material: 'gold', roughness: 0.6 }` is
 * gold with the node's roughness, and `{ look: 'sunset', exposure: 0.8 }` is
 * the sunset look a little darker. An unknown preset name renders as if
 * absent (and is reported once on the console).
 *
 * Colours stay sRGB here (as parsed from CSS); the renderer decodes them to
 * linear light, except light colours, which leave here already linear
 * because intensity is a linear multiplier.
 */

import { Mat4, mat4TransformPoint, vec3 } from './math.js';
import { SceneTheme, resolveSceneColor, isSceneColor } from './scene-types.js';
import { SceneLibraryConfig } from './scene-presets.js';
import {
  parseCssColor, srgbToLinear, linearToSrgb, RGBA, MeshLight, EnvironmentOpts, FogOpts, SkyOpts,
  ToneMapping, DrawMode, MeshMaterialOpts, MeshMaps,
} from './renderer.js';
import { MeshShading } from './shaders.js';
import { PostSettings } from './post-effects.js';

const SHADINGS: readonly MeshShading[] = ['standard', 'unlit', 'toon', 'matcap', 'rim'];
const TONE_MAPPINGS: readonly ToneMapping[] = ['aces', 'agx', 'neutral', 'none'];

/** Unknown preset names already reported, so a bad name warns once, not per frame. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[scene] ${message}`);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function vec2Of(v: unknown): [number, number] | undefined {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [v[0], v[1]] : undefined;
}
function vec3Of(v: unknown): [number, number, number] | undefined {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [v[0], v[1], v[2]] : undefined;
}
function colourOf(v: unknown, theme: SceneTheme | undefined): RGBA | undefined {
  return isSceneColor(v) ? parseCssColor(resolveSceneColor(v as string, theme)) : undefined;
}
function rgbOf(c: RGBA): [number, number, number] {
  return [c.r, c.g, c.b];
}

/** A node's params with its named material preset merged underneath. */
export function withMaterialPreset(params: Record<string, unknown>, library: SceneLibraryConfig): Record<string, unknown> {
  const name = params.material;
  if (typeof name !== 'string' || name.length === 0) return params;
  const preset = library.materials[name];
  if (!preset) {
    warnOnce(`material:${name}`, `unknown material '${name}' (known: ${Object.keys(library.materials).join(', ')}); drawing the node's own params`);
    return params;
  }
  return { ...preset, ...params };
}

/** An environment node's params with its named look merged underneath. */
export function withLookPreset(params: Record<string, unknown>, library: SceneLibraryConfig): Record<string, unknown> {
  const name = params.look;
  if (typeof name !== 'string' || name.length === 0) return params;
  const preset = library.looks[name];
  if (!preset) {
    warnOnce(`look:${name}`, `unknown look '${name}' (known: ${Object.keys(library.looks).join(', ')}); using the environment's own params`);
    return params;
  }
  return { ...preset, ...params };
}

/** Material maps by source (URL, data-URI or 'surface:<id>'), resolved to textures by the caller. */
export interface MaterialMapSources {
  texture?: string;
  normalMap?: string;
  roughnessMap?: string;
  metalnessMap?: string;
  aoMap?: string;
  emissiveMap?: string;
  matcap?: string;
}

/** A mesh material with every preset, token and default resolved. */
export interface ResolvedMaterial {
  color: RGBA;
  emissive?: RGBA;
  opacity: number;
  metalness?: number;
  roughness?: number;
  shading: MeshShading;
  blend: 'normal' | 'additive';
  maps: MaterialMapSources;
  normalScale?: number;
  uvRepeat?: [number, number];
  uvOffset?: [number, number];
  toonSteps?: number;
  outline?: { color: RGBA; width: number };
  rimColor?: RGBA;
  rimPower?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenColor?: RGBA;
  transmission?: number;
  ior?: number;
  envIntensity?: number;
  castShadow: boolean;
  receiveShadow: boolean;
  drawMode?: DrawMode;
  pointSize?: number;
  billboard: boolean;
  /** Adds light or shows what is behind it: belongs with the transparent, back-to-front pass. */
  translucent: boolean;
}

/**
 * Resolve a mesh (or model / text / line) node's material: merge its preset,
 * resolve `$token` colours against the theme, and fill defaults.
 */
export function resolveMaterial(
  rp: Record<string, unknown>, theme: SceneTheme | undefined, library: SceneLibraryConfig,
): ResolvedMaterial {
  const p = withMaterialPreset(rp, library);
  const shading = SHADINGS.includes(p.shading as MeshShading) ? p.shading as MeshShading : 'standard';
  const blend = p.blend === 'additive' ? 'additive' : 'normal';
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 ? v : undefined;
  const maps: MaterialMapSources = {
    texture: str(p.texture), normalMap: str(p.normalMap), roughnessMap: str(p.roughnessMap),
    metalnessMap: str(p.metalnessMap), aoMap: str(p.aoMap), emissiveMap: str(p.emissiveMap), matcap: str(p.matcap),
  };
  let emissive = colourOf(p.emissive, theme);
  // An emissive map with no emissive colour glows at the map's own colours.
  if (!emissive && maps.emissiveMap) emissive = { r: 1, g: 1, b: 1, a: 1 };
  let outline: ResolvedMaterial['outline'];
  if (p.outline === true) {
    outline = { color: { r: 0.06, g: 0.06, b: 0.08, a: 1 }, width: 2 };
  } else if (p.outline && typeof p.outline === 'object') {
    const o = p.outline as Record<string, unknown>;
    outline = { color: colourOf(o.color, theme) ?? { r: 0.06, g: 0.06, b: 0.08, a: 1 }, width: num(o.width) ?? 2 };
  }
  const opacity = num(p.opacity) ?? 1;
  const transmission = num(p.transmission);
  return {
    color: colourOf(p.color, theme) ?? { r: 1, g: 1, b: 1, a: 1 },
    emissive,
    opacity,
    metalness: num(p.metalness),
    roughness: num(p.roughness),
    shading,
    blend,
    maps,
    normalScale: num(p.normalScale),
    uvRepeat: vec2Of(p.uvRepeat),
    uvOffset: vec2Of(p.uvOffset),
    toonSteps: num(p.toonSteps),
    outline,
    rimColor: colourOf(p.rimColor ?? '$accentSecondary', theme),
    rimPower: num(p.rimPower),
    clearcoat: num(p.clearcoat),
    clearcoatRoughness: num(p.clearcoatRoughness),
    sheen: num(p.sheen),
    sheenColor: colourOf(p.sheenColor, theme),
    transmission,
    ior: num(p.ior),
    envIntensity: num(p.envIntensity),
    castShadow: p.castShadow !== false,
    receiveShadow: p.receiveShadow !== false,
    drawMode: p.drawMode as DrawMode | undefined,
    pointSize: num(p.pointSize),
    billboard: p.billboard === true,
    translucent: opacity < 1 || blend === 'additive' || shading === 'rim' || (transmission ?? 0) > 0,
  };
}

/**
 * The renderer options for a resolved material. `texture` turns a map source
 * into a GL texture (or undefined while it loads, which draws without it).
 */
export function materialDrawOpts(
  m: ResolvedMaterial, texture: (src: string | undefined) => WebGLTexture | undefined,
): Omit<MeshMaterialOpts, 'model' | 'viewProj' | 'cameraPos'> {
  const maps: MeshMaps = {
    normal: texture(m.maps.normalMap),
    roughness: texture(m.maps.roughnessMap),
    metalness: texture(m.maps.metalnessMap),
    ao: texture(m.maps.aoMap),
    emissive: texture(m.maps.emissiveMap),
    matcap: texture(m.maps.matcap),
  };
  return {
    color: m.color,
    emissive: m.emissive,
    opacity: m.opacity,
    metalness: m.metalness,
    roughness: m.roughness,
    texture: texture(m.maps.texture),
    maps,
    shading: m.shading,
    blend: m.blend,
    normalScale: m.normalScale,
    uvRepeat: m.uvRepeat,
    uvOffset: m.uvOffset,
    toonSteps: m.toonSteps,
    outline: m.outline,
    rimColor: m.rimColor,
    rimPower: m.rimPower,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    sheen: m.sheen,
    sheenColor: m.sheenColor,
    transmission: m.transmission,
    ior: m.ior,
    envIntensity: m.envIntensity,
    receiveShadow: m.receiveShadow,
    drawMode: m.drawMode,
    pointSize: m.pointSize,
  };
}

/**
 * The multiplier for an `intensity`: the linear multiplier the vocabulary
 * documents (1 = the colour at full strength, 2 = twice as bright on screen).
 */
export function lightEnergy(intensity: number): number {
  return Math.max(0, intensity);
}

/** A light node resolved for the renderer, plus its shadow request. */
export interface ResolvedLight {
  light: MeshLight;
  kind: 'directional' | 'point' | 'spot' | 'hemisphere';
  castShadow: boolean;
  shadow: { size: number; softness: number; bias?: number };
  /** Spot cone half-angle, radians (spot lights). */
  angle?: number;
}

/** Resolve a light node's params. `world` is the node's world matrix. */
export function resolveLight(params: Record<string, unknown>, theme: SceneTheme | undefined, world: Mat4): ResolvedLight {
  const col = colourOf(params.color, theme) ?? { r: 1, g: 1, b: 1, a: 1 };
  const e = lightEnergy(num(params.intensity) ?? 1);
  // Light colours stay display-referred (as parsed): direct light scales the
  // on-screen albedo, the model every existing scene was tuned under.
  const linear = (c: RGBA): [number, number, number] => [c.r * e, c.g * e, c.b * e];
  const type = params.lightType as string;
  const sh = (params.shadow && typeof params.shadow === 'object') ? params.shadow as Record<string, unknown> : {};
  const shadow = {
    size: num(sh.size) ?? 1024,
    softness: num(sh.softness) ?? 1.5,
    bias: num(sh.bias),
  };
  const castShadow = params.castShadow === true;
  if (type === 'hemisphere') {
    const ground = colourOf(params.groundColor, theme) ?? { r: 0.2, g: 0.18, b: 0.16, a: 1 };
    return {
      kind: 'hemisphere', castShadow: false, shadow,
      light: { pos: [0, 0, 0, 3], color: linear(col), dir: vec3Of(params.direction) ?? [0, 1, 0], groundColor: linear(ground) },
    };
  }
  const dir = vec3Of(params.direction) ?? [0, 0.4, -1];
  if (type === 'directional') {
    return { kind: 'directional', castShadow, shadow, light: { pos: [0, 0, 0, 0], color: linear(col), dir } };
  }
  const pos: [number, number, number, number] = [world[12], world[13], world[14], type === 'spot' ? 2 : 1];
  const range = num(params.range) ?? 0;
  if (type === 'spot') {
    const angle = num(params.angle) ?? Math.PI / 6;
    const penumbra = Math.min(1, Math.max(0, num(params.penumbra) ?? 0.3));
    return {
      kind: 'spot', castShadow, shadow, angle,
      light: { pos, color: linear(col), dir, range, spotInner: Math.cos(angle * (1 - penumbra)), spotOuter: Math.cos(angle) },
    };
  }
  return { kind: 'point', castShadow: false, shadow, light: { pos, color: linear(col), range } };
}

/** The light a scene gets when it declares none: a soft key from the front. */
export function defaultKeyLight(): MeshLight {
  return { pos: [0, 0, 0, 0], color: [0.9, 0.9, 0.95], dir: [-0.4, -0.5, -1] };
}

/** An environment resolved for the renderer, plus the sources it still needs loaded. */
export interface ResolvedEnvironment {
  /** Flat ambient, sRGB (also derives the default sky). */
  ambient?: [number, number, number];
  fog?: FogOpts;
  environment: EnvironmentOpts;
  /** Equirect image to load for image-based light. */
  envMapSrc?: string;
  /** Bloom request, as the node (or its look) asks for it. */
  bloom?: true | Record<string, unknown>;
  /** Post effects the node (or its look) turns on; absent when none are set. */
  post?: PostSettings;
}

/** Frame facts environment resolution needs: where the scene's depth begins, and its y mapping. */
export interface EnvironmentFrame {
  /** Camera distance to the content plane (fog near/far are measured behind it). */
  baseline: number;
  /** Map a y in the subtree's local px to world y (for height fog). */
  worldY: (y: number) => number;
}

/**
 * Resolve an environment node's params (with its look) into renderer
 * options. Linear fog keeps its scene-relative near/far; exp fogs start at
 * the content plane; height fog's `height` is in the subtree's own px.
 */
export function resolveEnvironment(
  params: Record<string, unknown>, theme: SceneTheme | undefined, library: SceneLibraryConfig, frame: EnvironmentFrame,
): ResolvedEnvironment {
  const p = withLookPreset(params, library);
  const out: ResolvedEnvironment = { environment: {} };
  const amb = colourOf(p.ambient, theme);
  if (amb) out.ambient = rgbOf(amb);

  const fog = p.fog as Record<string, unknown> | undefined;
  if (fog && typeof fog === 'object') {
    const mode = fog.mode === 'exp' || fog.mode === 'exp2' ? fog.mode : 'linear';
    const near = num(fog.near);
    const far = num(fog.far);
    const density = num(fog.density);
    const usable = mode === 'linear' ? near !== undefined && far !== undefined : density !== undefined;
    if (usable) {
      const c = colourOf(fog.color ?? '#0a0a14', theme) ?? { r: 0.04, g: 0.04, b: 0.08, a: 1 };
      const height = num(fog.height);
      out.fog = {
        color: rgbOf(c),
        mode,
        // Near/far are SCENE-relative depth (px behind the content plane), not
        // camera-relative: the camera distance scales with the live viewport,
        // so an author cannot know it. The baseline makes small values work
        // at any viewport size.
        near: frame.baseline + (near ?? 0),
        far: frame.baseline + (far ?? 0),
        density,
        start: frame.baseline,
        height: height !== undefined ? frame.worldY(height) : undefined,
        heightFalloff: num(fog.heightFalloff),
      };
    }
  }

  const env = out.environment;
  env.ambient = out.ambient;
  env.fog = out.fog;
  const sky = p.sky as Record<string, unknown> | undefined;
  if (sky && typeof sky === 'object') env.sky = resolveSky(sky, theme, out.ambient);
  if (typeof p.envMap === 'string' && p.envMap.length > 0) out.envMapSrc = p.envMap;
  env.envIntensity = num(p.envIntensity);
  if (TONE_MAPPINGS.includes(p.toneMapping as ToneMapping)) env.toneMapping = p.toneMapping as ToneMapping;
  env.exposure = num(p.exposure);
  const g = p.grading as Record<string, unknown> | undefined;
  if (g && typeof g === 'object') {
    // vignette and grain are screen effects for the post pass; accepted, not drawn here.
    env.grading = { contrast: num(g.contrast), saturation: num(g.saturation), temperature: num(g.temperature), tint: num(g.tint) };
  }
  if (p.bloom === true || (p.bloom && typeof p.bloom === 'object')) out.bloom = p.bloom as true | Record<string, unknown>;
  out.post = resolvePost(p, theme);
  return out;
}

/**
 * The post effects an environment's params turn on (each one by being set),
 * with defaults filled in. Undefined when none are on.
 */
export function resolvePost(p: Record<string, unknown>, theme: SceneTheme | undefined): PostSettings | undefined {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const post: PostSettings = {};
  if (p.ao === true || (p.ao && typeof p.ao === 'object')) {
    const o = obj(p.ao);
    post.ao = { radius: num(o.radius) ?? 28, intensity: num(o.intensity) ?? 1 };
  }
  if (p.dof && typeof p.dof === 'object') {
    const o = obj(p.dof);
    post.dof = { focus: num(o.focus) ?? 0, range: num(o.range) ?? 200, aperture: num(o.aperture) ?? 8 };
  }
  if (p.outline === true || (p.outline && typeof p.outline === 'object')) {
    const o = obj(p.outline);
    const c = colourOf(o.color ?? '#0b0b10', theme) ?? { r: 0.04, g: 0.04, b: 0.06, a: 1 };
    post.outline = { color: [c.r, c.g, c.b], width: num(o.width) ?? 1.5 };
  }
  if (p.lightShafts === true || (p.lightShafts && typeof p.lightShafts === 'object')) {
    const o = obj(p.lightShafts);
    post.lightShafts = { intensity: num(o.intensity) ?? 0.6, decay: num(o.decay) ?? 0.96 };
  }
  const ca = num(p.chromaticAberration);
  if (ca !== undefined && ca > 0) post.chromaticAberration = ca;
  if (p.fxaa === true) post.fxaa = true;
  const g = obj(p.grading);
  const vignette = num(g.vignette), grain = num(g.grain);
  if (vignette !== undefined && vignette > 0) post.vignette = vignette;
  if (grain !== undefined && grain > 0) post.grain = grain;
  return Object.keys(post).length > 0 ? post : undefined;
}

/**
 * A sky's colours with defaults: missing bands come from the gradient the
 * renderer would derive from the ambient, so `sky: { horizon: '#f80' }` alone
 * still lights sensibly.
 */
export function resolveSky(sky: Record<string, unknown>, theme: SceneTheme | undefined, ambient?: [number, number, number]): SkyOpts {
  const a = ambient ?? [0.35, 0.35, 0.4];
  const derive = (gain: number): [number, number, number] =>
    [linearToSrgb(srgbToLinear(a[0]) * gain), linearToSrgb(srgbToLinear(a[1]) * gain), linearToSrgb(srgbToLinear(a[2]) * gain)];
  const pick = (v: unknown, fallback: [number, number, number]) => {
    const c = colourOf(v, theme);
    return c ? rgbOf(c) : fallback;
  };
  const horizon = pick(sky.horizon, derive(0.92));
  const out: SkyOpts = {
    top: pick(sky.top, derive(1.75)),
    horizon,
    bottom: pick(sky.bottom, derive(0.32)),
  };
  const sun = sky.sun as Record<string, unknown> | undefined;
  const direction = sun && vec3Of(sun.direction);
  if (direction) {
    out.sun = {
      direction,
      color: pick(sun!.color, [1, 0.97, 0.92]),
      intensity: lightEnergy(num(sun!.intensity) ?? 1),
      // size is the disk's angular radius in degrees
      size: ((num(sun!.size) ?? 2) * Math.PI) / 180,
    };
  }
  return out;
}

/** World y of a local y under a subtree's surface model (for height fog). */
export function surfaceWorldY(surfaceModel: Mat4): (y: number) => number {
  return (y: number) => mat4TransformPoint(surfaceModel, vec3(0, y, 0)).y;
}
