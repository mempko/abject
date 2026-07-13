/**
 * Release script: drafts release notes with `claude -p`, updates the site
 * changelog, bumps the version, commits, tags (with the notes as the tag
 * annotation), and pushes.
 *
 * Usage: pnpm release <version>
 * Example: pnpm release 0.9.0
 *
 * The notes land in three places:
 *  - site/src/data/changelog.json  → rendered at abject.world/changelog
 *  - the annotated tag message     → picked up by the GitHub release workflow
 *  - the "Release vX.Y.Z" commit   → carries both files
 *
 * The tag push triggers the GitHub Actions release workflow, which uses the
 * tag annotation as the GitHub Release body (falling back to auto-generated
 * notes when the annotation is bare).
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const CHANGELOG_PATH = 'site/src/data/changelog.json';

const version = process.argv[2];
if (!version) {
  console.error('Usage: pnpm release <version>');
  console.error('Example: pnpm release 0.9.0');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: ${version} (expected semver like 1.2.3)`);
  process.exit(1);
}

const run = (cmd) => {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

const capture = (cmd) => execSync(cmd, { encoding: 'utf-8' }).trim();

// Ensure working tree is clean
try {
  execSync('git diff --quiet && git diff --cached --quiet');
} catch {
  console.error('Working tree is dirty. Commit or stash changes first.');
  process.exit(1);
}

// ── Gather the commit log since the last tag ─────────────────────────────
let lastTag = '';
try {
  lastTag = capture('git describe --tags --abbrev=0');
} catch { /* first release ever */ }

const logRange = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const subjects = capture(`git log --format=%s ${logRange}`)
  .split('\n')
  .filter(s => s && !/^Release v/.test(s) && !/^Merge (branch|pull request)/.test(s));

// ── Draft release notes with claude -p ───────────────────────────────────
// Returns { title, summary, highlights[], fixes[] }. Falls back to the raw
// commit subjects if claude is unavailable or emits something unparseable;
// a release must never be blocked on the drafting step.
function draftNotes() {
  if (subjects.length === 0) {
    return { title: `v${version}`, summary: 'Maintenance release.', highlights: [], fixes: [] };
  }

  const prompt = [
    `You are drafting release notes for Abject v${version}, an open-source, peer-to-peer desktop platform for local-first AI objects (abject.world).`,
    `Below are the commit subjects since ${lastTag || 'the beginning'}, newest first.`,
    '',
    'Respond with ONLY a JSON object (no markdown fence, no prose) shaped exactly like:',
    '{ "title": "<a short evocative release title, max 8 words>",',
    '  "summary": "<1-2 sentences on what this release means for users>",',
    '  "highlights": ["<major user-visible changes, most important first, max 10>"],',
    '  "fixes": ["<notable bug fixes, max 6>"] }',
    '',
    'Voice: sincere and concrete, plain language, no hype. Never use em-dashes; use colons, semicolons, or parentheses instead. Group related commits into one bullet. Skip internal chores (CI, lint, version bumps).',
    '',
    'Commits:',
    ...subjects.map(s => `- ${s}`),
  ].join('\n');

  console.log(`Drafting release notes with claude -p (${subjects.length} commits since ${lastTag || 'start'})...`);
  const res = spawnSync('claude', ['-p'], { input: prompt, encoding: 'utf-8', timeout: 180000 });
  if (res.status !== 0 || !res.stdout) {
    console.warn(`claude -p failed (${res.status ?? res.error?.message}); falling back to raw commit subjects.`);
    return { title: `v${version}`, summary: `Release v${version}.`, highlights: subjects.slice(0, 10), fixes: [] };
  }

  try {
    const jsonMatch = res.stdout.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : res.stdout);
    return {
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : `v${version}`,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.filter(h => typeof h === 'string') : [],
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes.filter(f => typeof f === 'string') : [],
    };
  } catch {
    console.warn('claude -p output was not parseable JSON; falling back to raw commit subjects.');
    return { title: `v${version}`, summary: `Release v${version}.`, highlights: subjects.slice(0, 10), fixes: [] };
  }
}

const notes = draftNotes();
const date = new Date().toISOString().slice(0, 10);

console.log(`\nRelease notes for v${version}: "${notes.title}"`);
if (notes.summary) console.log(`  ${notes.summary}`);
for (const h of notes.highlights) console.log(`  • ${h}`);
for (const f of notes.fixes) console.log(`  fix: ${f}`);
console.log('');

// ── Update the site changelog ─────────────────────────────────────────────
// Every version gets its own entry. Re-releasing the same version refreshes
// its entry in place; anything else goes on top.
const changelog = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf-8'));
const entry = { version, date, title: notes.title, summary: notes.summary, highlights: notes.highlights, fixes: notes.fixes };
if (changelog.length > 0 && changelog[0].version === version) {
  changelog[0] = entry;
} else {
  changelog.unshift(entry);
}
writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2) + '\n');
console.log(`Updated ${CHANGELOG_PATH}`);

// ── Bump version ──────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const oldVersion = pkg.version;
pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`Version: ${oldVersion} → ${version}`);

// ── Commit, tag with the notes as annotation, push ───────────────────────
run('git add package.json ' + CHANGELOG_PATH);
run(`git commit -m "Release v${version}"`);

const tagMessage = [
  `Abject v${version}: ${notes.title}`,
  '',
  notes.summary,
  '',
  ...(notes.highlights.length > 0 ? ['## Highlights', ...notes.highlights.map(h => `- ${h}`), ''] : []),
  ...(notes.fixes.length > 0 ? ['## Fixes', ...notes.fixes.map(f => `- ${f}`), ''] : []),
].join('\n');
const tagMsgFile = `.release-notes-v${version}.md`;
writeFileSync(tagMsgFile, tagMessage);
try {
  run(`git tag -a "v${version}" -F "${tagMsgFile}"`);
} finally {
  rmSync(tagMsgFile, { force: true });
}

run('git push');
run('git push --tags');

console.log(`\nReleased v${version}. GitHub Actions will build and publish with these notes.`);
