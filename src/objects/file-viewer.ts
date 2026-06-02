/**
 * FileViewer -- quick preview window for files stored in the workspace
 * FileSystem. Images render inline (decoded from base64); text/code files
 * render in a scrollable monospace pane. Opened by FileManager via openFile().
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

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

export class FileViewer extends Abject {
  private fileSystemId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private titleLabelId?: AbjectId;
  private contentScrollId?: AbjectId;
  private contentWidgetIds: AbjectId[] = [];

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
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display file preview window', required: true },
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
        margins: { top: 8, right: 12, bottom: 8, left: 12 },
        spacing: 6,
      })
    );

    const { widgetIds: [titleId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'label', windowId: this.windowId, text: 'Select a file to preview',
          style: { fontSize: 13, fontWeight: 'bold', color: this.theme.textSecondary, wordWrap: false },
        }],
      })
    );
    this.titleLabelId = titleId;

    this.contentScrollId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 4, right: 4, bottom: 4, left: 4 },
        spacing: 4,
      })
    );

    // Root children: title (fixed) then content (expanding). The content
    // scroll layout was auto-added expanding; insert the title above it.
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.titleLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 22 },
    }));

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
    if (!this.windowId) {
      await this.show();
    } else {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
      } catch { /* best effort */ }
    }

    const name = path.split('/').filter(Boolean).pop() ?? path;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

    await this.request(request(this.id, this.titleLabelId!, 'update', {
      text: name,
      style: { color: this.theme.textPrimary },
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
      await this.addContentLabel(`Could not open "${name}".`, { color: this.theme.textSecondary });
    }
    return true;
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
      await this.addContentLabel('(empty file)', { color: this.theme.textSecondary });
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
      `No preview available for .${ext || 'file'}${sizeNote}`,
      { color: this.theme.textSecondary },
    );
  }

  private async addContentLabel(text: string, style: Record<string, unknown>): Promise<void> {
    const { widgetIds: [id] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'label', windowId: this.windowId, text, style: { fontSize: 13, wordWrap: true, ...style } }],
      })
    );
    this.contentWidgetIds.push(id);
    await this.request(request(this.id, this.contentScrollId!, 'addLayoutChild', {
      widgetId: id,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 40 },
    }));
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FILE_VIEWER_ID = 'abjects:file-viewer' as AbjectId;
