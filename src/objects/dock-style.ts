/**
 * Shared styling for the sidebar dock's section providers (GlobalToolbar,
 * WorkspaceSwitcher, Taskbar).
 *
 * The three providers build rows into one dock window, so their header, row,
 * gear and active-row styles must agree: section headers are solid accent
 * blocks in the display face, rows are flat and square with a vector icon,
 * and the open target's row carries the accent marker.
 */

import type { ThemeData } from '../core/theme-data.js';
import { chromeCase } from '../core/theme-data.js';
import type { IconName } from '../ui/icons.js';

type Style = Record<string, unknown>;

/** Every launcher row the dock providers draw. */
export type DockLauncher =
  | 'network' | 'explorer' | 'procs' | 'eye' | 'notifications'
  | 'chat' | 'peers' | 'goals' | 'jobs' | 'knowledge' | 'agents'
  | 'schedules' | 'web' | 'files' | 'projects'
  | 'browse' | 'spaceShared' | 'spacePublic' | 'spaceLocal';

/** The vector icon (ui/icons.ts) each launcher row draws. */
export const DOCK_LAUNCHERS: Record<DockLauncher, { icon: IconName }> = {
  network:       { icon: 'network' },
  explorer:      { icon: 'search' },
  procs:         { icon: 'activity' },
  eye:           { icon: 'eye' },
  notifications: { icon: 'bell' },
  chat:          { icon: 'chat' },
  peers:         { icon: 'users' },
  goals:         { icon: 'target' },
  jobs:          { icon: 'list' },
  knowledge:     { icon: 'brain' },
  agents:        { icon: 'agent' },
  schedules:     { icon: 'calendar' },
  web:           { icon: 'globe' },
  files:         { icon: 'folder' },
  projects:      { icon: 'folderOpen' },
  browse:        { icon: 'grid' },
  spaceShared:   { icon: 'users' },
  spacePublic:   { icon: 'globe' },
  spaceLocal:    { icon: 'lock' },
};

export interface DockStyles {
  compact: boolean;
  /** Launcher / object row. */
  row: Style;
  /** Small square header-row action (gear, plus). */
  gear: Style;
  /** Section header toggle button. */
  header: Style;
  /** Label heading a sub-list inside a section (e.g. minimized windows). */
  sectionLabel: Style;
  /** Style merged into a row whose target is open. */
  activeRow: Style;
  /** Style merged into a row whose target is closed (restores the resting row). */
  inactiveRow: Style;
  /**
   * Row style, carrying the label as a tooltip when compact rows hide it.
   * With a launcher key, the row draws that launcher's vector icon.
   */
  rowStyle(label: string, key?: DockLauncher): Style;
  /** Launcher row text: the label, or nothing when compact (the icon stands alone). */
  rowText(key: DockLauncher, label: string): string;
  /** Expanded section header text: chevron + label in chrome case. */
  headerText(label: string, collapsed: boolean): string;
}

export function dockStyles(theme: ThemeData, compact: boolean): DockStyles {
  const align = compact ? 'center' : 'left';
  const radius = theme.tokens.radius.sm;

  // Flat square rows in the window ground; headers are solid accent blocks;
  // the active marker is carried by activeItemBorder.
  const row: Style = {
    background: theme.windowBg, flat: true,
    color: theme.textPrimary, radius,
    align, fontSize: compact ? 16 : 13,
  };
  const gear: Style = { background: theme.windowBg, flat: true, color: theme.textPrimary, radius, fontSize: 13, icon: 'gear' };
  const header: Style = {
    background: theme.accent, flat: true, color: theme.actionText, radius,
    fontSize: 13, fontWeight: 'bold', fontFamily: 'display', align,
  };
  const sectionLabel: Style = { color: theme.textPrimary, fontSize: 12, fontWeight: 'bold', fontFamily: 'display', align };
  const activeRow: Style = { background: theme.activeItemBg, borderColor: theme.activeItemBorder };
  const inactiveRow: Style = { background: theme.windowBg, borderColor: theme.windowBg };

  return {
    compact,
    row,
    gear,
    header,
    sectionLabel,
    activeRow,
    inactiveRow,
    rowStyle: (label: string, key?: DockLauncher) => {
      const withIcon = key ? { ...row, icon: DOCK_LAUNCHERS[key].icon } : row;
      return compact ? { ...withIcon, tooltip: label } : withIcon;
    },
    rowText: (_key: DockLauncher, label: string) => (compact ? '' : label),
    headerText: (label: string, collapsed: boolean) =>
      `${collapsed ? '\u25B8' : '\u25BE'} ${chromeCase(theme, label)}`,
  };
}

/** Two-digit Space numeral ("01", "02", ...) for the Spaces list. */
export function spaceNumeral(index: number): string {
  return String(index + 1).padStart(2, '0');
}
