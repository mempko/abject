/**
 * The desktop dock's widths, shared by the Sidebar that draws the dock and the
 * WorkspaceManager that lays the toolbars out beside it. Plain numbers, so the
 * WorkspaceManager (which runs on every edition) does not import the Sidebar.
 */

/** Dock width: 120px rows + root margins, with room for the section scrollbar. */
export const SIDEBAR_WIDTH = 168;
/** Compact dock width: icon-only rows + root margins. */
export const SIDEBAR_COMPACT_WIDTH = 56;
