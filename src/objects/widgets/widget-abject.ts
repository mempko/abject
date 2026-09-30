/**
 * WidgetAbject — abstract base class for all widget Abjects.
 *
 * Each widget is a first-class Abject with its own ID, mailbox, handlers,
 * and dependents. Follows Morphic drawOn: protocol — each widget knows
 * how to render itself via draw commands.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceDeclaration,
} from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { request, event } from '../../core/message.js';
import {
  MarkdownImageResolver,
  isAbjectUrl,
  isRemoteUrl,
  parseAbjectUrl,
  imageMimeForPath,
} from './markdown-image-resolver.js';
import { PopoutSurface, windowChannel, type PopoutOptions } from './popout.js';
import {
  Rect,
  WidgetStyle,
  WidgetType,
  ThemeData,
  DEFAULT_THEME,
  WIDGET_INTERFACE,
  fontStacks,
  widgetFont,
  withAlpha,
  inkFrame,
} from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';
import { require as contractRequire, invariant } from '../../core/contracts.js';
import { busyFrameOps, isDarkGround, moveBusyFrameOps, removeSceneGroupOps, type SceneOp } from '../ui-kit.js';

/**
 * A retained 3D decoration a widget hangs on its window around the rect it
 * draws at (window px from the top-left corner). WidgetAbject adds it when
 * the widget draws, moves it when the drawn rect moves, rebuilds it when the
 * size changes, and removes it when the widget is culled, hidden, stops
 * wanting it, or dies. All motion in it is client-side.
 */
export interface WidgetSceneDecoration {
  /** Root node id; unique per widget (prefix it with the widget id). */
  id: string;
  /** Add/animate ops for a rect-centred root group around `rect`. */
  build(rect: Rect): SceneOp[];
}

/**
 * Per-process font-metrics cache for local text measurement. One fetch from
 * the UI server serves every widget in the process; per-word layout measures
 * then run as local char-width sums instead of bus round trips — the
 * dominant cost of markdown reflow during window resizes. The summation
 * mirrors the server's own measureText (per-char widths, 'M' fallback), so
 * local and remote answers agree.
 */
class LocalFontMetrics {
  private fonts = new Map<string, Map<string, number>>();
  private fetchPromise?: Promise<void>;
  private lastFetchAt = 0;
  /** Cap refetch attempts (unknown fonts, headless with no metrics). */
  private static readonly REFETCH_INTERVAL_MS = 10_000;

  /** Local width, or null when this font has no metrics yet. */
  measure(text: string, font: string): number | null {
    const chars = this.fonts.get(font);
    if (!chars) return null;
    const fallback = chars.get('M') ?? 7.5;
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      width += chars.get(text[i]) ?? fallback;
    }
    return width;
  }

  /** Fetch/refresh the table (throttled, single-flight); always resolves. */
  refresh(
    fetcher: () => Promise<{ fonts?: Record<string, Record<string, number>> } | null>,
  ): Promise<void> {
    if (this.fetchPromise) return this.fetchPromise;
    const now = Date.now();
    if (now - this.lastFetchAt < LocalFontMetrics.REFETCH_INTERVAL_MS) return Promise.resolve();
    this.lastFetchAt = now;
    this.fetchPromise = fetcher()
      .then((result) => {
        for (const [font, chars] of Object.entries(result?.fonts ?? {})) {
          let map = this.fonts.get(font);
          if (!map) {
            map = new Map<string, number>();
            this.fonts.set(font, map);
          }
          for (const [ch, w] of Object.entries(chars)) map.set(ch, w);
        }
      })
      .catch(() => { /* keep whatever we have */ })
      .finally(() => { this.fetchPromise = undefined; });
    return this.fetchPromise;
  }
}

const localFontMetrics = new LocalFontMetrics();



// Theme color tokens that may be baked into a WidgetStyle. On a theme change we
// remap any style color matching the OLD theme's token to the NEW theme's
// corresponding token, so colors baked into a widget's style (e.g. a row's
// `background: theme.windowBg`) follow the theme without needing a rebuild.
// `updateTheme` updates `this.theme` but cannot otherwise re-resolve a resolved
// hex back to the token it came from.
const THEME_REMAP_KEYS: Array<keyof ThemeData> = [
  'windowBg', 'titleBarBg', 'buttonBg', 'inputBg', 'selectBg', 'selectHover', 'activeItemBg', 'destructiveBg', 'progressTrack', 'sliderTrack',
  'accent', 'accentSecondary', 'accentTertiary', 'actionBg', 'actionBorder', 'activeItemBorder', 'buttonBorder', 'inputBorder', 'inputBorderFocus', 'windowBorder', 'divider', 'destructiveBorder',
  'textPrimary', 'textSecondary', 'textTertiary', 'buttonText', 'actionText', 'destructiveText', 'textHeading', 'textDescription', 'textMeta', 'sectionLabel', 'linkColor',
  'statusSuccess', 'statusError', 'statusErrorBright', 'statusWarning', 'statusNeutral', 'statusInfo',
];

/** The WidgetStyle fields that carry theme colours. */
type StyleColorField = 'background' | 'color' | 'borderColor';
const STYLE_COLOR_FIELDS: StyleColorField[] = ['background', 'color', 'borderColor'];

/**
 * Which tokens a field most likely came from, tried first when a colour
 * matches several tokens. Palettes share values (Agitprop's ink is its
 * textPrimary, its accentSecondary and every border), so a bare value
 * match is ambiguous: text reaches for text tokens, fills for surface
 * tokens (then text, for inverted headers), borders for border tokens.
 */
const FIELD_TOKEN_PRIORITY: Record<StyleColorField, Array<keyof ThemeData>> = {
  color: ['textPrimary', 'buttonText', 'textSecondary', 'textTertiary', 'actionText', 'destructiveText', 'textHeading', 'textDescription', 'textMeta', 'sectionLabel', 'linkColor'],
  background: ['windowBg', 'titleBarBg', 'buttonBg', 'inputBg', 'selectBg', 'selectHover', 'activeItemBg', 'destructiveBg', 'progressTrack', 'sliderTrack', 'actionBg', 'textPrimary'],
  borderColor: ['windowBorder', 'inputBorder', 'buttonBorder', 'divider', 'activeItemBorder', 'inputBorderFocus', 'actionBorder', 'destructiveBorder'],
};

/**
 * The theme token a style colour was resolved from, or null for a literal
 * colour (never remapped). Field priority breaks ties between tokens that
 * share a value.
 */
function tokenForColor(color: string, theme: ThemeData, field: StyleColorField): keyof ThemeData | null {
  for (const k of FIELD_TOKEN_PRIORITY[field]) if (theme[k] === color) return k;
  for (const k of THEME_REMAP_KEYS) if (theme[k] === color) return k;
  return null;
}

function remapColor(color: string | undefined, oldT: ThemeData, newT: ThemeData, field: StyleColorField): string | undefined {
  if (!color) return color;
  const token = tokenForColor(color, oldT, field);
  const next = token ? newT[token] : undefined;
  return typeof next === 'string' ? next : color;
}

/** Remap a WidgetStyle's color fields from the old theme's tokens to the new theme's. */
export function remapStyleColors(style: WidgetStyle, oldT: ThemeData, newT: ThemeData): WidgetStyle {
  return {
    ...style,
    background: remapColor(style.background, oldT, newT, 'background'),
    color: remapColor(style.color, oldT, newT, 'color'),
    borderColor: remapColor(style.borderColor, oldT, newT, 'borderColor'),
  };
}

/**
 * Build a CSS font string from a WidgetStyle, selecting the Arcane Grimoire font
 * stack named by `style.fontFamily` (body serif by default).
 */
export function buildFont(style: WidgetStyle, theme?: ThemeData): string {
  const weight = style.fontWeight ?? 'normal';
  const size = style.fontSize ?? 14;
  const stacks = fontStacks(theme);
  const stack =
    style.fontFamily === 'display' ? stacks.display
    : style.fontFamily === 'mono' ? stacks.mono
    : stacks.body;
  return `${weight} ${size}px ${stack}`;
}

/**
 * Widget interface declaration shared by all widget Abjects.
 */
export const WIDGET_INTERFACE_DECL: InterfaceDeclaration = {
  id: WIDGET_INTERFACE,
  name: 'Widget',
  description: 'Widget rendering, input handling, and value access',
  methods: [
    {
      name: 'render',
      description: 'Render widget and return draw commands (Morphic drawOn:)',
      parameters: [
        { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface to draw on' },
        { name: 'ox', type: { kind: 'primitive', primitive: 'number' }, description: 'X offset' },
        { name: 'oy', type: { kind: 'primitive', primitive: 'number' }, description: 'Y offset' },
      ],
      returns: { kind: 'array', elementType: { kind: 'reference', reference: 'DrawCommand' } },
    },
    {
      name: 'getValue',
      description: 'Get the current value of the widget',
      parameters: [],
      returns: { kind: 'primitive', primitive: 'string' },
    },
    {
      name: 'update',
      description: 'Update widget properties',
      parameters: [
        { name: 'updates', type: { kind: 'reference', reference: 'WidgetUpdates' }, description: 'Properties to update' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'setFocused',
      description: 'Set focus state',
      parameters: [
        { name: 'focused', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Focus state' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'handleInput',
      description: 'Process input event, returns whether event was consumed (Morphic event bubbling)',
      parameters: [
        { name: 'input', type: { kind: 'reference', reference: 'InputEvent' }, description: 'Input event' },
      ],
      returns: { kind: 'object', properties: { consumed: { kind: 'primitive', primitive: 'boolean' } } },
    },
    {
      name: 'destroy',
      description: 'Destroy the widget and clean up',
      parameters: [],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
  ],
};

export interface WidgetConfig {
  type: WidgetType;
  rect: Rect;
  text?: string;
  style?: WidgetStyle;
  href?: string;
  ownerId: AbjectId;
  uiServerId: AbjectId;
  theme?: ThemeData;
}

/**
 * Abstract base class for all widget Abjects.
 */
export abstract class WidgetAbject extends Abject {
  /** How long a widget released by clearLayoutChildren waits to be re-added before it destroys itself. */
  static readonly RELEASE_GRACE_MS = 10_000;
  protected rect: Rect;
  protected style: WidgetStyle;
  /** Per colour field: the theme token its colour came from (null = a literal colour). */
  private styleTokens: Partial<Record<StyleColorField, keyof ThemeData | null>> = {};
  protected text: string;
  protected ownerId: AbjectId;
  protected uiServerId: AbjectId;
  protected href: string = '';
  protected focused = false;
  /**
   * Mirrors CSS `:focus-visible` semantics: true only when the widget gained
   * focus or interacted via the keyboard. Mouse-driven focus stays false so
   * a click doesn't paint an accent ring around the clicked target.
   *
   * Subclasses with their own focus indicator (button, text input) override
   * `suppressGenericFocusRing` so we don't double-paint.
   */
  protected focusVisible = false;
  protected disabled = false;
  protected visible = true;

  /**
   * Long-op affordance (Doherty Threshold). Set via `update({ busy: true })`.
   * While true the widget wears the living light: a static frame in its 2D
   * paint, plus a breathing 3D frame with a light running its edge that the
   * browser animates on its own. Turning it on or off costs one repaint, so
   * it suits long-lived status as well as short ops.
   */
  protected busy = false;
  /** Scene decorations in the scene now: root id -> the drawn rect they were built for. */
  private sceneDecoShown = new Map<string, Rect>();
  /** Where the widget last drew and can be seen (window px, clamped to its viewport); null when not drawn. */
  private sceneDecoRect: Rect | null = null;
  /** Rendered since it was last culled, so a cull notice only does work after a draw. */
  private drawnSinceCull = false;
  /** The window scene decorations hang on (asked up the owner chain on first need). */
  private sceneWindowId?: AbjectId;
  /** 'idle' until first needed; 'failed' when the window refused a batch (the 2D look stays). */
  private sceneWindowState: 'idle' | 'resolving' | 'ready' | 'failed' | 'stopped' = 'idle';
  /** Layouts (and other containers) that hold this widget now, told by event. */
  private holdingLayouts = new Set<AbjectId>();
  /** Pending self-destroy after a clearLayoutChildren released the last hold. */
  private releaseTimer?: ReturnType<typeof setTimeout>;
  protected widgetType: WidgetType;
  protected override theme: ThemeData;


  constructor(config: WidgetConfig) {
    super({
      manifest: {
        name: `${config.type.charAt(0).toUpperCase() + config.type.slice(1)}Widget`,
        description: `${config.type} widget Abject`,
        version: '1.0.0',
        interface: WIDGET_INTERFACE_DECL,
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['widget', config.type],
      },
    });

    this.widgetType = config.type;
    this.rect = { ...config.rect };
    this.style = config.style ? { ...config.style } : {};
    this.styleTokens = {};
    this.text = config.text ?? '';
    this.ownerId = config.ownerId;
    this.href = config.href ?? '';
    this.uiServerId = config.uiServerId;
    this.theme = config.theme ?? DEFAULT_THEME;
    this.syncDisabledVisible();

    this.setupWidgetHandlers();
  }

  /** Render-time snapshot: consistent state across async draw commands. */
  protected _renderText: string = '';
  protected _renderRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  protected _renderStyle: WidgetStyle = {};
  /**
   * Optional viewport clip propagated by scrolling parents (in absolute
   * surface coords). Tall widgets like markdown bubbles use this to skip
   * emitting draw commands for lines outside the visible scroll area.
   */
  protected _renderViewportClip: { top: number; bottom: number } | null = null;
  /** Where the widget last drew (surface and surface-local origin), for showMobileKeyboard. */
  private _lastDrawnAt?: { surfaceId: string; ox: number; oy: number };

  private setupWidgetHandlers(): void {
    this.on('render', async (msg: AbjectMessage) => {
      if (!this.visible) {
        this.noteCulled();
        return [];
      }
      // Snapshot mutable state so buildDrawCommands sees consistent values
      // across await points even when concurrent update handlers modify them.
      this._renderText = this.text;
      this._renderRect = { ...this.rect };
      this._renderStyle = { ...this.style };
      const { surfaceId, ox, oy, viewportClip } = msg.payload as {
        surfaceId: string;
        ox: number;
        oy: number;
        viewportClip?: { top: number; bottom: number };
      };
      this._renderViewportClip = viewportClip ?? null;
      this._lastDrawnAt = { surfaceId, ox, oy };
      const commands = await this.buildDrawCommands(surfaceId, ox, oy);

      // Generic keyboard-focus ring. Drawn AFTER the widget so it always
      // appears on top of the widget's own chrome. Widgets with bespoke
      // focus styles (button, text input) opt out via suppressGenericFocusRing.
      if (
        this.focused &&
        this.focusVisible &&
        !this.disabled &&
        !this.suppressGenericFocusRing()
      ) {
        commands.push(...this.buildFocusRing(surfaceId, ox, oy));
      }

      if (this.busy) {
        commands.push(...this.buildBusyPulse(surfaceId, ox, oy));
      }

      // Retained 3D decorations follow the rect just drawn (sent only when
      // something changed, so a steady repaint costs nothing here).
      this.drawnSinceCull = true;
      this.sceneDecoRect = this.visibleDrawnRect(ox, oy, viewportClip);
      this.syncSceneDecorations();

      return commands;
    });

    // A scrolling ancestor stopped drawing this widget (scrolled out of its
    // viewport) or a hidden container took it off screen. It hears render
    // again when it shows.
    this.on('viewportCulled', async () => {
      this.noteCulled();
      return true;
    });

    this.on('getValue', async () => {
      return this.getWidgetValue();
    });

    this.on('update', async (msg: AbjectMessage) => {
      const updates = msg.payload as Record<string, unknown>;
      const oldVisible = this.visible;
      this.applyCommonUpdates(updates);
      await this.applyUpdate(updates);
      if (this.visible !== oldVisible) {
        if (!this.visible) this.noteCulled();
        this.changed('visibility', this.visible);
      }
      await this.requestRedraw();
      return true;
    });

    this.on('setFocused', async (msg: AbjectMessage) => {
      const { focused, via } = msg.payload as { focused: boolean; via?: 'keyboard' | 'mouse' };
      this.focused = focused;
      // Reset focus-visible on every transition. Default trigger is mouse;
      // an explicit `via: 'keyboard'` opts in to the visible ring.
      this.focusVisible = focused && via === 'keyboard';
      // Tell mobile clients to show/hide the virtual keyboard, and where the
      // field is (surface-local px) so a phone can keep it above the keyboard.
      if (this.wantsMobileKeyboard()) {
        const at = this._lastDrawnAt;
        this.send(request(this.id, this.uiServerId, 'showMobileKeyboard', at && focused
          ? { show: focused, surfaceId: at.surfaceId, rect: { x: at.ox, y: at.oy, width: this.rect.width, height: this.rect.height } }
          : { show: focused }));
      }
      await this.requestRedraw();
      return true;
    });

    this.on('handleInput', async (msg: AbjectMessage) => {
      if (!this.visible) return { consumed: false };
      if (this.disabled && !this.acceptsInputWhenDisabled()) return { consumed: false };
      const input = msg.payload as Record<string, unknown>;

      // Track input modality for the focus-visible heuristic. Keyboard
      // interaction surfaces the ring; mouse interaction hides it.
      if (this.focused) {
        const t = input.type;
        if (t === 'keydown') {
          if (!this.focusVisible) {
            this.focusVisible = true;
            await this.requestRedraw();
          }
        } else if (t === 'mousedown' || t === 'mousemove') {
          if (this.focusVisible) {
            this.focusVisible = false;
            await this.requestRedraw();
          }
        }
      }

      // Open URL in browser when any widget with href is clicked
      if (input.type === 'mousedown' && this.href) {
        this.send(event(this.id, this.uiServerId, 'openUrl', { url: this.href }));
      }

      return this.processInput(input);
    });

    this.on('updateTheme', async (msg: AbjectMessage) => {
      const newTheme = msg.payload as ThemeData;
      // Follow theme changes with colours baked into this widget's style.
      // Each colour field remembers the token it was resolved from (found
      // against the theme that was current when the colour was set), so a
      // round trip through a palette whose tokens share values (Agitprop's
      // ink is both its text and its living light) comes back to the right
      // token instead of whichever shared-value token matched first.
      const next: WidgetStyle = { ...this.style };
      for (const f of STYLE_COLOR_FIELDS) {
        const color = this.style[f];
        if (typeof color !== 'string') continue;
        if (!(f in this.styleTokens)) this.styleTokens[f] = tokenForColor(color, this.theme, f);
        const token = this.styleTokens[f];
        const mapped = token ? newTheme[token] : undefined;
        if (typeof mapped === 'string') next[f] = mapped;
      }
      this.style = next;
      this.theme = newTheme;
      // Rebuild scene decorations on the next draw (colours or rule widths
      // baked from the old theme follow the new one).
      for (const [id, r] of this.sceneDecoShown) this.sceneDecoShown.set(id, { ...r, width: -1 });
      await this.requestRedraw();
      return true;
    });

    this.on('destroy', async () => {
      await this.stop();
      return true;
    });

    // Hold tracking (sent by layouts, see LayoutAbject.tellChildHold). A
    // widget released by clearLayoutChildren destroys itself after a grace
    // period unless some layout attaches it again first, so clearing a pane
    // and rebuilding it with new widgets frees the old ones, while clearing
    // and re-adding the same widgets keeps them.
    this.on('layoutAttached', async (msg: AbjectMessage) => {
      this.holdingLayouts.add(msg.routing.from);
      this.cancelTimer(this.releaseTimer);
      this.releaseTimer = undefined;
      // Layouts learn visibility from changes, so a widget created hidden
      // would keep its share of the space until it toggled once. Say so now,
      // to this holder only (the same notice a visibility change sends).
      if (!this.visible) {
        try {
          this.send(event(this.id, msg.routing.from, 'changed', { aspect: 'visibility', value: false }));
        } catch { /* holder gone */ }
      }
      return true;
    });
    this.on('layoutDetached', async (msg: AbjectMessage) => {
      this.holdingLayouts.delete(msg.routing.from);
      return true;
    });
    this.on('layoutReleased', async (msg: AbjectMessage) => {
      this.holdingLayouts.delete(msg.routing.from);
      if (this.holdingLayouts.size === 0 && this.releaseTimer === undefined) {
        this.releaseTimer = this.setTimer(async () => {
          this.releaseTimer = undefined;
          if (this.holdingLayouts.size === 0) await this.stop();
        }, WidgetAbject.RELEASE_GRACE_MS);
      }
      return true;
    });

    // The bus sends this when one of our events bounced off an unregistered
    // recipient. If that recipient is our owner (window/layout), we are an
    // orphan — the destroy cascade missed us. Self-destruct so animation
    // loops (canvas tweens) stop instead of firing childDirty at
    // the dead owner forever (locally and across peers).
    this.on('recipientGone', async (msg: AbjectMessage) => {
      const { recipient } = msg.payload as { recipient?: AbjectId };
      if (recipient && recipient === this.ownerId) {
        await this.stop();
      }
      return true;
    });

    // Pop-outs (popout.ts): input on a node this widget contributed to its
    // window comes straight back here, and while a pop-out is open the
    // widget listens to its window, which reports focus changes.
    this.on('nodeInput', async (msg: AbjectMessage) => {
      await this.handlePopoutInput((msg.payload ?? {}) as Record<string, unknown>);
      return true;
    });
    this.on('windowFocus', async (msg: AbjectMessage) => {
      const { focused } = (msg.payload ?? {}) as { focused?: boolean };
      await this.handlePopoutWindowFocus(focused === true);
      return true;
    });
  }

  /**
   * Override to return true if this widget should still receive input when disabled.
   * Used by text widgets to allow selection/copy while blocking edits.
   */
  protected acceptsInputWhenDisabled(): boolean {
    return false;
  }

  /**
   * Override to return true if this widget needs the mobile virtual keyboard
   * when focused (e.g. text input, text area).
   */
  protected wantsMobileKeyboard(): boolean {
    return false;
  }

  /**
   * Override to return true when the widget paints its own focus indicator
   * (button, text input). The base class then skips the generic keyboard
   * focus ring so the two don't double up.
   */
  protected suppressGenericFocusRing(): boolean {
    return false;
  }

  /**
   * Input on a scene node this widget contributed to its window (a pop-out,
   * see popout.ts): { type, nodeId, x, y, button?, deltaY?, ... } with x/y in
   * window px. Default: ignored.
   */
  protected async handlePopoutInput(_input: Record<string, unknown>): Promise<void> {
    // No contributed node takes input by default.
  }

  /** The window gained or lost focus (heard while a pop-out listens). Default: ignored. */
  protected async handlePopoutWindowFocus(_focused: boolean): Promise<void> {
    // Nothing to close by default.
  }

  /**
   * A pop-out surface hanging off this widget's window (see popout.ts): a 2D
   * layer that may reach past the window edge, for dropdown lists, tooltips,
   * menus and pickers. Its input arrives at handlePopoutInput; while open, the
   * window's focus changes arrive at handlePopoutWindowFocus.
   */
  protected createPopout(nodeId: string, options?: PopoutOptions): PopoutSurface {
    return new PopoutSurface(windowChannel({
      ask: <T>(to: AbjectId, method: string, payload: unknown, timeoutMs?: number) =>
        this.request<T>(request(this.id, to, method, payload), timeoutMs),
      tell: (to: AbjectId, method: string, payload: unknown) => this.send(request(this.id, to, method, payload)),
      windowId: this.ownerId,
      uiServerId: this.uiServerId,
    }), nodeId, options);
  }

  /**
   * The 2D half of the busy look: a faint static frame in the living light
   * (accentSecondary), drawn once per transition. The motion (a breathing
   * frame and a light running the edge) is the scene decoration from
   * `sceneDecorations()`, animated by the browser, so a busy widget never
   * repaints on a timer. The static frame is also what a screen without 3D
   * shows.
   */
  protected buildBusyPulse(surfaceId: string, ox: number, oy: number): unknown[] {
    return inkFrame(
      surfaceId,
      { x: ox, y: oy, width: this.rect.width, height: this.rect.height },
      withAlpha(this.theme.accentSecondary, 0.2),
      shapeOf(this.theme).ruleWidth,
    );
  }

  // ── Scene decorations (busy light, indeterminate sweeps) ──────────────

  /**
   * The retained 3D decorations this widget wants right now. The base class
   * contributes the busy light; subclasses add their own (call super). Ids
   * must stay stable while a decoration is wanted.
   */
  protected sceneDecorations(): WidgetSceneDecoration[] {
    if (!this.busy) return [];
    const id = `busy-${this.id}`;
    const lineWidth = Math.max(1.5, shapeOf(this.theme).ruleWidth);
    const glow = isDarkGround(this.theme.windowBg);
    return [{ id, build: (rect) => busyFrameOps(id, rect, { lineWidth, glow }) }];
  }

  /**
   * Bring the window's scene in line with `sceneDecorations()` at the rect
   * last drawn: add what is missing, move what moved (same size), rebuild
   * what changed size, remove what is no longer wanted. One batch, sent only
   * when something differs. Synchronous up to the send, so batches keep the
   * order of the state changes that caused them.
   */
  protected syncSceneDecorations(): void {
    const rect = this.visible ? this.sceneDecoRect : null;
    const want = rect ? this.sceneDecorations() : [];
    if (this.sceneWindowState !== 'ready') {
      // Nothing is shown before the window is known; learn it on first need.
      if (want.length > 0 && this.sceneWindowState === 'idle') this.resolveSceneWindow();
      return;
    }
    const wanted = new Set(want.map((d) => d.id));
    contractRequire(wanted.size === want.length, 'sceneDecorations: every decoration needs its own id');
    const ops: SceneOp[] = [];
    for (const id of [...this.sceneDecoShown.keys()]) {
      if (wanted.has(id)) continue;
      ops.push(...removeSceneGroupOps(id));
      this.sceneDecoShown.delete(id);
    }
    for (const d of want) {
      const cur = this.sceneDecoShown.get(d.id);
      const r = rect!;
      if (cur && cur.x === r.x && cur.y === r.y && cur.width === r.width && cur.height === r.height) continue;
      if (cur && cur.width === r.width && cur.height === r.height) {
        ops.push(...moveBusyFrameOps(d.id, r));
      } else {
        if (cur) ops.push(...removeSceneGroupOps(d.id));
        ops.push(...d.build(r));
      }
      this.sceneDecoShown.set(d.id, { ...r });
    }
    if (ops.length === 0) return;
    this.request<boolean>(request(this.id, this.sceneWindowId!, 'scene', { ops, origin: 'topLeft' }))
      .catch(() => {
        // The window refused the batch or is gone: keep the 2D look only.
        this.sceneDecoShown.clear();
        if (this.sceneWindowState === 'ready') this.sceneWindowState = 'failed';
      });
  }

  /**
   * Find the window this widget draws in (the owner, or up through nested
   * layouts), then show whatever decorations are wanted by then. Batches go
   * straight to the window, so they keep their order and still arrive while
   * a parent layout is being torn down. An owner that cannot answer is taken
   * to be the window itself.
   */
  private resolveSceneWindow(): void {
    this.sceneWindowState = 'resolving';
    this.request<AbjectId>(request(this.id, this.ownerId, 'getWindowId', {}), 5000)
      .then((id) => { this.sceneWindowId = typeof id === 'string' && id.length > 0 ? id : this.ownerId; })
      .catch(() => { this.sceneWindowId = this.ownerId; })
      .finally(() => {
        if (this.sceneWindowState !== 'resolving') return; // stopped meanwhile
        this.sceneWindowState = 'ready';
        this.syncSceneDecorations();
      });
  }

  /** The drawn rect clamped to a scrolling ancestor's viewport; null when nothing of it shows. */
  private visibleDrawnRect(ox: number, oy: number, clip?: { top: number; bottom: number }): Rect | null {
    const w = this._renderRect.width;
    const h = this._renderRect.height;
    if (!(w > 0 && h > 0)) return null;
    let top = oy;
    let bottom = oy + h;
    if (clip) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (bottom - top < 2) return null;
    return { x: ox, y: top, width: w, height: bottom - top };
  }

  /** The widget stopped being drawn: drop its scene decorations until it draws again. */
  private noteCulled(): void {
    if (!this.drawnSinceCull) return;
    this.drawnSinceCull = false;
    this.onCulled();
  }

  /**
   * Hook for "no longer drawn" (scrolled out of view, or a hidden container).
   * The base removes this widget's scene decorations; containers extend it
   * to tell their children.
   */
  protected onCulled(): void {
    this.sceneDecoRect = null;
    this.syncSceneDecorations();
  }

  /**
   * Build the generic keyboard-focus ring drawn around the widget rect.
   * Subclasses can override for custom shapes; the default is a flat 2 px
   * frame on the widget edge in the hand's colour (theme.accent), no glow.
   */
  protected buildFocusRing(surfaceId: string, ox: number, oy: number): unknown[] {
    return inkFrame(
      surfaceId,
      { x: ox, y: oy, width: this.rect.width, height: this.rect.height },
      this.theme.accent,
      2,
    );
  }

  /**
   * Apply common updates shared by all widgets.
   */
  private applyCommonUpdates(updates: Record<string, unknown>): void {
    if (updates.text !== undefined) this.text = updates.text as string;
    if (updates.href !== undefined) this.href = updates.href as string;
    if (updates.style !== undefined) {
      const incoming = updates.style as WidgetStyle;
      this.style = { ...this.style, ...incoming };
      // A newly set colour is resolved to its token lazily, against the
      // theme current until the next theme change.
      for (const f of STYLE_COLOR_FIELDS) if (f in incoming) delete this.styleTokens[f];
    }
    if (updates.rect !== undefined) this.rect = updates.rect as Rect;
    // Support top-level visible/disabled as shorthand for style.visible/style.disabled
    if (updates.visible !== undefined) this.style = { ...this.style, visible: updates.visible as boolean };
    if (updates.disabled !== undefined) this.style = { ...this.style, disabled: updates.disabled as boolean };
    if (updates.busy !== undefined) this.setBusy(updates.busy as boolean);
    this.syncDisabledVisible();
  }

  protected override async onStop(): Promise<void> {
    // Take our scene decorations off the window. An event, not a request:
    // teardown never waits on a reply.
    if (this.sceneDecoShown.size > 0 && this.sceneWindowId) {
      const ops = [...this.sceneDecoShown.keys()].flatMap((id) => removeSceneGroupOps(id));
      try {
        this.bus.send(event(this.id, this.sceneWindowId, 'scene', { ops, origin: 'topLeft' }));
      } catch { /* window already gone (its surface took the nodes with it) */ }
    }
    this.sceneDecoShown.clear();
    this.sceneWindowState = 'stopped';
    this.holdingLayouts.clear();
    this.releaseTimer = undefined; // stop() cancels the managed timer itself
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.releaseTimer === undefined || this.holdingLayouts.size === 0,
      'a widget waiting out its release grace is held by no layout');
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    // Off: the light leaves now. On: it appears at the last drawn rect now,
    // and the repaint that follows every update places it exactly.
    this.syncSceneDecorations();
  }

  /**
   * Sync disabled/visible fields from style.
   */
  private syncDisabledVisible(): void {
    if (this.style.disabled !== undefined) this.disabled = this.style.disabled;
    if (this.style.visible !== undefined) this.visible = this.style.visible;
  }

  /**
   * Measure text width. Answers locally from the process-wide font-metrics
   * table whenever possible; a font with no metrics yet triggers one
   * (throttled) table fetch and then falls back to a per-call UIServer
   * request, which itself estimates when no client has reported metrics.
   */
  /**
   * Set when a measureText answer came from the remote path, which may be an
   * estimate. Widgets that cache text layouts clear it before a layout pass
   * and, if it is set afterwards, treat that layout as provisional.
   */
  protected measuredWithoutMetrics = false;

  protected async measureText(surfaceId: string, text: string, font?: string): Promise<number> {
    if (!text) return 0;
    const resolvedFont = font ?? widgetFont(this.theme);

    let width = localFontMetrics.measure(text, resolvedFont);
    if (width !== null) return width;

    await localFontMetrics.refresh(() =>
      this.request<{ fonts?: Record<string, Record<string, number>> }>(
        request(this.id, this.uiServerId, 'getFontMetrics', {})
      ).catch(() => null)
    );
    width = localFontMetrics.measure(text, resolvedFont);
    if (width !== null) return width;

    // The remote answer may be a character-count estimate (no client has
    // reported metrics yet); callers that cache layouts re-measure later.
    this.measuredWithoutMetrics = true;
    return this.request<number>(
      request(this.id, this.uiServerId, 'measureText', {
        surfaceId,
        text,
        font: resolvedFont,
      })
    );
  }

  /**
   * Request parent window to redraw (sends childDirty event).
   */
  protected async requestRedraw(): Promise<void> {
    this.send(event(this.id, this.ownerId, 'childDirty', {
      widgetId: this.id,
    }));
  }

  // ── Markdown image resolution ────────────────────────────────────────
  //
  // Any markdown-rendering widget (LabelWidget bubbles, markdown-mode
  // TextInputWidget) resolves `![](src)` images through a shared resolver:
  // `data:` URIs draw directly, `abject://<typeId>/<path>` references are read
  // from a FileSystem Abject via message passing, and remote http(s) URLs are
  // fetched server-side into a data URI. Resolution is async with a sync cache,
  // matching ImageWidget's fetch→cache→redraw pattern.

  private _imageResolver?: MarkdownImageResolver;

  /** Lazily created per-widget image resolver (cache + async fetch). */
  protected get imageResolver(): MarkdownImageResolver {
    if (!this._imageResolver) {
      this._imageResolver = new MarkdownImageResolver({
        fetchImageSource: (url) => this.fetchImageSource(url),
        onImageResolved: () => {
          this.onImageResolved();
          void this.requestRedraw();
        },
      });
    }
    return this._imageResolver;
  }

  /**
   * Hook fired after an image source resolves. Subclasses that cache a
   * computed layout (e.g. LabelWidget's rich-text layout) override this to
   * invalidate it so the resolved dimensions take effect. Default: no-op.
   */
  protected onImageResolved(): void {
    // Default: no-op (requestRedraw is called by the resolver callback).
  }

  /**
   * Fetch a non-`data:` markdown image source into a drawable data URI.
   * Delegated to by the resolver, which owns classification + caching.
   */
  protected async fetchImageSource(url: string): Promise<string | null> {
    if (isAbjectUrl(url)) return this.fetchAbjectImage(url);
    if (isRemoteUrl(url)) return this.fetchRemoteImage(url);
    return null;
  }

  /** Read `abject://<typeId>/<path>` bytes from the referenced FileSystem Abject. */
  private async fetchAbjectImage(url: string): Promise<string | null> {
    const regId = await this.resolveRegistryId();
    if (!regId) return null;
    for (const { typeId, path } of parseAbjectUrl(url)) {
      let fsId: AbjectId | null = null;
      try {
        fsId = await this.request<AbjectId | null>(
          request(this.id, regId, 'resolveType', { typeId }),
        );
      } catch { fsId = null; }
      if (!fsId) continue;
      try {
        const base64 = await this.request<string>(
          request(this.id, fsId, 'readFileBytes', { path }),
        );
        if (base64) return `data:${imageMimeForPath(path)};base64,${base64}`;
      } catch { /* read failed for a resolved typeId — give up */ }
      return null;
    }
    return null;
  }

  /** Fetch a remote image server-side (HttpClient.getBase64) to avoid tainting. */
  private async fetchRemoteImage(url: string): Promise<string | null> {
    const httpId = await this.discoverDep('HttpClient');
    if (!httpId) return null;
    try {
      const res = await this.request<{ dataUri?: string }>(
        request(this.id, httpId, 'getBase64', { url }),
        20000,
      );
      return res?.dataUri ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Truncate text with ellipsis to fit within maxWidth pixels.
   * Uses binary search to find the longest prefix that fits.
   */
  protected async truncateWithEllipsis(
    surfaceId: string, text: string, maxWidth: number, font?: string,
  ): Promise<string> {
    if (!text) return text;
    const textWidth = await this.measureText(surfaceId, text, font);
    if (textWidth <= maxWidth) return text;
    // If even one char + ellipsis won't fit, just return the original text clipped
    const minTruncated = text.slice(0, 1) + '…';
    const minWidth = await this.measureText(surfaceId, minTruncated, font);
    if (minWidth > maxWidth) return text;
    let lo = 1, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const tw = await this.measureText(surfaceId, text.slice(0, mid) + '…', font);
      if (tw <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // ── Abstract methods subclasses implement ────────────────────────────

  /** Build draw commands for rendering (Morphic drawOn:). */
  protected abstract buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]>;

  /** Process input event, return whether consumed (Morphic event bubbling). */
  protected abstract processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }>;

  /** Get the widget's current value as a string. */
  protected abstract getWidgetValue(): string;

  /** Apply type-specific updates. */
  protected abstract applyUpdate(updates: Record<string, unknown>): void | Promise<void>;
}
