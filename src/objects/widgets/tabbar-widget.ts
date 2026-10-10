/**
 * TabBarWidget — horizontal tab bar with selectable tabs.
 *
 * Divides its width equally among tabs, each drawn as a slanted
 * parallelogram standing on a heavy ink baseline. The active tab is filled
 * with the accent (a wedge) and labelled in the action text colour; inactive
 * tabs are outlined in the divider colour, tinted on hover, with primary text.
 * Clicking a tab switches the selection and emits a 'change' notification.
 * Double-clicking a tab enters inline rename mode.
 * Each tab has a × close button (when closable is true).
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { fontStacks, wedge, withAlpha } from './widget-types.js';
import { shapeOf, chromeCase } from '../../core/theme-data.js';

export interface TabBarConfig extends WidgetConfig {
  tabs?: string[];
  selectedIndex?: number;
  closable?: boolean;  // default false — show × close buttons when true
}

export class TabBarWidget extends WidgetAbject {
  private tabs: string[];
  private selectedIndex: number;
  private hoveredIndex = -1;
  private closable: boolean;

  // ── Close button hover tracking ──
  private hoveredCloseIndex = -1;

  // ── Double-click rename tracking ──
  private lastClickTime = 0;
  private lastClickIndex = -1;
  private editingIndex = -1;
  private editText = '';
  private cursorVisible = true;
  private cursorTimer?: ReturnType<typeof setInterval>;

  constructor(config: TabBarConfig) {
    super(config);
    this.tabs = config.tabs ?? [];
    this.selectedIndex = config.selectedIndex ?? 0;
    this.closable = config.closable ?? false;
  }

  /**
   * Slanted parallelogram tabs standing on a heavy
   * ink baseline. The active tab is a solid red slab with inverse text;
   * labels are uppercase display type (tab labels are chrome). Hit zones are
   * equal-width columns.
   */
  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;
    const style = this.style;
    const theme = this.theme;
    const shape = shapeOf(theme);
    const tabCount = this.tabs.length;
    if (tabCount === 0) return commands;

    const tabWidth = w / tabCount;
    const rule = shape.ruleWidth;
    const tabH = h - rule;
    const slant = Math.min(8, tabWidth / 4);
    const size = style.fontSize ?? 13;
    const labelFont = `600 ${size}px ${fontStacks(theme).display}`;
    const editFont = buildFont(style, theme);

    if (this.disabled) {
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId, params: { alpha: 0.5 } });
    }

    commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy, width: w, height: h, fill: style.background ?? theme.windowBg } });

    for (let i = 0; i < tabCount; i++) {
      const tx = ox + i * tabWidth;
      const isActive = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isActive;
      const points = [
        { x: tx + slant, y: oy },
        { x: tx + tabWidth, y: oy },
        { x: tx + tabWidth - slant, y: oy + tabH },
        { x: tx, y: oy + tabH },
      ];

      if (isActive) {
        commands.push(...wedge(surfaceId, points, theme.accent));
      } else {
        commands.push({
          type: 'polygon', surfaceId,
          params: {
            points,
            fill: isHovered ? withAlpha(theme.textPrimary, 0.08) : theme.windowBg,
            stroke: theme.divider, lineWidth: 1, closePath: true,
          },
        });
      }

      const textColor = isActive ? theme.actionText : (style.color ?? theme.textPrimary);
      if (this.editingIndex === i) {
        const editPad = 4 + slant / 2;
        commands.push({
          type: 'rect', surfaceId,
          params: {
            x: tx + editPad, y: oy + 3, width: tabWidth - editPad * 2 - (this.closable ? 18 : 0), height: tabH - 6,
            fill: theme.inputBg, stroke: theme.inputBorder, lineWidth: 1,
          },
        });
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: tx + editPad + 4, y: oy + tabH / 2,
            text: this.editText + (this.cursorVisible ? '|' : ''),
            font: editFont, fill: theme.textPrimary, align: 'left', baseline: 'middle',
          },
        });
      } else {
        const labelCenterX = this.closable ? tx + (tabWidth - 18) / 2 : tx + tabWidth / 2;
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: labelCenterX, y: oy + tabH / 2,
            text: chromeCase(theme, this.tabs[i]),
            font: labelFont, fill: textColor, align: 'center', baseline: 'middle',
          },
        });
      }

      if (this.closable && this.tabs[i] !== '+') {
        const isCloseHovered = i === this.hoveredCloseIndex;
        commands.push({
          type: 'text', surfaceId,
          params: {
            x: tx + tabWidth - 16 - slant / 2, y: oy + tabH / 2,
            text: '\u00D7',
            font: `600 12px ${fontStacks(theme).body}`,
            fill: isActive ? theme.actionText : (isCloseHovered ? theme.accent : theme.textSecondary),
            align: 'center', baseline: 'middle',
          },
        });
      }
    }

    // Heavy ink baseline the tabs stand on.
    commands.push({ type: 'rect', surfaceId, params: { x: ox, y: oy + h - rule, width: w, height: rule, fill: theme.textPrimary } });

    if (this.disabled) {
      commands.push({ type: 'restore', surfaceId, params: {} });
    }
    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const tabCount = this.tabs.length;
    if (tabCount === 0) return { consumed: false };

    const tabWidth = this.rect.width / tabCount;

    if (input.type === 'mousedown') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      const idx = Math.min(Math.floor(localX / tabWidth), tabCount - 1);

      // Check if click is on the close button (rightmost ~20px of tab)
      if (this.closable && this.tabs[idx] !== '+') {
        const tabRight = (idx + 1) * tabWidth;
        if (localX >= tabRight - 20) {
          this.changed('close', idx);
          return { consumed: true };
        }
      }

      // If we're editing and clicked outside the editing tab, commit
      if (this.editingIndex >= 0 && idx !== this.editingIndex) {
        this.commitRename();
      }

      // Double-click detection for rename
      const now = Date.now();
      if (idx === this.lastClickIndex && now - this.lastClickTime < 300 && idx === this.selectedIndex && this.tabs[idx] !== '+') {
        // Double-click on active tab → enter rename mode
        this.editingIndex = idx;
        this.editText = this.tabs[idx];
        this.startCursorBlink();
        await this.requestRedraw();
        this.lastClickTime = 0;
        this.lastClickIndex = -1;
        return { consumed: true };
      }

      this.lastClickTime = now;
      this.lastClickIndex = idx;

      if (idx >= 0 && idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        await this.requestRedraw();
        this.changed('change', idx);
      }
      return { consumed: true };
    }

    if (input.type === 'mousemove') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      const idx = Math.min(Math.floor(localX / tabWidth), tabCount - 1);
      let needsRedraw = false;

      if (idx !== this.hoveredIndex) {
        this.hoveredIndex = idx;
        needsRedraw = true;
      }

      // Track close button hover
      let newCloseHover = -1;
      if (this.closable && this.tabs[idx] !== '+') {
        const tabRight = (idx + 1) * tabWidth;
        if (localX >= tabRight - 20) {
          newCloseHover = idx;
        }
      }
      if (newCloseHover !== this.hoveredCloseIndex) {
        this.hoveredCloseIndex = newCloseHover;
        needsRedraw = true;
      }

      if (needsRedraw) await this.requestRedraw();
      return { consumed: true };
    }

    if (input.type === 'mouseleave') {
      let needsRedraw = false;
      if (this.hoveredIndex !== -1) {
        this.hoveredIndex = -1;
        needsRedraw = true;
      }
      if (this.hoveredCloseIndex !== -1) {
        this.hoveredCloseIndex = -1;
        needsRedraw = true;
      }
      if (needsRedraw) await this.requestRedraw();
      return { consumed: true };
    }

    // ── Keyboard input while editing ──
    if (this.editingIndex >= 0) {
      if (input.type === 'keydown') {
        const key = input.key as string;
        if (key === 'Enter') {
          this.commitRename();
          await this.requestRedraw();
          return { consumed: true };
        }
        if (key === 'Escape') {
          this.cancelRename();
          await this.requestRedraw();
          return { consumed: true };
        }
        if (key === 'Backspace') {
          this.editText = this.editText.slice(0, -1);
          await this.requestRedraw();
          return { consumed: true };
        }
        // Printable character — append directly (no textInput event from client)
        const modifiers = input.modifiers as { ctrl?: boolean; meta?: boolean } | undefined;
        if (key.length === 1 && !modifiers?.ctrl && !modifiers?.meta) {
          this.editText += key;
          await this.requestRedraw();
        }
        return { consumed: true };
      }
    }

    if (input.type === 'keydown' && this.focused) {
      const key = input.key as string;
      if (key === 'ArrowLeft' && this.selectedIndex > 0) {
        this.selectedIndex--;
        await this.requestRedraw();
        this.changed('change', this.selectedIndex);
        return { consumed: true };
      }
      if (key === 'ArrowRight' && this.selectedIndex < tabCount - 1) {
        this.selectedIndex++;
        await this.requestRedraw();
        this.changed('change', this.selectedIndex);
        return { consumed: true };
      }
    }

    return { consumed: false };
  }

  private commitRename(): void {
    if (this.editingIndex < 0) return;
    const idx = this.editingIndex;
    const name = this.editText.trim() || this.tabs[idx]; // fallback to old name if empty
    this.tabs[idx] = name;
    this.stopCursorBlink();
    this.editingIndex = -1;
    this.editText = '';
    this.changed('rename', { index: idx, name });
  }

  private cancelRename(): void {
    this.stopCursorBlink();
    this.editingIndex = -1;
    this.editText = '';
  }

  private startCursorBlink(): void {
    this.stopCursorBlink();
    this.cursorVisible = true;
    this.cursorTimer = setInterval(async () => {
      this.cursorVisible = !this.cursorVisible;
      await this.requestRedraw();
    }, 500);
  }

  private stopCursorBlink(): void {
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = undefined;
    }
    this.cursorVisible = true;
  }

  protected getWidgetValue(): string {
    return String(this.selectedIndex);
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (updates.tabs !== undefined && Array.isArray(updates.tabs)) {
      this.tabs = updates.tabs as string[];
    }
    if (updates.selectedIndex !== undefined) {
      this.selectedIndex = updates.selectedIndex as number;
    }
    if (updates.closable !== undefined) {
      this.closable = updates.closable as boolean;
    }
  }
}
