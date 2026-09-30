/**
 * Polygon triangulation with holes: ear clipping over a doubly linked vertex
 * ring, with holes bridged into the outer ring first (the earcut approach).
 * Robust enough for traced text outlines and hand-written extrude shapes:
 * collinear and duplicate points are filtered, self-touching rings are cured
 * locally, and a polygon that still refuses to clip is split along a valid
 * diagonal and each half clipped on its own. Large rings index their vertices
 * along a z-order curve so the ear test stays near linear.
 *
 * Pure math: no DOM, no GL. Shared by the extrude primitive and 3D text.
 */

/** A 2D point as [x, y]. */
export type Vec2 = [number, number];

/** One polygon to fill: an outer ring plus any holes cut out of it. */
export interface PolygonShape {
  outer: Vec2[];
  holes?: Vec2[][];
}

interface Node {
  /** Vertex index into the flat input (vertex number, not array offset). */
  i: number;
  x: number;
  y: number;
  prev: Node;
  next: Node;
  /** z-order curve value (hashed mode only). */
  z: number;
  prevZ: Node | null;
  nextZ: Node | null;
  /** A single-point hole: never filtered away. */
  steiner: boolean;
}

/**
 * Triangulate a flat coordinate list. `data` holds `dim` numbers per vertex
 * (only x and y are read); `holeIndices` lists the VERTEX index where each
 * hole ring starts (the outer ring runs from 0 to the first hole). Returns a
 * flat triangle list of vertex indices.
 */
export function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number>, dim = 2): number[] {
  const hasHoles = !!holeIndices && holeIndices.length > 0;
  const outerLen = hasHoles ? holeIndices![0] * dim : data.length;
  let outerNode = linkedList(data, 0, outerLen, dim, true);
  const triangles: number[] = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;

  if (hasHoles) outerNode = eliminateHoles(data, holeIndices!, outerNode, dim);

  let minX = 0, minY = 0, invSize = 0;
  // Hash vertices along a z-order curve for large inputs so each ear test
  // only visits nearby points.
  if (data.length > 80 * dim) {
    minX = Infinity; minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < outerLen; i += dim) {
      const x = data[i], y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 32767 / invSize : 0;
  }

  earcutLinked(outerNode, triangles, minX, minY, invSize, 0);
  return triangles;
}

/** Build a circular linked list from a ring, in the requested winding. */
function linkedList(data: ArrayLike<number>, start: number, end: number, dim: number, clockwise: boolean): Node | null {
  let last: Node | null = null;
  if (clockwise === (flatSignedArea(data, start, end, dim) > 0)) {
    for (let i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  } else {
    for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }
  return last;
}

/** Drop duplicate and collinear points. */
function filterPoints(start: Node | null, end?: Node | null): Node | null {
  if (!start) return start;
  if (!end) end = start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

/** The main ear-slicing loop, escalating through repair passes when stuck. */
function earcutLinked(ear: Node | null, triangles: number[], minX: number, minY: number, invSize: number, pass: number): void {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);

  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev: Node = ear.prev;
    const next: Node = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      // Skipping the next vertex leads to fewer sliver triangles.
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) {
        earcutLinked(filterPoints(ear), triangles, minX, minY, invSize, 1);
      } else if (pass === 1) {
        const cured = cureLocalIntersections(filterPoints(ear)!, triangles);
        earcutLinked(cured, triangles, minX, minY, invSize, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles, minX, minY, invSize);
      }
      break;
    }
  }
}

/** Is this vertex a valid ear (convex, with no other vertex inside)? */
function isEar(ear: Node): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false; // reflex
  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
  let p = c.next;
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
        pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.x, p.y) &&
        area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function isEarHashed(ear: Node, minX: number, minY: number, invSize: number): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
  const minZ = zOrder(x0, y0, minX, minY, invSize);
  const maxZ = zOrder(x1, y1, minX, minY, invSize);

  const blocks = (p: Node): boolean =>
    p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
    pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0;

  let p = ear.prevZ;
  let n = ear.nextZ;
  // Walk both directions of the z-order list at once.
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (blocks(p)) return false;
    p = p.prevZ;
    if (blocks(n)) return false;
    n = n.nextZ;
  }
  while (p && p.z >= minZ) {
    if (blocks(p)) return false;
    p = p.prevZ;
  }
  while (n && n.z <= maxZ) {
    if (blocks(n)) return false;
    n = n.nextZ;
  }
  return true;
}

/** Clip away small self-intersections (a ring that touches itself). */
function cureLocalIntersections(start: Node, triangles: number[]): Node | null {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

/** Last resort: split the polygon along a valid diagonal and clip each half. */
function splitEarcut(start: Node, triangles: number[], minX: number, minY: number, invSize: number): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c: Node | null = splitPolygon(a, b);
        const a2 = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a2, triangles, minX, minY, invSize, 0);
        earcutLinked(c, triangles, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

/** Link every hole into the outer ring through a bridge edge, leftmost holes first. */
function eliminateHoles(data: ArrayLike<number>, holeIndices: ArrayLike<number>, outerNode: Node, dim: number): Node {
  const queue: Node[] = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * dim;
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next)!;
}

/** Find a vertex of the outer ring that the hole's leftmost point can see. */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
  let p = outerNode;
  const hx = hole.x, hy = hole.y;
  let qx = -Infinity;
  let m: Node | null = null;

  // Cast a ray from the hole's leftmost point to the left and find the
  // nearest outer segment it crosses.
  do {
    if (equals(hole, p)) return p;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m; // the hole touches the outer segment
      }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;

  // Any reflex vertex inside the triangle (hole point, crossing, m) would
  // block the bridge: pick the one with the smallest angle to the ray.
  const stop = m;
  const mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) &&
          (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m: Node, p: Node): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function indexCurve(start: Node, minX: number, minY: number, invSize: number): void {
  let p = start;
  do {
    p.z = zOrder(p.x, p.y, minX, minY, invSize);
    p.prevZ = p.prev;
    p.nextZ = p.next;
    p = p.next;
  } while (p !== start);
  p.prevZ!.nextZ = null;
  p.prevZ = null;
  sortLinked(p);
}

/** Merge sort of the z-order list (Simon Tatham's linked-list merge sort). */
function sortLinked(head: Node): Node {
  let list: Node | null = head;
  let inSize = 1;
  let numMerges: number;
  do {
    let p: Node | null = list;
    list = null;
    let tail: Node | null = null;
    numMerges = 0;
    while (p) {
      numMerges++;
      let q: Node | null = p;
      let pSize = 0;
      for (let i = 0; i < inSize; i++) {
        pSize++;
        q = q.nextZ;
        if (!q) break;
      }
      let qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        let e: Node;
        if (pSize !== 0 && (qSize === 0 || !q || p!.z <= q.z)) {
          e = p!;
          p = p!.nextZ;
          pSize--;
        } else {
          e = q!;
          q = q!.nextZ;
          qSize--;
        }
        if (tail) tail.nextZ = e;
        else list = e;
        e.prevZ = tail;
        tail = e;
      }
      p = q;
    }
    tail!.nextZ = null;
    inSize *= 2;
  } while (numMerges > 1);
  return list!;
}

/** Interleave the bits of the scaled coordinates (a Morton code). */
function zOrder(x0: number, y0: number, minX: number, minY: number, invSize: number): number {
  let x = ((x0 - minX) * invSize) | 0;
  let y = ((y0 - minY) * invSize) | 0;
  x = (x | (x << 8)) & 0x00FF00FF;
  x = (x | (x << 4)) & 0x0F0F0F0F;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00FF00FF;
  y = (y | (y << 4)) & 0x0F0F0F0F;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}

function getLeftmost(start: Node): Node {
  let p = start, leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function pointInTriangleExceptFirst(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return !(ax === px && ay === py) && pointInTriangle(ax, ay, bx, by, cx, cy, px, py);
}

/** Can a diagonal a-b split the polygon cleanly? */
function isValidDiagonal(a: Node, b: Node): boolean {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
     (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0));
}

/** Signed area of triangle p-q-r (twice the area; sign gives the turn). */
function area(p: Node, q: Node, r: Node): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1: Node, p2: Node): boolean {
  return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

/** Is the midpoint of a-b inside the polygon (even-odd ray test)? */
function middleInside(a: Node, b: Node): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y &&
        (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

/** Split a ring in two along a-b; returns the new node on the b side. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = createNode(a.i, a.x, a.y);
  const b2 = createNode(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function createNode(i: number, x: number, y: number): Node {
  const n = { i, x, y, z: 0, prevZ: null, nextZ: null, steiner: false } as unknown as Node;
  n.prev = n;
  n.next = n;
  return n;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
  const p = createNode(i, x, y);
  if (last) {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}

function flatSignedArea(data: ArrayLike<number>, start: number, end: number, dim: number): number {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

// ── Ring utilities ──────────────────────────────────────────────────────

/**
 * Shoelace area of a ring: positive when the ring runs counter-clockwise in
 * a y-up frame (which is clockwise on a y-down screen). Only the sign
 * convention matters to callers; both are consistent within this module.
 */
export function ringArea(ring: ArrayLike<Vec2>): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

/** Even-odd point-in-ring test. */
export function pointInRing(x: number, y: number, ring: ArrayLike<Vec2>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Drop consecutive duplicates and the closing repeat of the first point.
 * Returns a fresh array; the input is untouched.
 */
export function cleanRing(ring: ArrayLike<Vec2>, epsilon = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) <= epsilon && Math.abs(last[1] - p[1]) <= epsilon) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon) out.pop();
    else break;
  }
  return out;
}

/**
 * Sort a soup of closed, non-crossing rings (a traced glyph run, a set of
 * outlines) into fillable shapes by nesting depth: a ring inside an even
 * number of others is an outer boundary, one inside an odd number is a hole
 * of the smallest ring enclosing it. Orientation is ignored, so traced rings
 * of either winding work.
 */
export function classifyRings(rings: Vec2[][]): PolygonShape[] {
  const items = rings
    .map((ring) => ({ ring, area: Math.abs(ringArea(ring)) }))
    .filter((r) => r.ring.length >= 3 && r.area > 0);
  // Parent = the smallest ring containing this one.
  const parent: number[] = new Array(items.length).fill(-1);
  const depth: number[] = new Array(items.length).fill(0);
  for (let i = 0; i < items.length; i++) {
    const probe = items[i].ring[0];
    let best = -1;
    for (let j = 0; j < items.length; j++) {
      if (i === j || items[j].area <= items[i].area) continue;
      if (pointInRing(probe[0], probe[1], items[j].ring)) {
        depth[i]++;
        if (best < 0 || items[j].area < items[best].area) best = j;
      }
    }
    parent[i] = best;
  }
  const shapes = new Map<number, PolygonShape>();
  for (let i = 0; i < items.length; i++) {
    if (depth[i] % 2 === 0) shapes.set(i, { outer: items[i].ring, holes: [] });
  }
  for (let i = 0; i < items.length; i++) {
    if (depth[i] % 2 === 1 && parent[i] >= 0) shapes.get(parent[i])?.holes!.push(items[i].ring);
  }
  return [...shapes.values()];
}

/**
 * Triangulate one shape. Returns the flattened 2D vertices (outer ring first,
 * then each hole in order, matching the input rings after cleaning) and a
 * triangle index list into them.
 */
export function triangulateShape(shape: PolygonShape): { vertices: Vec2[]; indices: number[] } {
  const outer = cleanRing(shape.outer);
  const holes = (shape.holes ?? []).map((h) => cleanRing(h)).filter((h) => h.length >= 3);
  const vertices: Vec2[] = [];
  const flat: number[] = [];
  const holeIndices: number[] = [];
  for (const p of outer) { vertices.push(p); flat.push(p[0], p[1]); }
  for (const h of holes) {
    holeIndices.push(vertices.length);
    for (const p of h) { vertices.push(p); flat.push(p[0], p[1]); }
  }
  if (outer.length < 3) return { vertices, indices: [] };
  return { vertices, indices: earcut(flat, holeIndices.length ? holeIndices : undefined, 2) };
}

/**
 * How far a triangulation's total area strays from the polygon's area, as a
 * fraction (0 = exact). A cheap correctness check for tests and diagnostics.
 */
export function triangulationDeviation(shape: PolygonShape, vertices: Vec2[], indices: number[]): number {
  let polyArea = Math.abs(ringArea(cleanRing(shape.outer)));
  for (const h of shape.holes ?? []) polyArea -= Math.abs(ringArea(cleanRing(h)));
  let triArea = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]];
    triArea += Math.abs((a[0] - c[0]) * (b[1] - a[1]) - (a[0] - b[0]) * (c[1] - a[1])) / 2;
  }
  if (polyArea === 0 && triArea === 0) return 0;
  return Math.abs((triArea - polyArea) / polyArea);
}
