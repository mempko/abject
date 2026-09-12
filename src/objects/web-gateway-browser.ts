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
  private toggleBtnId?: AbjectId;
  private statusLabelId?: AbjectId;
  private routesLabelId?: AbjectId;
  private tokenNameInputId?: AbjectId;
  private mintBtnId?: AbjectId;
  private tokensListId?: AbjectId;
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

  private async showWindow(): Promise<void> {
    if (!this.widgetManagerId) this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    if (!this.widgetManagerId || this.windowId) return;
    this.theme = await this.fetchTheme();
    const gateway = await this.gateway();
    if (gateway) { try { this.send(request(this.id, gateway, 'addDependent', {})); } catch { /* not yet */ } }

    this.windowId = await this.wm('createWindowAbject', { title: 'Web Gateway', rect: { x: 200, y: 90, width: WIN_W, height: WIN_H }, resizable: true }) as AbjectId;
    this.rootLayoutId = await this.wm('createScrollableVBox', { windowId: this.windowId, margins: { top: 12, right: 12, bottom: 12, left: 12 }, spacing: 10 }) as AbjectId;

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'label', windowId: this.windowId, text: 'HTTP Gateway', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 16 } },
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textDescription, fontSize: 12, wordWrap: true, selectable: true } },
      { type: 'button', windowId: this.windowId, text: 'Enable', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
      { type: 'divider', windowId: this.windowId },
      { type: 'label', windowId: this.windowId, text: 'Routes', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textPrimary, fontSize: 12, wordWrap: true, selectable: true } },
      { type: 'divider', windowId: this.windowId },
      { type: 'label', windowId: this.windowId, text: 'API Tokens', style: { color: this.theme.textHeading, fontWeight: 'bold', fontSize: 13 } },
      { type: 'label', windowId: this.windowId, text: 'Authenticated routes need one of these as a Bearer token. The secret is shown once.', style: { color: this.theme.textDescription, fontSize: 12, wordWrap: true } },
    ] }));
    const [titleId, statusId, toggleId, div1, routesHdr, routesId, div2, tokensHdr, tokensDesc] = widgetIds;
    this.statusLabelId = statusId; this.toggleBtnId = toggleId; this.routesLabelId = routesId;
    for (const id of [titleId, statusId, div1, routesHdr, routesId, div2, tokensHdr, tokensDesc]) {
      await this.addTo(this.rootLayoutId, id, { vertical: 'fixed', horizontal: 'expanding' }, { height: id === statusId || id === routesId ? 60 : id === div1 || id === div2 ? 1 : 20 });
    }
    await this.addDep(this.toggleBtnId); await this.addTo(this.rootLayoutId, this.toggleBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 120, height: 30 });

    // mint row
    const mintRow = await this.wm('createNestedHBox', { parentLayoutId: this.rootLayoutId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 8 }) as AbjectId;
    await this.addTo(this.rootLayoutId, mintRow, { vertical: 'fixed', horizontal: 'expanding' }, { height: 32 });
    const { widgetIds: mintIds } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'textInput', windowId: this.windowId, placeholder: 'token name' },
      { type: 'button', windowId: this.windowId, text: 'Create token', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
    ] }));
    this.tokenNameInputId = mintIds[0]; this.mintBtnId = mintIds[1];
    await this.addDep(this.mintBtnId);
    await this.request(request(this.id, mintRow, 'addLayoutChild', { widgetId: this.tokenNameInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 30 } }));
    await this.request(request(this.id, mintRow, 'addLayoutChild', { widgetId: this.mintBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 120, height: 30 } }));

    const { widgetIds: [secretId, tokensId] } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId, 'create', { specs: [
      { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.statusSuccess, fontSize: 12, wordWrap: true, selectable: true } },
      { type: 'list', windowId: this.windowId, items: [] },
    ] }));
    this.secretLabelId = secretId; this.tokensListId = tokensId;
    await this.addTo(this.rootLayoutId, this.secretLabelId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 20 });
    await this.addTo(this.rootLayoutId, this.tokensListId, { vertical: 'expanding', horizontal: 'expanding' }, { height: 120 });

    await this.refresh();
  }

  private async hideWindow(): Promise<void> {
    if (!this.windowId || !this.widgetManagerId) return;
    await this.wm('destroyWindowAbject', { windowId: this.windowId });
    this.windowId = undefined; this.rootLayoutId = undefined; this.toggleBtnId = undefined; this.statusLabelId = undefined;
    this.routesLabelId = undefined; this.tokenNameInputId = undefined; this.mintBtnId = undefined; this.tokensListId = undefined;
    this.secretLabelId = undefined; this.revokeButtons.clear();
  }

  private async refresh(): Promise<void> {
    const gateway = await this.gateway();
    if (!gateway || !this.windowId) return;
    try {
      const status = await this.request<GatewayStatus>(request(this.id, gateway, 'getStatus', {}));
      const routes = await this.request<RouteInfo[]>(request(this.id, gateway, 'getRoutes', {}));
      this.tokens = await this.request<TokenInfo[]>(request(this.id, gateway, 'listTokens', {}));
      if (this.statusLabelId) await this.request(request(this.id, this.statusLabelId, 'update', {
        text: status.enabled ? `Listening on ${status.baseUrl}\n${status.routes} route(s) across ${status.workspaces} workspace(s)` : 'Off. Enable to serve whitelisted abjects over HTTP.' }));
      if (this.toggleBtnId) await this.request(request(this.id, this.toggleBtnId, 'update', { text: status.enabled ? 'Disable' : 'Enable' }));
      if (this.routesLabelId) await this.request(request(this.id, this.routesLabelId, 'update', {
        text: routes.length ? routes.map(r => `${r.path}  (${r.access})`).join('\n') : 'No abjects exposed yet. Open a workspace’s Settings → Web to expose one.' }));
      if (this.tokensListId) await this.request(request(this.id, this.tokensListId, 'update', {
        items: this.tokens.map(t => ({ label: `${t.name}  · created ${new Date(t.createdAt).toLocaleDateString()}${t.lastUsedAt ? `, used ${new Date(t.lastUsedAt).toLocaleDateString()}` : ''}`, value: t.id })), selectedIndex: -1 }));
    } catch { /* gateway not ready */ }
  }

  private async onChanged(msg: AbjectMessage): Promise<void> {
    const { aspect } = msg.payload as { aspect: string; value?: unknown };
    const fromId = msg.routing.from;
    if (fromId === this.gatewayId) { await this.refresh(); return; }
    if (aspect !== 'click' && aspect !== 'submit') return;
    const gateway = await this.gateway();
    if (!gateway) return;
    if (fromId === this.toggleBtnId) {
      const status = await this.request<GatewayStatus>(request(this.id, gateway, 'getStatus', {}));
      await this.request(request(this.id, gateway, 'setEnabled', { enabled: !status.enabled }), 20000);
      await this.refresh();
      return;
    }
    if (fromId === this.mintBtnId || (aspect === 'submit' && fromId === this.tokenNameInputId)) {
      let name = 'token';
      if (this.tokenNameInputId) { try { name = (await this.request<string>(request(this.id, this.tokenNameInputId, 'getValue', {}))) || 'token'; } catch { /* empty */ } }
      const res = await this.request<{ token: string; name: string }>(request(this.id, gateway, 'mintToken', { name }));
      if (this.secretLabelId) await this.request(request(this.id, this.secretLabelId, 'update', { text: `New token (copy now, shown once): ${res.token}` }));
      if (this.tokenNameInputId) { try { await this.request(request(this.id, this.tokenNameInputId, 'update', { text: '' })); } catch { /* ok */ } }
      await this.refresh();
      return;
    }
  }
}

export const WEB_GATEWAY_BROWSER_ID = 'abjects:web-gateway-browser' as AbjectId;
