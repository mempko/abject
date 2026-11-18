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

  /** The '+' tab is a button, not a share of the strip: it keeps this width at
   *  the trailing edge while the real tabs divide what is left. A lone '+' used
   *  to take the whole row, so any press anywhere on the strip was a press on
   *  the new-tab button — which is how a freshly shown viewer opened a blank
   *  page nobody asked for. */
  private static readonly NEW_TAB_WIDTH = 36;

  /** Where the tabs sit. Drawing and hit-testing both come from here, so what a
   *  press can reach is exactly what the person sees. */
  private tabBoxes(): { realCount: number; tabWidth: number; addLeft: number; addWidth: number } {
    const hasAdd = this.tabs.length > 0 && this.tabs[this.tabs.length - 1] === '+';
    const addWidth = hasAdd ? Math.min(TabBarWidget.NEW_TAB_WIDTH, this.rect.width) : 0;
    const realCount = hasAdd ? this.tabs.length - 1 : this.tabs.length;
    const realWidth = Math.max(0, this.rect.width - addWidth);
    return {
      realCount,
      tabWidth: realCount > 0 ? realWidth / realCount : 0,
      addLeft: realWidth,
      addWidth,
    };
  }

  /** The tab under a local x, or -1 for empty strip. The '+' keeps its own box,
   *  so the strip has dead space a stray press can land on and do nothing. */
  private indexAt(localX: number): number {
    const { realCount, tabWidth, addLeft } = this.tabBoxes();
    if (this.tabs.length > realCount && localX >= addLeft) return realCount;
    if (realCount === 0 || tabWidth <= 0 || localX < 0) return -1;
    return Math.min(Math.floor(localX / tabWidth), realCount - 1);
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

    const { realCount, tabWidth, addLeft, addWidth } = this.tabBoxes();
    const addIndex = this.tabs.length > realCount ? realCount : -1;
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
      const isAddTab = i === addIndex;
      const tw = isAddTab ? addWidth : tabWidth;
      const tx = ox + (isAddTab ? addLeft : i * tabWidth);
      const isActive = i === this.selectedIndex;
      const isHovered = i === this.hoveredIndex && !isActive;
      const points = [
        { x: tx + slant, y: oy },
        { x: tx + tw, y: oy },
        { x: tx + tw - slant, y: oy + tabH },
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
            x: tx + editPad, y: oy + 3, width: tw - editPad * 2 - (this.closable ? 18 : 0), height: tabH - 6,
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
        const labelCenterX = this.closable && !isAddTab ? tx + (tw - 18) / 2 : tx + tw / 2;
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
            x: tx + tw - 16 - slant / 2, y: oy + tabH / 2,
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

    const { tabWidth } = this.tabBoxes();

    if (input.type === 'mousedown') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      // Empty strip is not a tab: a press that is nobody's press opens nothing.
      const idx = this.indexAt(localX);
      if (idx < 0) return { consumed: true };

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

      // A '+' tab is a button, not a selection. When it is the only tab — no
      // pages open yet — it is also the selected index, so reporting a change
      // only on a selection change would swallow the click and leave no way to
      // open the first tab.
      // A '+' tab is a button, not a selection. It reports on its own aspect so
      // no consumer can read a selection (or a stale index) as a press: with no
      // pages open the '+' is index 0 and index === the page count, so a shared
      // channel made merely opening the strip look like "open a new tab".
      const isAddTab = idx >= 0 && this.tabs[idx] === '+';
      if (isAddTab) {
        this.changed('newTab');
        return { consumed: true };
      }
      if (idx >= 0 && idx !== this.selectedIndex) {
        this.selectedIndex = idx;
        await this.requestRedraw();
        this.changed('change', idx);
      }
      return { consumed: true };
    }

    if (input.type === 'mousemove') {
      const localX = (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0;
      const idx = this.indexAt(localX);
      let needsRedraw = false;

      if (idx < 0) {
        if (this.hoveredIndex !== -1 || this.hoveredCloseIndex !== -1) {
          this.hoveredIndex = -1;
          this.hoveredCloseIndex = -1;
          await this.requestRedraw();
        }
        return { consumed: true };
      }

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
