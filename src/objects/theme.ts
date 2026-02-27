/**
 * ThemeAbject — stores the active UI theme and broadcasts changes to dependents.
 *
 * All communication is via message passing:
 *   getTheme  → returns the current ThemeData
 *   setTheme  → merges partial theme, persists to Storage, broadcasts themeChanged
 *   resetTheme → resets to MIDNIGHT_BLOOM default
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { ThemeData, MIDNIGHT_BLOOM } from './widgets/widget-types.js';

const THEME_INTERFACE: InterfaceId = 'abjects:theme' as InterfaceId;
const STORAGE_KEY = 'theme:active';

export const THEME_ID = 'abjects:theme' as AbjectId;

export class ThemeAbject extends Abject {
  private currentTheme: ThemeData = { ...MIDNIGHT_BLOOM };
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
            description: 'Theme management — get, set, and reset the UI theme',
            methods: [
              {
                name: 'getTheme',
                description: 'Get the current theme data',
                parameters: [],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
              {
                name: 'setTheme',
                description: 'Merge partial theme data into the current theme, persist, and broadcast',
                parameters: [
                  { name: 'theme', type: { kind: 'reference', reference: 'Partial<ThemeData>' }, description: 'Partial theme to merge' },
                ],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
              {
                name: 'resetTheme',
                description: 'Reset to the default Midnight Bloom theme',
                parameters: [],
                returns: { kind: 'reference', reference: 'ThemeData' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
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
      this.currentTheme = { ...this.currentTheme, ...partial };
      this.applyBodyBackground();
      await this.persistTheme();
      await this.changed('themeChanged', { ...this.currentTheme });
      return { ...this.currentTheme };
    });

    this.on('resetTheme', async () => {
      this.currentTheme = { ...MIDNIGHT_BLOOM };
      this.applyBodyBackground();
      await this.persistTheme();
      await this.changed('themeChanged', { ...this.currentTheme });
      return { ...this.currentTheme };
    });
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    if (this.storageId) {
      try {
        const saved = await this.request<ThemeData | null>(
          request(this.id, this.storageId, 'get', { key: STORAGE_KEY })
        );
        if (saved && typeof saved === 'object' && 'canvasBg' in saved) {
          this.currentTheme = { ...MIDNIGHT_BLOOM, ...saved };
        }
      } catch {
        // Storage not available or key not found — use default
      }
    }

    this.applyBodyBackground();
  }

  private applyBodyBackground(): void {
    if (typeof document !== 'undefined') {
      document.body.style.background = this.currentTheme.canvasBg;
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
    } catch {
      // Storage failure should not break theme operations
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Theme Usage Guide

### Getting the Current Theme

  const theme = await this.call(
    this.dep('Theme'), 'getTheme', {});
  // Returns a ThemeData object with all color and layout fields

### ThemeData Fields

Colors (all strings, e.g. '#1a1b2e'):
  canvasBg, windowBg, titleBarBg, accent,
  textPrimary, textSecondary, textTertiary, textPlaceholder,
  buttonBg, buttonBorder, buttonText,
  inputBg, inputBorder, inputBorderFocus,
  windowBorder, divider, resizeGrip,
  progressTrack, progressFill, cursor,
  checkboxCheckedBg, checkboxBorder, checkmarkColor,
  selectBg, selectHover, selectArrow, selectionBg

Numeric fields:
  windowRadius: number   — border radius for windows
  widgetRadius: number   — border radius for widgets (buttons, inputs)
  titleBarHeight: number — height of window title bars in pixels

### Common Color Mapping
- Background: theme.windowBg (panels), theme.canvasBg (canvas behind windows)
- Text: theme.textPrimary (main), theme.textSecondary (muted), theme.textTertiary (disabled)
- Accents/highlights: theme.accent
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

### Subscribing to Theme Changes

Register as a dependent so you receive live updates when the theme changes:

  await this.call(
    this.dep('Theme'), 'addDependent',
    { dependentId: this.id });

Then handle the change notification:

  async changed(msg) {
    const { aspect, data } = msg.payload;
    if (aspect === 'themeChanged') {
      // data is the full updated ThemeData object
      this._theme = data;
      await this._draw();
    }
  }

### IMPORTANT
- The interface ID is 'abjects:theme' (NOT 'abjects:theme-abject').
- ALWAYS fetch the theme at startup AND subscribe to changes — the theme can change at any time.
- setTheme merges partial data; you do not need to pass the full ThemeData object.
- The changed event sends the complete ThemeData, not just the changed fields.`;
  }
}
