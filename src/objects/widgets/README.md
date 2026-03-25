# src/objects/widgets/ - Canvas Widget Toolkit

Qt-like widget system rendered via UIServer surfaces. Every widget is a first-class Abject with its own ID, mailbox, and message handlers. Widgets communicate with their parent window and with each other entirely through message passing.

## Widget Hierarchy

```
Abject
├── WindowAbject                     (top-level, owns UIServer surface)
│   └── children:
│       ├── WidgetAbject             (abstract base for all widgets)
│       │   ├── LabelWidget          (static text, word-wrap)
│       │   ├── ButtonWidget         (clickable, hover/focus states)
│       │   ├── TextInputWidget      (single-line, cursor, selection)
│       │   ├── TextAreaWidget       (multi-line, scrolling)
│       │   ├── CheckboxWidget       (toggle with label)
│       │   ├── SliderWidget         (numeric, draggable thumb)
│       │   ├── ProgressWidget       (read-only bar, 0-1)
│       │   ├── DividerWidget        (horizontal/vertical line)
│       │   ├── SelectWidget         (dropdown, expandable list)
│       │   ├── TabBarWidget         (horizontal tabs)
│       │   ├── ImageWidget          (URL-based, fit modes)
│       │   ├── CanvasWidget         (custom draw commands)
│       │   └── LayoutAbject         (abstract layout container)
│       │       ├── VBoxLayout       (vertical stacking)
│       │       │   └── ScrollableVBoxLayout (+ scrollbar)
│       │       └── HBoxLayout       (horizontal stacking)
│       └── Spacers                  (flexible gaps in layouts)
```

## Layout System

```
┌─ WindowAbject ──────────────────────────────────┐
│  Title Bar  [_][X]                              │
│ ┌─ VBoxLayout ────────────────────────────────┐ │
│ │ ┌─ HBoxLayout ───────────────────────────┐  │ │
│ │ │  [Label]  [TextInput: expanding]       │  │ │
│ │ └────────────────────────────────────────┘  │ │
│ │                                             │ │
│ │  ┌─ ScrollableVBoxLayout ────────────────┐  │ │
│ │  │  [ButtonWidget]                     ▲ │  │ │
│ │  │  [ButtonWidget]                     █ │  │ │
│ │  │  [CheckboxWidget]                   █ │  │ │
│ │  │  [SliderWidget]                     ▼ │  │ │
│ │  └───────────────────────────────────────┘  │ │
│ │                                             │ │
│ │  [ProgressWidget: expanding]                │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘

Size Policies:
  fixed     → exact preferredSize, never grows
  preferred → uses preferredSize, doesn't expand
  expanding → fills remaining space (stretch factor)
```

## Files

### Base Classes

| File | Class | Description |
|------|-------|-------------|
| `widget-types.ts` | - | Shared types (`WidgetStyle`, `SizePolicy`, `Rect`, `ThemeData`), `MIDNIGHT_BLOOM` theme, color utilities |
| `widget-abject.ts` | `WidgetAbject` | Abstract base for all widgets. Defines `buildDrawCommands()`, `processInput()`, `getWidgetValue()`, `applyUpdate()` |
| `window-abject.ts` | `WindowAbject` | Top-level composite. Owns UIServer surface, renders title bar, routes input to children with hit-testing, manages focus and Tab navigation |
| `layout-abject.ts` | `LayoutAbject` | Abstract layout container. Manages child list with size policies, two-pass rendering (expanded dropdowns on top), hover tracking |
| `word-wrap.ts` | - | Text wrapping utilities: `wrapText()` (async, precise) and `estimateWrappedLineCount()` (sync heuristic) |

### Layout Widgets

| File | Class | Description |
|------|-------|-------------|
| `vbox-layout.ts` | `VBoxLayout` | Vertical top-to-bottom layout. Distributes height by size policy and stretch factor |
| `hbox-layout.ts` | `HBoxLayout` | Horizontal left-to-right layout. Mirror of VBox for width allocation |
| `scrollable-vbox-layout.ts` | `ScrollableVBoxLayout` | VBox with overflow clipping and 8px scrollbar. Mouse wheel scrolling, skips off-screen children |

### Input Widgets

| File | Class | Description |
|------|-------|-------------|
| `button-widget.ts` | `ButtonWidget` | Rounded rect with gradient. States: normal, hovered, focused (glow), disabled. Fires `click` on mousedown or Enter/Space |
| `text-input-widget.ts` | `TextInputWidget` | Single-line input with cursor, selection, copy/cut/paste. Optional password masking. Fires `change` and `submit` |
| `text-area-widget.ts` | `TextAreaWidget` | Multi-line editor with scrolling. Line-by-line cursor navigation, Tab inserts spaces. Optional monospace font |
| `checkbox-widget.ts` | `CheckboxWidget` | 16x16 box with checkmark + label. Toggle on click or Space. Fires `change` with `'true'`/`'false'` |
| `slider-widget.ts` | `SliderWidget` | Horizontal slider with draggable thumb. Configurable min/max/step. Keyboard: Arrow keys, Home/End |
| `select-widget.ts` | `SelectWidget` | Dropdown with expandable option list. Keyboard: arrows navigate, Enter selects, Escape closes. Emits `expanded` state |
| `tabbar-widget.ts` | `TabBarWidget` | Horizontal tabs with amber active indicator. Keyboard: ArrowLeft/Right. Fires `change` with selected index |

### Display Widgets

| File | Class | Description |
|------|-------|-------------|
| `label-widget.ts` | `LabelWidget` | Static text with word-wrap. Fires `click` on mousedown (via addDependent). Alignment: left/center/right. Caches wrapped lines |
| `progress-widget.ts` | `ProgressWidget` | Read-only bar (0-1 range). Gradient fill with optional percentage text |
| `divider-widget.ts` | `DividerWidget` | Single line separator. Auto-detects horizontal vs vertical from dimensions |
| `image-widget.ts` | `ImageWidget` | Displays image via URL. Fires `click` on mousedown (via addDependent). Fit modes: contain/cover/fill. Alt text fallback |

### Advanced Widgets

| File | Class | Description |
|------|-------|-------------|
| `canvas-widget.ts` | `CanvasWidget` | Renders user-supplied draw commands. Forwards input to a target `AbjectId` (typically a ScriptableAbject). Emits `canvasResize` on rect change |

## Key Patterns

### Morphic-style Rendering

Widgets implement `buildDrawCommands()` which returns an array of `DrawCommand` objects. The parent `WindowAbject` collects commands from all children (translated to window coordinates) and sends them to UIServer in a single `draw()` call. This mirrors Morphic's `drawOn:` protocol.

### Input Dispatch

```
UIServer input event
  → WindowAbject.processInput()
    → translate to content-area coordinates (subtract title bar)
    → LayoutAbject.processInput()
      → translate to child-local coordinates
      → WidgetAbject.processInput()
        → returns { consumed: boolean, focusWidgetId? }
```

### Size Policy Algorithm (VBox example)

1. Sum fixed/preferred heights + spacing
2. Remaining = container height - sum
3. Expanding children share remaining proportionally by `stretch` factor
4. Width determined by horizontal policy (fixed/preferred/expanding)

### Theme

All widgets read colors from `this.theme` (`ThemeData`). The default `MIDNIGHT_BLOOM` theme provides a dark palette with amber (`#39ff8e`) accents. The `ThemeAbject` broadcasts theme changes to all dependents.

### Focus Management

`WindowAbject` tracks `focusedChildId`. Tab key cycles through focusable widgets (layouts implement `getFocusableWidgets()` recursively for nested containers). Focused widgets render a glow shadow for visual feedback.
