/**
 * GraphWidget: a layout-managed 3D node graph (widget type 'nodeGraph').
 *
 * The widget occupies its layout rect like any widget. Its 2D paint (the
 * well behind the graph, title, legend, hints, empty state) goes into the
 * window texture; the graph itself is retained scene nodes the widget
 * contributes to its window (the canvas-widget contributor pattern), so
 * orbiting, springs, hover picking and pulses all run in the browser and
 * nothing streams per frame.
 *
 * Confining the view to the widget's rect. A window has ONE camera node and
 * it re-frames the window's whole clipped subtree (other widgets' canvases,
 * busy frames, decorations), so the graph does not use one. It renders
 * through the window's own camera and stays inside its rect by construction:
 * - the graph lives in a "lens": a sphere of radius R centred on the widget,
 *   with R chosen so the sphere projects inside the rect under the window's
 *   perspective (an off-centre widget sees its near side magnified, so R
 *   leaves room for that); rotation about the centre keeps every point in
 *   the sphere, so a turn can never push the graph out of the rect;
 * - zooming and focusing scale and shift the content, and nodes that would
 *   leave the lens fade out (edges to them too), so the lens stays the bound;
 * - turning is client-side: an invisible hit plane behind the graph belongs
 *   to a draggable "pad" in front of it, and the graph's anchor group
 *   carries a lookAt constraint on the pad, so dragging turns the graph
 *   under the hand (the browser's drag engine, with inertia). When the drag
 *   ends the widget folds the turn into a resting orientation and puts the
 *   pad back. Each graph widget turns on its own, so a window may hold
 *   several, and nothing else in the window is re-framed.
 * The window's content clip (below the title bar) stays the hard clip.
 *
 * Layout: force-directed in 3D (graph-layout.ts), computed here once per
 * topology change, warm-started, and sent as spring animate ops so nodes
 * ease to their places. Each edge is a line node holding a unit segment,
 * placed at its source and scaled by the vector to its target; its position
 * and scale ride the same spring as the nodes, so both ends stay on their
 * nodes while everything moves (the motion is linear in the spring, so the
 * sums line up exactly). Graphs with very many edges draw their edges as one
 * batched line instead (see LIVE_EDGE_LIMIT).
 *
 * Events (changed): nodeSelected (JSON { id, label, group, data, via }),
 * nodeFocused (JSON { id, via }).
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request } from '../../core/message.js';
import { require as contractRequire, ensure, invariant } from '../../core/contracts.js';
import { chromeCase } from '../../core/theme-data.js';
import { isSceneColor } from '../../ui/gl/scene-types.js';
import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { Rect, ThemeData, fontStacks, inkFrame } from './widget-types.js';
import {
  Vec3,
  layoutGraph3D,
  normalizeLayout,
  bakeTurn,
  rotateByEuler,
  alignToPrincipalAxes,
  medianNearestNeighbour,
  relaxOverlaps,
} from './graph-layout.js';

export const GRAPH_INTERFACE = 'abjects:graph';

// ── Public data shapes ─────────────────────────────────────────────────────

export interface GraphNodeSpec {
  id: string | number;
  label?: string;
  group?: string | number;
  /** Radius in px at zoom 1 (default 9). */
  size?: number;
  color?: string;
  shape?: string;
  material?: string;
  /** Living light: a breathing halo while true. */
  active?: boolean;
  /** Not yet real (a dangling reference): drawn see-through. */
  ghost?: boolean;
  /** Held at the middle of the layout (a hub: "this peer", the current selection). */
  center?: boolean;
  data?: unknown;
}

export interface GraphEdgeSpec {
  id?: string;
  from: string | number;
  to: string | number;
  label?: string;
  weight?: number;
  color?: string;
  style?: 'solid' | 'dashed';
}

export interface GraphGroupSpec {
  id: string | number;
  label?: string;
  color?: string;
  shape?: string;
  material?: string;
}

export interface GraphWidgetConfig extends WidgetConfig {
  nodes?: GraphNodeSpec[];
  edges?: GraphEdgeSpec[];
  groups?: GraphGroupSpec[];
  title?: string;
  emptyText?: string;
  directed?: boolean;
  labels?: 'auto' | 'all' | 'none';
  /** false hides the interaction hint; a string replaces its text. */
  hint?: boolean | string;
}

/** Node shapes a graph node may take (mesh primitives). */
export const GRAPH_NODE_SHAPES = ['sphere', 'icosphere', 'box', 'roundedBox', 'capsule', 'cylinder', 'cone', 'torus'] as const;

// ── Internal model ─────────────────────────────────────────────────────────

interface GNode {
  id: string;
  key: string;
  label: string;
  group: string;
  size: number;
  color?: string;
  shape?: string;
  material?: string;
  active: boolean;
  ghost: boolean;
  center: boolean;
  data?: unknown;
}

interface GEdge {
  id: string;
  key: string;
  from: string;
  to: string;
  label?: string;
  weight: number;
  color?: string;
  dashed: boolean;
}

interface GGroup {
  id: string;
  label?: string;
  color?: string;
  shape?: string;
  material?: string;
}

/** What was last sent for a node (the diff base for the next reconcile). */
interface NodeShown {
  key: string;
  pos: Vec3;
  meshSig: string;
  meshScale: number;
  culled: boolean;
  label?: string;
  halo: boolean;
  ring?: string;
}

interface EdgeShown {
  key: string;
  src: string;
  /** Start point (the source node's place) and the vector to the target. */
  p: Vec3;
  d: Vec3;
  styleSig: string;
  opacity: number;
}

interface Geometry {
  /** Anchor (lens centre), px from the window centre. */
  ax: number;
  ay: number;
  /** Widget rect centre, px from the window centre. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Lens radius, px. */
  R: number;
}

type SceneOp = Record<string, unknown>;

// ── Tuning ─────────────────────────────────────────────────────────────────

/** The one spring every layout motion shares (node moves, edge vectors, pops). */
const SPRING = { stiffness: 170, damping: 26 } as const;
/** Zoom and focus moves of the whole content. */
const VIEW_SPRING = { stiffness: 120, damping: 22 } as const;
/** Camera distance estimate (px) for fitting the lens; the real one follows the viewport height. */
const CAMERA_DISTANCE_EST = 1600;
/**
 * Above this many edges, edges draw as one batched line (plus live lines for
 * the emphasized ones), which cannot follow node springs and so fades out
 * while nodes move. Each line node is its own draw; 1000 live edges cost
 * about 3 ms of frame time on top of their nodes while the graph turns.
 */
const LIVE_EDGE_LIMIT = 1200;
/** Edges per batched line node (4 points each; a line takes up to 10000 points). */
const BATCH_EDGES_PER_LINE = 2400;
/**
 * Nodes of a very small graph sit at most about this far apart (median
 * nearest neighbour, px at zoom 1), so three nodes in a big lens stay a
 * group instead of flying to its rim. Larger graphs fill the lens.
 */
const MAX_NEIGHBOUR_PX = 130;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const MIN_WIDGET_PX = 90;
const DOUBLE_CLICK_MS = 420;
const DEFAULT_ORIENT: Vec3 = [-0.28, 0.42, 0];

const GROUP_COLORS = ['$textPrimary', '$accentTertiary', '$statusInfo', '$statusSuccess', '$textSecondary', '$statusWarning', '$windowBorder'];
const GROUP_MATERIALS = ['ceramic', 'plastic', 'ceramic', 'plastic', 'bone', 'ceramic', 'plastic'];
const GROUP_SHAPES = ['sphere', 'icosphere', 'roundedBox', 'capsule', 'cylinder', 'cone', 'torus'];
/** Shapes whose corners reach past a sphere of the same size draw a little smaller. */
const SHAPE_SCALE: Record<string, number> = { box: 0.78, roundedBox: 0.82, cylinder: 0.85, capsule: 0.9, cone: 0.95, torus: 1.1 };

const EDGE_COLOR = '$textSecondary';
const EDGE_OPACITY = 0.62;

function vlen(v: readonly number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function sameVec(a: readonly number[] | undefined, b: readonly number[], eps: number): boolean {
  return !!a && Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

/** A vector with no component exactly zero (a zero scale axis makes a singular node matrix). */
function safeVec(v: Vec3): Vec3 {
  const f = (x: number) => (Math.abs(x) < 0.01 ? (x < 0 ? -0.01 : 0.01) : x);
  return [f(v[0]), f(v[1]), f(v[2])];
}

function round3(v: readonly number[]): Vec3 {
  return [Math.round(v[0] * 100) / 100, Math.round(v[1] * 100) / 100, Math.round(v[2] * 100) / 100];
}

/**
 * GraphWidget: interactive 3D graph in a widget rect.
 */
export class GraphWidget extends WidgetAbject {
  // ── Model ──
  private nodes = new Map<string, GNode>();
  private edges = new Map<string, GEdge>();
  private groups = new Map<string, GGroup>();
  private groupOrder: string[] = [];
  private keyToNode = new Map<string, string>();
  private nextKey = 0;
  private title?: string;
  private emptyText = 'No nodes yet';
  private directed = true;
  private labelMode: 'auto' | 'all' | 'none' = 'auto';
  private showHint = true;
  /** The hint's text when the owner words it (what a double-click does there). */
  private hintText?: string;

  // ── Interaction state ──
  private selectedId?: string;
  private hoveredId?: string;
  private highlighted = new Set<string>();
  private highlightColor = '$accent';
  private lastDown?: { target: string; t: number };

  // ── View ──
  private zoom = 1;
  /** Focus point in unit layout coordinates (the lens centre looks at it). */
  private focus: Vec3 = [0, 0, 0];
  private orient: Vec3 = [...DEFAULT_ORIENT];

  // ── Layout ──
  private raw = new Map<string, Vec3>();
  /** The layout normalized to the lens (radius 1), before the spacing cap. */
  private unitBase = new Map<string, Vec3>();
  /** Median nearest-neighbour distance in unitBase. */
  private unitNN = 0;
  /** unitBase scaled by the spacing cap for the current lens: every view computation reads this. */
  private unit = new Map<string, Vec3>();
  private unitSpread = 1;
  private unitSpreadFor = -1;
  private layoutPending = false;
  private layoutRunning = false;

  // ── Scene plumbing ──
  private readonly prefix: string;
  private built = false;
  private geom?: Geometry;
  private shownNodes = new Map<string, NodeShown>();
  private shownEdges = new Map<string, EdgeShown>();
  private shownView?: { pos: Vec3; zoom: number };
  private batchLines = 0;
  private batchSig = '';
  private batchTimer?: ReturnType<typeof setTimeout>;
  private opQueue: SceneOp[] = [];
  private opsInFlight = false;
  private lastOrigin?: { ox: number; oy: number; w: number; h: number };
  private geomBusy = false;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private geomDirty = false;
  private pulseSeq = 0;
  private disposed = false;
  /** First build pops nodes in with a stagger. */
  private revealNext = true;

  constructor(config: GraphWidgetConfig) {
    super(config);
    this.prefix = `ng${String(this.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`;
    this.title = config.title;
    if (typeof config.emptyText === 'string') this.emptyText = config.emptyText;
    if (typeof config.directed === 'boolean') this.directed = config.directed;
    if (config.labels === 'all' || config.labels === 'none' || config.labels === 'auto') this.labelMode = config.labels;
    if (config.hint === false) this.showHint = false;
    if (typeof config.hint === 'string' && config.hint.length > 0) this.hintText = config.hint;
    if (config.groups) this.applyGroups(config.groups);
    if (config.nodes || config.edges) this.replaceGraph(config.nodes ?? [], config.edges ?? []);

    (this as unknown as { manifest: unknown }).manifest = {
      name: 'GraphWidget',
      description: 'Interactive 3D node graph (widget type nodeGraph): nodes as lit shapes, edges as lines, force-directed 3D layout that springs into place, drag to turn, wheel to zoom, click to select, double-click to focus. Emits nodeSelected / nodeFocused.',
      version: '1.0.0',
      interface: {
        id: GRAPH_INTERFACE,
        name: 'Graph',
        description: 'Data and view API of the 3D graph widget. Node ids are your own strings; every method replies once the change is queued (motion runs in the browser).',
        methods: [
          {
            name: 'setGraph',
            description: 'Replace the whole graph. nodes: [{ id, label?, group?, size? (radius px, default 9), color? ("#hex" or $token), shape? (' + GRAPH_NODE_SHAPES.join('|') + '), material? (SceneLibrary name), active? (living light halo), ghost? (see-through, for dangling references), center? (held at the middle, for a hub such as "this peer" or the current selection), data? (echoed in events) }]; edges: [{ from, to, id?, label?, weight? (thicker and tighter), color?, style?: "solid"|"dashed" }]; groups?: [{ id, label?, color?, shape?, material? }] (legend and per-group look). Existing nodes keep their places; the layout warm-starts.',
            parameters: [
              { name: 'nodes', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphNode' } }, description: 'All nodes' },
              { name: 'edges', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphEdge' } }, description: 'All edges (endpoints must be node ids)' },
              { name: 'groups', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphGroup' } }, description: 'Group legend and looks', optional: true },
            ],
            returns: { kind: 'object', properties: { nodes: { kind: 'primitive', primitive: 'number' }, edges: { kind: 'primitive', primitive: 'number' } } },
          },
          {
            name: 'upsertNodes',
            description: 'Add nodes or change existing ones by id (fields you omit keep their value). Only a new node or a new group re-runs the layout; changing color, size, label, active or data does not move anything.',
            parameters: [{ name: 'nodes', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphNode' } }, description: 'Nodes to add or change' }],
            returns: { kind: 'primitive', primitive: 'number' },
          },
          {
            name: 'removeNodes',
            description: 'Remove nodes (and every edge touching them) by id.',
            parameters: [{ name: 'ids', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Node ids' }],
            returns: { kind: 'primitive', primitive: 'number' },
          },
          {
            name: 'upsertEdges',
            description: 'Add edges or change existing ones (matched by id, else by from+to). Endpoints must already be nodes.',
            parameters: [{ name: 'edges', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphEdge' } }, description: 'Edges to add or change' }],
            returns: { kind: 'primitive', primitive: 'number' },
          },
          {
            name: 'removeEdges',
            description: 'Remove edges: pass ids (edge ids) or edges ([{ from, to }]).',
            parameters: [
              { name: 'ids', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Edge ids', optional: true },
              { name: 'edges', type: { kind: 'array', elementType: { kind: 'reference', reference: 'GraphEdgeRef' } }, description: 'Edges by endpoints', optional: true },
            ],
            returns: { kind: 'primitive', primitive: 'number' },
          },
          {
            name: 'select',
            description: 'Select a node from code (null clears). The selection wears the accent ring and its edges light up (outgoing in the accent, incoming in the living light when directed). Does not emit nodeSelected. focus: true also centres and zooms on it; a selected node outside the view is brought into view anyway.',
            parameters: [
              { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Node id, or null to clear' },
              { name: 'focus', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Centre and zoom on it', optional: true },
            ],
            returns: { kind: 'primitive', primitive: 'boolean' },
          },
          {
            name: 'focusNode',
            description: 'Centre the view on a node and zoom to its neighbourhood (zoom? overrides, 0.5..6). Without an id the view resets to the whole graph. Nodes that fall outside the view fade out.',
            parameters: [
              { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Node id (omit to reset)', optional: true },
              { name: 'zoom', type: { kind: 'primitive', primitive: 'number' }, description: 'Zoom factor', optional: true },
            ],
            returns: { kind: 'primitive', primitive: 'boolean' },
          },
          {
            name: 'pulse',
            description: 'One-shot flow from one node to another: a glowing mote with a trail travels the edge and flashes the target (color? default the living light, count? motes 1..8). Nothing loops.',
            parameters: [
              { name: 'from', type: { kind: 'primitive', primitive: 'string' }, description: 'Source node id' },
              { name: 'to', type: { kind: 'primitive', primitive: 'string' }, description: 'Target node id' },
              { name: 'color', type: { kind: 'primitive', primitive: 'string' }, description: '"#hex" or $token', optional: true },
              { name: 'count', type: { kind: 'primitive', primitive: 'number' }, description: 'Motes, 1..8', optional: true },
            ],
            returns: { kind: 'primitive', primitive: 'boolean' },
          },
          {
            name: 'highlight',
            description: 'Spotlight a set of nodes: they get a ring (color?, default the accent) and labels, the edges among them brighten, everything else dims. ids: [] clears.',
            parameters: [
              { name: 'ids', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Node ids' },
              { name: 'color', type: { kind: 'primitive', primitive: 'string' }, description: '"#hex" or $token', optional: true },
            ],
            returns: { kind: 'primitive', primitive: 'boolean' },
          },
          {
            name: 'getSelection',
            description: 'The selected node id, or null.',
            parameters: [],
            returns: { kind: 'primitive', primitive: 'string' },
          },
          {
            name: 'getGraph',
            description: 'The current graph as { nodes, edges, groups } (the same shapes setGraph takes).',
            parameters: [],
            returns: { kind: 'object', properties: {} },
          },
        ],
        events: [
          {
            name: 'nodeSelected',
            description: 'changed aspect: the user clicked a node. value is a JSON string { id, label, group, data, via: "click" } (JSON.parse it).',
            payload: { kind: 'primitive', primitive: 'string' },
          },
          {
            name: 'nodeFocused',
            description: 'changed aspect: the user double-clicked a node and the view centred on it. value is a JSON string { id, via: "dblclick" }.',
            payload: { kind: 'primitive', primitive: 'string' },
          },
        ],
      },
      tags: ['widget', 'nodeGraph', 'graph', '3d'],
    };

    this.setupGraphHandlers();
  }

  protected override async onInit(): Promise<void> {
    await super.onInit();
    if (this.nodes.size > 0) this.scheduleLayout();
  }

  protected override async onStop(): Promise<void> {
    this.disposed = true;
    this.cancelTimer(this.batchTimer);
    // The UIServer drops a dead contributor's nodes; nothing to send (a
    // stopped object cannot send).
    await super.onStop();
  }

  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(question: string): string {
    return super.askPrompt(question) + `\n\n## GraphWidget (widget type 'nodeGraph')

I draw a graph in 3D inside my layout rect: nodes are lit shapes, edges are lines, and a force-directed 3D layout springs nodes into place in the browser. The user drags to turn the graph, uses the wheel to zoom, clicks a node to select it and double-clicks to focus it. Create me with WidgetManager create({ specs: [{ type: 'nodeGraph', windowId, nodes, edges, groups?, title?, emptyText?, directed? (default true), labels?: 'auto'|'all'|'none', hint? }] }) and place me in a layout like any widget.

Data: setGraph({ nodes, edges, groups? }), upsertNodes({ nodes }), removeNodes({ ids }), upsertEdges({ edges }), removeEdges({ ids | edges }). A node is { id, label?, group?, size? (radius px), color?, shape?, material?, active?, ghost?, center? (held at the middle: a hub), data? }; an edge is { from, to, id?, label?, weight?, color?, style?: 'solid'|'dashed' }. Changing attributes (color, size, active, label) never moves nodes; adding nodes or edges re-runs the layout warm.
View: select({ id, focus? }), focusNode({ id?, zoom? }) (no id resets), highlight({ ids, color? }), pulse({ from, to, color?, count? }) for a one-shot flow along an edge.
Events (addDependent, then changed): nodeSelected and nodeFocused, each a JSON string value ({ id, label, group, data, via }).
Light has meaning: active nodes breathe in the living light ($accentSecondary); the selection is the accent ($accent). Use $token colours so every palette works. Idle means still: only active nodes loop.`;
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  private setupGraphHandlers(): void {
    this.on('setGraph', async (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as { nodes?: unknown; edges?: unknown; groups?: unknown };
      contractRequire(Array.isArray(p.nodes), 'setGraph: nodes must be an array of { id, label?, group?, ... }');
      contractRequire(p.edges === undefined || Array.isArray(p.edges), 'setGraph: edges must be an array of { from, to, ... }');
      if (p.groups !== undefined) {
        contractRequire(Array.isArray(p.groups), 'setGraph: groups must be an array of { id, label?, color?, shape?, material? }');
        this.applyGroups(p.groups as GraphGroupSpec[]);
      }
      this.replaceGraph(p.nodes as GraphNodeSpec[], (p.edges ?? []) as GraphEdgeSpec[]);
      ensure(this.nodes.size === (p.nodes as unknown[]).length, 'setGraph: node count matches the input');
      return { nodes: this.nodes.size, edges: this.edges.size };
    });

    this.on('upsertNodes', async (msg: AbjectMessage) => {
      const { nodes } = (msg.payload ?? {}) as { nodes?: unknown };
      contractRequire(Array.isArray(nodes), 'upsertNodes: nodes must be an array of { id, ... }');
      const specs = (nodes as unknown[]).map((n) => this.parseNode(n));
      let topology = false;
      for (const s of specs) {
        const prev = this.nodes.get(s.id);
        // Only a new node, a new group or a new centre moves anything.
        if (!prev || (s.fields.has('group') && prev.group !== s.group)
          || (s.fields.has('center') && prev.center !== s.center)) topology = true;
        this.nodes.set(s.id, this.mergeNode(prev, s));
      }
      this.afterDataChange(topology);
      return specs.length;
    });

    this.on('removeNodes', async (msg: AbjectMessage) => {
      const { ids } = (msg.payload ?? {}) as { ids?: unknown };
      contractRequire(Array.isArray(ids), 'removeNodes: ids must be an array of node ids');
      let removed = 0;
      for (const raw of ids as unknown[]) {
        const id = String(raw);
        if (this.removeNodeInternal(id)) removed++;
      }
      if (removed > 0) this.afterDataChange(true);
      return removed;
    });

    this.on('upsertEdges', async (msg: AbjectMessage) => {
      const { edges } = (msg.payload ?? {}) as { edges?: unknown };
      contractRequire(Array.isArray(edges), 'upsertEdges: edges must be an array of { from, to, ... }');
      const specs = (edges as unknown[]).map((e) => this.parseEdge(e, this.nodes));
      let topology = false;
      for (const e of specs) {
        const prev = this.edges.get(e.id);
        if (!prev || prev.weight !== e.weight) topology = true;
        this.edges.set(e.id, { ...e, key: prev?.key ?? this.allocKey() });
      }
      this.afterDataChange(topology);
      return specs.length;
    });

    this.on('removeEdges', async (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as { ids?: unknown; edges?: unknown };
      contractRequire(p.ids !== undefined || p.edges !== undefined, 'removeEdges: pass ids (edge ids) or edges ([{ from, to }])');
      let removed = 0;
      if (Array.isArray(p.ids)) for (const id of p.ids) if (this.edges.delete(String(id))) removed++;
      if (Array.isArray(p.edges)) {
        for (const raw of p.edges as Array<{ from?: unknown; to?: unknown }>) {
          const key = GraphWidget.edgeId(undefined, String(raw?.from), String(raw?.to));
          if (this.edges.delete(key)) removed++;
        }
      }
      if (removed > 0) this.afterDataChange(true);
      return removed;
    });

    this.on('select', async (msg: AbjectMessage) => {
      const { id, focus } = (msg.payload ?? {}) as { id?: unknown; focus?: boolean };
      const target = id === null || id === undefined || id === '' ? undefined : String(id);
      contractRequire(target === undefined || this.nodes.has(target), `select: no node with id '${String(id)}'`);
      this.selectedId = target;
      if (target && focus === true) this.focusOn(target);
      else if (target) this.revealNode(target);
      this.reconcile();
      return true;
    });

    this.on('focusNode', async (msg: AbjectMessage) => {
      const { id, zoom } = (msg.payload ?? {}) as { id?: unknown; zoom?: unknown };
      const target = id === null || id === undefined || id === '' ? undefined : String(id);
      contractRequire(target === undefined || this.nodes.has(target), `focusNode: no node with id '${String(id)}'`);
      contractRequire(zoom === undefined || (typeof zoom === 'number' && Number.isFinite(zoom)), 'focusNode: zoom must be a number (0.5..6)');
      if (target) this.focusOn(target, zoom as number | undefined);
      else this.resetView(zoom as number | undefined);
      this.reconcile();
      return true;
    });

    this.on('pulse', async (msg: AbjectMessage) => {
      const { from, to, color, count } = (msg.payload ?? {}) as { from?: unknown; to?: unknown; color?: unknown; count?: unknown };
      contractRequire(from !== undefined && this.nodes.has(String(from)), `pulse: no node with id '${String(from)}' (from)`);
      contractRequire(to !== undefined && this.nodes.has(String(to)), `pulse: no node with id '${String(to)}' (to)`);
      contractRequire(color === undefined || isSceneColor(color), 'pulse: color must be "#hex", "rgb(...)" or a $token');
      return this.pulse(String(from), String(to), (color as string | undefined) ?? '$accentSecondary',
        Math.max(1, Math.min(8, Math.round(typeof count === 'number' ? count : 1))));
    });

    this.on('highlight', async (msg: AbjectMessage) => {
      const { ids, color } = (msg.payload ?? {}) as { ids?: unknown; color?: unknown };
      contractRequire(Array.isArray(ids), 'highlight: ids must be an array of node ids ([] clears)');
      contractRequire(color === undefined || isSceneColor(color), 'highlight: color must be "#hex", "rgb(...)" or a $token');
      this.highlighted = new Set((ids as unknown[]).map(String).filter((i) => this.nodes.has(i)));
      this.highlightColor = (color as string | undefined) ?? '$accent';
      this.reconcile();
      return true;
    });

    this.on('getSelection', async () => this.selectedId ?? null);

    this.on('getGraph', async () => ({
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id, label: n.label, group: n.group, size: n.size,
        ...(n.color ? { color: n.color } : {}), ...(n.shape ? { shape: n.shape } : {}),
        ...(n.material ? { material: n.material } : {}), active: n.active, ghost: n.ghost,
        ...(n.center ? { center: true } : {}),
        ...(n.data !== undefined ? { data: n.data } : {}),
      })),
      edges: [...this.edges.values()].map((e) => ({
        id: e.id, from: e.from, to: e.to, weight: e.weight,
        ...(e.label ? { label: e.label } : {}), ...(e.color ? { color: e.color } : {}),
        style: e.dashed ? 'dashed' : 'solid',
      })),
      groups: this.groupOrder.map((g) => ({ ...(this.groups.get(g) ?? { id: g }) })),
    }));

    // Input on the graph's own scene nodes (the UIServer routes a
    // contributor's node events straight back to it).
    this.on('nodeInput', async (msg: AbjectMessage) => {
      this.onGraphNodeInput(msg.payload as {
        type?: string; nodeId?: string; position?: number[];
      });
      return true;
    });
  }

  // ── Model helpers ─────────────────────────────────────────────────────

  private allocKey(): string {
    return (this.nextKey++).toString(36);
  }

  private static edgeId(id: string | undefined, from: string, to: string): string {
    return id ?? `${from}→${to}`;
  }

  private parseNode(raw: unknown): Omit<GNode, 'key'> & { fields: Set<string> } {
    contractRequire(!!raw && typeof raw === 'object', 'graph node must be an object { id, label?, group?, ... }');
    const n = raw as Record<string, unknown>;
    contractRequire((typeof n.id === 'string' && n.id.length > 0) || typeof n.id === 'number',
      'graph node needs an id (a non-empty string or a number)');
    const id = String(n.id);
    contractRequire(n.label === undefined || typeof n.label === 'string', `node '${id}': label must be a string`);
    contractRequire(n.group === undefined || typeof n.group === 'string' || typeof n.group === 'number', `node '${id}': group must be a string or number`);
    contractRequire(n.size === undefined || (typeof n.size === 'number' && Number.isFinite(n.size) && n.size > 0), `node '${id}': size must be a positive number (radius px)`);
    contractRequire(n.color === undefined || isSceneColor(n.color), `node '${id}': color must be "#hex", "rgb(...)" or a $token like "$accent"`);
    contractRequire(n.shape === undefined || (GRAPH_NODE_SHAPES as readonly string[]).includes(n.shape as string),
      `node '${id}': shape must be one of ${GRAPH_NODE_SHAPES.join(', ')}`);
    contractRequire(n.material === undefined || (typeof n.material === 'string' && n.material.length > 0), `node '${id}': material must be a SceneLibrary material name`);
    contractRequire(n.center === undefined || typeof n.center === 'boolean', `node '${id}': center must be true or false`);
    const fields = new Set(Object.keys(n));
    return {
      id,
      label: typeof n.label === 'string' ? n.label : id,
      group: n.group !== undefined ? String(n.group) : '',
      size: typeof n.size === 'number' ? Math.max(3, Math.min(60, n.size)) : 9,
      color: n.color as string | undefined,
      shape: n.shape as string | undefined,
      material: n.material as string | undefined,
      active: n.active === true,
      ghost: n.ghost === true,
      center: n.center === true,
      data: n.data,
      fields,
    };
  }

  /** A node from its spec, keeping unspecified fields of an existing node. */
  private mergeNode(prev: GNode | undefined, s: ReturnType<GraphWidget['parseNode']>): GNode {
    const has = (k: string) => s.fields.has(k);
    const node: GNode = {
      id: s.id,
      key: prev?.key ?? this.allocKey(),
      label: has('label') || !prev ? s.label : prev.label,
      group: has('group') || !prev ? s.group : prev.group,
      size: has('size') || !prev ? s.size : prev.size,
      color: has('color') || !prev ? s.color : prev.color,
      shape: has('shape') || !prev ? s.shape : prev.shape,
      material: has('material') || !prev ? s.material : prev.material,
      active: has('active') || !prev ? s.active : prev.active,
      ghost: has('ghost') || !prev ? s.ghost : prev.ghost,
      center: has('center') || !prev ? s.center : prev.center,
      data: has('data') || !prev ? s.data : prev.data,
    };
    this.keyToNode.set(node.key, node.id);
    if (!this.groupOrder.includes(node.group)) this.groupOrder.push(node.group);
    return node;
  }

  private parseEdge(raw: unknown, nodes: ReadonlyMap<string, unknown>): Omit<GEdge, 'key'> {
    contractRequire(!!raw && typeof raw === 'object', 'graph edge must be an object { from, to, ... }');
    const e = raw as Record<string, unknown>;
    contractRequire(e.from !== undefined && e.to !== undefined, 'graph edge needs from and to (node ids)');
    const from = String(e.from), to = String(e.to);
    contractRequire(nodes.has(from), `edge ${from} -> ${to}: no node with id '${from}' (add nodes before edges that use them)`);
    contractRequire(nodes.has(to), `edge ${from} -> ${to}: no node with id '${to}' (add nodes before edges that use them)`);
    contractRequire(e.weight === undefined || (typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight >= 0), `edge ${from} -> ${to}: weight must be a number >= 0`);
    contractRequire(e.color === undefined || isSceneColor(e.color), `edge ${from} -> ${to}: color must be "#hex", "rgb(...)" or a $token`);
    contractRequire(e.style === undefined || e.style === 'solid' || e.style === 'dashed', `edge ${from} -> ${to}: style must be 'solid' or 'dashed'`);
    contractRequire(e.id === undefined || (typeof e.id === 'string' && e.id.length > 0), `edge ${from} -> ${to}: id must be a non-empty string`);
    return {
      id: GraphWidget.edgeId(e.id as string | undefined, from, to),
      from, to,
      label: typeof e.label === 'string' ? e.label : undefined,
      weight: typeof e.weight === 'number' ? e.weight : 1,
      color: e.color as string | undefined,
      dashed: e.style === 'dashed',
    };
  }

  private applyGroups(groups: GraphGroupSpec[]): void {
    for (const raw of groups) {
      contractRequire(!!raw && (typeof raw.id === 'string' || typeof raw.id === 'number'), 'graph group needs an id');
      const id = String(raw.id);
      contractRequire(raw.color === undefined || isSceneColor(raw.color), `group '${id}': color must be "#hex", "rgb(...)" or a $token`);
      contractRequire(raw.shape === undefined || (GRAPH_NODE_SHAPES as readonly string[]).includes(raw.shape),
        `group '${id}': shape must be one of ${GRAPH_NODE_SHAPES.join(', ')}`);
      this.groups.set(id, { id, label: raw.label, color: raw.color, shape: raw.shape, material: raw.material });
      if (!this.groupOrder.includes(id)) this.groupOrder.push(id);
    }
  }

  /** Replace the whole graph (setGraph / spec / update). Existing ids keep their keys and places. */
  private replaceGraph(nodeSpecs: GraphNodeSpec[], edgeSpecs: GraphEdgeSpec[]): void {
    const parsed = nodeSpecs.map((n) => this.parseNode(n));
    const ids = new Set(parsed.map((n) => n.id));
    contractRequire(ids.size === parsed.length, 'setGraph: node ids must be unique');
    const nextNodes = new Map<string, GNode>();
    let topology = parsed.length !== this.nodes.size;
    for (const s of parsed) {
      const prev = this.nodes.get(s.id);
      if (!prev || prev.group !== s.group || prev.center !== s.center) topology = true;
      // setGraph replaces: a field the new spec leaves out takes its default.
      nextNodes.set(s.id, this.mergeNode(prev, { ...s, fields: new Set(['label', 'group', 'size', 'color', 'shape', 'material', 'active', 'ghost', 'center', 'data']) }));
    }
    const edgeParsed = edgeSpecs.map((e) => this.parseEdge(e, nextNodes));
    const nextEdges = new Map<string, GEdge>();
    if (edgeParsed.length !== this.edges.size) topology = true;
    for (const e of edgeParsed) {
      const prev = this.edges.get(e.id);
      if (!prev || prev.weight !== e.weight || prev.from !== e.from || prev.to !== e.to) topology = true;
      nextEdges.set(e.id, { ...e, key: prev?.key ?? this.allocKey() });
    }
    for (const id of this.nodes.keys()) {
      if (!nextNodes.has(id)) this.keyToNode.delete(this.nodes.get(id)!.key);
    }
    this.nodes = nextNodes;
    this.edges = nextEdges;
    for (const id of [...this.raw.keys()]) if (!this.nodes.has(id)) this.raw.delete(id);
    if (this.selectedId && !this.nodes.has(this.selectedId)) this.selectedId = undefined;
    if (this.hoveredId && !this.nodes.has(this.hoveredId)) this.hoveredId = undefined;
    for (const id of [...this.highlighted]) if (!this.nodes.has(id)) this.highlighted.delete(id);
    this.afterDataChange(topology);
  }

  private removeNodeInternal(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);
    this.keyToNode.delete(node.key);
    this.raw.delete(id);
    for (const [eid, e] of this.edges) if (e.from === id || e.to === id) this.edges.delete(eid);
    if (this.selectedId === id) this.selectedId = undefined;
    if (this.hoveredId === id) this.hoveredId = undefined;
    this.highlighted.delete(id);
    return true;
  }

  /** After any data change: repaint 2D (legend, empty state), then re-layout or just re-dress. */
  private afterDataChange(topology: boolean): void {
    void this.requestRedraw();
    if (topology) this.scheduleLayout();
    else this.reconcile();
  }

  // ── Layout ────────────────────────────────────────────────────────────

  private scheduleLayout(): void {
    this.layoutPending = true;
    void this.runLayout();
  }

  private async runLayout(): Promise<void> {
    if (this.layoutRunning) return;
    this.layoutRunning = true;
    try {
      while (this.layoutPending && !this.disposed) {
        this.layoutPending = false;
        const nodes = [...this.nodes.values()].map((n) => ({ id: n.id, group: n.group, ...(n.center ? { center: true } : {}) }));
        const edges = [...this.edges.values()].map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
        // Nothing of this graph is placed yet: a fresh layout, free to face the viewer.
        const cold = !nodes.some((n) => this.raw.has(n.id));
        let raw = await layoutGraph3D(nodes, edges, this.raw, {
          isStale: () => this.layoutPending || this.disposed,
        });
        if (this.layoutPending || this.disposed) continue;
        for (const id of [...raw.keys()]) if (!this.nodes.has(id)) raw.delete(id);
        // A centre node (held at the origin) is the middle of the view.
        const middle: Vec3 | undefined = nodes.some((n) => n.center) ? [0, 0, 0] : undefined;
        if (cold) raw = alignToPrincipalAxes(raw, middle);
        this.raw = raw;
        this.unitBase = normalizeLayout(raw, middle);
        this.unitNN = medianNearestNeighbour([...this.unitBase.values()]);
        this.unitSpreadFor = -1;
        this.ensureUnitSpread();
        this.reconcile();
      }
    } catch (err) {
      this.logError('graph layout failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.layoutRunning = false;
    }
  }

  // ── View helpers ──────────────────────────────────────────────────────

  /**
   * Scale the normalized layout for the current lens: a graph fills the
   * lens unless that would spread its nodes further apart than
   * MAX_NEIGHBOUR_PX, in which case it keeps that spacing and sits smaller
   * in the middle. The focus scales with it, so the view holds still.
   */
  private ensureUnitSpread(): void {
    const R = this.geom?.R;
    if (!R) {
      // No lens yet: unscaled until the widget is placed.
      this.unit = this.unitBase;
      this.unitSpread = 1;
      this.unitSpreadFor = -1;
      return;
    }
    if (this.unitSpreadFor === R) return;
    // A small graph reads best as a shallow relief facing the viewer (depth
    // stacks its nodes on top of each other); from a few dozen nodes on, the
    // full depth helps. The flattened layout is scaled back out to the lens.
    const n = this.unitBase.size;
    const flat = Math.max(0.25, Math.min(1, (n - 6) / 40));
    let base: Map<string, Vec3> = this.unitBase;
    if (flat < 1) {
      base = new Map([...this.unitBase].map(([id, u]) => [id, [u[0], u[1], u[2] * flat] as Vec3]));
      let rmax = 0;
      for (const u of base.values()) rmax = Math.max(rmax, Math.hypot(u[0], u[1], u[2]));
      const k = rmax > 1e-9 ? 0.9 / rmax : 1;
      base = new Map([...base].map(([id, u]) => [id, [u[0] * k, u[1] * k, u[2] * k] as Vec3]));
    }
    const nn = flat < 1 ? medianNearestNeighbour([...base.values()]) : this.unitNN;
    const spread = nn > 1e-9 ? Math.min(1, MAX_NEIGHBOUR_PX / (nn * R)) : 1;
    const k = this.unitSpread > 0 ? spread / this.unitSpread : 1;
    this.focus = [this.focus[0] * k, this.focus[1] * k, this.focus[2] * k];
    this.unitSpread = spread;
    this.unitSpreadFor = R;
    const scaled = new Map([...base].map(([id, u]) => [id, [u[0] * spread * R, u[1] * spread * R, u[2] * spread * R] as Vec3]));
    // Room for every body: a hub crowded by its spokes, or two nodes the
    // layout left on top of each other, are eased apart (inside the lens).
    const relaxed = scaled.size <= 400
      ? relaxOverlaps(scaled, (id) => this.nodes.get(id)?.size ?? 9,
        new Set([...this.nodes.values()].filter((n) => n.center).map((n) => n.id)), R * 0.96)
      : scaled;
    this.unit = new Map([...relaxed].map(([id, p]) => [id, [p[0] / R, p[1] / R, p[2] / R] as Vec3]));
  }

  private clampZoom(z: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  /** Centre on a node and zoom so its neighbours stay inside the lens. */
  private focusOn(id: string, zoom?: number): void {
    const u = this.unit.get(id);
    if (!u) return;
    let far = 0;
    for (const e of this.edges.values()) {
      const other = e.from === id ? e.to : e.to === id ? e.from : undefined;
      const v = other ? this.unit.get(other) : undefined;
      if (v) far = Math.max(far, Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]));
    }
    this.focus = [u[0], u[1], u[2]];
    this.zoom = this.clampZoom(zoom ?? (far > 1e-6 ? Math.max(1.3, Math.min(4, 0.8 / far)) : 2));
  }

  private resetView(zoom?: number): void {
    this.focus = [0, 0, 0];
    this.zoom = this.clampZoom(zoom ?? 1);
  }

  /**
   * A node outside the lens: shift the focus toward it, just far enough to
   * bring it inside (keeping the zoom), so the rest of the view stays put.
   */
  private revealNode(id: string): void {
    const u = this.unit.get(id);
    if (!u) return;
    const dx = u[0] - this.focus[0], dy = u[1] - this.focus[1], dz = u[2] - this.focus[2];
    const d = Math.hypot(dx, dy, dz);
    if (d * this.zoom <= 1.0 || d < 1e-9) return;
    const keep = 0.8 / this.zoom / d;
    this.focus = [u[0] - dx * keep, u[1] - dy * keep, u[2] - dz * keep];
  }

  private isCulled(u: Vec3): boolean {
    return Math.hypot(u[0] - this.focus[0], u[1] - this.focus[1], u[2] - this.focus[2]) * this.zoom > 1.0;
  }

  private groupIndexOf(group: string): number {
    const i = this.groupOrder.indexOf(group);
    return i < 0 ? 0 : i;
  }

  /** A node's mesh look: its own fields, then its group's, then the group-index defaults. */
  private nodeLook(n: GNode): { primitive: string; material: string; color: string } {
    const gi = this.groupIndexOf(n.group);
    const g = this.groups.get(n.group);
    return {
      primitive: n.shape ?? g?.shape ?? GROUP_SHAPES[gi % GROUP_SHAPES.length],
      material: n.material ?? g?.material ?? GROUP_MATERIALS[gi % GROUP_MATERIALS.length],
      color: n.color ?? g?.color ?? GROUP_COLORS[gi % GROUP_COLORS.length],
    };
  }

  /** Resolve a $token to the current theme's hex (for 2D paint). */
  private themeColor(c: string): string {
    if (!c.startsWith('$')) return c;
    const v = (this.theme as unknown as Record<string, unknown>)[c.slice(1)];
    return typeof v === 'string' ? v : this.theme.textSecondary;
  }

  // ── Scene ids ─────────────────────────────────────────────────────────

  private sid(part: string): string {
    return `${this.prefix}:${part}`;
  }

  // ── 2D paint + geometry sync ──────────────────────────────────────────

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const w = this._renderRect.width;
    const h = this._renderRect.height;
    this.lastOrigin = { ox, oy, w, h };
    void this.syncGeometry();
    return this.paint2D(surfaceId, ox, oy, w, h);
  }

  private paint2D(surfaceId: string, ox: number, oy: number, w: number, h: number): unknown[] {
    if (w <= 0 || h <= 0) return [];
    const t: ThemeData = this.theme;
    const { body, display } = fontStacks(t);
    const cmds: Array<{ type: string; surfaceId: string; params: Record<string, unknown> }> = [];
    const c = (type: string, params: Record<string, unknown>) => cmds.push({ type, surfaceId, params });
    c('rect', { x: ox, y: oy, width: w, height: h, fill: t.canvasBg });
    cmds.push(...inkFrame(surfaceId, { x: ox, y: oy, width: w, height: h }, t.divider, 1));
    if (this.title) {
      c('text', { x: ox + 12, y: oy + 18, text: `◉  ${chromeCase(t, this.title)}`, fill: t.textSecondary, font: `bold 11px ${display}`, baseline: 'alphabetic' });
      c('line', { x1: ox + 12, y1: oy + 24, x2: ox + 52, y2: oy + 24, stroke: t.accent, lineWidth: 2 });
    }
    if (this.nodes.size === 0) {
      c('text', {
        x: ox + w / 2, y: oy + h / 2, align: 'center', text: chromeCase(t, this.emptyText),
        fill: t.textSecondary, font: `bold 12px ${display}`, baseline: 'middle',
      });
      return cmds;
    }
    // Legend: groups that carry a label (or several named groups), top right;
    // only groups with nodes on the map now (declared looks may wait unused).
    const inUse = new Set([...this.nodes.values()].map((n) => n.group));
    const named = this.groupOrder.filter((g) => inUse.has(g) && (this.groups.get(g)?.label || (g !== '' && this.groupOrder.length > 1)));
    let ly = oy + 16;
    for (const gid of named.slice(0, 7)) {
      if (ly > oy + h - 30) break;
      const gi = this.groupIndexOf(gid);
      const col = this.themeColor(this.groups.get(gid)?.color ?? GROUP_COLORS[gi % GROUP_COLORS.length]);
      const label = chromeCase(t, this.groups.get(gid)?.label ?? gid);
      c('text', { x: ox + w - 24, y: ly + 4, text: label, align: 'right', fill: t.textSecondary, font: `10px ${display}`, baseline: 'alphabetic' });
      c('rect', { x: ox + w - 18, y: ly - 4, width: 8, height: 8, fill: col });
      ly += 15;
    }
    if (this.showHint && w >= 280 && h >= 160) {
      c('text', {
        x: ox + 12, y: oy + h - 10,
        text: chromeCase(t, this.hintText ?? 'Drag to turn · wheel to zoom · double-click to focus'),
        fill: t.textTertiary, font: `9px ${body}`, baseline: 'alphabetic',
      });
    }
    return cmds;
  }

  /**
   * Keep the scene scaffold in step with where the widget sits in its
   * window. Runs after renders (layout moves, window resizes); one request
   * chain at a time, re-checking when renders arrived meanwhile.
   */
  private async syncGeometry(): Promise<void> {
    if (this.geomBusy) { this.geomDirty = true; return; }
    this.geomBusy = true;
    try {
      do {
        this.geomDirty = false;
        const o = this.lastOrigin;
        if (!o || this.disposed) break;
        if (!this.visible || o.w < MIN_WIDGET_PX || o.h < MIN_WIDGET_PX) {
          this.teardownScene();
          continue;
        }
        const win = await this.request<Rect>(request(this.id, this.ownerId, 'getRect', {})).catch(() => null);
        if (!win || this.disposed) break;
        const g = this.computeGeometry(o, win);
        if (!this.built) {
          this.built = true;
          this.geom = g;
          this.pushOps(this.scaffoldOps(g));
          this.reconcile();
        } else if (this.geom && this.geometryChanged(this.geom, g)) {
          const resized = Math.abs(this.geom.R - g.R) > 0.5;
          this.geom = g;
          // The scaffold follows at once (a few ops); the nodes follow a new
          // lens size once the resize pauses, not on every step of the drag.
          this.pushOps(this.scaffoldUpdateOps(g));
          if (resized) {
            this.cancelTimer(this.resizeTimer);
            this.resizeTimer = this.setTimer(() => { this.resizeTimer = undefined; this.reconcile(); }, 180);
          }
        }
      } while (this.geomDirty);
    } finally {
      this.geomBusy = false;
    }
  }

  private computeGeometry(o: { ox: number; oy: number; w: number; h: number }, win: Rect): Geometry {
    const top = this.title ? 26 : 8;
    const bottom = this.showHint && o.w >= 280 && o.h >= 160 ? 18 : 8;
    const cx = o.ox + o.w / 2 - win.width / 2;
    const cy = o.oy + o.h / 2 - win.height / 2;
    const ax = cx;
    const ay = cy + (top - bottom) / 2;
    // Room for node bodies and the labels hanging under them.
    const halfW = Math.max(10, o.w / 2 - 22);
    const halfH = Math.max(10, (o.h - top - bottom) / 2 - 18);
    const R = Math.max(24, Math.min(GraphWidget.lensRadius(halfW, ax), GraphWidget.lensRadius(halfH, ay)));
    return { ax, ay, cx, cy, w: o.w, h: o.h, R };
  }

  /**
   * The largest sphere radius whose projection stays within `half` px of the
   * lens centre on one axis. A point at angle t on the sphere sits at lateral
   * u = R sin t and depth z = R cos t; seen from the window camera (distance
   * D, over the window centre) it lands (u D + offset z) / (D - z) px from
   * the centre's own image: the near side is magnified and pushed away from
   * the window centre when the widget is off-centre.
   */
  private static lensRadius(half: number, offset: number): number {
    const D = CAMERA_DISTANCE_EST;
    const a = Math.abs(offset);
    let lo = 0, hi = Math.max(1, half);
    for (let it = 0; it < 24; it++) {
      const R = (lo + hi) / 2;
      let worst = 0;
      for (let k = 0; k <= 48; k++) {
        const t = (k / 48) * Math.PI;
        const u = R * Math.sin(t), z = R * Math.cos(t);
        worst = Math.max(worst, (u * D + a * z) / (D - z), (u * D - a * z) / (D - z));
      }
      if (worst <= half) lo = R; else hi = R;
    }
    return lo;
  }

  private geometryChanged(a: Geometry, b: Geometry): boolean {
    return Math.abs(a.ax - b.ax) > 0.5 || Math.abs(a.ay - b.ay) > 0.5 || Math.abs(a.R - b.R) > 0.5
      || Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5 || Math.abs(a.cx - b.cx) > 0.5 || Math.abs(a.cy - b.cy) > 0.5;
  }

  private padDistance(g: Geometry): number {
    return Math.max(100, g.R);
  }

  /** The hit plane behind the graph: the widget rect, seen through the window camera. */
  private hitPlane(g: Geometry): { position: Vec3; scale: Vec3 } {
    const D = CAMERA_DISTANCE_EST;
    const L = this.padDistance(g);
    const zb = g.R + 14;
    const k = (D + zb) / D;
    return {
      position: [g.cx * k - g.ax, g.cy * k - g.ay, -zb - L],
      scale: [Math.max(1, (g.w - 4) * k), Math.max(1, (g.h - 4) * k), 1],
    };
  }

  private lensPoints(R: number): number[][] {
    const pts: number[][] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      pts.push([Math.cos(a) * R, Math.sin(a) * R, 0]);
    }
    return pts;
  }

  /** The pad drags in the plane L in front of the anchor, up to about 67 degrees of turn. */
  private padDraggable(g: Geometry): Record<string, unknown> {
    const L = this.padDistance(g);
    const B = L * 2.4;
    return { plane: 'xy', inertia: true, bounds: { min: [g.ax - B, g.ay - B, L], max: [g.ax + B, g.ay + B, L] } };
  }

  /**
   * The scaffold, three roots in window space: the lens ring (still), the
   * pad the user drags (with the hit plane hanging behind the graph), and
   * the graph's anchor, which turns to face the pad (lookAt) and carries
   * the resting orientation and the content (zoom and focus) below it.
   * Node parts sit directly in the content group: a shallow tree keeps the
   * per-frame matrix and parameter walks short.
   */
  private scaffoldOps(g: Geometry): SceneOp[] {
    const L = this.padDistance(g);
    const hit = this.hitPlane(g);
    return [
      {
        op: 'add', id: this.sid('lens'), kind: 'line', transform: { position: [g.ax, g.ay, 0] },
        params: { points: this.lensPoints(g.R), closed: true, width: 1, color: '$windowBorder', opacity: 0.3 },
      },
      {
        op: 'add', id: this.sid('pad'), kind: 'group',
        transform: { position: [g.ax, g.ay, L] },
        params: { draggable: this.padDraggable(g), cursor: 'grab' },
      },
      {
        op: 'add', id: this.sid('hit'), parentId: this.sid('pad'), kind: 'mesh',
        transform: { position: hit.position, scale: hit.scale },
        params: { primitive: 'plane', color: '$canvasBg', opacity: 0, shading: 'unlit', castShadow: false, receiveShadow: false },
      },
      {
        op: 'add', id: this.sid('a'), kind: 'group', transform: { position: [g.ax, g.ay, 0] },
        params: { lookAt: { node: this.sid('pad') } },
      },
      {
        op: 'add', id: this.sid('orient'), parentId: this.sid('a'), kind: 'group',
        transform: { rotation: [...this.orient] }, params: {},
      },
      {
        op: 'add', id: this.sid('c'), parentId: this.sid('orient'), kind: 'group',
        transform: { position: [0, 0, 0], scale: 1 }, params: {},
      },
    ];
  }

  private scaffoldUpdateOps(g: Geometry): SceneOp[] {
    const L = this.padDistance(g);
    const hit = this.hitPlane(g);
    return [
      { op: 'update', id: this.sid('lens'), transform: { position: [g.ax, g.ay, 0] }, params: { points: this.lensPoints(g.R) } },
      { op: 'update', id: this.sid('pad'), transform: { position: [g.ax, g.ay, L] }, params: { draggable: this.padDraggable(g) } },
      { op: 'update', id: this.sid('hit'), transform: { position: hit.position, scale: hit.scale } },
      { op: 'update', id: this.sid('a'), transform: { position: [g.ax, g.ay, 0] } },
    ];
  }

  private teardownScene(): void {
    if (!this.built) return;
    this.built = false;
    this.geom = undefined;
    this.shownNodes.clear();
    this.shownEdges.clear();
    this.shownView = undefined;
    this.batchLines = 0;
    this.batchSig = '';
    this.cancelTimer(this.batchTimer);
    this.batchTimer = undefined;
    this.revealNext = true;
    this.pendingPulses = [];
    this.pushOps([
      { op: 'remove', id: this.sid('a') },
      { op: 'remove', id: this.sid('pad') },
      { op: 'remove', id: this.sid('lens') },
    ]);
  }

  // ── Scene op queue (one request chain in flight, order kept) ──────────

  private pushOps(ops: SceneOp[]): void {
    if (ops.length === 0 || this.disposed) return;
    this.opQueue.push(...ops);
    void this.flushOps();
  }

  private async flushOps(): Promise<void> {
    if (this.opsInFlight) return;
    this.opsInFlight = true;
    try {
      while (this.opQueue.length > 0 && !this.disposed) {
        const batch = this.opQueue.splice(0, this.opQueue.length);
        try {
          await this.request(request(this.id, this.ownerId, 'scene', { ops: batch }));
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          // The window may be gone (teardown); anything else is a bug worth seeing.
          if (!/no surface|not found|stopped|WORKER_DEAD|recipient/i.test(m)) {
            this.logError('graph scene batch rejected', m.slice(0, 400));
          }
        }
      }
    } finally {
      this.opsInFlight = false;
    }
  }

  // ── Reconcile: model + view → minimal scene ops ───────────────────────

  /** Node ids that show a label now. */
  /** A node's label text (long names are cut). */
  private labelText(n: GNode): string {
    return n.label.length > 32 ? `${n.label.slice(0, 31)}\u2026` : n.label;
  }

  /**
   * Node ids that show a label now. The hovered node always does (drawn
   * over the rest); the selection, then highlighted nodes, the selection's
   * neighbours and the largest, best connected nodes follow, each only
   * where its label would not overlap one already placed (judged in the
   * resting orientation, as seen from the front).
   */
  /** Where each shown label sits around its node (under it unless that spot was taken). */
  private labelPlacement = new Map<string, 'below' | 'above' | 'right' | 'left'>();

  private labelSet(culled: (id: string) => boolean): Set<string> {
    const out = new Set<string>();
    this.labelPlacement.clear();
    const usable = (id: string | undefined): id is string =>
      !!id && this.nodes.has(id) && this.unit.has(id) && !culled(id);
    if (usable(this.hoveredId)) out.add(this.hoveredId);
    const R = this.geom?.R ?? 150;
    const zoom = this.zoom;
    // Every visible node as seen from the front (resting orientation): a
    // label may cover neither another label nor another node.
    const seen = new Map<string, { x: number; y: number; r: number }>();
    for (const n of this.nodes.values()) {
      if (!usable(n.id)) continue;
      const u = this.unit.get(n.id)!;
      const v = rotateByEuler(this.orient, [
        (u[0] - this.focus[0]) * zoom * R, (u[1] - this.focus[1]) * zoom * R, (u[2] - this.focus[2]) * zoom * R,
      ]);
      seen.set(n.id, { x: v[0], y: v[1], r: n.size * zoom });
    }
    const boxes: Array<[number, number, number, number]> = [];
    // The widget's own rect, relative to the lens centre: a label stays inside it.
    const g = this.geom;
    const bounds = g
      ? [g.cx - g.w / 2 - g.ax + 4, g.cy - g.h / 2 - g.ay + 4, g.cx + g.w / 2 - g.ax - 4, g.cy + g.h / 2 - g.ay - 4]
      : undefined;
    const hits = (box: [number, number, number, number], own: string) => {
      if (bounds && (box[0] < bounds[0] || box[1] < bounds[1] || box[2] > bounds[2] || box[3] > bounds[3])) return true;
      if (boxes.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) return true;
      for (const [id, d] of seen) {
        if (id === own) continue;
        if (d.x + d.r > box[0] && d.x - d.r < box[2] && d.y + d.r > box[1] && d.y - d.r < box[3]) return true;
      }
      return false;
    };
    const place = (id: string | undefined, force: boolean): boolean => {
      if (!usable(id) || (out.has(id) && id !== this.hoveredId)) return false;
      const n = this.nodes.get(id)!;
      const p = seen.get(id)!;
      const w = this.labelText(n).length * 6.2 + 10;
      const r = p.r + 3;
      const spots: Array<['below' | 'above' | 'right' | 'left', [number, number, number, number]]> = [
        ['below', [p.x - w / 2, p.y + r, p.x + w / 2, p.y + r + 20]],
        ['above', [p.x - w / 2, p.y - r - 20, p.x + w / 2, p.y - r]],
        ['right', [p.x + r, p.y - 10, p.x + r + w, p.y + 10]],
        ['left', [p.x - r - w, p.y - 10, p.x - r, p.y + 10]],
      ];
      const free = spots.find(([, box]) => !hits(box, id));
      if (!free && !force) return false;
      const [spot, box] = free ?? spots[0];
      this.labelPlacement.set(id, spot);
      boxes.push(box);
      out.add(id);
      return true;
    };
    place(this.selectedId, true);
    if (this.labelMode === 'none') return out;
    const visible = [...this.nodes.values()].filter((n) => usable(n.id));
    if (this.labelMode === 'all') {
      for (const n of visible.slice(0, 80)) place(n.id, true);
      return out;
    }
    for (const id of this.highlighted) place(id, false);
    if (this.selectedId) {
      let k = 0;
      for (const e of this.edges.values()) {
        if (k >= 10) break;
        const other = e.from === this.selectedId ? e.to : e.to === this.selectedId ? e.from : undefined;
        if (other && place(other, false)) k++;
      }
    }
    const K = visible.length <= 12 ? visible.length : Math.max(3, Math.min(16, Math.round((R * R) / 3000)));
    // The largest nodes, then the best connected, carry the map's names.
    const degree = new Map<string, number>();
    for (const e of this.edges.values()) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    let placed = 0;
    for (const n of visible
      .filter((nd) => !nd.ghost || visible.length <= 12)
      .sort((a, b) => (b.size - a.size) || ((degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)) || a.id.localeCompare(b.id))) {
      if (placed >= K) break;
      if (place(n.id, false)) placed++;
    }
    return out;
  }

  /**
   * Diff the desired scene (model, layout, view, selection, hover,
   * highlight) against what was last sent and queue the ops. Synchronous;
   * nothing is sent until the scaffold exists.
   */
  private reconcile(): void {
    if (!this.built || !this.geom || this.disposed) return;
    this.ensureUnitSpread();
    const g = this.geom;
    const R = g.R;
    const zoom = this.zoom;
    const ops: SceneOp[] = [];
    const reveal = this.revealNext;
    this.revealNext = false;
    let moved = false;

    // View: the content group shifts the focus to the lens centre and scales by zoom.
    const viewPos = round3([-this.focus[0] * R * zoom, -this.focus[1] * R * zoom, -this.focus[2] * R * zoom]);
    if (!this.shownView || !sameVec(this.shownView.pos, viewPos, 0.05) || Math.abs(this.shownView.zoom - zoom) > 1e-4) {
      ops.push(
        { op: 'animate', id: this.sid('c'), params: { channel: 'position', to: viewPos, spring: VIEW_SPRING } },
        { op: 'animate', id: this.sid('c'), params: { channel: 'scale', to: [zoom, zoom, zoom], spring: VIEW_SPRING } },
      );
      this.shownView = { pos: viewPos, zoom };
    }

    const target = new Map<string, Vec3>();
    for (const n of this.nodes.values()) {
      const u = this.unit.get(n.id);
      if (u) target.set(n.id, round3([u[0] * R, u[1] * R, u[2] * R]));
    }
    const culledIds = new Set<string>();
    for (const [id] of target) if (this.isCulled(this.unit.get(id)!)) culledIds.add(id);
    const culled = (id: string) => culledIds.has(id);
    const labels = this.labelSet(culled);
    const spotlight = this.highlighted.size > 0;

    // Positions before this pass (new nodes start where they land).
    const before = new Map<string, Vec3>();
    for (const [id, s] of this.shownNodes) before.set(id, s.pos);

    // Removed nodes: the mesh and whatever wears it (edges leave with the model's edges).
    for (const [id, s] of this.shownNodes) {
      if (target.has(id)) continue;
      ops.push({ op: 'remove', id: this.sid(`m${s.key}`) });
      if (s.label !== undefined) ops.push({ op: 'remove', id: this.sid(`l${s.key}`) });
      if (s.ring !== undefined) ops.push({ op: 'remove', id: this.sid(`r${s.key}`) });
      if (s.halo) ops.push({ op: 'remove', id: this.sid(`h${s.key}`) });
      this.shownNodes.delete(id);
    }

    // Stagger for the first reveal: centre first.
    const order = [...target.keys()].sort((a, b) => vlen(target.get(a)!) - vlen(target.get(b)!));
    const rank = new Map(order.map((id, i) => [id, i]));

    for (const [id, pos] of target) {
      const n = this.nodes.get(id)!;
      const key = n.key;
      const look = this.nodeLook(n);
      const isCulled = culled(id);
      const hovered = this.hoveredId === id;
      const selected = this.selectedId === id;
      const lit = this.highlighted.has(id);
      const dim = spotlight && !lit && !selected;
      const meshParams: Record<string, unknown> = {
        primitive: look.primitive,
        ...(look.primitive === 'roundedBox' ? { shape: { radius: 0.3 } } : {}),
        material: look.material,
        color: look.color,
        opacity: n.ghost ? 0.4 : dim ? 0.22 : 1,
        emissive: n.active ? '$accentSecondary' : '#000000',
        interactive: true,
        cursor: 'pointer',
      };
      const meshSig = JSON.stringify(meshParams);
      const meshScale = isCulled ? 0.001 : Math.round(n.size * 2 * (SHAPE_SCALE[look.primitive] ?? 1) * (hovered ? 1.3 : 1) * 100) / 100;
      let shown = this.shownNodes.get(id);

      if (!shown) {
        const delay = reveal ? Math.min(420, (rank.get(id) ?? 0) * 12) : 0;
        ops.push(
          { op: 'add', id: this.sid(`m${key}`), parentId: this.sid('c'), kind: 'mesh', transform: { position: pos, scale: 0.001 }, params: meshParams },
          { op: 'animate', id: this.sid(`m${key}`), params: { channel: 'scale', to: [meshScale, meshScale, meshScale], spring: SPRING, ...(delay ? { delay } : {}) } },
        );
        shown = { key, pos, meshSig, meshScale, culled: isCulled, halo: false };
        this.shownNodes.set(id, shown);
      } else {
        if (!sameVec(shown.pos, pos, 0.25)) {
          // Everything a node wears moves on the same spring, so it stays together.
          const move = (part: string) => ops.push({ op: 'animate', id: this.sid(`${part}${key}`), params: { channel: 'position', to: pos, spring: SPRING } });
          move('m');
          if (shown.label !== undefined && labels.has(id)) move('l');
          if (shown.ring !== undefined) move('r');
          if (shown.halo) move('h');
          shown.pos = pos;
          moved = true;
        }
        if (shown.meshSig !== meshSig) {
          ops.push({ op: 'update', id: this.sid(`m${key}`), params: meshParams });
          shown.meshSig = meshSig;
        }
        if (Math.abs(shown.meshScale - meshScale) > 1e-3) {
          ops.push({ op: 'animate', id: this.sid(`m${key}`), params: { channel: 'scale', to: [meshScale, meshScale, meshScale], spring: SPRING } });
          shown.meshScale = meshScale;
        }
        shown.culled = isCulled;
      }

      // Label: under the node, the content group's zoom undone by its own scale.
      const wantLabel = labels.has(id);
      if (wantLabel) {
        const text = this.labelText(n);
        const color = selected ? '$accent' : lit ? this.highlightColor : n.ghost ? '$textSecondary' : '$textPrimary';
        // Offset from the node's centre to the side its label won (fractions of the label's size).
        const rpx = n.size * zoom * (hovered ? 1.3 : 1) + 4;
        const wEst = text.length * 6.2 + 10;
        const spot = this.labelPlacement.get(id) ?? 'below';
        const round2 = (v: number) => Math.round(v * 100) / 100;
        const anchor = spot === 'above' ? [0.5, round2(1 + rpx / 19)]
          : spot === 'right' ? [round2(-rpx / wEst), 0.5]
            : spot === 'left' ? [round2(1 + rpx / wEst), 0.5]
              : [0.5, round2(-rpx / 19)];
        // World-sized (not screen-sized): labels keep their size relative to
        // the window, so a phone camera showing the window small shows them
        // small too; the content zoom is undone by the label's own scale.
        const lp = { text, size: 11, color, background: '$windowBg', padding: 3, anchor, opacity: 0.94, screenSpace: false };
        const lsig = JSON.stringify([lp, zoom]);
        if (shown.label === undefined) {
          ops.push({ op: 'add', id: this.sid(`l${key}`), parentId: this.sid('c'), kind: 'label', transform: { position: shown.pos, scale: 1 / zoom }, params: lp });
        } else if (shown.label !== lsig) {
          ops.push({ op: 'update', id: this.sid(`l${key}`), transform: { scale: 1 / zoom }, params: lp });
        }
        shown.label = lsig;
      } else if (shown.label !== undefined) {
        ops.push({ op: 'remove', id: this.sid(`l${key}`) });
        shown.label = undefined;
      }

      // Living light: a breathing halo while active (the only loop the graph runs).
      const wantHalo = n.active && !isCulled;
      if (wantHalo && !shown.halo) {
        ops.push(
          {
            op: 'add', id: this.sid(`h${key}`), parentId: this.sid('c'), kind: 'mesh',
            transform: { position: shown.pos, scale: n.size * 3.2 },
            params: { primitive: 'ring', billboard: true, material: 'sigil', opacity: 0.8, castShadow: false },
          },
          { op: 'animate', id: this.sid(`h${key}`), params: { preset: 'pulse', scale: 1.25, duration: 1600 } },
        );
        shown.halo = true;
      } else if (!wantHalo && shown.halo) {
        ops.push({ op: 'remove', id: this.sid(`h${key}`) });
        shown.halo = false;
      }

      // Ring: the selection (accent) or a highlight (its colour).
      const ringColor = isCulled ? undefined : selected ? '$accent' : lit ? this.highlightColor : undefined;
      const ringScale = Math.round(n.size * (selected ? 3.0 : 2.7) * 100) / 100;
      const ringSig = ringColor ? `${ringColor}|${ringScale}` : undefined;
      if (ringSig !== shown.ring) {
        if (shown.ring !== undefined) ops.push({ op: 'remove', id: this.sid(`r${key}`) });
        if (ringColor) {
          ops.push(
            {
              op: 'add', id: this.sid(`r${key}`), parentId: this.sid('c'), kind: 'mesh',
              transform: { position: shown.pos, scale: 0.001 },
              params: { primitive: 'ring', billboard: true, color: ringColor, emissive: ringColor, shading: 'unlit', castShadow: false },
            },
            { op: 'animate', id: this.sid(`r${key}`), params: { channel: 'scale', to: [ringScale, ringScale, ringScale], spring: { stiffness: 260, damping: 18 } } },
          );
        }
        shown.ring = ringSig;
      }
    }

    this.reconcileEdges(ops, target, before, culled, reveal, moved);
    this.pushOps(ops);
    this.flushPendingPulses();
  }

  /** Style of one edge given the selection, hover and spotlight. */
  private edgeStyle(e: GEdge, visible: boolean): { params: Record<string, unknown>; opacity: number } {
    const sel = this.selectedId;
    const hov = this.hoveredId;
    const spotlight = this.highlighted.size > 0;
    const w = Math.max(1.2, Math.min(6, 1.3 + 1.1 * Math.sqrt(e.weight)));
    let color = e.color ?? EDGE_COLOR;
    let width = w;
    let opacity = e.dashed ? EDGE_OPACITY * 0.7 : EDGE_OPACITY;
    if (sel && (e.from === sel || e.to === sel)) {
      color = !this.directed || e.from === sel ? '$accent' : '$accentSecondary';
      width = w + 1;
      opacity = 1;
    } else if (hov && (e.from === hov || e.to === hov)) {
      color = e.color ?? '$textPrimary';
      opacity = 0.9;
    } else if (spotlight) {
      const both = this.highlighted.has(e.from) && this.highlighted.has(e.to);
      if (both) { color = this.highlightColor; opacity = 0.95; width = w + 0.5; } else opacity = 0.12;
    }
    const params: Record<string, unknown> = {
      color, width: Math.round(width * 10) / 10,
      ...(this.directed ? { widths: [0.3, 1] } : {}),
      ...(e.dashed ? { dashed: { dash: 5, gap: 4 } } : {}),
    };
    return { params, opacity: visible ? opacity : 0 };
  }

  private reconcileEdges(
    ops: SceneOp[],
    target: Map<string, Vec3>,
    before: Map<string, Vec3>,
    culled: (id: string) => boolean,
    reveal: boolean,
    moved: boolean,
  ): void {
    const batched = this.edges.size > LIVE_EDGE_LIMIT;
    // Live edges: every edge, or (batched) only the emphasized ones.
    const live = new Map<string, GEdge>();
    for (const e of this.edges.values()) {
      if (!target.has(e.from) || !target.has(e.to) || e.from === e.to) continue;
      if (!batched) { live.set(e.id, e); continue; }
      const emphasized = (this.selectedId && (e.from === this.selectedId || e.to === this.selectedId))
        || (this.hoveredId && (e.from === this.hoveredId || e.to === this.hoveredId))
        || (this.highlighted.has(e.from) && this.highlighted.has(e.to));
      if (emphasized && live.size < 240) live.set(e.id, e);
    }

    for (const [eid, es] of this.shownEdges) {
      const e = this.edges.get(eid);
      if (e && live.has(eid) && e.from === es.src && e.key === es.key) continue;
      ops.push({ op: 'remove', id: this.sid(`e${es.key}`) });
      this.shownEdges.delete(eid);
    }

    for (const e of live.values()) {
      const pf = target.get(e.from)!, pt = target.get(e.to)!;
      const d = safeVec(round3([pt[0] - pf[0], pt[1] - pf[1], pt[2] - pf[2]]));
      const visible = !culled(e.from) && !culled(e.to);
      const style = this.edgeStyle(e, visible);
      const styleSig = JSON.stringify(style.params);
      const shown = this.shownEdges.get(e.id);
      if (!shown) {
        // Start where the endpoints were, so the edge's start rides its
        // source and its end rides its target on one shared spring.
        const bf = before.get(e.from) ?? pf, bt = before.get(e.to) ?? pt;
        const d0 = safeVec(round3([bt[0] - bf[0], bt[1] - bf[1], bt[2] - bf[2]]));
        ops.push({
          op: 'add', id: this.sid(`e${e.key}`), parentId: this.sid('c'), kind: 'line',
          transform: { position: bf, scale: d0 },
          params: { points: [[0, 0, 0], [1, 1, 1]], opacity: 0, ...style.params },
        });
        if (!sameVec(bf, pf, 0.05)) ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'position', to: pf, spring: SPRING } });
        if (!sameVec(d0, d, 0.05)) ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'scale', to: d, spring: SPRING } });
        if (style.opacity > 0) {
          ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'opacity', from: 0, to: style.opacity, duration: 320, ...(reveal ? { delay: 260 } : {}) } });
        }
        this.shownEdges.set(e.id, { key: e.key, src: e.from, p: pf, d, styleSig, opacity: style.opacity });
        continue;
      }
      if (!sameVec(shown.p, pf, 0.05)) {
        ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'position', to: pf, spring: SPRING } });
        shown.p = pf;
      }
      if (!sameVec(shown.d, d, 0.05)) {
        ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'scale', to: d, spring: SPRING } });
        shown.d = d;
      }
      if (shown.styleSig !== styleSig) {
        ops.push({ op: 'update', id: this.sid(`e${e.key}`), params: style.params });
        shown.styleSig = styleSig;
      }
      if (Math.abs(shown.opacity - style.opacity) > 1e-3) {
        ops.push({ op: 'animate', id: this.sid(`e${e.key}`), params: { channel: 'opacity', to: style.opacity, duration: 180 } });
        shown.opacity = style.opacity;
      }
    }

    this.reconcileBatch(ops, target, culled, batched, moved);
  }

  /**
   * Batched edges (graphs above LIVE_EDGE_LIMIT edges): one line per
   * BATCH_EDGES_PER_LINE edges in content space, each edge two points with
   * zero-width joins between edges. A batched line cannot follow node
   * springs, so when positions change it fades out and comes back once the
   * nodes have settled.
   */
  private reconcileBatch(ops: SceneOp[], target: Map<string, Vec3>, culled: (id: string) => boolean, batched: boolean, nodesMoved: boolean): void {
    const edges = batched
      ? [...this.edges.values()].filter((e) => target.has(e.from) && target.has(e.to) && e.from !== e.to && !culled(e.from) && !culled(e.to))
      : [];
    const lines: Array<{ points: number[][]; widths: number[] }> = [];
    for (let i = 0; i < edges.length; i += BATCH_EDGES_PER_LINE) {
      const points: number[][] = [];
      const widths: number[] = [];
      for (const e of edges.slice(i, i + BATCH_EDGES_PER_LINE)) {
        const a = target.get(e.from)!, b = target.get(e.to)!;
        const w = Math.max(0.6, Math.min(3, 0.6 + 0.4 * Math.sqrt(e.weight)));
        if (points.length > 0) { points.push(a); widths.push(0); }
        points.push(a, b);
        widths.push(this.directed ? w * 0.3 : w, w);
        points.push(b); widths.push(0);
      }
      if (points.length >= 2) lines.push({ points, widths });
    }
    const opacity = this.highlighted.size > 0 ? 0.1 : 0.4;
    const sig = JSON.stringify([lines.map((l) => l.points.length), edges.map((e) => e.key), opacity]);
    const posSig = JSON.stringify(lines.map((l) => l.points));
    if (sig === this.batchSig && posSig === this.batchPosSig) return;
    const moved = nodesMoved && this.batchPosSig !== '' && posSig !== this.batchPosSig;
    const apply = (): SceneOp[] => {
      const out: SceneOp[] = [];
      for (let i = 0; i < lines.length; i++) {
        const id = this.sid(`eb${i}`);
        const params = { points: lines[i].points, widths: lines[i].widths, width: 1.6, color: EDGE_COLOR, join: 'round', cap: 'round' };
        if (i < this.batchLines) out.push({ op: 'update', id, params });
        else out.push({ op: 'add', id, parentId: this.sid('c'), kind: 'line', params: { ...params, opacity: 0 } });
        out.push({ op: 'animate', id, params: { channel: 'opacity', to: opacity, duration: 260 } });
      }
      for (let i = lines.length; i < this.batchLines; i++) out.push({ op: 'remove', id: this.sid(`eb${i}`) });
      this.batchLines = lines.length;
      return out;
    };
    this.batchSig = sig;
    this.batchPosSig = posSig;
    this.cancelTimer(this.batchTimer);
    this.batchTimer = undefined;
    if (moved && this.batchLines > 0) {
      // Fade out now; redraw where the nodes come to rest.
      for (let i = 0; i < this.batchLines; i++) {
        ops.push({ op: 'animate', id: this.sid(`eb${i}`), params: { channel: 'opacity', to: 0, duration: 120 } });
      }
      this.batchTimer = this.setTimer(() => {
        this.batchTimer = undefined;
        if (this.built) this.pushOps(apply());
      }, 650);
      return;
    }
    ops.push(...apply());
  }

  private batchPosSig = '';

  // ── Input ─────────────────────────────────────────────────────────────

  private nodeIdOfScene(sceneId: string | undefined, kind: 'm'): string | undefined {
    if (!sceneId || !sceneId.startsWith(`${this.prefix}:${kind}`)) return undefined;
    return this.keyToNode.get(sceneId.slice(this.prefix.length + 1 + kind.length));
  }

  private onGraphNodeInput(p: { type?: string; nodeId?: string; position?: number[] }): void {
    const type = p.type;
    if (!type || !p.nodeId) return;
    const nodeId = this.nodeIdOfScene(p.nodeId, 'm');
    if (type === 'mouseenter' && nodeId) {
      if (this.hoveredId !== nodeId) { this.hoveredId = nodeId; this.reconcile(); }
      return;
    }
    if (type === 'mouseleave' && nodeId) {
      if (this.hoveredId === nodeId) { this.hoveredId = undefined; this.reconcile(); }
      return;
    }
    if (type === 'mousedown') {
      const now = Date.now();
      const targetKey = nodeId ?? (p.nodeId === this.sid('hit') ? '#bg' : undefined);
      if (!targetKey) return;
      const dbl = this.lastDown && this.lastDown.target === targetKey && now - this.lastDown.t <= DOUBLE_CLICK_MS;
      this.lastDown = dbl ? undefined : { target: targetKey, t: now };
      if (!nodeId) {
        if (dbl) { this.resetView(); this.reconcile(); }
        return;
      }
      if (dbl) {
        this.selectedId = nodeId;
        this.focusOn(nodeId);
        this.reconcile();
        this.changed('nodeFocused', JSON.stringify({ id: nodeId, via: 'dblclick' }));
        return;
      }
      this.selectedId = nodeId;
      this.reconcile();
      const n = this.nodes.get(nodeId)!;
      this.changed('nodeSelected', JSON.stringify({ id: n.id, label: n.label, group: n.group, data: n.data ?? null, via: 'click' }));
      return;
    }
    if (type === 'dragEnd' && p.nodeId === this.sid('pad') && Array.isArray(p.position) && p.position.length === 3 && this.geom) {
      // Fold the turn into the resting orientation and put the pad back:
      // one batch, so the client shows the same pose before and after.
      const g = this.geom;
      this.orient = bakeTurn([p.position[0] - g.ax, p.position[1] - g.ay, p.position[2]], this.orient);
      const L = this.padDistance(g);
      this.pushOps([
        { op: 'update', id: this.sid('orient'), transform: { rotation: [...this.orient] } },
        { op: 'update', id: this.sid('pad'), transform: { position: [g.ax, g.ay, L] } },
      ]);
      // Labels are decluttered as seen from the front: re-place them.
      this.reconcile();
    }
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const type = input.type as string;
    if (type === 'wheel') {
      const dy = typeof input.deltaY === 'number' ? input.deltaY : 0;
      if (dy !== 0) {
        const next = this.clampZoom(this.zoom * Math.exp(-dy * 0.0015));
        if (Math.abs(next - this.zoom) > 1e-4) {
          this.zoom = next;
          this.scheduleWheelReconcile();
        }
      }
      return { consumed: true };
    }
    if (type === 'mousedown') return { consumed: true, focusWidgetId: this.id };
    if (type === 'mousemove' || type === 'mouseup') return { consumed: true };
    return { consumed: false };
  }

  private wheelTimer?: ReturnType<typeof setTimeout>;

  /** Wheel bursts: at most one view update every 60 ms (the spring bends to the latest). */
  private scheduleWheelReconcile(): void {
    if (this.wheelTimer) return;
    this.reconcile();
    this.wheelTimer = this.setTimer(() => {
      this.wheelTimer = undefined;
      this.reconcile();
    }, 60);
  }

  // ── Pulse ─────────────────────────────────────────────────────────────

  /** Pulses asked for before their nodes were placed (a layout in flight), played once they are. */
  private pendingPulses: Array<{ from: string; to: string; color: string; count: number; until: number }> = [];

  private flushPendingPulses(): void {
    if (this.pendingPulses.length === 0) return;
    const now = Date.now();
    const waiting = this.pendingPulses;
    this.pendingPulses = [];
    for (const p of waiting) {
      if (p.until < now || !this.nodes.has(p.from) || !this.nodes.has(p.to)) continue;
      if (!this.shownNodes.has(p.from) || !this.shownNodes.has(p.to)) this.pendingPulses.push(p);
      else this.pulse(p.from, p.to, p.color, p.count, 260);
    }
  }

  private pulse(from: string, to: string, color: string, count: number, lead = 0): boolean {
    const a = this.shownNodes.get(from), b = this.shownNodes.get(to);
    if (this.built && (!a || !b) && (this.layoutPending || this.layoutRunning || !this.unit.has(from) || !this.unit.has(to))) {
      // A node just added is still being placed: play the flow once it lands.
      this.pendingPulses.push({ from, to, color, count, until: Date.now() + 4000 });
      return true;
    }
    if (!this.built || !a || !b || a.culled || b.culled) return false;
    const dst = this.nodes.get(to)!;
    const d = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
    const travel = Math.max(650, Math.min(1300, vlen(d) * 3.5));
    const ops: SceneOp[] = [];
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.sid(`p${(this.pulseSeq++).toString(36)}`);
      ids.push(id);
      const delay = lead + i * 190;
      ops.push(
        {
          op: 'add', id, parentId: this.sid('c'), kind: 'mesh',
          transform: { position: a.pos, scale: 0.001 },
          params: {
            primitive: 'sphere', color, emissive: color, shading: 'unlit', blend: 'additive', castShadow: false,
            trail: { width: 7, color, lifetime: 420 },
          },
        },
        { op: 'animate', id, params: { channel: 'position', keyframes: [{ t: 0, value: a.pos, easing: 'easeInOut' }, { t: travel, value: b.pos }], delay } },
        { op: 'animate', id, params: { channel: 'scale', keyframes: [{ t: 0, value: 0.001 }, { t: 90, value: 12 }, { t: travel - 90, value: 12 }, { t: travel, value: 0.001 }], delay } },
      );
    }
    ops.push({ op: 'animate', id: this.sid(`m${dst.key}`), params: { preset: 'flash', color, duration: 520, delay: lead + travel } });
    this.pushOps(ops);
    this.setTimer(() => {
      if (this.built) this.pushOps(ids.map((id) => ({ op: 'remove', id })));
    }, lead + travel + (count - 1) * 190 + 700);
    return true;
  }

  // ── Widget protocol ───────────────────────────────────────────────────

  protected getWidgetValue(): string {
    return this.selectedId ?? '';
  }

  protected override suppressGenericFocusRing(): boolean {
    return true;
  }

  /**
   * No longer drawn (a hidden tab or pane, or scrolled out of view): the
   * graph's scene leaves with it. It is rebuilt when the widget draws again.
   */
  protected override onCulled(): void {
    super.onCulled();
    this.teardownScene();
  }

  protected async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    if (typeof updates.title === 'string') this.title = updates.title;
    if (typeof updates.emptyText === 'string') this.emptyText = updates.emptyText;
    if (typeof updates.directed === 'boolean') { this.directed = updates.directed; this.reconcile(); }
    if (updates.labels === 'auto' || updates.labels === 'all' || updates.labels === 'none') { this.labelMode = updates.labels; this.reconcile(); }
    if (typeof updates.hint === 'boolean') this.showHint = updates.hint;
    if (typeof updates.hint === 'string') { this.showHint = updates.hint.length > 0; this.hintText = updates.hint || undefined; }
    if (Array.isArray(updates.groups)) this.applyGroups(updates.groups as GraphGroupSpec[]);
    // update({ nodes, edges }) is setGraph; either alone keeps the other
    // (edges whose ends are gone drop out).
    if (Array.isArray(updates.nodes) || Array.isArray(updates.edges)) {
      const nodes = Array.isArray(updates.nodes)
        ? updates.nodes as GraphNodeSpec[]
        : [...this.nodes.values()].map((n) => ({ id: n.id, label: n.label, group: n.group, size: n.size, color: n.color, shape: n.shape, material: n.material, active: n.active, ghost: n.ghost, center: n.center, data: n.data }));
      const ids = new Set(nodes.map((n) => String(n.id)));
      const edges = Array.isArray(updates.edges)
        ? updates.edges as GraphEdgeSpec[]
        : [...this.edges.values()].filter((e) => ids.has(e.from) && ids.has(e.to))
          .map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label, weight: e.weight, color: e.color, style: e.dashed ? 'dashed' as const : 'solid' as const }));
      this.replaceGraph(nodes, edges);
    }
    // Hiding the widget must hide its scene too: the scene lives outside the
    // widget render pass that visibility gates.
    const styleVisible = (updates.style as { visible?: boolean } | undefined)?.visible;
    if ((updates.visible !== undefined || styleVisible !== undefined) && !this.visible) this.teardownScene();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.zoom >= MIN_ZOOM && this.zoom <= MAX_ZOOM, 'graph zoom stays within its range');
    invariant(this.selectedId === undefined || this.nodes.has(this.selectedId), 'the selection is a node of the graph');
    invariant(this.hoveredId === undefined || this.nodes.has(this.hoveredId), 'the hovered node is a node of the graph');
    for (const e of this.edges.values()) {
      invariant(this.nodes.has(e.from) && this.nodes.has(e.to), `edge ${e.id} joins two nodes of the graph`);
    }
  }
}
