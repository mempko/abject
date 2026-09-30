/**
 * Thick lines for `line` scene nodes, drawn through the renderer's WebGL2
 * context with their own programs (WebGL's own line width is 1 px on most
 * GPUs). Widths are in CSS PIXELS on screen, constant at any depth.
 *
 * Two geometries, picked per draw:
 * - Mitred joins (the default) use a triangle strip, two vertices per point.
 *   The vertex shader projects each point and its neighbours, finds the join
 *   direction in screen space and pushes the pair apart by half the width
 *   (miter length capped by a miter limit). Adjacent segments share their
 *   joint vertices, so nothing overlaps.
 * - Round joins or round caps use one screen-aligned quad per segment whose
 *   fragment shader measures the distance to the segment (a capsule). At a
 *   joint the later segment owns the overlap and the earlier one draws only
 *   the outer wedge, so every pixel is covered once: translucent and
 *   additive lines show no bright seams.
 * Both take per-point colours and width multipliers, dashes (lengths in the
 * line's own units), closed loops, and normal or additive blending.
 *
 * Ribbon mode keeps the width in WORLD px instead: the strip spreads along
 * the direction perpendicular to both the line and the view ray, facing the
 * camera and shrinking with distance (trails, swooshes, beams). `Trail`
 * keeps a ring buffer of recent world positions for such a ribbon, fading and
 * tapering toward its tail.
 *
 * Every draw restores the renderer's state contract (premultiplied blending,
 * depth test off, depth writes on, no VAO bound) and leaves scissor and
 * stencil alone, so a window's clip keeps applying. A program the GPU rejects
 * makes draws no-ops.
 */

import type { Mat4 } from './math.js';
import type { RGBA } from './renderer.js';
import { GlHost, buildProgram, contextGeneration, restoreRendererState } from './program-cache.js';

// Strip vertex: pos3, prev3, next3, misc3 (side, distance, width scale), colour4.
const STRIP_FLOATS = 16;
// Segment-quad vertex: a4 (A, u), b4 (B, v), p4 (prev, hasPrev), n4 (next, hasNext),
// colorA4, colorB4, m4 (distA, distB, widthA, widthB), w1 (widthNext).
const SEG_FLOATS = 29;

const STRIP_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aPrev;
layout(location = 2) in vec3 aNext;
layout(location = 3) in vec3 aMisc;
layout(location = 4) in vec4 aColor;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uMiterLimit;
uniform int uRibbon;
uniform vec3 uCameraPos;
out highp vec4 vColor;
out highp float vDist;
out highp float vSide;
out highp float vHalf;
out highp float vEdge;

vec2 toScreen(vec4 c) {
  return c.xy / max(c.w, 1e-6) * 0.5 * uViewport;
}

void main() {
  float side = aMisc.x;
  float wscale = aMisc.z;
  vColor = aColor;
  vDist = aMisc.y;
  vSide = side;
  vec4 wp = uModel * vec4(aPos, 1.0);
  vec4 wprev = uModel * vec4(aPrev, 1.0);
  vec4 wnext = uModel * vec4(aNext, 1.0);
  if (uRibbon != 0) {
    vec3 tin = wp.xyz - wprev.xyz;
    vec3 tout = wnext.xyz - wp.xyz;
    if (dot(tin, tin) < 1e-10) tin = tout;
    if (dot(tout, tout) < 1e-10) tout = tin;
    if (dot(tout, tout) < 1e-10) { tin = vec3(1.0, 0.0, 0.0); tout = tin; }
    tin = normalize(tin);
    tout = normalize(tout);
    vec3 t = tin + tout;
    t = dot(t, t) < 1e-8 ? tout : normalize(t);
    vec3 toCam = normalize(uCameraPos - wp.xyz);
    vec3 n = cross(t, toCam);
    n = dot(n, n) < 1e-10 ? vec3(0.0, 1.0, 0.0) : normalize(n);
    vec3 nseg = cross(tout, toCam);
    float k = dot(nseg, nseg) < 1e-10 ? 1.0 : abs(dot(n, normalize(nseg)));
    float m = 1.0 / max(k, 1.0 / uMiterLimit);
    float hw = uWidth * 0.5 * wscale;
    wp.xyz += n * side * hw * m;
    vHalf = hw;
    vEdge = hw;
    gl_Position = uViewProj * wp;
  } else {
    vec4 cp = uViewProj * wp;
    vec2 sp = toScreen(cp);
    vec2 din = sp - toScreen(uViewProj * wprev);
    vec2 dout = toScreen(uViewProj * wnext) - sp;
    if (dot(din, din) < 1e-8) din = dout;
    if (dot(dout, dout) < 1e-8) dout = din;
    if (dot(dout, dout) < 1e-8) { din = vec2(1.0, 0.0); dout = din; }
    din = normalize(din);
    dout = normalize(dout);
    vec2 t = din + dout;
    t = dot(t, t) < 1e-8 ? dout : normalize(t);
    vec2 miter = vec2(-t.y, t.x);
    vec2 nout = vec2(-dout.y, dout.x);
    float edge = uWidth * 0.5 * wscale;
    float hw = edge + 1.0;
    float len = hw / max(dot(miter, nout), 1.0 / uMiterLimit);
    cp.xy += miter * side * len / (0.5 * uViewport) * cp.w;
    vHalf = hw;
    vEdge = edge;
    gl_Position = cp;
  }
}
`;

const STRIP_FS = `#version 300 es
precision highp float;
precision highp int;
in highp vec4 vColor;
in highp float vDist;
in highp float vSide;
in highp float vHalf;
in highp float vEdge;
uniform vec4 uColor;
uniform float uOpacity;
uniform vec2 uDash;
uniform float uDashScale;
uniform int uRibbon;
out vec4 outColor;

void main() {
  float cov;
  if (uRibbon != 0) {
    float w = max(fwidth(vSide), 1e-4);
    cov = clamp((1.0 - abs(vSide)) / w, 0.0, 1.0);
  } else {
    float d = abs(vSide) * vHalf;
    cov = clamp(vEdge + 0.5 - d, 0.0, 1.0);
  }
  if (uDash.x > 0.0) {
    float period = uDash.x + uDash.y;
    float s = vDist * uDashScale;
    float ph = mod(s, period);
    float w = max(fwidth(s), 1e-4);
    float inside = ph < uDash.x ? min(ph, uDash.x - ph) : -min(ph - uDash.x, period - ph);
    cov *= clamp(inside / w + 0.5, 0.0, 1.0);
  }
  vec4 c = vColor * uColor;
  float a = c.a * uOpacity * cov;
  if (a <= 0.002) discard;
  outColor = vec4(c.rgb * a, a);
}
`;

const SEG_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aA;
layout(location = 1) in vec4 aB;
layout(location = 2) in vec4 aP;
layout(location = 3) in vec4 aN;
layout(location = 4) in vec4 aColorA;
layout(location = 5) in vec4 aColorB;
layout(location = 6) in vec4 aM;
layout(location = 7) in float aWN;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform vec4 uViewportRect;
uniform float uWidth;
flat out highp vec4 vAB;
flat out highp vec4 vPN;
flat out highp vec4 vR;
flat out highp vec4 vDists;
flat out highp vec4 vColA;
flat out highp vec4 vColB;

vec4 clipOf(vec3 p) { return uViewProj * (uModel * vec4(p, 1.0)); }
vec2 winOf(vec4 c) { return (c.xy / max(c.w, 1e-6) * 0.5 + 0.5) * uViewportRect.zw + uViewportRect.xy; }

void main() {
  vec4 ca = clipOf(aA.xyz);
  vec4 cb = clipOf(aB.xyz);
  vec2 sa = winOf(ca);
  vec2 sb = winOf(cb);
  vec2 sp = winOf(clipOf(aP.xyz));
  vec2 sn = winOf(clipOf(aN.xyz));
  float ra = uWidth * 0.5 * aM.z;
  float rb = uWidth * 0.5 * aM.w;
  float rn = uWidth * 0.5 * aWN;
  vec2 d = sb - sa;
  d = dot(d, d) < 1e-8 ? vec2(1.0, 0.0) : normalize(d);
  vec2 nrm = vec2(-d.y, d.x);
  float r = max(ra, rb) + 1.5;
  float u = aA.w;
  float v = aB.w;
  vec2 base = u < 0.5 ? sa - d * r : sb + d * r;
  vec2 w = base + nrm * v * r;
  vec4 c = u < 0.5 ? ca : cb;
  c.xy = ((w - uViewportRect.xy) / uViewportRect.zw * 2.0 - 1.0) * c.w;
  gl_Position = c;
  vAB = vec4(sa, sb);
  vPN = vec4(sp, sn);
  vR = vec4(ra, rb, rn, aP.w + 2.0 * aN.w);
  vDists = aM.xyzw;
  vColA = aColorA;
  vColB = aColorB;
}
`;

const SEG_FS = `#version 300 es
precision highp float;
precision highp int;
flat in highp vec4 vAB;
flat in highp vec4 vPN;
flat in highp vec4 vR;
flat in highp vec4 vDists;
flat in highp vec4 vColA;
flat in highp vec4 vColB;
uniform vec4 uColor;
uniform float uOpacity;
uniform vec2 uDash;
uniform float uDashScale;
uniform int uRoundCap;
uniform int uAdditive;
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 a = vAB.xy;
  vec2 b = vAB.zw;
  vec2 ab = b - a;
  float len2 = max(dot(ab, ab), 1e-8);
  float len = sqrt(len2);
  float tr = dot(p - a, ab) / len2;
  float t = clamp(tr, 0.0, 1.0);
  float r = mix(vR.x, vR.y, t);
  float d = length(p - (a + ab * t)) - r;
  float cov = clamp(0.5 - d, 0.0, 1.0);
  vec4 c = mix(vColA, vColB, t) * uColor;
  float a0 = clamp(c.a * uOpacity, 0.0, 1.0);
  float flags = vR.w;
  bool hasPrev = mod(flags, 2.0) > 0.5;
  bool hasNext = flags > 1.5;
  // Ends: a joint's start belongs to the previous segment; free ends are
  // round caps or butt (cut square at the endpoint).
  if (hasPrev) {
    if (tr < 0.0) cov = 0.0;
  } else if (uRoundCap == 0) {
    cov *= clamp(0.5 + tr * len, 0.0, 1.0);
  }
  if (!hasNext && uRoundCap == 0) {
    cov *= clamp(0.5 - (tr - 1.0) * len, 0.0, 1.0);
  }
  // The next segment owns what its body covers (single coverage at joints).
  if (hasNext) {
    vec2 bn = vPN.zw - b;
    float bl2 = dot(bn, bn);
    if (bl2 > 1e-8) {
      float tn = dot(p - b, bn) / bl2;
      if (tn >= 0.0 && tn <= 1.0) {
        float rn = mix(vR.y, vR.z, tn);
        float cn = clamp(0.5 - (length(p - (b + bn * tn)) - rn), 0.0, 1.0);
        // Additive: the two shares sum to the union. Over-blending: the next
        // segment composites on top, so keep exactly what it leaves uncovered.
        float keep = 1.0 - cn;
        if (uAdditive == 0) keep = keep / max(1.0 - a0 * cn, 1e-4);
        cov *= keep;
      }
    }
  }
  if (uDash.x > 0.0) {
    float period = uDash.x + uDash.y;
    float s = mix(vDists.x, vDists.y, t) * uDashScale;
    float ph = mod(s, period);
    float w = max(fwidth(s), 1e-4);
    float inside = ph < uDash.x ? min(ph, uDash.x - ph) : -min(ph - uDash.x, period - ph);
    cov *= clamp(inside / w + 0.5, 0.0, 1.0);
  }
  float alpha = a0 * cov;
  if (alpha <= 0.002) discard;
  outColor = vec4(c.rgb * alpha, alpha);
}
`;

const STRIP_UNIFORMS = [
  'uModel', 'uViewProj', 'uViewport', 'uWidth', 'uMiterLimit', 'uRibbon', 'uCameraPos',
  'uColor', 'uOpacity', 'uDash', 'uDashScale',
];
const SEG_UNIFORMS = ['uModel', 'uViewProj', 'uViewportRect', 'uWidth', 'uColor', 'uOpacity', 'uDash', 'uDashScale', 'uRoundCap', 'uAdditive'];

/** Colour input: an RGBA object or [r, g, b, a?] with channels 0..1 (straight alpha). */
export type LineColor = RGBA | ArrayLike<number>;

/** The geometry of one polyline. */
export interface LineInput {
  /** Flat [x, y, z, ...] or a list of [x, y, z?] points (parent-local px). */
  points: ArrayLike<number> | ArrayLike<ArrayLike<number>>;
  /** One colour per point (multiplied with the draw colour). */
  colors?: ArrayLike<LineColor>;
  /** One width multiplier per point (tapers). */
  widths?: ArrayLike<number>;
  /** Join the last point back to the first. */
  closed?: boolean;
}

/** How to draw a line. */
export interface LineDrawOpts {
  /** Local-to-world matrix [identity]. */
  model?: Mat4;
  viewProj: Mat4;
  /** World-space eye position (ribbons face it). */
  cameraPos: [number, number, number];
  /** CSS px on screen [2]; world px for ribbons. */
  width?: number;
  color?: RGBA;
  opacity?: number;
  /** Dash and gap lengths in the line's own units (px at scale 1). */
  dashed?: { dash: number; gap: number };
  blend?: 'normal' | 'additive';
  join?: 'miter' | 'round';
  cap?: 'butt' | 'round';
  /** Miter length cap, as a multiple of half the width [4]. */
  miterLimit?: number;
  /** World-space width, camera-facing strip. */
  ribbon?: boolean;
  /**
   * Test against the depth buffer [true]. Only opaque mitred lines write
   * depth, so draw lines after the opaque meshes they sit among.
   */
  depthTest?: boolean;
}

interface GpuGeom {
  vao: WebGLVertexArrayObject | null;
  buf: WebGLBuffer | null;
  idx: WebGLBuffer | null;
  data: Float32Array;
  count: number;
  dirty: boolean;
}

/** GPU buffers for one polyline, plus the CPU copy they are built from (kept for context restores). */
export interface LineHandle {
  points: Float32Array;
  colors: Float32Array;
  widths: Float32Array;
  closed: boolean;
  /** Mitred strip / ribbon geometry, built on first use. */
  strip: GpuGeom;
  /** Per-segment quads for round joins and caps, built on first use. */
  segments: GpuGeom;
  generation: number;
}

function colorOf(c: LineColor | undefined): [number, number, number, number] {
  if (!c) return [1, 1, 1, 1];
  if (typeof (c as RGBA).r === 'number') {
    const o = c as RGBA;
    return [o.r, o.g, o.b, o.a ?? 1];
  }
  const a = c as ArrayLike<number>;
  return [a[0] ?? 1, a[1] ?? 1, a[2] ?? 1, a.length > 3 ? a[3] : 1];
}

/** Normalize either point form into a flat xyz list. */
export function flattenPoints(points: LineInput['points']): Float32Array {
  const n = points.length;
  if (n === 0) return new Float32Array(0);
  if (typeof points[0] === 'number') {
    const flat = points as ArrayLike<number>;
    return Float32Array.from({ length: Math.floor(flat.length / 3) * 3 }, (_, i) => flat[i]);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = (points as ArrayLike<ArrayLike<number>>)[i];
    out[i * 3] = p[0] ?? 0;
    out[i * 3 + 1] = p[1] ?? 0;
    out[i * 3 + 2] = p.length > 2 ? p[2] : 0;
  }
  return out;
}

/** The point sequence a line walks: indices into its points, closing loops. */
function walk(n: number, closed: boolean): number[] {
  const seq: number[] = [];
  for (let i = 0; i < n; i++) seq.push(i);
  if (closed) seq.push(0);
  return seq;
}

/** Cumulative length along the walk, in the points' own units. */
function distances(pts: Float32Array, seq: number[]): number[] {
  const out = [0];
  for (let s = 1; s < seq.length; s++) {
    const i = seq[s] * 3, j = seq[s - 1] * 3;
    out.push(out[s - 1] + Math.hypot(pts[i] - pts[j], pts[i + 1] - pts[j + 1], pts[i + 2] - pts[j + 2]));
  }
  return out;
}

/** Strip vertices (two per walked point) for mitred lines and ribbons. */
export function buildStripVertices(h: Pick<LineHandle, 'points' | 'colors' | 'widths' | 'closed'>): Float32Array {
  const pts = h.points;
  const n = pts.length / 3;
  if (n < 2) return new Float32Array(0);
  const closed = h.closed && n >= 3;
  const seq = walk(n, closed);
  const dist = distances(pts, seq);
  const out = new Float32Array(seq.length * 2 * STRIP_FLOATS);
  seq.forEach((i, s) => {
    const prev = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const next = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    for (let side = 0; side < 2; side++) {
      const o = (s * 2 + side) * STRIP_FLOATS;
      out.set(pts.subarray(i * 3, i * 3 + 3), o);
      out.set(pts.subarray(prev * 3, prev * 3 + 3), o + 3);
      out.set(pts.subarray(next * 3, next * 3 + 3), o + 6);
      out[o + 9] = side === 0 ? -1 : 1;
      out[o + 10] = dist[s];
      out[o + 11] = h.widths[i];
      out.set(h.colors.subarray(i * 4, i * 4 + 4), o + 12);
    }
  });
  return out;
}

/** Quad vertices (four per segment) for round joins and caps. */
export function buildSegmentVertices(h: Pick<LineHandle, 'points' | 'colors' | 'widths' | 'closed'>): Float32Array {
  const pts = h.points;
  const n = pts.length / 3;
  if (n < 2) return new Float32Array(0);
  const closed = h.closed && n >= 3;
  const seq = walk(n, closed);
  const dist = distances(pts, seq);
  const segs = seq.length - 1;
  const out = new Float32Array(segs * 4 * SEG_FLOATS);
  for (let s = 0; s < segs; s++) {
    const a = seq[s], b = seq[s + 1];
    const hasPrev = closed || s > 0;
    const hasNext = closed || s < segs - 1;
    const p = hasPrev ? seq[(s - 1 + segs) % segs] : a;
    const nx = hasNext ? seq[(s + 2) % (segs + (closed ? 0 : 1))] : b;
    const corners: Array<[number, number]> = [[0, -1], [0, 1], [1, -1], [1, 1]];
    corners.forEach(([u, v], c) => {
      const o = (s * 4 + c) * SEG_FLOATS;
      out.set(pts.subarray(a * 3, a * 3 + 3), o); out[o + 3] = u;
      out.set(pts.subarray(b * 3, b * 3 + 3), o + 4); out[o + 7] = v;
      out.set(pts.subarray(p * 3, p * 3 + 3), o + 8); out[o + 11] = hasPrev ? 1 : 0;
      out.set(pts.subarray(nx * 3, nx * 3 + 3), o + 12); out[o + 15] = hasNext ? 1 : 0;
      out.set(h.colors.subarray(a * 4, a * 4 + 4), o + 16);
      out.set(h.colors.subarray(b * 4, b * 4 + 4), o + 20);
      out[o + 24] = dist[s]; out[o + 25] = dist[s + 1]; out[o + 26] = h.widths[a]; out[o + 27] = h.widths[b];
      out[o + 28] = h.widths[nx];
    });
  }
  return out;
}

/**
 * The context's current viewport, tracked rather than read back. Every
 * line draw needs it (screen-space widths), and gl.getParameter(VIEWPORT)
 * is a synchronous round trip to the GPU process: a few hundred lines a
 * frame spent milliseconds waiting on it. The first call reads it once and
 * wraps this context's viewport() so every later change (the renderer's
 * frame setup, post-effect passes, shadow and bloom targets) lands in the
 * record as it happens; a restored context reads it once more.
 */
const viewportRecords = new WeakMap<WebGL2RenderingContext, { vp: Int32Array; generation: number }>();

export function trackedViewport(gl: WebGL2RenderingContext): Int32Array {
  let rec = viewportRecords.get(gl);
  if (!rec) {
    const vp = new Int32Array(4);
    const native = gl.viewport.bind(gl);
    const record = { vp, generation: -1 };
    gl.viewport = (x: number, y: number, w: number, h: number): void => {
      vp[0] = x; vp[1] = y; vp[2] = w; vp[3] = h;
      native(x, y, w, h);
    };
    viewportRecords.set(gl, record);
    rec = record;
  }
  const gen = contextGeneration(gl);
  if (rec.generation !== gen) {
    rec.vp.set(gl.getParameter(gl.VIEWPORT) as Int32Array);
    rec.generation = gen;
  }
  return rec.vp;
}

/** Mean scale of a model matrix's x and y axes (dash lengths follow it). */
function modelScale(m: Mat4 | undefined): number {
  if (!m) return 1;
  return (Math.hypot(m[0], m[1], m[2]) + Math.hypot(m[4], m[5], m[6])) / 2 || 1;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function emptyGeom(): GpuGeom {
  return { vao: null, buf: null, idx: null, data: new Float32Array(0), count: 0, dirty: true };
}

export class LineRenderer {
  private readonly gl: WebGL2RenderingContext;
  private scratch?: LineHandle;
  private trailHandles = new WeakMap<Trail, LineHandle>();

  constructor(private readonly host: GlHost) {
    this.gl = host.context;
  }

  /** False when this GPU could not build the line programs (draws are no-ops). */
  get available(): boolean {
    const gl = this.gl;
    return buildProgram(gl, 'lineStrip', STRIP_VS, STRIP_FS, STRIP_UNIFORMS) !== null
      && buildProgram(gl, 'lineSegments', SEG_VS, SEG_FS, SEG_UNIFORMS) !== null;
  }

  createLine(): LineHandle {
    return {
      points: new Float32Array(0), colors: new Float32Array(0), widths: new Float32Array(0), closed: false,
      strip: emptyGeom(), segments: emptyGeom(), generation: 0,
    };
  }

  /** Replace a line's points (and colours/widths). Uploads lazily on the next draw. */
  updateLine(h: LineHandle, input: LineInput): void {
    const pts = flattenPoints(input.points);
    const n = pts.length / 3;
    const colors = new Float32Array(n * 4).fill(1);
    if (input.colors && input.colors.length === n) {
      for (let i = 0; i < n; i++) colors.set(colorOf(input.colors[i]), i * 4);
    }
    const widths = new Float32Array(n).fill(1);
    if (input.widths && input.widths.length === n) {
      for (let i = 0; i < n; i++) widths[i] = Math.max(0, Number(input.widths[i]) || 0);
    }
    h.points = pts;
    h.colors = colors;
    h.widths = widths;
    h.closed = input.closed === true;
    h.strip.dirty = true;
    h.segments.dirty = true;
    h.strip.count = -1;
    h.segments.count = -1;
  }

  deleteLine(h: LineHandle): void {
    const gl = this.gl;
    const live = h.generation === contextGeneration(gl);
    for (const g of [h.strip, h.segments]) {
      if (live) {
        if (g.buf) gl.deleteBuffer(g.buf);
        if (g.idx) gl.deleteBuffer(g.idx);
        if (g.vao) gl.deleteVertexArray(g.vao);
      }
      g.vao = g.buf = g.idx = null;
      g.dirty = true;
    }
  }

  /** Immediate-mode draw through an internal scratch handle. */
  draw(input: LineInput, opts: LineDrawOpts): void {
    if (!this.scratch) this.scratch = this.createLine();
    this.updateLine(this.scratch, input);
    this.drawLine(this.scratch, opts);
  }

  drawLine(h: LineHandle, opts: LineDrawOpts): void {
    if (h.points.length < 6) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const ribbon = opts.ribbon === true;
    const round = !ribbon && (opts.join === 'round' || opts.cap === 'round');
    const prog = round
      ? buildProgram(gl, 'lineSegments', SEG_VS, SEG_FS, SEG_UNIFORMS)
      : buildProgram(gl, 'lineStrip', STRIP_VS, STRIP_FS, STRIP_UNIFORMS);
    if (!prog) return;
    this.syncGeneration(h);
    const geom = round ? this.ensureSegments(h) : this.ensureStrip(h);
    if (geom.count <= 0) return;

    const width = Math.max(0, opts.width ?? 2);
    const vp = trackedViewport(gl);
    // Device px per CSS px of the current target (as devicePixelRatioOf).
    const dpr = Math.max(1e-3, (vp[2] || this.host.canvas.width) / Math.max(1, this.host.cssWidth));
    const color = opts.color ?? { r: 1, g: 1, b: 1, a: 1 };
    const opacity = opts.opacity ?? 1;
    const model = opts.model ?? IDENTITY;
    const additive = opts.blend === 'additive';
    const dashed = opts.dashed && opts.dashed.dash > 0 ? opts.dashed : undefined;

    if (opts.depthTest === false) gl.disable(gl.DEPTH_TEST);
    else gl.enable(gl.DEPTH_TEST);
    // Lines test depth; only opaque mitred lines write it. Translucent and
    // additive lines must not hide what is drawn after them, and the
    // round-joint quads share antialiased pixels at their joints (a depth
    // write there would block the neighbour's share and leave a seam).
    // Draw lines after a subtree's opaque meshes.
    gl.depthMask(!round && !additive && opacity >= 1 && (color.a ?? 1) >= 1);
    gl.enable(gl.BLEND);
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(prog.program);
    const u = prog.uniforms;
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniformMatrix4fv(u.uViewProj, false, opts.viewProj);
    gl.uniform4f(u.uColor, color.r, color.g, color.b, color.a ?? 1);
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniform2f(u.uDash, dashed ? dashed.dash : 0, dashed ? Math.max(0, dashed.gap) : 0);
    gl.uniform1f(u.uDashScale, modelScale(model));
    gl.bindVertexArray(geom.vao);
    if (round) {
      gl.uniform4f(u.uViewportRect, vp[0], vp[1], vp[2], vp[3]);
      gl.uniform1f(u.uWidth, width * dpr);
      gl.uniform1i(u.uRoundCap, opts.cap === 'round' ? 1 : 0);
      gl.uniform1i(u.uAdditive, additive ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, geom.count, gl.UNSIGNED_INT, 0);
    } else {
      gl.uniform2f(u.uViewport, vp[2], vp[3]);
      gl.uniform1f(u.uWidth, ribbon ? width : width * dpr);
      gl.uniform1f(u.uMiterLimit, Math.max(1, opts.miterLimit ?? 4));
      gl.uniform1i(u.uRibbon, ribbon ? 1 : 0);
      gl.uniform3f(u.uCameraPos, opts.cameraPos[0], opts.cameraPos[1], opts.cameraPos[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, geom.count);
    }
    restoreRendererState(gl);
  }

  /** Draw a trail: newest point opaque and full width, fading and tapering to the tail. */
  drawTrail(trail: Trail, opts: LineDrawOpts & { fade?: boolean; taper?: boolean; now?: number }): void {
    const snap = trail.snapshot(opts.now);
    if (snap.count < 2) return;
    let h = this.trailHandles.get(trail);
    if (!h) { h = this.createLine(); this.trailHandles.set(trail, h); }
    const colors: Array<[number, number, number, number]> = [];
    const widths: number[] = [];
    const fade = opts.fade !== false, taper = opts.taper !== false;
    for (let i = 0; i < snap.count; i++) {
      const life = 1 - snap.ages[i]; // 1 at the head, 0 at the tail
      colors.push([1, 1, 1, fade ? life * life : 1]);
      widths.push(taper ? 0.15 + 0.85 * life : 1);
    }
    this.updateLine(h, { points: snap.positions, colors, widths });
    this.drawLine(h, { ...opts, ribbon: opts.ribbon ?? true, model: undefined });
  }

  /** Free the scratch line (other handles are freed with deleteLine). */
  dispose(): void {
    if (this.scratch) this.deleteLine(this.scratch);
  }

  /** After a context restore every GPU object is gone: rebuild from the CPU copy. */
  private syncGeneration(h: LineHandle): void {
    const gen = contextGeneration(this.gl);
    if (h.generation === gen) return;
    for (const g of [h.strip, h.segments]) {
      g.vao = g.buf = g.idx = null;
      g.dirty = true;
      g.count = -1;
    }
    h.generation = gen;
  }

  private ensureStrip(h: LineHandle): GpuGeom {
    const gl = this.gl;
    const g = h.strip;
    if (!g.vao) {
      g.vao = gl.createVertexArray();
      g.buf = gl.createBuffer();
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
      const stride = STRIP_FLOATS * 4;
      const layout: Array<[number, number, number]> = [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 3, 9], [4, 4, 12]];
      for (const [loc, size, off] of layout) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      }
      gl.bindVertexArray(null);
      g.dirty = true;
    }
    if (g.dirty) {
      g.data = buildStripVertices(h);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
      gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.DYNAMIC_DRAW);
      g.count = g.data.length / STRIP_FLOATS;
      g.dirty = false;
    }
    return g;
  }

  private ensureSegments(h: LineHandle): GpuGeom {
    const gl = this.gl;
    const g = h.segments;
    if (!g.vao) {
      g.vao = gl.createVertexArray();
      g.buf = gl.createBuffer();
      g.idx = gl.createBuffer();
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
      const stride = SEG_FLOATS * 4;
      for (let loc = 0; loc < 7; loc++) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, loc * 16);
      }
      gl.enableVertexAttribArray(7);
      gl.vertexAttribPointer(7, 1, gl.FLOAT, false, stride, 28 * 4);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
      gl.bindVertexArray(null);
      g.dirty = true;
    }
    if (g.dirty) {
      g.data = buildSegmentVertices(h);
      const quads = g.data.length / (SEG_FLOATS * 4);
      const idx = new Uint32Array(quads * 6);
      for (let q = 0; q < quads; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
      gl.bindVertexArray(g.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
      gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
      g.count = idx.length;
      g.dirty = false;
    }
    return g;
  }
}

/**
 * Ring buffer of recent world positions for a motion trail. Push the moving
 * object's position each frame; points closer than `minDistance` to the last
 * one only move the head, and with a `lifetime` (ms) old points expire.
 */
export class Trail {
  private readonly capacity: number;
  private readonly minDistance: number;
  private readonly lifetime: number;
  private readonly xyz: Float32Array;
  private readonly times: Float64Array;
  private head = 0;
  private size = 0;

  constructor(opts: { capacity?: number; minDistance?: number; lifetime?: number } = {}) {
    this.capacity = Math.max(2, Math.min(4096, Math.round(opts.capacity ?? 64)));
    this.minDistance = Math.max(0, opts.minDistance ?? 1);
    this.lifetime = Math.max(0, opts.lifetime ?? 0);
    this.xyz = new Float32Array(this.capacity * 3);
    this.times = new Float64Array(this.capacity);
  }

  get length(): number {
    return this.size;
  }

  /**
   * Record a position (world px). `now` in ms [performance.now()]. The newest
   * point always follows the object; it is kept as a trail point once it
   * has moved `minDistance` from the point before it.
   */
  push(x: number, y: number, z: number, now: number = nowMs()): void {
    if (this.size >= 2) {
      const last = (this.head - 1 + this.capacity) % this.capacity;
      const before = (this.head - 2 + this.capacity) % this.capacity;
      const moved = Math.hypot(
        this.xyz[last * 3] - this.xyz[before * 3],
        this.xyz[last * 3 + 1] - this.xyz[before * 3 + 1],
        this.xyz[last * 3 + 2] - this.xyz[before * 3 + 2],
      );
      if (moved < this.minDistance) {
        this.xyz[last * 3] = x; this.xyz[last * 3 + 1] = y; this.xyz[last * 3 + 2] = z;
        this.times[last] = now;
        return;
      }
    }
    this.xyz[this.head * 3] = x;
    this.xyz[this.head * 3 + 1] = y;
    this.xyz[this.head * 3 + 2] = z;
    this.times[this.head] = now;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.capacity, this.size + 1);
  }

  clear(): void {
    this.size = 0;
    this.head = 0;
  }

  /** Is anything still visible (keeps the render loop alive while true)? */
  isActive(now: number = nowMs()): boolean {
    return this.snapshot(now).count >= 2;
  }

  /**
   * Live points, oldest first, with ages 0 (head) .. 1 (tail): by time when a
   * lifetime is set, otherwise by position in the buffer.
   */
  snapshot(now: number = nowMs()): { positions: Float32Array; ages: Float32Array; count: number } {
    const idx: number[] = [];
    for (let k = this.size - 1; k >= 0; k--) {
      const i = (this.head - 1 - k + this.capacity * 2) % this.capacity;
      if (this.lifetime > 0 && now - this.times[i] > this.lifetime) continue;
      idx.push(i);
    }
    const count = idx.length;
    const positions = new Float32Array(count * 3);
    const ages = new Float32Array(count);
    idx.forEach((i, k) => {
      positions[k * 3] = this.xyz[i * 3];
      positions[k * 3 + 1] = this.xyz[i * 3 + 1];
      positions[k * 3 + 2] = this.xyz[i * 3 + 2];
      ages[k] = this.lifetime > 0
        ? Math.min(1, Math.max(0, (now - this.times[i]) / this.lifetime))
        : count > 1 ? 1 - k / (count - 1) : 0;
    });
    return { positions, ages, count };
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
