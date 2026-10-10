# src/objects/widgets/ - Canvas Widget Toolkit

The desktop's widget toolkit. Every window, layout and widget is a full Abject
with its own id, mailbox and handlers; they talk to each other, to their owner
and to UIServer only by message. A window owns one UIServer surface, asks its
children for draw commands (Morphic's `drawOn:`), and routes input back down
to them. WidgetManager (`src/objects/widget-manager.ts`) is the factory every
other object uses to build UI out of these classes.

This is display code. It exists only in the desktop edition: the headless
server has no WidgetManager, UIServer or windows.

## Architecture

```
  owner Abject ──create / createWindowAbject / createVBox──▶ WidgetManager
       ▲                                                    (spawns on its own bus,
       │ changed(aspect) events                              returns AbjectIds)
       │                                                          │
  WindowAbject ──render { surfaceId, ox, oy }──▶ LayoutAbject ──render──▶ widgets
       │  ◀──────────── draw commands (window px) ──────────────────────┘
       │
       ├──draw { commands }──▶ UIServer (BackendUI) ──wire──▶ browser Compositor
       ├──scene { ops }─────▶ (3D nodes on the window's subtree)
       │
       └──◀── input ── UIServer ◀── client hit test (surface-local x, y)
             └─ hit test ─▶ handleInput to the child under the pointer
                            (keydown goes to the focused child)
```

**Rendering.** A widget implements `buildDrawCommands(surfaceId, ox, oy)` and
answers `render` with commands in window coordinates. When a widget changes it
sends `childDirty` to its window, which schedules one frame: it draws its
chrome (title band, ink frame, resize grip), requests `render` from every
child in parallel, and sends the whole batch to UIServer as one `draw`.
Layouts pass `render` on to their children at computed offsets;
ScrollableVBoxLayout skips children wholly outside its viewport (with
`viewportClip`) and tells a child it stopped drawing with `viewportCulled`.

**Input.** UIServer delivers `input` (surface-local coordinates) to the window
that owns the surface. The window strips the title bar, hit-tests its
children, and sends `handleInput` to the one hit; layouts do the same for
their children. Keyboard events skip layouts and go to the focused widget.
Tab moves focus through `getFocusableWidgets()`; keys nobody consumes come out
of the window as `keyUnhandled`. Title-bar drags and resizes are handled by
UIServer and WindowManager, with the move itself done client-side.

**Events.** Widgets report to dependents with `changed(aspect, value)` (an
owner calls `addDependent` on a widget or window to listen). WidgetManager is
a dependent of every window and forwards some window aspects to the window's
owner (`windowCloseRequested`, `windowMinimized`, `windowRestored`, and
`windowRect` as `windowMoved` / `windowResized`).

**3D.** A window fronts the scene vocabulary for its surface: `scene { ops }`
adds retained nodes to the window's subtree (any Abject may contribute; UIServer
routes those nodes' input back to the contributor and removes them when it
dies), and `draw { nodeId, commands }` paints a `kind: 'canvas'` layer node.
CanvasWidget, GraphWidget, pop-outs and widget decorations are built on these
two messages. See [../../ui/README.md](../../ui/README.md).

**Where it runs.** WidgetManager inits every window, layout and built-in widget
on its own bus, so the widget tree lives in WidgetManager's worker (a
registered custom widget lives wherever its factory put it). UIServer
(BackendUI) runs in the dedicated UI worker.

## Class Hierarchy

```
Abject
├── WindowAbject                  top-level composite; owns the surface
└── WidgetAbject                  abstract: render, update, handleInput, ...
    ├── LayoutAbject              abstract container (children + size policies)
    │   ├── VBoxLayout
    │   │   ├── ScrollableVBoxLayout
    │   │   └── FormWidget        schema-driven form that owns its fields
    │   └── HBoxLayout
    ├── LabelWidget
    │   ├── MarkdownWidget
    │   └── ContentBlockWidget
    ├── ButtonWidget, TextInputWidget, TextAreaWidget, CheckboxWidget,
    │   SliderWidget, SelectWidget, TabBarWidget
    ├── ProgressWidget, DividerWidget, ImageWidget, VideoWidget, ThemeSwatchWidget
    ├── ListWidget, TreeWidget, TableWidget, ChartWidget, GoalProgressWidget
    ├── SplitPaneWidget           two children and a draggable divider
    ├── CanvasWidget              layout-managed 2D canvas layer
    └── GraphWidget               3D node graph ('nodeGraph')
```

Spec type names for `create({ specs })` are the `WidgetType` union in
`widget-types.ts` (`label`, `markdown`, `contentBlock`, `button`, `textInput`,
`textArea`, `checkbox`, `progress`, `divider`, `select`, `tabBar`, `slider`,
`image`, `themeSwatch`, `goalProgress`, `list`, `tree`, `splitPane`, `table`,
`form`, `chart`, `video`, `nodeGraph`). WidgetManager also maps common names
from other toolkits (`comboBox`, `lineEdit`, `textarea`, `grid`, ...) to these.
Canvases come from `createCanvas`.

## Size Policies

Layout children carry a size policy per axis:

- `fixed`: exactly its preferred size, never grows
- `preferred`: its preferred size, does not expand
- `expanding`: shares the remaining space by `stretch` factor

VBox sums the fixed and preferred heights plus spacing, then splits what is
left among expanding children; HBox does the same for widths. A box layout
never shrinks fixed or preferred children: when they do not fit, the layout
records a `LayoutOverflow` and reports it to WidgetManager (`layoutOverflow`),
which lists it in `listLayoutIssues`.

## Files

### Base classes and shared code

- **`widget-abject.ts`**: `WidgetAbject`, the abstract base. Subclasses
  implement `buildDrawCommands`, `processInput` (returns `{ consumed }`),
  `getWidgetValue` and `applyUpdate`. Handles `render`, `update`,
  `handleInput`, `setFocused`, `getValue`, `updateTheme`, `destroy`, layout
  attach/detach, `href` links (opened through UIServer), the `busy` look, and
  `sceneDecorations()` (retained 3D decorations around the widget's rect,
  added, moved and removed with it). Holds a per-process font-metrics cache so
  text measures locally instead of asking UIServer per word.
- **`window-abject.ts`**: `WindowAbject`. Owns the surface; draws chrome with
  the close, minimize, maximize and help (`?`) title buttons; renders children;
  routes input and focus; fronts `scene`, `draw`, `effect`, `setModal`,
  `setSlabTransform`, `setFocusDecoration`, `attachTo` (ride a scene node) and
  `openFilePicker` / `fileUploaded`. Emits `windowFocus`, `windowRect`,
  `windowCloseRequested`, `windowMinimized`, `windowMaximized`,
  `windowHelpRequested`, `nodeInput`, `keyUnhandled`.
- **`layout-abject.ts`**: `LayoutAbject`. Child list with size policies and
  spacers (`addLayoutChild`, `addLayoutChildren`, `addLayoutSpacer`,
  `updateLayoutChild`, `removeLayoutChild`, `clearLayoutChildren`), margins,
  `getPreferredHeight`, `getFocusableWidgets`, overflow reporting. Draws
  expanded children (an open select) last.
- **`widget-types.ts`**: shared types and constants (`WidgetStyle`,
  `WidgetType`, `SizePolicy`, `Rect`, interface ids, draw-command names and
  aliases, `TITLE_BAR_HEIGHT`), size helpers (`resolveWH`, `coerceRect`),
  theme-aware fonts (`fontStacks`, `widgetFont`, `titleFont`, `codeFont`),
  colour math and the design draw helpers (`inkFrame`, `raisedBlock`, `wedge`,
  `hatch`, `squareMark`).
- **`popout.ts`**: `PopoutSurface` and placement. A pop-out is a `kind:
  'canvas'` node on the window with `clip: 'none'` and `interactive: true`, so
  a dropdown list, menu or tooltip can reach past the window's edge; it flips
  toward the side of the screen with room. Also the tooltip draw helpers.

### Layouts

- **`vbox-layout.ts`**: `VBoxLayout`, top to bottom.
- **`hbox-layout.ts`**: `HBoxLayout`, left to right.
- **`scrollable-vbox-layout.ts`**: `ScrollableVBoxLayout`. VBox with clipping,
  an 8 px scrollbar, wheel and keyboard scrolling (`scrollKey`), optional
  `autoScroll` (stick to the bottom), and viewport culling.

### Input widgets

- **`button-widget.ts`**: `ButtonWidget`. Flat print block with a hard offset
  shadow; `click` on mousedown or Enter/Space; optional `style.icon` from
  `src/ui/icons.ts`.
- **`text-input-widget.ts`**: `TextInputWidget`. Single line (optionally
  wrapping), cursor, selection, clipboard, undo, masking, placeholder. Events
  `change`, `submit`, `resize`, `attach`.
- **`text-area-widget.ts`**: `TextAreaWidget`. Multi-line editor with scrolling,
  selection, paste, Tab indent, optional word wrap and monospace. Event
  `change`.
- **`text-edit-helpers.ts`**: word-boundary motion and `EditHistory` (undo/redo
  with typing-burst coalescing), shared by the two text widgets.
- **`checkbox-widget.ts`**: `CheckboxWidget`. Box plus label; `change` on click
  or Space.
- **`slider-widget.ts`**: `SliderWidget`. Min/max/step, arrow and Home/End keys;
  `change` with the value as a string.
- **`select-widget.ts`**: `SelectWidget`. Dropdown whose list opens as a
  pop-out, scrolls when long, and gets a filter box past one page; `change`.
- **`tabbar-widget.ts`**: `TabBarWidget`. Slanted tabs, active one an accent
  slab, arrow keys, double-click to rename; `change`, `close`, `rename`.
- **`form-widget.ts`**: `FormWidget`. Builds labelled inputs from a JSON-schema
  shaped `schema` (enum → select, boolean → checkbox, numbers validated),
  validates on submit; `submit`, `contentHeight`, `getValues`, `setValues`.

### Display widgets

- **`label-widget.ts`**: `LabelWidget`. Text with alignment, optional word
  wrap, markdown, read-only selection and `href` links; `click`.
- **`markdown-widget.ts`**: `MarkdownWidget`. A label preset for markdown with
  inline images (`data:`, `abject://`, http(s)).
- **`content-block-widget.ts`**: `ContentBlockWidget`. Wrapped markdown that
  measures itself and reports `contentHeight`.
- **`image-widget.ts`**: `ImageWidget`. contain/cover/fill, alt text, `click`;
  remote URLs are fetched server-side into data URIs.
- **`video-widget.ts`**: `VideoWidget`. Plays a URL, data URI, `abject://` file
  or a live MediaStream `streamId`. Frames never cross the wire: a
  `videoFrame` draw command marks a live region the client composites each
  frame. Events `playing`, `paused`, `ended`, `error`.
- **`progress-widget.ts`**, **`divider-widget.ts`**: progress bar (0 to 1) and
  separator line.
- **`theme-swatch-widget.ts`**: `ThemeSwatchWidget`. A mini window drawn in a
  preview theme; `click` with `{ themeId }`.

### Data widgets

- **`list-widget.ts`**: `ListWidget`. Selectable, scrollable rows with optional
  search and per-row action buttons; `selectionChanged`, `action`, `confirm`.
- **`tree-widget.ts`**: `TreeWidget`. Flat rows with depth; the owner keeps the
  expand state. `selectionChanged`, `toggle`.
- **`table-widget.ts`**: `TableWidget`. Sortable columns, row selection,
  optional inline editing; `rowSelected`, `cellEdited`.
- **`chart-widget.ts`**: `ChartWidget`. Line, bar, area, pie and sparkline from
  plain series data in theme colours; `pointClicked`.
- **`goal-progress-widget.ts`**: `GoalProgressWidget`. Wrapping goal tree rows
  with per-row controls; `toggle`, `goalAction`, `contentHeight`.
- **`split-pane-widget.ts`**: `SplitPaneWidget`. Two children with a draggable
  divider (`setLeftChild` / `setRightChild` or top/bottom); `dividerMoved`.

### Canvas and 3D

- **`canvas-widget.ts`**: `CanvasWidget`. A layout-managed backdrop canvas
  layer. Draw batches (`draw`) are validated and piped through the window's
  draw channel; painting is incremental and `clear` restarts it. Raw input
  goes to `inputTargetId` as `input` events (including `canvasResize` and
  `paste`).
- **`graph-widget.ts`**: `GraphWidget`. A 3D node graph drawn as retained scene
  nodes inside the widget's rect through the window's own camera; turning,
  zoom, hover and pulses run in the browser. `setGraph`, `upsertNodes`,
  `removeNodes`, `upsertEdges`, `removeEdges`, `select`, `focusNode`,
  `highlight`, `pulse`, `getSelection`, `getGraph`; `nodeSelected`,
  `nodeFocused`.
- **`graph-layout.ts`**: pure force-directed 3D layout and rotation math for
  GraphWidget (no bus, no DOM).

### Text and markdown

- **`markdown.ts`**: markdown parser into blocks and spans with source offsets
  (for selection).
- **`rich-text-layout.ts`**: multi-font word wrap of parsed markdown into
  positioned runs.
- **`markdown-render.ts`**: `renderRichTextCommands`, the one place laid-out
  markdown becomes draw commands (labels, markdown widgets, text input
  preview, the canvas `markdown` command).
- **`markdown-image-resolver.ts`**: turns image sources into drawable data
  URIs (`data:` as is, `abject://<typeId>/<path>` through that FileSystem,
  http(s) fetched server-side) and caches them. AudioOutput and VideoWidget
  reuse its `abject://` parsing.
- **`word-wrap.ts`**: `wrapText` (measured) and `estimateWrappedLineCount`
  (heuristic).
- **`handler-parser.ts`**: parses a ScriptableAbject handler map into entries,
  reassembles it, and tokenizes lines for syntax highlighting (AbjectEditor).

### Tests

- **`layout-overflow.test.ts`**: box-layout overflow reporting, run by
  `pnpm test`.

## Adding a Widget

### Built in

1. Create `<name>-widget.ts` extending `WidgetAbject` (or `LayoutAbject` for a
   container). Implement `buildDrawCommands`, `processInput`,
   `getWidgetValue` and `applyUpdate`; call `requestRedraw` or send
   `childDirty` to repaint; report changes with `changed(aspect, value)`.
2. Read colours from `this.theme` and structure from `shapeOf(theme)`
   (`src/core/theme-data.ts`); use the font helpers in `widget-types.ts`.
3. Add the type to `WidgetType` in `widget-types.ts`, to
   `VALID_WIDGET_TYPES` and the dispatch in `createWidgetFromSpec` in
   `widget-manager.ts`, and describe it in WidgetManager's ask guide.

### From any Abject, at runtime

`WidgetManager.registerWidgetType({ type, description, params?, factoryId? })`
adds a type every Abject can then create with `create({ specs: [{ type,
windowId, ... }] })`. The factory (default: the caller) answers
`createWidget({ spec, windowId, rect, theme, uiServerId })` with the AbjectId
of an Abject that speaks the widget protocol: `render({ surfaceId, ox, oy,
viewportClip? })` returns draw commands, `update({ rect?, ... })`,
`handleInput(input)` returns `{ consumed }`, and optionally `setFocused`,
`getValue`, `updateTheme`, `destroy`. It repaints by sending the event
`childDirty({ widgetId })` to its window. A registered type cannot shadow a
built-in name; `unregisterWidgetType` and `listWidgetTypes` complete the set.

### Motion and decoration

Window effects and lifecycle transitions are declarative data
(`src/ui/gl/slab-motion.ts`) evaluated by the client compositor; geometry and
input never change. On WidgetManager: `windowEffect`, `registerWindowEffect`,
`unregisterWindowEffect`, `listWindowEffects`, `setWindowTransitions`,
`setModalStyle`, `setWindowModal`, `getMotion`, `resetMotion`,
`setFocusDecoration` / `getFocusDecoration` (the scene ops the focused window
wears). On a window: `effect`, `setModal`, `setFocusDecoration`,
`setSlabTransform`. Particles, rings and the `shake` / `flash` / `float`
animate presets are part of the window `scene` vocabulary.

## Dialogs

DialogBroker owns every question to the person. WidgetManager is its
presenter for `confirm` and `prompt` dialogs: the broker sends
`presentDialog`, WidgetManager draws it with a ModalDialog
(`src/objects/modal-dialog.ts`, which heartbeats while it is open) and reports
the click back with `respond`; `dismissDialog` closes one a terminal answered
first. `showConfirmDialog` and `showPromptDialog` on WidgetManager remain for
callers and forward to the broker's `askPerson`. WidgetManager accepts
`presentDialog` and `dismissDialog` only from DialogBroker.

## Gotchas

- **Headless.** Widget, window and display modules must never be imported by
  code that runs on the headless edition. `scripts/headless-bundle-check.mjs`
  fails the build if `window-abject.ts`, any `*-widget.ts`, WidgetManager or
  the other display modules reach a headless bundle. Type-only imports are
  erased and fine; pure helpers (`widget-types.ts`, `markdown.ts`,
  `word-wrap.ts`) are allowed. Put plain numbers that non-UI code needs in
  `src/core`, as `src/core/dock-layout.ts` does for the sidebar widths.
- **Events can arrive twice.** `changed()` sends each dependent a generic
  `changed` event and an event named after the aspect. An owner that is a
  dependent of its window and also receives WidgetManager's forward of the
  same aspect handles it twice; keep such handlers idempotent or listen on one
  path.
- **Self-sizing widgets start at height 0.** ContentBlock, GoalProgress and
  Form learn their height by drawing once and reporting `contentHeight`; the
  owner then calls `updateLayoutChild`. ScrollableVBoxLayout always renders
  zero-height children so they get that first pass.
- **Coordinates.** `render` gets window coordinates (`ox`, `oy` already include
  the title bar); `processInput` gets widget-local coordinates. Sizes accept
  `w`/`h` (preferred) or `width`/`height`.
- **Remote images.** Draw remote images as data URIs fetched server-side, as
  ImageWidget does. A cross-origin image would taint the surface canvas.
- **Chrome case.** Uppercase is applied at draw time to system chrome only
  (`chromeCase`), never to user text. Explicit caller style (colours, radius)
  wins over the theme.
- **Owner lifetime.** WidgetManager destroys an owner's windows when the owner
  unregisters; widgets that lose their window go away on `recipientGone`.

## Related

- [../../ui/README.md](../../ui/README.md): the compositor and the draw and
  scene vocabularies these widgets emit
- [../../ui/gl/README.md](../../ui/gl/README.md): scene node kinds, slab motion
- [../README.md](../README.md): WidgetManager, WindowManager, DialogBroker,
  Theme
- [../../../client/README.md](../../../client/README.md): where the commands
  are drawn
