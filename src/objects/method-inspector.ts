/**
 * MethodInspector — focused, per-object method explorer (global).
 *
 * A pared-down cousin of ObjectBrowser. Where ObjectBrowser browses every
 * Abject kind across four panes, MethodInspector pins to a single live object
 * and shows just the two right-hand panes:
 *
 *   Pane A: Methods & events for the target object.
 *   Pane B: Detail (signature, description, Find Implementors / Find Senders,
 *           and an inline Send Message form that calls the target directly).
 *
 * Every non-chromeless window title bar carries a help (?) button. Clicking it
 * makes WindowManager → WindowAbject → WidgetManager broadcast a
 * 'windowHelpRequested' event with the window's owner attached. MethodInspector
 * watches that broadcast and opens an inspector window aimed at the owner, so
 * any window can be cracked open and poked at live.
 *
 * MethodInspector owns one window per inspected target (a fresh inspector for
 * each ? click); clicking ? again on the same object raises its existing
 * window. State is held per-window in a Session so several inspectors can be
 * open at once.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  InterfaceDeclaration,
  MethodDeclaration,
  ObjectRegistration,
  TypeDeclaration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MethodInspector');

const METHOD_INSPECTOR_INTERFACE: InterfaceId = 'abjects:method-inspector' as InterfaceId;
export const METHOD_INSPECTOR_ID = 'abjects:method-inspector' as AbjectId;

const WIN_W = 560;
const WIN_H = 460;

/** Introspect result returned by an object's `describe` handler. */
interface DescribeResult {
  manifest: { name: string; description?: string; interface?: InterfaceDeclaration };
  description: string;
}

type MethodEntry = { type: 'method' | 'event'; name: string; decl?: MethodDeclaration };

/** Per-window inspector state. One Session per inspected object. */
interface Session {
  windowId: AbjectId;
  targetId: AbjectId;
  targetName: string;
  iface?: InterfaceDeclaration;
  methods: MethodEntry[];
  /** Flat snapshot of every registered object, for implementors/senders lookups. */
  allRegs: ObjectRegistration[];

  selected?: { type: 'method' | 'event'; name: string };
  detailMode: 'detail' | 'implementors' | 'senders';

  /** Set when the target is a ScriptableAbject (exposes getSource). */
  editorId?: AbjectId;

  // Pane widgets
  editSourceBtnId?: AbjectId;
  methodsListId?: AbjectId;
  detailLayoutId?: AbjectId;
  detailLabelIds: AbjectId[];
  detailButtonIds: Map<AbjectId, string>;
  msgParamInputIds: Map<string, AbjectId>;
  msgSendBtnId?: AbjectId;
  msgResponseLabelId?: AbjectId;

  /** Every event-bearing widget in this session, for routing 'changed' events. */
  widgetIds: Set<AbjectId>;
}

export class MethodInspector extends Abject {
  private widgetManagerId?: AbjectId;
  private objectCatalogId?: AbjectId;
  private subscribedToWidgetManager = false;

  private sessions: Map<AbjectId, Session> = new Map(); // windowId → Session

  constructor() {
    super({
      manifest: {
        name: 'MethodInspector',
        description:
          'Focused single-object method explorer. Opened from a window\'s help (?) button — lists the object\'s methods and events and lets you inspect and call them live.',
        version: '1.0.0',
        interface: {
          id: METHOD_INSPECTOR_INTERFACE,
          name: 'MethodInspector',
          description: 'Two-pane inspector for a single live Abject',
          methods: [
            {
              name: 'inspect',
              description: 'Open an inspector window for a live object by AbjectId',
              parameters: [
                { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId of the object to inspect' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return the set of currently open inspector targets',
              parameters: [],
              returns: { kind: 'object', properties: {
                open: { kind: 'primitive', primitive: 'number' },
              } },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display inspector windows', required: true },
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
    this.objectCatalogId = await this.discoverDep('ObjectCatalog') ?? undefined;

    // Watch WidgetManager's window lifecycle broadcasts for help (?) clicks.
    if (this.widgetManagerId && !this.subscribedToWidgetManager) {
      this.send(request(this.id, this.widgetManagerId, 'addDependent', {}));
      this.subscribedToWidgetManager = true;
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## MethodInspector Usage Guide

MethodInspector is a focused two-pane explorer for a single live Abject. It is
the tool behind the help (?) button on every window title bar.

Pane A lists the target object's methods and events.
Pane B shows the selected method's signature and description, with buttons to
find implementors and senders, plus an inline form to call the method live.

### Inspect an object by id

  await call(await dep('MethodInspector'), 'inspect', { objectId: someAbjectId });

### How the help (?) button works

Clicking a window's ? button broadcasts 'windowHelpRequested' from WidgetManager
with the window's owner attached. MethodInspector opens an inspector for that
owner. Clicking ? again on the same object raises its existing window.

### IMPORTANT
- The interface ID is '${METHOD_INSPECTOR_INTERFACE}'.
- The target object's interface is read live via its 'describe' handler, so any
  object in any workspace can be inspected.`;
  }

  private setupHandlers(): void {
    // Help (?) button broadcast from WidgetManager — open inspector for owner.
    this.on('windowHelpRequested', async (msg: AbjectMessage) => {
      const { ownerId } = msg.payload as { windowId?: AbjectId; ownerId?: AbjectId };
      if (ownerId) await this.inspect(ownerId);
    });

    // Programmatic / interface entry point.
    this.on('inspect', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      if (objectId) await this.inspect(objectId);
      return true;
    });

    this.on('getState', async () => ({ open: this.sessions.size }));

    // Our own inspector window's close button.
    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      const { windowId } = msg.payload as { windowId: AbjectId };
      await this.closeSession(windowId);
    });

    // WidgetManager also broadcasts these to us as a dependent; ignore quietly.
    this.on('windowCreated', async () => { /* not interested */ });
    this.on('windowDestroyed', async (msg: AbjectMessage) => {
      const { windowId } = msg.payload as { windowId?: AbjectId };
      if (windowId && this.sessions.has(windowId)) this.sessions.delete(windowId);
    });

    // Widget events (list selection, button clicks, input submit).
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      await this.handleWidgetEvent(msg.routing.from, aspect, value);
    });
  }

  // ── Open / close ───────────────────────────────────────────────────

  private sessionForTarget(targetId: AbjectId): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.targetId === targetId) return s;
    }
    return undefined;
  }

  private async inspect(targetId: AbjectId): Promise<void> {
    if (!this.widgetManagerId) return;

    // Already inspecting this target — raise its window.
    const existing = this.sessionForTarget(targetId);
    if (existing) {
      try {
        await this.request(request(this.id, this.widgetManagerId, 'raiseWindow', {
          windowId: existing.windowId,
        }));
      } catch { /* window gone — fall through to rebuild */ }
      if (this.sessions.has(existing.windowId)) return;
    }

    // Read the target's interface live via its introspect 'describe' handler.
    let describe: DescribeResult;
    try {
      describe = await this.request<DescribeResult>(
        request(this.id, targetId, 'describe', {})
      );
    } catch {
      await this.notify('Could not inspect that object (no response)', 'error');
      return;
    }

    const iface = describe.manifest?.interface;
    const targetName = describe.manifest?.name ?? 'Object';

    const methods: MethodEntry[] = [];
    if (iface) {
      for (const m of iface.methods ?? []) methods.push({ type: 'method', name: m.name, decl: m });
      const events = (iface as InterfaceDeclaration & { events?: MethodDeclaration[] }).events ?? [];
      for (const e of events) methods.push({ type: 'event', name: e.name, decl: e });
    }

    const { allRegs, objectsByKey } = await this.loadCatalog();

    // A ScriptableAbject exposes a live getSource handler — that's our signal
    // that the object has editable source and can be opened in AbjectEditor.
    const isScriptable = methods.some(m => m.type === 'method' && m.name === 'getSource');

    const session: Session = {
      windowId: '' as AbjectId,
      targetId,
      targetName,
      iface,
      methods,
      allRegs,
      detailMode: 'detail',
      editorId: isScriptable ? this.findEditorForTarget(targetId, objectsByKey) : undefined,
      detailLabelIds: [],
      detailButtonIds: new Map(),
      msgParamInputIds: new Map(),
      widgetIds: new Set(),
    };

    await this.buildWindow(session, describe.manifest?.description, isScriptable);
    this.sessions.set(session.windowId, session);

    await this.rebuildMethods(session);
    await this.rebuildDetail(session);
  }

  private async closeSession(windowId: AbjectId): Promise<void> {
    const session = this.sessions.get(windowId);
    if (!session) return;
    this.sessions.delete(windowId);
    try {
      await this.request(request(this.id, this.widgetManagerId!,
        'destroyWindowAbject', { windowId }));
    } catch { /* already gone */ }
  }

  /**
   * Read every registered object across all registries from ObjectCatalog.
   * Returns a flat, de-duplicated list (for implementors/senders) plus the
   * per-registry grouping (so we can find the target's own AbjectEditor).
   */
  private async loadCatalog(): Promise<{ allRegs: ObjectRegistration[]; objectsByKey: Map<string, ObjectRegistration[]> }> {
    if (!this.objectCatalogId) {
      this.objectCatalogId = await this.discoverDep('ObjectCatalog') ?? undefined;
    }
    const objectsByKey = new Map<string, ObjectRegistration[]>();
    const allRegs: ObjectRegistration[] = [];
    if (!this.objectCatalogId) return { allRegs, objectsByKey };
    try {
      const snapshot = await this.request<{ objects: Array<[string, ObjectRegistration[]]> }>(
        request(this.id, this.objectCatalogId, 'getSnapshot', {})
      );
      const seen = new Set<string>();
      for (const [key, regs] of snapshot.objects ?? []) {
        objectsByKey.set(key, regs);
        for (const reg of regs) {
          if (!seen.has(reg.id)) { seen.add(reg.id); allRegs.push(reg); }
        }
      }
    } catch {
      log.warn('Could not read ObjectCatalog snapshot');
    }
    return { allRegs, objectsByKey };
  }

  /** Find the AbjectEditor registered in the same workspace registry as the target. */
  private findEditorForTarget(targetId: AbjectId, objectsByKey: Map<string, ObjectRegistration[]>): AbjectId | undefined {
    for (const [, regs] of objectsByKey) {
      if (regs.some(r => r.id === targetId)) {
        const editor = regs.find(r => r.manifest.name === 'AbjectEditor');
        return editor?.id as AbjectId | undefined;
      }
    }
    return undefined;
  }

  // ── Widget helpers ───────────────────────────────────────────────────

  private async wm(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request(request(this.id, this.widgetManagerId!, method, payload));
  }

  /** addDependent so we receive the widget's events, and track it on the session. */
  private async addDep(session: Session, widgetId: AbjectId): Promise<void> {
    session.widgetIds.add(widgetId);
    await this.request(request(this.id, widgetId, 'addDependent', {}));
  }

  // ── Build window ─────────────────────────────────────────────────────

  private async buildWindow(session: Session, description: string | undefined, scriptable: boolean): Promise<void> {
    const wm = this.wm.bind(this);

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    // Cascade windows a little so stacked inspectors don't perfectly overlap.
    const offset = (this.sessions.size % 6) * 28;
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2) + offset);
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2) + offset);

    const windowId = await wm('createWindowAbject', {
      title: `🔍 ${session.targetName}`,
      rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
      resizable: true,
    }) as AbjectId;
    session.windowId = windowId;

    const rootLayoutId = await wm('createVBox', {
      windowId,
      margins: { top: 6, right: 8, bottom: 6, left: 8 },
      spacing: 4,
    }) as AbjectId;

    // Header (object name + description) + divider.
    const headerText = session.targetName;
    const subText = description
      ? (description.length > 160 ? description.slice(0, 157) + '...' : description)
      : '';
    const headerSpecs: Array<Record<string, unknown>> = [
      { type: 'label', windowId, text: headerText, style: { fontSize: 15, fontWeight: 'bold', selectable: true } },
    ];
    if (subText) {
      headerSpecs.push({ type: 'label', windowId, text: subText, style: { fontSize: 12, wordWrap: true, selectable: true } });
    }
    headerSpecs.push({ type: 'divider', windowId });

    const { widgetIds: headerIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: headerSpecs })
    );
    let hi = 0;
    await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
      widgetId: headerIds[hi++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 20 },
    }));
    if (subText) {
      const lines = Math.max(1, Math.ceil(subText.length / 60));
      await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
        widgetId: headerIds[hi++], sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: Math.max(16, lines * 16) },
      }));
    }
    await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
      widgetId: headerIds[hi++], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 1 },
    }));

    // Edit Source button (ScriptableAbjects only) — opens the source editor for
    // the target. Sits under the description, above the two panes.
    if (scriptable) {
      const { widgetIds: [editBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'button', windowId, text: 'Edit Source', style: { fontSize: 11 } },
        ]})
      );
      session.editSourceBtnId = editBtnId;
      await this.addDep(session, editBtnId);
      await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
        widgetId: editBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 120, height: 26 },
      }));
    }

    // Two-pane split: methods list (left) | detail (right).
    const { widgetIds: [splitId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'splitPane', windowId, orientation: 'horizontal', dividerPosition: 0.42, minSize: 130 },
      ]})
    );
    await this.request(request(this.id, rootLayoutId, 'addLayoutChild', {
      widgetId: splitId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const { widgetIds: [methodsListId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'list', windowId, items: [], searchable: true },
      ]})
    );
    session.methodsListId = methodsListId;
    await this.addDep(session, methodsListId);

    const detailLayoutId = await wm('createDetachedScrollableVBox', {
      windowId,
      margins: { top: 4, right: 8, bottom: 4, left: 8 },
      spacing: 4,
    }) as AbjectId;
    session.detailLayoutId = detailLayoutId;

    await this.request(request(this.id, splitId, 'setLeftChild', { widgetId: methodsListId }));
    await this.request(request(this.id, splitId, 'setRightChild', { widgetId: detailLayoutId }));
  }

  // ── Methods pane ─────────────────────────────────────────────────────

  private async rebuildMethods(session: Session): Promise<void> {
    if (!session.methodsListId) return;
    const items = session.methods.map(m => ({
      label: `▸ ${m.name}`,
      value: `${m.type}:${m.name}`,
      secondary: m.type === 'event' ? 'event' : '',
    }));
    let selectedIndex = -1;
    if (session.selected) {
      selectedIndex = session.methods.findIndex(
        m => m.type === session.selected!.type && m.name === session.selected!.name
      );
    }
    await this.request(request(this.id, session.methodsListId, 'update', { items, selectedIndex }));
  }

  // ── Detail pane ──────────────────────────────────────────────────────

  private async clearDetail(session: Session): Promise<void> {
    if (!session.detailLayoutId) return;
    try {
      await this.request(request(this.id, session.detailLayoutId, 'clearLayoutChildren', {}));
    } catch { /* gone */ }

    const ids = [
      ...session.detailLabelIds,
      ...session.detailButtonIds.keys(),
      ...session.msgParamInputIds.values(),
    ];
    if (session.msgSendBtnId) ids.push(session.msgSendBtnId);
    if (session.msgResponseLabelId) ids.push(session.msgResponseLabelId);
    for (const id of ids) {
      session.widgetIds.delete(id);
      this.send(request(this.id, id, 'destroy', {}));
    }
    session.detailLabelIds = [];
    session.detailButtonIds.clear();
    session.msgParamInputIds.clear();
    session.msgSendBtnId = undefined;
    session.msgResponseLabelId = undefined;
  }

  private async rebuildDetail(session: Session): Promise<void> {
    if (!session.detailLayoutId) return;
    await this.clearDetail(session);

    if (session.detailMode === 'implementors') {
      await this.rebuildCrossRefs(session, 'implementors');
    } else if (session.detailMode === 'senders') {
      await this.rebuildCrossRefs(session, 'senders');
    } else if (session.selected) {
      await this.rebuildMethodDetail(session);
    } else {
      await this.addPlainLabel(session, 'Select a method or event to inspect it.', 12);
    }
  }

  private async addPlainLabel(session: Session, text: string, fontSize = 12): Promise<void> {
    const { widgetIds: [id] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: [
        { type: 'label', windowId: session.windowId, text, style: { fontSize, wordWrap: true, selectable: true } },
      ]})
    );
    session.detailLabelIds.push(id);
    const lines = Math.max(1, Math.ceil(text.length / 40));
    await this.request(request(this.id, session.detailLayoutId!, 'addLayoutChild', {
      widgetId: id, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: Math.max(16, lines * 16) },
    }));
  }

  private async rebuildMethodDetail(session: Session): Promise<void> {
    const sel = session.selected!;
    const method = session.methods.find(m => m.type === sel.type && m.name === sel.name);
    if (!method) {
      await this.addPlainLabel(session, `${sel.name} — not found`);
      return;
    }

    type LabelSpec = { text: string; secondary: boolean; style?: Record<string, unknown> };
    const labels: LabelSpec[] = [];

    const typeBadge = method.type === 'event' ? '[Event]' : '[Method]';
    labels.push({ text: `${typeBadge} ${method.name}`, secondary: false, style: { fontWeight: 'bold', fontSize: 14 } });

    const params = method.decl?.parameters ?? [];
    const paramStr = params.map(p => `${p.name}: ${p.type ? this.formatType(p.type) : 'any'}`).join(', ');
    labels.push({ text: `(${paramStr})`, secondary: true });
    if (method.decl?.returns) {
      labels.push({ text: `→ ${this.formatType(method.decl.returns)}`, secondary: true });
    }
    if (method.decl?.description) {
      labels.push({ text: method.decl.description, secondary: true });
    }
    if (session.iface) {
      labels.push({ text: `Interface: ${session.iface.id}`, secondary: true });
    }
    labels.push({ text: '───', secondary: true });

    // Cross-reference buttons (methods only).
    const navBtns: Array<{ text: string; action: string }> = [];
    if (method.type === 'method') {
      navBtns.push({ text: 'Find Implementors', action: `implementors:${method.name}` });
      navBtns.push({ text: 'Find Senders', action: `senders:${method.name}` });
    }

    // Send Message form (methods only).
    const hasSend = method.type === 'method';
    const inputSpecs: Array<{ paramName: string; placeholder: string; label: string }> = [];
    if (hasSend) {
      if (params.length === 0) {
        inputSpecs.push({ paramName: '__raw_json__', label: 'payload (JSON)', placeholder: 'JSON payload... (leave empty for {})' });
      } else {
        for (const p of params) {
          const typeStr = p.type ? this.formatType(p.type) : 'any';
          const optLabel = p.optional ? ' (optional)' : '';
          const isComplex = p.type?.kind === 'object' || p.type?.kind === 'array';
          inputSpecs.push({
            paramName: p.name,
            label: `${p.name}: ${typeStr}${optLabel}`,
            placeholder: isComplex ? `JSON ${typeStr}...` : (p.description || `${typeStr} value...`),
          });
        }
      }
    }

    // ── Build batch specs in layout order ──
    interface Spec { type: string; windowId: AbjectId; text?: string; placeholder?: string; style?: Record<string, unknown> }
    const specs: Spec[] = [];
    const win = session.windowId;

    const labelStart = specs.length;
    for (const l of labels) {
      specs.push({ type: 'label', windowId: win, text: l.text, style: { fontSize: l.secondary ? 12 : 13, wordWrap: true, selectable: true, ...(l.style ?? {}) } });
    }
    const navStart = specs.length;
    for (const b of navBtns) {
      specs.push({ type: 'button', windowId: win, text: b.text, style: { fontSize: 11 } });
    }

    let sendHeaderIdx = -1;
    const paramLabelIdx: number[] = [];
    const inputIdx: number[] = [];
    let sendBtnIdx = -1;
    let responseIdx = -1;
    if (hasSend) {
      sendHeaderIdx = specs.length;
      specs.push({ type: 'label', windowId: win, text: '─── Send Message', style: { fontSize: 12, wordWrap: true } });
      for (const ins of inputSpecs) {
        paramLabelIdx.push(specs.length);
        specs.push({ type: 'label', windowId: win, text: ins.label, style: { fontSize: 12, wordWrap: true } });
        inputIdx.push(specs.length);
        specs.push({ type: 'textInput', windowId: win, placeholder: ins.placeholder, text: '' });
      }
      sendBtnIdx = specs.length;
      specs.push({ type: 'button', windowId: win, text: `Send to ${session.targetName}`, style: { fontSize: 11, background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } });
      responseIdx = specs.length;
      specs.push({ type: 'label', windowId: win, text: '', style: { fontSize: 12, wordWrap: true, selectable: true } });
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: specs as unknown as Array<Record<string, unknown>> })
    );

    // ── Track ──
    for (let i = labelStart; i < navStart; i++) session.detailLabelIds.push(widgetIds[i]);
    for (let i = 0; i < navBtns.length; i++) session.detailButtonIds.set(widgetIds[navStart + i], navBtns[i].action);
    if (hasSend) {
      session.detailLabelIds.push(widgetIds[sendHeaderIdx]);
      for (let i = 0; i < inputSpecs.length; i++) {
        session.detailLabelIds.push(widgetIds[paramLabelIdx[i]]);
        session.msgParamInputIds.set(inputSpecs[i].paramName, widgetIds[inputIdx[i]]);
      }
      session.msgSendBtnId = widgetIds[sendBtnIdx];
      session.msgResponseLabelId = widgetIds[responseIdx];
      session.detailLabelIds.push(session.msgResponseLabelId);
    }

    // ── Layout ──
    const children: Array<{ widgetId: AbjectId; sizePolicy?: Record<string, string>; preferredSize?: Record<string, number> }> = [];
    for (let i = labelStart; i < navStart; i++) {
      const l = labels[i - labelStart];
      const lh = l.secondary ? 16 : 18;
      const lines = Math.max(1, Math.ceil(l.text.length / 40));
      children.push({ widgetId: widgetIds[i], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: Math.max(lh, lines * lh) } });
    }
    for (let i = 0; i < navBtns.length; i++) {
      children.push({ widgetId: widgetIds[navStart + i], sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 160, height: 26 } });
    }
    if (hasSend) {
      children.push({ widgetId: widgetIds[sendHeaderIdx], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 16 } });
      for (let i = 0; i < inputSpecs.length; i++) {
        const lblLines = Math.max(1, Math.ceil(inputSpecs[i].label.length / 40));
        children.push({ widgetId: widgetIds[paramLabelIdx[i]], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: Math.max(16, lblLines * 16) } });
        children.push({ widgetId: widgetIds[inputIdx[i]], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 30 } });
      }
      children.push({ widgetId: widgetIds[sendBtnIdx], sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 180, height: 26 } });
      children.push({ widgetId: widgetIds[responseIdx], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 16 } });
    }
    await this.request(request(this.id, session.detailLayoutId!, 'addLayoutChildren', { children }));

    // ── Wire events ──
    for (let i = 0; i < navBtns.length; i++) await this.addDep(session, widgetIds[navStart + i]);
    if (hasSend) {
      await this.addDep(session, widgetIds[sendBtnIdx]);
      for (const idx of inputIdx) await this.addDep(session, widgetIds[idx]);
    }
  }

  /** Implementors / senders cross-reference list with a Back button. */
  private async rebuildCrossRefs(session: Session, mode: 'implementors' | 'senders'): Promise<void> {
    const sel = session.selected;
    if (!sel) return;
    const methodName = sel.name;

    const names: string[] = [];
    if (mode === 'implementors') {
      for (const reg of session.allRegs) {
        const iface = reg.manifest.interface;
        if (iface && (iface.methods ?? []).some(m => m.name === methodName)) {
          if (!names.includes(reg.manifest.name)) names.push(reg.manifest.name);
        }
      }
    } else {
      const pattern = new RegExp(`['"]${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
      for (const reg of session.allRegs) {
        const source = (reg as unknown as { source?: string }).source;
        if (source && pattern.test(source)) {
          if (!names.includes(reg.manifest.name)) names.push(reg.manifest.name);
        }
      }
    }
    names.sort();

    const header = mode === 'implementors'
      ? `Implementors of "${methodName}"`
      : `Senders of "${methodName}"`;

    const specs: Array<Record<string, unknown>> = [
      { type: 'button', windowId: session.windowId, text: '◀ Back', style: { fontSize: 11 } },
      { type: 'label', windowId: session.windowId, text: header, style: { fontSize: 13, fontWeight: 'bold', wordWrap: true } },
    ];
    if (names.length === 0) {
      specs.push({ type: 'label', windowId: session.windowId, text: mode === 'implementors' ? 'No implementors found.' : 'No senders found.', style: { fontSize: 12, wordWrap: true } });
    } else {
      for (const name of names) {
        specs.push({ type: 'button', windowId: session.windowId, text: name, style: { fontSize: 11 } });
      }
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );

    const children: Array<{ widgetId: AbjectId; sizePolicy?: Record<string, string>; preferredSize?: Record<string, number> }> = [];
    // Back button
    session.detailButtonIds.set(widgetIds[0], 'back');
    children.push({ widgetId: widgetIds[0], sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 24 } });
    // Header
    session.detailLabelIds.push(widgetIds[1]);
    const hLines = Math.max(1, Math.ceil(header.length / 40));
    children.push({ widgetId: widgetIds[1], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: Math.max(18, hLines * 18) } });

    if (names.length === 0) {
      session.detailLabelIds.push(widgetIds[2]);
      children.push({ widgetId: widgetIds[2], sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 16 } });
    } else {
      for (let i = 0; i < names.length; i++) {
        const btnId = widgetIds[2 + i];
        session.detailButtonIds.set(btnId, `inspectKind:${names[i]}`);
        children.push({ widgetId: btnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 160, height: 26 } });
      }
    }

    await this.request(request(this.id, session.detailLayoutId!, 'addLayoutChildren', { children }));

    await this.addDep(session, widgetIds[0]);
    for (let i = 0; i < names.length; i++) await this.addDep(session, widgetIds[2 + i]);
  }

  // ── Event routing ────────────────────────────────────────────────────

  private sessionForWidget(widgetId: AbjectId): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.widgetIds.has(widgetId)) return s;
    }
    return undefined;
  }

  private async handleWidgetEvent(fromId: AbjectId, aspect: string, value: unknown): Promise<void> {
    const session = this.sessionForWidget(fromId);
    if (!session) return; // not one of our widgets (e.g. WidgetManager broadcasts)

    // Edit Source (ScriptableAbjects)
    if (fromId === session.editSourceBtnId && aspect === 'click') {
      await this.openSourceEditor(session);
      return;
    }

    // Methods list selection
    if (fromId === session.methodsListId && aspect === 'selectionChanged') {
      const sel = JSON.parse(String(value)) as { value: string };
      const [type, name] = sel.value.split(':') as ['method' | 'event', string];
      session.selected = { type, name };
      session.detailMode = 'detail';
      await this.rebuildDetail(session);
      return;
    }

    // Detail buttons (cross-ref nav, back, inspect-kind)
    if (session.detailButtonIds.has(fromId) && aspect === 'click') {
      const action = session.detailButtonIds.get(fromId)!;
      await this.handleDetailAction(session, action);
      return;
    }

    // Send message
    if (fromId === session.msgSendBtnId && aspect === 'click') {
      await this.handleSendMessage(session);
      return;
    }
    for (const [, inputId] of session.msgParamInputIds) {
      if (fromId === inputId && aspect === 'submit') {
        await this.handleSendMessage(session);
        return;
      }
    }
  }

  private async handleDetailAction(session: Session, action: string): Promise<void> {
    if (action.startsWith('implementors:')) {
      session.detailMode = 'implementors';
      await this.rebuildDetail(session);
    } else if (action.startsWith('senders:')) {
      session.detailMode = 'senders';
      await this.rebuildDetail(session);
    } else if (action === 'back') {
      session.detailMode = 'detail';
      await this.rebuildDetail(session);
    } else if (action.startsWith('inspectKind:')) {
      const kind = action.substring('inspectKind:'.length);
      const reg = session.allRegs.find(r => r.manifest.name === kind);
      if (reg) await this.inspect(reg.id as AbjectId);
    }
  }

  /** Open the source editor for a ScriptableAbject target. */
  private async openSourceEditor(session: Session): Promise<void> {
    // Prefer the target's own-workspace editor; fall back to any reachable one.
    // AbjectEditor.show fetches source live via the object's getSource handler,
    // so any editor can edit any object.
    let editorId = session.editorId;
    if (!editorId) {
      editorId = await this.discoverDep('AbjectEditor') ?? undefined;
      session.editorId = editorId;
    }
    if (!editorId) {
      await this.notify('No source editor available', 'error');
      return;
    }
    try {
      await this.request(request(this.id, editorId, 'show', { objectId: session.targetId }));
    } catch {
      await this.notify('Could not open the source editor', 'error');
    }
  }

  private async handleSendMessage(session: Session): Promise<void> {
    if (!session.selected || !session.msgResponseLabelId) return;
    const method = session.methods.find(m => m.type === session.selected!.type && m.name === session.selected!.name);
    const paramDecls = method?.decl?.parameters ?? [];

    let payload: Record<string, unknown> = {};
    const rawJsonInputId = session.msgParamInputIds.get('__raw_json__');
    if (rawJsonInputId && paramDecls.length === 0) {
      let raw = '';
      try { raw = (await this.request<string>(request(this.id, rawJsonInputId, 'getValue', {})) ?? '').trim(); } catch { raw = ''; }
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch { await this.showFeedback(session, 'Error: invalid JSON payload'); return; }
    } else {
      for (const p of paramDecls) {
        const inputId = session.msgParamInputIds.get(p.name);
        if (!inputId) continue;
        let raw = '';
        try { raw = (await this.request<string>(request(this.id, inputId, 'getValue', {})) ?? '').trim(); } catch { raw = ''; }
        if (raw === '' && p.optional) continue;
        if (raw === '' && !p.optional) { await this.showFeedback(session, `Error: "${p.name}" is required`); return; }
        const parsed = this.parseParamValue(raw, p.type);
        if (parsed.error) { await this.showFeedback(session, `Error in "${p.name}": ${parsed.error}`); return; }
        payload[p.name] = parsed.value;
      }
    }

    await this.setWidgetDisabled(session.msgSendBtnId, true);
    if (session.msgSendBtnId) this.send(event(this.id, session.msgSendBtnId, 'update', { busy: true }));
    await this.showFeedback(session, 'Sending...');

    try {
      const result = await this.request(request(this.id, session.targetId, session.selected.name, payload));
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      await this.showFeedback(session, `Response: ${resultStr}`);
      await this.notify(`${session.selected.name} returned ${resultStr.length > 60 ? resultStr.slice(0, 57) + '...' : resultStr}`, 'success');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.showFeedback(session, `Error: ${errMsg}`);
      await this.notify(`${session.selected.name} failed: ${errMsg.slice(0, 80)}`, 'error');
    } finally {
      if (session.msgSendBtnId) this.send(event(this.id, session.msgSendBtnId, 'update', { busy: false }));
      await this.setWidgetDisabled(session.msgSendBtnId, false);
    }
  }

  private async setWidgetDisabled(id: AbjectId | undefined, disabled: boolean): Promise<void> {
    if (!id) return;
    try { await this.request(request(this.id, id, 'update', { style: { disabled } })); } catch { /* gone */ }
  }

  private async showFeedback(session: Session, text: string): Promise<void> {
    if (!session.msgResponseLabelId || !session.detailLayoutId) return;
    try {
      await this.request(request(this.id, session.msgResponseLabelId, 'update', { text }));
      const explicitLines = text.split('\n');
      let totalLines = 0;
      for (const line of explicitLines) totalLines += Math.max(1, Math.ceil((line.length || 1) / 35));
      await this.request(request(this.id, session.detailLayoutId, 'updateLayoutChild', {
        widgetId: session.msgResponseLabelId, preferredSize: { height: Math.max(16, totalLines * 16) },
      }));
    } catch { /* gone */ }
  }

  // ── Type parsing / formatting ────────────────────────────────────────

  private parseParamValue(raw: string, type?: TypeDeclaration): { value?: unknown; error?: string } {
    if (!type) {
      try { return { value: JSON.parse(raw) }; } catch { return { value: raw }; }
    }
    if (type.kind === 'primitive') {
      switch (type.primitive) {
        case 'string': return { value: raw };
        case 'number': {
          const n = Number(raw);
          if (isNaN(n)) return { error: `"${raw}" is not a valid number` };
          return { value: n };
        }
        case 'boolean': {
          const lower = raw.toLowerCase();
          if (lower === 'true') return { value: true };
          if (lower === 'false') return { value: false };
          return { error: `"${raw}" is not a boolean (use true/false)` };
        }
        case 'null': return { value: null };
        default: return { value: raw };
      }
    }
    try { return { value: JSON.parse(raw) }; } catch { return { error: 'invalid JSON' }; }
  }

  private formatType(t: unknown): string {
    if (!t || typeof t !== 'object') return 'any';
    const obj = t as Record<string, unknown>;
    if (obj.kind === 'primitive') return obj.primitive as string;
    if (obj.kind === 'array') return `${this.formatType(obj.elementType)}[]`;
    if (obj.kind === 'reference') return obj.reference as string;
    if (obj.kind === 'object') return 'object';
    return 'any';
  }
}
