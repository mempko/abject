// Render tools/og-card.html to public/og-card.png (1200x630 at 2x, 2400x1260).
//   node tools/render-og.mjs                      (drawn windows in the frame)
//   node tools/render-og.mjs public/gallery/x.webp (a screenshot in the frame)
// Uses the repo's Playwright and a local Chrome.
import { chromium } from '../../node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shot = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '';
const url = pathToFileURL(resolve(here, 'og-card.html')).href + (shot ? `?shot=${encodeURIComponent(shot)}` : '');
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: resolve(here, '../public/og-card.png') });
await browser.close();
console.log('wrote public/og-card.png');
