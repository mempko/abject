/**
 * Shared design helpers for system Abjects' windows.
 *
 * Small pure functions that return widget styles, texts and scene ops in the
 * design language, so every system window builds its headers, empty states
 * and sigils the same way. Colours come from the theme (a palette).
 */

import type { ThemeData } from '../core/theme-data.js';
import { chromeCase } from '../core/theme-data.js';
import type { WidgetStyle } from './widgets/widget-types.js';

/** Label style for a section header inside a window (not user text). */
export function sectionHeaderStyle(theme: ThemeData, size = 13): WidgetStyle {
  return { color: theme.textHeading, fontWeight: 'bold', fontSize: size, fontFamily: 'display' };
}

/** Section header text in chrome case, led by the sigil ring mark (◉). */
export function sectionHeaderText(theme: ThemeData, text: string): string {
  return `\u25C9  ${chromeCase(theme, text)}`;
}

/** Muted helper-text style (descriptions under headers, hints). */
export function hintStyle(theme: ThemeData, size = 12): WidgetStyle {
  return { color: theme.textSecondary, fontSize: size, wordWrap: true };
}

/**
 * Markdown for an empty state: a short title and one line saying what to do
 * next. Render it in a markdown label with `emptyStateStyle`.
 */
export function emptyStateMarkdown(title: string, hint: string): string {
  return `**${title}**\n\n${hint}`;
}

/** Style for an empty-state markdown label (centered, muted). */
export function emptyStateStyle(theme: ThemeData): WidgetStyle {
  return { color: theme.textSecondary, fontSize: 13, markdown: true, wordWrap: true, align: 'center' };
}

/** Style for a live/"alive" status label: the living light (accentSecondary). */
export function livingStyle(theme: ThemeData, size = 12): WidgetStyle {
  return { color: theme.accentSecondary, fontSize: size };
}

/** One scene op as accepted by a window's `scene` method. */
export type SceneOp = Record<string, unknown>;

/**
 * A small 3D eye sigil for a window's `scene` method: a bone ring facing the
 * viewer, a red inner ring, a phosphor slit pupil that breathes, and a red
 * square satellite orbiting it. All motion is client-side `animate` ops (one
 * batch, no per-frame traffic). `at` is px from the window centre (+y down,
 * +z toward the viewer); `size` is the ring diameter in px. Colours are theme
 * tokens, so the sigil re-skins on a theme change. Prefix node ids so several
 * sigils can coexist; remove it with `removeSigilOps(prefix)`.
 */
export function eyeSigilOps(prefix: string, at: [number, number, number], size = 34): SceneOp[] {
  const faceViewer: [number, number, number] = [Math.PI / 2, 0, 0];
  const g = `${prefix}-sigil`;
  return [
    { op: 'add', id: g, kind: 'group', transform: { position: at } },
    {
      op: 'add', id: `${g}-ring`, parentId: g, kind: 'mesh',
      transform: { rotation: faceViewer, scale: [size, size, size] },
      params: { primitive: 'torus', color: '$textPrimary', emissive: '$textPrimary', roughness: 1 },
    },
    {
      op: 'add', id: `${g}-inner`, parentId: g, kind: 'mesh',
      transform: { rotation: faceViewer, scale: [size * 0.62, size * 0.62, size * 0.62] },
      params: { primitive: 'torus', color: '$accent', emissive: '$accent', roughness: 1 },
    },
    {
      op: 'add', id: `${g}-pupil`, parentId: g, kind: 'mesh',
      transform: { position: [0, 0, 2], scale: [size * 0.12, size * 0.42, size * 0.12] },
      params: { primitive: 'sphere', color: '$accentSecondary', emissive: '$accentSecondary' },
    },
    {
      op: 'add', id: `${g}-sat`, parentId: g, kind: 'mesh',
      transform: { position: [size * 0.62, 0, 0], scale: [size * 0.14, size * 0.14, size * 0.14] },
      params: { primitive: 'box', color: '$accent', emissive: '$accent' },
    },
    { op: 'animate', id: `${g}-pupil`, params: { preset: 'pulse', scale: 1.25, duration: 1800 } },
    {
      op: 'animate', id: `${g}-sat`,
      params: { preset: 'orbit', center: [0, 0, 0], radius: size * 0.62, plane: 'xy', duration: 9000 },
    },
  ];
}

/** Remove an eye sigil added with `eyeSigilOps(prefix, ...)`. */
export function removeSigilOps(prefix: string): SceneOp[] {
  return [{ op: 'remove', id: `${prefix}-sigil` }];
}
