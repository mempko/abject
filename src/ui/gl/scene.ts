/**
 * Client-side retained store for scene-vocabulary nodes. Surfaces themselves
 * are managed by the Compositor (they are the roots); vocabulary nodes hang
 * off a surface's subtree and are composed against the surface's model
 * matrix at draw time.
 */

import { Mat4, mat4Multiply, mat4TRS } from './math.js';
import { SceneNodeKind, SceneOp, SceneTransform } from './scene-types.js';

export interface VocabNode {
  id: string;
  surfaceId: string;
  parentId?: string;
  kind: SceneNodeKind;
  transform: SceneTransform;
  params: Record<string, unknown>;
  /**
   * Bumped each time an applied op supplies `params.geometry`, so the
   * renderer can tell a cheap transform/color update apart from one that
   * deforms a custom mesh and re-upload the GPU buffers only when needed.
   */
  geomRev: number;
}

export class SceneStore {
  private nodes = new Map<string, VocabNode>();
  private bySurface = new Map<string, Set<string>>();

  /** Apply a validated op batch scoped to one surface's subtree. */
  apply(surfaceId: string, ops: SceneOp[]): void {
    for (const op of ops) {
      const key = `${surfaceId}/${op.id}`;
      if (op.op === 'remove') {
        this.removeNode(key);
        continue;
      }
      if (op.op === 'add') {
        const node: VocabNode = {
          id: op.id,
          surfaceId,
          parentId: op.parentId,
          kind: op.kind!,
          transform: op.transform ?? {},
          params: op.params ?? {},
          geomRev: op.params?.geometry !== undefined ? 1 : 0,
        };
        this.nodes.set(key, node);
        let set = this.bySurface.get(surfaceId);
        if (!set) {
          set = new Set();
          this.bySurface.set(surfaceId, set);
        }
        set.add(key);
        continue;
      }
      // update — merge transform/params
      const node = this.nodes.get(key);
      if (!node) continue;
      if (op.transform) node.transform = { ...node.transform, ...op.transform };
      if (op.params) {
        // Deep-merge `geometry` so a positions-only deform update (the cheap
        // path the geomRev design exists for) keeps the existing indices and
        // any supplied normals. A shallow spread would replace the whole
        // geometry object, dropping indices and collapsing the mesh into a
        // sequential triangle soup — the surface renders as disjoint strips.
        const prevGeom = node.params.geometry as Record<string, unknown> | undefined;
        const nextGeom = op.params.geometry as Record<string, unknown> | undefined;
        node.params = { ...node.params, ...op.params };
        if (op.params.geometry !== undefined) {
          if (prevGeom && nextGeom) {
            node.params.geometry = { ...prevGeom, ...nextGeom };
          }
          node.geomRev++;
        }
      }
      if (op.parentId !== undefined) node.parentId = op.parentId;
    }
  }

  private removeNode(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    this.nodes.delete(key);
    this.bySurface.get(node.surfaceId)?.delete(key);
    // Remove descendants
    for (const [k, n] of this.nodes) {
      if (n.surfaceId === node.surfaceId && n.parentId === node.id) this.removeNode(k);
    }
  }

  /** Drop every node owned by a surface (surface destroyed). */
  removeForSurface(surfaceId: string): void {
    const set = this.bySurface.get(surfaceId);
    if (!set) return;
    for (const key of set) this.nodes.delete(key);
    this.bySurface.delete(surfaceId);
  }

  clear(): void {
    this.nodes.clear();
    this.bySurface.clear();
  }

  /** Look up a single node by its surface key and node id. */
  getNode(surfaceId: string, id: string): VocabNode | undefined {
    return this.nodes.get(`${surfaceId}/${id}`);
  }

  /**
   * Material/behaviour params a child inherits from its ancestors (a group can
   * set the color, opacity, occlusion, shadow casting, etc. for its whole
   * subtree). Intrinsic params — primitive, geometry, instances, lightType,
   * direction, fog, bloom — are NOT inherited; they belong to the node itself.
   */
  private static readonly INHERITABLE = [
    'color', 'emissive', 'opacity', 'metalness', 'roughness',
    'texture', 'drawMode', 'pointSize', 'layer', 'occlude', 'castShadow',
  ];

  /**
   * Resolve a node's effective params by overlaying inheritable params from
   * its ancestor chain (root first, nearer ancestors and the node itself
   * winning), then the node's own full params. Mirrors how worldMatrix walks
   * the parent chain for transforms.
   */
  resolveParams(node: VocabNode): Record<string, unknown> {
    const ancestors: VocabNode[] = [];
    let cur = node;
    while (cur.parentId) {
      const p = this.nodes.get(`${cur.surfaceId}/${cur.parentId}`);
      if (!p) break;
      ancestors.unshift(p);
      cur = p;
    }
    if (ancestors.length === 0) return node.params;
    const inherited: Record<string, unknown> = {};
    for (const a of ancestors) {
      for (const k of SceneStore.INHERITABLE) {
        if (a.params[k] !== undefined) inherited[k] = a.params[k];
      }
    }
    return { ...inherited, ...node.params };
  }

  nodesForSurface(surfaceId: string): VocabNode[] {
    const set = this.bySurface.get(surfaceId);
    if (!set || set.size === 0) return [];
    const out: VocabNode[] = [];
    for (const key of set) {
      const n = this.nodes.get(key);
      if (n) out.push(n);
    }
    return out;
  }

  /** Local TRS matrix for a node. */
  static localMatrix(t: SceneTransform): Mat4 {
    const pos = t.position ?? [0, 0, 0];
    const rot = t.rotation ?? [0, 0, 0];
    const s = t.scale ?? 1;
    const sc: [number, number, number] = typeof s === 'number' ? [s, s, s] : s;
    return mat4TRS(pos[0], pos[1], pos[2], rot[0], rot[1], rot[2], sc[0], sc[1], sc[2]);
  }

  /** World matrix: surfaceModel · parent chain · local. */
  worldMatrix(node: VocabNode, surfaceModel: Mat4): Mat4 {
    const chain: VocabNode[] = [node];
    let cur = node;
    while (cur.parentId) {
      const parent = this.nodes.get(`${cur.surfaceId}/${cur.parentId}`);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent;
    }
    let m = surfaceModel;
    for (const link of chain) {
      m = mat4Multiply(m, SceneStore.localMatrix(link.transform));
    }
    return m;
  }
}
