# site/src/components/ - Section Components

The building blocks of the site's pages. Each file is one section (or the
header or footer) with its own scoped `<style>`, and most of the copy lives
in arrays in the component's frontmatter. The shared kit (window frames,
screenshots, section headers, the lightbox) is in `ui/`.

## Conventions

- A section renders `<section id="...">` with a `SectionHead` and takes a
  `num` prop for its section number, with a default; the page passes the
  number it wants (`<Features num="06" />`). The `id` is the anchor other
  pages link to.
- Shared classes and tokens come from `../styles/global.css` (`.container`,
  `.field-red`, `.field-paper`, `.cut-top`, `.split`, `.ledger`, `.stepper`,
  `.mosaic`, `.stat`, `.tag`, the `--red` / `--bone` / `--living` tokens).
  `/why`'s long-form styles live in `pages/why.astro` (`.why-page`), so
  `Symbiogenesis`, `AskProtocol` and `Emergence` depend on that page.
- Screenshots go through `ui/Shot.astro` with an id from `data/shots.ts`,
  never a raw `<img>`.

## Files

| Component | Used on | What it is |
|---|---|---|
| `Header.astro` | every page | Title band: sigil and wordmark, page links, the red Download block (to `/#downloads`), community links; folds into a `<details>` menu below 860px |
| `Footer.astro` | every page | Red band, then a colophon: the mark, the pages, the community links (GitHub, Reddit, Discord, `/links`) |
| `Hero.astro` | `/` | The front poster: headline, the pitch, an OS-aware download button (reads `lib/releases.ts`), the three-things index, the `hero` shot |
| `BigIdea.astro` | `/` (00) | Every object can be asked: `ask(question)`, an animated ask demo in two `Win` cards, and what is built on it |
| `SayIt.astro` | `/` (01, `#make`) | The `tour` clip, real requests beside what they produced (`nasaViewer`, `tasksPair`, `wikigraph` shots), and the "make it look like anything" strip (`scene3d`, `materials`, `expose`) |
| `Team.astro` | `/` (02, `#team`) | The sprint loop drawn large, and four facts about how the team runs |
| `Learns.astro` | `/` (03, `#learns`) | The learning loop (predict, act, compare, learn, weave), the `patterns` shot, named patterns with usefulness counts |
| `Yours.astro` | `/` (04, `#yours`) | Your machine, any model (the fourteen providers as a strip), your devices, open source |
| `GetAbject.astro` | `/` (05, `#get`) | Section head, then `Downloads` with its own head hidden, a four-step start and four first questions |
| `Downloads.astro` | inside `GetAbject` | `#downloads`: desktop builds per platform with sizes, the command-line card (install one-liners and headless archive links, shown when the release has them), the phone card, and the visitor's platform highlighted by script |
| `WhyDifferent.astro` | `/why` (01, `#why`) | Three poster columns: not a chatbot, not an agent framework, not a cloud |
| `Symbiogenesis.astro` | `/why` (02) | How Abject differs: the thesis and four comparisons |
| `AskProtocol.astro` | `/why` (03) | The Ask Protocol in brief: quote, prose, the exchange drawn large, three uses |
| `Emergence.astro` | `/why` (04, `#emergence`) | Goals run in sprints: the loop, the lifecycle, three comparisons with other systems |
| `Architecture.astro` | `/why` (05, `#architecture`) | How it runs: the surface, the depths, the containment |
| `Features.astro` | `/why` (06, `#features`) | Capabilities, each tagged with the abjects that provide it (`#capabilities` inside) |
| `Spreading.astro` | `/why` (07) | The mesh: just you, people you name, the commons |
| `Lineage.astro` | `/why` (08) | It started with Fire★ |
| `Faq.astro` | `/why` (09), `/install` (02) | Questions by id (`name`, `code`, `key`, `llm`, `actors`, `safe`, `terminal`, `cost`); `only` picks and orders them, `ground` is `paper` or `void` |
| `Providers.astro` | `/install` (`bare`) | The fourteen model providers as a ledger; `bare` drops the section wrapper and header |
| `QuickStart.astro` | `/install` (11, `#summon`) | Build from source: the `git clone` and `pnpm` commands in a terminal window, and the three processes |
| `WhatsNew.astro` | nowhere at present | The latest release's summary and top highlights from `data/changelog.json`; `/` redirects the old `#whats-new` anchor to `/changelog` |

- **ui/**: the shared kit (`Win`, `Shot`, `SectionHead`, `Lightbox`). See
  [ui/README.md](ui/README.md).

## Gotchas

- The provider list is written out twice, in `Yours.astro` and
  `Providers.astro` (and named in `Faq.astro` and `GetAbject.astro`); keep
  them in step with the app's providers.
- Section defaults (`num = '11'` in `Architecture`, for example) date from
  older page layouts; the pages pass their own numbers, so check the page, not
  the default.
- Download and install copy is checked against the release data only for file
  names and sizes. Statements about updating or installing are prose; keep
  them current with the app.

## Related

- [../README.md](../README.md): the page map and how pages are put together
- [ui/README.md](ui/README.md): `Win`, `Shot`, `SectionHead`, `Lightbox`
- [../data/README.md](../data/README.md): `shots.ts` and `changelog.json`
- [../lib/README.md](../lib/README.md): release lookup
- [../styles/README.md](../styles/README.md): tokens and shared classes
