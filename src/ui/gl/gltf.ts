/**
 * glTF 2.0 / GLB loader for `model` scene nodes.
 *
 * Pure data: no GL and no DOM, so the same code validates a model on the
 * server (in Node) and prepares it for drawing in the browser. It reads the
 * JSON and binary chunks of a GLB (or a .gltf JSON document), resolves
 * buffers that are embedded, data-URIs, or external (through a caller-supplied
 * fetch), decodes every accessor form (all component types, normalized
 * integers, byteStride, sparse), and exposes meshes, PBR materials, images as
 * raw bytes, samplers, the node hierarchy, scenes, skins (parsed, not
 * applied: skinned meshes draw in bind pose) and node animations.
 *
 * Drawing is a flatten step: `flattenScene` walks a scene (optionally posed
 * by `sampleAnimation`) and returns one draw item per mesh primitive with its
 * world matrix. glTF is y-up and 1 unit = 1 metre; the scene world is y-down
 * px, so flattening applies a y flip at the root (a mirror that the y-down
 * projection mirrors back, so the model looks exactly as authored) and
 * leaves the units alone: 1 model unit = 1 px at scale 1.
 */

import { Geometry, computeNormals } from './primitives.js';
import { Mat4, mat4Identity, mat4Multiply } from './math.js';

/** Largest model accepted (the file plus any external buffers and images). */
export const GLTF_MAX_BYTES = 16 * 1024 * 1024;

/** A model that cannot be loaded, with a message that says why in plain terms. */
export class GltfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GltfError';
  }
}

/** Resolves an external buffer or image URI (relative to the model) to bytes. */
export type GltfFetch = (uri: string) => Promise<ArrayBuffer | ArrayBufferView>;

export interface GltfParseOptions {
  /** Needed only for models that reference external files. */
  fetch?: GltfFetch;
  /** Size cap in bytes [GLTF_MAX_BYTES]. */
  maxBytes?: number;
}

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface GltfSampler {
  magFilter?: number;
  minFilter?: number;
  /** GL wrap enums; glTF defaults to REPEAT (10497). */
  wrapS: number;
  wrapT: number;
}

/** An image as raw encoded bytes (PNG, JPEG, WebP), or an unresolved URI. */
export interface GltfImage {
  name?: string;
  mime: string;
  bytes?: Uint8Array;
  /** Set when the image is external and no fetch function was supplied. */
  uri?: string;
}

/** A material's reference to a texture, with KHR_texture_transform applied as fields. */
export interface GltfTextureRef {
  /** Index into `images`, or -1 when the texture has no usable source. */
  image: number;
  sampler: GltfSampler;
  texCoord: number;
  offset: [number, number];
  scale: [number, number];
  rotation: number;
}

export interface GltfMaterial {
  name?: string;
  /** Linear RGBA. */
  baseColorFactor: QuatTuple;
  baseColorTexture?: GltfTextureRef;
  metallicFactor: number;
  roughnessFactor: number;
  /** Roughness in G, metalness in B. */
  metallicRoughnessTexture?: GltfTextureRef;
  normalTexture?: GltfTextureRef & { scale: number };
  occlusionTexture?: GltfTextureRef & { strength: number };
  emissiveTexture?: GltfTextureRef;
  /** Linear RGB, already multiplied by KHR_materials_emissive_strength. */
  emissiveFactor: Vec3Tuple;
  emissiveStrength: number;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  /** KHR_materials_unlit. */
  unlit: boolean;
}

/** glTF primitive modes. */
export const GLTF_MODE = { POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6 } as const;

export interface GltfPrimitive {
  mode: number;
  positions: Float32Array;
  normals?: Float32Array;
  /** TEXCOORD_0 (glTF uv origin is the image's top-left, which matches our texture upload). */
  uvs?: Float32Array;
  uvs1?: Float32Array;
  /** COLOR_0 as RGBA, 4 per vertex (alpha 1 when the source is RGB). */
  colors?: Float32Array;
  tangents?: Float32Array;
  joints?: Uint32Array;
  weights?: Float32Array;
  indices?: Uint32Array;
  /** Index into `materials`, or -1 for the glTF default material. */
  material: number;
  vertexCount: number;
  min: Vec3Tuple;
  max: Vec3Tuple;
}

export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}

export interface GltfNode {
  name?: string;
  children: number[];
  parent: number;
  mesh: number;
  skin: number;
  translation: Vec3Tuple;
  rotation: QuatTuple;
  scale: Vec3Tuple;
  /** Column-major local matrix when the node gives one instead of TRS. */
  matrix?: Float32Array;
}

export interface GltfScene {
  name?: string;
  nodes: number[];
}

export type GltfAnimationPath = 'translation' | 'rotation' | 'scale' | 'weights';

export interface GltfAnimationSampler {
  input: Float32Array;
  output: Float32Array;
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GltfAnimationChannel {
  node: number;
  path: GltfAnimationPath;
  sampler: number;
}

export interface GltfAnimation {
  name?: string;
  channels: GltfAnimationChannel[];
  samplers: GltfAnimationSampler[];
  /** First and last keyframe times, seconds. */
  start: number;
  end: number;
  /** end (glTF clips play from time 0). */
  duration: number;
}

export interface GltfSkin {
  name?: string;
  joints: number[];
  skeleton: number;
  inverseBindMatrices?: Float32Array;
}

export interface GltfDocument {
  generator?: string;
  scenes: GltfScene[];
  /** Default scene index. */
  scene: number;
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  images: GltfImage[];
  animations: GltfAnimation[];
  skins: GltfSkin[];
  extensionsUsed: string[];
  /** Non-fatal notes (ignored features, unresolved images). */
  warnings: string[];
  /** Bytes consumed (file plus external resources). */
  byteLength: number;
}

/** Per-node TRS overrides produced by sampleAnimation. */
export type GltfPose = Map<number, { translation?: Vec3Tuple; rotation?: QuatTuple; scale?: Vec3Tuple }>;

export interface GltfDrawItem {
  nodeIndex: number;
  meshIndex: number;
  primitiveIndex: number;
  primitive: GltfPrimitive;
  /** -1 = glTF default material (white, metallic 1, roughness 1). */
  materialIndex: number;
  worldMatrix: Mat4;
}

// Extensions this loader understands. Anything else listed as REQUIRED stops the load.
const SUPPORTED_EXTENSIONS = new Set([
  'KHR_materials_emissive_strength',
  'KHR_texture_transform',
  'KHR_materials_unlit',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
]);

const COMPRESSION_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'compressed meshes are not supported yet (KHR_draco_mesh_compression); export the model without Draco compression',
  EXT_meshopt_compression: 'compressed meshes are not supported yet (EXT_meshopt_compression); export the model without meshopt compression',
  KHR_texture_basisu: 'compressed textures are not supported yet (KHR_texture_basisu); export the model with PNG or JPEG textures',
};

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const REPEAT = 10497;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

const B64 = (() => {
  const table = new Int16Array(128).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62; // url-safe alphabet
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Decode base64 (standard or url-safe; whitespace and padding tolerated). */
export function decodeBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let bits = 0, acc = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Parse a data: URI into bytes and its declared MIME type. */
export function decodeDataUri(uri: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!m) return null;
  const meta = m[1];
  const mime = meta.split(';')[0] || 'application/octet-stream';
  if (/;base64$/i.test(meta)) return { bytes: decodeBase64(m[2]), mime };
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[2])), mime };
}

/** Sniff an image MIME type from its first bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return undefined;
}

/**
 * Cheap content hash (two FNV-1a lanes, 16 hex chars) for caching parsed
 * models by content. Not cryptographic.
 */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Human size: '3.2 MB', or KB below a tenth of a megabyte. */
function mb(n: number): string {
  return n >= 102400 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Is this byte stream a binary glTF (GLB) container? */
export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === GLB_MAGIC;
}

/**
 * Parse a glTF 2.0 model: GLB bytes, .gltf JSON bytes, or JSON text.
 * Rejects with a GltfError naming the problem (size, compression, missing
 * external files, malformed data).
 */
export async function parseGltf(input: ArrayBuffer | ArrayBufferView | string, opts: GltfParseOptions = {}): Promise<GltfDocument> {
  const maxBytes = opts.maxBytes ?? GLTF_MAX_BYTES;
  let json: Json;
  let bin: Uint8Array | undefined;
  let used: number;

  if (typeof input === 'string') {
    used = input.length;
    if (used > maxBytes) throw new GltfError(`the model is ${mb(used)}; the limit is ${mb(maxBytes)}`);
    json = parseJson(input);
  } else {
    const bytes = toBytes(input);
    used = bytes.length;
    if (used > maxBytes) throw new GltfError(`the model is ${mb(used)}; the limit is ${mb(maxBytes)}`);
    if (isGlb(bytes)) {
      const glb = readGlb(bytes);
      json = glb.json;
      bin = glb.bin;
    } else {
      json = parseJson(new TextDecoder().decode(bytes));
    }
  }

  const version = String(json.asset?.version ?? '');
  if (!version.startsWith('2')) {
    throw new GltfError(`the model is glTF ${version || '(unknown version)'}; only glTF 2.0 is supported`);
  }

  const warnings: string[] = [];
  const extensionsUsed: string[] = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  const extensionsRequired: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  // A compression extension that is only USED (not required) ships
  // uncompressed fallbacks, which load normally.
  for (const ext of extensionsRequired) {
    if (COMPRESSION_EXTENSIONS[ext]) throw new GltfError(COMPRESSION_EXTENSIONS[ext]);
  }
  const unsupported = extensionsRequired.filter((e) => !SUPPORTED_EXTENSIONS.has(e));
  if (unsupported.length) {
    throw new GltfError(`the model requires glTF extension${unsupported.length > 1 ? 's' : ''} ${unsupported.join(', ')}, not supported yet`);
  }
  for (const e of extensionsUsed) {
    if (!SUPPORTED_EXTENSIONS.has(e) && !COMPRESSION_EXTENSIONS[e]) warnings.push(`extension ${e} is ignored`);
  }

  // ── Buffers ──
  const budget = { used, max: maxBytes };
  const charge = (n: number, what: string) => {
    budget.used += n;
    if (budget.used > budget.max) {
      throw new GltfError(`the model and its ${what} total ${mb(budget.used)}; the limit is ${mb(budget.max)}`);
    }
  };
  const fetchExternal = async (uri: string, what: string): Promise<Uint8Array> => {
    if (!opts.fetch) throw new GltfError(`the model references the external file '${uri}'; embed it (GLB or data URI) or supply a fetch function`);
    let data: ArrayBuffer | ArrayBufferView;
    try {
      data = await opts.fetch(uri);
    } catch (err) {
      throw new GltfError(`could not load the model's ${what} '${uri}': ${err instanceof Error ? err.message : String(err)}`);
    }
    const bytes = toBytes(data);
    charge(bytes.length, what);
    return bytes;
  };

  const buffersJson: Json[] = Array.isArray(json.buffers) ? json.buffers : [];
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < buffersJson.length; i++) {
    const b = buffersJson[i];
    let bytes: Uint8Array;
    if (b.uri === undefined) {
      if (i !== 0 || !bin) throw new GltfError(`buffer ${i} has no uri and the file has no binary chunk`);
      bytes = bin;
    } else if (String(b.uri).startsWith('data:')) {
      const d = decodeDataUri(String(b.uri));
      if (!d) throw new GltfError(`buffer ${i} has a malformed data URI`);
      bytes = d.bytes;
    } else {
      bytes = await fetchExternal(String(b.uri), 'buffer');
    }
    if (typeof b.byteLength === 'number' && bytes.length < b.byteLength) {
      throw new GltfError(`buffer ${i} holds ${bytes.length} bytes but declares ${b.byteLength}`);
    }
    buffers.push(bytes);
  }

  const reader = new AccessorReader(json, buffers);

  // ── Images, samplers, textures ──
  const images: GltfImage[] = [];
  for (let i = 0; i < (json.images?.length ?? 0); i++) {
    const im = json.images[i] as Json;
    let bytes: Uint8Array | undefined;
    let mime: string | undefined = im.mimeType;
    let uri: string | undefined;
    if (im.bufferView !== undefined) {
      bytes = reader.viewBytes(im.bufferView).slice();
    } else if (typeof im.uri === 'string' && im.uri.startsWith('data:')) {
      const d = decodeDataUri(im.uri);
      if (d) { bytes = d.bytes; mime = mime ?? d.mime; }
    } else if (typeof im.uri === 'string') {
      if (opts.fetch) {
        bytes = await fetchExternal(im.uri, 'image');
      } else {
        uri = im.uri;
        warnings.push(`image ${i} is the external file '${im.uri}' and was not loaded`);
      }
    }
    if (bytes) mime = sniffImageMime(bytes) ?? mime;
    images.push({ name: im.name, mime: mime ?? 'application/octet-stream', bytes, uri });
  }

  const samplers: GltfSampler[] = (json.samplers ?? []).map((s: Json) => ({
    magFilter: s.magFilter, minFilter: s.minFilter, wrapS: s.wrapS ?? REPEAT, wrapT: s.wrapT ?? REPEAT,
  }));
  const defaultSampler: GltfSampler = { wrapS: REPEAT, wrapT: REPEAT };

  const textureRef = (info: Json | undefined): GltfTextureRef | undefined => {
    if (!info || typeof info.index !== 'number') return undefined;
    const tex = json.textures?.[info.index] as Json | undefined;
    if (!tex) return undefined;
    const source = tex.extensions?.EXT_texture_webp?.source ?? tex.source;
    const tt = info.extensions?.KHR_texture_transform as Json | undefined;
    return {
      image: typeof source === 'number' && source < images.length ? source : -1,
      sampler: typeof tex.sampler === 'number' ? samplers[tex.sampler] ?? defaultSampler : defaultSampler,
      texCoord: tt?.texCoord ?? info.texCoord ?? 0,
      offset: tt?.offset ?? [0, 0],
      scale: tt?.scale ?? [1, 1],
      rotation: tt?.rotation ?? 0,
    };
  };

  // ── Materials ──
  const materials: GltfMaterial[] = (json.materials ?? []).map((m: Json): GltfMaterial => {
    const pbr = (m.pbrMetallicRoughness ?? {}) as Json;
    const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
    const ef = (m.emissiveFactor ?? [0, 0, 0]) as number[];
    const normal = textureRef(m.normalTexture);
    const occlusion = textureRef(m.occlusionTexture);
    return {
      name: m.name,
      baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as QuatTuple,
      baseColorTexture: textureRef(pbr.baseColorTexture),
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      metallicRoughnessTexture: textureRef(pbr.metallicRoughnessTexture),
      normalTexture: normal ? { ...normal, scale: m.normalTexture.scale ?? 1 } : undefined,
      occlusionTexture: occlusion ? { ...occlusion, strength: m.occlusionTexture.strength ?? 1 } : undefined,
      emissiveTexture: textureRef(m.emissiveTexture),
      emissiveFactor: [ef[0] * strength, ef[1] * strength, ef[2] * strength],
      emissiveStrength: strength,
      alphaMode: m.alphaMode === 'MASK' || m.alphaMode === 'BLEND' ? m.alphaMode : 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided === true,
      unlit: !!m.extensions?.KHR_materials_unlit,
    };
  });

  // ── Meshes ──
  let warnedMorph = false;
  const meshes: GltfMesh[] = (json.meshes ?? []).map((mesh: Json, mi: number): GltfMesh => {
    const prims: GltfPrimitive[] = [];
    for (let pi = 0; pi < (mesh.primitives?.length ?? 0); pi++) {
      const p = mesh.primitives[pi] as Json;
      const a = (p.attributes ?? {}) as Record<string, number>;
      for (const ext of Object.keys(p.extensions ?? {})) {
        const fallback = a.POSITION !== undefined && json.accessors?.[a.POSITION]?.bufferView !== undefined;
        if (COMPRESSION_EXTENSIONS[ext] && !fallback) throw new GltfError(COMPRESSION_EXTENSIONS[ext]);
      }
      if (a.POSITION === undefined) {
        warnings.push(`mesh ${mi} primitive ${pi} has no POSITION and was skipped`);
        continue;
      }
      if (Array.isArray(p.targets) && p.targets.length && !warnedMorph) {
        warnedMorph = true;
        warnings.push('morph targets are ignored (meshes draw in their base shape)');
      }
      const positions = reader.readFloat(a.POSITION, 3);
      const vertexCount = positions.length / 3;
      const attr = (name: string, comps: number): Float32Array | undefined => {
        if (a[name] === undefined) return undefined;
        const data = reader.readFloat(a[name], comps);
        if (data.length / comps !== vertexCount) throw new GltfError(`mesh ${mi} primitive ${pi}: ${name} has ${data.length / comps} entries for ${vertexCount} vertices`);
        return data;
      };
      let colors: Float32Array | undefined;
      if (a.COLOR_0 !== undefined) {
        const comps = TYPE_COMPONENTS[json.accessors?.[a.COLOR_0]?.type] ?? 4;
        const raw = reader.readFloat(a.COLOR_0, comps);
        colors = new Float32Array(vertexCount * 4);
        for (let v = 0; v < vertexCount; v++) {
          colors[v * 4] = raw[v * comps];
          colors[v * 4 + 1] = raw[v * comps + 1];
          colors[v * 4 + 2] = raw[v * comps + 2];
          colors[v * 4 + 3] = comps === 4 ? raw[v * comps + 3] : 1;
        }
      }
      const indices = p.indices !== undefined ? reader.readUint(p.indices) : undefined;
      if (indices) {
        for (let k = 0; k < indices.length; k++) {
          if (indices[k] >= vertexCount) throw new GltfError(`mesh ${mi} primitive ${pi}: index ${indices[k]} is past the ${vertexCount} vertices`);
        }
      }
      const min: Vec3Tuple = [Infinity, Infinity, Infinity], max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < 3; c++) {
          const x = positions[v * 3 + c];
          if (x < min[c]) min[c] = x;
          if (x > max[c]) max[c] = x;
        }
      }
      if (vertexCount === 0) { min.fill(0); max.fill(0); }
      prims.push({
        mode: typeof p.mode === 'number' ? p.mode : GLTF_MODE.TRIANGLES,
        positions,
        normals: attr('NORMAL', 3),
        uvs: attr('TEXCOORD_0', 2),
        uvs1: attr('TEXCOORD_1', 2),
        colors,
        tangents: attr('TANGENT', 4),
        joints: a.JOINTS_0 !== undefined ? reader.readUint(a.JOINTS_0) : undefined,
        weights: attr('WEIGHTS_0', 4),
        indices,
        material: typeof p.material === 'number' && p.material < materials.length ? p.material : -1,
        vertexCount,
        min,
        max,
      });
    }
    return { name: mesh.name, primitives: prims };
  });

  // ── Nodes and scenes ──
  const nodesJson: Json[] = json.nodes ?? [];
  const nodes: GltfNode[] = nodesJson.map((n: Json): GltfNode => ({
    name: n.name,
    children: Array.isArray(n.children) ? n.children.filter((c: unknown) => typeof c === 'number' && c >= 0 && c < nodesJson.length) : [],
    parent: -1,
    mesh: typeof n.mesh === 'number' && n.mesh < meshes.length ? n.mesh : -1,
    skin: typeof n.skin === 'number' ? n.skin : -1,
    translation: (n.translation ?? [0, 0, 0]) as Vec3Tuple,
    rotation: (n.rotation ?? [0, 0, 0, 1]) as QuatTuple,
    scale: (n.scale ?? [1, 1, 1]) as Vec3Tuple,
    matrix: Array.isArray(n.matrix) && n.matrix.length === 16 ? Float32Array.from(n.matrix) : undefined,
  }));
  nodes.forEach((n, i) => {
    for (const c of n.children) {
      if (nodes[c].parent >= 0 && nodes[c].parent !== i) warnings.push(`node ${c} has more than one parent`);
      else nodes[c].parent = i;
    }
  });
  let scenes: GltfScene[] = (json.scenes ?? []).map((s: Json) => ({
    name: s.name,
    nodes: Array.isArray(s.nodes) ? s.nodes.filter((c: unknown) => typeof c === 'number' && c >= 0 && c < nodes.length) : [],
  }));
  if (scenes.length === 0 && nodes.length) {
    // No scenes: every root node is part of one implicit scene.
    scenes = [{ nodes: nodes.map((n, i) => (n.parent < 0 ? i : -1)).filter((i) => i >= 0) }];
  }
  const scene = typeof json.scene === 'number' && json.scene < scenes.length ? json.scene : 0;

  // ── Skins (parsed, not applied) ──
  const skins: GltfSkin[] = (json.skins ?? []).map((s: Json) => ({
    name: s.name,
    joints: Array.isArray(s.joints) ? s.joints : [],
    skeleton: typeof s.skeleton === 'number' ? s.skeleton : -1,
    inverseBindMatrices: s.inverseBindMatrices !== undefined ? reader.readFloat(s.inverseBindMatrices, 16) : undefined,
  }));
  if (skins.length) warnings.push('skinning is not applied yet: skinned meshes draw in their bind pose');

  // ── Animations ──
  const animations: GltfAnimation[] = (json.animations ?? []).map((an: Json, ai: number): GltfAnimation => {
    const samplersOut: GltfAnimationSampler[] = (an.samplers ?? []).map((s: Json) => {
      const interp = s.interpolation === 'STEP' || s.interpolation === 'CUBICSPLINE' ? s.interpolation : 'LINEAR';
      const outComps = TYPE_COMPONENTS[json.accessors?.[s.output]?.type] ?? 1;
      return { input: reader.readFloat(s.input, 1), output: reader.readFloat(s.output, outComps), interpolation: interp };
    });
    const channels: GltfAnimationChannel[] = [];
    for (const ch of an.channels ?? []) {
      const node = ch.target?.node;
      const path = ch.target?.path;
      if (typeof node !== 'number' || node < 0 || node >= nodes.length) continue;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights') continue;
      if (typeof ch.sampler !== 'number' || !samplersOut[ch.sampler]) {
        throw new GltfError(`animation ${ai} has a channel with a missing sampler`);
      }
      channels.push({ node, path, sampler: ch.sampler });
    }
    let start = Infinity, end = 0;
    for (const s of samplersOut) {
      if (s.input.length) {
        start = Math.min(start, s.input[0]);
        end = Math.max(end, s.input[s.input.length - 1]);
      }
    }
    if (!Number.isFinite(start)) start = 0;
    return { name: an.name, channels, samplers: samplersOut, start, end, duration: end };
  });

  return {
    generator: json.asset?.generator,
    scenes, scene, nodes, meshes, materials, images, animations, skins,
    extensionsUsed, warnings, byteLength: budget.used,
  };
}

function parseJson(text: string): Json {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v as Json;
  } catch (err) {
    throw new GltfError(`the model is neither a GLB file nor valid glTF JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function readGlb(bytes: Uint8Array): { json: Json; bin?: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new GltfError(`the GLB container is version ${version}; only glTF 2.0 is supported`);
  const length = dv.getUint32(8, true);
  if (length > bytes.length) throw new GltfError(`the GLB file is truncated (${bytes.length} of ${length} bytes)`);
  let offset = 12;
  let json: Json | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) throw new GltfError('the GLB file has a chunk running past its end');
    const data = bytes.subarray(start, start + chunkLength);
    if (chunkType === CHUNK_JSON && !json) json = parseJson(new TextDecoder().decode(data));
    else if (chunkType === CHUNK_BIN && !bin) bin = data;
    offset = start + chunkLength;
  }
  if (!json) throw new GltfError('the GLB file has no JSON chunk');
  return { json, bin };
}

/** Decodes accessors into typed arrays (cached per accessor and kind). */
class AccessorReader {
  private floatCache = new Map<number, Float32Array>();
  private uintCache = new Map<number, Uint32Array>();

  constructor(private json: Json, private buffers: Uint8Array[]) {}

  /** The raw bytes of a buffer view. */
  viewBytes(viewIndex: number): Uint8Array {
    const view = this.json.bufferViews?.[viewIndex] as Json | undefined;
    if (!view) throw new GltfError(`bufferView ${viewIndex} does not exist`);
    const buf = this.buffers[view.buffer];
    if (!buf) throw new GltfError(`bufferView ${viewIndex} points at missing buffer ${view.buffer}`);
    const off = view.byteOffset ?? 0;
    const len = view.byteLength ?? 0;
    if (off + len > buf.length) throw new GltfError(`bufferView ${viewIndex} runs past the end of buffer ${view.buffer}`);
    return buf.subarray(off, off + len);
  }

  readFloat(index: number, expectComps?: number): Float32Array {
    const hit = this.floatCache.get(index);
    if (hit) return hit;
    const { values, comps } = this.decode(index, true);
    if (expectComps !== undefined && comps !== expectComps) {
      throw new GltfError(`accessor ${index} has ${comps} components per element where ${expectComps} are expected`);
    }
    const out = values instanceof Float32Array ? values : Float32Array.from(values);
    this.floatCache.set(index, out);
    return out;
  }

  readUint(index: number): Uint32Array {
    const hit = this.uintCache.get(index);
    if (hit) return hit;
    const { values } = this.decode(index, false);
    const out = values instanceof Uint32Array ? values : Uint32Array.from(values);
    this.uintCache.set(index, out);
    return out;
  }

  private decode(index: number, normalize: boolean): { values: Float32Array | Uint32Array | Float64Array; comps: number } {
    const acc = this.json.accessors?.[index] as Json | undefined;
    if (!acc) throw new GltfError(`accessor ${index} does not exist`);
    const comps = TYPE_COMPONENTS[acc.type];
    const csize = COMPONENT_BYTES[acc.componentType];
    if (!comps || !csize) throw new GltfError(`accessor ${index} has an unknown type ${acc.type}/${acc.componentType}`);
    const count = acc.count ?? 0;
    if (!Number.isInteger(count) || count < 0) throw new GltfError(`accessor ${index} has an invalid count`);
    const norm = normalize && acc.normalized === true;
    const out = normalize ? new Float32Array(count * comps) : new Uint32Array(count * comps);

    // Matrices of 1- and 2-byte components pad each column to 4 bytes.
    const isMat = acc.type.startsWith('MAT');
    const rows = isMat ? Math.round(Math.sqrt(comps)) : comps;
    const cols = isMat ? rows : 1;
    const colStride = isMat ? Math.ceil((rows * csize) / 4) * 4 : comps * csize;
    const elemSize = colStride * cols;

    if (acc.bufferView !== undefined) {
      const view = this.json.bufferViews?.[acc.bufferView] as Json | undefined;
      const bytes = this.viewBytes(acc.bufferView);
      const stride = view?.byteStride ?? elemSize;
      const off = acc.byteOffset ?? 0;
      if (count > 0 && off + (count - 1) * stride + elemSize > bytes.length) {
        throw new GltfError(`accessor ${index} reads past the end of bufferView ${acc.bufferView}`);
      }
      this.readElements(bytes, off, stride, count, acc.componentType, comps, rows, colStride, norm, out);
    }

    if (acc.sparse) {
      const sp = acc.sparse as Json;
      const n = sp.count ?? 0;
      const idxBytes = this.viewBytes(sp.indices.bufferView);
      const idxType = sp.indices.componentType;
      const idxSize = COMPONENT_BYTES[idxType];
      if (!idxSize) throw new GltfError(`accessor ${index} has sparse indices of unknown type ${idxType}`);
      const idx = new Uint32Array(n);
      this.readElements(idxBytes, sp.indices.byteOffset ?? 0, idxSize, n, idxType, 1, 1, idxSize, false, idx);
      const valBytes = this.viewBytes(sp.values.bufferView);
      const vals = normalize ? new Float32Array(n * comps) : new Uint32Array(n * comps);
      this.readElements(valBytes, sp.values.byteOffset ?? 0, elemSize, n, acc.componentType, comps, rows, colStride, norm, vals);
      for (let k = 0; k < n; k++) {
        if (idx[k] >= count) throw new GltfError(`accessor ${index} has a sparse index ${idx[k]} past its ${count} elements`);
        for (let c = 0; c < comps; c++) out[idx[k] * comps + c] = vals[k * comps + c];
      }
    }
    return { values: out, comps };
  }

  private readElements(
    bytes: Uint8Array, offset: number, stride: number, count: number, type: number,
    comps: number, rows: number, colStride: number, norm: boolean, out: Float32Array | Uint32Array,
  ): void {
    const csize = COMPONENT_BYTES[type];
    const need = count > 0 ? offset + (count - 1) * stride + Math.ceil(comps / rows) * colStride : 0;
    if (need > bytes.length) throw new GltfError('an accessor reads past the end of its data');
    const abs = bytes.byteOffset + offset;
    // Fast path: tightly packed, aligned floats.
    if (type === 5126 && stride === comps * 4 && rows === comps && abs % 4 === 0 && out instanceof Float32Array) {
      out.set(new Float32Array(bytes.buffer, abs, count * comps));
      return;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read = (at: number): number => {
      switch (type) {
        case 5126: return dv.getFloat32(at, true);
        case 5125: return dv.getUint32(at, true);
        case 5123: { const v = dv.getUint16(at, true); return norm ? v / 65535 : v; }
        case 5122: { const v = dv.getInt16(at, true); return norm ? Math.max(v / 32767, -1) : v; }
        case 5121: { const v = dv.getUint8(at); return norm ? v / 255 : v; }
        default: { const v = dv.getInt8(at); return norm ? Math.max(v / 127, -1) : v; }
      }
    };
    for (let e = 0; e < count; e++) {
      const base = offset + e * stride;
      for (let c = 0; c < comps; c++) {
        const col = Math.floor(c / rows), row = c % rows;
        out[e * comps + c] = read(base + col * colStride + row * csize);
      }
    }
  }
}

// ── Geometry conversion ──────────────────────────────────────────────────

const geometryCache = new WeakMap<GltfPrimitive, Geometry>();

/** Is this primitive drawn as triangles (as opposed to points or lines)? */
export function isTrianglePrimitive(prim: GltfPrimitive): boolean {
  return prim.mode === GLTF_MODE.TRIANGLES || prim.mode === GLTF_MODE.TRIANGLE_STRIP || prim.mode === GLTF_MODE.TRIANGLE_FAN;
}

/**
 * The primitive as a renderer Geometry (cached per primitive, so the
 * renderer's per-Geometry VAO cache holds). Strips and fans become triangle
 * lists; a primitive without normals gets flat normals (as glTF specifies);
 * vertex colours become sRGB-encoded RGB for the mesh shader (the alpha
 * channel is dropped). Point and line
 * primitives come back as a vertex list in draw order, for 'points'/'lines'
 * draw modes or the line renderer.
 */
export function primitiveGeometry(prim: GltfPrimitive): Geometry {
  const hit = geometryCache.get(prim);
  if (hit) return hit;
  const n = prim.vertexCount;
  const order = prim.indices ?? (() => {
    const seq = new Uint32Array(n);
    for (let i = 0; i < n; i++) seq[i] = i;
    return seq;
  })();

  let geometry: Geometry;
  if (!isTrianglePrimitive(prim)) {
    geometry = gatherVertices(prim, order, false);
  } else {
    let tris: Uint32Array;
    if (prim.mode === GLTF_MODE.TRIANGLE_STRIP) {
      const out: number[] = [];
      for (let i = 0; i + 2 < order.length; i++) {
        if (i % 2 === 0) out.push(order[i], order[i + 1], order[i + 2]);
        else out.push(order[i + 1], order[i], order[i + 2]);
      }
      tris = Uint32Array.from(out);
    } else if (prim.mode === GLTF_MODE.TRIANGLE_FAN) {
      const out: number[] = [];
      for (let i = 1; i + 1 < order.length; i++) out.push(order[i], order[i + 1], order[0]);
      tris = Uint32Array.from(out);
    } else {
      tris = order.length % 3 === 0 ? order : order.subarray(0, order.length - (order.length % 3));
    }
    if (prim.normals) {
      geometry = {
        positions: prim.positions,
        normals: prim.normals,
        indices: n > 65535 ? tris : Uint16Array.from(tris),
        colors: prim.colors ? rgbOf(prim.colors, n) : undefined,
        uvs: prim.uvs,
      };
    } else {
      // Flat shading: one vertex per triangle corner, face normals.
      geometry = gatherVertices(prim, tris, true);
    }
  }
  geometryCache.set(prim, geometry);
  return geometry;
}

/** glTF vertex colours are linear; the mesh shader decodes sRGB, so encode them. */
function linearToSrgbChannel(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbOf(rgba: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    out[v * 3] = linearToSrgbChannel(rgba[v * 4]);
    out[v * 3 + 1] = linearToSrgbChannel(rgba[v * 4 + 1]);
    out[v * 3 + 2] = linearToSrgbChannel(rgba[v * 4 + 2]);
  }
  return out;
}

/** De-index a primitive into a plain vertex list in `order`. */
function gatherVertices(prim: GltfPrimitive, order: Uint32Array, flatNormals: boolean): Geometry {
  const m = order.length;
  const positions = new Float32Array(m * 3);
  const colors = prim.colors ? new Float32Array(m * 3) : undefined;
  const uvs = prim.uvs ? new Float32Array(m * 2) : undefined;
  const normalsIn = prim.normals;
  const normals = new Float32Array(m * 3);
  for (let k = 0; k < m; k++) {
    const v = order[k];
    positions.set(prim.positions.subarray(v * 3, v * 3 + 3), k * 3);
    if (colors) {
      for (let c = 0; c < 3; c++) colors[k * 3 + c] = linearToSrgbChannel(prim.colors![v * 4 + c]);
    }
    if (uvs) uvs.set(prim.uvs!.subarray(v * 2, v * 2 + 2), k * 2);
    if (normalsIn) normals.set(normalsIn.subarray(v * 3, v * 3 + 3), k * 3);
  }
  const indices = m > 65535 ? new Uint32Array(m) : new Uint16Array(m);
  for (let k = 0; k < m; k++) indices[k] = k;
  const outNormals = flatNormals ? computeNormals(positions, indices) : (normalsIn ? normals : new Float32Array(m * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)));
  return { positions, normals: outNormals, indices, colors, uvs };
}

// ── Transforms, animation, flattening ────────────────────────────────────

/** Column-major matrix from translation, unit quaternion (x, y, z, w) and scale. */
export function mat4FromTRSQuat(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx; m[3] = 0;
  m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy; m[7] = 0;
  m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz; m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

/** A node's local matrix, with any animated TRS from `pose` taking precedence. */
export function nodeLocalMatrix(node: GltfNode, index: number, pose?: GltfPose, out?: Mat4): Mat4 {
  const o = pose?.get(index);
  if (node.matrix && !o) {
    const m = out ?? new Float32Array(16);
    m.set(node.matrix);
    return m;
  }
  return mat4FromTRSQuat(o?.translation ?? node.translation, o?.rotation ?? node.rotation, o?.scale ?? node.scale, out);
}

function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): QuatTuple {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0: number, k1: number;
  if (cos > 0.9995) {
    k0 = 1 - t; k1 = t;
  } else {
    const theta = Math.acos(Math.min(1, cos));
    const sin = Math.sin(theta);
    k0 = Math.sin((1 - t) * theta) / sin;
    k1 = Math.sin(t * theta) / sin;
  }
  const q: QuatTuple = [a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Evaluate one sampler at time t (seconds) into `comps` numbers. */
export function sampleAnimationSampler(s: GltfAnimationSampler, t: number, comps: number, isRotation: boolean): number[] {
  const input = s.input;
  const n = input.length;
  const cubic = s.interpolation === 'CUBICSPLINE';
  const value = (k: number): number[] => {
    const base = cubic ? (k * 3 + 1) * comps : k * comps;
    return Array.from(s.output.subarray(base, base + comps));
  };
  if (n === 0) return new Array(comps).fill(0);
  if (n === 1 || t <= input[0]) return value(0);
  if (t >= input[n - 1]) return value(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (input[mid] <= t) lo = mid; else hi = mid;
  }
  const t0 = input[lo], t1 = input[hi];
  const dt = t1 - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;
  if (s.interpolation === 'STEP') return value(lo);
  if (!cubic) {
    const a = value(lo), b = value(hi);
    if (isRotation && comps === 4) return slerp(a, b, u);
    return a.map((x, i) => x + (b[i] - x) * u);
  }
  // Cubic Hermite spline: keyframes store (in-tangent, value, out-tangent).
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const out: number[] = [];
  for (let c = 0; c < comps; c++) {
    const p0 = s.output[(lo * 3 + 1) * comps + c];
    const m0 = s.output[(lo * 3 + 2) * comps + c] * dt;
    const p1 = s.output[(hi * 3 + 1) * comps + c];
    const m1 = s.output[(hi * 3) * comps + c] * dt;
    out.push(h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1);
  }
  if (isRotation && comps === 4) {
    const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    return out.map((x) => x / l);
  }
  return out;
}

/**
 * Pose every animated node at time t (seconds) on the clip's own timeline.
 * Times before the first key hold the first value, after the last key the
 * last. Morph-weight channels are ignored.
 */
export function sampleAnimation(anim: GltfAnimation, t: number, out: GltfPose = new Map()): GltfPose {
  for (const ch of anim.channels) {
    if (ch.path === 'weights') continue;
    const s = anim.samplers[ch.sampler];
    const comps = ch.path === 'rotation' ? 4 : 3;
    const v = sampleAnimationSampler(s, t, comps, ch.path === 'rotation');
    let entry = out.get(ch.node);
    if (!entry) { entry = {}; out.set(ch.node, entry); }
    if (ch.path === 'translation') entry.translation = [v[0], v[1], v[2]];
    else if (ch.path === 'rotation') entry.rotation = [v[0], v[1], v[2], v[3]];
    else entry.scale = [v[0], v[1], v[2]];
  }
  return out;
}

/**
 * Map elapsed playback time (seconds, already multiplied by speed) onto a
 * clip: wraps when looping, holds the last frame otherwise.
 */
export function animationTime(anim: GltfAnimation, elapsed: number, loop = true): number {
  const d = anim.duration;
  if (!(d > 0)) return 0;
  if (!loop) return Math.max(0, Math.min(d, elapsed));
  const t = elapsed % d;
  return t < 0 ? t + d : t;
}

/** Resolve an animation by name or index; -1 when absent. */
export function findAnimation(doc: GltfDocument, which: string | number | undefined): number {
  if (typeof which === 'number') return Number.isInteger(which) && which >= 0 && which < doc.animations.length ? which : -1;
  if (typeof which === 'string') return doc.animations.findIndex((a) => a.name === which);
  return -1;
}

/** glTF (y-up) to scene (y-down) root conversion: a y mirror. */
export function gltfRootMatrix(): Mat4 {
  const m = mat4Identity();
  m[5] = -1;
  return m;
}

export interface FlattenOptions {
  /** Scene index [the document's default scene]. */
  scene?: number;
  /** Animated node transforms from sampleAnimation. */
  pose?: GltfPose;
  /** Matrix applied above the scene roots [gltfRootMatrix(), the y flip]. */
  root?: Mat4;
}

/**
 * Walk a scene and return one draw item per mesh primitive, with the node's
 * world matrix (root x parents x node). Matrices are built from quaternions
 * directly. Skinned meshes are placed by their node (bind pose).
 */
export function flattenScene(doc: GltfDocument, opts: FlattenOptions = {}): GltfDrawItem[] {
  const items: GltfDrawItem[] = [];
  const sceneIndex = opts.scene ?? doc.scene;
  const scene = doc.scenes[sceneIndex];
  if (!scene) return items;
  const root = opts.root ?? gltfRootMatrix();
  const visited = new Uint8Array(doc.nodes.length);
  const stack: Array<{ index: number; parent: Mat4 }> = scene.nodes.map((index) => ({ index, parent: root })).reverse();
  const local = new Float32Array(16);
  while (stack.length) {
    const { index, parent } = stack.pop()!;
    if (visited[index]) continue; // cycles and shared subtrees are invalid glTF
    visited[index] = 1;
    const node = doc.nodes[index];
    nodeLocalMatrix(node, index, opts.pose, local);
    const world = mat4Multiply(parent, local);
    if (node.mesh >= 0) {
      const mesh = doc.meshes[node.mesh];
      mesh.primitives.forEach((primitive, primitiveIndex) => {
        items.push({ nodeIndex: index, meshIndex: node.mesh, primitiveIndex, primitive, materialIndex: primitive.material, worldMatrix: world });
      });
    }
    for (let c = node.children.length - 1; c >= 0; c--) stack.push({ index: node.children[c], parent: world });
  }
  return items;
}

/** Axis-aligned bounds of flattened draw items in their (root) space. */
export function drawItemsBounds(items: GltfDrawItem[]): { min: Vec3Tuple; max: Vec3Tuple } {
  const min: Vec3Tuple = [Infinity, Infinity, Infinity], max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  for (const it of items) {
    const m = it.worldMatrix, a = it.primitive.min, b = it.primitive.max;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? b[0] : a[0], y = k & 2 ? b[1] : a[1], z = k & 4 ? b[2] : a[2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
      if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
      if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
    }
  }
  if (!items.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** A one-line summary for logs and validation replies. */
export function describeGltf(doc: GltfDocument): string {
  let prims = 0, verts = 0;
  for (const m of doc.meshes) for (const p of m.primitives) { prims++; verts += p.vertexCount; }
  const anims = doc.animations.map((a, i) => a.name ?? `#${i}`).join(', ');
  return `${doc.meshes.length} mesh(es), ${prims} primitive(s), ${verts} vertices, ${doc.materials.length} material(s), ` +
    `${doc.images.length} image(s), ${doc.nodes.length} node(s), ${doc.animations.length} animation(s)${anims ? ` [${anims}]` : ''}`;
}
