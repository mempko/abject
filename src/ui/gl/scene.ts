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
      if (op.params) node.params = { ...node.params, ...op.params };
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
