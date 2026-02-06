/**
 * Widget Manager — sophisticated widget toolkit built on UIServer's surface API.
 *
 * Provides createWindow/destroyWindow + 8 widget types: label, button, textInput,
 * checkbox, progress, divider, select, textArea. WidgetManager owns surfaces and
 * handles all rendering and input hit-testing, forwarding high-level widgetEvent
 * messages to the object that created the widget.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request, event } from '../core/message.js';

const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const UI_INTERFACE: InterfaceId = 'abjects:ui';

const TITLE_BAR_HEIGHT = 30;
const WIDGET_FONT = '14px system-ui';
const TITLE_FONT = 'bold 13px system-ui';
const CODE_FONT = '13px monospace';
const DEFAULT_LINE_HEIGHT = 18;
const EDGE_SIZE = 6;

// ── Types ────────────────────────────────────────────────────────────────────

export interface WidgetStyle {
  color?: string;
  background?: string;
  borderColor?: string;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  radius?: number;
}

type WidgetType = 'label' | 'button' | 'textInput' | 'checkbox' | 'progress' | 'divider' | 'select' | 'textArea';

interface WMWindowState {
  id: string;
  surfaceId: string;
  owner: AbjectId;
  title: string;
  rect: { x: number; y: number; width: number; height: number };
  widgets: string[];
  chromeless?: boolean;
  resizable?: boolean;
}

interface WMWidgetState {
  id: string;
  windowId: string;
  type: WidgetType;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
  style: WidgetStyle;
  // textInput / textArea
  placeholder?: string;
  masked?: boolean;
  cursorPos?: number;
  cursorLine?: number;
  cursorCol?: number;
  scrollTop?: number;
  lineHeight?: number;
  monospace?: boolean;
  // checkbox
  checked?: boolean;
  // progress
  value?: number;
  // select
  options?: string[];
  selectedIndex?: number;
  expanded?: boolean;
  hoveredOption?: number;
}

interface WMWidgetEventPayload {
  windowId: string;
  widgetId: string;
  type: 'click' | 'change' | 'submit';
  value?: string;
}

/**
 * WidgetManager — manages windows and widgets on top of UIServer surfaces.
 */
export class WidgetManager extends Abject {
  private uiServerId?: AbjectId;

  private windows: Map<string, WMWindowState> = new Map();
  private widgets: Map<string, WMWidgetState> = new Map();
  private focusedWidget?: string;

  private dragState?: {
    windowId: string;
    type: 'move' | 'resize';
    edge: string;
    startMouseX: number;
    startMouseY: number;
    startRect: { x: number; y: number; width: number; height: number };
  };

  constructor() {
    super({
      manifest: {
        name: 'WidgetManager',
        description:
          'Sophisticated widget toolkit built on UIServer. Provides windows with 8 widget types: label, button, textInput, checkbox, progress, divider, select, textArea.',
        version: '1.0.0',
        interfaces: [
          {
            id: WIDGETS_INTERFACE,
            name: 'Widgets',
            description: 'Window and widget management',
            methods: [
              {
                name: 'createWindow',
                description: 'Create a managed window with title bar chrome',
                parameters: [
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Window title' },
                  { name: 'rect', type: { kind: 'reference', reference: 'Rect' }, description: 'Window position and size' },
                  { name: 'options', type: { kind: 'reference', reference: 'WindowOptions' }, description: 'Optional window settings', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroyWindow',
                description: 'Destroy a window and all its widgets',
                parameters: [
                  { name: 'windowId', type: { kind: 'primitive', primitive: 'string' }, description: 'Window to destroy' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'addWidget',
                description: 'Add a widget to a window',
                parameters: [
                  { name: 'windowId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target window' },
                  { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget identifier' },
                  { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget type: label, button, textInput, checkbox, progress, divider, select, textArea' },
                  { name: 'rect', type: { kind: 'reference', reference: 'Rect' }, description: 'Widget position relative to content area' },
                  { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget text', optional: true },
                  { name: 'style', type: { kind: 'reference', reference: 'WidgetStyle' }, description: 'Widget style', optional: true },
                  { name: 'checked', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Checkbox checked state', optional: true },
                  { name: 'value', type: { kind: 'primitive', primitive: 'number' }, description: 'Progress value (0-1)', optional: true },
                  { name: 'options', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Select options', optional: true },
                  { name: 'selectedIndex', type: { kind: 'primitive', primitive: 'number' }, description: 'Select initial index', optional: true },
                  { name: 'placeholder', type: { kind: 'primitive', primitive: 'string' }, description: 'Placeholder for text inputs', optional: true },
                  { name: 'monospace', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Use monospace font (textArea)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'updateWidget',
                description: 'Update widget properties',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget to update' },
                  { name: 'updates', type: { kind: 'reference', reference: 'WidgetUpdates' }, description: 'Properties to update' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeWidget',
                description: 'Remove a single widget',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget to remove' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getWidgetValue',
                description: 'Get the current value of a text input/area or select widget',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget ID' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'getDisplayInfo',
                description: 'Get display dimensions (proxied from UIServer)',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
            ],
            events: [
              {
                name: 'widgetEvent',
                description: 'Widget interaction event (click, change, submit)',
                payload: { kind: 'reference', reference: 'WMWidgetEventPayload' },
              },
              {
                name: 'windowMoved',
                description: 'Window was dragged by the user',
                payload: {
                  kind: 'object',
                  properties: {
                    windowId: { kind: 'primitive', primitive: 'string' },
                    x: { kind: 'primitive', primitive: 'number' },
                    y: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'windowResized',
                description: 'Window was resized by the user',
                payload: {
                  kind: 'object',
                  properties: {
                    windowId: { kind: 'primitive', primitive: 'string' },
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createWindow', async (msg: AbjectMessage) => {
      const { title, rect, zIndex, chromeless, resizable } = msg.payload as {
        title: string;
        rect: { x: number; y: number; width: number; height: number };
        zIndex?: number;
        chromeless?: boolean;
        resizable?: boolean;
      };
      return this.createWindow(msg.routing.from, title, rect, { chromeless, resizable, zIndex });
    });

    this.on('destroyWindow', async (msg: AbjectMessage) => {
      const { windowId } = msg.payload as { windowId: string };
      return this.destroyWindow(msg.routing.from, windowId);
    });

    this.on('addWidget', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        windowId: string;
        id: string;
        type: WidgetType;
        rect: { x: number; y: number; width: number; height: number };
        text?: string;
        style?: WidgetStyle;
        checked?: boolean;
        value?: number;
        options?: string[];
        selectedIndex?: number;
        placeholder?: string;
        monospace?: boolean;
        masked?: boolean;
      };
      return this.addWidget(msg.routing.from, payload);
    });

    this.on('updateWidget', async (msg: AbjectMessage) => {
      const { widgetId, ...updates } = msg.payload as {
        widgetId: string;
        text?: string;
        style?: WidgetStyle;
        checked?: boolean;
        value?: number;
        options?: string[];
        selectedIndex?: number;
        rect?: { x: number; y: number; width: number; height: number };
        masked?: boolean;
      };
      return this.updateWidget(msg.routing.from, widgetId, updates);
    });

    this.on('removeWidget', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: string };
      return this.removeWidget(msg.routing.from, widgetId);
    });

    this.on('getWidgetValue', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: string };
      return this.getWidgetValue(msg.routing.from, widgetId);
    });

    // Handle raw input events forwarded from UIServer
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

    this.on('getDisplayInfo', async () => {
      require(this.uiServerId !== undefined, 'UIServer not set');
      return this.request<{ width: number; height: number }>(
        request(this.id, this.uiServerId!, UI_INTERFACE, 'getDisplayInfo', {})
      );
    });
  }

  /**
   * Set the UIServer dependency.
   */
  setDependencies(uiServerId: AbjectId): void {
    this.uiServerId = uiServerId;
  }

  // ── UIServer Calls ──────────────────────────────────────────────────────

  private async uiCreateSurface(
    rect: { x: number; y: number; width: number; height: number },
    zIndex?: number
  ): Promise<string> {
    require(this.uiServerId !== undefined, 'UIServer not set');
    return this.request<string>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'createSurface', { rect, zIndex })
    );
  }

  private async uiDestroySurface(surfaceId: string): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'destroySurface', { surfaceId })
    );
  }

  private async uiDraw(commands: unknown[]): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'draw', { commands })
    );
  }

  private async uiMoveSurface(surfaceId: string, x: number, y: number): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'moveSurface', { surfaceId, x, y })
    );
  }

  private async uiFocus(surfaceId: string): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'focus', { surfaceId })
    );
  }

  private async uiMeasureText(surfaceId: string, text: string, font?: string): Promise<number> {
    return this.request<number>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'measureText', { surfaceId, text, font })
    );
  }

  private async uiResizeSurface(surfaceId: string, width: number, height: number): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.uiServerId!, UI_INTERFACE, 'resizeSurface', { surfaceId, width, height })
    );
  }

  // ── Window API ──────────────────────────────────────────────────────────

  private async createWindow(
    owner: AbjectId,
    title: string,
    rect: { x: number; y: number; width: number; height: number },
    options?: { chromeless?: boolean; resizable?: boolean; zIndex?: number }
  ): Promise<string> {
    const surfaceId = await this.uiCreateSurface(rect, options?.zIndex ?? 100);
    await this.uiFocus(surfaceId);

    const windowId = `wm-win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const win: WMWindowState = {
      id: windowId,
      surfaceId,
      owner,
      title,
      rect: { ...rect },
      widgets: [],
      chromeless: options?.chromeless,
      resizable: options?.resizable,
    };
    this.windows.set(windowId, win);

    await this.renderWindow(windowId);
    return windowId;
  }

  private async destroyWindow(owner: AbjectId, windowId: string): Promise<boolean> {
    const win = this.windows.get(windowId);
    if (!win || win.owner !== owner) return false;

    for (const widgetId of win.widgets) {
      if (this.focusedWidget === widgetId) {
        this.focusedWidget = undefined;
      }
      this.widgets.delete(widgetId);
    }

    await this.uiDestroySurface(win.surfaceId);
    this.windows.delete(windowId);
    return true;
  }

  // ── Widget API ──────────────────────────────────────────────────────────

  private async addWidget(
    owner: AbjectId,
    config: {
      windowId: string;
      id: string;
      type: WidgetType;
      rect: { x: number; y: number; width: number; height: number };
      text?: string;
      style?: WidgetStyle;
      checked?: boolean;
      value?: number;
      options?: string[];
      selectedIndex?: number;
      placeholder?: string;
      monospace?: boolean;
      masked?: boolean;
    }
  ): Promise<boolean> {
    const win = this.windows.get(config.windowId);
    if (!win || win.owner !== owner) return false;

    const widget: WMWidgetState = {
      id: config.id,
      windowId: config.windowId,
      type: config.type,
      rect: config.rect,
      text: config.text ?? '',
      style: config.style ?? {},
      placeholder: config.placeholder,
      masked: config.masked,
      cursorPos: 0,
      cursorLine: config.type === 'textArea' ? 0 : undefined,
      cursorCol: config.type === 'textArea' ? 0 : undefined,
      scrollTop: config.type === 'textArea' ? 0 : undefined,
      lineHeight: config.type === 'textArea' ? DEFAULT_LINE_HEIGHT : undefined,
      monospace: config.monospace,
      checked: config.checked ?? false,
      value: config.value ?? 0,
      options: config.options,
      selectedIndex: config.selectedIndex ?? 0,
      expanded: false,
    };

    this.widgets.set(config.id, widget);
    win.widgets.push(config.id);

    await this.renderWindow(config.windowId);
    return true;
  }

  private async updateWidget(
    owner: AbjectId,
    widgetId: string,
    updates: {
      text?: string;
      style?: WidgetStyle;
      checked?: boolean;
      value?: number;
      options?: string[];
      selectedIndex?: number;
      rect?: { x: number; y: number; width: number; height: number };
      masked?: boolean;
    }
  ): Promise<boolean> {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const win = this.windows.get(widget.windowId);
    if (!win || win.owner !== owner) return false;

    if (updates.text !== undefined) {
      widget.text = updates.text;
      if (widget.type === 'textInput') {
        widget.cursorPos = updates.text.length;
      }
    }
    if (updates.style !== undefined) widget.style = { ...widget.style, ...updates.style };
    if (updates.checked !== undefined) widget.checked = updates.checked;
    if (updates.value !== undefined) widget.value = updates.value;
    if (updates.options !== undefined) widget.options = updates.options;
    if (updates.selectedIndex !== undefined) widget.selectedIndex = updates.selectedIndex;
    if (updates.rect !== undefined) widget.rect = updates.rect;
    if (updates.masked !== undefined) widget.masked = updates.masked;

    await this.renderWindow(widget.windowId);
    return true;
  }

  private async removeWidget(owner: AbjectId, widgetId: string): Promise<boolean> {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const win = this.windows.get(widget.windowId);
    if (!win || win.owner !== owner) return false;

    win.widgets = win.widgets.filter((id) => id !== widgetId);
    if (this.focusedWidget === widgetId) {
      this.focusedWidget = undefined;
    }
    this.widgets.delete(widgetId);

    await this.renderWindow(widget.windowId);
    return true;
  }

  private getWidgetValue(owner: AbjectId, widgetId: string): string {
    const widget = this.widgets.get(widgetId);
    if (!widget) return '';

    const win = this.windows.get(widget.windowId);
    if (!win || win.owner !== owner) return '';

    if (widget.type === 'select' && widget.options) {
      return widget.options[widget.selectedIndex ?? 0] ?? '';
    }
    return widget.text;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private buildFont(style: WidgetStyle): string {
    const weight = style.fontWeight ?? 'normal';
    const size = style.fontSize ?? 14;
    return `${weight} ${size}px system-ui`;
  }

  private async renderWindow(windowId: string): Promise<void> {
    const win = this.windows.get(windowId);
    if (!win) return;

    const sid = win.surfaceId;
    const w = win.rect.width;
    const h = win.rect.height;
    const commands: unknown[] = [];

    // Clear
    commands.push({ type: 'clear', surfaceId: sid, params: {} });

    // Window background
    commands.push({
      type: 'rect',
      surfaceId: sid,
      params: { x: 0, y: 0, width: w, height: h, fill: '#1e1e2e', stroke: '#444', radius: 6 },
    });

    if (!win.chromeless) {
      // Title bar
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: 0, width: w, height: TITLE_BAR_HEIGHT, fill: '#2a2a3e', radius: 6 },
      });
      // Cover bottom corners of title bar so they're square
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: TITLE_BAR_HEIGHT - 6, width: w, height: 6, fill: '#2a2a3e' },
      });

      // Title text
      commands.push({
        type: 'text',
        surfaceId: sid,
        params: {
          x: 12,
          y: TITLE_BAR_HEIGHT / 2,
          text: win.title,
          font: TITLE_FONT,
          fill: '#ccc',
          baseline: 'middle',
        },
      });

      // Separator
      commands.push({
        type: 'line',
        surfaceId: sid,
        params: { x1: 0, y1: TITLE_BAR_HEIGHT, x2: w, y2: TITLE_BAR_HEIGHT, stroke: '#444' },
      });
    }

    // Resize grip (bottom-right corner)
    if (win.resizable) {
      commands.push({
        type: 'line',
        surfaceId: sid,
        params: { x1: w - 3, y1: h - 8, x2: w - 8, y2: h - 3, stroke: '#666' },
      });
      commands.push({
        type: 'line',
        surfaceId: sid,
        params: { x1: w - 3, y1: h - 4, x2: w - 4, y2: h - 3, stroke: '#666' },
      });
    }

    // Render widgets
    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (widget) {
        await this.renderWidget(commands, sid, widget, win.chromeless);
      }
    }

    await this.uiDraw(commands);
  }

  private async renderWidget(
    commands: unknown[],
    surfaceId: string,
    widget: WMWidgetState,
    chromeless?: boolean
  ): Promise<void> {
    const ox = widget.rect.x;
    const oy = chromeless ? widget.rect.y : widget.rect.y + TITLE_BAR_HEIGHT;
    const w = widget.rect.width;
    const h = widget.rect.height;
    const style = widget.style;
    const font = this.buildFont(style);
    const radius = style.radius ?? 4;

    switch (widget.type) {
      case 'label':
        if (style.background) {
          commands.push({
            type: 'rect',
            surfaceId,
            params: { x: ox, y: oy, width: w, height: h, fill: style.background, radius },
          });
        }
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: style.align === 'center' ? ox + w / 2 : style.align === 'right' ? ox + w : ox,
            y: oy + h / 2,
            text: widget.text,
            font,
            fill: style.color ?? '#aaa',
            align: style.align ?? 'left',
            baseline: 'middle',
          },
        });
        break;

      case 'button':
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: style.background ?? '#4a4a6e',
            stroke: style.borderColor ?? '#666',
            radius,
          },
        });
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + w / 2,
            y: oy + h / 2,
            text: widget.text,
            font,
            fill: style.color ?? '#eee',
            align: 'center',
            baseline: 'middle',
          },
        });
        break;

      case 'textInput': {
        const focused = this.focusedWidget === widget.id;
        const borderColor = style.borderColor ?? (focused ? '#6a6aff' : '#555');
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: style.background ?? '#151520',
            stroke: borderColor,
            radius,
          },
        });

        commands.push({ type: 'save', surfaceId, params: {} });
        commands.push({
          type: 'clip',
          surfaceId,
          params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
        });

        const displayText = widget.text
          ? (widget.masked ? '\u2022'.repeat(widget.text.length) : widget.text)
          : '';
        const textPadding = 8;

        if (displayText) {
          commands.push({
            type: 'text',
            surfaceId,
            params: {
              x: ox + textPadding,
              y: oy + h / 2,
              text: displayText,
              font: style.fontSize ? font : WIDGET_FONT,
              fill: style.color ?? '#ddd',
              baseline: 'middle',
            },
          });
        } else if (widget.placeholder && !focused) {
          commands.push({
            type: 'text',
            surfaceId,
            params: {
              x: ox + textPadding,
              y: oy + h / 2,
              text: widget.placeholder,
              font: style.fontSize ? font : WIDGET_FONT,
              fill: '#555',
              baseline: 'middle',
            },
          });
        }

        if (focused) {
          const cursorPos = widget.cursorPos ?? 0;
          const beforeCursor = widget.masked
            ? '\u2022'.repeat(cursorPos)
            : widget.text.substring(0, cursorPos);
          const cursorFont = style.fontSize ? font : WIDGET_FONT;
          const measuredWidth = beforeCursor.length > 0
            ? await this.uiMeasureText(surfaceId, beforeCursor, cursorFont)
            : 0;
          const cursorX = ox + textPadding + measuredWidth;
          commands.push({
            type: 'line',
            surfaceId,
            params: {
              x1: cursorX, y1: oy + 4,
              x2: cursorX, y2: oy + h - 4,
              stroke: '#8888ff',
            },
          });
        }

        commands.push({ type: 'restore', surfaceId, params: {} });
        break;
      }

      case 'textArea': {
        const focused = this.focusedWidget === widget.id;
        const borderColor = style.borderColor ?? (focused ? '#6a6aff' : '#555');
        const lineHeight = widget.lineHeight ?? DEFAULT_LINE_HEIGHT;
        const taFont = widget.monospace ? CODE_FONT : (style.fontSize ? font : WIDGET_FONT);

        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: style.background ?? '#151520',
            stroke: borderColor,
            radius,
          },
        });

        commands.push({ type: 'save', surfaceId, params: {} });
        commands.push({
          type: 'clip',
          surfaceId,
          params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
        });

        const textPadding = 8;
        const lines = widget.text.split('\n');
        const scrollTop = widget.scrollTop ?? 0;
        const visibleLines = Math.floor(h / lineHeight);
        const charWidth = widget.monospace ? 7.8 : ((style.fontSize ?? 14) * 0.55);

        for (let i = scrollTop; i < Math.min(lines.length, scrollTop + visibleLines); i++) {
          const lineY = oy + (i - scrollTop) * lineHeight + lineHeight * 0.7;
          commands.push({
            type: 'text',
            surfaceId,
            params: {
              x: ox + textPadding,
              y: lineY,
              text: lines[i],
              font: taFont,
              fill: style.color ?? '#ddd',
              baseline: 'alphabetic',
            },
          });
        }

        if (focused) {
          const cursorLine = widget.cursorLine ?? 0;
          const cursorCol = widget.cursorCol ?? 0;
          if (cursorLine >= scrollTop && cursorLine < scrollTop + visibleLines) {
            const cursorLineText = lines[cursorLine]?.substring(0, cursorCol) ?? '';
            const cursorX = ox + textPadding + (cursorLineText.length > 0
              ? await this.uiMeasureText(surfaceId, cursorLineText, taFont)
              : 0);
            const cursorY = oy + (cursorLine - scrollTop) * lineHeight + 2;
            commands.push({
              type: 'line',
              surfaceId,
              params: {
                x1: cursorX, y1: cursorY,
                x2: cursorX, y2: cursorY + lineHeight - 4,
                stroke: '#8888ff',
              },
            });
          }
        }

        commands.push({ type: 'restore', surfaceId, params: {} });
        break;
      }

      case 'checkbox': {
        const boxSize = 16;
        const boxY = oy + (h - boxSize) / 2;
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: boxY, width: boxSize, height: boxSize,
            fill: widget.checked ? (style.background ?? '#4a4a6e') : 'transparent',
            stroke: style.borderColor ?? '#555',
            radius: 2,
          },
        });

        if (widget.checked) {
          // Checkmark: two angled lines
          const cx = ox;
          const cy = boxY;
          commands.push({
            type: 'line',
            surfaceId,
            params: {
              x1: cx + 3, y1: cy + 8,
              x2: cx + 6, y2: cy + 12,
              stroke: style.color ?? '#fff',
            },
          });
          commands.push({
            type: 'line',
            surfaceId,
            params: {
              x1: cx + 6, y1: cy + 12,
              x2: cx + 13, y2: cy + 4,
              stroke: style.color ?? '#fff',
            },
          });
        }

        // Label text to the right
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + boxSize + 8,
            y: oy + h / 2,
            text: widget.text,
            font,
            fill: style.color ?? '#aaa',
            baseline: 'middle',
          },
        });
        break;
      }

      case 'progress': {
        const trackColor = style.background ?? '#252535';
        const fillColor = style.color ?? '#6a6aff';
        const progressValue = Math.max(0, Math.min(1, widget.value ?? 0));

        // Track
        commands.push({
          type: 'rect',
          surfaceId,
          params: { x: ox, y: oy, width: w, height: h, fill: trackColor, radius },
        });

        // Fill
        if (progressValue > 0) {
          const fillWidth = Math.max(radius * 2, w * progressValue);
          commands.push({
            type: 'rect',
            surfaceId,
            params: { x: ox, y: oy, width: fillWidth, height: h, fill: fillColor, radius },
          });
        }

        // Optional percentage text
        if (widget.text) {
          commands.push({
            type: 'text',
            surfaceId,
            params: {
              x: ox + w / 2,
              y: oy + h / 2,
              text: widget.text,
              font,
              fill: '#eee',
              align: 'center',
              baseline: 'middle',
            },
          });
        }
        break;
      }

      case 'divider': {
        const divColor = style.color ?? '#444';
        if (w > h) {
          // Horizontal
          const midY = oy + h / 2;
          commands.push({
            type: 'line',
            surfaceId,
            params: { x1: ox, y1: midY, x2: ox + w, y2: midY, stroke: divColor },
          });
        } else {
          // Vertical
          const midX = ox + w / 2;
          commands.push({
            type: 'line',
            surfaceId,
            params: { x1: midX, y1: oy, x2: midX, y2: oy + h, stroke: divColor },
          });
        }
        break;
      }

      case 'select': {
        const options = widget.options ?? [];
        const selectedIndex = widget.selectedIndex ?? 0;
        const selectedText = options[selectedIndex] ?? '';

        // Collapsed: looks like a button
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: style.background ?? '#2a2a3e',
            stroke: style.borderColor ?? '#555',
            radius,
          },
        });

        // Selected text
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + 8,
            y: oy + h / 2,
            text: selectedText,
            font,
            fill: style.color ?? '#ddd',
            baseline: 'middle',
          },
        });

        // Down arrow
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: ox + w - 20,
            y: oy + h / 2,
            text: '\u25be',
            font,
            fill: style.color ?? '#888',
            baseline: 'middle',
          },
        });

        // Expanded dropdown
        if (widget.expanded) {
          const optionHeight = h;
          const dropdownH = options.length * optionHeight;

          // Dropdown background
          commands.push({
            type: 'rect',
            surfaceId,
            params: {
              x: ox, y: oy + h, width: w, height: dropdownH,
              fill: style.background ?? '#2a2a3e',
              stroke: style.borderColor ?? '#555',
              radius: 2,
            },
          });

          for (let i = 0; i < options.length; i++) {
            const optY = oy + h + i * optionHeight;
            const isHovered = widget.hoveredOption === i;

            if (isHovered) {
              commands.push({
                type: 'rect',
                surfaceId,
                params: {
                  x: ox + 1, y: optY, width: w - 2, height: optionHeight,
                  fill: '#4a4a6e',
                },
              });
            }

            commands.push({
              type: 'text',
              surfaceId,
              params: {
                x: ox + 8,
                y: optY + optionHeight / 2,
                text: options[i],
                font,
                fill: style.color ?? '#ddd',
                baseline: 'middle',
              },
            });
          }
        }
        break;
      }
    }
  }

  // ── Input Handling ──────────────────────────────────────────────────────

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
      this.handleMouseMove(inputEvent);
    } else if (inputEvent.type === 'mouseup') {
      this.handleMouseUp(inputEvent);
    } else if (inputEvent.type === 'keydown') {
      this.handleKeyDown(inputEvent);
    } else if (inputEvent.type === 'wheel') {
      this.handleWheel(inputEvent);
    } else if (inputEvent.type === 'paste') {
      this.handlePaste(inputEvent.pasteText ?? '');
    }
  }

  private async handleMouseDown(e: { surfaceId?: string; x?: number; y?: number }): Promise<void> {
    if (!e.surfaceId) return;

    const win = this.findWindowBySurface(e.surfaceId);
    if (!win) return;

    const localX = e.x ?? 0;
    const localY = e.y ?? 0;

    // Check resize edges first (higher priority at edges)
    const edge = this.detectResizeEdge(win, localX, localY);
    if (edge) {
      this.dragState = {
        windowId: win.id,
        type: 'resize',
        edge,
        startMouseX: localX + win.rect.x,
        startMouseY: localY + win.rect.y,
        startRect: { ...win.rect },
      };
      return;
    }

    // Title bar drag (non-chromeless only)
    if (!win.chromeless && localY < TITLE_BAR_HEIGHT) {
      this.dragState = {
        windowId: win.id,
        type: 'move',
        edge: '',
        startMouseX: localX + win.rect.x,
        startMouseY: localY + win.rect.y,
        startRect: { ...win.rect },
      };
      return;
    }

    // Content-area coordinates
    const cx = localX;
    const cy = win.chromeless ? localY : localY - TITLE_BAR_HEIGHT;

    // First check if any select is expanded and handle click on dropdown
    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (!widget || widget.type !== 'select' || !widget.expanded) continue;

      const wr = widget.rect;
      const options = widget.options ?? [];
      const optionHeight = wr.height;

      // Click in dropdown area
      if (cx >= wr.x && cx < wr.x + wr.width &&
          cy >= wr.y + wr.height && cy < wr.y + wr.height + options.length * optionHeight) {
        const clickedIndex = Math.floor((cy - wr.y - wr.height) / optionHeight);
        if (clickedIndex >= 0 && clickedIndex < options.length) {
          widget.selectedIndex = clickedIndex;
          widget.expanded = false;
          widget.hoveredOption = undefined;
          this.renderWindow(win.id);
          this.sendWidgetEvent(win.owner, {
            windowId: win.id,
            widgetId: widget.id,
            type: 'change',
            value: options[clickedIndex],
          });
        }
        return;
      }

      // Click outside dropdown — close it
      widget.expanded = false;
      widget.hoveredOption = undefined;
    }

    // Unfocus previous widget
    if (this.focusedWidget) {
      this.focusedWidget = undefined;
    }

    // Hit-test widgets
    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (!widget) continue;

      const wr = widget.rect;
      if (cx >= wr.x && cx < wr.x + wr.width && cy >= wr.y && cy < wr.y + wr.height) {
        switch (widget.type) {
          case 'button':
            this.sendWidgetEvent(win.owner, {
              windowId: win.id,
              widgetId: widget.id,
              type: 'click',
              value: widget.text,
            });
            break;

          case 'textInput':
            this.focusedWidget = widget.id;
            // Position cursor from click X using measured text width
            {
              const clickOffset = cx - wr.x - 8;
              if (widget.text.length > 0 && clickOffset > 0) {
                const displayText = widget.masked ? '\u2022'.repeat(widget.text.length) : widget.text;
                const cursorFont = widget.style.fontSize ? this.buildFont(widget.style) : WIDGET_FONT;
                const totalWidth = await this.uiMeasureText(win.surfaceId, displayText, cursorFont);
                const avgCharWidth = totalWidth / widget.text.length;
                widget.cursorPos = Math.max(0, Math.min(
                  Math.round(clickOffset / avgCharWidth),
                  widget.text.length
                ));
              } else {
                widget.cursorPos = clickOffset <= 0 ? 0 : widget.text.length;
              }
            }
            break;

          case 'textArea':
            this.focusedWidget = widget.id;
            {
              const lineHeight = widget.lineHeight ?? DEFAULT_LINE_HEIGHT;
              const scrollTop = widget.scrollTop ?? 0;
              const lines = widget.text.split('\n');
              const clickLine = Math.min(
                scrollTop + Math.floor((cy - wr.y) / lineHeight),
                lines.length - 1
              );
              const lineText = lines[clickLine] ?? '';
              const clickOffset = cx - wr.x - 8;
              let clickCol = 0;
              if (lineText.length > 0 && clickOffset > 0) {
                const taFont = widget.monospace ? CODE_FONT : (widget.style.fontSize ? this.buildFont(widget.style) : WIDGET_FONT);
                const lineWidth = await this.uiMeasureText(win.surfaceId, lineText, taFont);
                const avgCharWidth = lineWidth / lineText.length;
                clickCol = Math.min(
                  Math.round(clickOffset / avgCharWidth),
                  lineText.length
                );
              }
              widget.cursorLine = Math.max(0, clickLine);
              widget.cursorCol = Math.max(0, clickCol);
            }
            break;

          case 'checkbox':
            widget.checked = !widget.checked;
            this.sendWidgetEvent(win.owner, {
              windowId: win.id,
              widgetId: widget.id,
              type: 'change',
              value: widget.checked ? 'true' : 'false',
            });
            break;

          case 'select':
            widget.expanded = !widget.expanded;
            break;
        }
        break;
      }
    }

    this.renderWindow(win.id);
  }

  private handleMouseMove(e: { surfaceId?: string; x?: number; y?: number }): void {
    if (this.dragState) {
      const win = this.windows.get(this.dragState.windowId);
      if (!win || !e.surfaceId) { this.dragState = undefined; return; }

      // For drag, we get local coords to the surface, so compute global position
      const globalX = (e.x ?? 0) + win.rect.x;
      const globalY = (e.y ?? 0) + win.rect.y;
      const dx = globalX - this.dragState.startMouseX;
      const dy = globalY - this.dragState.startMouseY;

      if (this.dragState.type === 'move') {
        const newX = this.dragState.startRect.x + dx;
        const newY = this.dragState.startRect.y + dy;
        win.rect.x = newX;
        win.rect.y = newY;
        this.uiMoveSurface(win.surfaceId, newX, newY);
      } else {
        // resize
        const sr = this.dragState.startRect;
        let newX = sr.x;
        let newY = sr.y;
        let newW = sr.width;
        let newH = sr.height;
        const dragEdge = this.dragState.edge;

        if (dragEdge.includes('e')) newW = sr.width + dx;
        if (dragEdge.includes('w')) { newW = sr.width - dx; newX = sr.x + dx; }
        if (dragEdge.includes('s')) newH = sr.height + dy;
        if (dragEdge.includes('n')) { newH = sr.height - dy; newY = sr.y + dy; }

        // Enforce minimum size
        if (newW < 100) { if (dragEdge.includes('w')) newX = sr.x + sr.width - 100; newW = 100; }
        if (newH < 60) { if (dragEdge.includes('n')) newY = sr.y + sr.height - 60; newH = 60; }

        const moved = newX !== win.rect.x || newY !== win.rect.y;
        const resized = newW !== win.rect.width || newH !== win.rect.height;

        win.rect.x = newX;
        win.rect.y = newY;
        win.rect.width = newW;
        win.rect.height = newH;

        if (moved) this.uiMoveSurface(win.surfaceId, newX, newY);
        if (resized) this.uiResizeSurface(win.surfaceId, newW, newH);
        if (resized) this.renderWindow(win.id);
      }
      return;
    }

    // Handle hover on expanded select
    if (!e.surfaceId) return;
    const win = this.findWindowBySurface(e.surfaceId);
    if (!win) return;

    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (win.chromeless ? 0 : TITLE_BAR_HEIGHT);

    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (!widget || widget.type !== 'select' || !widget.expanded) continue;

      const wr = widget.rect;
      const options = widget.options ?? [];
      const optionHeight = wr.height;

      if (cx >= wr.x && cx < wr.x + wr.width &&
          cy >= wr.y + wr.height && cy < wr.y + wr.height + options.length * optionHeight) {
        const hoveredIndex = Math.floor((cy - wr.y - wr.height) / optionHeight);
        if (widget.hoveredOption !== hoveredIndex) {
          widget.hoveredOption = hoveredIndex;
          this.renderWindow(win.id);
        }
      }
    }
  }

  private handleMouseUp(_e: { surfaceId?: string; x?: number; y?: number }): void {
    if (this.dragState) {
      const win = this.windows.get(this.dragState.windowId);
      if (win) {
        if (this.dragState.type === 'move') {
          this.sendWindowMovedEvent(win.owner, win.id, win.rect.x, win.rect.y);
        } else {
          this.sendWindowResizedEvent(win.owner, win.id, win.rect.width, win.rect.height);
        }
      }
      this.dragState = undefined;
    }
  }

  private handleKeyDown(e: {
    key?: string;
    code?: string;
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  }): void {
    if (!this.focusedWidget) return;

    const widget = this.widgets.get(this.focusedWidget);
    if (!widget) return;

    if (widget.type === 'textInput') {
      this.handleTextInputKey(widget, e);
    } else if (widget.type === 'textArea') {
      this.handleTextAreaKey(widget, e);
    }
  }

  private handleWheel(e: {
    surfaceId?: string;
    x?: number;
    y?: number;
    deltaY?: number;
  }): void {
    if (!e.surfaceId) return;
    const win = this.findWindowBySurface(e.surfaceId);
    if (!win) return;

    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (win.chromeless ? 0 : TITLE_BAR_HEIGHT);

    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (!widget || widget.type !== 'textArea') continue;

      const wr = widget.rect;
      if (cx >= wr.x && cx < wr.x + wr.width && cy >= wr.y && cy < wr.y + wr.height) {
        const lineHeight = widget.lineHeight ?? DEFAULT_LINE_HEIGHT;
        const totalLines = widget.text.split('\n').length;
        const visibleLines = Math.floor(wr.height / lineHeight);
        const maxScroll = Math.max(0, totalLines - visibleLines);
        let scrollTop = widget.scrollTop ?? 0;
        scrollTop += Math.sign(e.deltaY ?? 0);
        scrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
        widget.scrollTop = scrollTop;
        this.renderWindow(win.id);
        return;
      }
    }
  }

  // ── Text Input Key Handling ─────────────────────────────────────────────

  private handleTextInputKey(
    widget: WMWidgetState,
    e: { key?: string; modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } }
  ): void {
    const key = e.key ?? '';
    const pos = widget.cursorPos ?? 0;

    if (key === 'Backspace') {
      if (pos > 0) {
        widget.text = widget.text.substring(0, pos - 1) + widget.text.substring(pos);
        widget.cursorPos = pos - 1;
        this.rerenderAndEmitChange(widget);
      }
      return;
    }

    if (key === 'Delete') {
      if (pos < widget.text.length) {
        widget.text = widget.text.substring(0, pos) + widget.text.substring(pos + 1);
        this.rerenderAndEmitChange(widget);
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (pos > 0) { widget.cursorPos = pos - 1; this.renderWindow(widget.windowId); }
      return;
    }

    if (key === 'ArrowRight') {
      if (pos < widget.text.length) { widget.cursorPos = pos + 1; this.renderWindow(widget.windowId); }
      return;
    }

    if (key === 'Home') {
      widget.cursorPos = 0;
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'End') {
      widget.cursorPos = widget.text.length;
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'Enter') {
      const win = this.windows.get(widget.windowId);
      if (win) {
        this.sendWidgetEvent(win.owner, {
          windowId: win.id,
          widgetId: widget.id,
          type: 'submit',
          value: widget.text,
        });
      }
      return;
    }

    if (key === 'Tab') {
      this.focusNextWidget(widget);
      return;
    }

    // Printable character
    if (key.length === 1 && !e.modifiers?.ctrl && !e.modifiers?.meta) {
      widget.text = widget.text.substring(0, pos) + key + widget.text.substring(pos);
      widget.cursorPos = pos + 1;
      this.rerenderAndEmitChange(widget);
    }
  }

  // ── Text Area Key Handling ──────────────────────────────────────────────

  private handleTextAreaKey(
    widget: WMWidgetState,
    e: { key?: string; modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean } }
  ): void {
    const key = e.key ?? '';
    const lines = widget.text.split('\n');
    let line = widget.cursorLine ?? 0;
    let col = widget.cursorCol ?? 0;
    const lineHeight = widget.lineHeight ?? DEFAULT_LINE_HEIGHT;
    const h = widget.rect.height;
    const visibleLines = Math.floor(h / lineHeight);

    const autoScroll = () => {
      let scrollTop = widget.scrollTop ?? 0;
      if (line < scrollTop) scrollTop = line;
      if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
      widget.scrollTop = scrollTop;
    };

    if (key === 'Backspace') {
      if (col > 0) {
        lines[line] = lines[line].substring(0, col - 1) + lines[line].substring(col);
        col--;
      } else if (line > 0) {
        col = lines[line - 1].length;
        lines[line - 1] += lines[line];
        lines.splice(line, 1);
        line--;
      }
      widget.text = lines.join('\n');
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.rerenderAndEmitChange(widget);
      return;
    }

    if (key === 'Delete') {
      if (col < lines[line].length) {
        lines[line] = lines[line].substring(0, col) + lines[line].substring(col + 1);
      } else if (line < lines.length - 1) {
        lines[line] += lines[line + 1];
        lines.splice(line + 1, 1);
      }
      widget.text = lines.join('\n');
      widget.cursorLine = line;
      widget.cursorCol = col;
      this.rerenderAndEmitChange(widget);
      return;
    }

    if (key === 'Enter') {
      const before = lines[line].substring(0, col);
      const after = lines[line].substring(col);
      lines[line] = before;
      lines.splice(line + 1, 0, after);
      line++;
      col = 0;
      widget.text = lines.join('\n');
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.rerenderAndEmitChange(widget);
      return;
    }

    if (key === 'Tab') {
      const indent = '  ';
      lines[line] = lines[line].substring(0, col) + indent + lines[line].substring(col);
      col += indent.length;
      widget.text = lines.join('\n');
      widget.cursorCol = col;
      this.rerenderAndEmitChange(widget);
      return;
    }

    if (key === 'ArrowLeft') {
      if (col > 0) { col--; }
      else if (line > 0) { line--; col = lines[line].length; }
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'ArrowRight') {
      if (col < lines[line].length) { col++; }
      else if (line < lines.length - 1) { line++; col = 0; }
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'ArrowUp') {
      if (line > 0) { line--; col = Math.min(col, lines[line].length); }
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'ArrowDown') {
      if (line < lines.length - 1) { line++; col = Math.min(col, lines[line].length); }
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'Home') {
      widget.cursorCol = 0;
      this.renderWindow(widget.windowId);
      return;
    }

    if (key === 'End') {
      widget.cursorCol = lines[line].length;
      this.renderWindow(widget.windowId);
      return;
    }

    // Printable character
    if (key.length === 1 && !e.modifiers?.ctrl && !e.modifiers?.meta) {
      lines[line] = lines[line].substring(0, col) + key + lines[line].substring(col);
      col++;
      widget.text = lines.join('\n');
      widget.cursorLine = line;
      widget.cursorCol = col;
      autoScroll();
      this.rerenderAndEmitChange(widget);
    }
  }

  // ── Paste Handling ─────────────────────────────────────────────────────

  private handlePaste(pasteText: string): void {
    if (!pasteText || !this.focusedWidget) return;

    const widget = this.widgets.get(this.focusedWidget);
    if (!widget) return;

    if (widget.type === 'textInput') {
      const pos = widget.cursorPos ?? 0;
      widget.text = widget.text.substring(0, pos) + pasteText + widget.text.substring(pos);
      widget.cursorPos = pos + pasteText.length;
      this.rerenderAndEmitChange(widget);
    } else if (widget.type === 'textArea') {
      const lines = widget.text.split('\n');
      let line = widget.cursorLine ?? 0;
      let col = widget.cursorCol ?? 0;
      const lineHeight = widget.lineHeight ?? DEFAULT_LINE_HEIGHT;
      const visibleLines = Math.floor(widget.rect.height / lineHeight);

      const before = lines[line].substring(0, col);
      const after = lines[line].substring(col);
      const pasteLines = pasteText.split('\n');

      if (pasteLines.length === 1) {
        lines[line] = before + pasteLines[0] + after;
        col += pasteLines[0].length;
      } else {
        lines[line] = before + pasteLines[0];
        for (let i = 1; i < pasteLines.length - 1; i++) {
          lines.splice(line + i, 0, pasteLines[i]);
        }
        const lastPasteLine = pasteLines[pasteLines.length - 1];
        lines.splice(line + pasteLines.length - 1, 0, lastPasteLine + after);
        line += pasteLines.length - 1;
        col = lastPasteLine.length;
      }

      widget.text = lines.join('\n');
      widget.cursorLine = line;
      widget.cursorCol = col;

      let scrollTop = widget.scrollTop ?? 0;
      if (line >= scrollTop + visibleLines) scrollTop = line - visibleLines + 1;
      widget.scrollTop = scrollTop;

      this.rerenderAndEmitChange(widget);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private findWindowBySurface(surfaceId: string): WMWindowState | undefined {
    for (const win of this.windows.values()) {
      if (win.surfaceId === surfaceId) return win;
    }
    return undefined;
  }

  private detectResizeEdge(win: WMWindowState, localX: number, localY: number): string | null {
    if (win.chromeless || !win.resizable) return null;

    const n = localY < EDGE_SIZE;
    const s = localY > win.rect.height - EDGE_SIZE;
    const w = localX < EDGE_SIZE;
    const e = localX > win.rect.width - EDGE_SIZE;

    if (n && w) return 'nw';
    if (n && e) return 'ne';
    if (s && w) return 'sw';
    if (s && e) return 'se';
    if (n) return 'n';
    if (s) return 's';
    if (w) return 'w';
    if (e) return 'e';

    return null;
  }

  private focusNextWidget(current: WMWidgetState): void {
    const win = this.windows.get(current.windowId);
    if (!win) return;

    const focusable = win.widgets
      .map((id) => this.widgets.get(id))
      .filter((w): w is WMWidgetState =>
        w !== undefined && (w.type === 'textInput' || w.type === 'textArea')
      );

    const idx = focusable.findIndex((w) => w.id === current.id);
    const next = focusable[(idx + 1) % focusable.length];

    if (next && next.id !== current.id) {
      this.focusedWidget = next.id;
      this.renderWindow(current.windowId);
    }
  }

  private rerenderAndEmitChange(widget: WMWidgetState): void {
    this.renderWindow(widget.windowId);
    const win = this.windows.get(widget.windowId);
    if (win) {
      this.sendWidgetEvent(win.owner, {
        windowId: win.id,
        widgetId: widget.id,
        type: 'change',
        value: widget.text,
      });
    }
  }

  // ── Event Sending ──────────────────────────────────────────────────────

  private async sendWidgetEvent(
    objectId: AbjectId,
    payload: WMWidgetEventPayload
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, WIDGETS_INTERFACE, 'widgetEvent', payload)
    );
  }

  private async sendWindowMovedEvent(
    owner: AbjectId,
    windowId: string,
    x: number,
    y: number
  ): Promise<void> {
    await this.send(
      event(this.id, owner, WIDGETS_INTERFACE, 'windowMoved', { windowId, x, y })
    );
  }

  private async sendWindowResizedEvent(
    owner: AbjectId,
    windowId: string,
    width: number,
    height: number
  ): Promise<void> {
    await this.send(
      event(this.id, owner, WIDGETS_INTERFACE, 'windowResized', { windowId, width, height })
    );
  }
}

// Well-known WidgetManager ID
export const WIDGET_MANAGER_ID = 'abjects:widget-manager' as AbjectId;
