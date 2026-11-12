/**
 * The Settings window's checkboxes, from the click to what SettingsManager
 * keeps.
 *
 * CheckboxWidget reports 'true' or 'false' as a string (widget-manager.ts
 * documents it), so each test clicks real checkboxes and a real Save button
 * and reads the result back from the real SettingsManager. GlobalSettings is
 * the real class with its window left unbuilt: WindowlessSettings's onInit
 * only finds SettingsManager and Storage, and the test sets the widget ids the
 * window would set and subscribes to the widgets as the window does. The
 * stand-ins are Storage (a Map), LLM (one chat provider), AuthGate (it records
 * what it is told), a CliServer endpoint that seeds settings (SettingsManager
 * takes writes from it), a Person endpoint that clicks and serves as the
 * widgets' UI server, the window, the status line, and the login name and
 * password fields, which answer getValue and remember whether they were
 * disabled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { Registry } from './registry.js';
import { CheckboxWidget } from './widgets/checkbox-widget.js';
import { ButtonWidget } from './widgets/button-widget.js';
import { GlobalSettings } from './global-settings.js';
import { SettingsManager } from './settings-manager.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Settings fixture',
      interface: { id: `fixture:${name}` as InterfaceId, name, description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call<T = any>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> { return this.request<T>(request(this.id, to, method, payload), 5000); }
}

/** The settings window without its window: onInit only finds its peers. */
class WindowlessSettings extends GlobalSettings {
  protected override async onInit(): Promise<void> {
    const self = this as any;
    self.settingsManagerId = await this.requireDep('SettingsManager');
    self.storageId = await this.requireDep('Storage');
  }
}

async function world() {
  const bus = new MessageBus();
  const registry = new Registry();
  const objects: Abject[] = [];
  const stop = async () => {
    for (const o of objects.reverse()) { try { await o.stop(); } catch { /* already stopped */ } }
    try { await registry.stop(); } catch { /* not started */ }
  };
  try {
    await registry.init(bus);
    const add = async <T extends Abject>(o: T): Promise<T> => {
      o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
    };

    const store = new Map<string, unknown>();
    const storage = await add(new Endpoint('Storage'));
    storage.on('get', (msg: any) => store.get(msg.payload.key) ?? null);
    storage.on('set', (msg: any) => { store.set(msg.payload.key, msg.payload.value); return true; });
    const llm = await add(new Endpoint('LLM'));
    llm.on('configure', () => true);
    // One chat provider, so the AI section can hold a model tier as a real one must.
    llm.on('listProviderDescriptions', () => [{ id: 'local', label: 'Local', storageSuffix: 'localUrl', credentialMode: 'none' }]);
    const authGate = await add(new Endpoint('AuthGate'));
    const authUpdates: Array<{ enabled: boolean }> = [];
    authGate.on('updateAuth', (msg: any) => { authUpdates.push(msg.payload); return true; });
    const manager = await add(new SettingsManager());
    // SettingsManager takes writes from the CLI server as well as the window.
    const cli = await add(new Endpoint('CliServer'));
    const settings = await add(new WindowlessSettings());
    const person = await add(new Endpoint('Person'));

    const window = await add(new Endpoint('Window'));
    window.on('effect', () => true);
    const status: string[] = [];
    const statusLine = await add(new Endpoint('StatusLine'));
    statusLine.on('update', (msg: any) => { if (msg.payload.text) status.push(msg.payload.text); return true; });

    /** A login field: answers getValue and remembers its disabled style. */
    const field = async (name: string, value: string) => {
      const f = await add(new Endpoint(name));
      const state = { value, disabled: false };
      f.on('getValue', () => state.value);
      f.on('update', (msg: any) => { if (typeof msg.payload.style?.disabled === 'boolean') state.disabled = msg.payload.style.disabled; return true; });
      return { id: f.id, state };
    };

    const self = settings as any;
    const checkbox = async (field: string, text: string, checked: boolean) => {
      const box = await add(new CheckboxWidget({ type: 'checkbox', rect: { x: 0, y: 0, width: 240, height: 28 },
        text, checked, ownerId: window.id, uiServerId: person.id }));
      self[field] = box.id;
      await self.request(request(settings.id, box.id, 'addDependent', {}));
      return box;
    };
    const button = async (field: string, text: string) => {
      const b = await add(new ButtonWidget({ type: 'button', rect: { x: 0, y: 0, width: 80, height: 28 },
        text, ownerId: window.id, uiServerId: person.id }));
      self[field] = b.id;
      await self.request(request(settings.id, b.id, 'addDependent', {}));
      return b;
    };
    /** What the window does when it opens: load SettingsManager's values into the forms. */
    const open = async () => {
      self.windowId = window.id;
      self.statusLabelId = statusLine.id;
      await self.loadFromManager();
    };

    const click = (widget: Abject) => person.call(widget.id, 'handleInput', { type: 'mousedown', x: 5, y: 5 });
    const read = <T = any>(section: string) => person.call<T>(manager.id, 'getSettings', { section });
    const write = (section: string, values: Record<string, unknown>) => cli.call(manager.id, 'setSettings', { section, values });
    return { settings, status, authUpdates, field, checkbox, button, open, click, read, write, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Wait up to 3 s for `done`, a click's handler running after the click returns; fail naming what never happened. */
async function until(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test('the Permissions checkboxes save what they show: shell, web and read-only, both ways', async () => {
  const w = await world();
  try {
    await w.write('shell', { enabled: true });
    await w.write('web', { enabled: true });
    await w.write('filesystem', { readOnly: false });
    await w.open();
    const shell = await w.checkbox('shellEnabledCheckboxId', 'Enable shell execution', true);
    const web = await w.checkbox('webEnabledCheckboxId', 'Enable HTTP requests', true);
    const readOnly = await w.checkbox('fsReadOnlyCheckboxId', 'Read-only mode (block all writes)', false);
    const save = await w.button('permsSaveBtnId', 'Save');

    await w.click(shell);
    await w.click(web);
    await w.click(readOnly);
    await w.click(save);
    await until('the save reports', () => w.status.length > 0);
    assert.deepEqual(w.status, ['Permissions saved!'], 'the save goes through');
    assert.equal((await w.read('shell')).enabled, false, 'unticked shell is saved off');
    assert.equal((await w.read('web')).enabled, false, 'unticked web is saved off');
    assert.equal((await w.read('filesystem')).readOnly, true, 'ticked read-only is saved on');

    w.status.length = 0;
    await w.click(shell);
    await w.click(web);
    await w.click(readOnly);
    await w.click(save);
    await until('the second save reports', () => w.status.length > 0);
    assert.deepEqual(w.status, ['Permissions saved!'], 'the second save goes through');
    assert.equal((await w.read('shell')).enabled, true, 'ticked again, shell is saved on');
    assert.equal((await w.read('web')).enabled, true, 'ticked again, web is saved on');
    assert.equal((await w.read('filesystem')).readOnly, false, 'unticked, read-only is saved off');
  } finally { await w.stop(); }
});

test('unticking "Require login" greys out the login fields and saves login off', async () => {
  const w = await world();
  try {
    await w.write('auth', { enabled: true, username: 'ana', password: 'correct horse' });
    await w.open();
    const user = await w.field('LoginName', 'ana');
    const pass = await w.field('LoginPassword', 'correct horse');
    const self = w.settings as any;
    self.authUserInputId = user.id;
    self.authPassInputId = pass.id;
    const requireLogin = await w.checkbox('authCheckboxId', 'Require login', true);
    const save = await w.button('authSaveBtnId', 'Save');

    await w.click(requireLogin);
    await until('the login fields are disabled', () => user.state.disabled && pass.state.disabled);
    assert.equal(user.state.disabled, true, 'unticked, the name field is disabled');
    assert.equal(pass.state.disabled, true, 'and so is the password field');

    const told = w.authUpdates.length;
    await w.click(save);
    await until('AuthGate hears of the save', () => w.authUpdates.length > told);
    assert.equal((await w.read('auth')).enabled, false, 'login is saved off');
    assert.equal(w.authUpdates.at(-1)?.enabled, false, 'and AuthGate is told so');

    await w.click(requireLogin);
    await until('the login fields come back', () => !user.state.disabled && !pass.state.disabled);
    assert.equal(user.state.disabled, false, 'ticked again, the name field comes back');
    assert.equal(pass.state.disabled, false, 'and so does the password field');
    const toldAgain = w.authUpdates.length;
    await w.click(save);
    await until('AuthGate hears of the second save', () => w.authUpdates.length > toldAgain);
    assert.equal((await w.read('auth')).enabled, true, 'and login is saved on');
    assert.equal(w.authUpdates.at(-1)?.enabled, true, 'and AuthGate is told so');
  } finally { await w.stop(); }
});

test('the prompt-cache keepalive checkbox saves with the AI settings, both ways', async () => {
  const w = await world();
  try {
    await w.write('ai', { tiers: { smart: { provider: 'local', model: 'm' } }, cacheKeepalive: false });
    await w.open();
    const keepalive = await w.checkbox('cacheKeepaliveCheckboxId', 'Keep prompt caches warm', false);
    const save = await w.button('saveBtnId', 'Save');

    await w.click(keepalive);
    await w.click(save);
    await until('the AI save reports', () => w.status.length > 0);
    assert.equal((await w.read('ai')).cacheKeepalive, true, `ticked keepalive is saved on (status: ${w.status.join(' | ')})`);

    w.status.length = 0;
    await w.click(keepalive);
    await w.click(save);
    await until('the second AI save reports', () => w.status.length > 0);
    assert.equal((await w.read('ai')).cacheKeepalive, false, `unticked keepalive is saved off (status: ${w.status.join(' | ')})`);
  } finally { await w.stop(); }
});
