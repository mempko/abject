/**
 * Instance switcher for the p2p client (client.abject.world): the DOM chrome
 * that lets one browser know several instances and show one at a time.
 *
 *   - Desktop: a pill in the bottom-right corner (current instance + status
 *     dot) opening a panel; Ctrl+Shift+O (Cmd+Shift+O on macOS) toggles it.
 *   - Phone: a floating button beside the palette and Exposé buttons opens the
 *     same panel as a full-width sheet.
 *   - Connecting screen: Switch instance and Disconnect beside Reset, and a
 *     plain message when the instance is not answering.
 *   - Login card: which instance is asking, and a way to switch away.
 *   - Picker: shown when disconnected or nothing is selected.
 *
 * Switching never swaps the live client: it writes the choice to storage
 * (instances.ts) and reloads, and the page connects to the selection on load.
 * Only the p2p build constructs this; other builds never load it.
 */

import cssText from './instance-switcher.css?inline';
import type { FrontendClient } from './frontend-client.js';
import {
  addUrlInstance,
  authTokenKey,
  findUrlInstance,
  forgetInstance,
  instanceDetail,
  listInstances,
  markDisconnected,
  normalizeServerUrl,
  renameInstance,
  selectInstance,
  selectedInstanceId,
  touchInstance,
  type Instance,
} from './instances.js';
import { pairingPageUrl, parsePairingText } from './pairing.js';

type Status = 'connected' | 'connecting' | 'login' | 'offline';

/** What this page is connected to: a saved instance, or a pairing in progress. */
export type SwitcherSession =
  | { kind: 'instance'; instance: Instance }
  | { kind: 'pairing'; name: string };

export interface InstanceSwitcherDeps {
  client: FrontendClient;
  /** The pairing splash, shown while no instance exists yet. */
  showPairSplash(message?: string): void;
  /** Open the camera QR scanner; reports the decoded text or a problem. */
  scanQr(onText: (text: string) => void, onProblem: (message: string) => void): void;
}

/** A server address being tried before it is saved (it may ask for a login). */
interface Probe {
  url: string;
  ws?: WebSocket;
  phase: 'connecting' | 'login' | 'signing-in' | 'failed';
  error?: string;
  pendingLogin?: { username: string; password: string };
  timer?: ReturnType<typeof setTimeout>;
  done?: boolean;
}

const STATUS_WORDS: Record<Status, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  login: 'Waiting for sign in',
  offline: 'Disconnected',
};

/** How long a session may go unanswered before the connecting screen says so. */
const TROUBLE_AFTER_MS = 8000;
/** How long the connecting screen waits before offering its buttons. */
const ACTIONS_AFTER_MS = 5000;
/** How often the pill re-reads the client's connection state. */
const STATUS_POLL_MS = 500;

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const SHORTCUT_LABEL = IS_MAC ? '⌘⇧O' : 'Ctrl+Shift+O';

/** Events that stop at the panel and picker, never reaching the canvas or the backend. */
const ISOLATED_EVENTS = [
  'keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut',
  'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel',
  'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend',
] as const;

export class InstanceSwitcher {
  private readonly deps: InstanceSwitcherDeps;
  private session?: SwitcherSession;
  private status: Status = 'connecting';
  private wasConnected = false;
  private notConnectedSince = Date.now();
  private troubleText?: string;
  private refusals = 0;
  private failures = 0;

  private readonly pill: HTMLButtonElement;
  private readonly pillDot: HTMLElement;
  private readonly pillName: HTMLElement;
  private readonly phoneBtn: HTMLButtonElement;
  private readonly phoneDot: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly panelTitle: HTMLElement;
  private readonly panelBody: HTMLDivElement;
  private readonly picker: HTMLDivElement;
  private readonly pickerCard: HTMLDivElement;
  private readonly pickerTitle: HTMLElement;
  private readonly pickerBody: HTMLDivElement;
  private connectingName?: HTMLElement;
  private connectingTrouble?: HTMLElement;
  private connectingStatusText?: Text;
  private connectingStatusDefault = '';
  private connectingButtons: HTMLButtonElement[] = [];
  private loginName?: HTMLElement;
  private loginSwitch?: HTMLButtonElement;

  /** Where list and messages render: the panel over a session, or the picker. */
  private surface: 'panel' | 'picker' | 'splash' | 'none' = 'none';
  private panelOpen = false;
  private view: 'list' | 'add' = 'list';
  private editing?: { id: string; mode: 'rename' | 'forget' };
  private message = '';
  private draft = { link: '', url: '', username: '', name: '' };
  private probe?: Probe;
  /**
   * Keys whose keydown the switcher took (the shortcut, or any key pressed
   * inside the panel or picker). Their keyup is kept from the backend too,
   * even when it lands after the panel has closed.
   */
  private keysTaken = new Set<string>();

  constructor(deps: InstanceSwitcherDeps) {
    this.deps = deps;
    const style = document.createElement('style');
    style.dataset.instanceSwitcher = '';
    style.textContent = cssText;
    document.head.appendChild(style);

    // Pill (desktop).
    this.pill = el('button', { type: 'button', class: 'instance-pill', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', hidden: '' });
    this.pillDot = el('span', { class: 'instance-dot', 'data-status': 'connecting' });
    this.pillName = el('span', { class: 'instance-pill-name' });
    this.pill.append(this.pillDot, this.pillName);
    this.pill.addEventListener('click', () => this.togglePanel());

    // Floating phone button; FrontendClient shows it with the other phone buttons.
    this.phoneBtn = el('button', { type: 'button', id: 'mobile-instance-btn', 'aria-label': 'Switch instance', hidden: '' }, '⇄');
    this.phoneDot = el('span', { class: 'instance-dot', 'data-status': 'connecting' });
    this.phoneBtn.append(this.phoneDot);
    this.phoneBtn.addEventListener('click', () => this.openPanel());

    // Panel.
    this.panel = el('div', { class: 'instance-panel', role: 'dialog', 'aria-label': 'Instances', tabindex: '-1', hidden: '' });
    const head = el('div', { class: 'instance-panel-head' });
    this.panelTitle = el('span', { class: 'instance-panel-title' }, 'Instances');
    const hint = el('span', { class: 'instance-panel-hint' }, SHORTCUT_LABEL);
    const close = el('button', { type: 'button', class: 'instance-close', 'aria-label': 'Close' }, '×');
    close.addEventListener('click', () => this.closePanel());
    head.append(this.panelTitle, hint, close);
    this.panelBody = el('div', { class: 'instance-panel-body' });
    this.panel.append(head, this.panelBody);
    this.isolate(this.panel);

    // Picker screen, in the pairing splash's card.
    this.picker = el('div', { id: 'instance-picker-overlay' });
    this.pickerCard = el('div', { class: 'pair-card instance-picker-card', tabindex: '-1' });
    const logo = el('div', { class: 'pair-logo' });
    logo.append(el('span', { class: 'accent' }, '{abject}'));
    this.pickerTitle = el('h2', {}, 'Choose an instance');
    this.pickerBody = el('div', { class: 'instance-panel-body' });
    this.pickerCard.append(logo, this.pickerTitle, this.pickerBody);
    this.picker.append(this.pickerCard);
    this.isolate(this.picker);

    document.body.append(this.pill, this.phoneBtn, this.panel, this.picker);

    this.decorateConnectingScreen();
    this.decorateLoginCard();
    this.installKeys();

    // Clicking outside the open panel closes it (the click still lands).
    window.addEventListener('pointerdown', (e) => {
      if (!this.panelOpen) return;
      const target = e.target as Node | null;
      if (target && (this.panel.contains(target) || this.isOpener(target))) return;
      this.closePanel();
    }, true);
    window.addEventListener('resize', () => this.refresh());
    setInterval(() => this.refresh(), STATUS_POLL_MS);
  }

  // ── Session lifecycle (called by index.ts) ─────────────────────────

  /** A connection to `session` is starting on this page. */
  beginSession(session: SwitcherSession): void {
    this.session = session;
    this.surface = 'none';
    this.wasConnected = false;
    this.notConnectedSince = Date.now();
    this.hidePicker();
    this.updateNames();
    // index.ts calls connect() right after this; read the state once it has.
    setTimeout(() => this.refresh(), 0);
    setTimeout(() => {
      const overlay = document.getElementById('connecting-overlay');
      if (overlay && !overlay.classList.contains('hidden')) this.revealConnectingButtons();
    }, ACTIONS_AFTER_MS);
  }

  /** The pairing in progress was accepted and saved as `instance`. */
  setInstance(instance: Instance): void {
    this.session = { kind: 'instance', instance };
    this.updateNames();
    if (this.panelOpen) this.render();
  }

  /** The instance accepted this browser; earlier refusals no longer count. */
  noteAccepted(): void {
    this.refusals = 0;
    this.failures = 0;
  }

  /** An attempt to reach the instance failed and another is scheduled. */
  noteRetry(info: { refused: boolean }): void {
    const name = this.sessionName();
    if (info.refused) {
      this.refusals++;
      if (this.refusals >= 2) {
        this.setTrouble(`${name} is not accepting this browser. It may have been removed on the desktop. Pair it again, or switch to another instance.`);
      }
    } else {
      this.failures++;
      if (this.failures >= 3) this.setTrouble(`Can't reach ${name} yet.`);
    }
  }

  /** The pairing link was refused or ran out: say so and offer the picker. */
  pairingFailed(reason: 'refused' | 'expired'): void {
    const text = reason === 'expired'
      ? 'That pairing link expired before the desktop answered. Make a new one on your desktop.'
      : 'The desktop did not accept this pairing link. It may have been used already or expired. Make a new one on your desktop.';
    this.showPicker(text);
  }

  /** The connection could not start at all. */
  connectFailed(): void {
    if (this.session) this.showPicker('Failed to connect. Please try again.');
  }

  /** No live connection: show the instances to pick from (the splash when there are none). */
  showPicker(message?: string): void {
    this.session = undefined;
    this.closePanel();
    this.cancelProbe();
    this.pill.hidden = true;
    this.phoneBtn.hidden = true;
    document.getElementById('connecting-overlay')?.classList.add('hidden');
    document.getElementById('login-overlay')?.classList.remove('visible');
    this.view = 'list';
    this.editing = undefined;
    this.setMessage(message ?? '');
    if (listInstances().length === 0) {
      this.surface = 'splash';
      this.hidePicker();
      this.deps.showPairSplash(message);
      this.decorateSplash();
      return;
    }
    this.openPicker();
  }

  /** The splash's Scan button. */
  scanFromSplash(): void {
    this.surface = 'splash';
    this.scan();
  }

  // ── Status ─────────────────────────────────────────────────────────

  private computeStatus(): Status {
    const state = this.deps.client.connectionState;
    if (state === 'connected') return 'connected';
    if (state === 'closed') return 'offline';
    if (document.getElementById('login-overlay')?.classList.contains('visible')) return 'login';
    return 'connecting';
  }

  /** Poll the client (cheap) and repaint what changed. */
  private refresh(): void {
    const mobile = this.deps.client.mobileLayout;
    this.pill.hidden = !this.session || mobile;
    this.panel.classList.toggle('phone', mobile);
    this.pickerCard.classList.toggle('phone', mobile);
    if (!this.session) return;

    const status = this.computeStatus();
    if (status !== this.status) {
      const was = this.status;
      this.status = status;
      if (status === 'connected') this.onConnected();
      else if (was === 'connected') this.notConnectedSince = Date.now();
      this.paintStatus();
    }
    if (status === 'connecting' && !this.troubleText && Date.now() - this.notConnectedSince > TROUBLE_AFTER_MS) {
      this.setTrouble(`Can't reach ${this.sessionName()} yet.`);
    }
  }

  private onConnected(): void {
    this.wasConnected = true;
    this.clearTrouble();
    if (this.session?.kind === 'instance') touchInstance(this.session.instance.id);
  }

  private paintStatus(): void {
    for (const dot of [this.pillDot, this.phoneDot, ...this.panel.querySelectorAll<HTMLElement>('[data-current-dot]')]) {
      dot.dataset.status = this.status;
    }
    for (const word of this.panel.querySelectorAll<HTMLElement>('[data-current-state]')) {
      word.textContent = STATUS_WORDS[this.status];
    }
    const name = this.sessionName();
    this.pill.title = `${name}: ${STATUS_WORDS[this.status]}. ${SHORTCUT_LABEL} to switch.`;
    this.phoneBtn.title = `${name}: ${STATUS_WORDS[this.status]}`;
  }

  private setTrouble(text: string): void {
    if (this.troubleText === text) return;
    this.troubleText = text;
    if (this.connectingTrouble) {
      this.connectingTrouble.textContent = text;
      this.connectingTrouble.hidden = false;
    }
    if (this.connectingStatusText) this.connectingStatusText.textContent = 'Still trying';
    this.revealConnectingButtons();
    // A live session that dropped: bring the connecting screen back over it.
    if (this.wasConnected && this.status !== 'login') this.deps.client.showConnectingScreen();
  }

  private clearTrouble(): void {
    this.troubleText = undefined;
    this.refusals = 0;
    this.failures = 0;
    if (this.connectingTrouble) {
      this.connectingTrouble.hidden = true;
      this.connectingTrouble.textContent = '';
    }
    if (this.connectingStatusText) this.connectingStatusText.textContent = this.connectingStatusDefault;
  }

  // ── Chrome around the existing overlays ────────────────────────────

  private decorateConnectingScreen(): void {
    const overlay = document.getElementById('connecting-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('.connecting-status');
    const first = status?.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      this.connectingStatusText = first as Text;
      this.connectingStatusDefault = first.textContent ?? '';
    }
    this.connectingName = el('div', { class: 'connecting-instance' });
    this.connectingTrouble = el('div', { class: 'connecting-trouble', role: 'status', hidden: '' });
    const actions = el('div', { class: 'connecting-actions' });
    const switchBtn = el('button', { type: 'button', class: 'connecting-reset', hidden: '' }, 'Switch instance');
    switchBtn.addEventListener('click', () => this.openPanel());
    const disconnectBtn = el('button', { type: 'button', class: 'connecting-reset', hidden: '' }, 'Disconnect');
    disconnectBtn.addEventListener('click', () => this.disconnect());
    actions.append(switchBtn, disconnectBtn);
    const reset = document.getElementById('connecting-reset-btn') as HTMLButtonElement | null;
    if (reset) actions.append(reset);
    this.connectingButtons = [switchBtn, disconnectBtn, ...(reset ? [reset] : [])];
    const anchor = status ?? overlay.lastChild;
    if (anchor && anchor.parentNode === overlay) {
      anchor.after(this.connectingName, this.connectingTrouble, actions);
    } else {
      overlay.append(this.connectingName, this.connectingTrouble, actions);
    }
  }

  private revealConnectingButtons(): void {
    for (const btn of this.connectingButtons) {
      btn.hidden = false;
      requestAnimationFrame(() => btn.classList.add('visible'));
    }
  }

  private decorateLoginCard(): void {
    const card = document.querySelector('#login-overlay .login-card');
    if (!card) return;
    this.loginName = el('div', { class: 'login-instance' });
    card.querySelector('h1')?.after(this.loginName);
    this.loginSwitch = el('button', { type: 'button', class: 'login-switch' }, 'Switch instance');
    this.loginSwitch.addEventListener('click', () => this.openPanel());
    card.append(this.loginSwitch);
  }

  /** The splash (no instances yet) also offers the other ways in. */
  private decorateSplash(): void {
    const actions = document.querySelector('#pair-prompt-overlay .pair-actions');
    if (!actions || actions.querySelector('[data-instance-add]')) return;
    const btn = el('button', { type: 'button', class: 'pair-btn secondary', 'data-instance-add': '' }, 'Paste a link or server address');
    btn.addEventListener('click', () => {
      document.getElementById('pair-prompt-overlay')?.classList.remove('visible');
      this.view = 'add';
      this.setMessage('');
      this.openPicker();
    });
    actions.append(btn);
  }

  private updateNames(): void {
    const name = this.sessionName();
    this.pillName.textContent = name;
    if (this.connectingName) this.connectingName.textContent = name;
    if (this.loginName) this.loginName.textContent = `Sign in to ${name}`;
    this.paintStatus();
  }

  private sessionName(): string {
    if (!this.session) return '';
    return this.session.kind === 'instance' ? this.session.instance.name : this.session.name;
  }

  private currentId(): string | undefined {
    return this.session?.kind === 'instance' ? this.session.instance.id : undefined;
  }

  // ── Panel and picker ───────────────────────────────────────────────

  private togglePanel(): void {
    if (this.panelOpen) this.closePanel(); else this.openPanel();
  }

  private openPanel(): void {
    if (!this.session) return;
    this.surface = 'panel';
    this.panelOpen = true;
    this.view = 'list';
    this.editing = undefined;
    this.setMessage('');
    this.refresh();
    this.panel.classList.toggle('phone', this.deps.client.mobileLayout);
    this.panel.hidden = false;
    this.pill.setAttribute('aria-expanded', 'true');
    this.render();
    this.panel.focus({ preventScroll: true });
  }

  private closePanel(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.panel.hidden = true;
    this.pill.setAttribute('aria-expanded', 'false');
    this.cancelProbe();
    if (this.surface === 'panel') this.surface = 'none';
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.panel.contains(active)) active.blur();
  }

  private openPicker(): void {
    this.surface = 'picker';
    this.picker.classList.add('visible');
    this.render();
  }

  private hidePicker(): void {
    this.picker.classList.remove('visible');
  }

  private isOpener(node: Node): boolean {
    return this.pill.contains(node) || this.phoneBtn.contains(node)
      || this.connectingButtons.some((b) => b.contains(node))
      || (this.loginSwitch?.contains(node) ?? false);
  }

  private setMessage(text: string): void {
    this.message = text;
  }

  /** Show a message wherever the user is looking now. */
  private say(text: string): void {
    if (this.surface === 'splash') {
      this.deps.showPairSplash(text);
      this.decorateSplash();
      return;
    }
    this.setMessage(text);
    this.render();
  }

  private render(): void {
    const body = this.surface === 'picker' ? this.pickerBody : this.surface === 'panel' ? this.panelBody : undefined;
    if (!body) return;
    const where = this.surface === 'picker' ? 'picker' : 'panel';
    // Rebuilding removes the focused element, which would hand the keyboard
    // back to the page (and so to the backend). Keep focus inside.
    const root: HTMLElement = where === 'picker' ? this.pickerCard : this.panel;
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && root.contains(active);
    const focused = hadFocus ? (active as HTMLElement).dataset.focusKey : undefined;
    body.replaceChildren();
    const instances = listInstances();

    if (where === 'picker') {
      this.pickerTitle.textContent = instances.length === 0 || this.view === 'add' ? 'Add an instance' : 'Choose an instance';
    } else {
      this.panelTitle.textContent = this.view === 'add' ? 'Add instance' : 'Instances';
    }

    const msg = el('div', { class: 'instance-message', role: 'status' }, this.message);
    body.append(msg);

    if (this.view === 'add' || (where === 'picker' && instances.length === 0)) {
      this.renderAdd(body, where, instances.length);
    } else {
      this.renderList(body, where, instances);
    }

    if (!hadFocus) return;
    const again = focused ? body.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`) : null;
    if (again) {
      again.focus();
    } else if (this.view === 'add' && !this.deps.client.mobileLayout) {
      // Straight to the first field (not on a phone, where focus raises the keyboard).
      body.querySelector<HTMLElement>('input')?.focus();
    } else {
      root.focus({ preventScroll: true });
    }
  }

  private renderList(body: HTMLElement, where: 'panel' | 'picker', instances: Instance[]): void {
    const list = el('div', { class: 'instance-list' });
    if (where === 'panel' && this.session?.kind === 'pairing') {
      list.append(this.pairingRow(this.session.name));
    }
    for (const inst of instances) list.append(this.instanceRow(inst, where));
    if (list.childElementCount === 0) {
      list.append(el('div', { class: 'instance-empty' }, 'No instances yet.'));
    }
    body.append(list);

    const foot = el('div', { class: 'instance-foot' });
    const add = button('Add instance', where === 'picker' ? 'primary' : '', () => {
      this.view = 'add';
      this.setMessage('');
      this.render();
    }, 'add');
    foot.append(add);
    body.append(foot);
  }

  private pairingRow(name: string): HTMLElement {
    const row = el('div', { class: 'instance-row current' });
    const top = el('div', { class: 'instance-row-top' });
    top.append(el('span', { class: 'instance-dot', 'data-status': this.status, 'data-current-dot': '' }),
      el('span', { class: 'instance-name' }, name),
      el('span', { class: 'instance-badge' }, 'Pairing'));
    const detail = el('div', { class: 'instance-detail' }, 'Waiting for the desktop to accept');
    const actions = el('div', { class: 'instance-actions' });
    actions.append(button('Cancel', '', () => this.disconnect()));
    row.append(top, detail, actions);
    return row;
  }

  private instanceRow(inst: Instance, where: 'panel' | 'picker'): HTMLElement {
    const isCurrent = where === 'panel' && this.currentId() === inst.id;
    const isLastUsed = where === 'picker' && selectedInstanceId() === inst.id;
    const editing = this.editing?.id === inst.id ? this.editing.mode : undefined;

    const row = el('div', { class: `instance-row${isCurrent ? ' current' : ''}` });
    const top = el('div', { class: 'instance-row-top' });
    const dot = el('span', { class: 'instance-dot', 'data-status': isCurrent ? this.status : 'idle' });
    if (isCurrent) dot.dataset.currentDot = '';
    top.append(dot);

    if (editing === 'rename') {
      const input = el('input', {
        class: 'instance-input instance-name-input', type: 'text', 'aria-label': 'Instance name',
        maxlength: '60', 'data-focus-key': `rename-${inst.id}`,
      });
      input.value = this.draft.name;
      input.addEventListener('input', () => { this.draft.name = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.commitRename(inst.id); }
      });
      top.append(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      top.append(el('span', { class: 'instance-name', title: inst.name }, inst.name));
      if (isCurrent) top.append(el('span', { class: 'instance-badge' }, 'Current'));
      else if (isLastUsed) top.append(el('span', { class: 'instance-badge quiet' }, 'Last used'));
    }
    row.append(top);

    const detail = el('div', { class: 'instance-detail', title: instanceDetail(inst) });
    if (isCurrent) {
      detail.append(el('span', { class: 'instance-state', 'data-current-state': '' }, STATUS_WORDS[this.status]), ' · ');
    }
    detail.append(instanceDetail(inst));
    row.append(detail);

    const actions = el('div', { class: 'instance-actions' });
    if (editing === 'rename') {
      actions.append(
        button('Save', 'primary', () => this.commitRename(inst.id)),
        button('Cancel', '', () => this.stopEditing()),
      );
    } else if (editing === 'forget') {
      actions.append(
        el('span', { class: 'instance-confirm' }, isCurrent ? 'Forget and disconnect?' : 'Forget this instance?'),
        button('Forget', 'primary', () => this.forget(inst.id)),
        button('Keep', '', () => this.stopEditing(), `forget-no-${inst.id}`),
      );
      requestAnimationFrame(() => row.querySelector<HTMLElement>(`[data-focus-key="forget-no-${inst.id}"]`)?.focus());
    } else {
      if (isCurrent) actions.append(button('Disconnect', '', () => this.disconnect(), `disconnect-${inst.id}`));
      else actions.append(button('Connect', 'primary', () => this.switchTo(inst.id), `connect-${inst.id}`));
      actions.append(
        button('Rename', '', () => this.startEditing(inst, 'rename'), `rename-btn-${inst.id}`),
        button('Forget', 'danger', () => this.startEditing(inst, 'forget'), `forget-${inst.id}`),
      );
    }
    row.append(actions);
    return row;
  }

  private renderAdd(body: HTMLElement, where: 'panel' | 'picker', count: number): void {
    // Pairing link.
    const pairSection = el('div', { class: 'instance-section' });
    pairSection.append(
      el('h3', {}, 'Pair a desktop'),
      el('p', { class: 'instance-hint' }, 'On the desktop, open the Network window, go to Frontends, turn on remote UI and make a pairing QR. Paste its link here, or scan the QR.'),
    );
    const linkForm = el('form', { class: 'instance-form' });
    const linkInput = el('input', {
      class: 'instance-input', type: 'text', placeholder: 'Pairing link', 'aria-label': 'Pairing link',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-focus-key': 'link',
    });
    linkInput.value = this.draft.link;
    linkInput.addEventListener('input', () => { this.draft.link = linkInput.value; });
    linkForm.append(linkInput, el('button', { type: 'submit', class: 'instance-btn primary' }, 'Pair'));
    linkForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.usePairingText(this.draft.link);
    });
    pairSection.append(linkForm);
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      pairSection.append(button('Scan a QR code', 'wide', () => this.scan(), 'scan'));
    }

    // Server address.
    const serverSection = el('div', { class: 'instance-section' });
    serverSection.append(
      el('h3', {}, 'Connect to a server'),
      el('p', { class: 'instance-hint' }, 'The address of an Abject server, such as wss://example.com/ws.'),
    );
    const probe = this.probe;
    const urlForm = el('form', { class: 'instance-form' });
    const urlInput = el('input', {
      class: 'instance-input', type: 'text', inputmode: 'url', placeholder: 'wss://host/ws', 'aria-label': 'Server address',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-focus-key': 'url',
    });
    urlInput.value = this.draft.url;
    urlInput.addEventListener('input', () => { this.draft.url = urlInput.value; });
    const busy = probe?.phase === 'connecting' || probe?.phase === 'signing-in';
    const urlBtn = el('button', { type: 'submit', class: 'instance-btn primary' }, 'Connect');
    if (busy) urlBtn.disabled = true;
    urlForm.append(urlInput, urlBtn);
    urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.useServerAddress(this.draft.url);
    });
    serverSection.append(urlForm);

    if (probe?.phase === 'connecting') {
      serverSection.append(el('div', { class: 'instance-working' }, `Reaching ${probe.url}…`));
    }
    if (probe && (probe.phase === 'login' || probe.phase === 'signing-in')) {
      serverSection.append(this.loginFields(probe));
    }
    if (probe?.error) serverSection.append(el('div', { class: 'instance-message' }, probe.error));

    body.append(pairSection, serverSection);

    const foot = el('div', { class: 'instance-foot' });
    if (where === 'panel' || count > 0) {
      foot.append(button('Back', '', () => {
        this.cancelProbe();
        this.view = 'list';
        this.setMessage('');
        this.render();
      }, 'back'));
    } else {
      foot.append(button('Back', '', () => {
        this.cancelProbe();
        this.view = 'list';
        this.showPicker();
      }, 'back'));
    }
    body.append(foot);
  }

  private loginFields(probe: Probe): HTMLElement {
    const form = el('form', { class: 'instance-fields' });
    form.append(el('div', { class: 'instance-hint' }, `${probe.url} asks you to sign in.`));
    const user = el('input', {
      class: 'instance-input', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': 'Username', 'data-focus-key': 'username', name: 'username',
    });
    user.value = this.draft.username;
    user.addEventListener('input', () => { this.draft.username = user.value; });
    const pass = el('input', {
      class: 'instance-input', type: 'password', autocomplete: 'current-password',
      'aria-label': 'Password', 'data-focus-key': 'password', name: 'password',
    });
    const submit = el('button', { type: 'submit', class: 'instance-btn primary wide' }, probe.phase === 'signing-in' ? 'Signing in…' : 'Sign in');
    if (probe.phase === 'signing-in') submit.disabled = true;
    form.append(el('label', {}, 'Username'), user, el('label', {}, 'Password'), pass, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.draft.username || !pass.value) return;
      this.signIn(this.draft.username, pass.value);
    });
    if (probe.phase === 'login' && !probe.error) requestAnimationFrame(() => (this.draft.username ? pass : user).focus());
    return form;
  }

  // ── Actions ────────────────────────────────────────────────────────

  private switchTo(id: string): void {
    selectInstance(id);
    location.reload();
  }

  private disconnect(): void {
    markDisconnected();
    location.reload();
  }

  private startEditing(inst: Instance, mode: 'rename' | 'forget'): void {
    this.editing = { id: inst.id, mode };
    if (mode === 'rename') this.draft.name = inst.name;
    this.setMessage('');
    this.render();
  }

  private stopEditing(): void {
    const id = this.editing?.id;
    this.editing = undefined;
    this.render();
    if (id) this.focusKey(`rename-btn-${id}`);
  }

  private commitRename(id: string): void {
    renameInstance(id, this.draft.name);
    this.editing = undefined;
    if (this.session?.kind === 'instance' && this.session.instance.id === id) {
      const fresh = listInstances().find((i) => i.id === id);
      if (fresh) this.session = { kind: 'instance', instance: fresh };
      this.updateNames();
    }
    this.render();
    this.focusKey(`rename-btn-${id}`);
  }

  private forget(id: string): void {
    const wasCurrent = this.currentId() === id;
    forgetInstance(id);
    this.editing = undefined;
    if (wasCurrent) {
      // The selection is gone with it: the reload lands on the picker.
      location.reload();
      return;
    }
    if (this.surface === 'picker' && listInstances().length === 0) {
      this.showPicker();
      return;
    }
    this.render();
  }

  private scan(): void {
    this.deps.scanQr(
      (text) => this.usePairingText(text),
      (problem) => this.say(problem),
    );
  }

  /** A pasted link or scanned QR: reload into the pairing it carries. */
  private usePairingText(text: string): void {
    const payload = parsePairingText(text.trim());
    if (!payload) {
      this.say('That is not a pairing link. Copy it from Network, Frontends on your desktop.');
      return;
    }
    if (payload.expires < Date.now()) {
      this.say('That pairing link has expired. Make a new one on your desktop.');
      return;
    }
    location.replace(pairingPageUrl(payload));
  }

  private useServerAddress(text: string): void {
    const result = normalizeServerUrl(text);
    if ('error' in result) {
      this.cancelProbe();
      this.setMessage(result.error);
      this.render();
      return;
    }
    const existing = findUrlInstance(result.url);
    if (existing) {
      this.switchTo(existing.id);
      return;
    }
    this.setMessage('');
    this.startProbe(result.url);
  }

  private signIn(username: string, password: string): void {
    const probe = this.probe;
    if (!probe) return;
    probe.error = undefined;
    if (probe.ws && probe.ws.readyState === WebSocket.OPEN && probe.phase === 'login') {
      probe.phase = 'signing-in';
      probe.ws.send(JSON.stringify({ type: 'auth', username, password }));
      this.render();
      return;
    }
    // The server closes a login left waiting; ask again on a fresh socket.
    this.startProbe(probe.url, { username, password });
  }

  /**
   * Try a server address before saving it: it either lets this page in
   * (authNotRequired), asks for a login (authRequired), or cannot be reached.
   */
  private startProbe(url: string, login?: { username: string; password: string }): void {
    this.cancelProbe();
    const probe: Probe = { url, phase: login ? 'signing-in' : 'connecting', pendingLogin: login };
    this.probe = probe;
    const unreachable = `Could not connect to ${url}. Check the address. A server you run must also list ${location.origin} in ABJECTS_ALLOWED_ORIGINS.`;
    const fail = (text: string) => {
      if (this.probe !== probe || probe.done) return;
      clearTimeout(probe.timer);
      probe.phase = 'failed';
      probe.error = text;
      try { probe.ws?.close(); } catch { /* ignore */ }
      probe.ws = undefined;
      this.render();
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      fail(unreachable);
      return;
    }
    probe.ws = ws;
    probe.timer = setTimeout(() => fail('That server did not answer.'), 10_000);
    ws.onmessage = (ev) => {
      if (this.probe !== probe || typeof ev.data !== 'string') return;
      let msg: { type?: string; success?: boolean; token?: string; error?: string };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'authNotRequired') {
        this.finishProbe(probe);
      } else if (msg.type === 'authRequired') {
        clearTimeout(probe.timer);
        if (probe.pendingLogin) {
          ws.send(JSON.stringify({ type: 'auth', ...probe.pendingLogin }));
          probe.pendingLogin = undefined;
          probe.phase = 'signing-in';
        } else {
          probe.phase = 'login';
        }
        this.render();
      } else if (msg.type === 'authResult') {
        if (msg.success && msg.token) {
          this.finishProbe(probe, msg.token);
        } else {
          probe.phase = 'login';
          probe.error = msg.error === 'Invalid credentials' ? 'Wrong username or password.' : (msg.error ?? 'Sign in failed.');
          this.render();
        }
      }
    };
    ws.onclose = () => {
      if (this.probe !== probe || probe.done) return;
      if (probe.phase === 'login') {
        // Waiting on the user: the next Sign in opens a fresh socket.
        probe.ws = undefined;
        return;
      }
      fail(probe.phase === 'signing-in' ? 'The server closed the connection. Try again.' : unreachable);
    };
    this.render();
  }

  private finishProbe(probe: Probe, token?: string): void {
    probe.done = true;
    clearTimeout(probe.timer);
    try { probe.ws?.close(); } catch { /* ignore */ }
    const inst = addUrlInstance(probe.url);
    if (token) {
      try { localStorage.setItem(authTokenKey(inst.id), token); } catch { /* storage unavailable */ }
    }
    this.draft.url = '';
    this.draft.username = '';
    this.switchTo(inst.id);
  }

  private cancelProbe(): void {
    const probe = this.probe;
    if (!probe) return;
    this.probe = undefined;
    probe.done = true;
    clearTimeout(probe.timer);
    try { probe.ws?.close(); } catch { /* ignore */ }
  }

  private focusKey(key: string): void {
    requestAnimationFrame(() => {
      const body = this.surface === 'picker' ? this.pickerBody : this.panelBody;
      body.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
    });
  }

  // ── Keyboard and event isolation ───────────────────────────────────

  private isToggleKey(e: KeyboardEvent): boolean {
    const primary = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    return primary && e.shiftKey && !e.altKey && (e.code === 'KeyO' || e.key === 'o' || e.key === 'O');
  }

  private installKeys(): void {
    // Capture on window runs before FrontendClient's document listeners, so
    // the shortcut (and an Escape closing the panel) never reach the backend.
    window.addEventListener('keydown', (e) => {
      if (this.session && this.isToggleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        this.keysTaken.add(e.code);
        if (!e.repeat) this.togglePanel();
        return;
      }
      if (this.panelOpen && e.key === 'Escape' && !this.panel.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        this.keysTaken.add(e.code);
        this.closePanel();
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (!this.keysTaken.delete(e.code)) return;
      // A keyup inside the panel or picker stops there on its own.
      const target = e.target as Node | null;
      if (target && (this.panel.contains(target) || this.picker.contains(target))) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /** Keep a surface's input to itself: nothing typed or clicked there reaches the canvas or backend. */
  private isolate(root: HTMLElement): void {
    root.addEventListener('keydown', (e) => {
      this.keysTaken.add(e.code);
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (this.editing) { this.stopEditing(); return; }
      if (this.view === 'add' && (root === this.panel || listInstances().length > 0)) {
        this.cancelProbe();
        this.view = 'list';
        this.setMessage('');
        this.render();
        this.focusKey('add');
        return;
      }
      if (root === this.panel) this.closePanel();
    });
    for (const type of ISOLATED_EVENTS) {
      root.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    }
  }
}

// ── DOM helpers ──────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, variant: string, onClick: () => void, focusKey?: string): HTMLButtonElement {
  const btn = el('button', { type: 'button', class: `instance-btn${variant ? ` ${variant}` : ''}` }, label);
  if (focusKey) btn.dataset.focusKey = focusKey;
  btn.addEventListener('click', onClick);
  return btn;
}
