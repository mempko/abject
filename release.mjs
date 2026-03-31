/**
 * Release script: bumps version, commits, tags, and pushes.
 *
 * Usage: pnpm release <version>
 * Example: pnpm release 0.2.0
 *
 * The tag push triggers the GitHub Actions release workflow.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: pnpm release <version>');
  console.error('Example: pnpm release 0.2.0');
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

// Ensure working tree is clean
try {
  execSync('git diff --quiet && git diff --cached --quiet');
} catch {
  console.error('Working tree is dirty. Commit or stash changes first.');
  process.exit(1);
}

// Bump version in package.json
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const oldVersion = pkg.version;
pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`Version: ${oldVersion} → ${version}`);

// Commit, tag, push
run('git add package.json');
run(`git commit -m "Release v${version}"`);
run(`git tag -a "v${version}" -m "v${version}"`);
run('git push');
run('git push --tags');

console.log(`\nReleased v${version}. GitHub Actions will build and publish.`);
