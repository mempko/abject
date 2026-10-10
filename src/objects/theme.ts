/**
 * ThemeAbject — stores the active UI theme and broadcasts changes to dependents.
 *
 * All communication is via message passing:
 *   getTheme        → returns the current ThemeData
 *   setTheme        → merges partial theme, persists, broadcasts themeChanged
 *   resetTheme      → resets to the default preset (Red Sigil)
 *   listPresets     → built-in + user-registered ThemePresets
 *   setThemeById    → swap to a preset by id (atomic, no merge)
 *   getActiveThemeId→ id of the active preset, or 'custom' after setTheme()
 *   registerTheme   → add (or replace) a user preset
 *   unregisterTheme → remove a user preset
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import {
  ThemeData,
  shapeOf,
  ThemePreset,
  BUILTIN_THEME_PRESETS,
  DEFAULT_THEME_ID,
  isBuiltinThemeId,
  getBuiltinThemeById,
  fillThemeDefaults,
} from '../core/theme-data.js';
import { withAlpha } from './widgets/widget-types.js';

/**
 * Deep-merge a partial theme update over the current theme.
 *
 * Why: ThemeData carries a nested `tokens` sub-object. A naive shallow spread
 * would let `setTheme({ tokens: { space: {...} } })` wipe sibling token groups.
 */
function mergeTheme(current: ThemeData, partial: Partial<ThemeData>): ThemeData {
  const next: ThemeData = { ...current, ...partial };
  if (partial.tokens) {
    const t = partial.tokens;
    next.tokens = {
      space:     { ...current.tokens.space,     ...(t.space     ?? {}) },
      type:      { ...current.tokens.type,      ...(t.type      ?? {}) },
      radius:    { ...current.tokens.radius,    ...(t.radius    ?? {}) },
      motion:    { ...current.tokens.motion,    ...(t.motion    ?? {}) },
      easing:    { ...current.tokens.easing,    ...(t.easing    ?? {}) },
      elevation: { ...current.tokens.elevation, ...(t.elevation ?? {}) },
      glow:      { ...current.tokens.glow,      ...(t.glow      ?? {}) },
      surface:   { ...current.tokens.surface,   ...(t.surface   ?? {}) },
      // shape is optional on stored themes: materialize it only when either
      // side has one (shapeOf supplies the design's constants otherwise).
      ...((current.tokens.shape || t.shape)
        ? { shape: { ...shapeOf(current), ...(t.shape ?? {}) } }
        : {}),
    };
  }
  return next;
}

/**
 * A stored theme as a palette of the current design: its colour slots are
 * kept and the structural tokens are rebuilt, so themes saved before the
 * design existed (with their own fonts, radii, and shadows) render in it.
 */
function paletteOnly(stored: ThemeData): ThemeData {
  const { tokens: _tokens, designNotes: _notes, ...colors } = stored;
  return fillThemeDefaults(colors);
}

const THEME_INTERFACE: InterfaceId = 'abjects:theme' as InterfaceId;
const STORAGE_KEY = 'theme:active';
const STORAGE_KEY_ACTIVE_ID = 'theme:active-id';
const STORAGE_KEY_USER_PRESETS = 'theme:user-presets';
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CUSTOM_THEME_ID = 'custom';
/**
 * One-time move off the previous default. Workspaces that were sitting on the
 * old default preset (almost always by inheritance, not choice) switch to the
 * new default once; a later explicit pick of the old preset sticks.
 */
const STORAGE_KEY_DEFAULT_MIGRATION = 'theme:default-migrated-2';
/** Presets that were the default at some point (Arcane Grimoire, then Agitprop). */
const PREVIOUS_DEFAULT_THEME_IDS = new Set(['arcane-grimoire', 'agitprop']);

function defaultTheme(): ThemeData {
  return { ...getBuiltinThemeById(DEFAULT_THEME_ID)! };
}

export const THEME_ID = 'abjects:theme' as AbjectId;

export class ThemeAbject extends Abject {
  private currentTheme: ThemeData = defaultTheme();
  private activeThemeId: string = DEFAULT_THEME_ID;
  private userPresets: Map<string, ThemePreset> = new Map();
  private storageId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Theme',
        description: 'Stores the active UI theme and broadcasts changes to dependents via message passing',
        version: '1.0.0',
        interface: {
            id: THEME_INTERFACE,
            name: 'Theme',
            description: 'Theme management — get, set, switch presets, and register custom themes',
            methods: [
              {
                name: 'getTheme',
                description: 'Get the current theme data',
                parameters: [],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
              {
                name: 'setTheme',
                description: 'Merge partial theme data into the current theme, persist, and broadcast. Sets active theme id to "custom".',
                parameters: [
                  { name: 'theme', type: { kind: 'reference', reference: 'Partial<ThemeData>' }, description: 'Partial theme to merge' },
                ],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
              {
                name: 'resetTheme',
                description: 'Reset to the default theme (Red Sigil)',
                parameters: [],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
              {
                name: 'listPresets',
                description: 'List all available theme presets, built-in and user-registered',
                parameters: [],
                returns: { kind: 'reference', reference: 'ThemePreset[]' },
              },
              {
                name: 'setThemeById',
                description: 'Activate a preset by id (atomic swap, no merge). Errors if id is unknown.',
                parameters: [
                  { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Preset id (e.g. "midnight-bloom")' },
                ],
                returns: { kind: 'reference', reference: '{ id: string, theme: ThemeData }' },
              },
              {
                name: 'getActiveThemeId',
                description: 'Get the id of the active preset, or "custom" if setTheme has been used since the last preset selection',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'registerTheme',
                description: 'Register or replace a user theme preset. Built-in ids are immutable. Missing colour slots are filled from the default theme so partial themes still render.',
                parameters: [
                  { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Stable kebab-case id (e.g. "forest")' },
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable name shown in the picker' },
                  { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'One-line description' },
                  { name: 'theme', type: { kind: 'reference', reference: 'Partial<ThemeData>' }, description: 'Theme colours; missing fields are filled from the default theme' },
                ],
                returns: { kind: 'reference', reference: 'ThemePreset' },
              },
              {
                name: 'unregisterTheme',
                description: 'Remove a user theme preset. Built-in presets cannot be removed. If the removed preset is active, falls back to the default.',
                parameters: [
                  { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Preset id to remove' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        tags: ['system', 'ui', 'theme'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('getTheme', async () => {
      return { ...this.currentTheme };
    });

    this.on('setTheme', async (msg: AbjectMessage) => {
      const partial = msg.payload as Partial<ThemeData>;
      // Colours merge; structure stays the design's (fillThemeDefaults runs
      // the result through palette()).
      this.currentTheme = fillThemeDefaults(mergeTheme(this.currentTheme, partial));
      this.activeThemeId = CUSTOM_THEME_ID;
      this.applyBodyBackground();
      await this.persistTheme();
      this.changed('themeChanged', { ...this.currentTheme });
      return { ...this.currentTheme };
    });

    this.on('resetTheme', async () => {
      this.currentTheme = defaultTheme();
      this.activeThemeId = DEFAULT_THEME_ID;
      this.applyBodyBackground();
      await this.persistTheme();
      this.changed('themeChanged', { ...this.currentTheme });
      return { ...this.currentTheme };
    });

    this.on('listPresets', async () => {
      return this.allPresets();
    });

    this.on('setThemeById', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      contractRequire(typeof id === 'string' && id.length > 0, 'setThemeById: id is required');

      const preset = this.findPreset(id);
      contractRequire(preset !== undefined, `setThemeById: unknown preset id "${id}"`);

      this.currentTheme = { ...preset!.theme };
      this.activeThemeId = preset!.id;
      this.applyBodyBackground();
      await this.persistTheme();
      this.changed('themeChanged', { ...this.currentTheme });
      return { id: preset!.id, theme: { ...this.currentTheme } };
    });

    this.on('getActiveThemeId', async () => {
      return this.activeThemeId;
    });

    this.on('registerTheme', async (msg: AbjectMessage) => {
      const { id, name, description, theme } = msg.payload as {
        id: string;
        name: string;
        description?: string;
        theme: Partial<ThemeData>;
      };

      contractRequire(typeof id === 'string' && KEBAB_CASE.test(id),
        'registerTheme: id must be non-empty kebab-case (e.g. "forest" or "deep-ocean")');
      contractRequire(!isBuiltinThemeId(id),
        `registerTheme: id "${id}" collides with a built-in preset; built-ins are immutable`);
      contractRequire(typeof name === 'string' && name.length > 0,
        'registerTheme: name is required');
      contractRequire(theme && typeof theme === 'object',
        'registerTheme: theme must be an object');
      contractRequire(typeof theme.canvasBg === 'string'
        && typeof theme.windowBg === 'string'
        && typeof theme.titleBarBg === 'string'
        && typeof theme.accent === 'string'
        && typeof theme.textPrimary === 'string',
        'registerTheme: theme must include canvasBg, windowBg, titleBarBg, accent, textPrimary');

      const preset: ThemePreset = {
        id,
        name,
        description: typeof description === 'string' ? description : '',
        builtin: false,
        theme: fillThemeDefaults(theme),
      };

      this.userPresets.set(id, preset);
      await this.persistUserPresets();
      this.changed('presetsChanged', { presets: this.allPresets() });
      return preset;
    });

    this.on('unregisterTheme', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      contractRequire(typeof id === 'string' && id.length > 0, 'unregisterTheme: id is required');
      contractRequire(!isBuiltinThemeId(id),
        `unregisterTheme: cannot remove built-in preset "${id}"`);

      const removed = this.userPresets.delete(id);
      if (!removed) return false;

      await this.persistUserPresets();

      // If the removed preset was active, fall back to the default and re-broadcast.
      if (this.activeThemeId === id) {
        this.currentTheme = defaultTheme();
        this.activeThemeId = DEFAULT_THEME_ID;
        this.applyBodyBackground();
        await this.persistTheme();
        this.changed('themeChanged', { ...this.currentTheme });
      }

      this.changed('presetsChanged', { presets: this.allPresets() });
      return true;
    });
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    if (this.storageId) {
      // 1. Load any user presets first so setThemeById below can reference them.
      try {
        const savedPresets = await this.request<ThemePreset[] | null>(
          request(this.id, this.storageId, 'get', { key: STORAGE_KEY_USER_PRESETS })
        );
        if (Array.isArray(savedPresets)) {
          for (const p of savedPresets) {
            if (p && typeof p.id === 'string' && !isBuiltinThemeId(p.id) && p.theme) {
              // A theme is a palette of the one design: keep the stored
              // colours, rebuild everything structural.
              this.userPresets.set(p.id, { ...p, builtin: false, theme: paletteOnly(p.theme) });
            }
          }
        }
      } catch {
        // Storage unavailable / bad data — boot with no user presets.
      }

      // 2. Try the active-id path first (preset reference).
      let resolved = false;
      try {
        const savedId = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: STORAGE_KEY_ACTIVE_ID })
        );
        if (typeof savedId === 'string' && savedId !== CUSTOM_THEME_ID) {
          const migrated = await this.request<boolean | null>(
            request(this.id, this.storageId, 'get', { key: STORAGE_KEY_DEFAULT_MIGRATION })
          ).catch(() => null);
          const effectiveId = (PREVIOUS_DEFAULT_THEME_IDS.has(savedId) && !migrated)
            ? DEFAULT_THEME_ID
            : savedId;
          const preset = this.findPreset(effectiveId);
          if (preset) {
            this.currentTheme = { ...preset.theme };
            this.activeThemeId = preset.id;
            resolved = true;
            if (effectiveId !== savedId) await this.persistTheme();
          }
        }
      } catch {
        // fall through to legacy path
      }

      // 3. Fall back to legacy field-merge load. Mark as 'custom' since we
      //    cannot tell which preset (if any) those fields came from.
      if (!resolved) {
        try {
          const saved = await this.request<ThemeData | null>(
            request(this.id, this.storageId, 'get', { key: STORAGE_KEY })
          );
          if (saved && typeof saved === 'object' && 'canvasBg' in saved) {
            this.currentTheme = paletteOnly(saved);
            this.activeThemeId = CUSTOM_THEME_ID;
          }
        } catch {
          // Storage not available or key not found — use default
        }
      }

      // Mark the default migration done for this workspace, so an explicit
      // choice of the previous default from here on is respected.
      try {
        await this.request(
          request(this.id, this.storageId, 'set', { key: STORAGE_KEY_DEFAULT_MIGRATION, value: true })
        );
      } catch {
        // Storage failure: migration re-runs next boot, which is harmless.
      }
    }

    this.applyBodyBackground();
  }

  /** Built-in presets, then user presets in insertion order. */
  private allPresets(): ThemePreset[] {
    return [
      ...BUILTIN_THEME_PRESETS.map((p) => ({ ...p })),
      ...Array.from(this.userPresets.values()).map((p) => ({ ...p })),
    ];
  }

  private findPreset(id: string): ThemePreset | undefined {
    const builtin = BUILTIN_THEME_PRESETS.find((p) => p.id === id);
    if (builtin) return builtin;
    return this.userPresets.get(id);
  }

  private applyBodyBackground(): void {
    if (typeof document !== 'undefined') {
      // Layered abyss, all derived from the active theme so the void tracks the
      // accent palette:
      //   1. Faint rune-dot grid — gives the void a sense of space without
      //      attracting the eye. 26-px pitch with a 1-px dot at low alpha.
      //   2. Soft rune-green + violet sigil blooms rising from below for depth.
      //   3. A vignette that draws the eye inward and deepens the edges.
      //   4. The flat canvas color underneath.
      const rune = this.currentTheme.accent;
      const sigil = this.currentTheme.accentSecondary;
      document.body.style.backgroundImage = [
        `radial-gradient(circle at 1px 1px, ${withAlpha(rune, 0.05)} 1px, transparent 1.6px)`,
        `radial-gradient(ellipse 70% 55% at 50% 108%, ${withAlpha(rune, 0.06)} 0%, transparent 60%)`,
        `radial-gradient(ellipse 45% 45% at 12% 78%, ${withAlpha(sigil, 0.045)} 0%, transparent 55%)`,
        `radial-gradient(ellipse 40% 40% at 88% 70%, ${withAlpha(rune, 0.035)} 0%, transparent 55%)`,
        `radial-gradient(ellipse 120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)`,
      ].join(', ');
      document.body.style.backgroundSize = '26px 26px, auto, auto, auto, auto';
      document.body.style.backgroundColor = this.currentTheme.canvasBg;
    }
  }

  private async persistTheme(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY,
          value: this.currentTheme,
        })
      );
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_ACTIVE_ID,
          value: this.activeThemeId,
        })
      );
    } catch {
      // Storage failure should not break theme operations
    }
  }

  private async persistUserPresets(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: STORAGE_KEY_USER_PRESETS,
          value: Array.from(this.userPresets.values()),
        })
      );
    } catch {
      // Storage failure should not break theme operations
    }
  }

  // Large theming/token reference consulted when styling apps to match the desktop.
  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Theme Usage Guide

### Getting the Current Theme

  const theme = await this.call(
    this.dep('Theme'), 'getTheme', {});
  // Returns a ThemeData object with all color and layout fields

### ThemeData Fields

Base colors (all strings, e.g. '#1a1b2e'):
  canvasBg, windowBg, titleBarBg, accent, accentSecondary, accentTertiary,
  textPrimary, textSecondary, textTertiary, textPlaceholder,
  buttonBg, buttonBorder, buttonText,
  inputBg, inputBorder, inputBorderFocus,
  windowBorder, divider, resizeGrip,
  progressTrack, progressFill, cursor,
  checkboxCheckedBg, checkboxBorder, checkmarkColor,
  selectBg, selectHover, selectArrow, selectionBg

Semantic action buttons:
  actionBg, actionText, actionBorder       — Save, Send, Apply, Connect
  destructiveBg, destructiveText, destructiveBorder — Delete, Block, Remove

Active item highlight:
  activeItemBg, activeItemBorder           — sidebar/list active state

Status indicators:
  statusSuccess    — completed, ready (#a8cc8c)
  statusError      — failed, error (#e05561)
  statusErrorBright — validation error, blocked (#ff6b6b)
  statusWarning    — in-progress, connecting (#9b59ff)
  statusNeutral    — pending, stopped, queued (#6b7084)
  statusInfo       — informational (#5b9bd5)

Semantic text:
  textHeading      — bold headings, object names (#e2e4e9)
  textDescription  — descriptions, body text (#b4b8c8)
  textMeta         — metadata, version, counts (#8b8fa3)
  sectionLabel     — section headers like "Apps", "System" (#6b7084)

Scrollbar:
  scrollbarTrack, scrollbarThumb, scrollbarThumbHover

Shadow:
  shadowColor, dropdownShadow

Numeric fields:
  windowRadius: number   : border radius for windows (0: the design is square)
  widgetRadius: number   : border radius for widgets (0)
  titleBarHeight: number — height of window title bars in pixels

Visual language (the same on every theme; a theme is a colour palette of one design):
  designNotes: string    : prose describing the design; build UI to match it
  tokens.shape           : { shadowStyle, blockShadowOffset, blockShadowColor, blockFocusColor,
                             ruleWidth, titleCase, titleTracking, ornament, iconCaps, backdrop }
  tokens.type.*.font     : the design's font families (display / body / code)
  accent = the human hand (actions, focus, selection); accentSecondary = the living
  light (things alive or thinking), the only colour that glows.

### Common Color Mapping
- Background: theme.windowBg (panels), theme.canvasBg (canvas behind windows)
- Text: theme.textPrimary (main), theme.textSecondary (muted), theme.textTertiary (disabled)
- Headings: theme.textHeading, Descriptions: theme.textDescription, Meta: theme.textMeta
- Accents/highlights: theme.accent (primary accent: red on the default Red Sigil theme), theme.accentSecondary, theme.accentTertiary
- Action buttons: theme.actionBg, theme.actionText, theme.actionBorder
- Destructive buttons: theme.destructiveBg, theme.destructiveText, theme.destructiveBorder
- Active items: theme.activeItemBg, theme.activeItemBorder
- Status: theme.statusSuccess, statusError, statusWarning, statusNeutral, statusInfo
- Buttons: theme.buttonBg, theme.buttonBorder, theme.buttonText
- Inputs: theme.inputBg, theme.inputBorder, theme.inputBorderFocus

### Updating the Theme (partial)

  const updated = await this.call(
    this.dep('Theme'), 'setTheme',
    { accent: '#ff6b6b', buttonBg: '#2a2b3e' });
  // Only pass the fields you want to change — others are preserved

### Resetting to Defaults

  const defaults = await this.call(
    this.dep('Theme'), 'resetTheme', {});

### Switching Between Presets

  const presets = await this.call(
    this.dep('Theme'), 'listPresets', {});
  // Returns: [{ id, name, description, builtin, theme }, ...]
  // Built-ins: ${BUILTIN_THEME_PRESETS.map((p) => (p.id === DEFAULT_THEME_ID ? `${p.id} (default)` : p.id)).join(', ')}

  await this.call(
    this.dep('Theme'), 'setThemeById', { id: 'ocean' });
  // Atomic swap to the named preset; broadcasts themeChanged

  const activeId = await this.call(
    this.dep('Theme'), 'getActiveThemeId', {});
  // Returns the active preset id, or 'custom' after setTheme()

### Registering a User Theme

User themes appear in the Appearance picker alongside built-ins. The id must
be kebab-case and must not collide with a built-in. Missing colour fields are
filled from the default palette, and the theme renders in the system's one
design: a theme is a colour palette.

  await this.call(
    this.dep('Theme'), 'registerTheme', {
      id: 'forest',
      name: 'Forest',
      description: 'Earthy greens and browns',
      theme: {
        canvasBg: '#0a1810',
        windowBg: '#142218',
        titleBarBg: '#1a2c20',
        accent: '#7fc28b',
        textPrimary: '#d8e8d8',
        // any other ThemeData fields you want to override
      },
    });

  await this.call(
    this.dep('Theme'), 'unregisterTheme', { id: 'forest' });
  // If 'forest' was active, the theme falls back to the default (red-sigil).

### Subscribing to Theme Changes

Theme broadcasts changes to all objects via the changed() event. Handle it like this:

  async changed(msg) {
    const { aspect, data } = msg.payload;
    if (aspect === 'themeChanged') {
      // data is the full updated ThemeData object
      this._theme = data;
      await this._draw();
    } else if (aspect === 'presetsChanged') {
      // data is { presets: ThemePreset[] } — refresh any preset lists you show
    }
  }

### IMPORTANT
- The interface ID is 'abjects:theme' (NOT 'abjects:theme-abject').
- ALWAYS fetch the theme at startup AND subscribe to changes — the theme can change at any time.
- setTheme merges partial data; setThemeById is an atomic swap with no merge.
- The themeChanged event sends the complete ThemeData, not just the changed fields.`;
  }
}
