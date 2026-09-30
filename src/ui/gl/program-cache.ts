/**
 * Program compile cache for the self-contained render modules (thick lines,
 * sky, and friends) that own their GLSL instead of going through GlRenderer.
 *
 * Same safety net as the renderer's own cache: a program that fails to build
 * on this GPU is recorded with the driver's reason, logged once, and every
 * later request returns null so the caller skips its draw (degrading to
 * "nothing drawn") instead of throwing out of the frame. A lost-and-restored
 * context bumps a generation counter so modules know to rebuild their GPU
 * objects.
 */

export interface GlProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/** What a render module needs from its host renderer (GlRenderer satisfies it). */
export interface GlHost {
  readonly context: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** CSS width of the canvas, for device-pixel-ratio math. */
  cssWidth: number;
}

interface ContextState {
  generation: number;
  programs: Map<string, GlProgram | string>;
}

const states = new WeakMap<WebGL2RenderingContext, ContextState>();

function stateFor(gl: WebGL2RenderingContext): ContextState {
  let st = states.get(gl);
  if (!st) {
    const fresh: ContextState = { generation: 1, programs: new Map() };
    st = fresh;
    states.set(gl, st);
    const canvas = gl.canvas as HTMLCanvasElement | OffscreenCanvas;
    // Programs and buffers die with the context; start over after a restore.
    canvas.addEventListener?.('webglcontextrestored', () => {
      fresh.generation++;
      fresh.programs.clear();
    });
  }
  return st;
}

/** Bumped every time the context is restored; compare to know when to rebuild. */
export function contextGeneration(gl: WebGL2RenderingContext): number {
  return stateFor(gl).generation;
}

/**
 * Compile and link (once per context) or return null when this GPU rejects
 * the program. The failure reason is logged a single time.
 */
export function buildProgram(gl: WebGL2RenderingContext, name: string, vsSrc: string, fsSrc: string, uniformNames: string[]): GlProgram | null {
  const st = stateFor(gl);
  const hit = st.programs.get(name);
  if (hit !== undefined) return typeof hit === 'string' ? null : hit;
  if (gl.isContextLost()) return null;
  const shaders: WebGLShader[] = [];
  try {
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      shaders.push(sh);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`Shader '${name}' compile error: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program '${name}' link error: ${gl.getProgramInfoLog(program)}`);
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const u of uniformNames) uniforms[u] = gl.getUniformLocation(program, u);
    const info = { program, uniforms };
    st.programs.set(name, info);
    return info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    st.programs.set(name, msg);
    console.error('[GL module]', msg);
    return null;
  } finally {
    for (const sh of shaders) gl.deleteShader(sh);
  }
}

/** The recorded failure for a program name, if it failed to build. */
export function programError(gl: WebGL2RenderingContext, name: string): string | undefined {
  const hit = stateFor(gl).programs.get(name);
  return typeof hit === 'string' ? hit : undefined;
}

/**
 * Restore the global state GlRenderer relies on after a module draws:
 * premultiplied source-over blending on, depth test off with depth writes
 * on, no culling, no bound vertex array, texture unit 0 active.
 */
export function restoreRendererState(gl: WebGL2RenderingContext): void {
  gl.bindVertexArray(null);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(true);
  gl.disable(gl.CULL_FACE);
  gl.activeTexture(gl.TEXTURE0);
}

/** Device pixels per CSS pixel for the current render target. */
export function devicePixelRatioOf(host: GlHost): number {
  const vp = host.context.getParameter(host.context.VIEWPORT) as Int32Array;
  return Math.max(1e-3, (vp[2] || host.canvas.width) / Math.max(1, host.cssWidth));
}
