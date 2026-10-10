# scripts/ - Build, Packaging and Evaluation Scripts

Tooling run from the command line or by pnpm scripts, never imported by
application code (the one exception is the headless bundle check, which
`build-server.mjs` imports). Most of it is the headless edition's packaging
pipeline.

## Architecture

```
  pnpm incarnate:headless
     -> package-headless.mjs
          -> build-server.mjs (pnpm bind) -> dist-server/
               '-> headless-bundle-check.mjs  (fails the build on display code)
          -> build-cli.mjs (pnpm distill)  -> dist-cli/abject.mjs
          -> stage release/abject-<v>-<os>-<arch>/  (lib/, npm install of runtime deps)
          -> Node single executable from sea-bootstrap.cjs  -> abject[.exe]
          -> archive + .sha256

  release archives' .sha256 files
     -> fill-manifests.mjs -> packaging/out/<version>/  (Homebrew, Scoop, winget)
```

## Files

- **package-headless.mjs** (`pnpm incarnate:headless`): packages the headless
  edition for the platform it runs on, as
  `release/abject-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows; `os` is
  `linux`, `mac` or `win`) plus a `.sha256`. Builds the server and the CLI,
  stages one directory (`abject` binary, `lib/launch.cjs`,
  `lib/cli/abject.mjs`, the headless server and its two workers in
  `lib/dist-server/`, the bundled packages in `lib/native/` without their
  sources, `lib/node_modules/` from an `npm install` of ws, node-datachannel,
  linkedom, node-pty and Playwright with the browser download skipped,
  `VERSION`, `LICENSE`, `README.txt`), injects the bootstrap into a copy of the
  running Node with postject (ad hoc signed on macOS), and smoke-tests it with
  `abject version`. The binary is a copy of the Node that runs the script, so
  build with the Node the release targets (24; at least 22.5), on each target
  platform.
- **sea-bootstrap.cjs**: the entry inside the `abject` binary. Sets
  `ABJECT_SEA=1`, `ABJECT_HOME` (the binary's directory) and
  `ABJECT_EDITION=headless` unless already set, then loads `lib/launch.cjs`,
  which imports the CLI bundle. Two reserved first arguments stand in for what
  plain Node would do: `__abject-eval` runs the code in `ABJECT_EVAL` (the
  backend's exit watchdog, `node -e` elsewhere) and `__abject-run <script>`
  runs a CommonJS script (Playwright's installer, from `abject setup`).
- **headless-bundle-check.mjs**: `checkHeadlessBundle(metafile, output)`,
  called by `build-server.mjs` for `server/headless.js` and the two headless
  workers. Fails when a forbidden module (BackendUI, the UI layer, the UI
  worker and constructors, the compositor, WidgetManager, WindowManager,
  windows, widgets, `*-browser.ts`, `*-viewer.ts`, and similar) reached the
  bundle, and prints the import chain that brought each one in.
- **fill-manifests.mjs** (`node scripts/fill-manifests.mjs <version> <dir>`):
  fills every `*.tmpl` under `packaging/` from a release's five `.sha256`
  files (linux x64 and arm64, mac arm64 and x64, win x64), writing
  `packaging/out/<version>/`. `{{version}}`, `{{license}}`,
  `{{sha256_<target>}}` and `{{SHA256_<TARGET>}}` are the placeholders; an
  unknown one is an error.
- **forge-abject.ts** (`pnpm forge <dir>`, `pnpm smelt`): build, validate and
  install an abject package, WASM or script. Runs the package's `build`
  command, checks a WASM module's exports and ABI version, or compiles a
  TypeScript entry and checks it yields a handler map in the sandbox,
  extracts or validates the manifest and settings, and installs into
  `$ABJECTS_DATA_DIR/extensions/` (`--dest` for another directory,
  `--no-build` to skip the build). `--build-only` builds in place instead;
  `pnpm smelt` is that for `native/knowledge-base`. See `docs/PACKAGES.md` and
  `docs/WASM_ABI.md`.
- **evaluate-learning.ts**
  (`node --import tsx scripts/evaluate-learning.ts <answers.json>`): scores
  review answers (`{ id, verdict, disposition, scope?, patternVerdict? }` per
  case) against the labeled corpus in `tests/fixtures/learning-judgment.json`
  and prints the result; exits 1 unless every case is right. It scores given
  answers and does not call a model. Its `evaluate()` is also used by
  `src/objects/agent-system.world-model.test.ts`.

## Root-level build scripts

These live at the repository root, beside `package.json`:

- **build-server.mjs** (`pnpm bind`): esbuild bundles of `server/index.ts`,
  `server/headless.ts` and every worker entry into `dist-server/`, mirroring
  the source layout so `new URL('../workers/...', import.meta.url)` still
  resolves. Native and lazily loaded modules stay external; the version is
  baked in as `__ABJECT_VERSION__`. Runs the headless bundle check.
- **build-cli.mjs** (`pnpm distill`): the `abject` command as one ESM file,
  `dist-cli/abject.mjs`.
- **build-electron.mjs**: the Electron main process, `dist-electron/main.js`.
- **release.mjs** (`pnpm release <version>`): drafts release notes with
  `claude -p` (falling back to the commit subjects), adds them to
  `site/src/data/changelog.json`, bumps `package.json`, commits
  `Release v<version>`, tags with the notes as the annotation, and pushes. The
  tag starts the release workflow.

## Gotchas

- `forge` installs into `$ABJECTS_DATA_DIR/extensions/`, which defaults to
  `.abjects` in the current directory. For an installed edition, point
  `ABJECTS_DATA_DIR` at its data directory (or use `--dest`).
- `package-headless.mjs` cannot cross-compile: the binary, node-datachannel
  and node-pty all come from the machine that runs it.
- A display import that sneaks into anything `server/boot.ts` reaches breaks
  `pnpm bind`, and with it every packaging script. The error names the chain
  to cut.
- `release.mjs` refuses a dirty working tree and pushes on success.

## Related

- [cli/README.md](../cli/README.md): what the binary runs
- [deploy/README.md](../deploy/README.md): installing an archive as a service
- [packaging/README.md](../packaging/README.md): the manifest templates
- [.github/workflows/README.md](../.github/workflows/README.md): CI that runs these
- [tests/fixtures/README.md](../tests/fixtures/README.md): the learning corpus
