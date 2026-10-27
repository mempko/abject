/**
 * Pinboard — cards pinned to the desktop.
 *
 * Pinning a card copies its object into this workspace's `desktop` folder
 * (an independent object, its data copied) and opens a small window holding
 * one slot that shows it. The pins are remembered: when the workspace comes
 * up the windows open again where they were. Closing a pin's window unpins it
 * and removes the copy; the original card stays where it was.
 *
 * Any kept object that draws itself (answers `render`) can be pinned, not
 * only standard cards.
 *
 * Undo: what the person does at the pin windows (closing one, moving or
 * resizing one) is one history, answered when WidgetManager asks; pin and
 * unpin requests from other objects go to each caller's own history. An
 * unpin is undone by bringing the removed copy back from AbjectStore (by
 * its trash id, so the store's other steps for this board are untouched)
 * and opening it where it was.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { UndoHistories, UndoHistory, UndoRefused, undoMethods, type UndoAction, type UndoResult, type UndoStep } from '../core/undo.js';

const log = new Log('Pinboard');

const PINBOARD_INTERFACE = 'abjects:pinboard' as InterfaceId;
const PINS_KEY = 'pinboard:pins';
/** The folder pinned copies live in. */
const PIN_FOLDER = 'desktop';
const PIN_WIDTH = 420;
const PIN_START_HEIGHT = 200;
const MARGIN = 10;

interface Pin {
  /** The pinned copy's typeId. */
  typeId: string;
  title: string;
  rect: { x: number; y: number; width: number; height: number };
}

type Rect = Pin['rect'];

/**
 * One undoable change to the board. A pin or unpin keeps the pin whole (its
 * rect too) and, while the copy is removed, its AbjectStore trash id.
 */
type PinStep =
  | { kind: 'pin' | 'unpin'; pin: Pin; trashId?: string }
  | { kind: 'rect'; typeId: string; before: Rect; after: Rect };

/** A pin's open window and the slot in it. */
interface OpenPin {
  windowId: AbjectId;
  layoutId: AbjectId;
  slotId: AbjectId;
}

export class Pinboard extends Abject {
  private storageId?: AbjectId;
  private storeId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private pins: Pin[] = [];
  private open = new Map<string, OpenPin>();
  /** What the person did at the pin windows (in memory, for the session). */
  private desk = new UndoHistory<PinStep>({ maxSteps: 50, merge: Pinboard.mergeRects });
  /** Pin and unpin requests by other objects, by caller. */
  private byCaller = new UndoHistories<PinStep>({ maxSteps: 20, mergeMs: 0 });

  constructor() {
    super({
      manifest: {
        name: 'Pinboard',
        description: 'Cards pinned to the desktop: pin a card (or any kept object that draws itself) and it stays in a small window of its own, across restarts.',
        version: '1.0.0',
        interface: {
          id: PINBOARD_INTERFACE,
          name: 'Pinboard',
          description: 'Pin cards to the desktop',
          methods: [
            {
              name: 'pin',
              description: 'Pin a copy of a kept object that draws itself (a card) to the desktop, in a window of its own. Returns the copy\'s typeId.',
              parameters: [
                { name: 'typeId', type: { kind: 'primitive', primitive: 'string' }, description: 'The card\'s typeId' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Window title', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'string' },
            },
            {
              name: 'unpin',
              description: 'Close a pinned card and remove its copy.',
              parameters: [{ name: 'typeId', type: { kind: 'primitive', primitive: 'string' }, description: 'The pinned copy\'s typeId' }],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listPins',
              description: 'The pinned cards: [{ typeId, title }].',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
            },
            ...undoMethods('your last pin or unpin (an unpinned card comes back where it was); at the pin windows, the last close, move or resize'),
          ],
        },
        tags: ['system', 'ui'],
      },
    });
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.requireDep('Storage');
    this.storeId = await this.requireDep('AbjectStore');
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    const saved = await this.request<Pin[] | null>(request(this.id, this.storageId, 'get', { key: PINS_KEY })).catch(() => null);
    this.pins = Array.isArray(saved) ? saved.filter(p => typeof p?.typeId === 'string' && !!p.rect) : [];
    // The pins open again with the workspace (a moment later, once the
    // workspace's objects are up).
    if (this.widgetManagerId && this.pins.length > 0) {
      this.setTimer(async () => {
        for (const pin of [...this.pins]) await this.openPin(pin).catch(err => log.warn(`could not reopen a pin: ${String(err)}`));
      }, 1500);
    }
  }

  private setupHandlers(): void {
    this.on('pin', async (msg: AbjectMessage) => {
      const { typeId, title } = msg.payload as { typeId: string; title?: string };
      precondition(typeof typeId === 'string' && typeId.length > 0, 'pin needs the card\'s typeId');
      precondition(!!this.widgetManagerId, 'pinning needs a desktop');
      const copy = await this.request<{ typeId: string }>(request(this.id, this.storeId!, 'copy', {
        objectId: typeId, folder: PIN_FOLDER, loading: 'needed',
      }), 30_000);
      const pin: Pin = {
        typeId: copy.typeId,
        title: (typeof title === 'string' && title.trim() ? title.trim() : 'Pinned').slice(0, 60),
        rect: this.nextRect(),
      };
      this.pins.push(pin);
      await this.savePins();
      await this.openPin(pin);
      log.info(`Pinned ${typeId.split('/').pop()} as ${copy.typeId.split('/').pop()}`);
      (await this.historyFor(msg.routing.from)).record(`Pin ${pin.title}`, { kind: 'pin', pin: structuredClone(pin) });
      return copy.typeId;
    });

    this.on('unpin', async (msg: AbjectMessage) => {
      const { typeId } = msg.payload as { typeId: string };
      const pin = this.pins.find(p => p.typeId === typeId);
      if (!pin) return false;
      const kept = structuredClone(pin);
      const trashId = await this.removePin(typeId);
      (await this.historyFor(msg.routing.from)).record(`Unpin ${kept.title}`, { kind: 'unpin', pin: kept, ...(trashId ? { trashId } : {}) });
      return true;
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoBy(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoBy(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => (await this.historyFor(msg.routing.from)).state());

    this.on('listPins', async () => this.pins.map(p => ({ typeId: p.typeId, title: p.title })));

    // Closing a pin's window unpins it: a step at the desk, so Ctrl+Z on
    // another pinned card brings it back.
    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      const { windowId } = (msg.payload ?? {}) as { windowId?: AbjectId };
      const typeId = [...this.open].find(([, o]) => o.windowId === windowId)?.[0];
      const pin = typeId ? this.pins.find(p => p.typeId === typeId) : undefined;
      if (!typeId || !pin) return true;
      const kept = structuredClone(pin);
      const trashId = await this.removePin(typeId);
      this.desk.record(`Unpin ${kept.title}`, { kind: 'unpin', pin: kept, ...(trashId ? { trashId } : {}) });
      if (trashId && this.open.size > 0) await this.notify(`Unpinned ${kept.title}. Ctrl+Z on a pinned card brings it back`, 'success');
      return true;
    });

    this.on('windowMoved', async (msg: AbjectMessage) => this.rememberRect(msg));
    this.on('windowResized', async (msg: AbjectMessage) => this.rememberRect(msg));

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = (msg.payload ?? {}) as { aspect?: string; value?: unknown };
      if (aspect !== 'contentHeight') return;
      const entry = [...this.open].find(([, o]) => o.slotId === msg.routing.from);
      const h = typeof value === 'number' ? value : Number(value);
      if (!entry || !Number.isFinite(h)) return;
      const [typeId, o] = entry;
      const pin = this.pins.find(p => p.typeId === typeId);
      if (!pin) return;
      try {
        await this.request(request(this.id, o.layoutId, 'updateLayoutChild', { widgetId: o.slotId, preferredSize: { height: h } }));
        const height = Math.ceil(h) + MARGIN * 2 + 36;
        if (Math.abs(height - pin.rect.height) >= 1) {
          pin.rect = { ...pin.rect, height };
          await this.request(request(this.id, o.windowId, 'windowRect', pin.rect));
          await this.savePins();
        }
      } catch { /* window closed meanwhile */ }
    });
  }

  /** Open a pin's window with one slot showing its object. */
  private async openPin(pin: Pin): Promise<void> {
    if (this.open.has(pin.typeId) || !this.widgetManagerId) return;
    const wm = this.widgetManagerId;
    const windowId = await this.request<AbjectId>(request(this.id, wm, 'createWindowAbject', {
      title: pin.title, rect: pin.rect, resizable: true, zIndex: 150,
    }));
    const layoutId = await this.request<AbjectId>(request(this.id, wm, 'createVBox', {
      windowId, margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, spacing: 0,
    }));
    const { widgetIds: [slotId] } = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, wm, 'create', {
      specs: [{ type: 'slot', windowId, target: pin.typeId, storeId: this.storeId, height: PIN_START_HEIGHT }],
    }));
    await this.request(request(this.id, slotId, 'addDependent', {}));
    await this.request(request(this.id, windowId, 'addDependent', {}));
    await this.request(request(this.id, layoutId, 'addLayoutChild', {
      widgetId: slotId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: PIN_START_HEIGHT },
    }));
    this.open.set(pin.typeId, { windowId, layoutId, slotId });
    this.checkInvariants();
  }

  /**
   * Close a pin and remove its copy; the copy's AbjectStore trash id, by
   * which undo brings it back (none when the store kept nothing).
   */
  private async removePin(typeId: string): Promise<string | undefined> {
    const index = this.pins.findIndex(p => p.typeId === typeId);
    precondition(index >= 0, `removePin: '${typeId}' is not pinned`);
    this.pins.splice(index, 1);
    await this.savePins();
    const o = this.open.get(typeId);
    this.open.delete(typeId);
    if (o && this.widgetManagerId) {
      try { await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: o.windowId })); } catch { /* gone */ }
    }
    let trashId: string | undefined;
    try {
      if (await this.request<boolean>(request(this.id, this.storeId!, 'remove', { objectId: typeId }))) {
        const removed = await this.request<Array<{ id: string; typeId: string; removedAt: number }>>(
          request(this.id, this.storeId!, 'listRemoved', {}));
        trashId = removed.filter(r => r.typeId === typeId).sort((a, b) => b.removedAt - a.removedAt)[0]?.id;
      }
    } catch { /* already gone */ }
    log.info(`Unpinned ${typeId.split('/').pop()}`);
    this.checkInvariants();
    return trashId;
  }

  /** Bring an unpinned copy back from AbjectStore and open it where it was. */
  private async restorePin(pin: Pin, trashId: string | undefined): Promise<Pin> {
    if (!trashId) throw new UndoRefused(`'${pin.title}' is no longer kept`);
    let typeId: string;
    try {
      ({ typeId } = await this.request<{ typeId: string }>(request(this.id, this.storeId!, 'restoreRemoved', { id: trashId }), 30_000));
    } catch {
      throw new UndoRefused(`'${pin.title}' is no longer kept`);
    }
    const back: Pin = { ...structuredClone(pin), typeId };
    this.pins.push(back);
    await this.savePins();
    await this.openPin(back).catch(err => log.warn(`could not reopen a pin: ${String(err)}`));
    this.checkInvariants();
    return back;
  }

  // ── Undo ──

  /** The history a caller's changes and undos go to: the desk for WidgetManager (the person at the pin windows). */
  private async historyFor(callerId: AbjectId): Promise<UndoHistory<PinStep>> {
    if (callerId === this.widgetManagerId) return this.desk;
    return this.byCaller.for(await this.undoCallerKey(callerId));
  }

  private async undoBy(callerId: AbjectId, action: UndoAction): Promise<UndoResult> {
    const history = await this.historyFor(callerId);
    return history[action](step => this.applyStep(step, action));
  }

  /** Take a step back (undo) or forward again (redo). */
  private async applyStep(step: UndoStep<PinStep>, action: UndoAction): Promise<unknown> {
    const d = step.data;
    if (d.kind === 'rect') {
      const pin = this.pins.find(p => p.typeId === d.typeId);
      if (!pin) throw new UndoRefused('That card is no longer pinned');
      const [from, to] = action === 'undo' ? [d.after, d.before] : [d.before, d.after];
      // Height follows the card's content in the background; where the
      // window stands and how wide it is are the person's.
      if (pin.rect.x !== from.x || pin.rect.y !== from.y || pin.rect.width !== from.width) {
        throw new UndoRefused(`'${pin.title}' was moved since`);
      }
      pin.rect = { ...to };
      await this.savePins();
      const o = this.open.get(pin.typeId);
      if (o) {
        try { await this.request(request(this.id, o.windowId, 'windowRect', pin.rect)); } catch { /* window closed meanwhile */ }
      }
      return {};
    }
    // Unpin undone and pin redone put the card back; the other two take it away.
    const putBack = (d.kind === 'unpin') === (action === 'undo');
    if (putBack) {
      d.pin = await this.restorePin(d.pin, d.trashId);
      delete d.trashId;
      return { typeId: d.pin.typeId };
    }
    const pin = this.pins.find(p => p.typeId === d.pin.typeId);
    if (!pin) throw new UndoRefused(`'${d.pin.title}' is not pinned`);
    d.pin = structuredClone(pin);
    const trashId = await this.removePin(pin.typeId);
    if (trashId) d.trashId = trashId; else delete d.trashId;
    return {};
  }

  /** A drag or resize burst is one step: from where it started to where it ended. */
  private static mergeRects(older: PinStep, newer: PinStep): PinStep {
    if (older.kind !== 'rect' || newer.kind !== 'rect') return newer;
    return { ...newer, before: older.before };
  }

  private async rememberRect(msg: AbjectMessage): Promise<void> {
    const { windowId, x, y, width, height } = (msg.payload ?? {}) as { windowId?: AbjectId; x?: number; y?: number; width?: number; height?: number };
    const typeId = [...this.open].find(([, o]) => o.windowId === windowId)?.[0];
    const pin = typeId ? this.pins.find(p => p.typeId === typeId) : undefined;
    if (!pin) return;
    const before = pin.rect;
    pin.rect = {
      x: typeof x === 'number' ? x : pin.rect.x,
      y: typeof y === 'number' ? y : pin.rect.y,
      width: typeof width === 'number' ? width : pin.rect.width,
      height: typeof height === 'number' ? height : pin.rect.height,
    };
    // Only the person's moves and resizes are steps: the window echoing a
    // rect this board set (undo, fitting the content) changes nothing here.
    const moved = pin.rect.x !== before.x || pin.rect.y !== before.y;
    if (moved || pin.rect.width !== before.width || pin.rect.height !== before.height) {
      this.desk.record(`${moved ? 'Move' : 'Resize'} ${pin.title}`, { kind: 'rect', typeId: pin.typeId, before, after: { ...pin.rect } },
        { mergeKey: pin.typeId });
    }
    await this.savePins();
  }

  /** Where a new pin opens: stepped down and across from the last one. */
  private nextRect(): Pin['rect'] {
    const n = this.pins.length;
    return { x: 220 + (n % 6) * 36, y: 80 + (n % 6) * 36, width: PIN_WIDTH, height: PIN_START_HEIGHT + MARGIN * 2 + 36 };
  }

  private async savePins(): Promise<void> {
    if (!this.storageId) return;
    await this.request(request(this.id, this.storageId, 'set', { key: PINS_KEY, value: this.pins }));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const typeId of this.open.keys()) {
      invariant(this.pins.some(p => p.typeId === typeId), 'an open pin window belongs to a pin');
    }
  }
}

export const PINBOARD_ID = 'abjects:pinboard' as AbjectId;
