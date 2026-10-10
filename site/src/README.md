# site/src/ - Website Source

The Astro source of abject.world. Pages compose section components; the
shared layout wraps every page; data files and the release lookup feed the
components at build time. The output is static HTML with a little client-side
script.

## How it is put together

- **Build time.** Each `.astro` file's frontmatter (between the `---` fences)
  runs during `pnpm build`. That is where `lib/releases.ts` fetches the latest
  release and where `data/changelog.json` and `data/shots.ts` are read.
- **The layout.** `layouts/Layout.astro` supplies the `<head>` (title,
  description, canonical URL, Open Graph and Twitter tags, favicons, Google
  Fonts), the animated background canvas, the shared lightbox, and the global
  stylesheet. Every page renders `<Layout>` with `<Header />` and `<Footer />`.
- **Section numbers** belong to the page: most section components take a
  `num` prop (with a default), so the same component can be section 02 on one
  page and 09 on another.
- **Client-side script** is small and local to its component: the background
  (`scripts/sigil-bg.js`), the lightbox, clip playback in `Shot`, the ask
  demo animation in `BigIdea`, the visitor's platform highlighted in
  `Downloads` and `Hero`, and a redirect on `/` that sends old landing anchors
  (`#features`, `#faq`, `#whats-new` and others) to their new pages.
  Everything renders without JavaScript; the narrow-screen menu in `Header` is
  a plain `<details>` element.

## Pages

`pages/` is file-based routing: every file there is a page. Document it here
rather than adding files to it.

| File | Route | Built from |
|---|---|---|
| `index.astro` | `/` | `Hero`, `BigIdea` (00), `SayIt` (01), `Team` (02), `Learns` (03), `Yours` (04), `GetAbject` (05, with `Downloads`) |
| `why.astro` | `/why` | `WhyDifferent` (01), `Symbiogenesis` (02), `AskProtocol` (03), `Emergence` (04), `Architecture` (05), `Features` (06), `Spreading` (07), `Lineage` (08), `Faq` (09, three questions); its own index and shared long-form styles |
| `install.astro` | `/install` | Its own sections (requirements, first launch, picking a model, first abject, phone, command line, data, network, updating, troubleshooting) plus `Faq` (02), `Providers` (bare) and `QuickStart` (11); reads `lib/releases.ts` for file names and sizes |
| `ask-protocol.astro` | `/ask-protocol` | The specification, self-contained: message and manifest sketches with a small highlighter, the ask flow diagram, use cases, comparisons |
| `theory.astro` | `/theory` | Essay with a contents rail |
| `about.astro` | `/about` | About the project and its author |
| `changelog.astro` | `/changelog` | `data/changelog.json`: the newest release on a red field, then the rest grouped by minor version |
| `links.astro` | `/links` | Three QR codes as inline SVG |

## Files

- **components/**: section components and the small `ui/` kit. See
  [components/README.md](components/README.md).
- **data/**: `changelog.json` and the shot list `shots.ts`. See
  [data/README.md](data/README.md).
- **layouts/**: `Layout.astro`. See [layouts/README.md](layouts/README.md).
- **lib/**: `releases.ts`, the build-time release lookup. See
  [lib/README.md](lib/README.md).
- **pages/**: the routes (table above).
- **scripts/**: `sigil-bg.js`, the background. See
  [scripts/README.md](scripts/README.md).
- **styles/**: `global.css`, the design system. See
  [styles/README.md](styles/README.md).

## Static files (`../public/`)

Served from the site root as is: `gallery/` and `media/` (screenshots and
clips named in `data/shots.ts`), `install.sh` and `install.ps1` (the one-line
installers for the `abject` command), the favicons, `og-card.png` and
`robots.txt`. Nothing there is processed, so a file added there is published
under that name. Details are in [../README.md](../README.md).

## Adding a page or section

- A page: add `pages/<name>.astro` rendering `<Layout title description>`,
  `<Header />`, the content and `<Footer />`. Add it to the `pages` list in
  `components/Header.astro` and the links in `components/Footer.astro` if it
  belongs in the navigation.
- A section: add a component that renders a `<section id="...">` with
  `SectionHead` and takes a `num` prop, then place it on a page. Use the
  shared classes and tokens from `styles/global.css` before adding new ones.

## Related

- [../README.md](../README.md): build, deploy, `public/`, installers
- [../SCREENSHOTS.md](../SCREENSHOTS.md): adding captures
