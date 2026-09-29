/**
 * WebGatewayBrowser — the desktop window for the HTTP gateway.
 *
 * Turns the gateway on or off, shows its address and live routes, and manages
 * API tokens (create, copy once, revoke). The per-workspace whitelist itself
 * is edited in each workspace's Settings under the Web tab; this window is the
 * global control surface. It follows the manager/browser split: WebGateway
 * holds the state, this only displays and drives it.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { emptyStateMarkdown, emptyStateStyle, livingStyle } from './ui-kit.js';
import { request } from '../core/message.js';

const WIN_W = 560, WIN_H = 520;

interface GatewayStatus { enabled: boolean; listening: boolean; bind: string; port: number; baseUrl: string; workspaces: number; routes: number; tokens: number; }
interface RouteInfo { workspace: string; workspaceSlug: string; abject: string; access: string; methods: string[] | null; path: string; }
interface TokenInfo { id: string; name: string; createdAt: number; lastUsedAt?: number; }

export class WebGatewayBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private gatewayId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  /** The API Tokens section card: the empty state's height is set on it. */
  private tokensCardId?: AbjectId;
  private toggleBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private routesLabelId?: AbjectId;
  private tokenNameInputId?: AbjectId;
  private mintBtnId?: AbjectId;
  private tokensListId?: AbjectId;
  private tokensEmptyId?: AbjectId;
  private secretLabelId?: AbjectId;
  private revokeButtons = new Map<AbjectId, string>();
  private tokens: TokenInfo[] = [];

  constructor() {
    super({
      manifest: {
        name: 'WebGatewayBrowser',
        description: 'Desktop window for the HTTP gateway: turn it on or off, see its address and live routes, and manage API tokens. Ask how to reach an abject over the web.',
        version: '1.0.0',
        interface: {
          id: 'abjects:web-gateway-browser' as InterfaceId,
          name: 'WebGatewayBrowser',
          description: 'HTTP gateway control window',
          methods: [
            { name: 'show', description: 'Open the gateway window.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide', description: 'Close the gateway window.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
          ],
        },
        requiredCapabilities: [], providedCapabilities: [], tags: ['system', 'ui', 'web'],
      },
    });
    this.on('show', async () => { await this.showWindow(); return true; });
    this.on('hide', async () => { await this.hideWindow(); return true; });
    this.on('windowCloseRequested', async () => { await this.hideWindow(); return true; });
    this.on('changed', async (msg: AbjectMessage) => this.onChanged(msg));
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.theme = await this.fetchTheme();
  }

  private async gateway(): Promise<AbjectId | undefined> {
    this.gatewayId = await this.resolveDep('WebGateway', this.gatewayId);
    return this.gatewayId;
  }
  private wm(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request(request(this.id, this.widgetManagerId!, method, payload));
  }
  private async addDep(id: AbjectId): Promise<void> { await this.request(request(this.id, id, 'addDependent', {})); }
  private async addTo(layout: AbjectId, widget: AbjectId, sizePolicy: Record<string, string>, preferredSize?: Record<string, number>): Promise<void> {
    await this.request(request(this.id, layout, 'addLayoutChild', { widgetId: widget, sizePolicy, preferredSize }));
  }

  /**
   * A grouped card in the window's scrolling root (WidgetManager
   * createSection: ruled panel, sigil title, hint). Returns the card's
   * layout id: add the section's rows to it. It sizes to its content.
   */
  private async sectionCard(title: string, description: string, hintHeight = 18): Promise<AbjectId> {
    const { sectionId } = await this.request<{ sectionId: AbjectId }>(request(this.id, this.widgetManagerId!, 'createSection', {
      parentLayoutId: this.rootLayoutId, windowId: this.windowId, title, description, hintHeight,
    }));
    return sectionId;
  }

  /** Play a slab effect on the gateway window (visual only, fire and forget). */
  private windowEffect(effect: 'shake' | 'flash'): void {
    if (!this.windowId) return;
    this.request(request(this.id, this.windowId, 'effect', { effect }))
      .catch(() => { /* effects are decoration */ });
  }

  /** Report a failed action on the one-line result label, with a shake. */
  private async reportFailure(text: string): Promise<void> {
    this.windowEffect('shake');
    if (!this.secretLabelId) return;
    try {
      await this.request(request(this.id, this.secretLabelId, 'update', { text, style: { color: this.theme.statusError, fontSize: 12, wordWrap: true, selectable: true } }));
    } catch { /* widget gone */ }
  }

  private async showWindow(): Promise<void> {
    if (!this.widgetManagerId) this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    if (!this.widgetManagerId || this.windowId) return;
    this.theme = await this.fetchTheme();
    const gateway = await this.gateway();
    if (gateway) { try { this.send(request(this.id, gateway, 'addDependent', {})); } catch { /* not yet */ } }

    this.windowId = await this.wm('createWindowAbject', { title: 'Web Gateway', rect: { x: 200, y: 90, width: WIN_W, height: WIN_H }, resizable: true }) as AbjectId;
    // The root scrolls; each topic is a section card that sizes to its content.
    this.rootLayoutId = await this.wm('createScrollableVBox', { windowId: this.windowId, margins: { top: 12, right: 12, bottom: 12, left: 12 }, spacing: 10 }) as AbjectId;
    const serverCard = await this.sectionCard('HTTP Server', 'Serves whitelisted abjects to browsers and scripts over HTTP.');
    const routesCard = await this.sectionCard('Routes', 'Each workspace chooses what it exposes in its Settings, under the Web tab.');
    this.tokensCardId = await this.sectionCard('API Tokens', 'Authenticated routes need one of these as a Bearer token. The secret is shown once.', 34);
    const tokensCard = this.tokensCardId;

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textMeta, fontSize: 12, wordWrap: true, selectable: true } },
      { type: 'button', windowId: this.windowId, text: 'Enable', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 12, wordWrap: true, selectable: true } },
    ] }));
    const [statusId, toggleId, routesId] = widgetIds;
    this.statusLabelId = statusId; this.toggleBtnId = toggleId; this.routesLabelId = routesId;
    await this.addTo(serverCard, statusId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 60 });
    await this.addDep(this.toggleBtnId); await this.addTo(serverCard, this.toggleBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 120, height: 30 });
    await this.addTo(routesCard, routesId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 60 });

    // mint row
    const mintRow = await this.wm('createNestedHBox', { parentLayoutId: tokensCard, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 }) as AbjectId;
    await this.addTo(tokensCard, mintRow, { vertical: 'fixed', horizontal: 'expanding' }, { height: 32 });
    const { widgetIds: mintIds } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'textInput', windowId: this.windowId, placeholder: 'Token name (e.g. my-script)' },
      { type: 'button', windowId: this.windowId, text: 'Create token', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
    ] }));
    this.tokenNameInputId = mintIds[0]; this.mintBtnId = mintIds[1];
    await this.addDep(this.mintBtnId);
    // Enter in the name field creates the token too.
    await this.addDep(this.tokenNameInputId);
    await this.request(request(this.id, mintRow, 'addLayoutChild', { widgetId: this.tokenNameInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 30 } }));
    await this.request(request(this.id, mintRow, 'addLayoutChild', { widgetId: this.mintBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: 30 } }));

    const { widgetIds: [secretId, tokensEmptyId, tokensId] } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.statusSuccess, fontSize: 12, wordWrap: true, selectable: true } },
      { type: 'label', windowId: this.windowId, text: emptyStateMarkdown('No API tokens yet', 'Name a token above and press Create token. Scripts and other apps send it to reach authenticated routes.'), style: { ...emptyStateStyle(this.theme), visible: false } },
      { type: 'list', windowId: this.windowId, items: [] },
    ] }));
    this.secretLabelId = secretId; this.tokensListId = tokensId; this.tokensEmptyId = tokensEmptyId;
    // Each token row carries an inline Revoke action.
    await this.addDep(this.tokensListId);
    await this.addTo(tokensCard, this.secretLabelId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 20 });
    await this.addTo(tokensCard, this.tokensEmptyId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 0 });
    // The card measures the list at its preferred height and hands it that space.
    await this.addTo(tokensCard, this.tokensListId, { vertical: 'expanding', horizontal: 'expanding' }, { height: 120 });

    await this.refresh();
  }

  private async hideWindow(): Promise<void> {
    if (!this.windowId || !this.widgetManagerId) return;
    await this.wm('destroyWindowAbject', { windowId: this.windowId });
    this.windowId = undefined; this.rootLayoutId = undefined; this.tokensCardId = undefined; this.toggleBtnId = undefined; this.statusLabelId = undefined;
    this.routesLabelId = undefined; this.tokenNameInputId = undefined; this.mintBtnId = undefined; this.tokensListId = undefined;
    this.tokensEmptyId = undefined; this.secretLabelId = undefined; this.revokeButtons.clear();
  }

  private async refresh(): Promise<void> {
    const gateway = await this.gateway();
    if (!gateway || !this.windowId) return;
    try {
      const status = await this.request<GatewayStatus>(request(this.id, gateway, 'getStatus', {}));
      const routes = await this.request<RouteInfo[]>(request(this.id, gateway, 'getRoutes', {}));
      this.tokens = await this.request<TokenInfo[]>(request(this.id, gateway, 'listTokens', {}));
      // Three states: listening (living light), enabled but not listening
      // (a failure to say plainly), and off.
      const stuck = status.enabled && !status.listening;
      if (this.statusLabelId) await this.request(request(this.id, this.statusLabelId, 'update', {
        style: stuck ? { color: this.theme.statusError, fontSize: 12, wordWrap: true, selectable: true }
          : status.enabled ? livingStyle(this.theme) : { color: this.theme.textMeta, fontSize: 12 },
        text: stuck ? `Enabled, but not listening: port ${status.port} could not be opened. Disable, pick another port, and enable again.`
          : status.enabled ? `Listening on ${status.baseUrl}\n${status.routes} route(s) across ${status.workspaces} workspace(s)` : 'Off. Enable to serve whitelisted abjects over HTTP.' }));
      if (this.toggleBtnId) await this.request(request(this.id, this.toggleBtnId, 'update', { text: status.enabled ? 'Disable' : 'Enable' }));
      if (this.routesLabelId) await this.request(request(this.id, this.routesLabelId, 'update', routes.length
        ? { style: { color: this.theme.textPrimary, fontSize: 12, markdown: false, align: 'left' }, text: routes.map(r => `${r.path}  (${r.access})`).join('\n') }
        : { style: emptyStateStyle(this.theme), text: emptyStateMarkdown('No abjects exposed yet', 'Open a workspace’s Settings, then the Web tab, to expose one.') }));
      const hasTokens = this.tokens.length > 0;
      // Visibility first, then the height: the tokens card re-measures on
      // updateLayoutChild, so it sizes to whichever of list or empty state shows.
      if (this.tokensListId) await this.request(request(this.id, this.tokensListId, 'update', { visible: hasTokens }));
      if (this.tokensEmptyId && this.tokensCardId) {
        await this.request(request(this.id, this.tokensEmptyId, 'update', { visible: !hasTokens }));
        await this.request(request(this.id, this.tokensCardId, 'updateLayoutChild', { widgetId: this.tokensEmptyId, preferredSize: { height: hasTokens ? 0 : 56 } }));
      }
      if (this.tokensListId) await this.request(request(this.id, this.tokensListId, 'update', {
        items: this.tokens.map(t => ({
          label: t.name,
          value: t.id,
          detail: `created ${new Date(t.createdAt).toLocaleDateString()}${t.lastUsedAt ? `, used ${new Date(t.lastUsedAt).toLocaleDateString()}` : ', never used'}`,
          actions: [{ id: 'revoke', label: 'Revoke', color: this.theme.destructiveBg, textColor: this.theme.destructiveText }],
        })), selectedIndex: -1 }));
    } catch { /* gateway not ready */ }
  }

  private async onChanged(msg: AbjectMessage): Promise<void> {
    const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
    const fromId = msg.routing.from;
    if (fromId === this.gatewayId) { await this.refresh(); return; }
    if (fromId === this.tokensListId && aspect === 'action') {
      await this.onTokenAction(value);
      return;
    }
    if (aspect !== 'click' && aspect !== 'submit') return;
    const gateway = await this.gateway();
    if (!gateway) return;
    if (fromId === this.toggleBtnId) {
      try {
        const status = await this.request<GatewayStatus>(request(this.id, gateway, 'getStatus', {}));
        const after = await this.request<Partial<GatewayStatus> | undefined>(
          request(this.id, gateway, 'setEnabled', { enabled: !status.enabled }), 20000);
        await this.refresh();
        // Turning on succeeds only when the listener is actually up.
        if (!status.enabled) {
          if (after && after.listening === false) this.windowEffect('shake');
          else this.windowEffect('flash');
        }
      } catch (err) {
        await this.refresh();
        await this.reportFailure(`Could not change the gateway: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      }
      return;
    }
    if (fromId === this.mintBtnId || (aspect === 'submit' && fromId === this.tokenNameInputId)) {
      let name = 'token';
      if (this.tokenNameInputId) { try { name = (await this.request<string>(request(this.id, this.tokenNameInputId, 'getValue', {}))) || 'token'; } catch { /* empty */ } }
      try {
        const res = await this.request<{ token: string; name: string }>(request(this.id, gateway, 'mintToken', { name }));
        if (this.secretLabelId) await this.request(request(this.id, this.secretLabelId, 'update', { text: `New token (copy now, shown once): ${res.token}`, style: { color: this.theme.statusSuccess, fontSize: 12, wordWrap: true, selectable: true } }));
        if (this.tokenNameInputId) { try { await this.request(request(this.id, this.tokenNameInputId, 'update', { text: '' })); } catch { /* ok */ } }
        await this.refresh();
        this.windowEffect('flash');
      } catch (err) {
        await this.reportFailure(`Could not create a token: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      }
      return;
    }
  }

  /** Inline row action on the tokens list: Revoke (after a confirmation). */
  private async onTokenAction(value: unknown): Promise<void> {
    let data: { value?: string; actionId?: string };
    try { data = JSON.parse(String(value)) as typeof data; } catch { return; }
    if (data.actionId !== 'revoke' || !data.value) return;
    const gateway = await this.gateway();
    if (!gateway) return;
    const token = this.tokens.find(t => t.id === data.value);
    const confirmed = await this.confirm({
      title: 'Revoke token',
      message: `Revoke "${token?.name ?? 'this token'}"? Scripts using it lose access at once.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await this.request(request(this.id, gateway, 'revokeToken', { id: data.value }));
      await this.refresh();
    } catch (err) {
      await this.reportFailure(`Could not revoke the token: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    }
  }
}

export const WEB_GATEWAY_BROWSER_ID = 'abjects:web-gateway-browser' as AbjectId;
