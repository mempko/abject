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

/** Fullscreen overlay: blit the 2D chrome canvas over everything. */
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

/**
 * Metallic-roughness mesh shader for scene-vocabulary nodes. Supports
 * per-vertex color (location 2), albedo texture UVs (location 3),
 * point/directional/spot lights with range falloff, distance fog, and a
 * Cook-Torrance-lite specular term. Output is premultiplied alpha. Normals
 * use a proper normal matrix so non-uniform scale (stretched water grids,
 * ellipsoids) stays lit correctly.
 */
export const MESH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
layout(location = 3) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform float uPointSize;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vColor;
out vec2 vUv;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = uNormalMat * aNormal;
  vColor = aColor;
  vUv = aUv;
  gl_PointSize = uPointSize;
  gl_Position = uViewProj * world;
}
`;

/**
 * Instanced variant: one geometry drawn many times, each instance carrying
 * its own model matrix (locations 4-7) and color (location 8). Reuses MESH_FS
 * (vertex color path = instance color). uModel is the parent node transform.
 */
export const MESH_INSTANCED_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 4) in vec4 iM0;
layout(location = 5) in vec4 iM1;
layout(location = 6) in vec4 iM2;
layout(location = 7) in vec4 iM3;
layout(location = 8) in vec3 iColor;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform float uPointSize;
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vColor;
out vec2 vUv;
void main() {
  mat4 m = uModel * mat4(iM0, iM1, iM2, iM3);
  vec4 world = m * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = mat3(m) * aNormal;
  vColor = iColor;
  vUv = vec2(0.0);
  gl_PointSize = uPointSize;
  gl_Position = uViewProj * world;
}
`;

export const MESH_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vColor;
in vec2 vUv;
uniform vec3  uColor;        // albedo
uniform vec3  uEmissive;
uniform float uOpacity;
uniform float uMetalness;
uniform float uRoughness;
uniform vec3  uAmbient;
uniform vec3  uCameraPos;
uniform bool  uUseVertexColor;
uniform bool  uUseTexture;
uniform sampler2D uTex;
uniform int   uLightCount;
uniform vec4  uLightPos[${MAX_MESH_LIGHTS}];   // xyz + w (0=dir, 1=point, 2=spot)
uniform vec3  uLightColor[${MAX_MESH_LIGHTS}]; // rgb * intensity
uniform vec4  uLightDir[${MAX_MESH_LIGHTS}];   // xyz aim dir (dir/spot), w = range (0 = infinite)
uniform vec4  uLightSpot[${MAX_MESH_LIGHTS}];  // x=cosInner, y=cosOuter, z=isSpot
uniform bool  uFogEnabled;
uniform vec3  uFogColor;
uniform vec2  uFogRange;      // near, far
out vec4 outColor;

const float PI = 3.14159265359;
float distGGX(float ndh, float a) { float a2 = a * a; float d = ndh * ndh * (a2 - 1.0) + 1.0; return a2 / max(PI * d * d, 1e-5); }
float gSchlick(float ndx, float k) { return ndx / (ndx * (1.0 - k) + k); }
float gSmith(float ndv, float ndl, float r) { float k = (r + 1.0) * (r + 1.0) / 8.0; return gSchlick(ndv, k) * gSchlick(ndl, k); }
vec3 fresnel(float ct, vec3 f0) { return f0 + (1.0 - f0) * pow(clamp(1.0 - ct, 0.0, 1.0), 5.0); }

void main() {
  vec3 albedo = uColor;
  if (uUseVertexColor) albedo *= vColor;
  float alpha = uOpacity;
  if (uUseTexture) { vec4 t = texture(uTex, vUv); albedo *= t.rgb; alpha *= t.a; }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  if (dot(N, V) < 0.0) N = -N;   // two-sided: author surfaces need not get winding right

  vec3 F0 = mix(vec3(0.04), albedo, uMetalness);
  float rough = clamp(uRoughness, 0.04, 1.0);
  float a = rough * rough;
  vec3 Lo = vec3(0.0);
  for (int i = 0; i < ${MAX_MESH_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 L; float atten = 1.0;
    if (uLightPos[i].w < 0.5) {
      L = normalize(-uLightDir[i].xyz);                 // directional
    } else {
      vec3 toL = uLightPos[i].xyz - vWorldPos;
      float dist = length(toL);
      L = toL / max(dist, 1e-4);
      float range = uLightDir[i].w;
      if (range > 0.0) { float f = clamp(1.0 - pow(dist / range, 4.0), 0.0, 1.0); atten *= f * f; }
      if (uLightSpot[i].z > 0.5) {                      // spot cone
        float cd = dot(normalize(-uLightDir[i].xyz), -L);
        atten *= smoothstep(uLightSpot[i].y, uLightSpot[i].x, cd);
      }
    }
    if (atten <= 0.0) continue;
    vec3 radiance = uLightColor[i] * atten;
    float NdL = max(dot(N, L), 0.0);
    vec3 H = normalize(V + L);
    float NdV = max(dot(N, V), 1e-4);
    float NdH = max(dot(N, H), 0.0);
    float VdH = max(dot(V, H), 0.0);
    float D = distGGX(NdH, a);
    float G = gSmith(NdV, NdL, rough);
    vec3  F = fresnel(VdH, F0);
    vec3 spec = (D * G) * F / max(4.0 * NdV * NdL, 1e-4);
    vec3 kd = (vec3(1.0) - F) * (1.0 - uMetalness);
    Lo += (kd * albedo + spec) * radiance * NdL;
  }
  vec3 color = uAmbient * albedo + Lo + uEmissive;

  if (uFogEnabled) {
    float d = length(uCameraPos - vWorldPos);
    float f = clamp((uFogRange.y - d) / max(uFogRange.y - uFogRange.x, 1e-3), 0.0, 1.0);
    color = mix(uFogColor, color, f);
  }
  outColor = vec4(color * alpha, alpha);
}
`;
