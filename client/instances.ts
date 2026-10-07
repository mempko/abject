/**
 * The instances the p2p client (client.abject.world) knows: backends this
 * browser can show, one live connection at a time. Used only by the p2p
 * build; the desktop app's client and `pnpm scry` never read these keys.
 *
 * Two kinds:
 *   - paired: a remote desktop reached over WebRTC. Kept in the existing
 *     `remote-ui:paired` list (paired-desktops.ts), keyed by the desktop's
 *     peerId; a user-chosen name rides there as `label`.
 *   - url: a WebSocket backend (`wss://host/ws`), kept in `abjects:instances:url`.
 *
 * Login tokens are stored per instance (`abjects_auth_token:<instanceId>`),
 * so one instance refusing a token never clears another's.
 *
 * `abjects:instance:selected` names the instance to connect to on load, and
 * `abjects:instance:disconnected` records an explicit Disconnect, which lands
 * on the instance picker instead. Switching writes these and reloads.
 */

import { listPairedDesktops, getMostRecentPairedDesktop, type PairedDesktop } from './paired-desktops.js';

const LS_PAIRED = 'remote-ui:paired';
const LS_URL_INSTANCES = 'abjects:instances:url';
const LS_SELECTED = 'abjects:instance:selected';
const LS_DISCONNECTED = 'abjects:instance:disconnected';
const LS_VERSION = 'abjects:instances:v';
const LEGACY_TOKEN_KEY = 'abjects_auth_token';
const TOKEN_KEY_PREFIX = 'abjects_auth_token:';

interface StoredUrlInstance {
  id: string;
  url: string;
  name: string;
  addedAt: number;
  lastConnected?: number;
}

interface InstanceCommon {
  id: string;
  /** Display name: the user's label, else the default for its kind. */
  name: string;
  addedAt: number;
  lastConnected?: number;
}

export interface PairedInstance extends InstanceCommon {
  kind: 'paired';
  desktop: PairedDesktop;
}

export interface UrlInstance extends InstanceCommon {
  kind: 'url';
  url: string;
}

export type Instance = PairedInstance | UrlInstance;

// ── Storage plumbing ─────────────────────────────────────────────────

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function remove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

function readUrlInstances(): StoredUrlInstance[] {
  try {
    const parsed = JSON.parse(read(LS_URL_INSTANCES) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is StoredUrlInstance =>
      !!u && typeof u.id === 'string' && typeof u.url === 'string' && typeof u.name === 'string');
  } catch {
    return [];
  }
}

function writeUrlInstances(list: StoredUrlInstance[]): void {
  write(LS_URL_INSTANCES, JSON.stringify(list));
}

function writePairedDesktops(list: PairedDesktop[]): void {
  write(LS_PAIRED, JSON.stringify(list));
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Views ────────────────────────────────────────────────────────────

export function pairedInstanceId(peerId: string): string {
  return `paired:${peerId}`;
}

function pairedView(d: PairedDesktop): PairedInstance {
  return {
    kind: 'paired',
    id: pairedInstanceId(d.peerId),
    name: d.label?.trim() || d.name || 'Desktop',
    addedAt: d.pairedAt,
    lastConnected: d.lastConnected,
    desktop: d,
  };
}

function urlView(u: StoredUrlInstance): UrlInstance {
  return { kind: 'url', id: u.id, name: u.name, addedAt: u.addedAt, lastConnected: u.lastConnected, url: u.url };
}

/** Every known instance, oldest first (a stable order for the switcher). */
export function listInstances(): Instance[] {
  const all: Instance[] = [
    ...listPairedDesktops().map(pairedView),
    ...readUrlInstances().map(urlView),
  ];
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export function getInstance(id: string): Instance | undefined {
  return listInstances().find((i) => i.id === id);
}

/** A one-line description of where an instance lives. */
export function instanceDetail(inst: Instance): string {
  if (inst.kind === 'url') return inst.url;
  return `Paired desktop · ${inst.desktop.peerId.slice(0, 8)}`;
}

// ── Selection ────────────────────────────────────────────────────────

/** The instance last chosen, whether or not the user has since disconnected. */
export function selectedInstanceId(): string | undefined {
  return read(LS_SELECTED) || undefined;
}

export function isDisconnected(): boolean {
  return read(LS_DISCONNECTED) === '1';
}

/** The instance to connect to on load, or undefined for the picker. */
export function getSelectedInstance(): Instance | undefined {
  if (isDisconnected()) return undefined;
  const id = selectedInstanceId();
  return id ? getInstance(id) : undefined;
}

export function selectInstance(id: string): void {
  write(LS_SELECTED, id);
  remove(LS_DISCONNECTED);
}

export function markDisconnected(): void {
  write(LS_DISCONNECTED, '1');
}

// ── Edits ────────────────────────────────────────────────────────────

export function renameInstance(id: string, name: string): void {
  const trimmed = name.trim();
  if (id.startsWith('paired:')) {
    const peerId = id.slice('paired:'.length);
    const all = listPairedDesktops();
    const found = all.find((d) => d.peerId === peerId);
    if (!found) return;
    // An empty name drops the label and falls back to the desktop's own name.
    if (trimmed) found.label = trimmed; else delete found.label;
    writePairedDesktops(all);
    return;
  }
  if (!trimmed) return;
  const all = readUrlInstances();
  const found = all.find((u) => u.id === id);
  if (!found) return;
  found.name = trimmed;
  writeUrlInstances(all);
}

/** Remove an instance, its saved login, and the selection if it pointed here. */
export function forgetInstance(id: string): void {
  if (id.startsWith('paired:')) {
    const peerId = id.slice('paired:'.length);
    writePairedDesktops(listPairedDesktops().filter((d) => d.peerId !== peerId));
  } else {
    writeUrlInstances(readUrlInstances().filter((u) => u.id !== id));
  }
  remove(authTokenKey(id));
  if (selectedInstanceId() === id) {
    remove(LS_SELECTED);
    remove(LS_DISCONNECTED);
  }
}

export function touchInstance(id: string): void {
  const now = Date.now();
  if (id.startsWith('paired:')) {
    const peerId = id.slice('paired:'.length);
    const all = listPairedDesktops();
    const found = all.find((d) => d.peerId === peerId);
    if (!found) return;
    found.lastConnected = now;
    writePairedDesktops(all);
    return;
  }
  const all = readUrlInstances();
  const found = all.find((u) => u.id === id);
  if (!found) return;
  found.lastConnected = now;
  writeUrlInstances(all);
}

/**
 * Record a desktop that has just accepted this browser. Pairing the same
 * desktop again keeps the name the user gave it.
 */
export function savePairedInstance(desktop: PairedDesktop): PairedInstance {
  const all = listPairedDesktops();
  const existing = all.find((d) => d.peerId === desktop.peerId);
  const merged: PairedDesktop = {
    ...desktop,
    label: existing?.label ?? desktop.label,
    pairedAt: existing?.pairedAt ?? desktop.pairedAt,
  };
  writePairedDesktops([...all.filter((d) => d.peerId !== desktop.peerId), merged]);
  return pairedView(merged);
}

/** Add a WebSocket backend, or return the one already saved at that address. */
export function addUrlInstance(url: string, name?: string): UrlInstance {
  const all = readUrlInstances();
  const existing = all.find((u) => u.url === url);
  if (existing) return urlView(existing);
  const entry: StoredUrlInstance = {
    id: `url:${newId()}`,
    url,
    name: name?.trim() || defaultUrlName(url),
    addedAt: Date.now(),
  };
  all.push(entry);
  writeUrlInstances(all);
  return urlView(entry);
}

export function findUrlInstance(url: string): UrlInstance | undefined {
  const found = readUrlInstances().find((u) => u.url === url);
  return found ? urlView(found) : undefined;
}

function defaultUrlName(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

// ── Login tokens ─────────────────────────────────────────────────────

export function authTokenKey(instanceId: string): string {
  return TOKEN_KEY_PREFIX + instanceId;
}

// ── Lifecycle ────────────────────────────────────────────────────────

/**
 * One-time upgrade from the single-desktop client: the most recently used
 * paired desktop becomes the selected instance, so a browser that was
 * reconnecting on every visit keeps doing so. The old single login token is
 * dropped: this client only ever reached desktops over WebRTC, which never
 * issues one, so it names no instance this list can hold.
 */
export function migrateInstances(): void {
  if (read(LS_VERSION) === '1') return;
  if (!read(LS_SELECTED)) {
    const recent = getMostRecentPairedDesktop();
    if (recent) write(LS_SELECTED, pairedInstanceId(recent.peerId));
  }
  remove(LEGACY_TOKEN_KEY);
  write(LS_VERSION, '1');
}

/** Forget every instance, login and selection (the Reset button). */
export function clearAllInstances(): void {
  for (const inst of listInstances()) remove(authTokenKey(inst.id));
  remove(LS_PAIRED);
  remove(LS_URL_INSTANCES);
  remove(LS_SELECTED);
  remove(LS_DISCONNECTED);
}

// ── Addresses ────────────────────────────────────────────────────────

/**
 * Turn what someone typed into a WebSocket URL: `ws://` and `wss://` pass
 * through, `http(s)://host` maps to `ws(s)://host/ws`, and a bare host is
 * taken as `wss://host/ws`. Returns an error message for anything unusable.
 */
export function normalizeServerUrl(input: string): { url: string } | { error: string } {
  let text = input.trim();
  if (!text) return { error: 'Enter a server address.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `wss://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: 'That does not look like a server address.' };
  }
  const scheme = parsed.protocol;
  if (scheme === 'http:' || scheme === 'https:') {
    parsed = new URL(text.replace(/^http/i, 'ws'));
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/ws';
  } else if (scheme === 'wss:' && (parsed.pathname === '/' || parsed.pathname === '') && !input.trim().includes('://')) {
    parsed.pathname = '/ws';
  } else if (scheme !== 'ws:' && scheme !== 'wss:') {
    return { error: 'Use a wss:// (or ws://) address.' };
  }
  if (!parsed.host) return { error: 'That address has no host.' };
  if (location.protocol === 'https:' && parsed.protocol === 'ws:' && !isLoopbackHost(parsed.hostname)) {
    return { error: 'This page is served over https, so the address must start with wss://.' };
  }
  let url = parsed.toString();
  // URL() adds a trailing slash to a bare origin; keep what people type.
  if (url.endsWith('/') && parsed.pathname === '/' && !parsed.search) url = url.slice(0, -1);
  return { url };
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}
