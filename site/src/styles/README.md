# site/src/styles/ - The Site's Design System

One global stylesheet: Red Sigil, the app's default theme, set as print. Every
page gets it through `layouts/Layout.astro`; components add their own scoped
`<style>` on top and use these tokens and classes.

## Files

- **global.css**, in order:
  - **Tokens** on `:root`: grounds (`--void`, `--sunken`, `--panel`,
    `--band`), ink (`--bone` and its steps), rules, the voices (`--red` for the
    human hand and actions, `--living` green for what is alive, `--brass`,
    `--commons`, `--info`, `--error`), print shadows (`--print`,
    `--print-red`), type (`--font-display` Oswald, `--font-body` PT Sans,
    `--font-mono` JetBrains Mono, each with fallbacks) and space
    (`--max-width`, `--section-gap`, `--gutter`). A block of legacy names
    (`--accent`, `--text-primary`, `--eldritch`, ...) maps older component
    styles onto these roles.
  - **Motion**: shared keyframes, and a `prefers-reduced-motion` rule that
    stops animation and transitions site-wide.
  - **Base, typography, layout**: `.container`, `section`, `.section-head`,
    `.kicker`, `.section-title`, `.lede`.
  - **Code, grids, buttons, small marks**: code blocks, `.grid-2/3/4`,
    `.btn`, `.btn-primary`, `.btn-outline`, `.tag`, `.band`, `.sigil`.
  - **Window and screenshot frames**: `.win`, `.win-bar`, `.win-body`,
    `.shot` (used by `components/ui/Win.astro` and `Shot.astro`).
  - **Composition devices**: `.field-red` and `.field-paper` (full-bleed red
    and paper grounds, which set `--field-ink`, `--field-rule` and
    `--field-accent` for their content), `.cut-top` / `.cut-bottom` (slanted
    section edges), `.ledger`, `.stat`, `.split`, `.stepper`, `.mosaic`,
    `.strip`, `.poster-quote`.
  - **Responsive** breakpoints and the **scrollbar**.

## Rules the file states

- The void is the ground; bone ink carries the text.
- Red marks the human hand: actions, the current thing, section bands.
- The living green marks what is alive and is the only colour that glows.
- Print, not glass: square corners, ruled frames, hard offset shadows, no
  blur or gradients on surfaces.
- Keep `.win`, `Win` and `Shot` for things that really are software on
  screen; everything else uses a composition device, and neighbouring
  sections use different ones.

## Gotchas

- The colours are duplicated in `scripts/sigil-bg.js` (its palette `P`) and
  `tools/og-card.html`; change them together.
- Components inside a `.field-red` or `.field-paper` should read the
  `--field-*` variables rather than the bone tokens, or their text disappears
  into the ground.

## Related

- [../layouts/README.md](../layouts/README.md): where the stylesheet is imported
- [../components/README.md](../components/README.md): the components that use it
- [../scripts/README.md](../scripts/README.md): the background drawn in the same palette
