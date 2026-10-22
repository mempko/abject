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
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

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
      return copy.typeId;
    });

    this.on('unpin', async (msg: AbjectMessage) => {
      const { typeId } = msg.payload as { typeId: string };
      return this.unpin(typeId);
    });

    this.on('listPins', async () => this.pins.map(p => ({ typeId: p.typeId, title: p.title })));

    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      const { windowId } = (msg.payload ?? {}) as { windowId?: AbjectId };
      const typeId = [...this.open].find(([, o]) => o.windowId === windowId)?.[0];
      if (typeId) await this.unpin(typeId);
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

  private async unpin(typeId: string): Promise<boolean> {
    const index = this.pins.findIndex(p => p.typeId === typeId);
    if (index < 0) return false;
    this.pins.splice(index, 1);
    await this.savePins();
    const o = this.open.get(typeId);
    this.open.delete(typeId);
    if (o && this.widgetManagerId) {
      try { await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: o.windowId })); } catch { /* gone */ }
    }
    try { await this.request(request(this.id, this.storeId!, 'remove', { objectId: typeId })); } catch { /* already gone */ }
    log.info(`Unpinned ${typeId.split('/').pop()}`);
    this.checkInvariants();
    return true;
  }

  private async rememberRect(msg: AbjectMessage): Promise<void> {
    const { windowId, x, y, width, height } = (msg.payload ?? {}) as { windowId?: AbjectId; x?: number; y?: number; width?: number; height?: number };
    const typeId = [...this.open].find(([, o]) => o.windowId === windowId)?.[0];
    const pin = typeId ? this.pins.find(p => p.typeId === typeId) : undefined;
    if (!pin) return;
    pin.rect = {
      x: typeof x === 'number' ? x : pin.rect.x,
      y: typeof y === 'number' ? y : pin.rect.y,
      width: typeof width === 'number' ? width : pin.rect.width,
      height: typeof height === 'number' ? height : pin.rect.height,
    };
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
