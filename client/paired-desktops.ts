/**
 * localStorage record of desktops this browser has paired with.
 * Used so the page can auto-reconnect on revisit without re-scanning the QR.
 */

const LS_PAIRED = 'remote-ui:paired';

export interface PairedDesktop {
  peerId: string;
  signKey: string;          // JWK signing pubkey
  exKey: string;            // JWK exchange pubkey
  signalingUrl: string;
  name: string;
  pairedAt: number;
  lastConnected?: number;
}

export function listPairedDesktops(): PairedDesktop[] {
  try {
    const raw = localStorage.getItem(LS_PAIRED);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as PairedDesktop[] : [];
  } catch {
    return [];
  }
}

export function getPairedDesktop(peerId: string): PairedDesktop | undefined {
  return listPairedDesktops().find((p) => p.peerId === peerId);
}

export function getMostRecentPairedDesktop(): PairedDesktop | undefined {
  const all = listPairedDesktops();
  if (all.length === 0) return undefined;
  return all.reduce((best, cur) => {
    const a = cur.lastConnected ?? cur.pairedAt;
    const b = best.lastConnected ?? best.pairedAt;
    return a > b ? cur : best;
  });
}

export function savePairedDesktop(desktop: PairedDesktop): void {
  const all = listPairedDesktops().filter((p) => p.peerId !== desktop.peerId);
  all.push(desktop);
  localStorage.setItem(LS_PAIRED, JSON.stringify(all));
}

export function touchLastConnected(peerId: string): void {
  const all = listPairedDesktops();
  const found = all.find((p) => p.peerId === peerId);
  if (!found) return;
  found.lastConnected = Date.now();
  localStorage.setItem(LS_PAIRED, JSON.stringify(all));
}

export function removePairedDesktop(peerId: string): void {
  const remaining = listPairedDesktops().filter((p) => p.peerId !== peerId);
  localStorage.setItem(LS_PAIRED, JSON.stringify(remaining));
}
