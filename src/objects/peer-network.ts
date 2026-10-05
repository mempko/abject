/**
 * PeerNetwork object — modal window for managing peer identity, signaling
 * servers, and contacts. Extracted from GlobalSettings to be a standalone
 * Abject opened from the GlobalToolbar.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { invariant, require, ensure } from '../core/contracts.js';
import {
  emptyStateMarkdown, emptyStateStyle, livingStyle, eyeSigilOps, removeSigilOps, sigilStreamOps,
} from './ui-kit.js';


interface GatewayStatus { enabled: boolean; listening: boolean; bind: string; port: number; baseUrl: string; workspaces: number; routes: number; tokens: number; }
interface RouteInfo { workspace: string; workspaceSlug: string; abject: string; access: string; methods: string[] | null; path: string; }
interface TokenInfo { id: string; name: string; createdAt: number; lastUsedAt?: number; }

const PEER_NETWORK_INTERFACE: InterfaceId = 'abjects:peer-network';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const IDENTITY_INTERFACE: InterfaceId = 'abjects:identity';
const CLIPBOARD_INTERFACE: InterfaceId = 'abjects:clipboard';
const PEER_REGISTRY_INTERFACE: InterfaceId = 'abjects:peer-registry';

/** Diameter of the live-peer eye sigil, px. */
const SIGIL_SIZE = 22;
/**
 * Window geometry the eye sigil is placed from. Every tab opens with a
 * section card, so the sigil sits at the right end of that first card's
 * title row: title bar, tab bar, the tab's margin, then the card's inset.
 */
const TITLE_BAR_H = 36;
const TAB_BAR_H = 36;
const TAB_MARGIN = 20;
/** Section card insets (WidgetManager createSection: 14 top, 16 sides) and title row height. */
const SECTION_PAD_TOP = 14;
const SECTION_PAD_X = 16;
const SECTION_TITLE_H = 20;
/** Motes per second the sigil streams while a handshake is in flight. */
const HANDSHAKE_STREAM_RATE = 10;
/**
 * Longest a user-started handshake keeps the stream alive. PeerTransport gives
 * up on a DataChannel after 20s; this covers that plus signalling slack, so
 * the stream always stops even when no connect/disconnect event arrives.
 */
const HANDSHAKE_WATCH_MS = 25_000;

type SlabEffect = 'shake' | 'flash' | 'burst' | 'pulse';

/** Tab indices, in the tab bar's order. */
const IDENTITY_TAB = 0;
const CONTACTS_TAB = 1;
const SERVERS_TAB = 2;
const INTROS_TAB = 3;
const FRONTENDS_TAB = 4;
const WEB_TAB = 5;
/** Tab index of the Map: the peer topology as a 3D graph beside the lists. */
const MAP_TAB = 6;
/** Map node id of this peer (held at the centre). */
const SELF_NODE = 'self';

/**
 * A burst of network events (a busy signaling server announces its peer list
 * several times a second) settles into one pass over the visible tab.
 */
const REFRESH_COALESCE_MS = 250;

/** What the tabs read, by source. */
type NetData = 'identity' | 'contacts' | 'servers' | 'signalingPeers' | 'networkPeers' | 'discovery' | 'blocked' | 'intros' | 'frontends' | 'web' | 'policy';

/** What each tab shows, by source (in tab order). */
const TAB_DATA: ReadonlyArray<readonly NetData[]> = [
  /* Identity */ ['identity', 'contacts', 'networkPeers'],
  /* Contacts */ ['contacts'],
  /* Servers & Peers */ ['servers', 'signalingPeers', 'contacts', 'networkPeers', 'discovery', 'blocked', 'policy'],
  /* Introductions */ ['intros', 'contacts'],
  /* Frontends */ ['frontends'],
  /* Web Access */ ['web'],
  /* Map */ ['identity', 'contacts', 'servers', 'signalingPeers', 'networkPeers', 'frontends'],
];

/**
 * What each PeerRegistry event can change. A pass after events re-reads only
 * these sources (the rest come from the last read); selecting a tab reads
 * everything it shows.
 */
const REGISTRY_EVENT_DATA: ReadonlyMap<string, readonly NetData[]> = new Map<string, readonly NetData[]>([
  // The registry lists a signaling peer only while no connection to it is
  // open or being tried, so connection events change that list too.
  ['contactConnected', ['contacts', 'networkPeers', 'signalingPeers', 'discovery']],
  // Also sent when a network peer (not a contact) leaves, or an attempt fails.
  ['contactDisconnected', ['contacts', 'networkPeers', 'signalingPeers', 'discovery']],
  ['contactIntroduced', ['discovery']],
  ['introductionReceived', ['intros']],
  ['signalingStateChanged', ['servers', 'signalingPeers']],
  ['signalingPeersUpdated', ['signalingPeers']],
  ['networkPeerConnected', ['networkPeers', 'signalingPeers', 'discovery']],
  ['networkPeerDisconnected', ['networkPeers', 'signalingPeers', 'discovery']],
  ['peerBlocked', ['blocked', 'contacts', 'networkPeers', 'signalingPeers', 'intros']],
  ['peerUnblocked', ['blocked', 'contacts', 'networkPeers', 'signalingPeers', 'intros']],
  ['signalingPolicyChanged', ['policy', 'servers']],
  ['peerAdmissionChanged', ['policy', 'contacts', 'networkPeers', 'signalingPeers']],
]);

interface ContactSnap { peerId: string; name: string; state: string; addedAt: number }
interface ServerSnap { url: string; status: string }
interface SignalingPeerSnap { peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string; serverUrl: string }
interface NetworkPeerSnap { peerId: string; name: string; connectedAt: number }
interface FrontendSnap { clientId: string; kind: string; peerId: string; name: string; connectedAt: number; ready: boolean }
interface IntroSnap { peerId: string; name: string; fromPeerId: string; receivedAt: number }
interface DiscoverySnap { cacheSize: number; connectedNetworkPeers: number }
/** Fixed signaling and mesh admission, as PeerRegistry reports them. */
interface PolicySnap {
  signaling: { fixed: boolean; pinned: boolean; urls: string[] };
  admission: { mode: 'open' | 'allowlist'; peers: string[]; pinnedPeers: string[]; pinned: boolean };
}

/**
 * One pass's reads. Each source is asked at most once per pass, and what it
 * answers also lands in the window's snapshot (the map and the map strip's
 * actions read from there).
 */
interface NetReads {
  identity(): Promise<{ peerId: string; name: string }>;
  contacts(): Promise<ContactSnap[]>;
  servers(): Promise<ServerSnap[]>;
  signalingPeers(): Promise<SignalingPeerSnap[]>;
  networkPeers(): Promise<NetworkPeerSnap[]>;
  discovery(): Promise<DiscoverySnap>;
  blocked(): Promise<string[]>;
  intros(): Promise<IntroSnap[]>;
  frontends(): Promise<FrontendSnap[]>;
  policy(): Promise<PolicySnap>;
}

/** What a row button does; the row's key says to whom. */
type RowAction =
  | 'removeServer' | 'addSignalingPeer' | 'block' | 'trust' | 'unblock'
  | 'acceptIntro' | 'rejectIntro' | 'disconnectFrontend' | 'revokeFrontend'
  | 'allowPeer' | 'disallowPeer';

/** A row button's action: what it does, for whom, and what the row knew of them when drawn. */
interface RowButtonAction { kind: RowAction; key: string; peer?: SignalingPeerSnap }

/** One widget of a keyed row. A `width` makes it fixed size; without one it takes the row's spare width. */
interface RowCell { spec: Record<string, unknown>; height: number; width?: number; action?: RowButtonAction }

/**
 * A row as the data wants it. `sig` sums up what the row shows: a row whose
 * sig is unchanged costs nothing; one whose sig changed is repainted in place
 * with `updates` (one per cell, undefined leaves that cell).
 */
interface RowSpec { key: string; sig: string; height: number; cells: RowCell[]; updates: Array<Record<string, unknown> | undefined> }

/** A row on screen: its HBox, its cells, and the sig it shows. */
interface LiveRow { rowId: AbjectId; cellIds: AbjectId[]; sig: string }

/** The keyed rows of one card, in display order (after the card's fixed children). */
interface RowSet { parentId: AbjectId; rows: Map<string, LiveRow>; order: string[] }

/** Layout policy of a row inside its card. */
const ROW_POLICY = { vertical: 'fixed', horizontal: 'expanding' } as const;

/** Keys made unique in order (a peer listed twice keeps two rows, as before). */
function uniqueKeys<T extends { key: string }>(rows: T[]): T[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = (seen.get(r.key) ?? 0) + 1;
    seen.set(r.key, n);
    return n === 1 ? r : { ...r, key: `${r.key}#${n}` };
  });
}

/** What the window last read about the network; the map is drawn from it. */
interface NetSnapshot {
  peerId: string;
  peerName: string;
  contacts: ContactSnap[];
  servers: ServerSnap[];
  signalingPeers: SignalingPeerSnap[];
  networkPeers: NetworkPeerSnap[];
  frontends: FrontendSnap[];
}

/** What a map node stands for: the strip under the map names it and offers its action. */
interface MapNodeInfo {
  text: string;
  /** The tab listing it ("Show in list"). */
  tab: number;
  action?: { label: string; kind: 'toggleContact' | 'trust' | 'addSignalingPeer' | 'disconnectFrontend'; key: string };
}

/**
 * A long link shortened in the middle so its start (the host) and its end
 * both stay visible on one line; the full link is what gets copied.
 */
function shortenLink(url: string, max = 52): string {
  if (url.length <= max) return url;
  const gap = ' ... ';
  const tail = 8;
  return `${url.slice(0, max - tail - gap.length)}${gap}${url.slice(-tail)}`;
}

export class PeerNetwork extends Abject {
  private widgetManagerId?: AbjectId;
  private identityId?: AbjectId;
  private clipboardId?: AbjectId;
  private peerRegistryId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private statusLabelId?: AbjectId;

  // Tab state
  private tabBarId?: AbjectId;
  private tabContents: AbjectId[] = [];
  /** Selected tab index (0 = Identity), for the live-peer eye sigil. */
  private selectedTab = 0;
  /** True while at least one peer connection is live. */
  private peersLive = false;
  /** True while the eye sigil is in the window's scene. */
  private sigilShown = false;
  /** Last known window size, for placing the sigil. */
  private winSize?: { width: number; height: number };
  /**
   * The connection handshake this window started and is watching: a contact's
   * peer id, or `signal:<url>` while a signaling server connect is in flight.
   */
  private handshakeKey?: string;
  /** When a connection last flashed the window (keeps a flapping link quiet). */
  private lastConnectFlashAt = 0;
  /** Stops the handshake watch when no outcome event arrives. */
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  /** True while the sigil's handshake stream is emitting (rate > 0). */
  private streamOn = false;

  // Keeping the tabs current. Each tab is built the first time it shows and
  // then updated in place: registry events mark the visible tab due, a burst
  // settles into one pass, and that pass changes only what differs (rows
  // come and go by key, labels change text). Hidden tabs and a minimized
  // window do nothing but remember; they catch up when they show.
  /** Tabs whose widgets exist. */
  private builtTabs: Set<number> = new Set();
  /** The visible tab has changes to show. */
  private refreshDue = false;
  /** The next pass reads everything its tab shows (a tab just selected, or this window's own action). */
  private fullDue = false;
  /** Sources events changed since the last pass (a pass after events re-reads only these). */
  private staleData: Set<NetData> = new Set();
  /** What each source last answered (a pass reuses what did not change). */
  private readCache: Map<NetData, unknown> = new Map();
  /** Coalesces a burst of events into one pass. */
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private flushAgain = false;
  /** True while the window is minimized. */
  private minimized = false;
  /** Keyed rows per card (servers, signalingPeers, network, blocked, intros, frontends). */
  private rowSets: Map<string, RowSet> = new Map();
  /** Row buttons: what each does and for whom. */
  private rowActions: Map<AbjectId, RowButtonAction> = new Map();
  /** Last update sent to each long-lived widget, so an unchanged value sends nothing. */
  private lastSent: Map<AbjectId, string> = new Map();
  /** Visibility this window last gave a widget (absent: visible). */
  private shownState: Map<AbjectId, boolean> = new Map();

  // Identity tab
  private nameInputId?: AbjectId;
  private saveNameBtnId?: AbjectId;
  private copyPeerIdBtnId?: AbjectId;
  private copyIdentityBtnId?: AbjectId;
  private peerIdLabelId?: AbjectId;
  /** The identity name the name field was last given (the field is left alone while it holds). */
  private shownPeerName?: string;

  // Servers & Peers tab
  private signalingInputId?: AbjectId;
  private signalingConnectBtnId?: AbjectId;
  private sigCardId?: AbjectId;
  private sigEmptyId?: AbjectId;
  private spCardId?: AbjectId;
  private netCardId?: AbjectId;
  private netMeshId?: AbjectId;
  private netEmptyId?: AbjectId;
  private blockedCardId?: AbjectId;
  /** "Use only these servers" (fixed signaling) and its pinned note. */
  private fixedSignalingCheckboxId?: AbjectId;
  private sigPinnedNoteId?: AbjectId;
  /** Who Can Connect: the allowlist toggle, its pinned note, and the add row. */
  private admissionCardId?: AbjectId;
  private admissionCheckboxId?: AbjectId;
  private admissionPinnedNoteId?: AbjectId;
  private allowInputId?: AbjectId;
  private allowAddBtnId?: AbjectId;

  // Contacts tab
  private addContactInputId?: AbjectId;
  private addContactBtnId?: AbjectId;
  private contactListId?: AbjectId;
  /**
   * The Contacts card: rebuilt only when it flips between its empty state
   * and the list (the list fills the tab, the empty state sizes to itself).
   * `ids` are the card first, then its title, hint and content.
   */
  private contactsCard?: { kind: 'empty' | 'list'; ids: AbjectId[] };
  /** Peer ids in the order the contacts list shows them. */
  private contactListPeers: string[] = [];
  /** What the contacts list was last given (items and selection). */
  private contactListSig?: string;

  // Introductions tab
  private introCardId?: AbjectId;
  private introEmptyId?: AbjectId;

  // Frontends tab
  private uiServerId?: AbjectId;
  private remoteUIAccessId?: AbjectId;
  private feCardId?: AbjectId;
  private feEmptyId?: AbjectId;
  // Pairing widgets (Frontends tab)
  private remoteEnableCheckboxId?: AbjectId;
  private remoteStatusLabelId?: AbjectId;
  private remoteGenerateBtnId?: AbjectId;
  private remoteQrImageId?: AbjectId;
  private remoteQrUrlLabelId?: AbjectId;
  /** Caption over the pairing link (states when it expires). */
  private remoteQrLinkCaptionId?: AbjectId;
  private remoteCopyLinkBtnId?: AbjectId;
  /** When the current pairing link stops working (ms epoch). */
  private lastQrExpires?: number;
  private lastQrDataUrl?: string;
  private lastQrUrl?: string;

  // Web Access section widgets
  private webGatewayId?: AbjectId;
  /** The Web Access tab was built with the gateway present (else it shows the unavailable note). */
  private webBuiltWithGateway = false;
  private webUnavailableId?: AbjectId;
  private webAccessStatusId?: AbjectId;
  private webToggleBtnId?: AbjectId;
  private webRoutesId?: AbjectId;
  private webMintBtnId?: AbjectId;
  private webTokenResultId?: AbjectId;
  private webTokensId?: AbjectId;
  private webPortInputId?: AbjectId;
  private webPortApplyBtnId?: AbjectId;
  private webGatewayEnabled = false;

  // Discovery dep
  private peerDiscoveryId?: AbjectId;

  // Map tab (built once per window; its pass redraws it with one setGraph)
  private mapGraphId?: AbjectId;
  private mapDetailLabelId?: AbjectId;
  private mapActionBtnId?: AbjectId;
  private mapShowBtnId?: AbjectId;
  /** Selected map node (the contacts list selection follows it, and back). */
  private mapSelectedId?: string;
  /** Node ids the map holds now (select and pulse only reach these). */
  private mapNodeIds: Set<string> = new Set();
  private mapInfo: Map<string, MapNodeInfo> = new Map();
  private snapshot: NetSnapshot = { peerId: '', peerName: '', contacts: [], servers: [], signalingPeers: [], networkPeers: [], frontends: [] };
  /**
   * Map nodes that were live (active) at the last redraw while the map
   * showed; a node that comes alive since pulses. Unset while the map is
   * hidden, so showing it replays nothing.
   */
  private mapLive?: Set<string>;
  /** The selection the map widget holds (it keeps one across setGraph). */
  private mapWidgetSelection?: string;
  /** What the strip under the map shows now (skip unchanged updates). */
  private mapStripSig?: string;

  constructor() {
    super({
      manifest: {
        name: 'PeerNetwork',
        description:
          'Peer network management UI. Identity, signaling servers, and contacts.',
        version: '1.0.0',
        interface: {
            id: PEER_NETWORK_INTERFACE,
            name: 'PeerNetwork',
            description: 'Peer network management',
            methods: [
              {
                name: 'show',
                description: 'Show the peer network window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the peer network window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display peer network window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'network'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## PeerNetwork Usage Guide

PeerNetwork is the peer network management UI. It provides a modal window
for managing your identity, signaling servers, and contacts.

### Show the peer network window

  await call(await dep('PeerNetwork'), 'show', {});
  / returns true when the window is displayed

### Hide the peer network window

  await call(await dep('PeerNetwork'), 'hide', {});
  / returns true when the window is hidden

### What it manages
- Identity: view/edit your peer name, copy your peer ID or full identity JSON
- Signaling servers: add, connect, disconnect, and remove signaling server URLs
- Contacts: add contacts by peer ID, connect/disconnect, introduce contacts to each other
- Network peers: view connected peers discovered through signaling, promote to contacts
- Discovered peers: view peers found via gossip-based discovery
- Map tab: the same network as a 3D map with this peer at the centre (contacts, network
  peers, signaling servers and the peers visible on them, paired frontends). Live links
  breathe in the living light; a link that opens, or a handshake you start, sends light
  along its edge. Click a node for its details, its action and Show in list; the
  contacts list and the map share their selection.

### Notes
- This is a UI object; it renders its own window via WidgetManager.
- Closing the window hides it (does not destroy it).

Interface: abjects:peer-network`;
  }

  /** Style for the one affirmative primary button per area (red action face). */
  private positiveButtonStyle(): Record<string, unknown> {
    const t = this.theme;
    return { background: t.actionBg, color: t.actionText, borderColor: t.actionBorder };
  }

  /**
   * Style for affirmative buttons repeated on every row (Add, Trust, Unblock,
   * Accept). Red is kept for the one primary action per area, so row buttons
   * are default secondary buttons.
   */
  private rowPositiveStyle(): Record<string, unknown> {
    return { fontSize: 11 };
  }

  /**
   * A grouped card for one section (WidgetManager createSection: ruled panel,
   * sigil title, wrap-friendly hint). Returns the card's layout id: add the
   * section's rows to IT, not to the tab. Cards size to their content inside
   * a tab's ScrollableVBox; `expanding` fills the space the tab has left.
   */
  private async sectionCard(parentId: AbjectId, title: string, description: string, hintHeight = 18, expanding = false): Promise<AbjectId> {
    return (await this.sectionCardParts(parentId, title, description, hintHeight, expanding)).sectionId;
  }

  /** sectionCard, also returning the card's title and hint ids (for a card that is later replaced). */
  private async sectionCardParts(parentId: AbjectId, title: string, description: string, hintHeight = 18, expanding = false): Promise<{ sectionId: AbjectId; titleId: AbjectId; hintId?: AbjectId }> {
    return this.request<{ sectionId: AbjectId; titleId: AbjectId; hintId?: AbjectId }>(
      request(this.id, this.widgetManagerId!, 'createSection', {
        parentLayoutId: parentId,
        windowId: this.windowId,
        title,
        description,
        hintHeight,
        expanding,
      })
    );
  }

  /**
   * Empty-state label spec plus its height: the kit markdown empty state
   * saying what appears here and how to get it.
   */
  private emptySpec(title: string, hint: string): { spec: Record<string, unknown>; height: number } {
    const t = this.theme;
    return {
      spec: { type: 'label', windowId: this.windowId, text: emptyStateMarkdown(title, hint), style: emptyStateStyle(t) },
      height: 64,
    };
  }

  /** Create one widget from a spec and place it in a layout at a fixed height (and width, when given). */
  private async addWidget(layoutId: AbjectId, spec: Record<string, unknown>, height: number, width?: number): Promise<AbjectId> {
    const { widgetIds: [widgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [spec] })
    );
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId,
      sizePolicy: { vertical: 'fixed', horizontal: width !== undefined ? 'fixed' : 'expanding' },
      preferredSize: width !== undefined ? { width, height } : { height },
    }));
    return widgetId;
  }

  /**
   * Update a long-lived widget only when the payload differs from the last
   * one it was given here (the widget keeps its own copy; resending the same
   * text would only cost a message and a redraw).
   */
  private async updateIfChanged(widgetId: AbjectId | undefined, payload: Record<string, unknown>): Promise<void> {
    if (!widgetId) return;
    const sig = JSON.stringify(payload);
    if (this.lastSent.get(widgetId) === sig) return;
    this.lastSent.set(widgetId, sig);
    try {
      await this.request(request(this.id, widgetId, 'update', payload));
    } catch {
      this.lastSent.delete(widgetId); // gone or busy: the next pass sends again
    }
  }

  /** Show or hide a widget, sending only on a change (its layout drops a hidden widget from the flow). */
  private async setShown(widgetId: AbjectId | undefined, shown: boolean): Promise<void> {
    if (!widgetId || (this.shownState.get(widgetId) ?? true) === shown) return;
    this.shownState.set(widgetId, shown);
    try {
      await this.request(request(this.id, widgetId, 'update', { style: { visible: shown } }));
    } catch {
      this.shownState.delete(widgetId);
    }
  }

  /** Destroy widgets this window made (fire and forget; a second destroy is harmless). */
  private destroyWidgets(ids: AbjectId[]): void {
    for (const id of ids) {
      this.rowActions.delete(id);
      this.lastSent.delete(id);
      this.shownState.delete(id);
      try { this.send(event(this.id, id, 'destroy', {})); } catch { /* already gone */ }
    }
  }

  /**
   * Bring one card's keyed rows in line with the data. Rows whose subject
   * left are detached and destroyed; rows whose content changed are repainted
   * in place; new rows are created. Rows already in the wanted order stay
   * where they are; any that must move are detached and re-appended (moved,
   * not rebuilt). An unchanged list sends nothing.
   */
  private async syncRows(name: string, parentId: AbjectId, specs: RowSpec[]): Promise<void> {
    const windowId = this.windowId;
    let set = this.rowSets.get(name);
    if (!set || set.parentId !== parentId) {
      set = { parentId, rows: new Map(), order: [] };
      this.rowSets.set(name, set);
    }
    const want = new Map(specs.map((s) => [s.key, s]));
    require(want.size === specs.length, `syncRows(${name}): row keys are unique`);
    for (const key of set.order) {
      if (want.has(key)) continue;
      const row = set.rows.get(key)!;
      set.rows.delete(key);
      await this.request(request(this.id, parentId, 'removeLayoutChild', { widgetId: row.rowId })).catch(() => { /* card gone */ });
      this.destroyWidgets([...row.cellIds, row.rowId]);
    }
    const kept = set.order.filter((k) => want.has(k));
    set.order = kept;
    for (const key of kept) {
      const row = set.rows.get(key)!;
      const spec = want.get(key)!;
      if (row.sig === spec.sig) continue;
      row.sig = spec.sig;
      for (let i = 0; i < row.cellIds.length; i++) {
        const update = spec.updates[i];
        if (update) await this.request(request(this.id, row.cellIds[i], 'update', update)).catch(() => { /* gone */ });
      }
    }
    let inPlace = 0;
    while (inPlace < kept.length && kept[inPlace] === specs[inPlace].key) inPlace++;
    for (const key of kept.slice(inPlace)) {
      await this.request(request(this.id, parentId, 'removeLayoutChild', { widgetId: set.rows.get(key)!.rowId })).catch(() => { /* gone */ });
    }
    for (const spec of specs.slice(inPlace)) {
      if (this.windowId !== windowId) return; // the window closed mid-pass
      const row = set.rows.get(spec.key);
      if (row) {
        await this.request(request(this.id, parentId, 'addLayoutChild', {
          widgetId: row.rowId, sizePolicy: ROW_POLICY, preferredSize: { height: spec.height },
        })).catch(() => { /* gone */ });
      } else {
        set.rows.set(spec.key, await this.createRow(parentId, spec));
      }
    }
    set.order = specs.map((s) => s.key);
    ensure(set.order.length === set.rows.size, `syncRows(${name}): every wanted row is on screen`);
  }

  /** One keyed row: an HBox in the card, its cells in one create, its buttons wired to their actions. */
  private async createRow(parentId: AbjectId, spec: RowSpec): Promise<LiveRow> {
    const rowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: parentId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, parentId, 'addLayoutChild', {
      widgetId: rowId, sizePolicy: ROW_POLICY, preferredSize: { height: spec.height },
    }));
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: spec.cells.map((c) => c.spec) })
    );
    await this.request(request(this.id, rowId, 'addLayoutChildren', {
      children: spec.cells.map((c, i) => ({
        widgetId: widgetIds[i],
        sizePolicy: { vertical: 'fixed', horizontal: c.width !== undefined ? 'fixed' : 'expanding' },
        preferredSize: c.width !== undefined ? { width: c.width, height: c.height } : { height: c.height },
      })),
    }));
    for (let i = 0; i < spec.cells.length; i++) {
      const action = spec.cells[i].action;
      if (!action) continue;
      this.rowActions.set(widgetIds[i], action);
      await this.request(request(this.id, widgetIds[i], 'addDependent', {}));
    }
    return { rowId, cellIds: widgetIds, sig: spec.sig };
  }

  /** Style for the remote UI status line: phosphor while enabled, muted when off. */
  private remoteStatusStyle(enabled: boolean): Record<string, unknown> {
    return enabled ? { ...livingStyle(this.theme) } : { color: this.theme.textMeta, fontSize: 12 };
  }

  /** Colour for a live/connected status (phosphor). */
  private liveColor(): string {
    return livingStyle(this.theme).color as string;
  }

  /**
   * Show the small eye sigil beside the tab's header row while at least one
   * peer connection is live and the Identity tab is selected, or on any tab
   * while a handshake this window started is under way. During the handshake
   * the kit's sigil stream flows from the eye; it stops (rate 0) the moment
   * the handshake resolves. The stream is a child of the sigil, so removing
   * the eye removes it too. Adds or removes once per state change; motion is
   * client-side.
   */
  private async syncPeerSigil(forceReposition = false): Promise<void> {
    if (!this.windowId) { this.sigilShown = false; this.streamOn = false; return; }
    const handshaking = this.handshakeKey !== undefined;
    const want = (this.peersLive && this.selectedTab === 0) || handshaking;
    const wantStream = want && handshaking;
    const reposition = forceReposition && this.sigilShown;
    if (want === this.sigilShown && wantStream === this.streamOn && !reposition) return;
    try {
      if (this.sigilShown && (!want || reposition)) {
        await this.request(request(this.id, this.windowId, 'scene', { ops: removeSigilOps('peer-live') }));
        this.sigilShown = false;
        this.streamOn = false;
      }
      if (!want) return;
      if (this.sigilShown) {
        // The eye stays; only the stream starts or stops.
        await this.request(request(this.id, this.windowId, 'scene', {
          ops: [{ op: 'update', id: 'peer-live-stream', params: { rate: wantStream ? HANDSHAKE_STREAM_RATE : 0 } }],
        }));
        this.streamOn = wantStream;
        return;
      }
      if (!this.winSize) {
        const rect = await this.request<{ x: number; y: number; width: number; height: number }>(
          request(this.id, this.windowId, 'getRect', {})
        );
        this.winSize = { width: rect.width, height: rect.height };
      }
      const { width, height } = this.winSize;
      // Centre of the first card's title row: title bar, tab bar, tab margin,
      // card inset, then half the title row. The eye sits at that row's right
      // end, inside the card's side inset.
      const headerCenterY = TITLE_BAR_H + TAB_BAR_H + TAB_MARGIN + SECTION_PAD_TOP + SECTION_TITLE_H / 2;
      const rightInset = TAB_MARGIN + SECTION_PAD_X + SIGIL_SIZE / 2;
      const at: [number, number, number] = [width / 2 - rightInset, headerCenterY - height / 2, 8];
      await this.request(request(this.id, this.windowId, 'scene', { ops: [
        ...eyeSigilOps('peer-live', at, SIGIL_SIZE),
        ...sigilStreamOps('peer-live', SIGIL_SIZE, wantStream ? HANDSHAKE_STREAM_RATE : 0),
      ] }));
      this.sigilShown = true;
      this.streamOn = wantStream;
    } catch { /* scene is best effort */ }
  }

  /**
   * Begin watching a handshake this window started: the stream flows until
   * an outcome arrives, bounded by a timer so it always stops.
   */
  private async startHandshake(key: string): Promise<void> {
    this.cancelTimer(this.handshakeTimer);
    this.handshakeKey = key;
    this.handshakeTimer = this.setTimer(async () => {
      this.handshakeTimer = undefined;
      if (this.handshakeKey !== key) return;
      // No outcome event arrived: stop watching and report the real state.
      await this.endHandshake();
      if (!key.startsWith('signal:')) await this.reportContactOutcome(key);
    }, HANDSHAKE_WATCH_MS);
    await this.syncPeerSigil();
    // The handshake leaves this peer: one mote along the edge on the map.
    await this.pulseOnMap(key.startsWith('signal:') ? `sig:${key.slice('signal:'.length)}` : `peer:${key}`, 1);
  }

  /** Ask the registry how a watched handshake ended and say so. */
  private async reportContactOutcome(peerId: string): Promise<void> {
    let state = '';
    if (this.peerRegistryId) {
      try {
        state = await this.request<string>(request(this.id, this.peerRegistryId, 'getContactState', { peerId }));
      } catch { /* registry busy: treat as not connected */ }
    }
    await this.refresh();
    if (state === 'connected') await this.acknowledge('Connected.', this.liveColor());
    else await this.reject('Could not connect to that peer. They may be offline.');
  }

  /** Stop watching the handshake: the stream stops and the sigil follows its idle rule. */
  private async endHandshake(): Promise<void> {
    this.cancelTimer(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (this.handshakeKey === undefined) return;
    this.handshakeKey = undefined;
    await this.syncPeerSigil();
  }

  /** Play a slab effect on the window (visual only, fire and forget). */
  private windowEffect(effect: SlabEffect): void {
    if (!this.windowId) return;
    this.request(request(this.id, this.windowId, 'effect', { effect }))
      .catch(() => { /* effects are decoration */ });
  }

  /** Report a failure or invalid input: error status plus a shake. */
  private async reject(text: string): Promise<void> {
    this.windowEffect('shake');
    await this.setStatus(text, this.theme.statusError);
  }

  /** Report a success: status plus a living-light flash. */
  private async acknowledge(text: string, color?: string): Promise<void> {
    this.windowEffect('flash');
    await this.setStatus(text, color);
  }

  // ========== MAP TAB ==========

  /**
   * Show one tab and hide the rest (a hidden tab takes its map scene with
   * it). `fromCode` also moves the tab bar, for "Show in list".
   */
  private async selectTab(idx: number, fromCode = false): Promise<void> {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.tabContents.length) return;
    if (fromCode && this.tabBarId) {
      await this.request(request(this.id, this.tabBarId, 'update', { selectedIndex: idx })).catch(() => { /* gone */ });
    }
    // Only the tab that leaves and the tab that arrives change.
    for (let i = 0; i < this.tabContents.length; i++) {
      await this.setShown(this.tabContents[i], i === idx);
    }
    this.selectedTab = idx;
    // A tab bar click means the window is on screen, whatever we last heard.
    this.minimized = false;
    if (idx !== MAP_TAB) this.mapLive = undefined;
    await this.syncPeerSigil();
    // The tab shows what is true now: built on first show, then brought up
    // to date (a pass changes only what differs; the map redraws with one
    // setGraph, and unchanged data moves nothing).
    this.fullDue = true;
    this.refreshDue = true;
    await this.flush();
  }

  // ========== KEEPING TABS CURRENT ==========

  /**
   * An event changed these sources. Only the visible tab acts, and only if
   * it shows one of them, once a burst settles; hidden tabs read fresh when
   * selected, and a minimized window only remembers what changed.
   */
  private markStale(data: readonly NetData[]): void {
    if (!this.windowId) return;
    const shows = TAB_DATA[this.selectedTab];
    const touched = data.filter((d) => shows.includes(d));
    if (touched.length === 0) return;
    for (const d of touched) this.staleData.add(d);
    this.refreshDue = true;
    if (this.minimized || this.flushTimer !== undefined) return;
    this.flushTimer = this.setTimer(async () => {
      this.flushTimer = undefined;
      await this.flush();
    }, REFRESH_COALESCE_MS);
  }

  /**
   * After this window's own action (add, remove, connect, ...): bring the
   * visible tab up to date now, reading everything it shows.
   */
  private async refresh(): Promise<void> {
    if (!this.windowId) return;
    this.minimized = false;
    this.fullDue = true;
    this.refreshDue = true;
    await this.flush();
  }

  /**
   * Bring the visible tab up to date if it is due. One pass at a time; a
   * request that arrives mid-pass runs another pass after it (for whichever
   * tab is visible then).
   */
  private async flush(): Promise<void> {
    if (!this.windowId || this.minimized) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        if (!this.refreshDue) continue;
        const fresh: 'all' | Set<NetData> = this.fullDue ? 'all' : new Set(this.staleData);
        this.refreshDue = false;
        this.fullDue = false;
        this.staleData.clear();
        await this.syncTab(this.selectedTab, fresh);
      } while (this.flushAgain && this.windowId !== undefined && !this.minimized);
    } finally {
      this.flushing = false;
    }
  }

  /** One pass over one tab: build it the first time, then change what differs. */
  private async syncTab(tab: number, fresh: 'all' | Set<NetData>): Promise<void> {
    require(Number.isInteger(tab) && tab >= 0 && tab <= MAP_TAB, 'syncTab: a tab index');
    const windowId = this.windowId;
    const reads = this.newReads(fresh);
    try {
      switch (tab) {
        case IDENTITY_TAB: await this.syncIdentityTab(reads); break;
        case CONTACTS_TAB: await this.syncContactsTab(reads); break;
        case SERVERS_TAB: await this.syncServersTab(reads); break;
        case INTROS_TAB: await this.syncIntrosTab(reads); break;
        case FRONTENDS_TAB: await this.syncFrontendsTab(reads); break;
        case WEB_TAB: await this.syncWebTab(); break;
        case MAP_TAB: await this.syncMapTab(reads); break;
      }
    } catch (err) {
      if (this.windowId === windowId) throw err;
      // The window closed mid-pass; its widgets went with it.
    }
  }

  /**
   * Readers for one pass. A source in `fresh` (or never read) is asked,
   * once however many cards need it; any other source answers with what it
   * said last. Answers also land in the snapshot the map draws from. A
   * source that does not answer reads as empty, as a busy registry always has.
   */
  private newReads(fresh: 'all' | Set<NetData>): NetReads {
    const snap = this.snapshot;
    const ask = async <T>(to: AbjectId | undefined, method: string, fallback: T): Promise<T> => {
      if (!to) return fallback;
      try {
        return (await this.request<T>(request(this.id, to, method, {}))) ?? fallback;
      } catch {
        return fallback;
      }
    };
    const source = <T>(key: NetData, read: () => Promise<T>): (() => Promise<T>) => {
      let pending: Promise<T> | undefined;
      return () => (pending ??= (async () => {
        if (fresh !== 'all' && !fresh.has(key) && this.readCache.has(key)) return this.readCache.get(key) as T;
        const value = await read();
        this.readCache.set(key, value);
        return value;
      })());
    };
    return {
      identity: source('identity', async () => {
        const id = await ask<{ peerId: string; name?: string } | null>(this.identityId, 'exportPublicKeys', null);
        if (id) {
          snap.peerId = id.peerId;
          snap.peerName = id.name ?? '';
        }
        return { peerId: snap.peerId, name: snap.peerName };
      }),
      contacts: source('contacts', async () => (snap.contacts = await ask<ContactSnap[]>(this.peerRegistryId, 'listContacts', []))),
      servers: source('servers', async () => (snap.servers = await ask<ServerSnap[]>(this.peerRegistryId, 'listSignalingServers', []))),
      signalingPeers: source('signalingPeers', async () => (snap.signalingPeers = await ask<SignalingPeerSnap[]>(this.peerRegistryId, 'listSignalingPeers', []))),
      networkPeers: source('networkPeers', async () => (snap.networkPeers = await ask<NetworkPeerSnap[]>(this.peerRegistryId, 'listNetworkPeers', []))),
      discovery: source('discovery', () => ask<DiscoverySnap>(this.peerDiscoveryId, 'getDiscoveryStats', { cacheSize: 0, connectedNetworkPeers: 0 })),
      blocked: source('blocked', () => ask<string[]>(this.peerRegistryId, 'listBlockedPeers', [])),
      intros: source('intros', () => ask<IntroSnap[]>(this.peerRegistryId, 'listPendingIntroductions', [])),
      frontends: source('frontends', async () => {
        await this.ensureFrontendDeps();
        return (snap.frontends = await ask<FrontendSnap[]>(this.uiServerId, 'listFrontendClients', []));
      }),
      policy: source('policy', async () => ({
        signaling: await ask<PolicySnap['signaling']>(this.peerRegistryId, 'getSignalingPolicy',
          { fixed: false, pinned: false, urls: [] }),
        admission: await ask<PolicySnap['admission']>(this.peerRegistryId, 'getPeerAdmission',
          { mode: 'open', peers: [], pinnedPeers: [], pinned: false }),
      })),
    };
  }

  /** Live peer connections drive the Identity tab's eye sigil. */
  private async notePeersLive(reads: NetReads): Promise<void> {
    const [contacts, networkPeers] = await Promise.all([reads.contacts(), reads.networkPeers()]);
    this.peersLive = contacts.some((c) => c.state === 'connected') || networkPeers.length > 0;
    await this.syncPeerSigil();
  }

  /** The Map tab's pass: read what the map draws, then one setGraph. */
  private async syncMapTab(reads: NetReads): Promise<void> {
    await Promise.all([reads.identity(), reads.contacts(), reads.servers(), reads.signalingPeers(), reads.networkPeers(), reads.frontends()]);
    await this.notePeersLive(reads);
    await this.syncPeerMap();
  }

  private mapShown(): boolean {
    return this.selectedTab === MAP_TAB && this.mapGraphId !== undefined;
  }

  /** The Map tab: the graph, then a strip naming the selection with its action. */
  private async buildMapTab(mapTabId: AbjectId): Promise<void> {
    const t = this.theme;
    const { widgetIds: [graphId, detailId, actionId, showId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        {
          type: 'nodeGraph', windowId: this.windowId, title: 'Peer network',
          emptyText: 'Reading the network', directed: false,
          groups: [
            { id: 'self', label: 'This peer', color: '$textPrimary', shape: 'icosphere', material: 'ceramic' },
            { id: 'contacts', label: 'Contacts', color: '$statusInfo', shape: 'sphere' },
            { id: 'network', label: 'Network peers', color: '$statusSuccess', shape: 'sphere' },
            { id: 'servers', label: 'Signaling servers', color: '$textSecondary', shape: 'cylinder' },
            { id: 'discoverable', label: 'On your servers', color: '$textSecondary', shape: 'icosphere' },
            { id: 'frontends', label: 'Frontends', color: '$accentTertiary', shape: 'roundedBox' },
          ],
          hint: 'Drag to turn · wheel to zoom · click a node for its details',
        },
        { type: 'label', windowId: this.windowId, text: '', style: { color: t.textMeta, fontSize: 12, selectable: true } },
        { type: 'button', windowId: this.windowId, text: 'Connect', style: { ...this.positiveButtonStyle(), fontSize: 11, visible: false } },
        { type: 'button', windowId: this.windowId, text: 'Show in list', style: { fontSize: 11, visible: false } },
      ] })
    );
    this.mapGraphId = graphId;
    this.mapDetailLabelId = detailId;
    this.mapActionBtnId = actionId;
    this.mapShowBtnId = showId;
    await this.request(request(this.id, mapTabId, 'addLayoutChild', {
      widgetId: graphId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    const stripId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: mapTabId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, mapTabId, 'addLayoutChild', {
      widgetId: stripId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    await this.request(request(this.id, stripId, 'addLayoutChildren', { children: [
      { widgetId: detailId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 30 } },
      { widgetId: actionId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 100, height: 28 } },
      { widgetId: showId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 100, height: 28 } },
    ] }));
    for (const id of [graphId, actionId, showId]) {
      await this.request(request(this.id, id, 'addDependent', {}));
    }
  }

  /**
   * Redraw the map from the last snapshot: this peer at the centre; contacts,
   * network peers, signaling servers (with the peers visible on them) and
   * paired frontends around it. Live links breathe in the living light and
   * are drawn solid; offline ones are see-through and dashed. Runs in the
   * Map tab's pass (when it shows, and after network events while it
   * shows); one setGraph, and nodes keep their places. A link that comes
   * alive while the map shows pulses.
   */
  private async syncPeerMap(): Promise<void> {
    if (!this.mapGraphId || !this.mapShown()) return;
    const snap = this.snapshot;
    const nodes: Array<Record<string, unknown>> = [];
    const edges: Array<Record<string, unknown>> = [];
    const info = new Map<string, MapNodeInfo>();
    const shortId = (id: string) => (id ? `${id.slice(0, 12)}...` : '');
    const liveCount = snap.contacts.filter((c) => c.state === 'connected').length + snap.networkPeers.length;

    nodes.push({ id: SELF_NODE, label: snap.peerName || 'This peer', group: 'self', size: 14, center: true });
    info.set(SELF_NODE, {
      text: `This peer · ${snap.peerName || 'unnamed'} · ${shortId(snap.peerId)} · ${liveCount} live connection${liveCount === 1 ? '' : 's'}`,
      tab: 0,
    });

    for (const c of snap.contacts) {
      const id = `peer:${c.peerId}`;
      const live = c.state === 'connected';
      const name = c.name || shortId(c.peerId);
      nodes.push({
        id, label: name, group: 'contacts', size: 9, active: live,
        ...(c.state === 'connecting' ? { color: '$statusWarning' } : {}),
        ...(!live && c.state !== 'connecting' ? { ghost: true } : {}),
      });
      edges.push({ from: SELF_NODE, to: id, weight: live ? 2.5 : 0.6, ...(live ? {} : { style: 'dashed' }) });
      info.set(id, {
        text: `${name} · contact · ${c.state} · ${shortId(c.peerId)}`,
        tab: 1,
        action: { label: live ? 'Disconnect' : 'Connect', kind: 'toggleContact', key: c.peerId },
      });
    }
    for (const p of snap.networkPeers) {
      const id = `peer:${p.peerId}`;
      if (info.has(id)) continue;
      const name = p.name || shortId(p.peerId);
      nodes.push({ id, label: name, group: 'network', size: 8, active: true });
      edges.push({ from: SELF_NODE, to: id, weight: 2.5 });
      info.set(id, {
        text: `${name} · network peer · connected ${this.formatDuration(Date.now() - p.connectedAt)}`,
        tab: 2,
        action: { label: 'Trust', kind: 'trust', key: p.peerId },
      });
    }
    for (const s of snap.servers) {
      const id = `sig:${s.url}`;
      const live = s.status === 'connected';
      let host = s.url;
      try { host = new URL(s.url).host || s.url; } catch { /* not a URL: show it whole */ }
      nodes.push({
        id, label: host, group: 'servers', size: 10, active: live,
        ...(s.status === 'connecting' ? { color: '$statusWarning' } : {}),
        ...(!live && s.status !== 'connecting' ? { ghost: true } : {}),
      });
      edges.push({ from: SELF_NODE, to: id, weight: live ? 1.5 : 0.6, ...(live ? {} : { style: 'dashed' }) });
      info.set(id, { text: `${s.url} · signaling server · ${live ? 'connected' : s.status === 'connecting' ? 'connecting' : 'offline'}`, tab: 2 });
    }
    for (const sp of snap.signalingPeers) {
      const server = `sig:${sp.serverUrl}`;
      if (!info.has(server)) continue;
      const known = `peer:${sp.peerId}`;
      if (info.has(known)) {
        edges.push({ id: `seen:${sp.peerId}`, from: server, to: known, weight: 0.4, style: 'dashed' });
        continue;
      }
      const id = `sp:${sp.peerId}`;
      if (info.has(id)) continue;
      const name = sp.name || shortId(sp.peerId);
      nodes.push({ id, label: name, group: 'discoverable', size: 6, ghost: true });
      edges.push({ from: server, to: id, weight: 0.5, style: 'dashed' });
      info.set(id, {
        text: `${name} · visible on ${sp.serverUrl}`,
        tab: 2,
        action: { label: 'Add contact', kind: 'addSignalingPeer', key: sp.peerId },
      });
    }
    for (const fe of snap.frontends) {
      const id = `fe:${fe.clientId}`;
      const kind = fe.kind === 'webrtc' ? 'P2P' : 'WS';
      const name = fe.name?.trim() || shortId(fe.peerId) || fe.clientId.slice(0, 10);
      nodes.push({ id, label: `${kind} ${name}`, group: 'frontends', size: 7, active: fe.ready, ...(fe.ready ? {} : { ghost: true }) });
      edges.push({ from: SELF_NODE, to: id, weight: 1.5, ...(fe.ready ? {} : { style: 'dashed' }) });
      info.set(id, {
        text: `${kind} frontend · ${name} · connected ${formatRelative(Date.now() - fe.connectedAt)}`,
        tab: 4,
        action: { label: 'Disconnect', kind: 'disconnectFrontend', key: fe.clientId },
      });
    }

    try {
      await this.request(request(this.id, this.mapGraphId, 'setGraph', { nodes, edges }));
    } catch {
      return; // the window went away mid-refresh
    }
    this.mapInfo = info;
    this.mapNodeIds = new Set(info.keys());
    if (this.mapSelectedId && !this.mapNodeIds.has(this.mapSelectedId)) this.mapSelectedId = undefined;
    if (this.mapSelectedId && this.mapSelectedId !== this.mapWidgetSelection) {
      // Chosen in the contacts list while the map was hidden.
      await this.request(request(this.id, this.mapGraphId, 'select', { id: this.mapSelectedId })).catch(() => { /* gone */ });
    }
    this.mapWidgetSelection = this.mapSelectedId;
    await this.updateMapStrip();

    // A link that came alive while the map showed: light flows out to it.
    const live = new Set(nodes.filter((n) => n.active === true).map((n) => n.id as string));
    const before = this.mapLive;
    this.mapLive = live;
    if (before) {
      for (const id of live) if (!before.has(id)) await this.pulseOnMap(id, 2);
    }
  }

  /** One flow of light from this peer to a node on the map (while the map shows). */
  private async pulseOnMap(nodeId: string, count: number): Promise<void> {
    if (!this.mapShown() || !this.mapNodeIds.has(nodeId)) return;
    await this.request(request(this.id, this.mapGraphId!, 'pulse', { from: SELF_NODE, to: nodeId, count }))
      .catch(() => { /* not placed yet */ });
  }

  /**
   * Select a node: the map (unless the click came from it), the strip under
   * it, and the contacts list when it is a contact.
   */
  private async selectOnMap(nodeId: string, via: 'map' | 'list'): Promise<void> {
    this.mapSelectedId = nodeId;
    if (via === 'map') this.mapWidgetSelection = nodeId;
    if (via === 'list' && this.mapGraphId && this.mapNodeIds.has(nodeId)) {
      await this.request(request(this.id, this.mapGraphId, 'select', { id: nodeId })).catch(() => { /* not on the map yet */ });
      this.mapWidgetSelection = nodeId;
    }
    if (via === 'map' && this.contactListId && nodeId.startsWith('peer:')) {
      // The row as the contacts list shows it (the list may be a pass behind the snapshot).
      const idx = this.contactListPeers.indexOf(nodeId.slice('peer:'.length));
      if (idx >= 0) {
        await this.request(request(this.id, this.contactListId, 'update', { selectedIndex: idx })).catch(() => { /* list gone */ });
      }
    }
    await this.updateMapStrip();
  }

  /** The strip under the map: the selection's facts, its action, and Show in list. */
  private async updateMapStrip(): Promise<void> {
    if (!this.mapDetailLabelId) return;
    const info = this.mapSelectedId ? this.mapInfo.get(this.mapSelectedId) : undefined;
    const text = info?.text ?? 'Click a peer, server or frontend for its details.';
    // Every refresh redraws the map; the strip only changes when its content does.
    const sig = JSON.stringify([text, info?.action?.label ?? null, !!info]);
    if (sig === this.mapStripSig) return;
    this.mapStripSig = sig;
    try {
      await this.request(request(this.id, this.mapDetailLabelId, 'update', {
        text, style: { color: info ? this.theme.textHeading : this.theme.textMeta },
      }));
      if (this.mapActionBtnId) {
        await this.request(request(this.id, this.mapActionBtnId, 'update', {
          ...(info?.action ? { text: info.action.label } : {}),
          style: { visible: !!info?.action },
        }));
      }
      if (this.mapShowBtnId) {
        await this.request(request(this.id, this.mapShowBtnId, 'update', { style: { visible: !!info } }));
      }
    } catch { /* widgets gone */ }
  }

  /** The strip's action: the same operation the lists offer for that row. */
  private async runMapAction(): Promise<void> {
    const action = this.mapSelectedId ? this.mapInfo.get(this.mapSelectedId)?.action : undefined;
    if (!action) return;
    switch (action.kind) {
      case 'toggleContact':
        await this.toggleConnection(action.key);
        return;
      case 'trust':
        await this.promoteNetworkPeer(action.key);
        return;
      case 'addSignalingPeer':
        await this.addSignalingPeerContact(action.key, true);
        return;
      case 'disconnectFrontend':
        await this.disconnectFrontend(action.key);
        return;
    }
  }

  /** A row button: the operation its row offers, for that row's subject. */
  private async runRowAction({ kind, key, peer }: RowButtonAction): Promise<void> {
    switch (kind) {
      case 'removeServer': await this.removeSignalingServer(key); return;
      case 'addSignalingPeer': await this.addSignalingPeerContact(key, false, peer); return;
      case 'block': await this.blockPeer(key); return;
      case 'trust': await this.promoteNetworkPeer(key); return;
      case 'unblock': await this.unblockPeer(key); return;
      case 'acceptIntro': await this.acceptIntroduction(key); return;
      case 'rejectIntro': await this.rejectIntroduction(key); return;
      case 'disconnectFrontend': await this.disconnectFrontend(key); return;
      case 'allowPeer': await this.allowPeer(key); return;
      case 'disallowPeer': await this.disallowPeer(key); return;
      case 'revokeFrontend':
        if (!this.remoteUIAccessId) return;
        try {
          await this.request(request(this.id, this.remoteUIAccessId, 'revokeClient', { peerId: key }));
        } catch {
          await this.reject('Could not revoke that frontend.');
        }
        return;
    }
  }

  /**
   * Make a peer seen on a signaling server a contact (its keys as the server
   * listed them: the row's own copy, or the last read). From the map, the new
   * contact stays selected there.
   */
  private async addSignalingPeerContact(peerId: string, selectOnMap: boolean, known?: SignalingPeerSnap): Promise<void> {
    const sp = known ?? this.snapshot.signalingPeers.find((p) => p.peerId === peerId);
    if (!this.peerRegistryId) return;
    if (!sp) {
      await this.reject('Could not add that peer as a contact.');
      return;
    }
    try {
      await this.request(request(this.id, this.peerRegistryId, 'addContact', {
        peerId: sp.peerId, name: sp.name, publicSigningKey: sp.publicSigningKey, publicExchangeKey: sp.publicExchangeKey,
      }));
    } catch {
      await this.reject('Could not add that peer as a contact.');
      return;
    }
    if (selectOnMap) this.mapSelectedId = `peer:${sp.peerId}`;
    // Adding emits no registry event, so show the new contact now.
    await this.refresh();
    await this.acknowledge('Contact added!');
  }

  private async disconnectFrontend(clientId: string): Promise<void> {
    if (!this.uiServerId) return;
    try {
      await this.request(request(this.id, this.uiServerId, 'disconnectFrontendClient', { clientId }));
    } catch {
      await this.reject('Could not disconnect that frontend.');
    }
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.identityId = await this.discoverDep('Identity') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    this.peerDiscoveryId = await this.discoverDep('PeerDiscovery') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.remoteUIAccessId = await this.discoverDep('RemoteUIAccess') ?? undefined;

    // Their events are subscribed while the window is open (show/hide).
  }

  /**
   * Registry, frontend and gateway events only matter while the window is
   * open: show subscribes, hide unsubscribes, so a closed window costs the
   * network nothing.
   */
  private async listenToNetwork(on: boolean): Promise<void> {
    const method = on ? 'addDependent' : 'removeDependent';
    for (const id of [this.peerRegistryId, this.uiServerId, this.remoteUIAccessId, this.webGatewayId]) {
      if (!id) continue;
      try { await this.request(request(this.id, id, method, {})); } catch { /* best effort */ }
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    // Minimized, the window only remembers that its tab is due; restored, it
    // catches up once.
    this.on('windowMinimized', async (msg: AbjectMessage) => {
      if ((msg.payload as { windowId?: AbjectId } | undefined)?.windowId !== this.windowId || !this.windowId) return;
      this.minimized = true;
      this.cancelTimer(this.flushTimer);
      this.flushTimer = undefined;
    });
    this.on('windowRestored', async (msg: AbjectMessage) => {
      if ((msg.payload as { windowId?: AbjectId } | undefined)?.windowId !== this.windowId || !this.minimized) return;
      this.minimized = false;
      await this.flush();
    });

    this.on('windowResized', async (msg: AbjectMessage) => {
      const { windowId, width, height } = msg.payload as { windowId?: AbjectId; width: number; height: number };
      if (!this.windowId || (windowId && windowId !== this.windowId)) return;
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        this.winSize = { width, height };
        if (this.sigilShown) await this.syncPeerSigil(true);
      }
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // Tab bar change — show/hide tab content
      if (fromId === this.tabBarId && aspect === 'change') {
        await this.selectTab(parseInt(value as string));
        return;
      }

      // Map: a click selects (the strip names it, the contacts list follows);
      // a double-click also brings it close (the widget's focus).
      if (fromId === this.mapGraphId && (aspect === 'nodeSelected' || aspect === 'nodeFocused')) {
        try {
          const id = (JSON.parse(value as string) as { id?: string }).id;
          if (id) await this.selectOnMap(id, 'map');
        } catch { /* malformed payload */ }
        return;
      }
      if (fromId === this.mapActionBtnId && aspect === 'click') {
        await this.runMapAction();
        return;
      }
      if (fromId === this.mapShowBtnId && aspect === 'click') {
        const info = this.mapSelectedId ? this.mapInfo.get(this.mapSelectedId) : undefined;
        if (info) await this.selectTab(info.tab, true);
        return;
      }
      // Contacts list selection: the map selects the same contact.
      if (fromId === this.contactListId && aspect === 'selectionChanged') {
        try {
          const peerId = (JSON.parse(value as string) as { value?: string }).value;
          if (peerId) await this.selectOnMap(`peer:${peerId}`, 'list');
        } catch { /* malformed payload */ }
        return;
      }

      // Signaling server remove buttons
      // Web Access tab — toggle the HTTP gateway
      if (fromId === this.webToggleBtnId && aspect === 'click') {
        if (this.webGatewayId) {
          const next = !this.webGatewayEnabled;
          try {
            const status = await this.request<Partial<GatewayStatus> | undefined>(
              request(this.id, this.webGatewayId, 'setEnabled', { enabled: next })
            );
            this.webGatewayEnabled = next;
            if (!next) await this.setStatus('Web gateway is off.');
            else if (status && status.listening === false) await this.reject('Gateway enabled, but its listener could not start. Try another port.');
            else await this.acknowledge('Web gateway is on.', this.liveColor());
          } catch {
            await this.reject('Could not change the web gateway.');
          }
        }
        await this.refreshWebAccessTab();
        return;
      }

      // Web Access tab — apply the gateway port (empty = automatic)
      if (fromId === this.webPortApplyBtnId && aspect === 'click') {
        if (this.webGatewayId && this.webPortInputId) {
          try {
            const raw = ((await this.request<string>(request(this.id, this.webPortInputId, 'getValue', {}))) ?? '').trim();
            const port = raw.length === 0 ? 0 : Number(raw);
            if (raw.length === 0 || (Number.isInteger(port) && port >= 0 && port <= 65535)) {
              await this.request(request(this.id, this.webGatewayId, 'setPort', { port }));
              // Applied: the field empties again, ready for the next change.
              await this.request(request(this.id, this.webPortInputId, 'update', { text: '' })).catch(() => { /* gone */ });
              await this.acknowledge(raw.length === 0 ? 'Port set to automatic.' : `Port ${port} applied.`);
            } else {
              // Keep the typed value in place so it can be corrected.
              await this.reject('Enter a port from 0 to 65535, or leave it empty for automatic.');
              return;
            }
          } catch {
            await this.reject('Could not apply the port.');
          }
        }
        await this.refreshWebAccessTab();
        return;
      }

      // Web Access tab — mint an API token (secret shown once)
      if (fromId === this.webMintBtnId && aspect === 'click') {
        if (this.webGatewayId) {
          try {
            const minted = await this.request<{ id: string; name: string; token?: string; secret?: string }>(
              request(this.id, this.webGatewayId, 'mintToken', { name: 'token' })
            );
            await this.updateWebAccessData();
            // The gateway answers with the plaintext as `token`.
            await this.updateIfChanged(this.webTokenResultId, {
              text: `Token secret (shown once): ${minted.token ?? minted.secret ?? ''}`,
            });
            this.windowEffect('flash');
          } catch {
            await this.reject('Could not create a token.');
          }
        }
        return;
      }

      // Row buttons (servers, signaling peers, network and blocked peers,
      // introductions, frontends): the row's operation for the row's subject.
      const rowAction = aspect === 'click' ? this.rowActions.get(fromId) : undefined;
      if (rowAction) {
        await this.runRowAction(rowAction);
        return;
      }

      // Identity section
      if (fromId === this.saveNameBtnId && aspect === 'click') {
        await this.saveName();
        return;
      }

      if (fromId === this.copyPeerIdBtnId && aspect === 'click') {
        await this.copyPeerId();
        return;
      }

      if (fromId === this.copyIdentityBtnId && aspect === 'click') {
        await this.copyIdentityJson();
        return;
      }

      // Signaling section
      if (fromId === this.signalingConnectBtnId && aspect === 'click') {
        await this.connectSignaling();
        return;
      }
      if (fromId === this.fixedSignalingCheckboxId && aspect === 'change') {
        await this.setFixedSignaling(value === true || value === 'true');
        return;
      }

      // Who Can Connect
      if (fromId === this.admissionCheckboxId && aspect === 'change') {
        await this.setAdmissionMode(value === true || value === 'true' ? 'allowlist' : 'open');
        return;
      }
      if (fromId === this.allowAddBtnId && aspect === 'click') {
        const peerId = this.allowInputId
          ? await this.request<string>(request(this.id, this.allowInputId, 'getValue', {}))
          : '';
        if (await this.allowPeer(peerId ?? '') && this.allowInputId) {
          await this.request(request(this.id, this.allowInputId, 'update', { text: '' }));
        }
        return;
      }

      // Contacts section
      if (fromId === this.addContactBtnId && aspect === 'click') {
        await this.addContact();
        return;
      }

      // Inline contact actions on the rich contacts list
      if (fromId === this.contactListId && aspect === 'action') {
        try {
          const data = JSON.parse(value as string) as { value: string; actionId: string };
          const peerId = data.value;
          if (data.actionId === 'connect') await this.toggleConnection(peerId);
          else if (data.actionId === 'introduce') await this.introduceContact(peerId);
          else if (data.actionId === 'remove') await this.removeContact(peerId);
          else if (data.actionId === 'block') await this.blockPeer(peerId);
        } catch { /* malformed payload */ }
        return;
      }

      // Frontends tab — toggle remote UI access
      if (fromId === this.remoteEnableCheckboxId && aspect === 'change') {
        if (this.remoteUIAccessId) {
          try {
            await this.request(request(this.id, this.remoteUIAccessId, 'setEnabled', { enabled: !!value }));
          } catch {
            await this.reject('Could not change remote UI access.');
          }
        }
        return;
      }

      // Frontends tab — Generate Pairing QR
      if (fromId === this.remoteGenerateBtnId && aspect === 'click') {
        if (this.remoteUIAccessId) {
          try {
            const result = await this.request<{ qrUrl: string; qrDataUrl: string; expires?: number }>(
              request(this.id, this.remoteUIAccessId, 'generatePairingToken', {})
            );
            this.lastQrDataUrl = result.qrDataUrl;
            this.lastQrUrl = result.qrUrl;
            this.lastQrExpires = result.expires;
            if (this.remoteQrImageId) {
              await this.request(request(this.id, this.remoteQrImageId, 'update', { url: result.qrDataUrl, alt: '' }));
            }
            await this.showPairingLink();
            await this.acknowledge('Pairing QR ready. Scan it, or copy the link and open it on your device.');
          } catch {
            await this.reject('Could not generate a pairing QR. Enable remote UI first.');
          }
        }
        return;
      }

      // Frontends tab — Copy the pairing link
      if (fromId === this.remoteCopyLinkBtnId && aspect === 'click') {
        await this.copyPairingLink();
        return;
      }

      // PeerRegistry events: the handshake watch reacts at once; the tabs
      // the event touches are marked due (the visible one catches up after
      // the burst settles).
      const eventData = fromId === this.peerRegistryId ? REGISTRY_EVENT_DATA.get(aspect) : undefined;
      if (eventData) {
        const eventPeerId = (value as { peerId?: string } | undefined)?.peerId;
        if (aspect === 'contactConnected') {
          const watched = eventPeerId !== undefined && eventPeerId === this.handshakeKey;
          if (watched) await this.endHandshake();
          // A contact came online: the window lights up (a flapping link
          // flashes at most once every few seconds).
          const now = Date.now();
          if (watched || now - this.lastConnectFlashAt > 3000) {
            this.lastConnectFlashAt = now;
            this.windowEffect('flash');
          }
          if (watched) await this.setStatus('Connected.', this.liveColor());
        } else if (aspect === 'contactDisconnected' && eventPeerId !== undefined && eventPeerId === this.handshakeKey) {
          // The handshake this window started closed before it opened.
          await this.endHandshake();
          await this.reject('Could not connect to that peer. They may be offline.');
        }
        // (The map redraws in its pass; a link that came alive pulses there.)
        this.markStale(eventData);
        return;
      }

      // UIServer / RemoteUIAccess events: the Frontends tab and the map.
      if ((fromId === this.uiServerId && aspect === 'frontendClientsChanged') ||
          (fromId === this.remoteUIAccessId && aspect === 'clientsChanged')) {
        this.markStale(['frontends']);
        return;
      }

      // The web gateway changed (on, off, port, routes, tokens).
      if (fromId === this.webGatewayId && aspect === 'gatewayChanged') {
        this.markStale(['web']);
        return;
      }
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;

    // Get display dimensions
    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    // Wide enough for seven tabs (the Map tab included) at the old tab width.
    const winW = 720;
    const winH = 700;
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    // Create window
    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Peer Network',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
      })
    );
    this.winSize = { width: winW, height: winH };
    this.selectedTab = 0;
    this.sigilShown = false;
    this.streamOn = false;

    // Create root VBox layout (non-scrollable — tabs handle their own scrolling)
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 0,
      })
    );

    // Tab bar
    const { widgetIds: [_tabBarId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'tabBar', windowId: this.windowId, tabs: ['Identity', 'Contacts', 'Servers & Peers', 'Introductions', 'Frontends', 'Web Access', 'Map'], selectedIndex: 0 },
      ] })
    );
    this.tabBarId = _tabBarId;
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: TAB_BAR_H },
    }));

    // Create 6 tab content ScrollableVBoxes; each stacks section cards,
    // which size to their content and scroll when a tab overflows.
    this.tabContents = [];
    for (let i = 0; i < 6; i++) {
      const tabVBox = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId!, 'createScrollableVBox', {
          windowId: this.windowId,
          margins: { top: TAB_MARGIN, right: TAB_MARGIN, bottom: TAB_MARGIN, left: TAB_MARGIN },
          spacing: 8,
        })
      );
      await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
        widgetId: tabVBox,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
      if (i > 0) await this.setShown(tabVBox, false);
      this.tabContents.push(tabVBox);
    }

    // The Map tab (index MAP_TAB): the same network as a 3D graph. A plain
    // VBox (the graph fills it; it never scrolls), built once per window.
    const mapTabId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createDetachedVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: TAB_MARGIN, bottom: 8, left: TAB_MARGIN },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: mapTabId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    await this.setShown(mapTabId, false);
    this.tabContents.push(mapTabId);
    await this.buildMapTab(mapTabId);

    // Status line under the tabs. Actions on every tab report here, so it
    // lives outside the tabs and stays visible whichever tab is selected.
    const statusRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 20, bottom: 10, left: 20 },
        spacing: 0,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: statusRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));
    const { widgetIds: [_statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId!, text: '', style: { color: this.theme.textDescription, fontSize: 12, align: 'right', selectable: true } },
      ] })
    );
    this.statusLabelId = _statusLabelId;
    await this.request(request(this.id, statusRowId, 'addLayoutChild', {
      widgetId: this.statusLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));

    await this.listenToNetwork(true);

    // Each tab is built the first time it shows; the Identity tab now.
    this.minimized = false;
    this.fullDue = true;
    this.refreshDue = true;
    await this.flush();

    this.changed('visibility', true);
    return true;
  }

  // ========== TAB 0: IDENTITY ==========

  /** Display name (the field is only rewritten when the identity's name changes) and the peer id. */
  private async syncIdentityTab(reads: NetReads): Promise<void> {
    const { peerId, name } = await reads.identity();
    const truncatedPeerId = peerId ? `${peerId.slice(0, 16)}...${peerId.slice(-8)}` : '(not initialized)';
    if (!this.builtTabs.has(IDENTITY_TAB)) {
      this.builtTabs.add(IDENTITY_TAB);
      await this.buildIdentityTab(this.tabContents[IDENTITY_TAB], name, `Peer ID: ${truncatedPeerId}`);
    } else if (name !== this.shownPeerName && this.nameInputId) {
      this.shownPeerName = name;
      await this.request(request(this.id, this.nameInputId, 'update', { text: name })).catch(() => { /* gone */ });
    }
    await this.updateIfChanged(this.peerIdLabelId, { text: `Peer ID: ${truncatedPeerId}` });
    await this.notePeersLive(reads);
  }

  private async buildIdentityTab(tab0: AbjectId, peerName: string, peerIdText: string): Promise<void> {
    // ── 1 · Display Name (card) ──
    const nameCard = await this.sectionCard(tab0, '1 · Display Name',
      'The name other peers see when you connect.');

    // Name input + Save button row
    const nameRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: nameCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, nameCard, 'addLayoutChild', {
      widgetId: nameRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: name input + save button
    const { widgetIds: [_nameInputId, _saveNameBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Enter display name', text: peerName },
        { type: 'button', windowId: this.windowId, text: 'Save', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.nameInputId = _nameInputId;
    this.saveNameBtnId = _saveNameBtnId;
    this.shownPeerName = peerName;
    await this.request(request(this.id, this.nameInputId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.nameInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.saveNameBtnId, 'addDependent', {}));
    await this.request(request(this.id, nameRowId, 'addLayoutChild', {
      widgetId: this.saveNameBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 70, height: 32 },
    }));

    // ── 2 · Your Identity (card): peer id plus the copy actions ──
    const identityCard = await this.sectionCard(tab0, '2 · Your Identity',
      'Share your identity JSON with someone so they can add you as a contact.');

    this.peerIdLabelId = await this.addWidget(identityCard,
      { type: 'label', windowId: this.windowId, text: peerIdText, style: { color: this.theme.textMeta, fontSize: 12, selectable: true } }, 18);
    this.lastSent.set(this.peerIdLabelId, JSON.stringify({ text: peerIdText }));

    // Copy buttons row
    const copyRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: identityCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, identityCard, 'addLayoutChild', {
      widgetId: copyRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    // Batch: copy peer ID + copy identity buttons
    const { widgetIds: [_copyPeerIdBtnId, _copyIdentityBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Copy Peer ID' },
        { type: 'button', windowId: this.windowId, text: 'Copy Identity JSON' },
      ] })
    );
    this.copyPeerIdBtnId = _copyPeerIdBtnId;
    this.copyIdentityBtnId = _copyIdentityBtnId;
    await this.request(request(this.id, this.copyPeerIdBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyPeerIdBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 130, height: 30 },
    }));
    await this.request(request(this.id, this.copyIdentityBtnId, 'addDependent', {}));
    await this.request(request(this.id, copyRowId, 'addLayoutChild', {
      widgetId: this.copyIdentityBtnId,
      sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
      preferredSize: { width: 160, height: 30 },
    }));

    // (The status line lives under the tabs; see show().)
  }

  // ========== TAB 1: CONTACTS ==========

  /**
   * The add-contact field (built once; what was typed survives network
   * events) and the contacts list, updated in place with its items. The
   * contacts card itself is replaced only when it flips between empty and
   * listing.
   */
  private async syncContactsTab(reads: NetReads): Promise<void> {
    const tab1 = this.tabContents[CONTACTS_TAB];
    if (!this.builtTabs.has(CONTACTS_TAB)) {
      this.builtTabs.add(CONTACTS_TAB);
      await this.buildAddContactCard(tab1);
    }
    const contacts = await reads.contacts();
    // Contacts as a single rich list: state badge + inline actions per row.
    const items = contacts.map((contact) => {
      const isConnected = contact.state === 'connected';
      const stateColor = contact.state === 'connected' ? this.liveColor()
        : contact.state === 'connecting' ? this.theme.statusWarning
        : this.theme.textMeta;
      const actions: Array<{ id: string; label: string; color?: string; textColor?: string }> = [
        { id: 'connect', label: isConnected ? 'Disconnect' : 'Connect' },
      ];
      if (isConnected) {
        actions.push({ id: 'introduce', label: 'Introduce' });
      }
      actions.push(
        { id: 'remove', label: 'Remove', color: this.theme.destructiveBg, textColor: this.theme.destructiveText },
        { id: 'block', label: 'Block', color: this.theme.destructiveBg, textColor: this.theme.destructiveText },
      );
      return {
        label: contact.name || contact.peerId.slice(0, 12) + '...',
        value: contact.peerId,
        detail: contact.peerId.slice(0, 24),
        badge: { text: contact.state, color: stateColor },
        actions,
      };
    });
    // The contact selected on the map stays selected here.
    const selectedIndex = contacts.findIndex((c) => `peer:${c.peerId}` === this.mapSelectedId);
    const kind = contacts.length > 0 ? 'list' : 'empty';
    if (this.contactsCard?.kind !== kind) {
      await this.buildContactsCard(tab1, kind, items, selectedIndex);
    } else if (kind === 'list' && this.contactListId) {
      const sig = JSON.stringify([items, selectedIndex]);
      if (sig !== this.contactListSig) {
        this.contactListSig = sig;
        await this.request(request(this.id, this.contactListId, 'update', { items, selectedIndex }))
          .catch(() => { this.contactListSig = undefined; });
      }
    }
    this.contactListPeers = contacts.map((c) => c.peerId);
  }

  private async buildAddContactCard(tab1: AbjectId): Promise<void> {
    // ── Add a Contact (card) ──
    const addCard = await this.sectionCard(tab1, 'Add a Contact',
      "Paste a peer's identity JSON (they copy it from their Identity tab).");

    // Add contact input + button row
    const addRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: addCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, addCard, 'addLayoutChild', {
      widgetId: addRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: add contact input + add button
    const { widgetIds: [_addContactInputId, _addContactBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Paste identity JSON' },
        { type: 'button', windowId: this.windowId, text: 'Add', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.addContactInputId = _addContactInputId;
    this.addContactBtnId = _addContactBtnId;
    await this.request(request(this.id, this.addContactInputId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.addContactBtnId, 'addDependent', {}));
    await this.request(request(this.id, addRowId, 'addLayoutChild', {
      widgetId: this.addContactBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 32 },
    }));
  }

  /**
   * The Contacts card: with contacts it fills the rest of the tab so the
   * list stretches; the empty state sizes to its content. Replaces the card
   * it had (the last card of the tab, so it goes back in the same place).
   */
  private async buildContactsCard(tab1: AbjectId, kind: 'empty' | 'list', items: unknown[], selectedIndex: number): Promise<void> {
    if (this.contactsCard) {
      const [cardId, ...parts] = this.contactsCard.ids;
      this.contactsCard = undefined;
      this.contactListId = undefined;
      this.contactListSig = undefined;
      await this.request(request(this.id, tab1, 'removeLayoutChild', { widgetId: cardId })).catch(() => { /* gone */ });
      this.destroyWidgets([...parts, cardId]);
    }
    const { sectionId, titleId, hintId } = await this.sectionCardParts(tab1, 'Contacts',
      'Connect, introduce, or remove each contact from its row.', 18, kind === 'list');
    const ids = [sectionId, titleId, ...(hintId ? [hintId] : [])];
    if (kind === 'empty') {
      const empty = this.emptySpec('No contacts yet', 'Paste a peer\'s identity JSON above, or trust a peer from the Servers & Peers tab.');
      ids.push(await this.addWidget(sectionId, empty.spec, empty.height));
    } else {
      const { widgetIds: [contactListId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'list', windowId: this.windowId, items, ...(selectedIndex >= 0 ? { selectedIndex } : {}) },
        ] })
      );
      this.contactListId = contactListId;
      this.contactListSig = JSON.stringify([items, selectedIndex]);
      await this.request(request(this.id, contactListId, 'addDependent', {}));
      await this.request(request(this.id, sectionId, 'addLayoutChild', {
        widgetId: contactListId,
        sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
      }));
      ids.push(contactListId);
    }
    this.contactsCard = { kind, ids };
  }

  // ========== TAB 2: SERVERS & PEERS ==========

  /**
   * Four cards in a fixed order (servers, peers seen on them, live network
   * peers, blocked peers) whose rows come and go by key. The peers card and
   * the blocked card hide while they have nothing to list.
   */
  private async syncServersTab(reads: NetReads): Promise<void> {
    if (!this.builtTabs.has(SERVERS_TAB)) {
      this.builtTabs.add(SERVERS_TAB);
      await this.buildServersTab(this.tabContents[SERVERS_TAB]);
    }
    const [servers, signalingPeers, contacts, networkPeers, discovery, blocked, policy] = await Promise.all([
      reads.servers(), reads.signalingPeers(), reads.contacts(), reads.networkPeers(), reads.discovery(), reads.blocked(),
      reads.policy(),
    ]);
    const windowId = this.windowId;
    const { signaling, admission } = policy;
    const allowlist = admission.mode === 'allowlist';
    const admitted = new Set([...admission.peers, ...admission.pinnedPeers]);

    // Fixed signaling: the toggle (locked while the environment pins it).
    await this.updateIfChanged(this.fixedSignalingCheckboxId, { checked: signaling.fixed, disabled: signaling.pinned });
    await this.setShown(this.sigPinnedNoteId, signaling.pinned);

    // Signaling servers: url and status per row; a status change recolours in place.
    await this.setShown(this.sigEmptyId, servers.length === 0);
    await this.syncRows('servers', this.sigCardId!, uniqueKeys(servers.map(({ url, status }) => {
      const urlColor = status === 'connected' ? this.liveColor()
        : status === 'connecting' ? this.theme.statusWarning
        : this.theme.statusError;
      const statusText = status === 'connected' ? 'connected'
        : status === 'connecting' ? 'connecting...'
        : 'offline';
      // A server pinned by the environment cannot be removed here.
      const removable = !(signaling.pinned && signaling.urls.includes(url));
      const cells: RowCell[] = [
        { spec: { type: 'label', windowId, text: url, style: { color: urlColor, fontSize: 12, selectable: true } }, height: 28 },
        { spec: { type: 'label', windowId, text: statusText, style: { color: urlColor, fontSize: 11, selectable: true } }, height: 28, width: 80 },
      ];
      if (removable) {
        cells.push({ spec: { type: 'button', windowId, text: 'Remove', style: { fontSize: 11 } }, height: 26, width: 70, action: { kind: 'removeServer' as const, key: url } });
      }
      return {
        key: url, sig: `${statusText}|${urlColor}`, height: 28,
        cells,
        updates: [{ style: { color: urlColor } }, { text: statusText, style: { color: urlColor } }, undefined],
      };
    })));

    // Peers visible on the signaling servers (a busy server churns these).
    await this.syncRows('signalingPeers', this.spCardId!, uniqueKeys(signalingPeers.map((sp) => {
      const displayName = sp.name || sp.peerId.slice(0, 12) + '...';
      // While only listed peers may connect, a peer seen here can be allowed in one step.
      const offerAllow = allowlist && !admitted.has(sp.peerId);
      const cells: RowCell[] = [
        { spec: { type: 'label', windowId, text: displayName, style: { color: this.theme.textDescription, fontSize: 12, selectable: true } }, height: 28 },
        { spec: { type: 'button', windowId, text: 'Add', style: this.rowPositiveStyle() }, height: 26, width: 60, action: { kind: 'addSignalingPeer' as const, key: sp.peerId, peer: sp } },
      ];
      if (offerAllow) {
        cells.push({ spec: { type: 'button', windowId, text: 'Allow', style: this.rowPositiveStyle() }, height: 26, width: 60, action: { kind: 'allowPeer' as const, key: sp.peerId } });
      }
      return {
        key: `${sp.serverUrl} ${sp.peerId}${offerAllow ? ' allow' : ''}`, sig: displayName, height: 28,
        cells,
        updates: [{ text: displayName }, undefined, undefined],
      };
    })));
    await this.setShown(this.spCardId, signalingPeers.length > 0);

    // Network peers: the mesh status, connected contacts (no Trust), then
    // the live network peers; or the card's empty state.
    const connectedContacts = contacts.filter((c) => c.state === 'connected');
    const hasNet = connectedContacts.length > 0 || networkPeers.length > 0 || discovery.cacheSize > 0;
    const hasSignaling = servers.some((s) => s.status === 'connected');
    const blockStyle = { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 };
    await this.setShown(this.netEmptyId, !hasNet);
    await this.setShown(this.netMeshId, hasNet);
    if (hasNet) {
      const meshStatus = `Mesh: ${connectedContacts.length + networkPeers.length} direct, ${discovery.cacheSize} discoverable${!hasSignaling && networkPeers.length > 0 ? ' | Relay active' : ''}`;
      await this.updateIfChanged(this.netMeshId, { text: meshStatus });
    }
    const netRows: RowSpec[] = [];
    for (const contact of connectedContacts) {
      const name = contact.name || contact.peerId.slice(0, 12) + '...';
      netRows.push({
        key: `c:${contact.peerId}`, sig: name, height: 30,
        cells: [
          { spec: { type: 'label', windowId, text: name, style: { color: this.theme.textDescription, fontSize: 12, selectable: true } }, height: 30 },
          { spec: { type: 'label', windowId, text: 'contact', style: { color: this.liveColor(), fontSize: 11, selectable: true } }, height: 30, width: 50 },
          { spec: { type: 'button', windowId, text: 'Block', style: blockStyle }, height: 28, width: 60, action: { kind: 'block', key: contact.peerId } },
        ],
        updates: [{ text: name }, undefined, undefined],
      });
    }
    for (const netPeer of networkPeers) {
      const name = netPeer.name || netPeer.peerId.slice(0, 12) + '...';
      const duration = this.formatDuration(Date.now() - netPeer.connectedAt);
      netRows.push({
        key: `n:${netPeer.peerId}`, sig: `${name}|${duration}`, height: 30,
        cells: [
          { spec: { type: 'label', windowId, text: name, style: { color: this.theme.textDescription, fontSize: 12, selectable: true } }, height: 30 },
          { spec: { type: 'label', windowId, text: duration, style: { color: this.liveColor(), fontSize: 11, selectable: true } }, height: 30, width: 50 },
          { spec: { type: 'button', windowId, text: 'Trust', style: this.rowPositiveStyle() }, height: 28, width: 60, action: { kind: 'trust', key: netPeer.peerId } },
          { spec: { type: 'button', windowId, text: 'Block', style: blockStyle }, height: 28, width: 60, action: { kind: 'block', key: netPeer.peerId } },
        ],
        updates: [{ text: name }, { text: duration }, undefined, undefined],
      });
    }
    await this.syncRows('network', this.netCardId!, uniqueKeys(netRows));

    // Who Can Connect: the mode toggle and the allowed peers (pinned ones
    // cannot be removed here). Names come from contacts where known.
    await this.updateIfChanged(this.admissionCheckboxId, { checked: allowlist, disabled: admission.pinned });
    await this.setShown(this.admissionPinnedNoteId, admission.pinned);
    const nameOf = (peerId: string) => contacts.find((c) => c.peerId === peerId)?.name || peerId.slice(0, 16) + '...';
    const allowedRows: RowSpec[] = [
      ...admission.pinnedPeers.map((peerId) => ({
        key: `pinned ${peerId}`, sig: nameOf(peerId), height: 28,
        cells: [
          { spec: { type: 'label', windowId, text: nameOf(peerId), style: { color: this.theme.textDescription, fontSize: 12, selectable: true } }, height: 28 },
          { spec: { type: 'label', windowId, text: 'pinned', style: { color: this.theme.textMeta, fontSize: 11 } }, height: 28, width: 70 },
        ],
        updates: [{ text: nameOf(peerId) }, undefined],
      })),
      ...admission.peers.filter((peerId) => !admission.pinnedPeers.includes(peerId)).map((peerId) => ({
        key: peerId, sig: nameOf(peerId), height: 28,
        cells: [
          { spec: { type: 'label', windowId, text: nameOf(peerId), style: { color: this.theme.textDescription, fontSize: 12, selectable: true } }, height: 28 },
          { spec: { type: 'button', windowId, text: 'Remove', style: { fontSize: 11 } }, height: 26, width: 70, action: { kind: 'disallowPeer' as const, key: peerId } },
        ],
        updates: [{ text: nameOf(peerId) }, undefined],
      })),
    ];
    await this.syncRows('allowed', this.admissionCardId!, uniqueKeys(allowedRows));

    // Blocked peers.
    await this.syncRows('blocked', this.blockedCardId!, uniqueKeys(blocked.map((bPeerId) => ({
      key: bPeerId, sig: '', height: 28,
      cells: [
        { spec: { type: 'label', windowId, text: bPeerId.slice(0, 16) + '...', style: { color: this.theme.textMeta, fontSize: 12, selectable: true } }, height: 28 },
        { spec: { type: 'button', windowId, text: 'Unblock', style: this.rowPositiveStyle() }, height: 26, width: 70, action: { kind: 'unblock' as const, key: bPeerId } },
      ],
      updates: [],
    }))));
    await this.setShown(this.blockedCardId, blocked.length > 0);

    await this.notePeersLive(reads);
  }

  private async buildServersTab(tab2: AbjectId): Promise<void> {
    // ── Signaling Servers (card): add a server, then its list ──
    const sigCard = await this.sectionCard(tab2, 'Signaling Servers',
      'A signaling server introduces peers to each other so they can connect directly.');
    this.sigCardId = sigCard;

    // Signaling URL input + Connect button row
    const sigRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: sigCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, sigCard, 'addLayoutChild', {
      widgetId: sigRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));

    // Batch: signaling input + connect button
    const { widgetIds: [_signalingInputId, _signalingConnectBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'wss://signal.abject.world' },
        { type: 'button', windowId: this.windowId, text: 'Connect', style: this.positiveButtonStyle() },
      ] })
    );
    this.signalingInputId = _signalingInputId;
    this.signalingConnectBtnId = _signalingConnectBtnId;
    await this.request(request(this.id, this.signalingInputId, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, 'addLayoutChild', {
      widgetId: this.signalingInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.signalingConnectBtnId, 'addDependent', {}));
    await this.request(request(this.id, sigRowId, 'addLayoutChild', {
      widgetId: this.signalingConnectBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 80, height: 32 },
    }));
    this.fixedSignalingCheckboxId = await this.addWidget(sigCard,
      { type: 'checkbox', windowId: this.windowId, checked: false,
        text: 'Use only these servers (ignore servers learned from peers and contacts)' }, 26);
    await this.request(request(this.id, this.fixedSignalingCheckboxId, 'addDependent', {}));
    this.sigPinnedNoteId = await this.addWidget(sigCard,
      { type: 'label', windowId: this.windowId, text: 'Fixed by ABJECTS_SIGNALING_URLS when this instance was started.',
        style: { color: this.theme.textMeta, fontSize: 11 } }, 18);
    await this.setShown(this.sigPinnedNoteId, false);
    const sigEmpty = this.emptySpec('No signaling servers', 'Enter a server URL above and press Connect to find peers on the network.');
    this.sigEmptyId = await this.addWidget(sigCard, sigEmpty.spec, sigEmpty.height);

    // ── Signaling Peers (card), shown while it lists someone ──
    this.spCardId = await this.sectionCard(tab2, 'Signaling Peers',
      'Peers visible on your signaling servers. Add one to make it a contact.');

    // ── Network Peers (card): the mesh status and each live peer, or its
    //    empty state ──
    this.netCardId = await this.sectionCard(tab2, 'Network Peers',
      'Peers connected to you right now. Trust one to make it a contact.');
    this.netMeshId = await this.addWidget(this.netCardId,
      { type: 'label', windowId: this.windowId, text: '', style: livingStyle(this.theme, 11) }, 18);
    const netEmpty = this.emptySpec('No peers connected', 'Peers appear here once you connect to a signaling server or a contact comes online.');
    this.netEmptyId = await this.addWidget(this.netCardId, netEmpty.spec, netEmpty.height);

    // ── Who Can Connect (card): the allowlist toggle, an add row, then the
    //    allowed peers ──
    this.admissionCardId = await this.sectionCard(tab2, 'Who Can Connect',
      'Any peer you find or that calls you can connect, unless you allow only listed peers. Blocked peers never can.', 34);
    this.admissionCheckboxId = await this.addWidget(this.admissionCardId,
      { type: 'checkbox', windowId: this.windowId, checked: false, text: 'Allow only the peers listed below' }, 26);
    await this.request(request(this.id, this.admissionCheckboxId, 'addDependent', {}));
    this.admissionPinnedNoteId = await this.addWidget(this.admissionCardId,
      { type: 'label', windowId: this.windowId, text: 'Fixed by ABJECTS_PEER_ADMISSION when this instance was started.',
        style: { color: this.theme.textMeta, fontSize: 11 } }, 18);
    await this.setShown(this.admissionPinnedNoteId, false);
    const allowRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.admissionCardId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.admissionCardId, 'addLayoutChild', {
      widgetId: allowRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    this.allowInputId = await this.addWidget(allowRowId,
      { type: 'textInput', windowId: this.windowId, placeholder: 'Peer ID (64 hex characters)' }, 32);
    this.allowAddBtnId = await this.addWidget(allowRowId,
      { type: 'button', windowId: this.windowId, text: 'Allow', style: this.positiveButtonStyle() }, 32, 80);
    await this.request(request(this.id, this.allowAddBtnId, 'addDependent', {}));

    // ── Blocked Peers (card), shown while it lists someone ──
    this.blockedCardId = await this.sectionCard(tab2, 'Blocked Peers',
      'Unblock a peer to let it connect to you again.');
  }

  // ========== TAB 3: INTRODUCTIONS ==========

  private async syncIntrosTab(reads: NetReads): Promise<void> {
    if (!this.builtTabs.has(INTROS_TAB)) {
      this.builtTabs.add(INTROS_TAB);
      // ── Pending Introductions (card) ──
      this.introCardId = await this.sectionCard(this.tabContents[INTROS_TAB], 'Pending Introductions',
        'When a contact introduces you to someone they know, accept to add that peer as a contact.', 34);
      const empty = this.emptySpec('No pending introductions', 'Introductions from your connected contacts will wait here for your answer.');
      this.introEmptyId = await this.addWidget(this.introCardId, empty.spec, empty.height);
    }
    const [pendingIntros, contacts] = await Promise.all([reads.intros(), reads.contacts()]);
    const windowId = this.windowId;
    await this.setShown(this.introEmptyId, pendingIntros.length === 0);
    await this.syncRows('intros', this.introCardId!, uniqueKeys(pendingIntros.map((intro) => {
      const introName = intro.name || intro.peerId.slice(0, 12) + '...';
      const fromContact = contacts.find((c) => c.peerId === intro.fromPeerId);
      const fromName = fromContact?.name || intro.fromPeerId.slice(0, 12) + '...';
      const text = `${introName} (from ${fromName})`;
      return {
        key: intro.peerId, sig: text, height: 30,
        cells: [
          { spec: { type: 'label', windowId, text, style: { color: this.theme.textHeading, fontSize: 12, selectable: true } }, height: 30 },
          { spec: { type: 'button', windowId, text: 'Accept', style: this.rowPositiveStyle() }, height: 28, width: 65, action: { kind: 'acceptIntro' as const, key: intro.peerId } },
          { spec: { type: 'button', windowId, text: 'Reject', style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 } }, height: 28, width: 65, action: { kind: 'rejectIntro' as const, key: intro.peerId } },
        ],
        updates: [{ text }, undefined, undefined],
      };
    })));
  }

  // ========== TAB 4: FRONTENDS ==========

  /** Find UIServer and RemoteUIAccess if they were not ready at init, and listen to them. */
  private async ensureFrontendDeps(): Promise<void> {
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
      if (this.uiServerId) {
        try { await this.request(request(this.id, this.uiServerId, 'addDependent', {})); } catch { /* best effort */ }
      }
    }
    if (!this.remoteUIAccessId) {
      this.remoteUIAccessId = await this.discoverDep('RemoteUIAccess') ?? undefined;
      if (this.remoteUIAccessId) {
        try { await this.request(request(this.id, this.remoteUIAccessId, 'addDependent', {})); } catch { /* best effort */ }
      }
    }
  }

  /** The Frontends tab: pairing (built once), then one row per connected UI client (WS + WebRTC). */
  private async syncFrontendsTab(reads: NetReads): Promise<void> {
    await this.ensureFrontendDeps();
    const tab4 = this.tabContents[FRONTENDS_TAB];
    if (!this.builtTabs.has(FRONTENDS_TAB)) {
      this.builtTabs.add(FRONTENDS_TAB);
      // ── Pair a new frontend (QR generation) ──
      await this.buildPairingSection(tab4);
      // ── Connected Frontends (card) ──
      this.feCardId = await this.sectionCard(tab4, 'Connected Frontends',
        'Browsers and phones showing this desktop. Disconnect or revoke from each row.');
      const empty = this.emptySpec('No frontends connected', 'Browsers and paired phones showing this desktop appear here.');
      this.feEmptyId = await this.addWidget(this.feCardId, empty.spec, empty.height);
    } else {
      await this.refreshRemoteStatusLabel();
    }

    const clients = await reads.frontends();
    const windowId = this.windowId;
    const destructive = { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveText, fontSize: 11 };
    await this.setShown(this.feEmptyId, clients.length === 0);
    await this.syncRows('frontends', this.feCardId!, uniqueKeys(clients.map((c) => {
      const isWebRTC = c.kind === 'webrtc';
      const kindLabel = isWebRTC ? 'P2P' : 'WS';
      const displayName = c.name?.trim()
        || (c.peerId ? c.peerId.slice(0, 12) + '…' : '')
        || c.clientId;
      const text = `${kindLabel}  /  ${displayName}  /  ${formatRelative(Date.now() - c.connectedAt)}`;
      const cells: RowCell[] = [
        { spec: { type: 'label', windowId, text, style: { color: this.theme.textHeading, fontSize: 12, selectable: true } }, height: 30 },
        { spec: { type: 'button', windowId, text: 'Disconnect', style: destructive }, height: 28, width: 90, action: { kind: 'disconnectFrontend', key: c.clientId } },
      ];
      // Revoke a paired remote UI client (WebRTC only).
      if (isWebRTC) cells.push({ spec: { type: 'button', windowId, text: 'Revoke', style: destructive }, height: 28, width: 70, action: { kind: 'revokeFrontend', key: c.peerId } });
      return { key: `${c.kind} ${c.clientId}`, sig: text, height: 32, cells, updates: [{ text }] };
    })));
  }

  /**
   * Pair-a-new-frontend section: enable toggle, status, Generate QR button,
   * QR image, and selectable pairing URL. Mirrors the UX that previously
   * lived in GlobalSettings → Auth → Remote Access.
   */
  private async buildPairingSection(tab4: AbjectId): Promise<void> {
    // ── Pair a Frontend (card): every pairing widget goes in it ──
    const pairCard = await this.sectionCard(tab4, 'Pair a Frontend',
      'Open this desktop on your phone: enable remote UI, then scan the pairing QR code.');

    let status = { enabled: false, peerId: '', signalingUrl: '', deviceLabel: '', connectedCount: 0, authorizedCount: 0 };
    if (this.remoteUIAccessId) {
      try {
        status = await this.request<typeof status>(
          request(this.id, this.remoteUIAccessId, 'getStatus', {})
        );
      } catch { /* not ready */ }
    }

    // Enable checkbox
    const enableRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: pairCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: enableRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    const { widgetIds: [enableCheckboxId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'checkbox', windowId: this.windowId,
          checked: status.enabled,
          text: 'Enable remote UI (phone access via WebRTC)' },
      ] })
    );
    this.remoteEnableCheckboxId = enableCheckboxId;
    await this.request(request(this.id, this.remoteEnableCheckboxId, 'addDependent', {}));
    await this.request(request(this.id, enableRowId, 'addLayoutChild', {
      widgetId: this.remoteEnableCheckboxId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 28 },
    }));

    // Status label
    const { widgetIds: [statusLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId,
          text: formatRemoteStatus(status),
          style: this.remoteStatusStyle(status.enabled) },
      ] })
    );
    this.remoteStatusLabelId = statusLabelId;
    this.lastSent.set(statusLabelId, JSON.stringify({ text: formatRemoteStatus(status), style: this.remoteStatusStyle(status.enabled) }));
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: this.remoteStatusLabelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 18 },
    }));

    // Generate QR button
    const generateRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: pairCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: generateRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    const { widgetIds: [generateBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'Generate Pairing QR',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.remoteGenerateBtnId = generateBtnId;
    await this.request(request(this.id, this.remoteGenerateBtnId, 'addDependent', {}));
    await this.request(request(this.id, generateRowId, 'addLayoutChild', {
      widgetId: this.remoteGenerateBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 200, height: 36 },
    }));
    await this.request(request(this.id, generateRowId, 'addLayoutSpacer', {}));

    // Pairing link: a caption (with expiry), then the link on one line in the
    // mono face at full contrast beside a Copy Link button. The link is the
    // same one the QR encodes, for devices that open it directly.
    const { widgetIds: [captionId, qrUrlLabelId, copyLinkBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: this.windowId, text: '',
          style: { color: this.theme.textSecondary, fontSize: 12, fontFamily: 'display', fontWeight: 'bold' } },
        { type: 'label', windowId: this.windowId, text: '',
          style: { color: this.theme.textPrimary, fontSize: 13, fontFamily: 'mono' } },
        { type: 'button', windowId: this.windowId, text: 'Copy Link',
          style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      ] })
    );
    this.remoteQrLinkCaptionId = captionId;
    this.remoteQrUrlLabelId = qrUrlLabelId;
    this.remoteCopyLinkBtnId = copyLinkBtnId;
    await this.request(request(this.id, copyLinkBtnId, 'addDependent', {}));
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: captionId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 18 },
    }));
    const linkRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: pairCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
        style: { background: this.theme.inputBg, borderColor: this.theme.inputBorder, borderWidth: 1, radius: this.theme.widgetRadius },
      })
    );
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: linkRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));
    await this.request(request(this.id, linkRowId, 'addLayoutChildren', { children: [
      { widgetId: qrUrlLabelId, sizePolicy: { horizontal: 'expanding', vertical: 'expanding' } },
      { widgetId: copyLinkBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 110, height: 36 } },
    ] }));
    // QR image
    const qrImageSpec: Record<string, unknown> = {
      type: 'image', windowId: this.windowId,
      alt: this.lastQrDataUrl ? '' : 'No QR generated yet',
      style: { background: this.theme.windowBg, color: this.theme.textTertiary, fontSize: 12, radius: this.theme.tokens.radius.sm },
    };
    if (this.lastQrDataUrl) qrImageSpec.url = this.lastQrDataUrl;
    const { widgetIds: [qrImageId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [qrImageSpec] })
    );
    this.remoteQrImageId = qrImageId;
    await this.request(request(this.id, pairCard, 'addLayoutChild', {
      widgetId: this.remoteQrImageId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 320, height: 320 },
    }));

    await this.showPairingLink();
  }

  /** Paint the pairing link row for the current link (or its absence). */
  private async showPairingLink(): Promise<void> {
    const url = this.lastQrUrl;
    const expired = this.lastQrExpires !== undefined && this.lastQrExpires <= Date.now();
    const caption = !url
      ? 'PAIRING LINK'
      : expired
        ? 'PAIRING LINK · EXPIRED, GENERATE A NEW ONE'
        : `PAIRING LINK · WORKS ONCE${this.lastQrExpires ? `, UNTIL ${new Date(this.lastQrExpires).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
    const text = url ? `  ${shortenLink(url)}` : '  Generate a pairing QR to get a link.';
    try {
      if (this.remoteQrLinkCaptionId) {
        await this.request(request(this.id, this.remoteQrLinkCaptionId, 'update', { text: caption }));
      }
      if (this.remoteQrUrlLabelId) {
        await this.request(request(this.id, this.remoteQrUrlLabelId, 'update', {
          text,
          style: { color: url && !expired ? this.theme.textPrimary : this.theme.textTertiary },
        }));
      }
      if (this.remoteCopyLinkBtnId) {
        await this.request(request(this.id, this.remoteCopyLinkBtnId, 'update', { style: { disabled: !url || expired } }));
      }
    } catch { /* window closed */ }
  }

  /** Copy the full pairing link (the label shows it shortened). */
  private async copyPairingLink(): Promise<void> {
    const url = this.lastQrUrl;
    if (!url) {
      await this.reject('Generate a pairing QR first.');
      return;
    }
    if (this.lastQrExpires !== undefined && this.lastQrExpires <= Date.now()) {
      await this.showPairingLink();
      await this.reject('That pairing link expired. Generate a new one.');
      return;
    }
    if (!this.clipboardId) {
      await this.reject('Clipboard not available.');
      return;
    }
    try {
      await this.request(request(this.id, this.clipboardId, 'write', { text: url }));
      await this.acknowledge('Pairing link copied. Open it on the device you want to pair.');
    } catch {
      await this.reject('Could not copy the pairing link.');
    }
  }

  /**
   * The Web Access tab's pass. Built once (with the gateway's cards, or a
   * note while the gateway is not running, replaced once it is); afterwards
   * its labels follow the gateway (its gatewayChanged events mark the tab due).
   */
  private async syncWebTab(): Promise<void> {
    if (!this.webGatewayId) {
      this.webGatewayId = await this.discoverDep('WebGateway') ?? undefined;
      if (this.webGatewayId) {
        try { await this.request(request(this.id, this.webGatewayId, 'addDependent', {})); } catch { /* best effort */ }
      }
    }
    const tab5 = this.tabContents[WEB_TAB];
    if (this.builtTabs.has(WEB_TAB) && (this.webBuiltWithGateway || !this.webGatewayId)) {
      await this.updateWebAccessData();
      return;
    }
    if (this.webUnavailableId) {
      // The gateway came up since the note was shown: the cards replace it.
      await this.request(request(this.id, tab5, 'removeLayoutChild', { widgetId: this.webUnavailableId })).catch(() => { /* gone */ });
      this.destroyWidgets([this.webUnavailableId]);
      this.webUnavailableId = undefined;
    }
    this.builtTabs.add(WEB_TAB);
    this.webBuiltWithGateway = this.webGatewayId !== undefined;
    await this.populateWebAccessTab(tab5);
  }

  /** Populate the Web Access tab — HTTP gateway status, toggle, routes, and API tokens. */
  private async populateWebAccessTab(tab5: AbjectId): Promise<void> {
    if (!this.webGatewayId) {
      const note = this.emptySpec('Web Gateway is not available', 'The HTTP gateway serves workspaces to browsers and scripts. It appears here once the gateway object is running.');
      this.webUnavailableId = await this.addWidget(tab5, note.spec, note.height);
      return;
    }

    // One card per topic, created in display order: the gateway itself, its
    // port, what it serves, and the tokens that open authenticated routes.
    const gatewayCard = await this.sectionCard(tab5, 'HTTP Gateway',
      'Serves whitelisted abjects to browsers and scripts over HTTP.');
    const portCard = await this.sectionCard(tab5, 'Port',
      'Leave it empty and the system finds a free port, or enter a port number.');
    const routesCard = await this.sectionCard(tab5, 'Routes',
      'Each workspace chooses what it exposes in its Settings, under the Web tab.');
    const tokensCard = await this.sectionCard(tab5, 'API Tokens',
      'Authenticated routes need one of these as a Bearer token. The secret is shown once at mint time.', 34);

    // Port input + Apply Port share one row.
    const portRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: portCard,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, portCard, 'addLayoutChild', {
      widgetId: portRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));

    const { widgetIds: [statusId, toggleBtnId, portInputId, portApplyId, routesId, mintBtnId, resultId, tokensListId] } =
      await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 12, wordWrap: true, selectable: true } },
          { type: 'button', windowId: this.windowId, text: 'Enable', style: this.positiveButtonStyle() },
          { type: 'textInput', windowId: this.windowId, placeholder: 'Automatic' },
          { type: 'button', windowId: this.windowId, text: 'Apply Port', style: this.positiveButtonStyle() },
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 12, wordWrap: true, selectable: true } },
          { type: 'button', windowId: this.windowId, text: 'Mint Token', style: this.positiveButtonStyle() },
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 12, wordWrap: true, selectable: true } },
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textDescription, fontSize: 12, wordWrap: true, selectable: true } },
        ] })
      );
    this.webAccessStatusId = statusId;
    this.webToggleBtnId = toggleBtnId;
    this.webPortInputId = portInputId;
    this.webPortApplyBtnId = portApplyId;
    this.webRoutesId = routesId;
    this.webMintBtnId = mintBtnId;
    this.webTokenResultId = resultId;
    this.webTokensId = tokensListId;

    // [card, widget, height, width]: a width makes the widget a fixed-size button.
    const layoutSpecs: Array<[AbjectId, AbjectId, number, number?]> = [
      [gatewayCard, statusId, 40], [gatewayCard, toggleBtnId, 30, 120],
      [routesCard, routesId, 60],
      [tokensCard, mintBtnId, 30, 120], [tokensCard, resultId, 32], [tokensCard, tokensListId, 80],
    ];
    for (const [cardId, widgetId, height, width] of layoutSpecs) {
      await this.request(request(this.id, cardId, 'addLayoutChild', {
        widgetId,
        sizePolicy: { vertical: 'fixed', horizontal: width !== undefined ? 'fixed' : 'expanding' },
        preferredSize: width !== undefined ? { width, height } : { height },
      }));
    }
    await this.request(request(this.id, portRowId, 'addLayoutChild', {
      widgetId: portInputId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 30 },
    }));
    await this.request(request(this.id, portRowId, 'addLayoutChild', {
      widgetId: portApplyId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: 110, height: 30 },
    }));
    await this.request(request(this.id, toggleBtnId, 'addDependent', {}));
    await this.request(request(this.id, mintBtnId, 'addDependent', {}));
    await this.request(request(this.id, portApplyId, 'addDependent', {}));

    await this.updateWebAccessData();
  }

  /** Refresh the Web Access tab data from the gateway. */
  private async updateWebAccessData(): Promise<void> {
    if (!this.webGatewayId || !this.windowId) return;
    try {
      const status = await this.request<GatewayStatus>(request(this.id, this.webGatewayId, 'getStatus', {}));
      this.webGatewayEnabled = !!status.enabled;
      const routes = await this.request<RouteInfo[]>(request(this.id, this.webGatewayId, 'getRoutes', {}));
      const tokens = await this.request<TokenInfo[]>(request(this.id, this.webGatewayId, 'listTokens', {}));
      // Each label changes only when its text does.
      await this.updateIfChanged(this.webAccessStatusId, {
        text: status.enabled
          ? `ON — ${status.baseUrl} (${status.routes} route(s) across ${status.workspaces} workspace(s))`
          : 'OFF — the HTTP listener is not running.',
        style: status.enabled
          ? { ...livingStyle(this.theme), wordWrap: true, selectable: true }
          : { color: this.theme.textMeta, fontSize: 12, wordWrap: true, selectable: true },
      });
      await this.updateIfChanged(this.webRoutesId, {
        text: routes.length
          ? routes.map(r => `${r.path} — ${r.abject} (${r.access})`).join('\n')
          : 'No routes yet. Enable serving on a workspace to expose it here.',
      });
      await this.updateIfChanged(this.webTokensId, {
        text: tokens.length
          ? tokens.map(t => `${t.name} — created ${new Date(t.createdAt).toISOString().slice(0, 10)} (${t.id.slice(0, 8)})`).join('\n')
          : 'No API tokens.',
      });
      await this.updateIfChanged(this.webToggleBtnId, { text: status.enabled ? 'Disable' : 'Enable' });
    } catch { /* gateway not ready */ }
  }

  /**
   * After a gateway action (toggle, port): the tab's labels read fresh and a
   * token secret shown earlier leaves (it is shown once).
   */
  private async refreshWebAccessTab(): Promise<void> {
    if (!this.windowId || !this.webGatewayId) return;
    await this.updateIfChanged(this.webTokenResultId, { text: '' });
    await this.updateWebAccessData();
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // The window counts as closed from here on: events, timers and a pass
    // still in flight see no window and stand down while it is destroyed.
    const windowId = this.windowId;
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.sigilShown = false;
    this.streamOn = false;
    this.cancelTimer(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.handshakeKey = undefined;
    this.winSize = undefined;
    this.tabContents = [];
    this.statusLabelId = undefined;
    this.nameInputId = undefined;
    this.saveNameBtnId = undefined;
    this.copyPeerIdBtnId = undefined;
    this.copyIdentityBtnId = undefined;
    this.signalingInputId = undefined;
    this.signalingConnectBtnId = undefined;
    this.addContactInputId = undefined;
    this.addContactBtnId = undefined;
    this.contactListId = undefined;
    this.contactsCard = undefined;
    this.contactListPeers = [];
    this.contactListSig = undefined;
    this.peerIdLabelId = undefined;
    this.shownPeerName = undefined;
    this.sigCardId = undefined;
    this.sigEmptyId = undefined;
    this.spCardId = undefined;
    this.netCardId = undefined;
    this.netMeshId = undefined;
    this.netEmptyId = undefined;
    this.blockedCardId = undefined;
    this.fixedSignalingCheckboxId = undefined;
    this.sigPinnedNoteId = undefined;
    this.admissionCardId = undefined;
    this.admissionCheckboxId = undefined;
    this.admissionPinnedNoteId = undefined;
    this.allowInputId = undefined;
    this.allowAddBtnId = undefined;
    this.introCardId = undefined;
    this.introEmptyId = undefined;
    this.feCardId = undefined;
    this.feEmptyId = undefined;
    // The window took every widget with it: forget the tabs, rows and what
    // they were last given, and any pass that was waiting.
    this.builtTabs.clear();
    this.rowSets.clear();
    this.rowActions.clear();
    this.lastSent.clear();
    this.shownState.clear();
    this.refreshDue = false;
    this.fullDue = false;
    this.staleData.clear();
    this.readCache.clear();
    this.cancelTimer(this.flushTimer);
    this.flushTimer = undefined;
    this.minimized = false;
    this.webBuiltWithGateway = false;
    this.webUnavailableId = undefined;
    this.webPortInputId = undefined;
    this.webPortApplyBtnId = undefined;
    this.webAccessStatusId = undefined;
    this.webToggleBtnId = undefined;
    this.webRoutesId = undefined;
    this.webMintBtnId = undefined;
    this.webTokenResultId = undefined;
    this.webTokensId = undefined;
    this.remoteEnableCheckboxId = undefined;
    this.remoteStatusLabelId = undefined;
    this.remoteGenerateBtnId = undefined;
    this.remoteQrImageId = undefined;
    this.remoteQrUrlLabelId = undefined;
    this.remoteQrLinkCaptionId = undefined;
    this.remoteCopyLinkBtnId = undefined;
    this.mapGraphId = undefined;
    this.mapDetailLabelId = undefined;
    this.mapActionBtnId = undefined;
    this.mapShowBtnId = undefined;
    this.mapSelectedId = undefined;
    this.mapNodeIds.clear();
    this.mapInfo.clear();
    this.mapLive = undefined;
    this.mapWidgetSelection = undefined;
    this.mapStripSig = undefined;

    await this.listenToNetwork(false);
    // Shown again while this one closed: the new window listens.
    if (this.windowId) await this.listenToNetwork(true);
    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId })
    );

    this.changed('visibility', false);
    return true;
  }

  // ========== HELPERS ==========

  private async refreshRemoteStatusLabel(): Promise<void> {
    if (!this.remoteStatusLabelId || !this.remoteUIAccessId) return;
    try {
      const status = await this.request<{ enabled: boolean; peerId: string; signalingUrl: string; connectedCount: number }>(
        request(this.id, this.remoteUIAccessId, 'getStatus', {})
      );
      await this.updateIfChanged(this.remoteStatusLabelId, {
        text: formatRemoteStatus(status),
        style: this.remoteStatusStyle(status.enabled),
      });
    } catch { /* best effort */ }
  }

  private async setStatus(text: string, color = this.theme.textDescription): Promise<void> {
    if (!this.statusLabelId) return;
    await this.request(
      request(this.id, this.statusLabelId, 'update', {
        text, style: { color },
      })
    );
  }

  // ========== IDENTITY ACTIONS ==========

  private async saveName(): Promise<void> {
    if (!this.windowId || !this.nameInputId || !this.identityId) return;

    const name = await this.request<string>(
      request(this.id, this.nameInputId, 'getValue', {})
    );

    if (!name || name.trim() === '') {
      await this.reject('Name cannot be empty.');
      return;
    }

    try {
      await this.request(
        request(this.id, this.identityId, 'setName', { name: name.trim() })
      );
    } catch {
      await this.reject('Could not save the name.');
      return;
    }
    // The field already says it; a later pass leaves the field alone.
    this.shownPeerName = name.trim();

    await this.acknowledge('Name saved!');
  }

  private async copyPeerId(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{ peerId: string }>(
        request(this.id, this.identityId, 'exportPublicKeys', {})
      );

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, 'write', { text: identity.peerId })
        );
        await this.setStatus('Peer ID copied!');
      } else {
        await this.reject('Clipboard not available.');
      }
    } catch {
      await this.reject('Failed to copy Peer ID.');
    }
  }

  private async copyIdentityJson(): Promise<void> {
    if (!this.identityId) return;

    try {
      const identity = await this.request<{
        peerId: string; publicSigningKey: string; publicExchangeKey: string; name: string;
      }>(
        request(this.id, this.identityId, 'exportPublicKeys', {})
      );

      const json = JSON.stringify({
        peerId: identity.peerId,
        publicSigningKey: identity.publicSigningKey,
        publicExchangeKey: identity.publicExchangeKey,
        name: identity.name,
      }, null, 2);

      if (this.clipboardId) {
        await this.request(
          request(this.id, this.clipboardId, 'write', { text: json })
        );
        await this.setStatus('Identity JSON copied!');
      } else {
        await this.reject('Clipboard not available.');
      }
    } catch {
      await this.reject('Failed to copy identity.');
    }
  }

  // ========== PEER NETWORK ACTIONS ==========

  private async removeSignalingServer(url: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Remove Server',
      message: `Remove signaling server "${url}"?`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeSignalingServer', { url })
      );
      await this.refresh();
      await this.setStatus('Removed signaling server.');
    } catch {
      await this.reject('Failed to remove server.');
    }
  }

  /** Fix signaling to the listed servers, or let peers and contacts add more. */
  private async setFixedSignaling(fixed: boolean): Promise<void> {
    if (!this.peerRegistryId) return;
    const result = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.peerRegistryId, 'setFixedSignaling', { fixed }),
    ).catch(() => ({ success: false, error: 'Could not change signaling.' }));
    if (!result.success) {
      await this.reject(result.error ?? 'Could not change signaling.');
      // The checkbox flipped itself; show the setting as it really is.
      if (this.fixedSignalingCheckboxId) this.lastSent.delete(this.fixedSignalingCheckboxId);
      await this.refresh();
      return;
    }
    await this.acknowledge(fixed ? 'Signaling uses only the listed servers.' : 'Signaling may use servers learned from peers.');
  }

  private async setAdmissionMode(mode: 'open' | 'allowlist'): Promise<void> {
    if (!this.peerRegistryId) return;
    const result = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.peerRegistryId, 'setPeerAdmission', { mode }),
    ).catch(() => ({ success: false, error: 'Could not change who can connect.' }));
    if (!result.success) {
      await this.reject(result.error ?? 'Could not change who can connect.');
      if (this.admissionCheckboxId) this.lastSent.delete(this.admissionCheckboxId);
      await this.refresh();
      return;
    }
    await this.acknowledge(mode === 'allowlist'
      ? 'Only listed peers can connect; others were disconnected.'
      : 'Any peer can connect.');
  }

  /** Add a peer to the allowed list. True when it was added. */
  private async allowPeer(peerId: string): Promise<boolean> {
    if (!this.peerRegistryId) return false;
    const id = peerId.trim();
    if (!id) {
      await this.reject('Enter a peer ID.');
      return false;
    }
    const result = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.peerRegistryId, 'allowPeer', { peerId: id }),
    ).catch(() => ({ success: false, error: 'Could not allow that peer.' }));
    if (!result.success) {
      await this.reject(result.error ?? 'Could not allow that peer.');
      return false;
    }
    await this.acknowledge('Peer allowed.');
    return true;
  }

  private async disallowPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;
    const result = await this.request<{ success: boolean; error?: string }>(
      request(this.id, this.peerRegistryId, 'disallowPeer', { peerId }),
    ).catch(() => ({ success: false, error: 'Could not remove that peer.' }));
    if (!result.success) await this.reject(result.error ?? 'Could not remove that peer.');
    else await this.acknowledge('Peer removed from the allowed list.');
  }

  private async connectSignaling(): Promise<void> {
    if (!this.signalingInputId || !this.peerRegistryId) return;

    const url = await this.request<string>(
      request(this.id, this.signalingInputId, 'getValue', {})
    );

    if (!url || url.trim() === '') {
      await this.reject('Enter a signaling server URL.');
      return;
    }

    // The eye watches while the server handshake is in flight.
    const key = `signal:${url.trim()}`;
    await this.setStatus('Connecting to signaling server...', this.liveColor());
    await this.startHandshake(key);
    let ok = false;
    let failed = false;
    try {
      ok = await this.request<boolean>(
        request(this.id, this.peerRegistryId, 'connectSignaling', { url: url.trim() })
      );
    } catch {
      failed = true;
    } finally {
      if (this.handshakeKey === key) await this.endHandshake();
    }
    if (ok) {
      await this.refresh();
      await this.acknowledge('Connected to signaling server!', this.liveColor());
    } else {
      await this.reject(failed ? 'Connection error.' : 'Failed to connect.');
    }
  }

  private async addContact(): Promise<void> {
    if (!this.addContactInputId || !this.peerRegistryId) return;

    const jsonStr = await this.request<string>(
      request(this.id, this.addContactInputId, 'getValue', {})
    );

    if (!jsonStr || jsonStr.trim() === '') {
      await this.reject('Paste identity JSON.');
      return;
    }

    let parsed: {
      peerId: string;
      publicSigningKey: string;
      publicExchangeKey: string;
      name?: string;
    };
    try {
      parsed = JSON.parse(jsonStr.trim()) as typeof parsed;
    } catch {
      await this.reject('Invalid JSON format.');
      return;
    }

    if (!parsed || !parsed.peerId || !parsed.publicSigningKey || !parsed.publicExchangeKey) {
      await this.reject('Invalid identity JSON.');
      return;
    }

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'addContact', {
          peerId: parsed.peerId,
          publicSigningKey: parsed.publicSigningKey,
          publicExchangeKey: parsed.publicExchangeKey,
          name: parsed.name ?? '',
        })
      );
    } catch {
      await this.reject('Could not add the contact.');
      return;
    }

    await this.refresh();
    await this.acknowledge('Contact added!');
  }

  private async toggleConnection(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      const state = await this.request<string>(
        request(this.id, this.peerRegistryId, 'getContactState', { peerId })
      );

      const wasConnected = state === 'connected';
      if (wasConnected) {
        await this.request(
          request(this.id, this.peerRegistryId, 'disconnectPeer', { peerId })
        );
        if (this.handshakeKey === peerId) await this.endHandshake();
        await this.refresh();
        await this.setStatus('Disconnected.');
        return;
      }

      const started = await this.request<boolean>(
        request(this.id, this.peerRegistryId, 'connectToPeer', { peerId })
      );
      if (started === false) {
        await this.refresh();
        await this.reject('Could not reach that peer. Connect to a signaling server first.');
        return;
      }
      // The offer is out; the eye watches until the peer answers.
      await this.startHandshake(peerId);
      await this.refresh();
      await this.setStatus('Connecting...', this.liveColor());
    } catch {
      if (this.handshakeKey === peerId) await this.endHandshake();
      await this.reject('Connection error.');
    }
  }

  private async introduceContact(contactId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    // Get list of connected peers to choose the recipient
    interface ContactInfo {
      peerId: string; name: string; state: string; addedAt: number;
    }
    let contacts: ContactInfo[] = [];
    try {
      contacts = await this.request<ContactInfo[]>(
        request(this.id, this.peerRegistryId, 'listContacts', {})
      );
    } catch { return; }

    // Find connected peers that are not the contact being introduced
    const connectedPeers = contacts.filter(c => c.state === 'connected' && c.peerId !== contactId);
    if (connectedPeers.length === 0) {
      await this.reject('No other connected peers to introduce to.');
      return;
    }

    // For simplicity, introduce to each connected peer
    let introduced = 0;
    for (const peer of connectedPeers) {
      try {
        await this.request(
          request(this.id, this.peerRegistryId, 'introduceContact', {
            contactId, toPeerId: peer.peerId,
          })
        );
        introduced++;
      } catch { /* skip failures */ }
    }

    if (introduced > 0) {
      await this.acknowledge(`Introduced to ${introduced} peer(s)!`);
    } else {
      await this.reject('Failed to introduce.');
    }
  }

  private async acceptIntroduction(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'acceptIntroduction', { peerId })
      );
      await this.refresh();
      await this.acknowledge('Introduction accepted!');
    } catch {
      await this.reject('Failed to accept introduction.');
    }
  }

  private async rejectIntroduction(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'rejectIntroduction', { peerId })
      );
      await this.refresh();
      await this.setStatus('Introduction rejected.');
    } catch {
      await this.reject('Failed to reject introduction.');
    }
  }

  private async blockPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Block Peer',
      message: `Block this peer? They will no longer be able to connect to you.`,
      confirmLabel: 'Block',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'blockPeer', { peerId })
      );
      await this.refresh();
      await this.setStatus('Peer blocked.');
    } catch {
      await this.reject('Failed to block peer.');
    }
  }

  private async unblockPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'unblockPeer', { peerId })
      );
      await this.refresh();
      await this.setStatus('Peer unblocked.');
    } catch {
      await this.reject('Failed to unblock peer.');
    }
  }

  private async promoteNetworkPeer(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'promoteToContact', { peerId })
      );
      await this.refresh();
      await this.acknowledge('Peer promoted to contact!');
    } catch {
      await this.reject('Failed to promote peer.');
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.mapSelectedId === undefined || this.mapSelectedId === SELF_NODE || /^(peer|sig|sp|fe):/.test(this.mapSelectedId),
      'the map selection names a map node (this peer, a peer, a server, a peer on a server, or a frontend)');
    invariant(this.tabContents.length <= MAP_TAB + 1, 'the window has at most its six list tabs plus the Map');
    invariant(Number.isInteger(this.selectedTab) && this.selectedTab >= 0 && this.selectedTab <= MAP_TAB,
      'the selected tab is one of the seven');
    invariant(this.windowId !== undefined || (this.flushTimer === undefined && !this.minimized),
      'a closed window has no pass waiting and is not minimized');
  }

  private async removeContact(peerId: string): Promise<void> {
    if (!this.peerRegistryId) return;

    const confirmed = await this.confirm({
      title: 'Remove Contact',
      message: `Remove this contact? You will lose the ability to connect to them.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await this.request(
        request(this.id, this.peerRegistryId, 'removeContact', { peerId })
      );
      await this.refresh();
      await this.setStatus('Contact removed.');
    } catch {
      await this.reject('Failed to remove contact.');
    }
  }
}

// Well-known peer network ID
export const PEER_NETWORK_ID = 'abjects:peer-network' as AbjectId;

function formatRemoteStatus(status: { enabled: boolean; peerId: string; signalingUrl: string; connectedCount: number }): string {
  if (!status.enabled) return 'Remote access is disabled.';
  if (!status.peerId) return 'Remote access enabled (initializing…)';
  return `Listening as ${status.peerId.slice(0, 16)}… via ${status.signalingUrl} (${status.connectedCount} connected)`;
}

function formatRelative(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
