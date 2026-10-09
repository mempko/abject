/**
 * DialogBroker -- the questions waiting on a person, and who may answer them.
 *
 * A question to the user (a confirmation, a typed answer, a permission with
 * several ways to grant it) used to belong to whichever window drew it. That
 * made a question impossible without a desktop: the headless server has no
 * windows, so a permission prompt there could only be denied, and a terminal
 * could answer a question only by going through the widget layer that drew it.
 *
 * This object owns the question instead. It holds every open dialog, keeps
 * the asker's call alive while it waits (for as long as the person takes), and
 * takes the answer from whichever surface gives it first:
 *
 *   - a PRESENTER draws the dialog on a desktop and reports the click. The
 *     desktop registers one per dialog kind at boot (WidgetManager for
 *     confirm and prompt, the Settings window for permission options). A
 *     presenter shows one dialog at a time and gets the next as each closes.
 *   - a RESPONDER is a remote surface, such as the terminal gateway. It is
 *     told of every dialog as it opens and closes, can list the open ones, and
 *     can answer any of them.
 *
 * Both sets are registered by the bootstrap and then sealed before any
 * workspace (and so any user abject) exists. Nothing else can answer a dialog:
 * that is what stops an object from granting itself permissions by answering
 * its own question. With no presenter at all (the headless server) the
 * question still opens and waits; a terminal answers it.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { event } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('DialogBroker');

const DIALOG_BROKER_INTERFACE: InterfaceId = 'abjects:dialog-broker';

export const DIALOG_BROKER_ID = 'abjects:dialog-broker' as AbjectId;

export type DialogKind = 'confirm' | 'prompt' | 'options';
export const DIALOG_KINDS: readonly DialogKind[] = ['confirm', 'prompt', 'options'];

export interface DialogOption {
  id: string;
  label: string;
  tone?: 'default' | 'good' | 'bad';
}

export interface DialogGroup {
  label: string;
  options: DialogOption[];
}

/** What an asker puts to the person. */
export interface DialogSpec {
  kind: DialogKind;
  title: string;
  message: string;
  /** confirm */
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** prompt */
  defaultValue?: string;
  placeholder?: string;
  /** options: the thing being decided on (a command line, a path), shown verbatim. */
  resource?: string;
  /** options: analysis lines shown under the resource. */
  detail?: string[];
  /** options: the answers, grouped narrowest scope first. */
  groups?: DialogGroup[];
  /** The task the question belongs to, so the wait keeps exactly its callers alive. */
  taskId?: string;
  /** What the question is about ('permission', 'confirm', ...), for presenters and terminals. */
  topic?: string;
}

/** An open dialog as presenters and responders see it. */
export interface OpenDialog extends DialogSpec {
  dialogId: string;
  openedAt: number;
  /** The asking object's registered name, when it could be established. */
  askedBy?: string;
}

/** How a dialog ended. `answered` false means it was withdrawn or abandoned. */
export interface DialogAnswer {
  answered: boolean;
  confirmed: boolean;
  value?: string;
  option?: string;
  /** Which kind of surface answered: a desktop presenter or a remote responder. */
  via?: 'presenter' | 'responder';
}

interface PendingDialog {
  dialog: OpenDialog;
  /** The asker's request, answered when the dialog closes. */
  msg: AbjectMessage;
  askedById: AbjectId;
  stopBeating: () => void;
}

/** The ids of every option an options dialog offers. */
function optionIds(dialog: DialogSpec): string[] {
  return (dialog.groups ?? []).flatMap(g => g.options.map(o => o.id));
}

export class DialogBroker extends Abject {
  /** Remote surfaces (terminal gateways): told of every dialog, may answer any. */
  private responders = new Set<AbjectId>();
  /** Desktop surfaces by the dialog kinds they draw. */
  private presenters = new Map<DialogKind, AbjectId>();
  private sealed = false;

  private open = new Map<string, PendingDialog>();
  /** Presenter id -> the dialog it is showing now. One at a time per presenter. */
  private presenting = new Map<AbjectId, string>();
  private counter = 0;

  constructor() {
    super({
      manifest: {
        name: 'DialogBroker',
        description:
          'Holds every question waiting on the person (confirmations, typed answers, permission prompts) and takes ' +
          'the answer from the desktop or from a terminal, whichever comes first. Askers wait as long as the person takes.',
        version: '1.0.0',
        interface: {
          id: DIALOG_BROKER_INTERFACE,
          name: 'DialogBroker',
          description: 'Questions to the person and their answers',
          methods: [
            {
              name: 'askPerson',
              description: 'Put a question to the person and wait for the answer. kind: confirm, prompt (typed answer) or options (pick one of grouped options). Returns { answered, confirmed, value?, option? }.',
              parameters: [
                { name: 'kind', type: { kind: 'primitive', primitive: 'string' }, description: 'confirm | prompt | options' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Short title' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The question' },
                { name: 'groups', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'options: [{ label, options: [{ id, label, tone? }] }]', optional: true },
                { name: 'resource', type: { kind: 'primitive', primitive: 'string' }, description: 'options: what is being decided on', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task the question belongs to', optional: true },
              ],
              returns: { kind: 'object', properties: {
                answered: { kind: 'primitive', primitive: 'boolean' },
                confirmed: { kind: 'primitive', primitive: 'boolean' },
                value: { kind: 'primitive', primitive: 'string' },
                option: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'cancel',
              description: 'Withdraw a question you asked (the asker only).',
              parameters: [{ name: 'dialogId', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog id' }],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'respond',
              description: 'Answer an open dialog. Taken only from the surfaces registered at boot.',
              parameters: [
                { name: 'dialogId', type: { kind: 'primitive', primitive: 'string' }, description: 'Dialog id' },
                { name: 'confirmed', type: { kind: 'primitive', primitive: 'boolean' }, description: 'False declines' },
                { name: 'value', type: { kind: 'primitive', primitive: 'string' }, description: 'prompt: the typed answer', optional: true },
                { name: 'option', type: { kind: 'primitive', primitive: 'string' }, description: 'options: the chosen option id', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listOpen',
              description: 'Every open dialog, oldest first. Registered surfaces only.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'OpenDialog' } },
            },
            {
              name: 'getState',
              description: 'How many dialogs are open, which kinds have a desktop presenter, how many remote responders.',
              parameters: [],
              returns: { kind: 'object', properties: {
                open: { kind: 'primitive', primitive: 'number' },
                presenterKinds: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                responders: { kind: 'primitive', primitive: 'number' },
                sealed: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
          events: [
            { name: 'dialogOpened', description: 'Sent to responders when a dialog opens (payload: the OpenDialog).', payload: { kind: 'reference', reference: 'OpenDialog' } },
            { name: 'dialogClosed', description: 'Sent to responders when a dialog closes (payload: { dialogId, answered }).', payload: { kind: 'object', properties: {} } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'security'],
      },
    });
    this.setupHandlers();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [presenterId, dialogId] of this.presenting) {
      invariant(this.open.has(dialogId), 'DialogBroker: a presenter is showing a dialog that is not open');
      invariant([...this.presenters.values()].includes(presenterId), 'DialogBroker: an unregistered surface is presenting');
    }
  }

  private setupHandlers(): void {
    // ── Registration, sealed before any workspace exists ──────────────

    this.on('registerResponder', (msg: AbjectMessage) => {
      precondition(!this.sealed, 'Dialog surface registration is sealed');
      const { objectId } = (msg.payload ?? {}) as { objectId?: AbjectId };
      precondition(typeof objectId === 'string' && objectId.length > 0, 'objectId required');
      this.responders.add(objectId!);
      log.info(`Dialog responder registered: ${objectId!.slice(0, 8)}`);
      return true;
    });

    this.on('registerPresenter', (msg: AbjectMessage) => {
      precondition(!this.sealed, 'Dialog surface registration is sealed');
      const { objectId, kinds } = (msg.payload ?? {}) as { objectId?: AbjectId; kinds?: string[] };
      precondition(typeof objectId === 'string' && objectId.length > 0, 'objectId required');
      precondition(Array.isArray(kinds) && kinds.length > 0 && kinds.every(k => DIALOG_KINDS.includes(k as DialogKind)),
        `kinds must list dialog kinds (${DIALOG_KINDS.join(', ')})`);
      for (const kind of kinds as DialogKind[]) this.presenters.set(kind, objectId!);
      log.info(`Dialog presenter registered for ${kinds!.join(', ')}: ${objectId!.slice(0, 8)}`);
      return true;
    });

    this.on('seal', () => {
      this.sealed = true;
      log.info(`Dialog surfaces sealed (${this.responders.size} responder(s), presenters for ${[...this.presenters.keys()].join(', ') || 'nothing'})`);
      return true;
    });

    // ── Asking ─────────────────────────────────────────────────────────

    this.on('askPerson', (msg: AbjectMessage) => {
      const spec = this.validateSpec(msg.payload);
      const dialogId = `dlg-${++this.counter}-${Date.now().toString(36)}`;
      const dialog: OpenDialog = { ...spec, dialogId, openedAt: Date.now() };
      // The heartbeat is what lets the asker, and every caller stacked up
      // behind it, wait as long as the person does: their stall timers reset
      // on each beat, so they expire only if this object is gone.
      const stopBeating = this.awaitingHuman(`${spec.kind}: ${spec.title}`, spec.taskId);
      this.open.set(dialogId, { dialog, msg, askedById: msg.routing.from, stopBeating });
      void this.announce(dialogId);
      return DEFERRED_REPLY;
    });

    this.on('cancel', (msg: AbjectMessage) => {
      const { dialogId } = (msg.payload ?? {}) as { dialogId?: string };
      const pending = dialogId ? this.open.get(dialogId) : undefined;
      if (!pending) return false;
      precondition(pending.askedById === msg.routing.from, 'Only the asker may withdraw its question');
      this.close(dialogId!, { answered: false, confirmed: false });
      return true;
    });

    // ── Answering ──────────────────────────────────────────────────────

    this.on('respond', (msg: AbjectMessage) => {
      const { dialogId, confirmed, value, option } = (msg.payload ?? {}) as {
        dialogId?: string; confirmed?: boolean; value?: string; option?: string;
      };
      precondition(typeof dialogId === 'string' && dialogId.length > 0, 'dialogId required');
      const from = msg.routing.from;
      const isResponder = this.responders.has(from);
      const isItsPresenter = this.presenting.get(from) === dialogId;
      if (!isResponder && !isItsPresenter) {
        log.warn(`respond DENIED for unauthorized sender ${from.slice(0, 8)}`);
        throw new Error('Not authorized to answer dialogs');
      }
      const pending = this.open.get(dialogId!);
      if (!pending) throw new Error('Unknown or already-answered dialog');
      const dialog = pending.dialog;
      const yes = confirmed === true;
      if (yes && dialog.kind === 'options') {
        precondition(typeof option === 'string' && optionIds(dialog).includes(option),
          `option must be one of: ${optionIds(dialog).join(', ')}`);
      }
      if (yes && dialog.kind === 'prompt') {
        precondition(typeof value === 'string', 'a prompt answer needs a value');
      }
      this.close(dialogId!, {
        answered: true,
        confirmed: yes,
        ...(yes && dialog.kind === 'prompt' ? { value } : {}),
        ...(yes && dialog.kind === 'options' ? { option } : {}),
        via: isItsPresenter ? 'presenter' : 'responder',
      });
      return true;
    });

    this.on('listOpen', (msg: AbjectMessage) => {
      precondition(this.isSurface(msg.routing.from), 'Only registered dialog surfaces may list open dialogs');
      return [...this.open.values()]
        .map(p => p.dialog)
        .sort((a, b) => a.openedAt - b.openedAt);
    });

    this.on('getState', () => ({
      open: this.open.size,
      presenterKinds: [...this.presenters.keys()],
      responders: this.responders.size,
      sealed: this.sealed,
    }));
  }

  private isSurface(id: AbjectId): boolean {
    return this.responders.has(id) || [...this.presenters.values()].includes(id);
  }

  /** Check an `askPerson` payload and keep only the fields a dialog carries. */
  private validateSpec(payload: unknown): DialogSpec {
    const p = (payload ?? {}) as Record<string, unknown>;
    precondition(DIALOG_KINDS.includes(p.kind as DialogKind), `kind must be one of ${DIALOG_KINDS.join(', ')}`);
    precondition(typeof p.title === 'string' && p.title.trim().length > 0, 'title must be a non-empty string');
    precondition(typeof p.message === 'string', 'message must be a string');
    const kind = p.kind as DialogKind;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const spec: DialogSpec = {
      kind,
      title: (p.title as string).trim(),
      message: p.message as string,
      confirmLabel: str(p.confirmLabel),
      cancelLabel: str(p.cancelLabel),
      destructive: p.destructive === true ? true : undefined,
      defaultValue: str(p.defaultValue),
      placeholder: str(p.placeholder),
      resource: str(p.resource),
      detail: Array.isArray(p.detail) ? (p.detail as unknown[]).filter((d): d is string => typeof d === 'string') : undefined,
      taskId: str(p.taskId),
      topic: str(p.topic) ?? (kind === 'options' ? 'choice' : kind),
    };
    if (kind === 'options') {
      precondition(Array.isArray(p.groups) && p.groups.length > 0, 'an options dialog needs groups of options');
      const groups: DialogGroup[] = [];
      for (const g of p.groups as unknown[]) {
        const group = g as { label?: unknown; options?: unknown };
        precondition(typeof group?.label === 'string' && Array.isArray(group.options), 'each group needs a label and options');
        const options: DialogOption[] = [];
        for (const o of group.options as unknown[]) {
          const opt = o as { id?: unknown; label?: unknown; tone?: unknown };
          precondition(typeof opt?.id === 'string' && opt.id.length > 0 && typeof opt.label === 'string', 'each option needs an id and a label');
          const tone = opt.tone === 'good' || opt.tone === 'bad' ? opt.tone : 'default';
          options.push({ id: opt.id as string, label: opt.label as string, tone });
        }
        if (options.length > 0) groups.push({ label: group.label as string, options });
      }
      precondition(groups.length > 0, 'an options dialog needs at least one option');
      spec.groups = groups;
    }
    return spec;
  }

  /** Tell the remote surfaces, then hand the dialog to its presenter if free. */
  private async announce(dialogId: string): Promise<void> {
    const pending = this.open.get(dialogId);
    if (!pending) return;
    const who = await this.resolveCallerIdentity(pending.askedById).catch(() => undefined);
    if (who?.name) pending.dialog.askedBy = who.name;
    if (!this.open.has(dialogId)) return; // answered while we looked the asker up
    log.info(`open ${dialogId}: ${pending.dialog.kind} "${pending.dialog.title}"${who?.name ? ` from ${who.name}` : ''}`);
    for (const responder of this.responders) {
      try { this.send(event(this.id, responder, 'dialogOpened', pending.dialog)); } catch { /* surface gone */ }
    }
    this.presentNext(pending.dialog.kind);
  }

  /** Give a free presenter the oldest open dialog of a kind it draws. */
  private presentNext(kind: DialogKind): void {
    const presenter = this.presenters.get(kind);
    if (!presenter || this.presenting.has(presenter)) return;
    const kinds = [...this.presenters.entries()].filter(([, id]) => id === presenter).map(([k]) => k);
    const next = [...this.open.values()]
      .filter(p => kinds.includes(p.dialog.kind))
      .sort((a, b) => a.dialog.openedAt - b.dialog.openedAt)[0];
    if (!next) return;
    this.presenting.set(presenter, next.dialog.dialogId);
    try {
      this.send(event(this.id, presenter, 'presentDialog', next.dialog));
    } catch {
      // The desktop is gone; the dialog stays open for the terminals.
      this.presenting.delete(presenter);
    }
  }

  /** Answer the asker, tell every surface, and move the presenter on. */
  private close(dialogId: string, answer: DialogAnswer): void {
    const pending = this.open.get(dialogId);
    if (!pending) return;
    this.open.delete(dialogId);
    pending.stopBeating();
    this.sendDeferredReply(pending.msg, answer);
    log.info(`closed ${dialogId}: ${answer.answered ? (answer.confirmed ? `confirmed${answer.option ? ` (${answer.option})` : ''}` : 'declined') : 'withdrawn'}${answer.via ? ` via ${answer.via}` : ''}`);

    for (const responder of this.responders) {
      try { this.send(event(this.id, responder, 'dialogClosed', { dialogId, answered: answer.answered })); } catch { /* surface gone */ }
    }
    for (const [presenter, showing] of this.presenting) {
      if (showing !== dialogId) continue;
      this.presenting.delete(presenter);
      // The presenter that took the click has already closed its window.
      if (answer.via !== 'presenter') {
        try { this.send(event(this.id, presenter, 'dismissDialog', { dialogId })); } catch { /* gone */ }
      }
      const kinds = [...this.presenters.entries()].filter(([, id]) => id === presenter).map(([k]) => k);
      for (const kind of kinds) this.presentNext(kind);
    }
    this.checkInvariants();
  }

  protected override async onStop(): Promise<void> {
    // Nobody can answer once this object is gone: decline what is still open
    // rather than leave the askers waiting on beats that have stopped.
    for (const dialogId of [...this.open.keys()]) {
      const pending = this.open.get(dialogId)!;
      this.open.delete(dialogId);
      pending.stopBeating();
      try { this.sendDeferredReply(pending.msg, { answered: false, confirmed: false }); } catch { /* bus gone */ }
    }
    this.presenting.clear();
  }

  protected override askPrompt(question: string): string {
    return super.askPrompt(question) + `\n\n## DialogBroker Usage Guide

Puts a question to the person and waits for the answer, however long that takes.
The answer comes from the desktop, when there is one, or from a terminal.

### Ask
  const r = await call(await dep('DialogBroker'), 'askPerson', {
    kind: 'confirm', title: 'Delete the draft?', message: 'This cannot be undone.', destructive: true,
  });
  // r: { answered, confirmed }
  // kind 'prompt' returns the typed text in r.value;
  // kind 'options' takes groups: [{ label, options: [{ id, label }] }] and returns r.option.

Open dialogs right now: ${this.open.size}.`;
  }
}
