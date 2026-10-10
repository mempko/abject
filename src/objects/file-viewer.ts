/**
 * FileViewer -- quick preview window for files stored in the workspace
 * FileSystem. Images render inline (decoded from base64); text/code files
 * render in a scrollable monospace pane. Opened by FileManager via openFile().
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { sectionHeaderStyle, sectionHeaderText, emptyStateMarkdown, emptyStateStyle } from './ui-kit.js';

const log = new Log('FileViewer');

const FILE_VIEWER_INTERFACE: InterfaceId = 'abjects:file-viewer';

const WIN_W = 560;
const WIN_H = 520;

/** Image extensions → the data-URI media type used to render them. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** Extensions previewable as plain text. */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml',
  'ini', 'conf', 'env', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss',
  'html', 'htm', 'xml', 'svg', 'sh', 'bash', 'zsh', 'py', 'rb', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'sql', 'gitignore', 'gql', 'graphql',
]);

/** Max characters of a text file rendered in the preview. */
const MAX_TEXT_CHARS = 200_000;

/** Arrowing through files flashes once, not once per file. */
const ARRIVAL_FLASH_GAP_MS = 1500;

export class FileViewer extends Abject {
  private fileSystemId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private titleLabelId?: AbjectId;
  private contentScrollId?: AbjectId;
  private contentWidgetIds: AbjectId[] = [];
  /** When the last arrival flash played. */
  private lastArrivalFlashAt = 0;

  constructor() {
    super({
      manifest: {
        name: 'FileViewer',
        description:
          'Quick preview window for files in the workspace filesystem. Renders images inline and text/code files in a scrollable monospace pane.',
        version: '1.0.0',
        interface: {
          id: FILE_VIEWER_INTERFACE,
          name: 'FileViewer',
          description: 'File preview window',
          methods: [
            {
              name: 'openFile',
              description: 'Open a file from the workspace filesystem in the preview window',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Path of the file to preview' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            { name: 'show', description: 'Show the preview window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'hide', description: 'Hide the preview window', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'getState', description: 'Get window visibility', parameters: [], returns: { kind: 'object', properties: { visible: { kind: 'primitive', primitive: 'boolean' } } } },
          ],
        },
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.fileSystemId = await this.discoverDep('FileSystem') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({ visible: !!this.windowId }));
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('openFile', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.openFile(path);
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
    const winX = Math.max(40, Math.floor((displayInfo.width - WIN_W) / 2) + 40);
    const winY = Math.max(40, Math.floor((displayInfo.height - WIN_H) / 2) + 40);

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '👁 Preview',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 220,
        resizable: true,
      })
    );

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
        spacing: 8,
      })
    );

    const { widgetIds: [titleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'label', windowId: this.windowId, text: sectionHeaderText(this.theme, 'Preview'),
          style: { ...sectionHeaderStyle(this.theme), wordWrap: false },
        }],
      })
    );
    this.titleLabelId = titleId;

    // Root children: title (fixed) then content (expanding). Add the title
    // first so it sits above the content scroll layout, which the nested
    // create auto-adds (expanding) to the root.
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.titleLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 22 },
    }));

    this.contentScrollId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 8,
      })
    );

    // Empty state until a file is opened (openFile clears the content).
    await this.addContentLabel(
      emptyStateMarkdown(
        'Nothing to preview yet',
        'Select a file in Files to see it here. Text and code show in full; images show at a size that fits the window.',
      ),
      { ...emptyStateStyle(this.theme) },
      WIN_H - 140,
    );

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.titleLabelId = undefined;
    this.contentScrollId = undefined;
    this.contentWidgetIds = [];
    this.changed('visibility', false);
    return true;
  }

  // ── Preview ─────────────────────────────────────────────────────────

  async openFile(path: string): Promise<boolean> {
    if (!this.fileSystemId) return false;
    // A fresh window plays its own open transition; an open one flashes
    // when the new file arrives.
    const freshWindow = !this.windowId;
    if (!this.windowId) {
      await this.show();
    } else {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
      } catch { /* best effort */ }
    }

    const name = path.split('/').filter(Boolean).pop() ?? path;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

    // The file name is user data: header face, original case.
    await this.request(request(this.id, this.titleLabelId!, 'update', {
      text: name,
      style: { color: this.theme.textHeading },
    }));

    // Clear any previous preview content.
    await this.request(request(this.id, this.contentScrollId!, 'clearLayoutChildren', {}));
    this.contentWidgetIds = [];

    try {
      if (IMAGE_MIME[ext]) {
        await this.renderImage(path, IMAGE_MIME[ext]);
      } else if (TEXT_EXTS.has(ext) || ext === '') {
        await this.renderText(path);
      } else {
        await this.renderUnsupported(path, ext);
      }
    } catch (err) {
      log.warn(`Failed to preview ${path}:`, err instanceof Error ? err.message : String(err));
      await this.addContentLabel(
        emptyStateMarkdown(
          `Could not open "${name}"`,
          'It may have been moved or removed. Press Refresh in Files and select it again.',
        ),
        { ...emptyStateStyle(this.theme), color: this.theme.statusError },
        120,
      );
      this.playEffect('glitch');
      return true;
    }
    if (!freshWindow && Date.now() - this.lastArrivalFlashAt >= ARRIVAL_FLASH_GAP_MS) {
      this.lastArrivalFlashAt = Date.now();
      this.playEffect('flash');
    }
    return true;
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
  }

  private async renderImage(path: string, mime: string): Promise<void> {
    const base64 = await this.request<string>(
      request(this.id, this.fileSystemId!, 'readFileBytes', { path }), 30000);
    const { widgetIds: [imgId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'image', windowId: this.windowId, url: `data:${mime};base64,${base64}`, fit: 'contain' }],
      })
    );
    this.contentWidgetIds.push(imgId);
    await this.request(request(this.id, this.contentScrollId!, 'addLayoutChild', {
      widgetId: imgId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: WIN_H - 120 },
    }));
  }

  private async renderText(path: string): Promise<void> {
    let text = await this.request<string>(
      request(this.id, this.fileSystemId!, 'readFile', { path }), 30000);
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]';
    }
    if (text.length === 0) {
      await this.addContentLabel(
        emptyStateMarkdown('This file is empty', 'It has no contents yet. Anything written to it will show here when you open it again.'),
        { ...emptyStateStyle(this.theme) },
        120,
      );
      return;
    }
    const lineCount = text.split('\n').length;
    const estHeight = Math.max(80, lineCount * 18 + 16);
    const { widgetIds: [textId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'label', windowId: this.windowId, text,
          style: {
            wordWrap: true, fontFamily: 'mono', fontSize: 12, selectable: true,
            color: this.theme.textPrimary,
          },
        }],
      })
    );
    this.contentWidgetIds.push(textId);
    await this.request(request(this.id, this.contentScrollId!, 'addLayoutChild', {
      widgetId: textId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: estHeight },
    }));
  }

  private async renderUnsupported(path: string, ext: string): Promise<void> {
    let sizeNote = '';
    try {
      const info = await this.request<{ size: number } | null>(
        request(this.id, this.fileSystemId!, 'stat', { path }), 10000);
      if (info) sizeNote = ` · ${formatSize(info.size)}`;
    } catch { /* ignore */ }
    await this.addContentLabel(
      emptyStateMarkdown(
        `No preview for .${ext || 'file'} files${sizeNote}`,
        'Text, code and image files preview here. This file is stored safely and agents can still read it.',
      ),
      { ...emptyStateStyle(this.theme) },
      120,
    );
  }

  private async addContentLabel(text: string, style: Record<string, unknown>, height = 40): Promise<void> {
    const { widgetIds: [id] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'label', windowId: this.windowId, text, style: { fontSize: 13, wordWrap: true, ...style } }],
      })
    );
    this.contentWidgetIds.push(id);
    await this.request(request(this.id, this.contentScrollId!, 'addLayoutChild', {
      widgetId: id,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height },
    }));
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FILE_VIEWER_ID = 'abjects:file-viewer' as AbjectId;
