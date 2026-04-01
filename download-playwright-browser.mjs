/**
 * Download Playwright's Chrome Headless Shell for specified target platforms.
 *
 * Usage:
 *   node download-playwright-browser.mjs [platform...]
 *
 * Platforms: linux-x64, mac-x64, mac-arm64, win-x64
 * Defaults to the current platform if none specified.
 *
 * Downloads go to playwright-browsers/ which electron-builder includes
 * and unpacks from the asar archive.
 */

import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { get } from 'node:https';
import path from 'node:path';
import os from 'node:os';

const PLATFORM_MAP = {
  'linux-x64': 'linux64',
  'mac-x64': 'mac-x64',
  'mac-arm64': 'mac-arm64',
  'win-x64': 'win64',
};

function currentPlatformKey() {
  const plat = os.platform();
  const arch = os.arch();
  if (plat === 'linux' && arch === 'x64') return 'linux-x64';
  if (plat === 'darwin' && arch === 'x64') return 'mac-x64';
  if (plat === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (plat === 'win32' && arch === 'x64') return 'win-x64';
  throw new Error(`Unsupported platform: ${plat}-${arch}`);
}

/** Read Playwright's browsers.json to get version info. */
function getBrowserInfo() {
  const require = createRequire(import.meta.url);
  // Resolve through playwright (direct dep) to find playwright-core's browsers.json.
  // pnpm hoists playwright-core as a sibling of playwright inside the .pnpm store.
  const playwrightDir = path.dirname(require.resolve('playwright/package.json'));
  const coreDir = path.join(playwrightDir, '..', 'playwright-core');
  const browsersJsonPath = path.join(coreDir, 'browsers.json');
  if (!existsSync(browsersJsonPath)) {
    throw new Error(`browsers.json not found at ${browsersJsonPath}`);
  }
  const browsersJson = JSON.parse(
    require('node:fs').readFileSync(browsersJsonPath, 'utf-8')
  );
  const headlessShell = browsersJson.browsers.find(
    (b) => b.name === 'chromium-headless-shell'
  );
  if (!headlessShell) {
    throw new Error('chromium-headless-shell not found in browsers.json');
  }
  return {
    revision: headlessShell.revision,
    browserVersion: headlessShell.browserVersion,
  };
}

/** Download a file via HTTPS, following redirects. */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const request = (url) => {
      get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(0);
            process.stdout.write(`\r  ${pct}% of ${(total / 1048576).toFixed(1)} MiB`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', reject);
    };
    request(url);
  });
}

/** Extract a zip file to a directory. */
function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (os.platform() === 'win32') {
    execSync(
      `powershell -Command "Expand-Archive -Force '${zipPath}' '${destDir}'"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`unzip -o -q "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
  }
}

async function downloadForPlatform(platformKey, browserInfo, outDir) {
  const cdnDir = PLATFORM_MAP[platformKey];
  if (!cdnDir) {
    throw new Error(`Unknown platform: ${platformKey}. Valid: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  }

  const zipName = `chrome-headless-shell-${cdnDir}.zip`;
  const url = `https://cdn.playwright.dev/builds/cft/${browserInfo.browserVersion}/${cdnDir}/${zipName}`;
  const browserDir = path.join(outDir, `chromium_headless_shell-${browserInfo.revision}`);

  console.log(`Downloading ${zipName} (v${browserInfo.browserVersion}, revision ${browserInfo.revision})`);
  console.log(`  URL: ${url}`);

  mkdirSync(browserDir, { recursive: true });

  const tmpZip = path.join(outDir, zipName);
  await download(url, tmpZip);

  console.log(`  Extracting to ${browserDir}/`);
  extractZip(tmpZip, browserDir);

  // Playwright checks for this marker file
  writeFileSync(path.join(browserDir, 'INSTALLATION_COMPLETE'), '');

  // Clean up zip
  rmSync(tmpZip);

  console.log(`  Done: ${platformKey}`);
}

async function main() {
  const args = process.argv.slice(2);
  const platforms = args.length > 0 ? args : [currentPlatformKey()];

  // Validate all platforms before starting
  for (const p of platforms) {
    if (!PLATFORM_MAP[p]) {
      console.error(`Unknown platform: ${p}`);
      console.error(`Valid platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`);
      process.exit(1);
    }
  }

  const browserInfo = getBrowserInfo();
  const outDir = path.resolve('playwright-browsers');

  // Clean and recreate output directory
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  console.log(`Playwright Headless Shell v${browserInfo.browserVersion} (revision ${browserInfo.revision})`);
  console.log(`Target platforms: ${platforms.join(', ')}`);
  console.log(`Output: ${outDir}\n`);

  for (const platform of platforms) {
    await downloadForPlatform(platform, browserInfo, outDir);
    console.log();
  }

  console.log('All downloads complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
