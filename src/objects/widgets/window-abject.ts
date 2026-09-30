/**
 * WindowAbject — composite morph that contains child widgets.
 *
 * Owns a UIServer surface, coordinates rendering (Morphic drawOn:) and
 * routes input to children (Morphic event dispatch with bubbling).
 * All child interaction is via message passing — no direct references.
 */

import {
  AbjectId,
  AbjectMessage,
} from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require as contractRequire } from '../../core/contracts.js';
import { request, event } from '../../core/message.js';
import {
  Rect,
  ThemeData,
  DEFAULT_THEME,
  WINDOW_INTERFACE,
  TITLE_BAR_HEIGHT,
  titleFont,
  inkFrame,
} from './widget-types.js';
import { shapeOf, chromeCase } from '../../core/theme-data.js';
import { iconCommands } from '../../ui/icons.js';
import { Tween, shimmer as motionShimmer } from '../../ui/motion.js';
import {
  PopoutSurface, TOOLTIP_NODE_ID, TOOLTIP_DELAY_MS, cachedScreenSize, showTooltip,
} from './popout.js';
import { isScreenAnchor, type ScreenAnchor } from '../../ui/gl/scene-types.js';

/** The four title-bar buttons, as WindowManager names them. */
type TitleButtonKind = 'close' | 'minimize' | 'maximize' | 'help';

export interface WindowConfig {
  title: string;
  rect: Rect;
  uiServerId: AbjectId;
  chromeless?: boolean;
  transparent?: boolean;
  resizable?: boolean;
  draggable?: boolean;
  zIndex?: number;
  theme?: ThemeData;
  /** Whether the phone's Exposé view may flick this window closed (default true). */
  closable?: boolean;
  /**
   * Whether the window grabs focus when created (default true). Passive
   * popups (tooltips) must not steal focus — the focus loss would send a
   * mouseleave to the hovered widget that summoned them.
   */
  focusOnCreate?: boolean;
  /**
   * Scene ops this window wears while focused (WidgetManager's focus
   * decoration), in px from the window's top-left corner (+y down).
   */
  focusDecoration?: Array<Record<string, unknown>> | null;
  /**
   * On a zoomable camera (the phone) the window stays pinned to this spot
   * of the screen at a readable scale; the desktop at zoom 1 ignores it.
   */
  screenAnchor?: ScreenAnchor;
}

/**
 * WindowAbject — a composite morph that owns a surface and contains child widgets.
 */
/**
 * A window title as the title band draws it: pictographic emoji are dropped
 * (the band's eye sigil is the window's mark) and the rest is trimmed. The
 * title itself (getTitle, the dock, the switcher) is unchanged.
 */
function bandTitle(title: string): string {
  const stripped = title.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim();
  return stripped || title;
}

export class WindowAbject extends Abject {
  private surfaceId?: string;
  private uiServerId: AbjectId;
  private title: string;
  private rect: Rect;
  private chromeless: boolean;
  private transparent: boolean;
  private closable: boolean;
  private screenAnchor?: ScreenAnchor;
  private focusOnCreate: boolean;
  private resizable: boolean;
  private draggable: boolean;
  private maximized = false;
  private zIndex: number;
  protected override theme: ThemeData;

  /** Expose surfaceId so WidgetManager can register with WindowManager. */
  get surface(): string | undefined { return this.surfaceId; }

  private children: AbjectId[] = [];
  private childRects: Map<AbjectId, Rect> = new Map();
  private expandedSelects: Set<AbjectId> = new Set();
  private focusedChildId?: AbjectId;
  private focusedParentChildId?: AbjectId;  // the window's direct child (layout) that contains focusedChildId
  private hoveredChildId?: AbjectId;
  /** Title-bar button under the pointer (drives the Constructivist hover plate). */
  private hoveredTitleButton?: TitleButtonKind;
  /** Title-button tooltips: a pop-out under the hovered button after a dwell. */
  private chromeTip?: PopoutSurface;
  private chromeTipTimer?: ReturnType<typeof setTimeout>;

  private windowFocused = false;
  /** Scene ops worn while focused (px from the top-left corner); null = none. */
  private focusDecoration: Array<Record<string, unknown>> | null = null;
  /** Whether the focus decoration is currently in the scene. */
  private decorationShown = false;
  /** Whether the top-left origin anchor group (scene origin: 'topLeft') exists. */
  private originAnchorShown = false;
  private destroying = false;
  private rendering = false;
  private renderScheduled = false;
  /** A size change awaits relayout (latest-wins; this.rect holds the newest size). */
  private resizePending = false;
  private resizeDraining = false;
  private frameTimer?: ReturnType<typeof setTimeout>;

  // Animation state — shimmerPos cycles 0 → 1 along the accent line while
  // focused. Sampled each render and wrapped in save/restore so it never
  // bleeds into child draw commands.
  private shimmerTween?: Tween;
  private shimmerPos = 0;

  constructor(config: WindowConfig) {
    super({
      manifest: {
        name: 'Window',
        description: 'Composite window morph — owns surface, contains child widgets. The window is a slab in the desktop\'s native 3D scene: scene({ ops }) attaches retained 3D meshes/lights to it, setSlabTransform tilts/floats it.',
        version: '1.0.0',
        interface: {
            id: WINDOW_INTERFACE,
            name: 'Window',
            description: 'Window management and child widget coordination',
            methods: [
              {
                name: 'addChild',
                description: 'Add a widget as a child of this window (Morphic addMorph:)',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
                  { name: 'rect', type: { kind: 'reference', reference: 'Rect' }, description: 'Widget rect in content area' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeChild',
                description: 'Remove a widget from this window (Morphic removeMorph:)',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setTitle',
                description: 'Set window title',
                parameters: [
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getRect',
                description: 'Get window rect',
                parameters: [],
                returns: { kind: 'reference', reference: 'Rect' },
              },
              {
                name: 'getTitle',
                description: 'Get window title',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroy',
                description: 'Destroy this window and all children',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'focusChild',
                description: 'Programmatically focus a child widget. Unfocuses any current child first. via=keyboard surfaces the focus ring; via=mouse (default) does not.',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId of the widget to focus' },
                  { name: 'parentChildId', type: { kind: 'primitive', primitive: 'string' }, description: 'The window\'s direct child (e.g. layout) that contains widgetId. Defaults to widgetId.', optional: true },
                  { name: 'via', type: { kind: 'primitive', primitive: 'string' }, description: '"keyboard" | "mouse"', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'draw',
                description: 'Paint this window\'s surface or one of its canvas-layer scene nodes with 2D draw commands. Painting is INCREMENTAL: commands accumulate on the target\'s pixels; a { type: "clear" } restarts it (and compacts the retained replay log — clear at repaint boundaries). Pass nodeId to target a kind:"canvas" scene node (2D layer among the 3D); omit it to paint the window surface itself. mode:"replace" prepends a clear when the batch lacks one. Commands use the standard 2D vocabulary ({ type, params } — rect, text, line, circle, path, imageUrl, markdown-free primitives, plus the Canvas 2D API dialect).',
                parameters: [
                  { name: 'commands', type: { kind: 'array', elementType: { kind: 'reference', reference: 'DrawCommand' } }, description: 'Draw commands ({ type, params }); surfaceId/nodeId are stamped by the window' },
                  { name: 'nodeId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target canvas-layer scene node id (kind:"canvas"). Omit to paint the window surface.', optional: true },
                  { name: 'mode', type: { kind: 'primitive', primitive: 'string' }, description: '"append" (default, incremental) or "replace" (prepends a clear when missing)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'scene',
                description: 'Apply retained 3D scene ops to this window\'s subtree. The window is a slab in a 3D scene; mesh/light/group nodes attach to it and travel with it. ANY abject may call this — you do not need to own the window. Decorations from other abjects route their nodeInput back to the contributor and tear down when the contributor dies (prefix your node ids to avoid collisions). Ops: { op: "add"|"update"|"remove"|"animate", id, parentId?, kind: "mesh"|"light"|"group"|"environment"|"canvas"|"particles"|"camera"|"model"|"text"|"label"|"line"|"sky", transform: { position?: [x,y,z] px from window center (+z toward viewer, y-DOWN), rotation?: [rx,ry,rz] radians, scale?: n|[x,y,z] }, params }. Mesh params: { primitive: "plane"|"box"|"sphere"|"cylinder"|"cone"|"torus"|"icosphere"|"ring" (ring: flat annulus facing the viewer), color, emissive?, opacity?, metalness?(0..1), roughness?(0..1), texture?(url|dataURI|"surface:<id>"), billboard?, drawMode?("triangles"|"lines"|"points"), pointSize?, occlude?(default true: clipped to the window & below the title bar; false = draw on top / pop out), instances?:[{position,scale?,rotation?,color?},...](draw the mesh many times in one call — particles/fields) } for a built-in shape, OR { geometry: { positions:[x,y,z,...], indices?:[...], normals?:[...], colors?:[r,g,b,...](0..1 per vertex), uvs?:[u,v,...] }, color, ... } for an arbitrary polygonal mesh (re-send geometry in an "update" op to deform it every frame). MATERIALS (mesh params): material?:"<preset name>" (a named material from the SceneLibrary, e.g. gold, chrome, glass, neon, hologram, toon; the node\'s own params override it, and color may then be omitted), shading?:"standard"|"unlit"|"toon"|"matcap"|"rim", blend?:"normal"|"additive" (adds light over what is behind), normalMap?, roughnessMap?, metalnessMap?, aoMap?, emissiveMap?, matcap? (url|dataURI|"surface:<id>"), normalScale?, uvRepeat?:[u,v], uvOffset?:[u,v], clearcoat?, clearcoatRoughness?, sheen?, sheenColor?, transmission?(0..1, see-through glass with reflections), ior?, envIntensity?(reflection strength), toonSteps?, outline?:true|{ color?, width? px }, rimColor?, rimPower?, castShadow?, receiveShadow?. Colors are sRGB; lighting happens in linear light and is tone mapped. Light params: { lightType: "point"|"directional"|"spot"|"hemisphere", color?, intensity?, direction?(the way the light travels), range?, angle?, penumbra?, groundColor?(hemisphere: the color from below; color is the sky), castShadow?(directional or spot: meshes cast shadows on each other), shadow?:{ size?:512|1024|2048|4096, softness?(px), bias? } } (intensity is a LINEAR MULTIPLIER on the light color — 1 = full strength, keys 0.8-1.6, fills 0.3-0.6 — NOT watts/lumens; over 10 is rejected because it renders every lit mesh pure white. Use range for reach, not intensity). Environment params (scene mood): { ambient? (a COLOR \"#hex\"/$token, NOT a number — brightness rides in the color\'s lightness), look?:"<preset name>" (a named look from the SceneLibrary, e.g. studio, sunset, night; own params override it), sky?:{ top?, horizon?, bottom?, sun?:{ direction (toward the sun, y-down), color?, intensity?, size?(degrees) } } (lights and reflects every mesh), envMap?(equirect image), envIntensity?, toneMapping?:"neutral"(default)|"aces"|"agx"|"none", exposure?, grading?:{ contrast?, saturation?, temperature?, tint? }, fog?: { color?, near, far } or { color?, mode:"exp"|"exp2", density } (plus height?, heightFalloff?), bloom?: true|{ threshold?, intensity? } (glow on bright/emissive meshes); post effects, each on just by being set: ao?:true|{ radius?, intensity? } (contact shadows), dof?:{ focus?(px behind the content plane), range?, aperture?(px blur) }, outline?:true|{ color?, width? } (ink edges), lightShafts?:true|{ intensity?, decay? }, chromaticAberration?(px), fxaa?:true, grading.vignette?, grading.grain?; bloom also takes radius? and quality?:"low"|"medium"|"high". Example: { op:"add", id:"env", kind:"environment", params:{ look:"studio", ao:true, dof:{ focus:0, range:160, aperture:8 }, bloom:{ threshold:0.6, quality:"high" } } } }. CONTENT KINDS: primitive also takes "capsule"|"roundedBox"|"grid"|"tube"|"lathe"|"extrude", with options in params.shape: capsule { radius?, length? }, roundedBox { radius?(0..0.5) }, grid { segments?:[x,y] }, tube { path:[[x,y,z],...] (unit space), radius? }, lathe { points:[[radius,y],...] }, extrude { outline:[[x,y],...], holes?:[[[x,y],...]], depth?, bevel? } (unit-sized like the other primitives; scale sets px), e.g. params:{ primitive:"extrude", color:"$accent", shape:{ outline:[[-0.5,-0.5],[0.5,-0.5],[0,0.5]], depth:0.3, bevel:0.04 } }. kind:"model" (glTF 2.0 / GLB): { src (a URL, or a data-URI "data:model/gltf-binary;base64,..." up to 16 MB, stored once and sent to each screen once), animation?(clip name or index, plays on add), loop?(true), speed?(1), playing?(true), fit?(px: scaled so its largest side is this size, centred; otherwise 1 model unit = 1 px at scale 1), material?, color?(tint), opacity?, shading? (override the model\'s own materials) }, e.g. { op:"add", id:"ship", kind:"model", params:{ src:"https://example.com/ship.glb", fit:200, animation:0 } }. kind:"text" (extruded 3D text, lit like a mesh): { text, font?(CSS family; default the theme display font), size?(48 px), depth?(8 px), bevel?(0), align?:"left"|"center"|"right", color? or material? }, e.g. params:{ text:"LEVEL 2", size:72, depth:14, material:"gold" }. kind:"label" (crisp 2D text facing the camera): { text, font?, size?(14 px), color?($textPrimary), background?, padding?(6), radius?, maxWidth?(wraps), screenSpace?(true: the same size at any depth), anchor?:[ax,ay] }, e.g. params:{ text:"Score 120", background:"$windowBg", radius:4 }. kind:"line" (thick lines, width in screen px): { points:[[x,y,z],...], width?(2), color?, colors?(one per point), widths?(multipliers), closed?, dashed?:{ dash, gap }, join?:"miter"|"round", cap?:"butt"|"round", blend?, ribbon?(true: a camera-facing strip of world width) }, e.g. params:{ points:[[0,0,0],[80,-40,20],[160,0,0]], width:4, color:"$accent", join:"round" }. trail?:true|{ width?, color?, lifetime?(ms), length? } on any node leaves a fading ribbon behind it as it moves. kind:"sky" (a dome behind everything else in its subtree): { top?, horizon?, bottom?, sun?:{ direction (toward the sun, y-down), color?, size?(degrees) }, stars?:true|density, texture?(equirect image) } (an environment sky only lights; add a sky node to see one). Model, text, label and line nodes take input like meshes (interactive: true).  Canvas params (kind:\'canvas\' — a 2D drawing layer living in the scene; the window\'s own content is the BACKMOST 2D layer of the subtree): { width, height (px size of the layer\'s rectangle; transform.scale multiplies), commands? (standard 2D draw commands painted onto the layer — an update supplying commands REPLACES the whole batch and repaints; the layer starts transparent, so unpainted areas show the scene behind it), opacity?, radius?, interactive? }. Particles params (kind:\'particles\', an emitter simulated on the GPU, up to 20000 live particles in one draw): { rate? (per second, streams while > 0: the desktop redraws while it streams, so set rate 0 or remove it when idle), burst? (count emitted once on add, again whenever burstKey changes), burstKey?, lifetime? (ms), speed?:[min,max] px/s, direction?:[x,y,z], spread? (cone radians), gravity? (px/s², +y down), drag? (0..1 of speed lost per second), turbulence? (px/s swirl), size?:[min,max] px, sizeEnd? (px or [min,max]), spin? (rad/s or [min,max]), color?, colorEnd?, opacity?, opacityEnd?, shape?:"glow"|"square", texture? (a sprite: url|dataURI|"surface:<id>", tinted by color), blend?:"additive"|"normal" (default: light colors glow additively, darker ones cover), emitterSize?:[w,h,d], maxParticles? (300, up to 20000) }, e.g. { op:"add", id:"sparks", kind:"particles", params:{ rate:200, speed:[120,220], spread:0.4, gravity:300, drag:0.4, color:"#ffd166", colorEnd:"$accent", sizeEnd:0 } }. Canvas layers slice meshes by depth: meshes behind the layer\'s z draw under it, meshes in front draw over it — 2D and 3D stack in any order (put HUD/text on a canvas layer in front of the meshes). ANIMATE (client-side, one op instead of per-frame updates): { op:"animate", id, params: { preset?:"spin"|"orbit"|"bob"|"pulse"|"shake"|"flash"|"float"|"wobble"|"breathe"|"hover" (shake: decaying jolt; flash: emissive to params.color and back; float: slow drift and sway; wobble: jelly twist after a hit; breathe: slow swell; hover: lift toward the viewer; amplitude? and duration? tune them), channel?:"position"|"rotation"|"scale"|"color"|"emissive"|"opacity", to?, from?, duration?, easing? (linear|standard|easeInOut|backOut|bounce|elastic|... or [x1,y1,x2,y2]), loop?, yoyo?, delay?, path?:[[x,y,z],...], keyframes?:[{ t (ms from the start), value, easing? }] (a key easing shapes the segment starting at it), spring?:true|{ stiffness?(170), damping?(26), mass?(1) } (with to: spring physics; a new to retargets it keeping its speed), stop?:true } }, e.g. { op:"animate", id:"gem", params:{ channel:"scale", keyframes:[{ t:0, value:1 }, { t:300, value:1.3, easing:"backOut" }, { t:700, value:1 }] } }. CONSTRAINTS (node params): lookAt?:[x,y,z] (parent space) | { node:"<id>" } turns the node so its local +z faces it; follow?:{ node:"<id>", offset?:[x,y,z], stiffness?(0..1, 0.15) } eases it after another node; null clears, e.g. params:{ lookAt:{ node:"ship" } }. CAMERA (kind:"camera", one per window): the window 3D subtree renders through it instead of the default camera, still glued to and clipped by the window (pop-out nodes with clip:"none" keep the window\'s own view); transform.position is the eye (default: where the default camera sits), params { target?:[x,y,z] (origin), fov? (degrees, 30), orbit?:true|{ button?:"left"|"middle"|"right", minDistance?, maxDistance?, minPitch?, maxPitch?, damping? } (drag inside the window to turn around target), zoom?:true (wheel dollies), viewport?:{ x, y, width, height } (window px where drags orbit) }; the owner gets nodeInput cameraChange { nodeId, position, target, phase } (throttled) and the view survives reconnects, e.g. { op:"add", id:"cam", kind:"camera", transform:{ position:[0,-200,700] }, params:{ orbit:true, zoom:true } }. Colors accept "#hex" or theme tokens like "$accent". Nodes are RETAINED until removed. OCCLUSION: window 3D children are clipped to the window and sit below the title bar by default. params.clip: "content" (default) | "window" (the whole window, title bar included) | "none" (pops out past the window, depth-correct against the windows above: near parts draw over them, far parts hide behind them; params.occlude:false means the same). INTERACTION: interactive:true makes a node an input target (nodeInput: mousedown/mouseup/mousemove/mouseenter/mouseleave/focus/blur/keydown/keyup/wheel with deltaX, deltaY). draggable:true or { plane?:"xy"|"xz"|"yz", axis?:"x"|"y"|"z", bounds?:{ min:[x,y,z], max:[x,y,z] }, snap?:px, inertia?:true } lets the user drag the node in the browser (planes and bounds in the node\'s parent space; on a group, pressing any child drags the group); the owner gets nodeInput dragStart, dragMove (about 10/s) and dragEnd with position (the new transform.position) and hitNodeId, e.g. { op:"add", id:"knob", kind:"mesh", transform:{ position:[0, 40, 30], scale:36 }, params:{ primitive:"sphere", color:"$accent", draggable:{ axis:"x", bounds:{ min:[-150, 40, 30], max:[150, 40, 30] } } } }. focusable:true: pressing the node gives it the keyboard exclusively (keys stop reaching the window until the user clicks elsewhere). cursor:"pointer"|"grab"|"crosshair"|... sets the hover cursor. A window can also RIDE a node: see attachTo. LAYERS: the window\'s own content is the BACKMOST 2D layer; a kind:"canvas" node is a 2D drawing layer in the scene — params { width, height, commands (standard 2D draw commands; an update replaces the batch and repaints; the layer starts transparent), opacity?, radius? }. Canvas layers slice meshes by z: meshes behind draw under, meshes in front draw over — 2D and 3D stack in any order (put HUD/text on a canvas node in front of the meshes). INHERITANCE: children inherit a parent group\'s material params (color, opacity, metalness, roughness, texture, occlude, castShadow, ...) unless they set their own.',
                parameters: [
                  { name: 'ops', type: { kind: 'array', elementType: { kind: 'reference', reference: 'SceneOp' } }, description: 'Scene operations (invalid batches rejected with the vocabulary)' },
                  { name: 'origin', type: { kind: 'primitive', primitive: 'string' }, description: '"center" (default: positions are px from the window centre) or "topLeft": root nodes added in this batch hang under a window-owned group kept at the window\'s top-left corner, so positions are the same window px widgets draw at (title bar included) and stay put when the window resizes. Later updates and animations of those nodes keep using top-left px.', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'effect',
                description: 'Play a slab effect on this window (visual only, animated client-side). effect: a registered or built-in name (materialize, dematerialize, sink, shake, flash, pulse, burst, glitch) or an inline SlabEffectSpec (see WidgetManager registerWindowEffect). ANY abject may call this.',
                parameters: [
                  { name: 'effect', type: { kind: 'reference', reference: 'string | SlabEffectSpec' }, description: 'Effect name or inline spec' },
                  { name: 'color', type: { kind: 'primitive', primitive: 'string' }, description: 'Override light colour (CSS or $token)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setModal',
                description: 'Mark this window modal (or not): while it shows, every other window recedes into depth and dims.',
                parameters: [
                  { name: 'modal', type: { kind: 'primitive', primitive: 'boolean' }, description: 'true while modal' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setSlabTransform',
                description: 'Tilt or float this window\'s slab in the 3D scene (visual only — input picking follows automatically).',
                parameters: [
                  { name: 'rotation', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'number' } }, description: 'Euler radians [rx, ry, rz]', optional: true },
                  { name: 'z', type: { kind: 'primitive', primitive: 'number' }, description: 'Lift toward the viewer in px', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'attachTo',
                description: 'Make this window ride a 3D scene node: the whole window (slab, widgets and its own 3D subtree) follows the node\'s position and rotation every frame, and its buttons and widgets keep working. { scope: "world", nodeId, ownerId? } rides a world node (ownerId defaults to the caller, the usual case: your own world node); { scope: "window", windowId | surfaceId, nodeId } rides a node in another window\'s scene. offset: [x, y, z] px from the node (in the node\'s frame) to this window\'s centre. { detach: true } lets go. Title-bar drags move the window relative to its anchor; resize-edge cursors are approximate while attached. The window lets go by itself when the node or its owner goes away. Example: add a world group { op:"add", id:"cart", kind:"group", transform:{ position:[500, 400, 0] } }, then attachTo({ scope:"world", nodeId:"cart", offset:[0, -120, 0] }), then animate or drag "cart" and the window travels with it.',
                parameters: [
                  { name: 'scope', type: { kind: 'primitive', primitive: 'string' }, description: '"world" or "window"', optional: true },
                  { name: 'nodeId', type: { kind: 'primitive', primitive: 'string' }, description: 'The node to ride', optional: true },
                  { name: 'ownerId', type: { kind: 'primitive', primitive: 'string' }, description: 'World scope: the abject owning the world node (default: the caller)', optional: true },
                  { name: 'windowId', type: { kind: 'primitive', primitive: 'string' }, description: 'Window scope: the host window whose scene holds the node', optional: true },
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Window scope: the host surface (instead of windowId)', optional: true },
                  { name: 'offset', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'number' } }, description: '[x, y, z] px from the node to the window centre', optional: true },
                  { name: 'detach', type: { kind: 'primitive', primitive: 'boolean' }, description: 'true to stop riding', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getSurfaceId',
                description: 'The UIServer surface id of this window (for UIServer-level calls such as attaching another window to a node in this window\'s scene).',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'getWindowId',
                description: 'This window\'s own id. Widgets and nested layouts ask their owner for it (layouts pass the question up), so a widget deep in a layout can reach its window, e.g. to hang scene decorations on it.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
            ],
            events: [
              {
                name: 'windowMoved',
                description: 'Window was moved by user',
                payload: { kind: 'object', properties: { x: { kind: 'primitive', primitive: 'number' }, y: { kind: 'primitive', primitive: 'number' } } },
              },
              {
                name: 'windowResized',
                description: 'Window was resized by user',
                payload: { kind: 'object', properties: { width: { kind: 'primitive', primitive: 'number' }, height: { kind: 'primitive', primitive: 'number' } } },
              },
              {
                name: 'windowCloseRequested',
                description: 'Close button was clicked — owner should destroy',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowMinimized',
                description: 'Window was minimized',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowHelpRequested',
                description: 'Help (?) button was clicked — owner should reveal the object inspector',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowRestored',
                description: 'Window was restored from minimized state',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowFocus',
                description: 'The window gained or lost focus (to dependents; widgets with an open pop-out close it on blur)',
                payload: { kind: 'object', properties: { focused: { kind: 'primitive', primitive: 'boolean' } } },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['widget', 'window'],
      },
    });

    this.uiServerId = config.uiServerId;
    this.title = config.title;
    this.rect = { ...config.rect };
    this.focusDecoration = config.focusDecoration ?? null;
    this.chromeless = config.chromeless ?? false;
    this.transparent = config.transparent ?? false;
    this.closable = config.closable ?? true;
    contractRequire(config.screenAnchor === undefined || isScreenAnchor(config.screenAnchor),
      'screenAnchor must be one of top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right');
    this.screenAnchor = config.screenAnchor;
    this.focusOnCreate = config.focusOnCreate ?? true;
    this.resizable = config.resizable ?? false;
    this.draggable = config.draggable ?? false;
    this.zIndex = config.zIndex ?? 100;
    this.theme = config.theme ?? DEFAULT_THEME;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('addChild', async (msg: AbjectMessage) => {
      const { widgetId, rect } = msg.payload as { widgetId: AbjectId; rect: Rect };
      console.debug(`[Window:${this.id}] addChild — widgetId=${widgetId}`);
      this.children.push(widgetId);

      // If rect is {0,0,0,0}, fill the full content area (typical for layout children)
      const contentW = this.rect.width;
      const contentH = this.rect.height - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);
      const effectiveRect = (rect.width === 0 && rect.height === 0)
        ? { x: 0, y: 0, width: contentW, height: contentH }
        : rect;
      this.childRects.set(widgetId, effectiveRect);

      // Update the child widget's own rect so it knows its dimensions
      if (rect.width === 0 && rect.height === 0) {
        try {
          await this.request(
            request(this.id, widgetId, 'update', { rect: effectiveRect })
          );
        } catch {
          // Widget setup may not be complete yet
        }
      }

      this.scheduleFrame();
      return true;
    });

    this.on('removeChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      if (!this.children.includes(widgetId)) return true;  // Not a direct child (layout-managed) — no-op
      this.children = this.children.filter((id) => id !== widgetId);
      this.childRects.delete(widgetId);
      this.expandedSelects.delete(widgetId);
      if (this.focusedChildId === widgetId) { this.focusedChildId = undefined; this.focusedParentChildId = undefined; }
      if (this.focusedParentChildId === widgetId) this.focusedParentChildId = undefined;
      if (this.hoveredChildId === widgetId) this.hoveredChildId = undefined;
      this.scheduleFrame();
      return true;
    });

    this.on('setTitle', async (msg: AbjectMessage) => {
      const { title } = msg.payload as { title: string };
      this.title = title;
      if (this.surfaceId) {
        this.send(request(this.id, this.uiServerId, 'setSurfaceTitle', {
          surfaceId: this.surfaceId, title,
        }));
      }
      this.scheduleFrame();
      return true;
    });

    this.on('getRect', async () => {
      // w/h are canonical across the UI; width/height kept for compatibility.
      return { ...this.rect, w: this.rect.width, h: this.rect.height };
    });

    this.on('getTitle', async () => {
      return this.title;
    });

    // Input on a 3D node in this window's subtree: forward to the window's
    // owner via the dependent chain (WidgetManager relays 'nodeInput'),
    // mirroring how widget clicks reach owners.
    this.on('nodeInput', async (msg: AbjectMessage) => {
      this.changed('nodeInput', msg.payload);
      return true;
    });

    // ── 3D scene: the window owns its surface, so it fronts the scene
    // vocabulary for its owner AND for decorators — any abject may attach
    // nodes to this window's subtree. The caller's identity rides along so
    // UIServer routes the nodes' input back to the contributor and tears the
    // nodes down if the contributor dies.
    this.on('scene', async (msg: AbjectMessage) => {
      const { ops, origin } = msg.payload as { ops: unknown[]; origin?: 'center' | 'topLeft' };
      contractRequire(this.surfaceId !== undefined, 'scene: window has no surface yet');
      contractRequire(origin === undefined || origin === 'center' || origin === 'topLeft',
        `scene: origin must be 'center' (default) or 'topLeft', got ${String(origin)}`);
      // Everything below runs before the first await, so batches reach the
      // UIServer in the order they arrived (an add never overtakes its remove).
      const out = origin === 'topLeft' ? this.hangOnOriginAnchor(ops) : ops;
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'scene', {
          surfaceId: this.surfaceId, ops: out, contributorId: msg.routing.from,
        })
      );
    });

    // ── Draw channel: paint this window's surface or one of its canvas-layer
    // scene nodes (kind:'canvas'). Painting is incremental — commands
    // accumulate; a 'clear' restarts the target. mode:'replace' is sugar
    // that prepends a clear when the batch lacks one.
    this.on('draw', async (msg: AbjectMessage) => {
      const { nodeId, commands, mode } = msg.payload as {
        nodeId?: string;
        commands: unknown[];
        mode?: 'append' | 'replace';
      };
      contractRequire(this.surfaceId !== undefined, 'draw: window has no surface yet');
      contractRequire(Array.isArray(commands), 'draw needs a commands array');
      let out: Array<Record<string, unknown>> = commands.map((c) => ({
        ...(c as Record<string, unknown>),
        surfaceId: this.surfaceId!,
        ...(nodeId ? { nodeId } : {}),
      }));
      if (mode === 'replace'
        && !out.some((c) => c.type === 'clear' || c.type === 'reset')) {
        out = [
          { type: 'clear', surfaceId: this.surfaceId!, ...(nodeId ? { nodeId } : {}), params: {} },
          ...out,
        ];
      }
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'draw', { commands: out })
      );
    });

    // WidgetManager pushes the desktop's focus decoration (scene ops).
    this.on('setFocusDecoration', async (msg: AbjectMessage) => {
      const { ops } = msg.payload as { ops: Array<Record<string, unknown>> | null };
      if (this.decorationShown) await this.removeFocusDecoration();
      this.focusDecoration = Array.isArray(ops) && ops.length > 0 ? ops : null;
      await this.syncFocusDecoration();
      return true;
    });

    this.on('effect', async (msg: AbjectMessage) => {
      const { effect, color } = msg.payload as { effect: unknown; color?: string };
      contractRequire(this.surfaceId !== undefined, 'effect: window has no surface yet');
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'surfaceEffect', { surfaceId: this.surfaceId, effect, ...(color ? { color } : {}) })
      );
    });

    this.on('setModal', async (msg: AbjectMessage) => {
      const { modal } = msg.payload as { modal: boolean };
      contractRequire(this.surfaceId !== undefined, 'setModal: window has no surface yet');
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'setSurfaceModal', { surfaceId: this.surfaceId, modal: modal === true })
      );
    });

    this.on('setSlabTransform', async (msg: AbjectMessage) => {
      const { rotation, z } = msg.payload as { rotation?: [number, number, number]; z?: number };
      contractRequire(this.surfaceId !== undefined, 'setSlabTransform: window has no surface yet');
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'setSurfaceTransform', { surfaceId: this.surfaceId, rotation, z })
      );
    });

    this.on('getSurfaceId', async () => {
      contractRequire(this.surfaceId !== undefined, 'getSurfaceId: window has no surface yet');
      return this.surfaceId;
    });

    // Widgets ask their owner chain for their window (nested layouts pass the
    // question up); the window answers with itself.
    this.on('getWindowId', async () => this.id);

    // Ride a scene node (world or another window's): the UIServer keeps the
    // anchor, the client moves the slab with the node every frame.
    this.on('attachTo', async (msg: AbjectMessage) => {
      const p = (msg.payload ?? {}) as {
        scope?: 'world' | 'window'; nodeId?: string; ownerId?: string;
        windowId?: AbjectId; surfaceId?: string; offset?: [number, number, number]; detach?: boolean;
      };
      contractRequire(this.surfaceId !== undefined, 'attachTo: window has no surface yet');
      if (p.detach === true) {
        return this.request<boolean>(
          request(this.id, this.uiServerId, 'attachSurface', { surfaceId: this.surfaceId, target: null })
        );
      }
      contractRequire(p.scope === 'world' || p.scope === 'window',
        'attachTo: scope must be "world" (a world node) or "window" (a node in another window\'s scene), or pass { detach: true }');
      contractRequire(typeof p.nodeId === 'string' && p.nodeId.length > 0, 'attachTo: nodeId must name the scene node to ride');
      contractRequire(p.offset === undefined || (Array.isArray(p.offset) && p.offset.length === 3
        && p.offset.every((v) => typeof v === 'number' && Number.isFinite(v))), 'attachTo: offset must be [x, y, z] px');
      let target: Record<string, unknown>;
      if (p.scope === 'world') {
        target = { scope: 'world', nodeId: p.nodeId, ownerId: p.ownerId ?? msg.routing.from, ...(p.offset ? { offset: p.offset } : {}) };
      } else {
        let hostSurface = p.surfaceId;
        if (!hostSurface && p.windowId) {
          contractRequire(p.windowId !== this.id, 'attachTo: a window cannot ride a node in its own scene');
          hostSurface = await this.request<string>(request(this.id, p.windowId, 'getSurfaceId', {}));
        }
        contractRequire(typeof hostSurface === 'string' && hostSurface.length > 0,
          'attachTo: a window-scope anchor needs windowId (the host window) or surfaceId');
        target = { scope: 'window', nodeId: p.nodeId, surfaceId: hostSurface, ...(p.offset ? { offset: p.offset } : {}) };
      }
      return this.request<boolean>(
        request(this.id, this.uiServerId, 'attachSurface', { surfaceId: this.surfaceId, target })
      );
    });

    this.on('destroy', async () => {
      await this.destroyWindow();
      return true;
    });

    this.on('focusChild', async (msg: AbjectMessage) => {
      const { widgetId, parentChildId, via } = msg.payload as {
        widgetId: AbjectId;
        parentChildId?: AbjectId;
        via?: 'keyboard' | 'mouse';
      };
      await this.focusChildWidget(widgetId, parentChildId ?? widgetId, via);
      return true;
    });

    // Input events forwarded from UIServer
    this.on('input', async (msg: AbjectMessage) => {
      const inputEvent = msg.payload as {
        type: string;
        surfaceId?: string;
        x?: number;
        y?: number;
        button?: number;
        key?: string;
        code?: string;
        modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
        deltaX?: number;
        deltaY?: number;
        pasteText?: string;
      };
      await this.handleInputEvent(inputEvent);
    });

    // Owner (e.g. Chat) asks to open a native file picker for this window's
    // surface. The chosen file comes back as a 'fileUploaded' event below.
    this.on('openFilePicker', async (msg: AbjectMessage) => {
      const { accept, multiple } = msg.payload as { accept?: string; multiple?: boolean };
      if (this.surfaceId) {
        this.send(request(this.id, this.uiServerId, 'openFilePicker', {
          surfaceId: this.surfaceId, accept, multiple,
        }));
      }
      return true;
    });

    // A file picked or dropped onto this window arrives from UIServer (the
    // surface owner). Re-emit it to the window's owner via the dependency
    // protocol (WidgetManager forwards 'fileUploaded' to the owner).
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      const payload = msg.payload as { name: string; mimeType: string; base64: string; toFocusedWidget?: boolean };
      // An image pasted into a focused child (e.g. a text input) is delivered
      // straight to that widget so it can accept the attachment, rather than
      // bubbling to the window's owner like a picked/dropped file.
      if (payload.toFocusedWidget && this.focusedChildId) {
        this.send(event(this.id, this.focusedChildId, 'fileUploaded', {
          name: payload.name, mimeType: payload.mimeType, base64: payload.base64,
        }));
        return true;
      }
      this.changed('fileUploaded', payload);
      return true;
    });

    // Child dirty notification — schedule a frame render
    this.on('childDirty', async () => {
      if (this.destroying) return;
      this.scheduleFrame();
    });

    // Receive changed events from children (e.g., select expanded/collapsed)
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'expanded') {
        if (value) {
          this.expandedSelects.add(msg.routing.from);
        } else {
          this.expandedSelects.delete(msg.routing.from);
        }
      }
    });

    // Focus/unfocus events from UIServer
    this.on('focus', async (msg: AbjectMessage) => {
      const { focused } = msg.payload as { surfaceId: string; focused: boolean };
      // Dependents hear focus transitions (an open pop-out closes on blur).
      if (focused !== this.windowFocused) this.changed('windowFocus', { focused });
      this.windowFocused = focused;
      void this.syncFocusDecoration();

      // Focus is shown with a static accent border + a soft compositor halo,
      // so no continuous shimmer animation is needed (avoids repainting the
      // focused window every frame). Cancel any legacy tween.
      this.stopShimmer();

      // When window loses focus, send mouseleave to hovered child so it
      // clears hover highlight (the mouse may never
      // re-enter this window before entering the newly focused one).
      if (!focused && this.hoveredChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
        this.hoveredChildId = undefined;
      }
      if (!focused) {
        this.hoveredTitleButton = undefined;
        this.syncChromeTip();
      }

      this.scheduleFrame();
    });

    this.on('updateTheme', async (msg: AbjectMessage) => {
      this.theme = msg.payload as ThemeData;
      this.scheduleFrame();
      return true;
    });

    // Frontend reconnected with new font metrics — recompute layout and redraw
    this.on('fontMetricsChanged', async () => {
      this.scheduleFrame();
      return true;
    });

    // WindowManager sends titleBarAction when close/minimize buttons are clicked
    this.on('titleBarAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { action: string };
      if (action === 'close') {
        this.changed('windowCloseRequested', {});
      } else if (action === 'minimize') {
        this.changed('windowMinimized', {});
      } else if (action === 'help') {
        this.changed('windowHelpRequested', {});
      } else if (action === 'restore') {
        this.changed('windowRestored', {});
        this.scheduleFrame();
      } else if (action === 'maximize') {
        this.maximized = true;
        this.changed('windowMaximized', {});
        this.scheduleFrame();
      } else if (action === 'unmaximize') {
        this.maximized = false;
        this.changed('windowUnmaximized', {});
        this.scheduleFrame();
      }
    });

    // WindowManager sends rect updates during drag/resize;
    // Taskbar (and other owners) may also send windowRect for programmatic resize.
    this.on('windowRect', async (msg: AbjectMessage) => {
      const { x, y, width, height } = msg.payload as { x: number; y: number; width: number; height: number };
      const moved = x !== this.rect.x || y !== this.rect.y;
      const sizeChanged = width !== this.rect.width || height !== this.rect.height;
      this.rect = { x, y, width, height };
      if (sizeChanged && this.decorationShown) void this.placeFocusDecoration();
      if (sizeChanged && this.originAnchorShown) this.placeOriginAnchor();

      // Update the actual UIServer surface so it matches the new rect
      if (this.surfaceId) {
        if (moved) {
          this.request(
            request(this.id, this.uiServerId, 'moveSurface', { surfaceId: this.surfaceId, x, y })
          ).catch(() => {});
        }
        if (sizeChanged) {
          this.request(
            request(this.id, this.uiServerId, 'resizeSurface', { surfaceId: this.surfaceId, width, height })
          ).catch(() => {});
        }
      }

      if (sizeChanged) {
        // Latest-wins coalescing: resize drags deliver un-throttled rects
        // (120+/sec on fast mice), and a full child relayout + render per
        // event queues far behind the pointer. this.rect already holds the
        // newest size, so intermediate sizes are skipped and at most one
        // relayout runs at a time.
        this.resizePending = true;
        void this.drainResize();
      }
      this.changed('windowRect', { x, y, width, height });
    });
  }

  /**
   * Run relayout+render passes until no newer size is pending. Each pass
   * lays out at whatever this.rect holds when it starts, so a burst of
   * windowRect events costs at most one in-flight pass plus one final
   * pass at the settled size.
   */
  private async drainResize(): Promise<void> {
    if (this.resizeDraining) return;
    this.resizeDraining = true;
    try {
      while (this.resizePending) {
        this.resizePending = false;
        await this.updateChildrenOnResize();
        await this.renderWindow();
      }
    } finally {
      this.resizeDraining = false;
    }
  }

  // Window lifecycle/API (create, layout, close/reopen) agents build against.
  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WindowAbject Usage Guide

### Overview

WindowAbject is a composite morph that owns a UIServer surface and contains child widgets.
It handles rendering (Morphic drawOn:) and routes input events to children.

### Title Bar Actions

WindowManager sends 'titleBarAction' events to WindowAbject when title bar buttons are clicked.
WindowAbject translates these into dependency-protocol events:

- action: 'close'   → emits 'windowCloseRequested' to dependents
- action: 'minimize' → emits 'windowMinimized' to dependents
- action: 'restore'  → emits 'windowRestored' to dependents, then re-renders
- action: 'maximize'  → marks maximized (renders restore glyph), emits 'windowMaximized'
- action: 'unmaximize' → clears maximized (renders maximize glyph), emits 'windowUnmaximized'

### Event Flow

1. User clicks close (X) or minimize (_) button in title bar
2. WindowManager detects the hit and sends 'titleBarAction' to WindowAbject
3. WindowAbject calls this.changed(eventName) which notifies all dependents
4. WidgetManager (registered as dependent) receives the event via 'changed' handler
5. WidgetManager forwards the event to the window's owner Abject
6. Owner handles the event (e.g., calls hide() on windowCloseRequested)

### Owner Handling

Window owners do NOT register as dependents of WindowAbject directly.
Instead, WidgetManager acts as the intermediary. Owners receive events as
method calls on 'abjects:widgets' interface:

  this.on('windowCloseRequested', async (msg) => {
    await this.hide();
  });

### 3D Scene

The window is a slab in a 3D desktop. Attach retained 3D nodes to it:

  await this.call(windowId, 'scene', { ops: [
    { op: 'add', id: 'orb', kind: 'mesh',
      transform: { position: [0, 0, 40], scale: 30 },
      params: { primitive: 'sphere', color: '$accent' } },
  ] });

Kinds: mesh (primitive: plane|box|sphere|cylinder), light (lightType:
point|directional), group. Positions are px from the window center
(+z toward the viewer); colors take '#hex' or theme tokens ('$accent', ...).
A mesh can carry CUSTOM polygons instead of a primitive for arbitrary or
deformable surfaces (waves, terrain, generated shapes): params { geometry:
{ positions: [x,y,z, ...], indices?: [...], normals?: [...], colors?: [r,g,b,...]
(0..1 per vertex), uvs?: [u,v,...] }, color }. Re-send geometry in an 'update'
op each tick to deform it (buffers reuse, so per-frame morphing is cheap).
Primitives: plane, box, sphere, cylinder, cone, torus, icosphere. Material
params: metalness/roughness (0..1, PBR), emissive (glow), texture (url|dataURI|
'surface:<id>'), billboard (face camera), drawMode 'points'|'lines' + pointSize,
material:'<preset name>' (gold, chrome, glass, neon, hologram, toon, ... from
the SceneLibrary; the node's own params override it), shading 'standard'|
'unlit'|'toon'|'matcap'|'rim', blend 'additive' (glows), normalMap/roughnessMap/
metalnessMap/aoMap/emissiveMap + uvRepeat/uvOffset, clearcoat, sheen,
transmission + ior (glass), outline, castShadow/receiveShadow.
Lights: lightType 'point'|'directional'|'spot'|'hemisphere' with color,
intensity, range, angle, penumbra, direction (the way the light travels),
groundColor (hemisphere), castShadow (directional or spot) + shadow:{ size,
softness, bias }. INTENSITY IS A LINEAR MULTIPLIER ON THE LIGHT'S COLOR
(1 = that color at full strength), NOT watts/lumens/candela — key lights run
0.8-1.6, fills 0.3-0.6, and anything over 10 is REJECTED because it pushes
every channel past white and renders every lit mesh PURE WHITE, erasing its
own color. Light a bigger scene with 'range' (reach in world px), never with
a bigger intensity. A kind:'environment' node sets { ambient (a COLOR '#hex'/$token, NOT a
number — brightness rides in the color's lightness), fog:{color,near,far} (near/far = depth
in px behind the content, small e.g. 0..400), bloom }, plus look:'<name>'
(studio, sunset, night, ...), sky:{ top, horizon, bottom, sun:{ direction
toward the sun } } (lights and reflects the meshes), envMap, toneMapping
'neutral'|'aces'|'agx'|'none', exposure, grading:{ contrast, saturation,
temperature, tint }, and fog { mode:'exp'|'exp2', density } or height fog. Scene ops validate ATOMICALLY: one
invalid node rejects the whole batch and nothing renders.
ANIMATE without per-frame messages: { op:'animate', id, params:{ preset:'spin'|
'orbit'|'bob'|'pulse' } } or { channel:'position'|'rotation'|'scale'|'color'|
'emissive'|'opacity', to, duration, easing?, loop?, yoyo?, path? }; stop with
{ stop:true }.
COORDINATES ARE Y-DOWN (screen convention): +y moves DOWN, the same
direction as input y — mouse deltas map onto positions with no sign flips.
Nodes persist until { op: 'remove', id }. Tilt/float the window itself:
\`call(windowId, 'setSlabTransform', { rotation: [0, 0.1, 0], z: 20 })\`.
LAYERS — 2D layers are scene nodes, so 2D and 3D stack in ANY order by z.
The window's own content (background, widgets, canvas widget) is the
BACKMOST 2D layer of this subtree; scene nodes draw above it. A
kind:'canvas' node is a 2D drawing layer IN the scene graph — a
width×height px rectangle at its transform painted with the standard 2D
draw-command vocabulary:

  await this.call(windowId, 'scene', { ops: [
    { op: 'add', id: 'hud', kind: 'canvas',
      transform: { position: [0, 0, 150] },
      params: { width: 800, height: 500, commands: [
        { type: 'text', params: { x: 24, y: 24, text: 'Score: 12',
          fill: '$textPrimary', font: 'bold 24px sans-serif' } },
      ] } },
  ] });

Paint it through my DRAW CHANNEL (preferred — incremental):

  await this.call(windowId, 'draw', { nodeId: 'hud', commands: [
    { type: 'clear', params: {} },
    { type: 'text', params: { x: 24, y: 24, text: 'Score: 13',
      fill: '$textPrimary', font: 'bold 24px sans-serif' } },
  ] });

Commands ACCUMULATE on the layer's pixels; begin each repaint with a bare
clear (the layer erases to transparent, so unpainted areas show the scene
behind it; clear with a color opts into an opaque background). Omitting
nodeId paints the window surface itself. mode:'replace' prepends a clear
when the batch lacks one. A scene update supplying params.commands also
works and replaces the batch wholesale.
ORDERING IS DEPTH: meshes behind the layer's z draw under it, meshes in
front draw over it — background canvas (z -300) → meshes → HUD canvas
(z 150) → pop-out meshes compose freely. 2D text/HUD that must read over
the 3D goes on a canvas node in front of the meshes; the window's base
canvas always renders beneath them.
Meshes are DECORATIVE BY DEFAULT and pass clicks through to the widgets/
canvas beneath them. Add interactive:true to a mesh's params to make it an
input target; then the window's owner receives 'nodeInput'
events — payload { type, nodeId, x, y, key?, code?, button?, windowId }
where type is mousedown|mouseup|mousemove|mouseenter|mouseleave|focus|blur|
keydown|keyup. Clicking an interactive mesh selects it; keyboard routes to it
until the user clicks elsewhere. Drag capture is built in: after mousedown on a mesh,
mousemove streams to it until mouseup — drag = position [startX + dx,
startY + dy, z], both axes same sign.
Or let the desktop do the dragging: params.draggable:true (or { plane, axis,
bounds, snap, inertia }) moves the node in the browser at full frame rate and
sends you dragStart / dragMove / dragEnd with its new position. focusable:true
makes a pressed node the only keyboard receiver; 'wheel' events carry deltaX /
deltaY; clip:'window' lets a node cover the title bar and clip:'none' pops it
out of the window (depth-correct against the windows above).
RIDING 3D: attachTo({ scope: 'world', nodeId, offset? }) hangs this whole
window on one of your world nodes (it follows the node's position and
rotation; widgets keep working); attachTo({ detach: true }) lets go.
DECORATING: you may attach scene nodes to a window you do NOT own — find it
via WidgetManager listWindows, then call its 'scene' with your nodes. Your
nodes' nodeInput events come back to YOU (windowId in the payload), and they
tear down automatically if your abject dies. Prefix node ids with your name
to avoid colliding with the window owner's nodes. Decoration nodes ride the
slab — they follow drags, resizes, hide/show with zero tracking code (the
top edge is y = -height/2 from center; recompute it on the window's
windowResized event via addDependent). For host open/close, observe
WidgetManager's windowCreated/windowDestroyed changed-events and re-attach
by re-matching title/owner.

### Interface ID

'abjects:window' — for addChild, removeChild, setTitle, getRect, destroy, scene, setSlabTransform, attachTo, getSurfaceId`;
  }

  protected async onInit(): Promise<void> {
    // Create surface via UIServer
    this.surfaceId = await this.request<string>(
      request(this.id, this.uiServerId, 'createSurface', {
        rect: this.rect,
        zIndex: this.zIndex,
        transparent: this.transparent,
        closable: this.closable,
        chromeless: this.chromeless,
        ...(this.screenAnchor ? { screenAnchor: this.screenAnchor } : {}),
      })
    );
    // Forward title to frontend for mobile tab bar
    this.send(request(this.id, this.uiServerId, 'setSurfaceTitle', {
      surfaceId: this.surfaceId,
      title: this.title,
    }));
    if (this.focusOnCreate) {
      await this.request<boolean>(
        request(this.id, this.uiServerId, 'focus', {
          surfaceId: this.surfaceId,
          // Accent + corner radius for the compositor's focus-glow halo so it
          // matches the theme and the window silhouette.
          glowColor: this.theme.accent,
          glowRadius: this.theme.windowRadius,
        })
      );
    }
    await this.renderWindow();
  }

  private startShimmer(): void {
    this.shimmerTween?.cancel();
    this.shimmerTween = motionShimmer(
      this.theme.tokens.motion.shimmer,
      (pos) => {
        if (this.destroying) return;
        this.shimmerPos = pos;
        this.scheduleFrame();
      },
    ).start();
  }

  private stopShimmer(): void {
    this.shimmerTween?.cancel();
    this.shimmerTween = undefined;
  }

  // ── Rendering (Morphic drawOn:) ──────────────────────────────────────

  /**
   * Game-engine style frame scheduler: debounce all mutation-triggered renders
   * into a single renderWindow() call. The timer resets on each call, so the
   * render fires only after all pending mutations settle.
   */
  private scheduleFrame(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      if (!this.destroying) {
        this.renderWindow().catch(() => {});
      }
    }, 0);
  }

  private async renderWindow(): Promise<void> {
    if (!this.surfaceId || this.destroying) return;
    if (this.rendering) {
      this.renderScheduled = true;
      return;
    }

    this.rendering = true;
    this.renderScheduled = false;
    try {
      await this.renderWindowInner();
    } finally {
      this.rendering = false;
      if (this.renderScheduled) {
        this.renderScheduled = false;
        this.scheduleFrame();
      }
    }
  }

  /**
   * Title-bar button centers, right to left: close, maximize, minimize, help.
   * Mirrors WindowManager.detectTitleButton (the hit-test authority).
   */
  private titleButtonCenters(): Record<TitleButtonKind, number> {
    const btnSize = this.theme.titleButtonSize;
    const btnMargin = this.theme.titleButtonMargin;
    const close = this.rect.width - btnMargin - btnSize / 2;
    const maximize = close - btnSize - btnMargin;
    const minimize = maximize - btnSize - btnMargin;
    const help = minimize - btnSize - btnMargin;
    return { close, maximize, minimize, help };
  }

  /** The title-bar button at window-local (x, y), if any. */
  private titleButtonAt(x: number, y: number): TitleButtonKind | undefined {
    const tbh = this.theme.titleBarHeight;
    if (y < 0 || y >= tbh) return undefined;
    const half = this.theme.titleButtonSize / 2;
    if (Math.abs(y - tbh / 2) > half) return undefined;
    const centers = this.titleButtonCenters();
    for (const kind of ['close', 'maximize', 'minimize', 'help'] as const) {
      if (Math.abs(x - centers[kind]) <= half) return kind;
    }
    return undefined;
  }

  /**
   * Title-button tooltips follow the hover: any change drops the shown tip
   * and, over a button, schedules the next after the usual dwell. The tip is
   * a pop-out (popout.ts) under the button, so it may leave the window.
   */
  private syncChromeTip(): void {
    this.dropChromeTip();
    const kind = this.hoveredTitleButton;
    if (kind && this.surfaceId) {
      this.chromeTipTimer = this.setTimer(() => this.showChromeTip(kind), TOOLTIP_DELAY_MS);
    }
  }

  private dropChromeTip(): void {
    this.cancelTimer(this.chromeTipTimer);
    this.chromeTipTimer = undefined;
    if (this.chromeTip?.isOpen) void this.chromeTip.hide();
  }

  private async showChromeTip(kind: TitleButtonKind): Promise<void> {
    this.chromeTipTimer = undefined;
    const sid = this.surfaceId;
    if (this.hoveredTitleButton !== kind || !sid) return;
    const tip = this.chromeTip ??= new PopoutSurface({
      scene: (ops) => this.request(request(this.id, this.uiServerId, 'scene', { surfaceId: sid, ops, contributorId: this.id })),
      draw: (nodeId, commands) => this.request(request(this.id, this.uiServerId, 'draw', {
        commands: commands.map((c) => ({ ...(c as Record<string, unknown>), surfaceId: sid, nodeId })),
      })),
      geometry: async () => {
        const screen = await cachedScreenSize(() =>
          this.request<{ width: number; height: number }>(request(this.id, this.uiServerId, 'getDisplayInfo', {}), 3000));
        return screen ? { window: { x: this.rect.x, y: this.rect.y }, screen } : null;
      },
    }, TOOLTIP_NODE_ID, { interactive: false });
    const size = this.theme.titleButtonSize;
    const tbh = this.theme.titleBarHeight;
    const text = kind === 'close' ? 'Close'
      : kind === 'minimize' ? 'Minimize'
      : kind === 'maximize' ? (this.maximized ? 'Restore' : 'Maximize')
      : 'Inspect methods';
    await showTooltip(tip, {
      text,
      anchor: { x: this.titleButtonCenters()[kind] - size / 2, y: tbh / 2 - size / 2, width: size, height: size },
      side: 'below',
      theme: this.theme,
      measure: (t, font) => this.request<number>(request(this.id, this.uiServerId, 'measureText', { surfaceId: sid, text: t, font })),
    }).catch(() => { /* no surface to hang it on */ });
    if (this.hoveredTitleButton !== kind) void tip.hide();
  }

  // ── Top-left scene origin ──────────────────────────────────────────
  // `scene` with origin: 'topLeft' hangs the batch's root nodes under one
  // window-owned group kept at the window's top-left corner, so callers
  // (widgets, decorators) place nodes in the same px they draw at and never
  // re-send them when the window resizes. The group is created on first use
  // and lives as long as the window.

  static readonly ORIGIN_ANCHOR = 'window-origin-tl';

  /** Re-parent a batch's root adds onto the top-left anchor (creating it first if needed). */
  private hangOnOriginAnchor(ops: unknown[]): unknown[] {
    contractRequire(Array.isArray(ops), 'scene: ops must be an array');
    const anchor = WindowAbject.ORIGIN_ANCHOR;
    if (!this.originAnchorShown) {
      // Sent synchronously ahead of the caller's batch, as the window's own
      // node, so it outlives every contributor hanging things on it.
      this.originAnchorShown = true;
      this.request(request(this.id, this.uiServerId, 'scene', {
        surfaceId: this.surfaceId,
        ops: [{ op: 'add', id: anchor, kind: 'group', transform: { position: this.originAnchorPosition() } }],
        contributorId: this.id,
      })).catch(() => { this.originAnchorShown = false; });
    }
    return ops.map((raw) => {
      const op = raw as Record<string, unknown>;
      if (!op || op.op !== 'add' || op.parentId !== undefined || op.parent !== undefined) return raw;
      return { ...op, parentId: anchor };
    });
  }

  private originAnchorPosition(): [number, number, number] {
    return [-this.rect.width / 2, -this.rect.height / 2, 0];
  }

  private placeOriginAnchor(): void {
    if (!this.surfaceId) return;
    this.request(request(this.id, this.uiServerId, 'scene', {
      surfaceId: this.surfaceId,
      ops: [{ op: 'update', id: WindowAbject.ORIGIN_ANCHOR, transform: { position: this.originAnchorPosition() } }],
      contributorId: this.id,
    })).catch(() => {});
  }

  // ── Focus decoration ───────────────────────────────────────────────
  // The focused window wears WidgetManager's focus decoration: scene ops in
  // px from the window's top-left corner, hung under one root group so they
  // are added on focus and removed on blur with a single op each. Chromeless
  // and transparent windows (docks, scrims, tooltips) wear none.

  private static readonly DECORATION_ROOT = 'focus-deco';

  private async syncFocusDecoration(): Promise<void> {
    const want = this.windowFocused && !!this.focusDecoration && !this.chromeless && !this.transparent;
    if (want && !this.decorationShown) await this.addFocusDecoration();
    else if (!want && this.decorationShown) await this.removeFocusDecoration();
  }

  private async addFocusDecoration(): Promise<void> {
    if (!this.surfaceId || !this.focusDecoration) return;
    const root = WindowAbject.DECORATION_ROOT;
    const prefix = (id: unknown) => `${root}:${String(id)}`;
    const ops: Array<Record<string, unknown>> = [
      {
        op: 'add', id: root, kind: 'group',
        transform: { position: [-this.rect.width / 2, -this.rect.height / 2, 0] },
        params: { occlude: false },
      },
    ];
    for (const raw of this.focusDecoration) {
      const op: Record<string, unknown> = { ...raw, id: prefix(raw.id) };
      if (op.op === 'add') op.parentId = raw.parentId !== undefined ? prefix(raw.parentId) : root;
      ops.push(op);
    }
    this.decorationShown = true;
    try {
      await this.request(request(this.id, this.uiServerId, 'scene', {
        surfaceId: this.surfaceId, ops, contributorId: this.id,
      }));
    } catch {
      this.decorationShown = false;
    }
  }

  private async placeFocusDecoration(): Promise<void> {
    if (!this.surfaceId) return;
    await this.request(request(this.id, this.uiServerId, 'scene', {
      surfaceId: this.surfaceId,
      ops: [{
        op: 'update', id: WindowAbject.DECORATION_ROOT,
        transform: { position: [-this.rect.width / 2, -this.rect.height / 2, 0] },
      }],
      contributorId: this.id,
    })).catch(() => {});
  }

  private async removeFocusDecoration(): Promise<void> {
    this.decorationShown = false;
    if (!this.surfaceId) return;
    await this.request(request(this.id, this.uiServerId, 'scene', {
      surfaceId: this.surfaceId,
      ops: [{ op: 'remove', id: WindowAbject.DECORATION_ROOT }],
      contributorId: this.id,
    })).catch(() => {});
  }

  /**
   * Constructivist window chrome: flat paper body, a solid title band (red
   * when focused, ink when not) with a paper wedge at its left, an upper-case
   * tracked display title, square title buttons, and an ink frame. No wash,
   * gradient, or glow; the compositor draws the hard block shadow.
   */
  private renderChrome(
    commands: unknown[], sid: string, w: number, h: number, tbh: number, focused: boolean,
  ): void {
    const theme = this.theme;
    const shape = shapeOf(theme);

    if (!this.transparent) {
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: 0, width: w, height: h, fill: theme.windowBg },
      });
    }

    if (!this.chromeless) {
      // Focused: a solid red band with the paper stripe. Resting windows
      // recede to a quiet band in the title-bar tone with muted type and a
      // red stripe, so one red band on screen always marks the focus.
      const band = focused ? theme.accent : theme.titleBarBg;
      const bandText = focused ? theme.actionText : theme.textSecondary;
      commands.push({ type: 'rect', surfaceId: sid, params: { x: 0, y: 0, width: w, height: tbh, fill: band } });

      // The eye sigil: a ring with a phosphor slit pupil, watching from the
      // corner of every window (the thing the poster contains).
      const ex = 19;
      const ey = tbh / 2;
      commands.push({
        type: 'circle', surfaceId: sid,
        params: { cx: ex, cy: ey, radius: 8, stroke: focused ? bandText : theme.accent, lineWidth: 2 },
      });
      commands.push({
        type: 'ellipse', surfaceId: sid,
        params: { cx: ex, cy: ey, radiusX: 2, radiusY: 5.5, fill: theme.accentSecondary },
      });

      const centers = this.titleButtonCenters();
      const btnSize = theme.titleButtonSize;
      const iconSize = theme.titleButtonIconSize;
      const cy = tbh / 2;

      // Title: upper-case display face with tracking, clipped short of the
      // button cluster so long titles never run under the buttons.
      const titleRight = Math.max(0, centers.help - btnSize / 2 - 6);
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({ type: 'clip', surfaceId: sid, params: { x: 0, y: 0, width: titleRight, height: tbh } });
      commands.push({ type: 'letterSpacing', surfaceId: sid, params: { value: `${shape.titleTracking}px` } });
      commands.push({
        type: 'text',
        surfaceId: sid,
        params: {
          x: 32, y: cy,
          text: chromeCase(theme, bandTitle(this.title)), font: titleFont(theme), fill: bandText, baseline: 'middle',
        },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });

      // Square buttons. Hover lays a paper plate under an ink icon; close
      // hover inverts against the band instead (red on ink, ink on red).
      const drawButton = (kind: TitleButtonKind, icon: 'close' | 'minimize' | 'maximize' | 'restore' | 'help') => {
        const cx = centers[kind];
        const hovered = this.hoveredTitleButton === kind;
        let iconColor = bandText;
        if (hovered) {
          const plate = kind === 'close'
            ? (focused ? theme.textPrimary : theme.accent)
            : (focused ? theme.titleButtonHoverBg : theme.windowBg);
          iconColor = kind === 'close'
            ? (focused ? theme.windowBg : theme.actionText)
            : theme.textPrimary;
          commands.push({
            type: 'rect',
            surfaceId: sid,
            params: { x: Math.round(cx - btnSize / 2), y: Math.round(cy - btnSize / 2), width: btnSize, height: btnSize, fill: plate },
          });
        }
        commands.push(...iconCommands(icon, {
          surfaceId: sid,
          x: cx - iconSize / 2,
          y: cy - iconSize / 2,
          size: iconSize,
          color: iconColor,
          lineWidth: Math.max(1.5, iconSize / 8),
          caps: shape.iconCaps,
        }));
      };
      drawButton('help', 'help');
      drawButton('minimize', 'minimize');
      drawButton('maximize', this.maximized ? 'restore' : 'maximize');
      drawButton('close', 'close');
    }

    if (!this.transparent) {
      // Resting windows take a quieter frame so the focused one leads.
      const frame = focused || this.chromeless ? theme.windowBorder : theme.textTertiary;
      commands.push(...inkFrame(sid, { x: 0, y: 0, width: w, height: h }, frame, shape.ruleWidth));
    }
  }

  private async renderWindowInner(): Promise<void> {
    const sid = this.surfaceId!;
    const w = this.rect.width;
    const h = this.rect.height;
    const tbh = this.theme.titleBarHeight;
    const focused = this.windowFocused;
    const tokens = this.theme.tokens;
    const commands: unknown[] = [];

    // Clear
    commands.push({ type: 'clear', surfaceId: sid, params: {} });

    // Windows stay fully opaque; focus is carried by the title band (accent
    // when focused, quiet otherwise) and the compositor's print shadow.
    commands.push({ type: 'save', surfaceId: sid, params: {} });
    this.renderChrome(commands, sid, w, h, tbh, focused);

    // (The print shadow, living-light rim and aura are drawn by the
    // compositor around the slab, so they can extend beyond the window edges.)

    // Resize grip — vector icon in the bottom-right corner
    if (this.resizable) {
      const gripSize = 14;
      commands.push(...iconCommands('resize', {
        surfaceId: sid,
        x: w - gripSize - 2,
        y: h - gripSize - 2,
        size: gripSize,
        color: focused ? this.theme.resizeGrip : this.theme.divider,
        lineWidth: 1.25,
        caps: shapeOf(this.theme).iconCaps,
      }));
    }

    // Render children in parallel — request draw commands from each child widget (Morphic drawOn:)
    const childResults = await Promise.all(
      this.children.map(async (childId) => {
        const childRect = this.childRects.get(childId);
        if (!childRect) return null;
        const ox = childRect.x;
        const oy = this.chromeless ? childRect.y : childRect.y + TITLE_BAR_HEIGHT;
        try {
          return await this.request<unknown[]>(
            request(this.id, childId, 'render', { surfaceId: sid, ox, oy })
          );
        } catch {
          return null;
        }
      })
    );
    for (const childCmds of childResults) {
      if (Array.isArray(childCmds)) commands.push(...childCmds);
    }

    // Close the open-fade wrapper opened at the top of this render.
    commands.push({ type: 'restore', surfaceId: sid, params: {} });

    // Window may have been destroyed mid-render (e.g., destroy arrived
    // re-entrantly during a child render await).
    if (this.destroying || !this.surfaceId) return;

    // Draw all commands to surface
    await this.request<boolean>(
      request(this.id, this.uiServerId, 'draw', { commands })
    );
  }

  // ── Input Handling (Morphic event dispatch) ──────────────────────────

  private async handleInputEvent(inputEvent: {
    type: string;
    surfaceId?: string;
    x?: number;
    y?: number;
    button?: number;
    key?: string;
    code?: string;
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
    deltaX?: number;
    deltaY?: number;
    pasteText?: string;
  }): Promise<void> {
    if (inputEvent.type === 'mousedown') {
      await this.handleMouseDown(inputEvent);
    } else if (inputEvent.type === 'mousemove') {
      await this.handleMouseMove(inputEvent);
    } else if (inputEvent.type === 'mouseup') {
      await this.handleMouseUp(inputEvent);
    } else if (inputEvent.type === 'keydown') {
      await this.handleKeyDown(inputEvent);
    } else if (inputEvent.type === 'wheel') {
      await this.handleWheel(inputEvent);
    } else if (inputEvent.type === 'paste') {
      await this.handlePaste(inputEvent.pasteText ?? '');
    } else if (inputEvent.type === 'mouseleave') {
      await this.handleMouseLeave();
    }
  }

  private async handleMouseLeave(): Promise<void> {
    if (this.hoveredTitleButton) {
      this.hoveredTitleButton = undefined;
      this.syncChromeTip();
      this.scheduleFrame();
    }
    // Send mouseleave to hovered child
    if (this.hoveredChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.hoveredChildId, 'handleInput', {
            type: 'mouseleave',
          })
        );
      } catch {
        // Widget gone
      }
      this.hoveredChildId = undefined;
    }
    // Send mouseleave to focused layout child (stops drag-selection forwarding)
    if (this.focusedParentChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedParentChildId, 'handleInput', {
            type: 'mouseleave',
          })
        );
      } catch {
        // Widget gone
      }
      this.focusedParentChildId = undefined;
    }
  }

  private async handleMouseDown(e: { x?: number; y?: number }): Promise<void> {
    this.dropChromeTip();  // a press acts now; its tooltip has said its piece
    const localX = e.x ?? 0;
    const localY = e.y ?? 0;

    // Content-area coordinates
    const cx = localX;
    const cy = this.chromeless ? localY : localY - TITLE_BAR_HEIGHT;

    // First check expanded selects (highest priority in hit-test)
    for (const childId of this.expandedSelects) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      // Forward to the expanded select widget — let it handle dropdown hit-test
      try {
        const result = await this.request<{ consumed: boolean }>(
          request(this.id, childId, 'handleInput', {
            type: 'mousedown', x: cx, y: cy,
          })
        );
        if (result.consumed) {
          this.scheduleFrame();
          return;
        }
      } catch {
        // Widget gone
      }
    }

    // Unfocus previous widget
    if (this.focusedChildId) {
      try {
        await this.request(
          request(this.id, this.focusedChildId, 'setFocused', { focused: false })
        );
      } catch {
        // Widget gone
      }
      this.focusedChildId = undefined;
      this.focusedParentChildId = undefined;
    }

    // Hit-test children
    let childConsumed = false;
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        try {
          const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
            request(this.id, childId, 'handleInput', {
              type: 'mousedown', x: cx, y: cy,
            })
          );
          if (result.consumed) {
            childConsumed = true;
            // Use focusWidgetId if returned (layout routing), otherwise the child itself
            const focusTarget = result.focusWidgetId ?? childId;
            this.focusedChildId = focusTarget;
            this.focusedParentChildId = childId;
            await this.request(
              request(this.id, focusTarget, 'setFocused', { focused: true })
            );
          }
        } catch {
          // Widget gone
        }
        break;
      }
    }

    // If no child consumed the click and this window is draggable,
    // request a drag from UIServer (two-phase grab for chromeless+draggable windows)
    if (!childConsumed && this.draggable) {
      this.send(
        event(this.id, this.uiServerId, 'requestDrag', {
          surfaceId: this.surfaceId,
        })
      );
    }

    this.scheduleFrame();
  }

  private async handleMouseMove(e: { surfaceId?: string; x?: number; y?: number }): Promise<void> {
    // Content-area coordinates
    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    // Compute global coordinates for child widgets
    const globalX = this.rect.x + (e.x ?? 0);
    const globalY = this.rect.y + (e.y ?? 0);

    // Title-bar button hover plates.
    if (!this.chromeless) {
      const hit = this.titleButtonAt(e.x ?? 0, e.y ?? 0);
      if (hit !== this.hoveredTitleButton) {
        this.hoveredTitleButton = hit;
        this.syncChromeTip();
        this.scheduleFrame();
      }
    }

    // Forward mousemove to expanded selects for hover
    for (const childId of this.expandedSelects) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, childId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }

    // Hit-test children to forward mousemove/mouseleave for hover tracking
    let hitChildId: AbjectId | undefined;
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        hitChildId = childId;
        break;
      }
    }

    if (hitChildId !== this.hoveredChildId) {
      // Send mouseleave to old hovered child
      if (this.hoveredChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
      }

      this.hoveredChildId = hitChildId;

      // Send mousemove to new child
      if (hitChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, hitChildId, 'handleInput', {
              type: 'mousemove', x: cx, y: cy, globalX, globalY,
            })
          );
        } catch {
          // Widget gone
        }
      }
    } else if (hitChildId) {
      // Same child — forward mousemove with local coords
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, hitChildId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }

    // Forward mousemove to the parent layout of the focused child even when
    // the cursor is outside its bounds (supports drag-selection)
    if (this.focusedParentChildId && this.focusedParentChildId !== hitChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedParentChildId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }
  }

  private async handleMouseUp(e: { x?: number; y?: number }): Promise<void> {
    // Forward mouseup to focused child so it can end drag-selection
    if (this.focusedChildId) {
      const cx = e.x ?? 0;
      const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedChildId, 'handleInput', {
            type: 'mouseup', x: cx, y: cy,
          })
        );
      } catch {
        // Widget gone
      }
    }
  }

  private async handleKeyDown(e: {
    key?: string;
    code?: string;
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  }): Promise<void> {
    if (!this.focusedChildId) return;

    try {
      const result = await this.request<{ consumed: boolean }>(
        request(this.id, this.focusedChildId, 'handleInput', {
          type: 'keydown', key: e.key, code: e.code, modifiers: e.modifiers,
        })
      );

      // Event bubbling — if child didn't consume, Window handles
      if (!result.consumed) {
        if (e.key === 'Tab') {
          await this.focusNextWidget();
        } else if (e.key === 'Escape' && this.chromeless) {
          // Chromeless windows are used for modals/popups (palette, switcher,
          // toasts). Esc dismisses them by reusing the existing close path,
          // which WidgetManager forwards to the window's owner.
          this.changed('windowCloseRequested', {});
        } else {
          // Bubble any other unhandled key to the window's owner so it can
          // implement app-level keyboard navigation (e.g. the command palette
          // moving its selection with the arrow keys). Owners that don't
          // register a 'keyUnhandled' handler simply ignore it.
          this.changed('keyUnhandled', { key: e.key, code: e.code, modifiers: e.modifiers });
        }
      }
    } catch {
      // Widget gone
    }
  }

  private async handleWheel(e: {
    x?: number;
    y?: number;
    deltaY?: number;
  }): Promise<void> {
    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    // Find child under cursor
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, childId, 'handleInput', {
              type: 'wheel', x: cx, y: cy, deltaY: e.deltaY,
            })
          );
        } catch {
          // Widget gone
        }
        return;
      }
    }
  }

  private async handlePaste(pasteText: string): Promise<void> {
    if (!pasteText || !this.focusedChildId) return;

    try {
      await this.request<{ consumed: boolean }>(
        request(this.id, this.focusedChildId, 'handleInput', {
          type: 'paste', pasteText,
        })
      );
    } catch {
      // Widget gone
    }
  }

  // ── Focus Management ──────────────────────────────────────────────────

  /**
   * Move focus to a specific child widget. Caller-supplied parentChildId
   * identifies the window's direct child (typically a layout) that contains
   * the target — needed because we don't track nesting from the outside.
   * Used by chromeless modal Abjects (CommandPalette, WindowSwitcher) that
   * want to autofocus their search input on open.
   */
  private async focusChildWidget(widgetId: AbjectId, parentChildId: AbjectId, via?: 'keyboard' | 'mouse'): Promise<void> {
    if (this.focusedChildId && this.focusedChildId !== widgetId) {
      try {
        await this.request(
          request(this.id, this.focusedChildId, 'setFocused', { focused: false }),
        );
      } catch { /* widget gone */ }
    }
    this.focusedChildId = widgetId;
    this.focusedParentChildId = parentChildId;
    try {
      await this.request(
        request(this.id, widgetId, 'setFocused', { focused: true, via: via ?? 'mouse' }),
      );
    } catch { /* widget gone */ }
    this.scheduleFrame();
  }

  private async focusNextWidget(): Promise<void> {
    if (!this.focusedChildId) return;

    // Get flat list of focusable widgets (supports layouts via getFocusableWidgets)
    const focusableWidgets = await this.getFocusableWidgetList();
    if (focusableWidgets.length === 0) return;

    const idx = focusableWidgets.indexOf(this.focusedChildId);
    if (idx === -1) return;

    // Try the next focusable widget in order
    for (let i = 1; i < focusableWidgets.length; i++) {
      const nextId = focusableWidgets[(idx + i) % focusableWidgets.length];
      if (nextId === this.focusedChildId) break;

      // Unfocus current
      try {
        await this.request(
          request(this.id, this.focusedChildId, 'setFocused', { focused: false })
        );
      } catch {
        // Widget gone
      }

      // Focus next — Tab is keyboard-driven, so opt in to focus-visible.
      this.focusedChildId = nextId;
      try {
        await this.request(
          request(this.id, nextId, 'setFocused', { focused: true, via: 'keyboard' })
        );
      } catch {
        // Widget gone
      }

      this.scheduleFrame();
      return;
    }
  }

  /**
   * Get a flat list of all focusable widgets across all children,
   * recursing into layout children via getFocusableWidgets.
   */
  private async getFocusableWidgetList(): Promise<AbjectId[]> {
    const result: AbjectId[] = [];
    for (const childId of this.children) {
      try {
        const nested = await this.request<AbjectId[]>(
          request(this.id, childId, 'getFocusableWidgets', {})
        );
        if (Array.isArray(nested) && nested.length > 0) {
          result.push(...nested);
          continue;
        }
      } catch {
        // Not a layout — treat as regular widget
      }
      result.push(childId);
    }
    return result;
  }

  /**
   * Update children rects on window resize. For layout children,
   * send the full content area rect. For non-layout children, keep existing rects.
   */
  private async updateChildrenOnResize(): Promise<void> {
    const contentW = this.rect.width;
    const contentH = this.rect.height - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      // Update layout children to fill the full content area
      const newRect = {
        x: 0,
        y: 0,
        width: contentW,
        height: contentH,
      };
      this.childRects.set(childId, newRect);

      try {
        await this.request(
          request(this.id, childId, 'update', { rect: newRect })
        );
      } catch {
        // Widget gone
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private async destroyWindow(): Promise<void> {
    this.destroying = true;
    this.shimmerTween?.cancel();
    this.shimmerTween = undefined;
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
    console.debug(`[WindowAbject:${this.id}] destroyWindow — ${this.children.length} children`);
    // Send destroy message to all children (must use request() so the reply
    // is consumed; using send() with a request message causes the reply to
    // fall through as a new handler invocation).
    for (const childId of this.children) {
      try {
        console.debug(`[WindowAbject:${this.id}] destroying child ${childId}`);
        await this.request(request(this.id, childId, 'destroy', {}));
      } catch {
        // Child may already be gone
      }
    }
    this.children = [];
    this.childRects.clear();
    this.expandedSelects.clear();
    this.focusedChildId = undefined;
    this.focusedParentChildId = undefined;

    // Destroy surface
    if (this.surfaceId) {
      console.debug(`[WindowAbject:${this.id}] destroying surface ${this.surfaceId}`);
      await this.request<boolean>(
        request(this.id, this.uiServerId, 'destroySurface', {
          surfaceId: this.surfaceId,
        })
      );
      this.surfaceId = undefined;
    }

    console.debug(`[WindowAbject:${this.id}] calling stop()`);
    await this.stop();
  }
}
