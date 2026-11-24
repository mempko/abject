/**
 * ModePickerWidget -- icon-only permission mode trigger with a floating
 * upward PopoutSurface menu.
 *
 * Renders a square composer trigger matching the attach-file button's chrome
 * and sizing, displaying a semantic icon for the active permission mode plus
 * risk cues for elevated modes (Unattended / Full access) and an open-state
 * highlight. Clicking or pressing Enter/Space opens a floating 352px pop-out
 * above the composer without reflowing the window.
 */

import { WidgetAbject, WidgetConfig, buildFont } from './widget-abject.js';
import { Rect, ThemeData, darkenColor, raisedBlock } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';
import { placePopout, type PopoutScreen, type PopoutSurface } from './popout.js';
import { iconCommands, type IconName } from '../../ui/icons.js';
import {
  MODE_PRESETS,
  DEFAULT_ROOT_MODE,
  DEFAULT_ROOT_CEILING,
  modeWithin,
  sameMode,
  presetOf,
  modeLabel,
  ceilingMode,
  parseMode,
  parseCeiling,
  type PermissionMode,
  type ModeCeiling,
  type ModePreset,
  type PresetName,
} from '../../core/permission-modes.js';

export interface ModePickerChainEntry {
  id?: string;
  holderLabel: string;
  mode?: PermissionMode;
  ceiling?: ModeCeiling;
}

export interface ModePickerWidgetConfig extends WidgetConfig {
  mode?: PermissionMode;
  ceiling?: ModeCeiling;
  maySetMode?: boolean;
  chain?: ModePickerChainEntry[];
}

const PANEL_WIDTH = 352;
const HEADER_HEIGHT = 30;
const SECTION_HEADER_HEIGHT = 22;
const ROW_HEIGHT = 42;
const FOOTER_HEIGHT = 32;
const BODY_PAD_Y = 4;
const GROUP_DIVIDER_PAD = 4;
const POPOUT_GAP = 6;
const GRANTS_HIT_WIDTH = 76;

const INTERACTIVE_NAMES: readonly PresetName[] = ['plan', 'manual', 'acceptEdits', 'auto'];
const AUTONOMOUS_NAMES: readonly PresetName[] = ['unattended', 'fullAccess'];

const PRESET_ICONS: Partial<Record<PresetName, IconName>> = {
  plan: 'eye',
  manual: 'shield',
  acceptEdits: 'pencil',
  auto: 'bolt',
  unattended: 'sliders',
  fullAccess: 'warning',
};

interface RowLayoutItem {
  preset: ModePreset;
  group: 'interactive' | 'autonomous';
  y: number;
  height: number;
}

function buildRowLayout(): {
  rows: RowLayoutItem[];
  interactiveHeaderY: number;
  groupDividerY: number;
  autonomousHeaderY: number;
  footerDividerY: number;
  footerY: number;
  panelHeight: number;
} {
  const byName = new Map<PresetName, ModePreset>();
  for (const p of MODE_PRESETS) byName.set(p.name, p);

  const rows: RowLayoutItem[] = [];
  let y = HEADER_HEIGHT + 1 + BODY_PAD_Y;

  const interactiveHeaderY = y;
  y += SECTION_HEADER_HEIGHT;
  for (const name of INTERACTIVE_NAMES) {
    const preset = byName.get(name);
    if (!preset) continue;
    rows.push({ preset, group: 'interactive', y, height: ROW_HEIGHT });
    y += ROW_HEIGHT;
  }

  y += GROUP_DIVIDER_PAD;
  const groupDividerY = y;
  y += 1 + GROUP_DIVIDER_PAD;

  const autonomousHeaderY = y;
  y += SECTION_HEADER_HEIGHT;
  for (const name of AUTONOMOUS_NAMES) {
    const preset = byName.get(name);
    if (!preset) continue;
    rows.push({ preset, group: 'autonomous', y, height: ROW_HEIGHT });
    y += ROW_HEIGHT;
  }

  y += BODY_PAD_Y;
  const footerDividerY = y;
  const footerY = y + 1;
  const panelHeight = footerY + FOOTER_HEIGHT;

  return {
    rows,
    interactiveHeaderY,
    groupDividerY,
    autonomousHeaderY,
    footerDividerY,
    footerY,
    panelHeight,
  };
}

const LAYOUT = buildRowLayout();

function normalizeMode(raw: unknown, fallback: PermissionMode): PermissionMode {
  if (raw && typeof raw === 'object') {
    const m = raw as Partial<PermissionMode>;
    if (
      typeof m.reach === 'string' &&
      typeof m.beyond === 'string' &&
      typeof m.readOnly === 'boolean'
    ) {
      return { reach: m.reach, beyond: m.beyond, readOnly: m.readOnly };
    }
  }
  if (typeof raw === 'string') {
    return parseMode(raw) ?? fallback;
  }
  return fallback;
}

function normalizeCeiling(raw: unknown, fallback: ModeCeiling): ModeCeiling {
  if (raw && typeof raw === 'object') {
    const c = raw as Partial<ModeCeiling>;
    if (typeof c.reach === 'string' && typeof c.beyond === 'string') {
      return { reach: c.reach, beyond: c.beyond };
    }
  }
  if (typeof raw === 'string') {
    return parseCeiling(raw) ?? fallback;
  }
  return fallback;
}

function normalizeChain(raw: unknown): ModePickerChainEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ModePickerChainEntry[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as ModePickerChainEntry).holderLabel === 'string') {
      const e = item as ModePickerChainEntry;
      out.push({
        id: typeof e.id === 'string' ? e.id : undefined,
        holderLabel: e.holderLabel,
        mode: e.mode,
        ceiling: e.ceiling,
      });
    }
  }
  return out;
}

function iconForMode(mode: PermissionMode): IconName {
  const preset = presetOf(mode);
  if (preset) {
    const mapped = PRESET_ICONS[preset];
    if (mapped) return mapped;
  }
  if (mode.readOnly) return 'eye';
  if (mode.beyond === 'allow') return 'warning';
  if (mode.beyond === 'deny') return 'sliders';
  if (mode.reach === 'full') return 'bolt';
  if (mode.reach === 'edit') return 'pencil';
  return 'shield';
}

function isUnattendedMode(mode: PermissionMode): boolean {
  const preset = presetOf(mode);
  return preset === 'unattended' || mode.beyond === 'deny';
}

function isFullAccessMode(mode: PermissionMode): boolean {
  const preset = presetOf(mode);
  return preset === 'fullAccess' || mode.beyond === 'allow';
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '…';
}

export class ModePickerWidget extends WidgetAbject {
  private mode: PermissionMode;
  private ceiling: ModeCeiling;
  private maySetMode: boolean;
  private chain: ModePickerChainEntry[];

  private expanded = false;
  private hovered = false;
  private pressed = false;
  private hoveredIndex: number | undefined;
  private pressedRowIndex: number | undefined;
  private grantsHovered = false;
  private grantsPressed = false;

  private popout?: PopoutSurface;
  private popoutGeo: PopoutScreen | null = null;
  private popoutTheme?: ThemeData;
  private popoutDirty = false;
  private popoutPainting = false;
  private fieldAt?: Rect;

  constructor(config: ModePickerWidgetConfig) {
    super({ ...config, type: 'modePicker' });
    this.mode = normalizeMode(config.mode, DEFAULT_ROOT_MODE);
    this.ceiling = normalizeCeiling(config.ceiling, DEFAULT_ROOT_CEILING);
    this.maySetMode = config.maySetMode ?? true;
    this.chain = normalizeChain(config.chain);
  }

  private ensurePopout(): PopoutSurface {
    if (!this.popout) {
      this.popout = this.createPopout(`mode-picker-popout-${this.id}`);
    }
    return this.popout;
  }

  private shadowOffset(): number {
    const offset = shapeOf(this.theme).blockShadowOffset;
    return offset > 0 ? offset : 4;
  }

  private anchorRect(): Rect {
    return this.fieldAt ?? {
      x: this.rect.x,
      y: this.rect.y,
      width: this.rect.width,
      height: this.rect.height,
    };
  }

  private popoutRect(): Rect {
    const shadow = this.shadowOffset();
    const placed = placePopout(
      {
        anchor: this.anchorRect(),
        width: PANEL_WIDTH + shadow,
        height: LAYOUT.panelHeight + shadow,
        side: 'above',
        align: 'start',
        gap: POPOUT_GAP,
        flip: true,
      },
      this.popoutGeo,
    );
    return placed.rect;
  }

  private isRowLocked(index: number): boolean {
    const row = LAYOUT.rows[index];
    if (!row) return true;
    if (!this.maySetMode) return true;
    return !modeWithin(row.preset.mode, this.ceiling);
  }

  private isRowAboveCeiling(index: number): boolean {
    const row = LAYOUT.rows[index];
    if (!row) return true;
    return !modeWithin(row.preset.mode, this.ceiling);
  }

  private unlockedIndices(): number[] {
    const indices: number[] = [];
    for (let i = 0; i < LAYOUT.rows.length; i++) {
      if (!this.isRowLocked(i)) indices.push(i);
    }
    return indices;
  }

  private initialHoveredIndex(): number | undefined {
    for (let i = 0; i < LAYOUT.rows.length; i++) {
      if (sameMode(this.mode, LAYOUT.rows[i].preset.mode) && !this.isRowLocked(i)) {
        return i;
      }
    }
    const unlocked = this.unlockedIndices();
    return unlocked.length > 0 ? unlocked[0] : undefined;
  }

  private moveHighlight(delta: 1 | -1): boolean {
    const unlocked = this.unlockedIndices();
    if (unlocked.length === 0) return false;
    if (this.hoveredIndex === undefined) {
      this.hoveredIndex = delta > 0 ? unlocked[0] : unlocked[unlocked.length - 1];
      return true;
    }
    const pos = unlocked.indexOf(this.hoveredIndex);
    if (pos === -1) {
      this.hoveredIndex = delta > 0 ? unlocked[0] : unlocked[unlocked.length - 1];
      return true;
    }
    const next = (pos + delta + unlocked.length) % unlocked.length;
    this.hoveredIndex = unlocked[next];
    return true;
  }

  private openPopout(): void {
    if (this.disabled || this.expanded) return;
    this.expanded = true;
    this.hoveredIndex = this.initialHoveredIndex();
    this.pressedRowIndex = undefined;
    this.grantsHovered = false;
    this.grantsPressed = false;
    this.changed('expanded', true);
    void this.refreshPopout(true);
  }

  private closePopout(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.hoveredIndex = undefined;
    this.pressedRowIndex = undefined;
    this.grantsHovered = false;
    this.grantsPressed = false;
    this.changed('expanded', false);
    void this.popout?.hide();
  }

  private async refreshPopout(fetchScreen = false): Promise<void> {
    this.popoutDirty = true;
    if (this.popoutPainting) return;
    this.popoutPainting = true;
    try {
      while (this.popoutDirty) {
        this.popoutDirty = false;
        if (!this.expanded) break;
        const surface = this.ensurePopout();
        if (fetchScreen || !this.popoutGeo) {
          try {
            this.popoutGeo = await surface.screen();
          } catch {
            this.popoutGeo = null;
          }
          fetchScreen = false;
        }
        if (!this.expanded) break;
        const commands = this.buildPopoutCommands('');
        if (!this.expanded) break;
        this.popoutTheme = this.theme;
        await surface.show(this.popoutRect(), commands);
      }
    } finally {
      this.popoutPainting = false;
    }
  }

  private repaintPopout(): void {
    if (!this.expanded) return;
    void this.refreshPopout(false).catch(() => {});
  }

  private selectRow(index: number): void {
    if (this.isRowLocked(index)) return;
    const row = LAYOUT.rows[index];
    if (!row) return;
    this.mode = { ...row.preset.mode };
    this.changed('change', row.preset.name);
    this.closePopout();
  }

  private localPoint(input: Record<string, unknown>): { x: number; y: number } {
    return {
      x: (input.localX as number | undefined) ?? (input.x as number | undefined) ?? 0,
      y: (input.localY as number | undefined) ?? (input.y as number | undefined) ?? 0,
    };
  }

  private onField(x: number, y: number): boolean {
    return x >= 0 && x < this.rect.width && y >= 0 && y < this.rect.height;
  }

  private hitRowAt(x: number, y: number): number | undefined {
    if (x < 0 || x >= PANEL_WIDTH) return undefined;
    for (let i = 0; i < LAYOUT.rows.length; i++) {
      const r = LAYOUT.rows[i];
      if (y >= r.y && y < r.y + r.height) return i;
    }
    return undefined;
  }

  private hitGrantsAt(x: number, y: number): boolean {
    return (
      x >= PANEL_WIDTH - GRANTS_HIT_WIDTH &&
      x <= PANEL_WIDTH &&
      y >= LAYOUT.footerY &&
      y <= LAYOUT.footerY + FOOTER_HEIGHT
    );
  }

  protected override async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number,
  ): Promise<unknown[]> {
    const prevAnchor = this.fieldAt;
    this.fieldAt = { x: ox, y: oy, width: this.rect.width, height: this.rect.height };
    const moved =
      !prevAnchor ||
      prevAnchor.x !== ox ||
      prevAnchor.y !== oy ||
      prevAnchor.width !== this.rect.width ||
      prevAnchor.height !== this.rect.height;
    if (this.expanded && (moved || this.popoutTheme !== this.theme)) {
      this.repaintPopout();
    }

    const commands: unknown[] = [];
    const theme = this.theme;
    const shape = shapeOf(theme);
    const w = this.rect.width;
    const h = this.rect.height;
    const radius = this.style.radius ?? theme.widgetRadius;
    const fullAccess = isFullAccessMode(this.mode);
    const unattended = isUnattendedMode(this.mode);

    const baseFill = this.expanded
      ? theme.activeItemBg
      : fullAccess
        ? theme.destructiveBg
        : (this.style.background ?? theme.buttonBg);

    const stroke = this.expanded
      ? theme.activeItemBorder
      : fullAccess
        ? theme.destructiveBorder
        : unattended
          ? theme.statusWarning
          : (this.style.borderColor ?? theme.buttonBorder);

    let iconColor = this.disabled
      ? theme.textTertiary
      : fullAccess
        ? theme.statusError
        : unattended
          ? theme.statusWarning
          : this.expanded
            ? theme.textPrimary
            : (this.style.color ?? theme.textSecondary);

    let fill = baseFill;
    if (!this.disabled && this.hovered && !this.expanded) {
      fill = darkenColor(baseFill, 18);
    }

    const block = raisedBlock(
      surfaceId,
      { x: ox, y: oy, width: w, height: h },
      shape.blockShadowColor,
      3,
      this.pressed && !this.disabled,
    );
    commands.push(...block.commands);
    const face = block.face;

    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: face.x,
        y: face.y,
        width: face.width,
        height: face.height,
        fill,
        stroke,
        lineWidth: shape.ruleWidth,
        radius,
      },
    });

    const iconSize = Math.max(12, Math.min(18, Math.round(Math.min(face.width, face.height) * 0.45)));
    const ix = Math.round(face.x + (face.width - iconSize) / 2);
    const iy = Math.round(face.y + (face.height - iconSize) / 2);
    commands.push(
      ...iconCommands(iconForMode(this.mode), {
        surfaceId,
        x: ix,
        y: iy,
        size: iconSize,
        color: iconColor,
        caps: shape.iconCaps,
      }),
    );

    return commands;
  }

  private buildPopoutCommands(surfaceId: string): unknown[] {
    const commands: unknown[] = [];
    const theme = this.theme;
    const shape = shapeOf(theme);
    const radius = theme.widgetRadius;
    const shadow = this.shadowOffset();
    const panelH = LAYOUT.panelHeight;

    // Hard offset shadow
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: shadow,
        y: shadow,
        width: PANEL_WIDTH,
        height: panelH,
        fill: theme.dropdownShadow,
        radius,
      },
    });

    // Floating panel frame
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: 0,
        y: 0,
        width: PANEL_WIDTH,
        height: panelH,
        fill: theme.windowBg,
        stroke: theme.windowBorder,
        lineWidth: 1,
        radius,
      },
    });

    // Zone 1: Header (30px)
    const sectionFont = buildFont({ fontSize: 10, fontWeight: 'bold' }, theme);
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: 12,
        y: HEADER_HEIGHT / 2,
        text: 'PERMISSION MODE',
        font: sectionFont,
        fill: theme.sectionLabel,
        baseline: 'middle',
      },
    });

    const ceilingText = `CEILING: ${modeLabel(ceilingMode(this.ceiling)).toUpperCase()}`;
    const badgeW = Math.min(176, Math.max(88, Math.round(ceilingText.length * 6.3 + 14)));
    const badgeH = 18;
    const badgeX = PANEL_WIDTH - 10 - badgeW;
    const badgeY = Math.round((HEADER_HEIGHT - badgeH) / 2);
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: badgeX,
        y: badgeY,
        width: badgeW,
        height: badgeH,
        fill: theme.activeItemBg,
        stroke: theme.buttonBorder,
        lineWidth: 1,
        radius: Math.min(4, radius),
      },
    });
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: badgeX + badgeW / 2,
        y: badgeY + badgeH / 2,
        text: ceilingText,
        font: sectionFont,
        fill: theme.textSecondary,
        align: 'center',
        baseline: 'middle',
      },
    });

    // Header divider
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: 1,
        y: HEADER_HEIGHT,
        width: PANEL_WIDTH - 2,
        height: 1,
        fill: theme.divider,
      },
    });

    // Zone 2: Grouped borderless two-line rows
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: 12,
        y: LAYOUT.interactiveHeaderY + SECTION_HEADER_HEIGHT / 2,
        text: 'INTERACTIVE',
        font: sectionFont,
        fill: theme.sectionLabel,
        baseline: 'middle',
      },
    });

    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: 12,
        y: LAYOUT.groupDividerY,
        width: PANEL_WIDTH - 24,
        height: 1,
        fill: theme.divider,
      },
    });

    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: 12,
        y: LAYOUT.autonomousHeaderY + SECTION_HEADER_HEIGHT / 2,
        text: 'AUTONOMOUS · NO PROMPTS',
        font: sectionFont,
        fill: theme.sectionLabel,
        baseline: 'middle',
      },
    });

    const titleFont = buildFont({ fontSize: 12, fontWeight: 'bold' }, theme);
    const descFont = buildFont({ fontSize: 11 }, theme);
    const lockTagFont = buildFont({ fontSize: 9, fontWeight: 'bold' }, theme);

    for (let i = 0; i < LAYOUT.rows.length; i++) {
      const row = LAYOUT.rows[i];
      const preset = row.preset;
      const active = sameMode(this.mode, preset.mode);
      const aboveCeiling = this.isRowAboveCeiling(i);
      const locked = this.isRowLocked(i);
      const hovered = !locked && this.hoveredIndex === i;
      const rowAccent =
        preset.name === 'fullAccess'
          ? theme.statusError
          : preset.name === 'unattended'
            ? theme.statusWarning
            : theme.accent;

      if (active) {
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: 1,
            y: row.y,
            width: PANEL_WIDTH - 2,
            height: row.height,
            fill: theme.selectionBg,
          },
        });
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: 1,
            y: row.y,
            width: 2,
            height: row.height,
            fill: rowAccent,
          },
        });
      } else if (hovered) {
        commands.push({
          type: 'rect',
          surfaceId,
          params: {
            x: 1,
            y: row.y,
            width: PANEL_WIDTH - 2,
            height: row.height,
            fill: theme.selectHover,
          },
        });
      }

      const rowIconColor = locked
        ? theme.textTertiary
        : preset.name === 'fullAccess'
          ? theme.statusError
          : preset.name === 'unattended'
            ? theme.statusWarning
            : active
              ? theme.accent
              : theme.textSecondary;

      commands.push(
        ...iconCommands(PRESET_ICONS[preset.name] ?? 'shield', {
          surfaceId,
          x: 14,
          y: row.y + 14,
          size: 14,
          color: rowIconColor,
          caps: shape.iconCaps,
        }),
      );

      const labelColor = locked
        ? theme.textTertiary
        : preset.name === 'fullAccess'
          ? theme.statusError
          : theme.textPrimary;

      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: 38,
          y: row.y + 14,
          text: preset.label,
          font: titleFont,
          fill: labelColor,
          baseline: 'middle',
        },
      });

      commands.push({
        type: 'text',
        surfaceId,
        params: {
          x: 38,
          y: row.y + 30,
          text: truncateText(preset.description, 48),
          font: descFont,
          fill: locked ? theme.textTertiary : theme.textSecondary,
          baseline: 'middle',
        },
      });

      if (locked) {
        commands.push({
          type: 'text',
          surfaceId,
          params: {
            x: PANEL_WIDTH - 28,
            y: row.y + 14,
            text: aboveCeiling ? 'ABOVE CEILING' : 'LOCKED',
            font: lockTagFont,
            fill: theme.textTertiary,
            align: 'right',
            baseline: 'middle',
          },
        });
        commands.push(
          ...iconCommands('lock', {
            surfaceId,
            x: PANEL_WIDTH - 23,
            y: row.y + 8,
            size: 11,
            color: theme.textTertiary,
            caps: shape.iconCaps,
          }),
        );
      } else if (active) {
        commands.push(
          ...iconCommands('check', {
            surfaceId,
            x: PANEL_WIDTH - 25,
            y: row.y + 14,
            size: 13,
            color: rowAccent,
            caps: shape.iconCaps,
          }),
        );
      }
    }

    // Footer divider
    commands.push({
      type: 'rect',
      surfaceId,
      params: {
        x: 1,
        y: LAYOUT.footerDividerY,
        width: PANEL_WIDTH - 2,
        height: 1,
        fill: theme.divider,
      },
    });

    // Zone 3: Footer (32px) — provenance + clickable Grants link
    const provenanceRaw =
      this.chain.length > 0
        ? this.chain.map((c) => c.holderLabel).join(' → ')
        : 'This chat';
    const provenance = truncateText(provenanceRaw, 34);
    const footerMidY = LAYOUT.footerY + FOOTER_HEIGHT / 2;

    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: 12,
        y: footerMidY,
        text: provenance,
        font: descFont,
        fill: theme.textTertiary,
        baseline: 'middle',
      },
    });

    if (this.grantsHovered) {
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: PANEL_WIDTH - GRANTS_HIT_WIDTH,
          y: LAYOUT.footerY,
          width: GRANTS_HIT_WIDTH - 1,
          height: FOOTER_HEIGHT - 1,
          fill: theme.selectHover,
        },
      });
    }

    const linkFont = buildFont({ fontSize: 11, fontWeight: 'bold' }, theme);
    commands.push({
      type: 'text',
      surfaceId,
      params: {
        x: PANEL_WIDTH - 27,
        y: footerMidY,
        text: 'Grants',
        font: linkFont,
        fill: theme.linkColor,
        align: 'right',
        baseline: 'middle',
      },
    });
    commands.push(
      ...iconCommands('externalLink', {
        surfaceId,
        x: PANEL_WIDTH - 22,
        y: Math.round(footerMidY - 5.5),
        size: 11,
        color: theme.linkColor,
        caps: shape.iconCaps,
      }),
    );

    return commands;
  }

  private async handleKeyDown(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const key = input.key as string;

    if (!this.expanded) {
      if (key === 'Enter' || key === ' ') {
        this.openPopout();
        await this.requestRedraw();
        return { consumed: true };
      }
      return { consumed: false };
    }

    if (key === 'Escape') {
      this.closePopout();
      await this.requestRedraw();
      return { consumed: true };
    }
    if (key === 'ArrowDown') {
      if (this.moveHighlight(1)) this.repaintPopout();
      return { consumed: true };
    }
    if (key === 'ArrowUp') {
      if (this.moveHighlight(-1)) this.repaintPopout();
      return { consumed: true };
    }
    if (key === 'Home') {
      const unlocked = this.unlockedIndices();
      if (unlocked.length > 0 && this.hoveredIndex !== unlocked[0]) {
        this.hoveredIndex = unlocked[0];
        this.repaintPopout();
      }
      return { consumed: true };
    }
    if (key === 'End') {
      const unlocked = this.unlockedIndices();
      const last = unlocked[unlocked.length - 1];
      if (last !== undefined && this.hoveredIndex !== last) {
        this.hoveredIndex = last;
        this.repaintPopout();
      }
      return { consumed: true };
    }
    if (key === 'Enter' || key === ' ') {
      if (this.hoveredIndex !== undefined && !this.isRowLocked(this.hoveredIndex)) {
        this.selectRow(this.hoveredIndex);
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    return { consumed: false };
  }

  protected override async processInput(
    input: Record<string, unknown>,
  ): Promise<{ consumed: boolean }> {
    if (this.disabled) return { consumed: false };
    const type = input.type as string;

    if (type === 'keydown') {
      return this.handleKeyDown(input);
    }

    if (type === 'mousedown') {
      const { x, y } = this.localPoint(input);
      const onField = this.onField(x, y);
      if (!this.expanded) {
        if (!onField) return { consumed: false };
        this.pressed = true;
        this.openPopout();
        await this.requestRedraw();
        return { consumed: true };
      }
      this.pressed = false;
      this.closePopout();
      await this.requestRedraw();
      return { consumed: onField };
    }

    if (type === 'mouseup') {
      if (this.pressed) {
        this.pressed = false;
        await this.requestRedraw();
      }
      return { consumed: false };
    }

    if (type === 'mousemove') {
      const { x, y } = this.localPoint(input);
      const nowHovered = this.onField(x, y);
      if (nowHovered !== this.hovered) {
        this.hovered = nowHovered;
        await this.requestRedraw();
      }
      return { consumed: false };
    }

    if (type === 'mouseleave') {
      if (this.hovered || this.pressed) {
        this.hovered = false;
        this.pressed = false;
        await this.requestRedraw();
      }
      return { consumed: false };
    }

    return { consumed: false };
  }

  protected override async handlePopoutInput(input: Record<string, unknown>): Promise<void> {
    const surface = this.popout;
    if (!surface || input.nodeId !== surface.nodeId || !this.expanded) return;
    const type = input.type as string;

    if (type === 'keydown') {
      await this.handleKeyDown(input);
      return;
    }

    const at = surface.toLocal(input);
    if (!at) return;

    if (type === 'mousemove') {
      const hitRow = this.hitRowAt(at.x, at.y);
      const nextHovered = hitRow !== undefined && !this.isRowLocked(hitRow) ? hitRow : undefined;
      const nextGrants = this.hitGrantsAt(at.x, at.y);
      if (nextHovered !== this.hoveredIndex || nextGrants !== this.grantsHovered) {
        this.hoveredIndex = nextHovered;
        this.grantsHovered = nextGrants;
        this.repaintPopout();
      }
      return;
    }

    if (type === 'mouseleave') {
      if (this.hoveredIndex !== undefined || this.grantsHovered) {
        this.hoveredIndex = undefined;
        this.grantsHovered = false;
        this.repaintPopout();
      }
      return;
    }

    if (type === 'mousedown') {
      if (this.hitGrantsAt(at.x, at.y)) {
        this.grantsPressed = true;
        return;
      }
      const hitRow = this.hitRowAt(at.x, at.y);
      if (hitRow !== undefined && !this.isRowLocked(hitRow)) {
        this.pressedRowIndex = hitRow;
        this.hoveredIndex = hitRow;
        this.repaintPopout();
      }
      return;
    }

    if (type === 'mouseup') {
      const wasGrants = this.grantsPressed;
      this.grantsPressed = false;
      if (wasGrants && this.hitGrantsAt(at.x, at.y)) {
        this.closePopout();
        this.changed('openGrants', {});
        await this.requestRedraw();
        return;
      }
      const pressed = this.pressedRowIndex;
      this.pressedRowIndex = undefined;
      const hitRow = this.hitRowAt(at.x, at.y);
      if (hitRow !== undefined && (pressed === undefined || pressed === hitRow) && !this.isRowLocked(hitRow)) {
        this.selectRow(hitRow);
        await this.requestRedraw();
      }
    }
  }

  protected override async handlePopoutWindowFocus(focused: boolean): Promise<void> {
    if (focused || !this.expanded) return;
    this.closePopout();
    await this.requestRedraw();
  }

  protected override getWidgetValue(): string {
    return presetOf(this.mode) ?? modeLabel(this.mode);
  }

  protected override async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    if (updates.mode !== undefined) {
      this.mode = normalizeMode(updates.mode, this.mode);
    }
    if (updates.ceiling !== undefined) {
      this.ceiling = normalizeCeiling(updates.ceiling, this.ceiling);
    }
    if (updates.maySetMode !== undefined) {
      this.maySetMode = Boolean(updates.maySetMode);
    }
    if (updates.chain !== undefined) {
      this.chain = normalizeChain(updates.chain);
    }

    if (this.expanded) {
      if (!this.visible || this.disabled) {
        this.closePopout();
      } else {
        if (this.hoveredIndex !== undefined && this.isRowLocked(this.hoveredIndex)) {
          this.hoveredIndex = this.initialHoveredIndex();
        }
        this.repaintPopout();
      }
    }

    await this.requestRedraw();
  }

  protected override async onStop(): Promise<void> {
    await this.popout?.hide();
    await super.onStop();
  }
}
