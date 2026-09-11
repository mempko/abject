/**
 * Build-time release lookup shared by the hero and the download section.
 *
 * Primary source: the GitHub releases API (asset names, sizes, publish date).
 * Fallback: the electron-builder manifests (latest-*.yml), which carry
 * version, file names, and sizes for the desktop builds only.
 * Last resort: no version, every link points at the "latest release" page.
 */

export const REPO = 'mempko/abject';
export const REPO_URL = `https://github.com/${REPO}`;
export const LATEST_URL = `${REPO_URL}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  /** ISO date (YYYY-MM-DD) or '' when unknown. */
  date: string;
  assets: ReleaseAsset[];
  /** Human-readable release page. */
  pageUrl: string;
}

export interface PlatformAssets {
  linuxAppImage?: ReleaseAsset;
  linuxDeb?: ReleaseAsset;
  winExe?: ReleaseAsset;
  macArmDmg?: ReleaseAsset;
  macArmZip?: ReleaseAsset;
  macX64Dmg?: ReleaseAsset;
  macX64Zip?: ReleaseAsset;
  communeLinux?: ReleaseAsset;
  communeWin?: ReleaseAsset;
  communeMac?: ReleaseAsset;
}

async function fromGitHubApi(): Promise<ReleaseInfo | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tag_name?: string;
      published_at?: string;
      html_url?: string;
      assets?: { name: string; browser_download_url: string; size: number }[];
    };
    const version = (json.tag_name ?? '').replace(/^v/, '');
    if (!version) return null;
    return {
      version,
      date: (json.published_at ?? '').slice(0, 10),
      pageUrl: json.html_url ?? `${REPO_URL}/releases/tag/v${version}`,
      assets: (json.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    };
  } catch {
    return null;
  }
}

async function fetchManifest(filename: string): Promise<{ version: string; date: string; files: ReleaseAsset[] } | null> {
  try {
    const res = await fetch(`${LATEST_URL}/download/${filename}`);
    if (!res.ok) return null;
    const text = await res.text();
    const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? '';
    if (!version) return null;
    const date = text.match(/^releaseDate:\s*'?([^'\n]+)'?$/m)?.[1]?.trim().slice(0, 10) ?? '';
    const files: ReleaseAsset[] = [];
    const block = /^\s+-\s*url:\s*(.+)$(?:\n\s+\w+:.*$)*?\n\s+size:\s*(\d+)/gm;
    for (const m of text.matchAll(block)) {
      const name = m[1].trim();
      files.push({ name, url: `${REPO_URL}/releases/download/v${version}/${name}`, size: Number(m[2]) });
    }
    return { version, date, files };
  } catch {
    return null;
  }
}

async function fromManifests(): Promise<ReleaseInfo | null> {
  const [linux, mac, win] = await Promise.all([
    fetchManifest('latest-linux.yml'),
    fetchManifest('latest-mac.yml'),
    fetchManifest('latest.yml'),
  ]);
  const first = linux ?? mac ?? win;
  if (!first) return null;
  const version = first.version;
  const assets = [linux, mac, win].flatMap((m) => m?.files ?? []);
  // commune binaries ship with every release from 0.8.34 on, with fixed names.
  for (const name of ['abject-commune-linux-x64', 'abject-commune-win-x64.exe', 'abject-commune-mac-arm64']) {
    assets.push({ name, url: `${REPO_URL}/releases/download/v${version}/${name}`, size: 0 });
  }
  return { version, date: first.date, assets, pageUrl: `${REPO_URL}/releases/tag/v${version}` };
}

let cached: Promise<ReleaseInfo> | null = null;

export function latestRelease(): Promise<ReleaseInfo> {
  cached ??= (async () => {
    const info = (await fromGitHubApi()) ?? (await fromManifests());
    return info ?? { version: '', date: '', assets: [], pageUrl: LATEST_URL };
  })();
  return cached;
}

export function platformAssets(info: ReleaseInfo): PlatformAssets {
  const find = (pred: (n: string) => boolean) => info.assets.find((a) => pred(a.name));
  const isMacZip = (n: string) => n.endsWith('-mac.zip') || (n.endsWith('.zip') && /mac/i.test(n));
  return {
    linuxAppImage: find((n) => n.endsWith('.AppImage')),
    linuxDeb: find((n) => n.endsWith('.deb')),
    winExe: find((n) => n.endsWith('.exe') && !n.startsWith('abject-commune')),
    macArmDmg: find((n) => n.endsWith('.dmg') && /arm64/.test(n)),
    macX64Dmg: find((n) => n.endsWith('.dmg') && !/arm64/.test(n)),
    macArmZip: find((n) => isMacZip(n) && /arm64/.test(n)),
    macX64Zip: find((n) => isMacZip(n) && !/arm64/.test(n)),
    communeLinux: find((n) => n === 'abject-commune-linux-x64'),
    communeWin: find((n) => n === 'abject-commune-win-x64.exe'),
    communeMac: find((n) => n === 'abject-commune-mac-arm64'),
  };
}

/** "237 MB" style size, or '' when unknown. */
export function fmtSize(bytes: number | undefined): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** "11 Sep 2026" style date, or '' when unknown. */
export function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
