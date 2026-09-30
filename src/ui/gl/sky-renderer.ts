/**
 * Sky dome for `sky` scene nodes (and an environment's `sky`), drawn first in
 * a subtree behind everything else in it.
 *
 * One fullscreen triangle: the vertex shader unprojects each corner through
 * the inverse view-projection to the near and far planes, so the fragment
 * shader gets the exact view ray of every pixel for ANY camera, including a
 * window's off-axis camera and a user camera node. Depth test and depth
 * writes are off; the caller's scissor or stencil clip still applies, so a
 * window sky stays inside its window.
 *
 * The sky is a top / horizon / bottom gradient (or an equirectangular image),
 * an optional sun disk with a soft glow, and optional procedural stars that
 * twinkle over `time`. World convention: y-down, so "up" is -y; the horizon
 * is the plane y = 0 through the eye. The sun `direction` points FROM the
 * scene TOWARD the sun (where it appears in the sky).
 */

import type { Mat4 } from './math.js';
import type { RGBA } from './renderer.js';
import { GlHost, buildProgram, contextGeneration, restoreRendererState } from './program-cache.js';

const SKY_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 aPos;
uniform mat4 uInvViewProj;
out highp vec3 vNear;
out highp vec3 vFar;
void main() {
  vec4 n = uInvViewProj * vec4(aPos, -1.0, 1.0);
  vec4 f = uInvViewProj * vec4(aPos, 1.0, 1.0);
  vNear = n.xyz / n.w;
  vFar = f.xyz / f.w;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const SKY_FS = `#version 300 es
precision highp float;
precision highp int;
in highp vec3 vNear;
in highp vec3 vFar;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform float uSharpness;
uniform int uSunEnabled;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunCos;
uniform float uSunIntensity;
uniform float uStars;
uniform float uTime;
uniform int uUseTexture;
uniform sampler2D uTex;
uniform float uTexIntensity;
uniform float uRotation;
uniform float uOpacity;
out vec4 outColor;

const float PI = 3.14159265358979;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 rotateY(vec3 d, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
}

void main() {
  vec3 dir = normalize(vFar - vNear);
  vec3 rdir = rotateY(dir, uRotation);
  float up = -dir.y;
  vec3 col;
  if (uUseTexture != 0) {
    // The image centre (u = 0.5) faces -z, the way the desktop camera looks.
    float u = atan(rdir.x, -rdir.z + 1e-7) / (2.0 * PI) + 0.5;
    float v = acos(clamp(-rdir.y, -1.0, 1.0)) / PI;
    col = textureLod(uTex, vec2(u, v), 0.0).rgb * uTexIntensity;
  } else {
    float t = 1.0 - exp(-abs(up) * uSharpness);
    col = up >= 0.0 ? mix(uHorizon, uTop, t) : mix(uHorizon, uBottom, t);
  }

  if (uStars > 0.0) {
    // One candidate star per cell of a grid wrapped around the view sphere.
    float scale = 180.0;
    vec3 sd = rdir * scale;
    vec3 cell = floor(sd);
    float h = hash13(cell);
    if (h < uStars * 0.12) {
      vec3 jitter = vec3(hash13(cell + 17.13), hash13(cell + 31.71), hash13(cell + 47.37));
      vec3 star = normalize(cell + 0.25 + 0.5 * jitter);
      float ang = length(rdir - star);
      float px = max(length(fwidth(rdir)), 1e-5);
      float size = px * (0.7 + 1.1 * jitter.x);
      float b = 1.0 - smoothstep(0.0, size, ang);
      float twinkle = 0.7 + 0.3 * sin(uTime * (1.3 + 3.0 * jitter.y) + h * 91.0);
      float horizonFade = smoothstep(-0.02, 0.12, up);
      vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.75), jitter.z);
      col += tint * b * twinkle * horizonFade * (0.6 + 0.8 * jitter.y);
    }
  }

  if (uSunEnabled != 0) {
    float c = dot(dir, uSunDir);
    float aa = max(fwidth(c), 1e-6);
    float disk = smoothstep(uSunCos - aa, uSunCos + aa, c);
    float g = max(c, 0.0);
    float glow = pow(g, 900.0) * 0.6 + pow(g, 90.0) * 0.25 + pow(g, 8.0) * 0.08;
    col += uSunColor * uSunIntensity * (disk + glow);
  }

  outColor = vec4(col * uOpacity, uOpacity);
}
`;

const SKY_UNIFORMS = [
  'uInvViewProj', 'uTop', 'uHorizon', 'uBottom', 'uSharpness',
  'uSunEnabled', 'uSunDir', 'uSunColor', 'uSunCos', 'uSunIntensity',
  'uStars', 'uTime', 'uUseTexture', 'uTex', 'uTexIntensity', 'uRotation', 'uOpacity',
];

/** A colour as an RGBA object or [r, g, b] (0..1). */
export type SkyColor = RGBA | ArrayLike<number>;

export interface SkySun {
  /** Toward the sun (y-down world: a sun above the horizon has y < 0). */
  direction: [number, number, number];
  color?: SkyColor;
  /** Angular RADIUS of the disk in degrees [2] (as an environment sky's sun). */
  size?: number;
  intensity?: number;
}

export interface SkyOptions {
  top?: SkyColor;
  horizon?: SkyColor;
  bottom?: SkyColor;
  sun?: SkySun;
  /** true, or a density 0..1 (true = 0.5). */
  stars?: boolean | number;
  /**
   * Equirectangular image (replaces the gradient): top row = straight up,
   * the image centre faces -z (into the screen). Give it REPEAT wrapping on
   * s for a seamless back seam.
   */
  texture?: WebGLTexture;
  textureIntensity?: number;
  /** Turn the sky around the vertical axis, radians. */
  rotation?: number;
  /** Seconds, for star twinkle. */
  time?: number;
  opacity?: number;
  /** How quickly the gradient leaves the horizon color [6]. */
  sharpness?: number;
}

export interface SkyDrawOpts extends SkyOptions {
  /** Inverse of the view-projection the subtree renders through. */
  invViewProj: Mat4;
}

/** Defaults: a deep blue night-to-dusk gradient. */
export const SKY_DEFAULTS = {
  top: [0.06, 0.09, 0.2] as [number, number, number],
  horizon: [0.42, 0.5, 0.68] as [number, number, number],
  bottom: [0.08, 0.08, 0.1] as [number, number, number],
  sunColor: [1.0, 0.92, 0.78] as [number, number, number],
  sunSize: 2,
  sharpness: 6,
};

function rgb(c: SkyColor | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!c) return fallback;
  if (typeof (c as RGBA).r === 'number') {
    const o = c as RGBA;
    return [o.r, o.g, o.b];
  }
  const a = c as ArrayLike<number>;
  return [a[0] ?? fallback[0], a[1] ?? fallback[1], a[2] ?? fallback[2]];
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function starDensity(stars: SkyOptions['stars']): number {
  if (stars === true) return 0.5;
  if (typeof stars === 'number' && Number.isFinite(stars)) return Math.max(0, Math.min(1, stars));
  return 0;
}

/**
 * The gradient-and-sun colour of the sky in a direction, on the CPU (same
 * formula as the shader, without stars or texture). Handy for deriving
 * ambient or fog colours that match the sky.
 */
export function skyColorAt(opts: SkyOptions, direction: [number, number, number]): [number, number, number] {
  const d = normalize3(direction);
  const top = rgb(opts.top, SKY_DEFAULTS.top), hor = rgb(opts.horizon, SKY_DEFAULTS.horizon), bot = rgb(opts.bottom, SKY_DEFAULTS.bottom);
  const up = -d[1];
  const t = 1 - Math.exp(-Math.abs(up) * (opts.sharpness ?? SKY_DEFAULTS.sharpness));
  const to = up >= 0 ? top : bot;
  const col: [number, number, number] = [hor[0] + (to[0] - hor[0]) * t, hor[1] + (to[1] - hor[1]) * t, hor[2] + (to[2] - hor[2]) * t];
  if (opts.sun) {
    const s = normalize3(opts.sun.direction);
    const c = Math.max(0, d[0] * s[0] + d[1] * s[1] + d[2] * s[2]);
    const sc = rgb(opts.sun.color, SKY_DEFAULTS.sunColor);
    const k = (opts.sun.intensity ?? 1) * (Math.pow(c, 900) * 0.6 + Math.pow(c, 90) * 0.25 + Math.pow(c, 8) * 0.08);
    col[0] += sc[0] * k; col[1] += sc[1] * k; col[2] += sc[2] * k;
  }
  return col;
}

export class SkyRenderer {
  private readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject | null = null;
  private buf: WebGLBuffer | null = null;
  private generation = 0;

  constructor(private readonly host: GlHost) {
    this.gl = host.context;
  }

  /** False when this GPU could not build the sky program (draws are no-ops). */
  get available(): boolean {
    return buildProgram(this.gl, 'sky', SKY_VS, SKY_FS, SKY_UNIFORMS) !== null;
  }

  draw(o: SkyDrawOpts): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const p = buildProgram(gl, 'sky', SKY_VS, SKY_FS, SKY_UNIFORMS);
    if (!p) return;
    this.ensureGpu();
    const u = p.uniforms;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(u.uInvViewProj, false, o.invViewProj);
    const top = rgb(o.top, SKY_DEFAULTS.top), hor = rgb(o.horizon, SKY_DEFAULTS.horizon), bot = rgb(o.bottom, SKY_DEFAULTS.bottom);
    gl.uniform3f(u.uTop, top[0], top[1], top[2]);
    gl.uniform3f(u.uHorizon, hor[0], hor[1], hor[2]);
    gl.uniform3f(u.uBottom, bot[0], bot[1], bot[2]);
    gl.uniform1f(u.uSharpness, Math.max(0.1, o.sharpness ?? SKY_DEFAULTS.sharpness));
    if (o.sun) {
      const d = normalize3(o.sun.direction);
      const c = rgb(o.sun.color, SKY_DEFAULTS.sunColor);
      const radius = (Math.max(0.05, Math.min(60, o.sun.size ?? SKY_DEFAULTS.sunSize)) * Math.PI) / 180;
      gl.uniform1i(u.uSunEnabled, 1);
      gl.uniform3f(u.uSunDir, d[0], d[1], d[2]);
      gl.uniform3f(u.uSunColor, c[0], c[1], c[2]);
      gl.uniform1f(u.uSunCos, Math.cos(radius));
      gl.uniform1f(u.uSunIntensity, Math.max(0, o.sun.intensity ?? 1));
    } else {
      gl.uniform1i(u.uSunEnabled, 0);
    }
    gl.uniform1f(u.uStars, starDensity(o.stars));
    gl.uniform1f(u.uTime, (o.time ?? 0) % 3600);
    if (o.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.texture);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1i(u.uUseTexture, 1);
      gl.uniform1f(u.uTexIntensity, o.textureIntensity ?? 1);
    } else {
      gl.uniform1i(u.uUseTexture, 0);
      gl.uniform1i(u.uTex, 0);
    }
    gl.uniform1f(u.uRotation, o.rotation ?? 0);
    gl.uniform1f(u.uOpacity, Math.max(0, Math.min(1, o.opacity ?? 1)));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    restoreRendererState(gl);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.generation === contextGeneration(gl)) {
      if (this.buf) gl.deleteBuffer(this.buf);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.vao = null;
    this.buf = null;
  }

  private ensureGpu(): void {
    const gl = this.gl;
    const gen = contextGeneration(gl);
    if (this.vao && this.generation === gen) return;
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.generation = gen;
  }
}
