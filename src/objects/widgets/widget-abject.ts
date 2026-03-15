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
  Rect,
  WidgetStyle,
  WidgetType,
  ThemeData,
  MIDNIGHT_BLOOM,
  WIDGET_INTERFACE,
  WIDGET_FONT,
} from './widget-types.js';


/**
 * Build a CSS font string from a WidgetStyle.
 */
export function buildFont(style: WidgetStyle): string {
  const weight = style.fontWeight ?? 'normal';
  const size = style.fontSize ?? 14;
  return `${weight} ${size}px "Inter", system-ui, sans-serif`;
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
  ownerId: AbjectId;
  uiServerId: AbjectId;
  theme?: ThemeData;
}

/**
 * Abstract base class for all widget Abjects.
 */
export abstract class WidgetAbject extends Abject {
  protected rect: Rect;
  protected style: WidgetStyle;
  protected text: string;
  protected ownerId: AbjectId;
  protected uiServerId: AbjectId;
  protected focused = false;
  protected disabled = false;
  protected visible = true;
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
    this.text = config.text ?? '';
    this.ownerId = config.ownerId;
    this.uiServerId = config.uiServerId;
    this.theme = config.theme ?? MIDNIGHT_BLOOM;
    this.syncDisabledVisible();

    this.setupWidgetHandlers();
  }

  private setupWidgetHandlers(): void {
    this.on('render', async (msg: AbjectMessage) => {
      if (!this.visible) return [];
      const { surfaceId, ox, oy } = msg.payload as { surfaceId: string; ox: number; oy: number };
      return this.buildDrawCommands(surfaceId, ox, oy);
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
        await this.changed('visibility', this.visible);
      }
      await this.requestRedraw();
      return true;
    });

    this.on('setFocused', async (msg: AbjectMessage) => {
      const { focused } = msg.payload as { focused: boolean };
      this.focused = focused;
      await this.requestRedraw();
      return true;
    });

    this.on('handleInput', async (msg: AbjectMessage) => {
      if (!this.visible || this.disabled) return { consumed: false };
      const input = msg.payload as Record<string, unknown>;
      return this.processInput(input);
    });

    this.on('updateTheme', async (msg: AbjectMessage) => {
      this.theme = msg.payload as ThemeData;
      await this.requestRedraw();
      return true;
    });

    this.on('destroy', async () => {
      await this.stop();
      return true;
    });
  }

  /**
   * Apply common updates shared by all widgets.
   */
  private applyCommonUpdates(updates: Record<string, unknown>): void {
    if (updates.text !== undefined) this.text = updates.text as string;
    if (updates.style !== undefined) this.style = { ...this.style, ...(updates.style as WidgetStyle) };
    if (updates.rect !== undefined) this.rect = updates.rect as Rect;
    // Support top-level visible/disabled as shorthand for style.visible/style.disabled
    if (updates.visible !== undefined) this.style = { ...this.style, visible: updates.visible as boolean };
    if (updates.disabled !== undefined) this.style = { ...this.style, disabled: updates.disabled as boolean };
    this.syncDisabledVisible();
  }

  /**
   * Sync disabled/visible fields from style.
   */
  private syncDisabledVisible(): void {
    if (this.style.disabled !== undefined) this.disabled = this.style.disabled;
    if (this.style.visible !== undefined) this.visible = this.style.visible;
  }

  /**
   * Measure text width via UIServer message.
   */
  protected async measureText(surfaceId: string, text: string, font?: string): Promise<number> {
    if (!text) return 0;
    return this.request<number>(
      request(this.id, this.uiServerId, 'measureText', {
        surfaceId,
        text,
        font: font ?? WIDGET_FONT,
      })
    );
  }

  /**
   * Request parent window to redraw (sends childDirty event).
   */
  protected async requestRedraw(): Promise<void> {
    await this.send(event(this.id, this.ownerId, 'childDirty', {
      widgetId: this.id,
    }));
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
