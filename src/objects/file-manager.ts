/**
 * FileManager -- browse, upload, and remove files in the workspace
 * FileSystem (~/.abject/ws-<id>/files). A toolbar (Up / Add / Delete /
 * Refresh) sits above a scrollable list of the current directory. Selecting
 * a folder navigates into it; selecting a file opens it in the FileViewer.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import type { ListItem } from './widgets/list-widget.js';
import type { FileInfo } from './capabilities/filesystem.js';

const log = new Log('FileManager');

const FILE_MANAGER_INTERFACE: InterfaceId = 'abjects:file-manager';

const WIN_W = 560;
const WIN_H = 480;
const TOOLBAR_H = 36;
const PATH_H = 22;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

export class FileManager extends Abject {
  private fileSystemId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private fileViewerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private toolbarId?: AbjectId;
  private pathLabelId?: AbjectId;
  private listWidgetId?: AbjectId;
  private upBtnId?: AbjectId;
  private addBtnId?: AbjectId;
  private newFolderBtnId?: AbjectId;
  private renameBtnId?: AbjectId;
  private deleteBtnId?: AbjectId;
  private refreshBtnId?: AbjectId;

  private currentDir = '/';
  private entries: FileInfo[] = [];
  private selectedPath?: string;
  private selectedName = '';
  private selectedIsDir = false;

  constructor() {
    super({
      manifest: {
        name: 'FileManager',
        description:
          'Browse, upload, and remove files stored in the workspace filesystem. Folders navigate; files open in the FileViewer for a quick preview.',
        version: '1.0.0',
        interface: {
          id: FILE_MANAGER_INTERFACE,
          name: 'FileManager',
          description: 'Workspace file browser UI',
          methods: [
            { name: 'show', description: 'Show the file manager window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide', description: 'Hide the file manager window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'getState', description: 'Get window visibility', parameters: [], returns: { kind: 'object', properties: { visible: { kind: 'primitive', primitive: 'boolean' } } } },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display file manager window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.fileSystemId = await this.discoverDep('FileSystem') ?? undefined;
    this.fileViewerId = await this.discoverDep('FileViewer') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({ visible: !!this.windowId }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      const { name, base64 } = msg.payload as { name: string; base64: string };
      await this.handleFileUploaded(name, base64 ?? '');
      return true;
    });
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleChanged(msg.routing.from, aspect, value);
    });
  }

  // ── Window lifecycle ────────────────────────────────────────────────

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2) - 60);
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '📁 Files',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 210,
        resizable: true,
      })
    );
    // Direct dependent so picked/dropped files (fileUploaded) reach us.
    this.send(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    // Toolbar row (auto-added expanding; pin to fixed height below).
    this.toolbarId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: this.toolbarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: TOOLBAR_H },
    }));

    const { widgetIds: btnIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: '⬆ Up', style: { fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: '＋ Add', style: { fontSize: 12, background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
          { type: 'button', windowId: this.windowId, text: 'New Folder', style: { fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: 'Rename', style: { fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: 'Delete', style: { fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: 'Refresh', style: { fontSize: 12 } },
        ],
      })
    );
    this.upBtnId = btnIds[0];
    this.addBtnId = btnIds[1];
    this.newFolderBtnId = btnIds[2];
    this.renameBtnId = btnIds[3];
    this.deleteBtnId = btnIds[4];
    this.refreshBtnId = btnIds[5];
    await this.request(request(this.id, this.toolbarId, 'addLayoutChildren', {
      children: [
        { widgetId: this.upBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 56, height: 30 } },
        { widgetId: this.addBtnId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 30 } },
        { widgetId: this.newFolderBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 92, height: 30 } },
        { widgetId: this.renameBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 70, height: 30 } },
        { widgetId: this.deleteBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 64, height: 30 } },
        { widgetId: this.refreshBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 72, height: 30 } },
      ],
    }));
    for (const id of btnIds) this.send(request(this.id, id, 'addDependent', {}));

    // Path / breadcrumb label.
    const { widgetIds: [pathId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'label', windowId: this.windowId, text: this.currentDir, style: { fontSize: 11, color: this.theme.textSecondary, wordWrap: false } }],
      })
    );
    this.pathLabelId = pathId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.pathLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: PATH_H },
    }));

    // File list (built-in scrollable + selectable).
    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], itemHeight: 28 }],
      })
    );
    this.listWidgetId = listId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));

    await this.loadDir(this.currentDir);

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.toolbarId = undefined;
    this.pathLabelId = undefined;
    this.listWidgetId = undefined;
    this.upBtnId = undefined;
    this.addBtnId = undefined;
    this.newFolderBtnId = undefined;
    this.renameBtnId = undefined;
    this.deleteBtnId = undefined;
    this.refreshBtnId = undefined;
    this.selectedPath = undefined;
    this.selectedName = '';
    this.selectedIsDir = false;
    this.entries = [];
    this.changed('visibility', false);
    return true;
  }

  // ── Directory listing ───────────────────────────────────────────────

  private async loadDir(dir: string): Promise<void> {
    if (!this.fileSystemId || !this.listWidgetId) return;
    this.currentDir = dir;
    this.selectedPath = undefined;
    this.selectedName = '';
    this.selectedIsDir = false;

    let infos: FileInfo[] = [];
    try {
      infos = await this.request<FileInfo[]>(
        request(this.id, this.fileSystemId, 'readdir', { path: dir }), 15000) ?? [];
    } catch (err) {
      log.warn(`readdir ${dir} failed:`, err instanceof Error ? err.message : String(err));
      infos = [];
    }
    // Folders first, then files, each alphabetical.
    infos.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    this.entries = infos;

    const items: ListItem[] = [];
    if (dir !== '/') {
      items.push({ label: '⬆  ..', value: '..' });
    }
    for (const info of infos) {
      if (info.isDirectory) {
        items.push({ label: `📁  ${info.name}`, value: info.path });
      } else {
        items.push({ label: `${this.fileGlyph(info.name)}  ${info.name}`, value: info.path, secondary: formatSize(info.size) });
      }
    }

    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
    if (this.pathLabelId) {
      await this.request(request(this.id, this.pathLabelId, 'update', { text: dir }));
    }
  }

  private fileGlyph(name: string): string {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return IMAGE_EXTS.has(ext) ? '🖼' : '📄';
  }

  // ── Events ──────────────────────────────────────────────────────────

  private async handleChanged(fromId: AbjectId, aspect: string, value: unknown): Promise<void> {
    if (fromId === this.listWidgetId && (aspect === 'selectionChanged' || aspect === 'confirm')) {
      const data = typeof value === 'string' ? JSON.parse(value) : value;
      const path = (data as { value?: string })?.value;
      if (!path) return;
      if (path === '..') { await this.navigateUp(); return; }
      const entry = this.entries.find(e => e.path === path);
      if (!entry) return;
      // Clicking a folder navigates into it; clicking a file selects + previews it.
      if (entry.isDirectory) {
        await this.loadDir(path);
      } else {
        this.selectedPath = path;
        this.selectedName = entry.name;
        this.selectedIsDir = false;
        await this.openInViewer(path);
      }
      return;
    }

    if (aspect !== 'click') return;
    if (fromId === this.upBtnId) { await this.navigateUp(); return; }
    if (fromId === this.refreshBtnId) { await this.loadDir(this.currentDir); return; }
    if (fromId === this.addBtnId) {
      if (this.windowId) {
        this.send(request(this.id, this.windowId, 'openFilePicker', { multiple: true }));
      }
      return;
    }
    if (fromId === this.newFolderBtnId) { await this.newFolder(); return; }
    if (fromId === this.renameBtnId) { await this.renameSelected(); return; }
    if (fromId === this.deleteBtnId) { await this.deleteSelected(); return; }
  }

  /**
   * What Rename/Delete act on: the selected file if one is selected, otherwise
   * the current folder (so a folder is renamed/deleted by entering it first).
   * Returns null at the root with no file selected.
   */
  private actionTarget(): { path: string; name: string; isDir: boolean } | null {
    if (this.selectedPath) {
      return { path: this.selectedPath, name: this.selectedName, isDir: this.selectedIsDir };
    }
    if (this.currentDir !== '/') {
      const name = this.currentDir.split('/').filter(Boolean).pop() ?? this.currentDir;
      return { path: this.currentDir, name, isDir: true };
    }
    return null;
  }

  private async newFolder(): Promise<void> {
    if (!this.fileSystemId) return;
    const name = await this.prompt({
      title: 'New folder',
      message: `Create a folder in ${this.currentDir}`,
      placeholder: 'Folder name',
      confirmLabel: 'Create',
    });
    if (name === null) return;
    const clean = name.trim().replace(/[/\\]/g, '_');
    if (!clean) return;
    try {
      await this.request(request(this.id, this.fileSystemId, 'mkdir', { path: this.joinPath(clean) }), 15000);
      await this.loadDir(this.currentDir);
    } catch (err) {
      await this.notify(`Could not create folder: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`, 'error');
    }
  }

  private async renameSelected(): Promise<void> {
    if (!this.fileSystemId) return;
    const target = this.actionTarget();
    if (!target) { await this.notify('Select a file, or open a folder, to rename', 'info'); return; }
    const newName = await this.prompt({
      title: target.isDir ? 'Rename folder' : 'Rename file',
      message: `Rename "${target.name}"`,
      defaultValue: target.name,
      confirmLabel: 'Rename',
    });
    if (newName === null) return;
    const clean = newName.trim().replace(/[/\\]/g, '_');
    if (!clean || clean === target.name) return;
    const parent = this.parentOf(target.path);
    const dest = parent === '/' ? `/${clean}` : `${parent}/${clean}`;
    try {
      await this.request(request(this.id, this.fileSystemId, 'rename', { from: target.path, to: dest }), 15000);
      await this.notify(`Renamed to "${clean}"`, 'success');
      // If we renamed the folder we're inside, drop to its parent listing.
      await this.loadDir(target.path === this.currentDir ? parent : this.currentDir);
    } catch (err) {
      await this.notify(`Rename failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`, 'error');
    }
  }

  private joinPath(name: string): string {
    return this.currentDir === '/' ? `/${name}` : `${this.currentDir}/${name}`;
  }

  private parentOf(p: string): string {
    const t = p.replace(/\/+$/, '');
    return t.slice(0, t.lastIndexOf('/')) || '/';
  }

  private async navigateUp(): Promise<void> {
    if (this.currentDir === '/') return;
    const trimmed = this.currentDir.replace(/\/+$/, '');
    const parent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
    await this.loadDir(parent);
  }

  private async openInViewer(path: string): Promise<void> {
    if (!this.fileViewerId) {
      this.fileViewerId = await this.discoverDep('FileViewer') ?? undefined;
    }
    if (!this.fileViewerId) {
      await this.notify('FileViewer is not available', 'error');
      return;
    }
    try {
      await this.request(request(this.id, this.fileViewerId, 'openFile', { path }), 30000);
    } catch (err) {
      log.warn(`openFile ${path} failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async deleteSelected(): Promise<void> {
    if (!this.fileSystemId) return;
    const target = this.actionTarget();
    if (!target) { await this.notify('Select a file, or open a folder, to delete', 'info'); return; }
    const confirmed = await this.confirm({
      title: target.isDir ? 'Delete folder?' : 'Delete file?',
      message: target.isDir
        ? `"${target.name}" and all of its contents will be permanently removed.`
        : `"${target.name}" will be permanently removed.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: true }));
    try {
      // `remove` handles both files and (recursively) directories.
      await this.request(request(this.id, this.fileSystemId, 'remove', { path: target.path }), 30000);
      await this.notify(`Deleted "${target.name}"`, 'success');
      // If we deleted the folder we're inside, drop to its parent listing.
      await this.loadDir(target.path === this.currentDir ? this.parentOf(this.currentDir) : this.currentDir);
    } catch (err) {
      await this.notify(`Delete failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`, 'error');
    } finally {
      if (this.deleteBtnId) this.send(event(this.id, this.deleteBtnId, 'update', { busy: false }));
    }
  }

  private async handleFileUploaded(name: string, base64: string): Promise<void> {
    if (!this.fileSystemId || !name) return;
    const safeName = name.replace(/[/\\]/g, '_');
    const path = this.joinPath(safeName);
    try {
      await this.request(request(this.id, this.fileSystemId, 'writeFileBytes', { path, base64 }), 30000);
      await this.loadDir(this.currentDir);
    } catch (err) {
      log.warn(`store upload ${safeName} failed:`, err instanceof Error ? err.message : String(err));
      await this.notify(`Failed to add "${safeName}"`, 'error');
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FILE_MANAGER_ID = 'abjects:file-manager' as AbjectId;
