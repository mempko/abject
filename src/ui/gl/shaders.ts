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

/**
 * Blinn-Phong mesh shader for scene-vocabulary nodes. Ambient + up to 4
 * lights (directional when w=0, point when w=1). Colors premultiplied at
 * output. Normals renormalized after the model transform (uniform-ish scale
 * assumed for UI-scale objects).
 */
export const MESH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec3 vWorldPos;
out vec3 vNormal;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uViewProj * world;
}
`;

export const MESH_FS = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
uniform vec3  uColor;
uniform vec3  uEmissive;
uniform float uOpacity;
uniform vec3  uAmbient;
uniform vec3  uCameraPos;
uniform int   uLightCount;
uniform vec4  uLightPos[4];     // xyz + w (0=directional dir, 1=point pos)
uniform vec3  uLightColor[4];
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCameraPos - vWorldPos);
  vec3 c = uColor * uAmbient + uEmissive;
  for (int i = 0; i < 4; i++) {
    if (i >= uLightCount) break;
    vec3 lv = uLightPos[i].w > 0.5
      ? normalize(uLightPos[i].xyz - vWorldPos)
      : normalize(-uLightPos[i].xyz);
    float diff = max(dot(n, lv), 0.0);
    vec3 h = normalize(lv + view);
    float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.35;
    c += uColor * uLightColor[i] * diff + uLightColor[i] * spec;
  }
  outColor = vec4(c * uOpacity, uOpacity);
}
`;
