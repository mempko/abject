/**
 * GLSL sources for the WebGL2 compositor.
 *
 * All output colors are PREMULTIPLIED alpha; the renderer blends with
 * (ONE, ONE_MINUS_SRC_ALPHA), which is byte-equivalent to canvas2d
 * source-over. Textures upload with UNPACK_PREMULTIPLY_ALPHA_WEBGL so 2D
 * canvas content (which is stored premultiplied) composites without fringes.
 */

/** Vertex shader shared by quad-based passes (surface, glow, flat). */
export const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 aPos;       // unit quad, centered: -0.5..0.5
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec2 vUnit;                            // -0.5..0.5
void main() {
  vUnit = aPos;
  gl_Position = uViewProj * uModel * vec4(aPos, 0.0, 1.0);
}
`;

/**
 * Window slab front face: content texture masked by a rounded-corner SDF,
 * with a thin theme-tinted border, a dim factor for unfocused windows, and
 * an accent rim glow that hugs the inside edge when focused.
 */
export const SURFACE_FS = `#version 300 es
precision highp float;
in vec2 vUnit;
uniform sampler2D uTex;
uniform vec2  uSize;        // slab size in px
uniform float uRadius;      // corner radius px
uniform float uDim;         // 1 = full brightness, <1 dims unfocused windows
uniform float uOpacity;     // overall opacity (card fades)
uniform vec4  uBorderColor; // premultiplied; a=0 disables
uniform vec4  uRimColor;    // premultiplied accent; a=0 disables
uniform float uRimWidth;    // px
out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 pPx = vUnit * uSize;                       // local px from center
  float r = min(uRadius, min(uSize.x, uSize.y) * 0.5);
  float d = sdRoundRect(pPx, uSize * 0.5, r);
  float mask = 1.0 - smoothstep(-0.75, 0.75, d);  // ~1.5px AA edge
  if (mask <= 0.0) discard;

  vec2 uv = vUnit + 0.5;                          // 0..1, y-down matches canvas rows
  vec4 tex = texture(uTex, uv);                   // premultiplied
  vec3 rgb = tex.rgb * uDim;
  float a = tex.a;

  // Thin border just inside the edge
  if (uBorderColor.a > 0.0) {
    float border = (1.0 - smoothstep(-1.5, -0.25, d)) * smoothstep(-2.5, -1.5, d);
    rgb = mix(rgb, uBorderColor.rgb, border * uBorderColor.a);
    a = max(a, border * uBorderColor.a);
  }

  // Focus rim: soft accent band hugging the inside edge
  if (uRimColor.a > 0.0) {
    float rim = 1.0 - smoothstep(-uRimWidth, 0.0, abs(d + uRimWidth * 0.5) - uRimWidth * 0.5);
    rim = clamp(rim, 0.0, 1.0);
    rgb += uRimColor.rgb * rim;
    a = max(a, rim * uRimColor.a);
  }

  outColor = vec4(rgb, a) * mask * uOpacity;
}
`;

/**
 * Rounded-rect gaussian glow/shadow on an oversized quad. Coverage uses an
 * erf approximation so the falloff matches canvas2d shadowBlur (sigma =
 * blur/2). Two lobes: tight bright pass + wide soft pass (focus halo), or a
 * single lobe with offset (drop shadow).
 */
export const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUnit;
uniform vec2  uQuadSize;    // oversized quad px
uniform vec2  uHalfSize;    // glow rect half-size px
uniform float uRadius;
uniform vec2  uOffset;      // rect center offset within quad (px, +y down)
uniform vec3  uColor;       // straight color; premultiplied in-shader
uniform float uColorAlpha;
uniform float uA1; uniform float uSigma1;
uniform float uA2; uniform float uSigma2;
out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float gaussCoverage(float d, float sigma) {
  float x = d / (sigma * 1.41421356);
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float erfAbs = 1.0 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * exp(-x * x);
  float erf = sign(x) * erfAbs;
  return 0.5 * (1.0 - erf);
}
void main() {
  vec2 pPx = vUnit * uQuadSize - uOffset;
  float r = min(uRadius, min(uHalfSize.x, uHalfSize.y));
  float d = sdRoundRect(pPx, uHalfSize, r);
  float a = (uA1 * gaussCoverage(d, max(uSigma1, 0.001))
           + uA2 * gaussCoverage(d, max(uSigma2, 0.001))) * uColorAlpha;
  a = clamp(a, 0.0, 1.0);
  outColor = vec4(uColor * a, a);
}
`;

/** Solid premultiplied color quad (dim backdrops, scrollbar parts). */
export const FLAT_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;   // premultiplied
out vec4 outColor;
void main() { outColor = uColor; }
`;

/**
 * Bloom bright-pass: keep only pixels above a luminance threshold (soft knee),
 * feeding the blur chain. Samples a copy of the rendered scene.
 */
export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
// The region (uv, y-down) that may contribute glow: the owning window's
// screen rect. Everything outside is zeroed BEFORE the blur, so a bright
// neighbour cannot bleed into a window that never asked for bloom.
uniform vec4 uRect;
out vec4 outColor;
void main() {
  if (vUv.x < uRect.x || vUv.y < uRect.y || vUv.x > uRect.z || vUv.y > uRect.w) {
    outColor = vec4(0.0);
    return;
  }
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
  outColor = vec4(c * k, 1.0);
}
`;

/** Separable 9-tap gaussian blur; uDir is the per-tap texel step (h then v). */
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.194595; w[2] = 0.121622; w[3] = 0.054054; w[4] = 0.016216;
  vec3 c = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    c += texture(uTex, vUv + uDir * float(i)).rgb * w[i];
    c += texture(uTex, vUv - uDir * float(i)).rgb * w[i];
  }
  outColor = vec4(c, 1.0);
}
`;

/** Fullscreen overlay: blit the 2D chrome canvas over everything. */
/**
 * Bloom composite: the blurred glow as premultiplied light. The bright/blur
 * targets carry alpha 1 everywhere, so compositing them as-is would add full
 * coverage over transparent backbuffer pixels and paint the glow's dark areas
 * as opaque black around the window (visible on any light backdrop). Coverage
 * instead follows the glow's own brightness: no glow, no coverage.
 */
export const BLOOM_COMPOSITE_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uScale;      // intensity, normalised for the chain depth
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * uScale;
  outColor = vec4(c, clamp(max(max(c.r, c.g), c.b), 0.0, 1.0));
}
`;

/** Dual-filter bloom downsample: the centre plus four diagonal taps at half-pixel offsets. */
export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uHalfPixel;   // of the source level
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv - uHalfPixel).rgb;
  c += texture(uTex, vUv + uHalfPixel).rgb;
  c += texture(uTex, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  c += texture(uTex, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  outColor = vec4(c / 8.0, 1.0);
}
`;

/** Dual-filter bloom upsample: an eight-tap tent, added onto the finer level. */
export const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uHalfPixel;   // of the source level, times the radius
out vec4 outColor;
void main() {
  vec2 h = uHalfPixel;
  vec3 c = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(c / 12.0, 1.0);
}
`;

export const OVERLAY_VS = `#version 300 es
layout(location = 0) in vec2 aPos;   // fullscreen triangle in clip space
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);  // y-down uv
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const OVERLAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }
`;

/** Max simultaneous lights the mesh shader evaluates. */
export const MAX_MESH_LIGHTS = 8;

/** Default shadow map resolution (square depth texture); lights may ask for 512..4096. */
export const SHADOW_SIZE = 1024;

/** Depth-only pass from the shadow light's POV (renders caster depth). */
export const DEPTH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main() { gl_Position = uLightVP * uModel * vec4(aPos, 1.0); }
`;

export const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}
`;

/** How a mesh turns light into colour. Mirrors `shading` in the scene vocabulary. */
export type MeshShading = 'standard' | 'unlit' | 'toon' | 'matcap' | 'rim';

/**
 * One compiled mesh program. Rather than one giant branching shader (mobile
 * compilers are the constraint), each shading mode and each optional map is a
 * compile-time switch, and the renderer builds only the combinations a scene
 * actually uses. The instanced and dynamic mesh paths share the fragment code.
 */
export interface MeshVariant {
  shading: MeshShading;
  instanced: boolean;
  normalMap: boolean;
  roughnessMap: boolean;
  metalnessMap: boolean;
  aoMap: boolean;
  emissiveMap: boolean;
  matcapMap: boolean;
  envMap: boolean;
  clearcoat: boolean;
  sheen: boolean;
  transmission: boolean;
}

/** Stable cache key for a variant (also its program name). */
export function meshVariantKey(v: MeshVariant): string {
  const flags: Array<[boolean, string]> = [
    [v.instanced, 'I'], [v.normalMap, 'n'], [v.roughnessMap, 'r'], [v.metalnessMap, 'm'],
    [v.aoMap, 'o'], [v.emissiveMap, 'e'], [v.matcapMap, 'c'], [v.envMap, 'E'],
    [v.clearcoat, 'C'], [v.sheen, 'S'], [v.transmission, 'T'],
  ];
  return `mesh:${v.shading}:${flags.filter(([on]) => on).map(([, k]) => k).join('')}`;
}

/**
 * Mesh vertex shader. Explicit precision on BOTH stages so the linker never has
 * to reconcile a vertex out-varying against a fragment in-varying of differing
 * (or default) precision: desktop linkers are lenient, strict mobile drivers
 * (Adreno, Mali) reject a mismatched interpolant pair, which reads as "3D
 * silently absent". Normals use a proper normal matrix so non-uniform scale
 * stays lit correctly. Geometry without UVs gets box-projected ones from its
 * unit-space position, so textures and maps work on every primitive.
 *
 * `outline` builds the inverted-hull pass: the surface is pushed out along its
 * normal (or radially, for faceted convex primitives whose split normals would
 * crack at the corners) by a constant number of screen pixels.
 */
export function meshVertexSource(instanced: boolean, outline = false): string {
  return `#version 300 es
precision highp float;
precision highp int;
${instanced ? '#define INSTANCED 1' : ''}
${outline ? '#define OUTLINE 1' : ''}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
#ifdef INSTANCED
layout(location = 4) in vec4 iM0;
layout(location = 5) in vec4 iM1;
layout(location = 6) in vec4 iM2;
layout(location = 7) in vec4 iM3;
layout(location = 8) in vec3 iColor;
#else
layout(location = 2) in vec3 aColor;
#endif
layout(location = 3) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform float uPointSize;
uniform int uHasUv;
uniform vec4 uUvTransform;     // xy = repeat, zw = offset
#ifdef OUTLINE
uniform float uOutlineWidth;   // css px
uniform vec2 uViewportPx;      // css px
uniform float uHullRadial;     // 1 = expand along the position direction
#endif
out highp vec3 vWorldPos;
out highp vec3 vNormal;
out highp vec3 vColor;
out highp vec2 vUv;

vec2 projectedUv(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.x >= a.y && a.x >= a.z) return vec2(n.x > 0.0 ? -p.z : p.z, p.y) + 0.5;
  if (a.y >= a.z) return vec2(p.x, n.y > 0.0 ? p.z : -p.z) + 0.5;
  return vec2(n.z > 0.0 ? p.x : -p.x, p.y) + 0.5;
}

void main() {
#ifdef INSTANCED
  mat4 m = uModel * mat4(iM0, iM1, iM2, iM3);
  vec3 nrm = mat3(m) * aNormal;
  vColor = iColor;
#else
  mat4 m = uModel;
  vec3 nrm = uNormalMat * aNormal;
  vColor = aColor;
#endif
  vec4 world = m * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = nrm;
  vec2 uv = uHasUv != 0 ? aUv : projectedUv(aPos, aNormal);
  vUv = uv * uUvTransform.xy + uUvTransform.zw;
  gl_PointSize = uPointSize;
  vec4 clip = uViewProj * world;
#ifdef OUTLINE
  vec3 wdir = uHullRadial > 0.5 ? mat3(m) * (aPos + vec3(1e-5)) : nrm;
  float wl = length(wdir);
  wdir = wl > 1e-6 ? wdir / wl : vec3(0.0);
  vec4 clip2 = uViewProj * vec4(world.xyz + wdir, 1.0);
  vec2 dpx = (clip2.xy / clip2.w - clip.xy / clip.w) * uViewportPx;
  float dl = length(dpx);
  vec2 ndcDir = dl > 1e-6 ? dpx / dl : vec2(0.0);
  clip.xy += ndcDir * (2.0 * uOutlineWidth / uViewportPx) * clip.w;
#endif
  gl_Position = clip;
}
`;
}

/** Shared GLSL: colour transfer, fog, tone mapping and grading. */
const COMMON_GLSL = `
const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const vec3 ENV_UP = vec3(0.0, -1.0, 0.0);   // the world is y-down: up on screen is -y

uniform vec3  uCameraPos;
uniform int   uFogMode;       // 0 off, 1 linear, 2 exp, 3 exp2
uniform vec3  uFogColor;      // display (sRGB) colour, mixed after tone mapping
uniform vec4  uFogParams;     // x near, y far (camera distance), z density (per px), w start distance
uniform vec4  uFogHeight;     // x on (0/1), y fog surface world y, z falloff per px above it
uniform int   uToneMap;       // 0 none, 1 neutral, 2 aces, 3 agx
uniform float uExposure;
uniform vec4  uGrade;         // x contrast, y saturation, z temperature, w tint

vec3 srgbToLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
/** Textures are uploaded premultiplied; colour maps want the straight colour. */
vec3 unpremultiply(vec4 t) { return t.a > 1e-4 ? t.rgb / t.a : vec3(0.0); }

/** 1 = clear, 0 = fully fogged. Linear fog keeps its scene-relative near/far. */
float fogFactor() {
  if (uFogMode == 0) return 1.0;
  vec3 toP = vWorldPos - uCameraPos;
  float dist = length(toP);
  if (uFogMode == 1) {
    float f = clamp((uFogParams.y - dist) / max(uFogParams.y - uFogParams.x, 1e-3), 0.0, 1.0);
    if (uFogHeight.x > 0.5) {
      float above = max(0.0, uFogHeight.y - vWorldPos.y);
      f = 1.0 - (1.0 - f) * exp(-uFogHeight.z * above);
    }
    return f;
  }
  float len = max(0.0, dist - uFogParams.w);
  float optical = uFogParams.z * len;
  if (uFogHeight.x > 0.5) {
    // Height fog: density falls off exponentially above the fog surface.
    // Integrate it along the view ray from where the scene begins.
    vec3 rd = toP / max(dist, 1e-4);
    float startY = uCameraPos.y + rd.y * min(uFogParams.w, dist);
    float b = max(uFogHeight.z, 1e-6);
    float h0 = uFogHeight.y - startY;
    float bk = -b * rd.y;
    float base = uFogParams.z * exp(clamp(-b * h0, -60.0, 30.0));
    optical = abs(bk * len) > 1e-4 ? base * (1.0 - exp(clamp(-bk * len, -60.0, 30.0))) / bk : base * len;
  }
  float f = uFogMode == 3 ? exp(-optical * optical) : exp(-optical);
  return clamp(f, 0.0, 1.0);
}

/**
 * The desktop's hue-preserving highlight knee: below 0.85 on screen colour
 * passes through exactly; above it the PEAK channel rolls off toward 1 and
 * rgb scales uniformly, so an over-lit blue paddle stays blue instead of
 * clipping to white (and scenes keep the rolloff they were tuned under).
 */
vec3 tmNeutral(vec3 c) {
  const float K = 0.85;
  float peak = max(c.r, max(c.g, c.b));
  float pd = pow(max(peak, 0.0), 1.0 / 2.2);
  if (pd <= K) return c;
  float rd = K + (1.0 - K) * (1.0 - exp(-(pd - K) / (1.0 - K)));
  return c * pow(rd / pd, 2.2);
}
vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 tmAces(vec3 c) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = outM * rrtOdtFit(inM * (c / 0.6));
  return clamp(c, 0.0, 1.0);
}
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 tmAgx(vec3 c) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065180774));
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  c = outset * agxContrast(c);
  c = pow(max(c, 0.0), vec3(2.2));
  return clamp(fromRec2020 * c, 0.0, 1.0);
}
vec3 toneMap(vec3 c) {
  c = max(c, 0.0) * uExposure;
  if (uToneMap == 1) return tmNeutral(c);
  if (uToneMap == 2) return tmAces(c);
  if (uToneMap == 3) return tmAgx(c);
  return clamp(c, 0.0, 1.0);
}
/** Linear HDR radiance to the display: tone map, grade, encode sRGB, contrast. */
vec3 toDisplay(vec3 hdr) {
  vec3 c = toneMap(hdr);
  float l0 = dot(c, LUMA);
  c *= vec3(1.0 + 0.2 * uGrade.z + 0.1 * uGrade.w, 1.0 - 0.2 * uGrade.w, 1.0 - 0.2 * uGrade.z + 0.1 * uGrade.w);
  float l1 = dot(c, LUMA);
  c *= l1 > 1e-5 ? l0 / l1 : 1.0;
  c = max(mix(vec3(dot(c, LUMA)), c, uGrade.y), 0.0);
  vec3 d = linearToSrgb(min(c, vec3(1.0)));
  return clamp((d - 0.5) * uGrade.x + 0.5, 0.0, 1.0);
}
`;

/**
 * Mesh fragment shader for one variant. Colour inputs arrive LINEAR (the host
 * decodes uniform colours; vertex colours and colour maps are decoded here),
 * lighting happens in linear light, and toDisplay tone maps, grades and
 * encodes to sRGB. Output is premultiplied alpha, as everywhere else.
 */
export function meshFragmentSource(v: MeshVariant): string {
  const defs = [
    `#define SHADING_${v.shading.toUpperCase()} 1`,
    v.normalMap ? '#define NORMAL_MAP 1' : '',
    v.roughnessMap ? '#define ROUGHNESS_MAP 1' : '',
    v.metalnessMap ? '#define METALNESS_MAP 1' : '',
    v.aoMap ? '#define AO_MAP 1' : '',
    v.emissiveMap ? '#define EMISSIVE_MAP 1' : '',
    v.matcapMap ? '#define MATCAP_MAP 1' : '',
    v.envMap ? '#define ENV_MAP 1' : '',
    v.clearcoat ? '#define CLEARCOAT 1' : '',
    v.sheen ? '#define SHEEN 1' : '',
    v.transmission ? '#define TRANSMISSION 1' : '',
  ].filter(Boolean).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DShadow;
${defs}
#if defined(SHADING_STANDARD) || defined(SHADING_TOON)
#define LIT 1
#endif
in highp vec3 vWorldPos;
in highp vec3 vNormal;
in highp vec3 vColor;
in highp vec2 vUv;
out vec4 outColor;

uniform vec3  uColor;          // albedo, linear
uniform vec3  uEmissive;       // linear
uniform float uOpacity;
uniform float uMetalness;
uniform float uRoughness;
// Boolean flags carried as int (0/1), never a GLSL bool: several mobile drivers
// (notably Adreno) mishandle boolean uniform upload/packing.
uniform int   uUseVertexColor;
uniform int   uUseTexture;
uniform int   uAdditive;
uniform int   uFrontOnly;      // light-adding material on a closed shape: skip its far shell
uniform sampler2D uTex;
uniform float uEnvIntensity;   // this material's reflection strength

uniform int   uLightCount;
uniform vec4  uLightPos[${MAX_MESH_LIGHTS}];    // xyz + w (0 dir, 1 point, 2 spot, 3 hemisphere)
uniform vec3  uLightColor[${MAX_MESH_LIGHTS}];  // display rgb * intensity (hemisphere: sky)
uniform vec4  uLightDir[${MAX_MESH_LIGHTS}];    // xyz travel dir, w = range (0 = infinite)
uniform vec4  uLightSpot[${MAX_MESH_LIGHTS}];   // x cosInner, y cosOuter, z isSpot
uniform vec3  uLightGround[${MAX_MESH_LIGHTS}]; // hemisphere ground colour

// Image-based light: an analytic sky (gradient + sun) or an equirect map.
uniform vec3  uEnvTop;
uniform vec3  uEnvHorizon;
uniform vec3  uEnvBottom;
uniform vec3  uSunDir;         // toward the sun
uniform vec3  uSunColor;       // display rgb * intensity, zero = no sun
uniform float uSunSize;        // angular radius, radians
#ifdef ENV_MAP
uniform sampler2D uEnvMap;
uniform float uEnvMapLod;      // highest mip worth sampling
uniform float uEnvMapIntensity;
#endif

uniform int   uReceiveShadow;
uniform int   uShadowEnabled;
uniform int   uShadowLight;
uniform sampler2DShadow uShadowMap;
uniform mat4  uLightVP;
uniform vec4  uShadowParams;     // x texel (uv), y softness (texels), z depth bias, w normal offset (px)
uniform int   uSpotShadowEnabled;
uniform int   uSpotShadowLight;
uniform sampler2DShadow uSpotShadowMap;
uniform mat4  uSpotLightVP;
uniform vec4  uSpotShadowParams; // as above; w = normal offset per px of distance

#ifdef NORMAL_MAP
uniform sampler2D uNormalMap;
uniform float uNormalScale;
#endif
#ifdef ROUGHNESS_MAP
uniform sampler2D uRoughnessMap;
#endif
#ifdef METALNESS_MAP
uniform sampler2D uMetalnessMap;
#endif
#ifdef AO_MAP
uniform sampler2D uAoMap;
#endif
#ifdef EMISSIVE_MAP
uniform sampler2D uEmissiveMap;
#endif
#ifdef MATCAP_MAP
uniform sampler2D uMatcapMap;
#endif
#ifdef CLEARCOAT
uniform float uClearcoat;
uniform float uClearcoatRoughness;
#endif
#ifdef SHEEN
uniform float uSheen;
uniform vec3  uSheenColor;
#endif
#ifdef TRANSMISSION
uniform float uTransmission;
uniform float uIor;
#endif
#ifdef SHADING_TOON
uniform float uToonSteps;
#endif
#ifdef SHADING_RIM
uniform vec3  uRimColor;
uniform float uRimPower;
#endif
${COMMON_GLSL}

float distGGX(float ndh, float a) { float a2 = a * a; float d = ndh * ndh * (a2 - 1.0) + 1.0; return a2 / max(PI * d * d, 1e-5); }
float gSchlick(float ndx, float k) { return ndx / (ndx * (1.0 - k) + k); }
float gSmith(float ndv, float ndl, float r) { float k = (r + 1.0) * (r + 1.0) / 8.0; return gSchlick(ndv, k) * gSchlick(ndl, k); }
vec3 fresnel(float ct, vec3 f0) { return f0 + (1.0 - f0) * pow(clamp(1.0 - ct, 0.0, 1.0), 5.0); }

/** Split-sum environment BRDF, analytic fit (Karis, mobile). */
vec2 envBRDF(float ndv, float rough) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

vec3 skyRadiance(vec3 d) {
  float e = dot(d, ENV_UP);
  return e >= 0.0 ? mix(uEnvHorizon, uEnvTop, sqrt(e)) : mix(uEnvHorizon, uEnvBottom, sqrt(-e));
}
/** Cosine-convolved sky, in the same units as a flat ambient colour. */
vec3 skyIrradiance(vec3 n) {
  vec3 sky = mix(uEnvHorizon, uEnvTop, 0.67);
  vec3 ground = mix(uEnvHorizon, uEnvBottom, 0.67);
  return mix(ground, sky, 0.5 + 0.5 * dot(n, ENV_UP));
}
#ifdef ENV_MAP
vec2 equirectUv(vec3 d) {
  // Forward (-z, into the screen) is the image centre; up (-y) is the top row.
  return vec2(atan(d.x, -d.z) * (0.5 / PI) + 0.5, acos(clamp(-d.y, -1.0, 1.0)) / PI);
}
#endif
vec3 envDiffuse(vec3 n) {
#ifdef ENV_MAP
  return srgbToLinear(textureLod(uEnvMap, equirectUv(n), max(uEnvMapLod - 1.5, 0.0)).rgb) * uEnvMapIntensity;
#else
  return skyIrradiance(n);
#endif
}
/** Reflected environment, blurred by roughness. */
vec3 envSpecular(vec3 r, float rough) {
#ifdef ENV_MAP
  return srgbToLinear(textureLod(uEnvMap, equirectUv(r), sqrt(rough) * uEnvMapLod).rgb) * uEnvMapIntensity;
#else
  return mix(skyRadiance(r), skyIrradiance(r), smoothstep(0.0, 0.85, rough));
#endif
}

#ifdef LIT
const vec2 POISSON[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

/** Soft shadow: a rotated 12-tap Poisson disk of hardware-filtered compares. */
float shadowAt(sampler2DShadow map, mat4 vp, vec4 params, vec3 n, vec3 l, float offsetScale) {
  vec3 p = vWorldPos + n * params.w * offsetScale * (1.0 - 0.5 * max(dot(n, l), 0.0));
  vec4 lp = vp * vec4(p, 1.0);
  if (lp.w <= 0.0) return 1.0;
  vec3 proj = lp.xyz / lp.w * 0.5 + 0.5;
  float inside = step(0.0, proj.x) * step(proj.x, 1.0) * step(0.0, proj.y) * step(proj.y, 1.0) * step(proj.z, 1.0);
  float ref = proj.z - params.z * (1.0 + 2.0 * (1.0 - max(dot(n, l), 0.0)));
  float ang = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float s = sin(ang), c = cos(ang);
  mat2 rot = mat2(c, s, -s, c);
  float radius = params.x * max(params.y, 0.0);
  float sum = 0.0;
  for (int k = 0; k < 12; k++) {
    sum += textureLod(map, vec3(proj.xy + rot * POISSON[k] * radius, ref), 0.0);
  }
  return mix(1.0, sum / 12.0, inside);
}

vec3 lightVector(int i) {
  if (uLightPos[i].w < 0.5) return normalize(-uLightDir[i].xyz);
  return normalize(uLightPos[i].xyz - vWorldPos);
}

#ifdef SHADING_TOON
float toonBand(float x) {
  float steps = max(uToonSteps, 2.0);
  float s = clamp(x, 0.0, 1.0) * steps;
  float f = floor(s);
  float b = f + smoothstep(0.94, 1.0, s - f);
  return clamp(b / (steps - 1.0), 0.0, 1.0);
}
#endif

/**
 * One light's contribution. radiance includes range and cone falloff;
 * shadow is the light's shadow factor (1 = fully lit).
 */
void addLight(vec3 N, vec3 V, vec3 L, vec3 radiance, float shadow, float NdV, vec3 F0, float metal, float rough, float a,
              inout vec3 dDiff, inout vec3 dSpec, inout vec3 dCoat, inout vec3 dSheen) {
  float NdL = max(dot(N, L), 0.0);
  vec3 H = normalize(V + L);
  float NdH = max(dot(N, H), 0.0);
#ifdef SHADING_TOON
  // Cel bands: the shadow band keeps a share of the light (a painted shadow
  // tone rather than black), and cast shadows fall into it too.
  float band = toonBand(NdL * shadow);
  dDiff += radiance * mix(0.3, 1.0, band) * (1.0 - metal);
  float gloss = mix(160.0, 8.0, rough);
  float sp = smoothstep(0.45, 0.55, pow(NdH, gloss) * step(0.0, NdL)) * step(0.5, shadow);
  dSpec += radiance * mix(vec3(0.5), F0, metal) * sp * (1.0 - rough);
#else
  radiance *= shadow;
  float VdH = max(dot(V, H), 0.0);
  vec3 F = fresnel(VdH, F0);
  float D = distGGX(NdH, a);
  float G = gSmith(NdV, NdL, rough);
  vec3 spec = (D * G) * F / max(4.0 * NdV * NdL, 1e-4);
  vec3 kd = (vec3(1.0) - F) * (1.0 - metal);
  dDiff += kd * radiance * NdL;
  dSpec += spec * radiance * NdL;
#ifdef CLEARCOAT
  float ccR = clamp(uClearcoatRoughness, 0.04, 1.0);
  float Fc = (0.04 + 0.96 * pow(1.0 - VdH, 5.0)) * uClearcoat;
  dCoat += radiance * NdL * distGGX(NdH, ccR * ccR) * gSmith(NdV, NdL, ccR) * Fc / max(4.0 * NdV * NdL, 1e-4);
#endif
#ifdef SHEEN
  float sr = max(rough, 0.07);
  float sin2h = max(1.0 - NdH * NdH, 0.0078125);
  float Dc = (2.0 + 1.0 / sr) * pow(sin2h, 0.5 / sr) / (2.0 * PI);
  float Vn = 1.0 / max(4.0 * (NdL + NdV - NdL * NdV), 1e-4);
  dSheen += uSheenColor * uSheen * Dc * Vn * NdL * radiance;
#endif
#endif
}
#endif

#ifdef NORMAL_MAP
/**
 * Tangent-space normal mapping without tangent attributes: a per-pixel
 * cotangent frame from screen derivatives. The sign corrects for the
 * y-flipped projection. Image rows run down the texture (v grows downward)
 * while maps encode +Y as up, so green steers against the v gradient.
 */
vec3 perturbNormal(vec3 N) {
  vec3 dp1 = dFdx(vWorldPos);
  vec3 dp2 = dFdy(vWorldPos);
  vec2 duv1 = dFdx(vUv);
  vec2 duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float m2 = max(dot(T, T), dot(B, B));
  float invmax = m2 > 0.0 ? inversesqrt(m2) : 0.0;
  float hand = dot(cross(dp1, dp2), N) < 0.0 ? -1.0 : 1.0;
  vec3 t = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;
  t.xy *= uNormalScale;
  vec3 pn = T * (invmax * hand * t.x) - B * (invmax * hand * t.y) + N * t.z;
  float pl = length(pn);
  return (invmax > 0.0 && pl > 1e-5) ? pn / pl : N;
}
#endif

#ifdef SHADING_MATCAP
/** A procedural studio matcap: key light upper left, soft fill, rim, floor bounce. */
vec3 studioMatcap(vec2 m) {
  vec3 n = vec3(m, sqrt(max(1.0 - dot(m, m), 0.0)));
  vec3 key = normalize(vec3(-0.5, 0.65, 0.6));
  float diff = max(dot(n, key), 0.0);
  float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n), key), 0.0), 40.0);
  float rim = pow(1.0 - n.z, 3.0);
  float bounce = smoothstep(0.0, -0.9, n.y) * 0.18;
  return vec3(0.08 + 0.8 * diff + 0.35 * rim + bounce) + vec3(1.0, 0.98, 0.95) * spec * 1.2;
}
#endif

void main() {
  vec3 albedo = uColor;
  if (uUseVertexColor != 0) albedo *= srgbToLinear(vColor);
  float alpha = uOpacity;
  if (uUseTexture != 0) {
    vec4 t = texture(uTex, vUv);
    albedo *= srgbToLinear(unpremultiply(t));
    alpha *= t.a;
  }
  vec3 emissive = uEmissive;
#ifdef EMISSIVE_MAP
  emissive *= srgbToLinear(unpremultiply(texture(uEmissiveMap, vUv)));
#endif

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  // A glow or glass on a closed shape shows its near shell only; its far
  // shell would add the same light a second time.
  if (uFrontOnly != 0 && dot(N, V) < 0.0) discard;
  if (dot(N, V) < 0.0) N = -N;   // two-sided: author surfaces need not get winding right
  vec3 Ngeo = N;
#ifdef NORMAL_MAP
  N = perturbNormal(N);
#endif
  float NdV = max(dot(N, V), 1e-4);
  float fog = fogFactor();
  vec3 color;
  float cover = alpha;          // how much of what is behind this surface it hides
  vec3 over = vec3(0.0);        // light added on top without coverage (glass reflections)

#if defined(SHADING_UNLIT)
  color = albedo + emissive;
#elif defined(SHADING_MATCAP)
  vec3 right = cross(V, ENV_UP);
  float rl = length(right);
  right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 upv = cross(right, V);
  vec2 mc = vec2(dot(right, N), dot(upv, N));
#ifdef MATCAP_MAP
  vec3 cap = srgbToLinear(unpremultiply(texture(uMatcapMap, vec2(0.5 + 0.495 * mc.x, 0.5 - 0.495 * mc.y))));
#else
  vec3 cap = studioMatcap(mc);
#endif
  color = cap * albedo + emissive;
#elif defined(SHADING_RIM)
  float fres = pow(1.0 - NdV, max(uRimPower, 0.1));
  color = albedo * envDiffuse(N) * 0.6 + emissive + uRimColor * (0.35 + 2.2 * fres);
  cover = alpha * clamp(0.08 + 0.92 * fres, 0.0, 1.0);
#else
  float metal = clamp(uMetalness, 0.0, 1.0);
  float rough = uRoughness;
#ifdef ROUGHNESS_MAP
  rough *= texture(uRoughnessMap, vUv).g;
#endif
#ifdef METALNESS_MAP
  metal *= texture(uMetalnessMap, vUv).b;
#endif
  float ao = 1.0;
#ifdef AO_MAP
  ao = texture(uAoMap, vUv).r;
#endif
  rough = clamp(rough, 0.04, 1.0);
  float a = rough * rough;
#ifdef TRANSMISSION
  float f0d = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
#else
  float f0d = 0.04;
#endif
  // Direct light is display-referred, the way this desktop has always lit:
  // each light scales the albedo as it appears on screen (colour x intensity
  // x the surface's angle to it), lights and ambient add as they look, and
  // the total returns to linear light for reflections, tone mapping and
  // grading. Scenes tuned by eye keep their brightness and hue: strong
  // lights over dark albedos, several lights balancing each other.
  vec3 albedoD = linearToSrgb(albedo);
  vec3 F0 = mix(vec3(f0d), albedoD, metal);     // direct highlights
  vec3 F0L = mix(vec3(f0d), albedo, metal);     // environment reflection (linear reflectance)

  // Shadow factors, sampled once outside the light loop.
  float shDir = 1.0;
  float shSpot = 1.0;
  if (uReceiveShadow != 0 && uShadowEnabled != 0) {
    shDir = shadowAt(uShadowMap, uLightVP, uShadowParams, Ngeo, lightVector(uShadowLight), 1.0);
  }
  if (uReceiveShadow != 0 && uSpotShadowEnabled != 0) {
    shSpot = shadowAt(uSpotShadowMap, uSpotLightVP, uSpotShadowParams, Ngeo, lightVector(uSpotShadowLight),
                      length(uLightPos[uSpotShadowLight].xyz - vWorldPos));
  }

  vec3 dDiff = vec3(0.0);
  vec3 dSpec = vec3(0.0);
  vec3 dCoat = vec3(0.0);
  vec3 dSheen = vec3(0.0);
  for (int i = 0; i < ${MAX_MESH_LIGHTS}; i++) {
    // continue, not break: the trip count stays a compile-time constant so the
    // loop fully unrolls. A data-dependent break defeats unrolling on some
    // mobile compilers, which then choke on the dynamically indexed arrays.
    if (i >= uLightCount) continue;
    vec4 lp = uLightPos[i];
    if (lp.w > 2.5) {
      // Hemisphere: sky colour from above blending into ground colour below.
      float e = dot(N, -normalize(uLightDir[i].xyz));
#ifdef SHADING_TOON
      e = e > 0.0 ? 1.0 : -1.0;
#endif
      dDiff += mix(uLightGround[i], uLightColor[i], 0.5 + 0.5 * e) * (1.0 - metal);
      continue;
    }
    vec3 L;
    float atten = 1.0;
    if (lp.w < 0.5) {
      L = normalize(-uLightDir[i].xyz);
    } else {
      vec3 toL = lp.xyz - vWorldPos;
      float dist = length(toL);
      L = toL / max(dist, 1e-4);
      float range = uLightDir[i].w;
      if (range > 0.0) { float f = clamp(1.0 - pow(dist / range, 4.0), 0.0, 1.0); atten *= f * f; }
      if (uLightSpot[i].z > 0.5) {
        // Cone around the aim direction (the way the light travels). -L runs
        // from the light to this fragment.
        float cd = dot(normalize(uLightDir[i].xyz), -L);
        atten *= smoothstep(uLightSpot[i].y, uLightSpot[i].x, cd);
      }
    }
    if (atten <= 0.0) continue;
    float sh = 1.0;
    if (uShadowEnabled != 0 && i == uShadowLight) sh = shDir;
    if (uSpotShadowEnabled != 0 && i == uSpotShadowLight) sh = min(sh, shSpot);
    addLight(N, V, L, uLightColor[i] * atten, sh, NdV, F0, metal, rough, a, dDiff, dSpec, dCoat, dSheen);
  }
  // A sky sun lights like a directional light whose highlight widens with its disk.
  if (dot(uSunColor, uSunColor) > 0.0) {
    float sunRough = clamp(sqrt(a + uSunSize * 0.5), 0.04, 1.0);
    addLight(N, V, uSunDir, uSunColor, 1.0, NdV, F0, metal, sunRough, sunRough * sunRough, dDiff, dSpec, dCoat, dSheen);
  }

  // Image-based light: diffuse irradiance plus a roughness-blurred reflection,
  // weighted by the split-sum BRDF with multiple-scattering compensation (so
  // rough metals keep their energy).
#ifdef SHADING_TOON
  vec3 irr = envDiffuse(V);
#else
  vec3 irr = envDiffuse(N);
#endif
  vec3 R = reflect(-V, N);
  vec2 ab = envBRDF(NdV, rough);
  vec3 FssEss = F0L * ab.x + ab.y;
  float Ems = 1.0 - (ab.x + ab.y);
  vec3 Favg = F0L + (1.0 - F0L) / 21.0;
  vec3 specW = FssEss + FssEss * Favg / (1.0 - Ems * Favg) * Ems;
#ifdef SHADING_TOON
  vec3 iblSpec = vec3(0.0);
#else
  vec3 iblSpec = envSpecular(R, rough) * specW * uEnvIntensity * ao;
#endif
  // Ambient: the environment's irradiance, added like a light. Metals take
  // theirs from the environment's reflection instead.
  vec3 bodyD = albedoD * (dDiff + linearToSrgb(irr) * (1.0 - metal) * ao);
  vec3 emissiveD = linearToSrgb(emissive);
  vec3 extra = vec3(0.0);
#ifdef SHEEN
  // Velvet: a soft grazing-angle glow over the body, lit and ambient.
  bodyD += dSheen;
  extra += uSheenColor * uSheen * irr * (0.08 + 0.5 * pow(1.0 - NdV, 4.0));
#endif
#ifdef TRANSMISSION
  // Glass-lite: diffuse gives way to see-through. Coverage follows the
  // dielectric Fresnel (clear face-on, reflective at grazing angles); the
  // reflections themselves ride on top as light with no coverage.
  float tr = clamp(uTransmission, 0.0, 1.0) * (1.0 - metal);
  float Fv = f0d + (1.0 - f0d) * pow(1.0 - NdV, 5.0);
  color = srgbToLinear(bodyD * (1.0 - tr) + emissiveD) + albedo * irr * tr * 0.5 + extra;
  cover = alpha * mix(1.0, min(1.0, Fv + 0.04), tr);
  over = srgbToLinear(dSpec) + iblSpec;
#else
  color = srgbToLinear(bodyD + dSpec + emissiveD) + iblSpec + extra;
#endif
#ifdef CLEARCOAT
  float Fcv = (0.04 + 0.96 * pow(1.0 - max(dot(Ngeo, V), 1e-4), 5.0)) * clamp(uClearcoat, 0.0, 1.0);
  vec3 coat = srgbToLinear(dCoat) + envSpecular(reflect(-V, Ngeo), clamp(uClearcoatRoughness, 0.04, 1.0)) * uEnvIntensity * Fcv;
  color = color * (1.0 - Fcv) + coat;
#endif
#endif

  vec3 rgb = mix(uFogColor, toDisplay(color), fog) * cover;
#if defined(TRANSMISSION) && defined(LIT)
  rgb += toDisplay(over) * fog * alpha;
#endif
  outColor = vec4(rgb, uAdditive != 0 ? 0.0 : cover);
}
`;
}

/** Inverted-hull outline: the expanded surface's back faces in a flat colour. */
export const OUTLINE_FS = `#version 300 es
precision highp float;
precision highp int;
in highp vec3 vWorldPos;
in highp vec3 vNormal;
in highp vec3 vColor;
in highp vec2 vUv;
out vec4 outColor;
uniform vec4 uOutlineColor;   // display rgb, alpha
${COMMON_GLSL}
void main() {
  if (dot(vNormal, uCameraPos - vWorldPos) > 0.0) discard;
  vec3 d = mix(uFogColor, uOutlineColor.rgb, fogFactor());
  outColor = vec4(d * uOutlineColor.a, uOutlineColor.a);
}
`;

/** The default variant: standard shading, no maps. */
export const DEFAULT_MESH_VARIANT: MeshVariant = {
  shading: 'standard', instanced: false, normalMap: false, roughnessMap: false, metalnessMap: false,
  aoMap: false, emissiveMap: false, matcapMap: false, envMap: false,
  clearcoat: false, sheen: false, transmission: false,
};

/** Default-variant sources, kept under their historical names. */
export const MESH_VS = meshVertexSource(false);
export const MESH_INSTANCED_VS = meshVertexSource(true);
export const MESH_FS = meshFragmentSource(DEFAULT_MESH_VARIANT);
