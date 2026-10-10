# build/ - Desktop App Build Resources

electron-builder's build-resources directory (its default, `build/`; not
configured in `electron-builder.yml`). Nothing in here is compiled code, and
nothing in here ships as a file of its own: electron-builder reads it while
packaging.

## Files

- **icon.png**: the desktop app icon, 512 by 512. electron-builder derives each
  platform's icon formats from it. It is generated, not drawn by hand:
  `site/tools/gen-favicons.sh` renders it from `site/public/favicon.svg` (the
  eye sigil) along with the site's favicons and the client's `favicon.svg`, so
  the mark stays the same everywhere. Change the SVG and rerun that script
  (it needs inkscape and ImageMagick) rather than editing this file.

## Gotchas

- Build output does not go here. The compiled bundles are in `dist-*/` and the
  packages in `release/`, both ignored by git.

## Related

- [electron/README.md](../electron/README.md): packaging the desktop app
