/**
 * The headless edition carries no display code. After `pnpm bind` builds it,
 * this fails the build if a window, a widget, the window system, the display
 * server or the desktop's browser windows reached a headless bundle, and
 * reports the import chain that brought each one in.
 *
 * A small set of shared helpers (markdown and text measurement, theme data,
 * colour math) is allowed: they are pure functions that headless objects use
 * to format text, not things that draw.
 */

/** Modules that are display code and must stay out of headless bundles. */
const FORBIDDEN = [
  /^server\/backend-ui\.ts$/,
  /^server\/ui-layer\.ts$/,
  /^server\/ui-transport\.ts$/,
  /^workers\/ui-constructors\.ts$/,
  /^workers\/ui-worker-node\.ts$/,
  /^src\/ui\/compositor\.ts$/,
  /^src\/objects\/widget-manager\.ts$/,
  /^src\/objects\/window-manager\.ts$/,
  /^src\/objects\/modal-dialog\.ts$/,
  /^src\/objects\/chat-window\.ts$/,
  /^src\/objects\/global-settings\.ts$/,
  /^src\/objects\/sidebar\.ts$/,
  /^src\/objects\/taskbar\.ts$/,
  /^src\/objects\/scene-library\.ts$/,
  /^src\/objects\/remote-ui-access\.ts$/,
  /^src\/objects\/app-updater\.ts$/,
  /^src\/objects\/capabilities\/browser-window-host\.ts$/,
  /^src\/objects\/capabilities\/screenshot\.ts$/,
  /^src\/objects\/widgets\/window-abject\.ts$/,
  /^src\/objects\/widgets\/.*-widget\.ts$/,
  /^src\/objects\/[a-z-]*-browser\.ts$/,
  /^src\/objects\/[a-z-]*-viewer\.ts$/,
];

/**
 * Check one output file of an esbuild metafile. Throws, listing each display
 * module that got in and the chain of imports that brought it.
 */
export function checkHeadlessBundle(metafile, outputPath) {
  const output = metafile.outputs[outputPath];
  if (!output) throw new Error(`headless bundle check: no output ${outputPath} in the metafile`);
  const included = Object.keys(output.inputs);
  const offenders = included.filter((input) => FORBIDDEN.some((re) => re.test(input)));
  if (offenders.length === 0) {
    console.log(`headless bundle check: ${outputPath} carries no display code (${included.length} modules)`);
    return;
  }
  const importers = new Map();
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const imp of info.imports ?? []) {
      if (!imp.path) continue;
      if (!importers.has(imp.path)) importers.set(imp.path, []);
      importers.get(imp.path).push(file);
    }
  }
  const chainTo = (target) => {
    // Breadth-first from the target back to an entry point.
    const seen = new Set([target]);
    const queue = [[target]];
    while (queue.length > 0) {
      const chain = queue.shift();
      const parents = importers.get(chain[0]) ?? [];
      if (parents.length === 0) return chain;
      for (const parent of parents) {
        if (seen.has(parent) || !included.includes(parent)) continue;
        seen.add(parent);
        queue.push([parent, ...chain]);
      }
    }
    return [target];
  };
  const lines = offenders.map((o) => `  ${o}\n      via ${chainTo(o).join(' -> ')}`);
  throw new Error(`headless bundle check: display code reached ${outputPath}:\n${lines.join('\n')}`);
}
