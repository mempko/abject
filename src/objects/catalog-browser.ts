/**
 * CatalogBrowser -- unified browser + installer for the official MCP server
 * registry (registry.modelcontextprotocol.io) and ClawHub (clawhub.ai), the
 * vendor-neutral skills registry.
 *
 * Layout: top tab bar (MCP Servers | Skills), a search box + refresh button,
 * a two-pane split beneath for the list and the detail view. Install actions
 * flow through SkillRegistry -- skills land as bundle trees, MCP entries as
 * synthesised SKILL.md wrappers -- so there is exactly one write path on
 * disk.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { MCPServerSummary } from './mcp-registry-client.js';
import type { ClawHubSkillSummary, SkillBundle } from './clawhub-client.js';
import { buildMcpSkillMd, packageToMcpCommand, sanitiseSkillName } from '../core/skill-synth.js';
import { Log } from '../core/timed-log.js';

const log = new Log('CatalogBrowser');

const CATALOG_BROWSER_INTERFACE: InterfaceId = 'abjects:catalog-browser';

export const CATALOG_BROWSER_ID = 'abjects:catalog-browser' as AbjectId;

const WIN_W = 780;
const WIN_H = 480;

type Tab = 'skills' | 'mcp';

interface DisplayItem {
  kind: Tab;
  label: string;
  subtitle: string;
  /**
   * MCP: registry server name.
   * Skills (ClawHub): slug.
   */
  key: string;
}

export class CatalogBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private mcpRegistryClientId?: AbjectId;
  private clawHubClientId?: AbjectId;
  private skillRegistryId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private skillsTabBtnId?: AbjectId;
  private mcpTabBtnId?: AbjectId;

  private splitPaneId?: AbjectId;
  private leftPaneId?: AbjectId;
  private detailPaneId?: AbjectId;

  private searchInputId?: AbjectId;
  private refreshBtnId?: AbjectId;
  private listWidgetId?: AbjectId;

  /**
   * Serialise detail-pane renders so two triggers (e.g. an event and a
   * click) cannot interleave their children. If another render is already
   * in flight when one is requested, the latest is stored in
   * pendingDetailRender; it runs once the current render completes.
   */
  private detailRenderInFlight = false;
  private pendingDetailRender: (() => Promise<void>) | null = null;

  private detailChildIds: AbjectId[] = [];
  private detailInstallBtnId?: AbjectId;

  // State
  private activeTab: Tab = 'mcp';
  private searchQuery = '';
  private mcpServers: MCPServerSummary[] = [];
  private clawHubSkills: ClawHubSkillSummary[] = [];
  private displayItems: DisplayItem[] = [];
  private selectedIndex = -1;

  constructor() {
    super({
      manifest: {
        name: 'CatalogBrowser',
        description:
          'Browse the official MCP server registry and ClawHub (vendor-neutral ' +
          'skills registry). One-click install lands entries under the local ' +
          'skills directory via SkillRegistry.',
        version: '1.0.0',
        interface: {
          id: CATALOG_BROWSER_INTERFACE,
          name: 'CatalogBrowser',
          description: 'Skill and MCP catalog UI',
          methods: [
            {
              name: 'show',
              description: 'Show the catalog browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the catalog browser window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display catalog window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'skill', 'mcp'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.mcpRegistryClientId = await this.discoverDep('MCPRegistryClient') ?? undefined;
    this.clawHubClientId = await this.discoverDep('ClawHubClient') ?? undefined;
    this.skillRegistryId = await this.discoverDep('SkillRegistry') ?? undefined;

    // Subscribe so the list refreshes live while registries paginate in.
    if (this.skillRegistryId) {
      this.send(request(this.id, this.skillRegistryId, 'addDependent', {}));
    }
    if (this.mcpRegistryClientId) {
      this.send(request(this.id, this.mcpRegistryClientId, 'addDependent', {}));
    }
    if (this.clawHubClientId) {
      this.send(request(this.id, this.clawHubClientId, 'addDependent', {}));
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## CatalogBrowser Usage Guide

Browse and install skills and MCP servers from public registries.

### Show / hide

  await call(await dep('CatalogBrowser'), 'show', {});
  await call(await dep('CatalogBrowser'), 'hide', {});

### Interactions (handled internally)

- Toggle between "MCP Servers" and "Skills" tabs at the top.
- Type in the search box to filter the loaded list.
- Click an item to see details.
- Click "Install" to write the entry into the local skills directory.

### IMPORTANT
- The interface ID is '${CATALOG_BROWSER_INTERFACE}'.
- MCP installs synthesise a SKILL.md wrapper around the server's command/args.
- ClawHub installs download a ZIP bundle and land the full tree under ~/.abjects/skills/.`;
  }

  // ─── Widget helpers ─────────────────────────────────────────────

  private async wm(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request(request(this.id, this.widgetManagerId!, method, payload));
  }

  private async addDep(widgetId: AbjectId): Promise<void> {
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  private async addToLayout(layoutId: AbjectId, widgetId: AbjectId, sizePolicy: Record<string, string>, preferredSize?: Record<string, number>): Promise<void> {
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId,
      sizePolicy,
      preferredSize,
    }));
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('show', async () => {
      await this.showWindow();
      return true;
    });

    this.on('hide', async () => {
      await this.hideWindow();
      return true;
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // Registry / installed-skills refresh events — any of them triggers
      // a list re-render.
      if ((fromId === this.skillRegistryId && aspect === 'skillsChanged')
          || (fromId === this.mcpRegistryClientId && aspect === 'registryUpdated')
          || (fromId === this.clawHubClientId && aspect === 'clawhubUpdated')) {
        await this.refreshData();
        return;
      }

      // Tab toggle
      if (fromId === this.skillsTabBtnId && aspect === 'click') {
        await this.setTab('skills');
        return;
      }
      if (fromId === this.mcpTabBtnId && aspect === 'click') {
        await this.setTab('mcp');
        return;
      }

      // Search input (textInput widget emits `change` with the raw string)
      if (fromId === this.searchInputId && aspect === 'change') {
        this.searchQuery = typeof value === 'string' ? value : '';
        await this.updateList();
        return;
      }

      // Refresh button
      if (fromId === this.refreshBtnId && aspect === 'click') {
        await this.forceRefresh();
        return;
      }

      // List selection
      if (fromId === this.listWidgetId && aspect === 'selectionChanged') {
        try {
          const sel = JSON.parse(value as string) as { index: number };
          this.selectedIndex = sel.index;
        } catch {
          this.selectedIndex = -1;
        }
        await this.rebuildDetailPane();
        return;
      }

      // Install button
      if (fromId === this.detailInstallBtnId && aspect === 'click') {
        await this.installSelected();
        return;
      }
    });

    this.on('windowCloseRequested', async () => {
      await this.hideWindow();
    });
  }

  // ─── Window lifecycle ───────────────────────────────────────────

  private async showWindow(): Promise<void> {
    if (!this.widgetManagerId) return;
    if (this.windowId) return;

    this.windowId = await this.wm('createWindowAbject', {
      title: 'Browse Skills & MCP',
      rect: { x: 160, y: 90, width: WIN_W, height: WIN_H },
      resizable: true,
    }) as AbjectId;

    // Root VBox: [tabBar] [splitPane]
    this.rootLayoutId = await this.wm('createVBox', {
      windowId: this.windowId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 0,
    }) as AbjectId;

    await this.buildTabBar();
    await this.buildBody();
    await this.refreshData();
  }

  private async hideWindow(): Promise<void> {
    if (!this.windowId || !this.widgetManagerId) return;
    await this.wm('destroyWindowAbject', { windowId: this.windowId });
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.skillsTabBtnId = undefined;
    this.mcpTabBtnId = undefined;
    this.splitPaneId = undefined;
    this.leftPaneId = undefined;
    this.detailPaneId = undefined;
    this.searchInputId = undefined;
    this.refreshBtnId = undefined;
    this.listWidgetId = undefined;
    this.detailChildIds = [];
    this.detailInstallBtnId = undefined;
  }

  private async buildTabBar(): Promise<void> {
    if (!this.rootLayoutId || !this.widgetManagerId || !this.windowId) return;

    this.tabBarId = await this.wm('createHBox', {
      windowId: this.windowId,
      margins: { top: 6, right: 8, bottom: 6, left: 8 },
      spacing: 8,
    }) as AbjectId;
    await this.addToLayout(this.rootLayoutId, this.tabBarId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 34 });

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'button', windowId: this.windowId, text: 'MCP Servers' },
        { type: 'button', windowId: this.windowId, text: 'Skills' },
      ]}),
    );
    this.mcpTabBtnId = widgetIds[0];
    this.skillsTabBtnId = widgetIds[1];
    await this.addDep(this.mcpTabBtnId);
    await this.addDep(this.skillsTabBtnId);
    await this.addToLayout(this.tabBarId, this.mcpTabBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 130, height: 28 });
    await this.addToLayout(this.tabBarId, this.skillsTabBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 130, height: 28 });
    await this.applyTabStyles();
  }

  private async applyTabStyles(): Promise<void> {
    const active = {
      background: this.theme.actionBg,
      color: this.theme.actionText,
      borderColor: this.theme.actionBorder,
    };
    const inactive = {
      background: this.theme.windowBg,
      color: this.theme.textPrimary,
      borderColor: this.theme.divider,
    };
    if (this.mcpTabBtnId) {
      await this.request(request(this.id, this.mcpTabBtnId, 'update', {
        style: this.activeTab === 'mcp' ? active : inactive,
      }));
    }
    if (this.skillsTabBtnId) {
      await this.request(request(this.id, this.skillsTabBtnId, 'update', {
        style: this.activeTab === 'skills' ? active : inactive,
      }));
    }
  }

  private async buildBody(): Promise<void> {
    if (!this.rootLayoutId || !this.widgetManagerId || !this.windowId) return;

    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'splitPane', windowId: this.windowId, orientation: 'horizontal',
          dividerPosition: 0.38, minSize: 180 },
      ]}),
    );
    this.splitPaneId = splitId;
    await this.addToLayout(this.rootLayoutId, this.splitPaneId, { vertical: 'expanding' });

    // Left: [search row] [list]
    this.leftPaneId = await this.wm('createDetachedVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 0, bottom: 4, left: 4 },
      spacing: 4,
    }) as AbjectId;

    // Right: scrollable detail
    this.detailPaneId = await this.wm('createDetachedScrollableVBox', {
      windowId: this.windowId,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 6,
    }) as AbjectId;

    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.leftPaneId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.detailPaneId }));

    const searchRow = await this.wm('createNestedHBox', {
      parentLayoutId: this.leftPaneId,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: 6,
    }) as AbjectId;
    await this.addToLayout(this.leftPaneId, searchRow, { vertical: 'fixed', horizontal: 'expanding' }, { height: 30 });

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        { type: 'textInput', windowId: this.windowId, placeholder: 'Search' },
        { type: 'button', windowId: this.windowId, text: 'Refresh' },
        { type: 'list', windowId: this.windowId, items: [] },
      ]}),
    );
    this.searchInputId = widgetIds[0];
    this.refreshBtnId = widgetIds[1];
    this.listWidgetId = widgetIds[2];

    await this.addDep(this.searchInputId);
    await this.addDep(this.refreshBtnId);
    await this.addDep(this.listWidgetId);

    await this.addToLayout(searchRow, this.searchInputId, { vertical: 'fixed', horizontal: 'expanding' }, { height: 28 });
    await this.addToLayout(searchRow, this.refreshBtnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 84, height: 28 });
    await this.addToLayout(this.leftPaneId, this.listWidgetId, { vertical: 'expanding', horizontal: 'expanding' });
  }

  // ─── Data refresh ───────────────────────────────────────────────

  private async setTab(tab: Tab): Promise<void> {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.searchQuery = '';
    this.selectedIndex = -1;
    if (this.searchInputId) {
      await this.request(request(this.id, this.searchInputId, 'update', { text: '' }));
    }
    await this.applyTabStyles();
    await this.updateList();
    await this.rebuildDetailPane();
  }

  private async refreshData(): Promise<void> {
    if (this.mcpRegistryClientId) {
      try {
        // No limit — the registry client auto-paginates in the background
        // and streams in via `registryUpdated` events, so each call here
        // returns everything we have so far.
        const { servers } = await this.request<{ servers: MCPServerSummary[]; nextCursor?: string }>(
          request(this.id, this.mcpRegistryClientId, 'list', {}),
          120000,
        );
        this.mcpServers = servers;
      } catch (err) {
        log.warn(`MCP registry refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.clawHubClientId) {
      try {
        const { skills } = await this.request<{ skills: ClawHubSkillSummary[]; nextCursor?: string }>(
          request(this.id, this.clawHubClientId, 'list', {}),
          120000,
        );
        this.clawHubSkills = skills;
      } catch (err) {
        log.warn(`ClawHub refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.updateList();
  }

  private async forceRefresh(): Promise<void> {
    if (this.activeTab === 'mcp' && this.mcpRegistryClientId) {
      try {
        await this.request(request(this.id, this.mcpRegistryClientId, 'refresh', {}), 5000);
      } catch { /* best effort */ }
    } else if (this.activeTab === 'skills' && this.clawHubClientId) {
      try {
        await this.request(request(this.id, this.clawHubClientId, 'refresh', {}), 5000);
      } catch { /* best effort */ }
    }
    await this.refreshData();
  }

  private async updateList(): Promise<void> {
    if (!this.listWidgetId) return;

    const q = this.searchQuery.trim().toLowerCase();
    if (this.activeTab === 'mcp') {
      this.displayItems = this.mcpServers
        .filter(s => !q || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q))
        .map<DisplayItem>(s => ({
          kind: 'mcp',
          label: s.name,
          subtitle: s.description ?? '',
          key: s.name,
        }));
    } else {
      this.displayItems = this.clawHubSkills
        .filter(s => !q || `${s.slug} ${s.displayName ?? ''} ${s.summary ?? ''}`.toLowerCase().includes(q))
        .map<DisplayItem>(s => ({
          kind: 'skills',
          label: s.isOfficial ? `★ ${s.displayName || s.slug}` : (s.displayName || s.slug),
          subtitle: s.summary ?? '',
          key: s.slug,
        }));
    }

    if (this.selectedIndex >= this.displayItems.length) {
      this.selectedIndex = this.displayItems.length > 0 ? 0 : -1;
    }

    const items = this.displayItems.map(d => ({ label: d.label, value: d.key }));
    await this.request(request(this.id, this.listWidgetId, 'update', {
      items,
      selectedIndex: this.selectedIndex,
    }));
    await this.rebuildDetailPane();
  }

  // ─── Detail pane ────────────────────────────────────────────────

  private async clearDetailPane(): Promise<void> {
    if (!this.detailPaneId) return;
    try {
      await this.request(request(this.id, this.detailPaneId, 'clearLayoutChildren', {}));
    } catch { /* gone */ }
    for (const id of this.detailChildIds) {
      this.send(request(this.id, id, 'destroy', {}));
    }
    this.detailChildIds = [];
    this.detailInstallBtnId = undefined;
  }

  private async rebuildDetailPane(): Promise<void> {
    await this.runDetailRender(() => this.doRebuildDetailPane());
  }

  private async runDetailRender(fn: () => Promise<void>): Promise<void> {
    if (this.detailRenderInFlight) {
      // A render is already running. Overwrite any previous pending work
      // with the most recent request; whatever was pending before is
      // superseded and safely dropped.
      this.pendingDetailRender = fn;
      return;
    }
    this.detailRenderInFlight = true;
    try {
      let next: (() => Promise<void>) | null = fn;
      while (next) {
        const current = next;
        this.pendingDetailRender = null;
        try {
          await current();
        } catch (err) {
          log.warn(`Detail render failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        next = this.pendingDetailRender;
      }
    } finally {
      this.detailRenderInFlight = false;
    }
  }

  private async doRebuildDetailPane(): Promise<void> {
    if (!this.detailPaneId || !this.widgetManagerId || !this.windowId) return;

    await this.clearDetailPane();

    if (this.selectedIndex < 0 || this.selectedIndex >= this.displayItems.length) {
      await this.addDetailLabel(
        this.activeTab === 'mcp'
          ? 'Select an MCP server to see details.'
          : 'Select a skill to see details.',
        false,
        { color: this.theme.textSecondary, wordWrap: true },
      );
      return;
    }

    const item = this.displayItems[this.selectedIndex];
    await this.addDetailLabel(item.label, true, { fontSize: 15 });

    if (item.subtitle) {
      await this.addDetailLabel(item.subtitle, false, { color: this.theme.textSecondary, wordWrap: true, markdown: true });
    }

    let installable = true;
    if (item.kind === 'mcp') {
      const server = this.mcpServers.find(s => s.name === item.key);
      if (server) {
        if (server.version) await this.addDetailLabel(`Version: ${server.version}`, false, { color: this.theme.textSecondary, wordWrap: true });
        if (server.repository?.url) await this.addDetailLabel(`Repo: ${server.repository.url}`, false, { color: this.theme.textSecondary, wordWrap: true });
        const pkg = server.packages?.find(p => !!p && !!(p.identifier ?? p.name));
        if (pkg) {
          const registry = pkg.registryType ?? pkg.registry_name ?? '?';
          const ident = pkg.identifier ?? pkg.name ?? '';
          await this.addDetailLabel(`Package: ${registry} / ${ident}${pkg.version ? ' @ ' + pkg.version : ''}`, false, { color: this.theme.textSecondary, wordWrap: true });
          if (pkg.environmentVariables && pkg.environmentVariables.length > 0) {
            const required = pkg.environmentVariables.filter(e => e.isRequired).map(e => e.name);
            if (required.length > 0) {
              await this.addDetailLabel(`Requires env: ${required.join(', ')}`, false, { color: this.theme.textSecondary, wordWrap: true });
            }
          }
        } else {
          installable = false;
          const remoteCount = server.remotes?.length ?? 0;
          if (remoteCount > 0) {
            await this.addDetailLabel(
              `This is a remote-only MCP server (${remoteCount} endpoint${remoteCount > 1 ? 's' : ''}). Local subprocess install is not possible; remote MCP transport is not yet supported.`,
              false,
              { color: this.theme.textSecondary, wordWrap: true },
            );
            const firstRemote = server.remotes?.[0];
            if (firstRemote?.url) {
              await this.addDetailLabel(`Endpoint: ${firstRemote.url}`, false, { color: this.theme.textSecondary, wordWrap: true });
            }
          } else {
            await this.addDetailLabel(
              'This entry has no installable package and no remote endpoints. Nothing to install.',
              false,
              { color: this.theme.textSecondary, wordWrap: true },
            );
          }
        }
      }
    } else {
      const hit = this.clawHubSkills.find(s => s.slug === item.key);
      if (hit) {
        if (hit.ownerHandle) await this.addDetailLabel(`Author: ${hit.ownerHandle}`, false, { color: this.theme.textSecondary, wordWrap: true });
        if (hit.latestVersion) await this.addDetailLabel(`Version: ${hit.latestVersion}`, false, { color: this.theme.textSecondary, wordWrap: true });
        if (hit.channel) await this.addDetailLabel(`Channel: ${hit.channel}${hit.isOfficial ? ' (official)' : ''}`, false, { color: this.theme.textSecondary, wordWrap: true });
        if (hit.capabilityTags && hit.capabilityTags.length > 0) {
          await this.addDetailLabel(`Flags: ${hit.capabilityTags.join(', ')}`, false, { color: this.theme.textSecondary, wordWrap: true });
          if (hit.capabilityTags.includes('requires-sensitive-credentials')) {
            await this.addDetailLabel(
              'Heads-up: this skill declares that it needs sensitive credentials. Review the SKILL.md after install before enabling, and use SecretsVault for any tokens.',
              false,
              { color: this.theme.textSecondary, wordWrap: true },
            );
          }
        }
        await this.addDetailLabel(`Source: clawhub.ai/${hit.slug}`, false, { color: this.theme.textSecondary, wordWrap: true });
        await this.addDetailLabel(
          'ClawHub skills are community-published and untrusted until you review them. The bundle will be written under ~/.abjects/skills/<slug>/ but will not be enabled automatically.',
          false,
          { color: this.theme.textSecondary, wordWrap: true },
        );
      }
    }

    // Install button (installable entries only).
    if (installable) {
      const { widgetIds: [btnId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId, 'create', { specs: [
          { type: 'button', windowId: this.windowId, text: 'Install',
            style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        ]}),
      );
      this.detailInstallBtnId = btnId;
      await this.addDep(btnId);
      await this.addToLayout(this.detailPaneId, btnId, { vertical: 'fixed', horizontal: 'fixed' }, { width: 120, height: 30 });
      this.detailChildIds.push(btnId);
    }
  }

  private async addDetailLabel(text: string, bold = false, extraStyle: Record<string, unknown> = {}): Promise<void> {
    if (!this.detailPaneId || !this.widgetManagerId || !this.windowId) return;
    const { widgetIds: [id] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', { specs: [
        {
          type: 'label',
          windowId: this.windowId,
          text,
          style: {
            bold,
            color: this.theme.textPrimary,
            fontSize: bold ? 15 : 13,
            wordWrap: true,
            selectable: true,
            ...extraStyle,
          },
        },
      ]}),
    );
    // Estimate height from line count so wordWrap has somewhere to wrap into.
    // Matches SkillBrowser's detail-pane sizing pattern.
    const lines = Math.max(1, Math.ceil(text.length / 45));
    const lineHeight = bold ? 20 : 18;
    await this.addToLayout(this.detailPaneId, id, { vertical: 'fixed' },
      { height: Math.max(lineHeight, lines * lineHeight) });
    this.detailChildIds.push(id);
  }

  // ─── Install actions ───────────────────────────────────────────

  private async installSelected(): Promise<void> {
    if (this.selectedIndex < 0) return;
    if (!this.skillRegistryId) return;

    const item = this.displayItems[this.selectedIndex];
    if (item.kind === 'mcp') {
      const server = this.mcpServers.find(s => s.name === item.key);
      if (!server) return;
      await this.installMcpServer(server);
    } else {
      const hit = this.clawHubSkills.find(s => s.slug === item.key);
      if (!hit) return;
      await this.installClawHubSkill(hit);
    }
  }

  private async installClawHubSkill(skill: ClawHubSkillSummary): Promise<void> {
    if (!this.skillRegistryId || !this.clawHubClientId) return;
    try {
      await this.flashInstallStatus('Downloading…');
      const bundle = await this.request<SkillBundle>(
        request(this.id, this.clawHubClientId, 'downloadSkill', { slug: skill.slug }),
        60000,
      );
      const localName = sanitiseSkillName(skill.slug);
      await this.request(
        request(this.id, this.skillRegistryId, 'installSkillBundle', {
          name: localName,
          entries: bundle.entries,
        }),
      );
      await this.flashInstallStatus('Installed');
    } catch (err) {
      await this.flashInstallStatus(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async installMcpServer(server: MCPServerSummary): Promise<void> {
    if (!this.skillRegistryId) return;
    const pkg = server.packages?.find(p => !!p && !!(p.identifier ?? p.name));
    if (!pkg) return;

    const { command, args } = packageToMcpCommand(pkg);
    if (!command) {
      await this.flashInstallStatus('Unsupported package registry');
      return;
    }

    const skillName = sanitiseSkillName(server.name);
    const content = buildMcpSkillMd({
      name: skillName,
      description: server.description ?? `MCP server: ${server.name}`,
      mcpCommand: command,
      mcpArgs: args,
    });

    try {
      await this.request(
        request(this.id, this.skillRegistryId, 'installSkill', { name: skillName, content }),
      );
      await this.request(
        request(this.id, this.skillRegistryId, 'enableSkill', { name: skillName }),
      );
      await this.flashInstallStatus('Installed');
    } catch (err) {
      await this.flashInstallStatus(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async flashInstallStatus(text: string): Promise<void> {
    if (!this.detailInstallBtnId) return;
    await this.request(request(this.id, this.detailInstallBtnId, 'update', { text }));
    setTimeout(() => {
      if (this.detailInstallBtnId) {
        this.send(request(this.id, this.detailInstallBtnId, 'update', { text: 'Install' }));
      }
    }, 2500);
  }
}
