/**
 * Graph layout and view math for the 3D graph widget (graph-widget.ts).
 *
 * Pure functions, no bus and no DOM, so the widget (backend side) and
 * one-shot Node checks share them:
 * - a force-directed 3D layout: warm-started from previous positions,
 *   bounded in iterations and time, groups pulled toward their own region
 *   of the sphere, run in short slices so a big graph never stalls the
 *   worker that hosts the widget;
 * - the rotation algebra the widget uses to fold a turntable drag into its
 *   resting orientation (Euler angles in the scene's convention,
 *   R = Rx * Ry * Rz, as `mat4TRS` and `lookAtEuler` use).
 */

import { require as contractRequire, ensure } from '../../core/contracts.js';
import { lookAtEuler } from '../../ui/gl/anim-tracks.js';

export type Vec3 = [number, number, number];

export interface LayoutNode {
  id: string;
  group: string;
  /**
   * Held at the origin (a hub such as "this peer" or the current
   * selection): it never moves and takes no part in the group pull, so the
   * rest of the graph arranges itself around it.
   */
  center?: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** Spring strength multiplier source (> 0). */
  weight: number;
}

export interface LayoutOptions {
  /** Iteration cap before time and size limits apply. */
  maxIterations?: number;
  /** Total wall-clock budget in ms (the layout stops early, still valid). */
  budgetMs?: number;
  /** Called between slices; resolve to continue. Default: a macrotask yield. */
  yieldSlice?: () => Promise<void>;
  /** Returns true when a newer layout superseded this one (it then stops). */
  isStale?: () => boolean;
}

/** Stable 32-bit FNV-1a hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic jitter vector in [-1, 1]^3 for an id (same id, same jitter). */
export function jitterOf(id: string): Vec3 {
  const a = hashString(id);
  const b = hashString(`${id}#y`);
  const c = hashString(`${id}#z`);
  return [(a / 0xffffffff) * 2 - 1, (b / 0xffffffff) * 2 - 1, (c / 0xffffffff) * 2 - 1];
}

/** `count` near-uniform unit directions on a sphere (Fibonacci lattice). */
export function fibonacciSphere(count: number): Vec3[] {
  const out: Vec3[] = [];
  if (count <= 0) return out;
  if (count === 1) return [[0, 0, 0]];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // Half-step offset: a few points spread around the sphere rather than
    // lining up pole to pole.
    const y = 1 - ((i + 0.5) / count) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Force-directed 3D layout (Fruchterman-Reingold, ideal edge length 1).
 *
 * `prev` holds earlier raw positions by node id: nodes found there start
 * where they were and the run starts cool (a small change settles in a few
 * dozen iterations and existing nodes barely move); new nodes start beside
 * their already-placed neighbours, or in their group's region. With more
 * than one group, each group is drawn toward its own point on a sphere so
 * groups read as clusters. Returns raw coordinates (not normalized) for
 * every node, suitable as `prev` for the next run.
 */
export async function layoutGraph3D(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  prev: ReadonlyMap<string, Vec3>,
  opts: LayoutOptions = {},
): Promise<Map<string, Vec3>> {
  const n = nodes.length;
  const out = new Map<string, Vec3>();
  if (n === 0) return out;
  if (n === 1) {
    out.set(nodes[0].id, nodes[0].center ? [0, 0, 0] : prev.get(nodes[0].id) ?? [0, 0, 0]);
    return out;
  }
  // Centre nodes sit at the origin and stay there.
  const pinned = nodes.map((nd) => nd.center === true);

  const index = new Map<string, number>();
  nodes.forEach((nd, i) => index.set(nd.id, i));
  const pairs: Array<[number, number, number]> = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const w = Math.max(0.2, Math.min(4, 0.6 + 0.4 * Math.log2(1 + Math.max(0, e.weight))));
    pairs.push([a, b, w]);
  }

  // Groups in first-appearance order, each with a region on a sphere (centre
  // nodes claim no region: they hold the middle).
  const groupIndex = new Map<string, number>();
  for (const nd of nodes) if (!nd.center && !groupIndex.has(nd.group)) groupIndex.set(nd.group, groupIndex.size);
  const groupCount = groupIndex.size;
  const spread = 0.62 * Math.cbrt(n);
  const anchors = fibonacciSphere(groupCount).map((d) => [d[0] * spread * 0.75, d[1] * spread * 0.75, d[2] * spread * 0.75] as Vec3);
  const gOf = nodes.map((nd) => groupIndex.get(nd.group) ?? 0);

  // Seed: previous positions, else beside placed neighbours, else the group region.
  const pos = new Float64Array(n * 3);
  const placed = new Uint8Array(n);
  let known = 0;
  for (let i = 0; i < n; i++) {
    const p = prev.get(nodes[i].id);
    if (pinned[i]) {
      placed[i] = 1;
      if (p) known++;
    } else if (p) {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      placed[i] = 1;
      known++;
    }
  }
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) { neighbours[a].push(b); neighbours[b].push(a); }
  // Two passes so chains of new nodes can hang off each other.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (const j of neighbours[i]) {
        if (!placed[j]) continue;
        sx += pos[j * 3]; sy += pos[j * 3 + 1]; sz += pos[j * 3 + 2]; c++;
      }
      const jit = jitterOf(nodes[i].id);
      if (c > 0) {
        pos[i * 3] = sx / c + jit[0] * 0.45;
        pos[i * 3 + 1] = sy / c + jit[1] * 0.45;
        pos[i * 3 + 2] = sz / c + jit[2] * 0.45;
        placed[i] = 2;
      } else if (pass === 1) {
        const a = anchors[gOf[i]];
        const r = groupCount > 1 ? spread * 0.45 : spread;
        pos[i * 3] = a[0] + jit[0] * r;
        pos[i * 3 + 1] = a[1] + jit[1] * r;
        pos[i * 3 + 2] = a[2] + jit[2] * r;
        placed[i] = 2;
      }
    }
  }

  const warm = known / n;
  const cold = warm < 0.5;
  // Pair work grows with n^2: big graphs get fewer iterations (and the time
  // budget below caps them anyway); a warm start mostly polishes.
  const sizeCap = Math.max(50, Math.floor(3e7 / (n * n)));
  const iterations = Math.min(opts.maxIterations ?? (cold ? 360 : warm >= 0.999 ? 70 : 140), sizeCap);
  const budget = opts.budgetMs ?? 450;
  const yieldSlice = opts.yieldSlice ?? defaultYield;
  const t0 = (cold ? 0.35 : warm >= 0.999 ? 0.04 : 0.07) * spread;
  const disp = new Float64Array(n * 3);
  const started = Date.now();
  let sliceStart = started;

  for (let it = 0; it < iterations; it++) {
    const temp = t0 * (1 - it / iterations) + 0.002;
    disp.fill(0);
    // Repulsion between every pair (k^2 / d along the separation).
    for (let i = 0; i < n; i++) {
      const ix = pos[i * 3], iy = pos[i * 3 + 1], iz = pos[i * 3 + 2];
      for (let j = i + 1; j < n; j++) {
        let dx = ix - pos[j * 3], dy = iy - pos[j * 3 + 1], dz = iz - pos[j * 3 + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) {
          // Coincident: separate along a stable per-pair direction.
          dx = ((i * 7 + j * 3) % 5 - 2) * 0.01 + 0.005; dy = 0.007; dz = -0.004;
          d2 = dx * dx + dy * dy + dz * dz;
        }
        const f = 1 / d2;
        const fx = dx * f, fy = dy * f, fz = dz * f;
        disp[i * 3] += fx; disp[i * 3 + 1] += fy; disp[i * 3 + 2] += fz;
        disp[j * 3] -= fx; disp[j * 3 + 1] -= fy; disp[j * 3 + 2] -= fz;
      }
    }
    // Springs along edges (d^2 / k, stronger for heavier edges).
    for (const [a, b, w] of pairs) {
      const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
      const f = d * w;
      const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
      disp[a * 3] -= fx; disp[a * 3 + 1] -= fy; disp[a * 3 + 2] -= fz;
      disp[b * 3] += fx; disp[b * 3 + 1] += fy; disp[b * 3 + 2] += fz;
    }
    // Group regions and a light pull to the centre (keeps islands together).
    let maxMove = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      let gx = -pos[i * 3] * 0.03, gy = -pos[i * 3 + 1] * 0.03, gz = -pos[i * 3 + 2] * 0.03;
      if (groupCount > 1) {
        const a = anchors[gOf[i]];
        gx += (a[0] - pos[i * 3]) * 0.12; gy += (a[1] - pos[i * 3 + 1]) * 0.12; gz += (a[2] - pos[i * 3 + 2]) * 0.12;
      }
      const dx = disp[i * 3] + gx, dy = disp[i * 3 + 1] + gy, dz = disp[i * 3 + 2] + gz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const step = Math.min(len, temp);
      pos[i * 3] += (dx / len) * step;
      pos[i * 3 + 1] += (dy / len) * step;
      pos[i * 3 + 2] += (dz / len) * step;
      if (step > maxMove) maxMove = step;
    }
    if (maxMove < 0.0015 * spread && it > 10) break;

    const now = Date.now();
    if (now - started > budget) break;
    if (now - sliceStart > 12) {
      await yieldSlice();
      if (opts.isStale?.()) return out;
      sliceStart = Date.now();
    }
  }

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    out.set(nodes[i].id, [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0]);
  }
  ensure(out.size === n, 'layoutGraph3D: every node gets a position');
  return out;
}

/**
 * Normalize raw layout positions into the unit ball around their centroid.
 * The scale comes from the 90th-percentile distance, so one far-flung node
 * does not shrink the rest into a speck; the few beyond the rim are drawn in
 * to it. The graph reaches 0.9 of the ball whatever its size (the widget
 * then caps the spacing of very small graphs). `center`, when given (a
 * centre node's place), is the middle instead of the centroid.
 */
export function normalizeLayout(raw: ReadonlyMap<string, Vec3>, center?: Vec3): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const n = raw.size;
  if (n === 0) return out;
  let cx = 0, cy = 0, cz = 0;
  if (center) {
    [cx, cy, cz] = center;
  } else {
    for (const p of raw.values()) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= n; cy /= n; cz /= n;
  }
  const dists = [...raw.values()].map((p) => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz)).sort((a, b) => a - b);
  const radius = dists[dists.length - 1];
  const p90 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.9))];
  const reach = 0.9;
  // Up to 20 nodes the farthest sets the scale; beyond, the 90th percentile.
  const basis = n <= 20 || p90 <= 1e-9 ? radius : Math.max(p90 / 0.88, radius * 0.5);
  const k = basis > 1e-9 ? reach / basis : 0;
  const rim = 0.98;
  for (const [id, p] of raw) {
    let x = (p[0] - cx) * k, y = (p[1] - cy) * k, z = (p[2] - cz) * k;
    const r = Math.hypot(x, y, z);
    if (r > rim) { const f = rim / r; x *= f; y *= f; z *= f; }
    out.set(id, [x, y, z]);
  }
  return out;
}

/**
 * Turn a layout so it faces the viewer at its widest: its axis of greatest
 * spread along x, the next along y, the least along z (depth). Rotates about
 * `center` (default: the centroid). Used on a fresh layout only, so nothing
 * already on screen moves.
 */
export function alignToPrincipalAxes(raw: ReadonlyMap<string, Vec3>, center?: Vec3): Map<string, Vec3> {
  const n = raw.size;
  const out = new Map<string, Vec3>();
  if (n < 3) { for (const [id, p] of raw) out.set(id, [p[0], p[1], p[2]]); return out; }
  let c: Vec3 = [0, 0, 0];
  if (center) c = [center[0], center[1], center[2]];
  else {
    for (const p of raw.values()) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
  }
  // Covariance, then Jacobi eigen-decomposition (3x3 symmetric).
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of raw.values()) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j];
  }
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = cs * vkp - sn * vkq; v[k][q] = sn * vkp + cs * vkq;
      }
    }
  }
  // Eigenvectors (columns of v) by descending eigenvalue: x, y, z.
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const axes = order.map((k) => [v[0][k], v[1][k], v[2][k]]);
  // Keep it a rotation (no mirror): z = x cross y.
  const [ax, ay] = axes;
  const az = [ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]];
  for (const [id, p] of raw) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const dot = (e: number[]) => e[0] * d[0] + e[1] * d[1] + e[2] * d[2];
    out.set(id, [c[0] + dot(ax), c[1] + dot(ay), c[2] + dot(az)]);
  }
  return out;
}

/**
 * Push apart nodes that sit closer than their bodies (plus `gap`) allow,
 * keeping everything inside a ball of `maxRadius` around the origin. Works
 * in the widget's px so the node sizes mean what they draw; pinned nodes
 * stay put. A few cheap passes: this only settles overlaps the force layout
 * left behind (a hub crowded by its spokes), it does not redo the layout.
 */
export function relaxOverlaps(
  points: ReadonlyMap<string, Vec3>,
  radius: (id: string) => number,
  pinned: ReadonlySet<string>,
  maxRadius: number,
  gap = 14,
  passes = 24,
): Map<string, Vec3> {
  const ids = [...points.keys()];
  const n = ids.length;
  const pos = ids.map((id) => [...points.get(id)!] as Vec3);
  const rad = ids.map((id) => radius(id));
  const fixed = ids.map((id) => pinned.has(id));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[i], b = pos[j];
        let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        let d = Math.hypot(dx, dy, dz);
        const min = rad[i] + rad[j] + gap;
        if (d >= min) continue;
        if (d < 1e-6) { dx = ((i * 7 + j * 3) % 5) - 2 || 1; dy = 1; dz = 0.5; d = Math.hypot(dx, dy, dz); }
        const push = min - d;
        const ux = dx / d, uy = dy / d, uz = dz / d;
        const shareA = fixed[i] ? 0 : fixed[j] ? 1 : 0.5;
        const shareB = fixed[j] ? 0 : fixed[i] ? 1 : 0.5;
        a[0] -= ux * push * shareA; a[1] -= uy * push * shareA; a[2] -= uz * push * shareA;
        b[0] += ux * push * shareB; b[1] += uy * push * shareB; b[2] += uz * push * shareB;
        moved = true;
      }
    }
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      const r = Math.hypot(p[0], p[1], p[2]);
      if (r > maxRadius) { const f = maxRadius / r; p[0] *= f; p[1] *= f; p[2] *= f; }
    }
    if (!moved) break;
  }
  const out = new Map<string, Vec3>();
  ids.forEach((id, i) => out.set(id, pos[i]));
  return out;
}

/** Median distance from each point to its nearest neighbour (sampled for big sets). */
export function medianNearestNeighbour(points: readonly Vec3[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const step = Math.max(1, Math.floor(n / 300));
  const nn: number[] = [];
  for (let i = 0; i < n; i += step) {
    let best = Infinity;
    const p = points[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = points[j];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d < best) best = d;
    }
    nn.push(best);
  }
  nn.sort((x, y) => x - y);
  return nn[Math.floor(nn.length / 2)];
}

// ── Rotation algebra (R = Rx * Ry * Rz, row-major 3x3) ────────────────────

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Rotation matrix for Euler angles in the scene convention. */
export function eulerToMat3(e: readonly number[]): Mat3 {
  const cx = Math.cos(e[0]), sx = Math.sin(e[0]);
  const cy = Math.cos(e[1]), sy = Math.sin(e[1]);
  const cz = Math.cos(e[2]), sz = Math.sin(e[2]);
  return [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
  ];
}

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/** Euler angles (scene convention) of a rotation matrix. */
export function mat3ToEuler(m: Mat3): Vec3 {
  const r02 = Math.max(-1, Math.min(1, m[2]));
  const ry = Math.asin(r02);
  if (Math.abs(r02) < 0.999999) {
    return [Math.atan2(-m[5], m[8]), ry, Math.atan2(-m[1], m[0])];
  }
  // Gimbal lock: fold the roll into rx (rz = 0).
  return [Math.atan2(m[7], m[4]), ry, 0];
}

/** Rotate a vector by Euler angles (scene convention). */
export function rotateByEuler(e: readonly number[], v: Vec3): Vec3 {
  const m = eulerToMat3(e);
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Fold a turntable drag into the resting orientation. The turn group looks
 * at the dragged pad (`lookAtEuler` from its origin), the orientation group
 * under it holds `orient`; the result is the single orientation that shows
 * the same pose once the pad is back at rest on +z (where the turn group is
 * the identity).
 */
export function bakeTurn(pad: readonly number[], orient: readonly number[]): Vec3 {
  contractRequire(pad.length === 3 && orient.length === 3, 'bakeTurn: pad and orient are [x, y, z]');
  const turn = lookAtEuler([0, 0, 0], pad);
  return mat3ToEuler(mat3Multiply(eulerToMat3(turn), eulerToMat3(orient)));
}
