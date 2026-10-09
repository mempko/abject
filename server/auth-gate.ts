/**
 * AuthGate -- the login every socket of this instance checks.
 *
 * The UI socket, the terminal gateway (CliServer) and the HTTP gateway share
 * one AuthConfig and one SessionStore, so one login token works on all of
 * them. The login itself is a setting, saved and validated by SettingsManager;
 * this object is where it takes effect. It used to take effect only as a side
 * effect of a message to the display server, which meant an instance without a
 * display (the headless server) saved a login and never enforced it.
 *
 * Main thread only: it holds the live config objects the sockets read.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { request } from '../src/core/message.js';
import { require as contractRequire, invariant } from '../src/core/contracts.js';
import { Log } from '../src/core/timed-log.js';
import type { AuthConfig, SessionStore } from './auth.js';

const log = new Log('AuthGate');

const AUTH_GATE_INTERFACE: InterfaceId = 'abjects:auth-gate';

export const AUTH_GATE_ID = 'abjects:auth-gate' as AbjectId;

/** The only object that may change the login: it validates and persists it. */
const AUTH_WRITERS = ['SettingsManager'] as const;

export interface AuthGateArgs {
  authConfig: AuthConfig;
  sessions: SessionStore;
}

export class AuthGate extends Abject {
  private readonly authConfig: AuthConfig;
  private readonly sessions: SessionStore;

  constructor(args: AuthGateArgs) {
    super({
      manifest: {
        name: 'AuthGate',
        description:
          'The login checked by every socket of this instance (desktop UI, terminal gateway, HTTP gateway). ' +
          'Changed only through the settings; reports whether a login is required.',
        version: '1.0.0',
        interface: {
          id: AUTH_GATE_INTERFACE,
          name: 'AuthGate',
          description: 'Login enforcement for this instance',
          methods: [
            {
              name: 'getAuthState',
              description: 'Whether a login is required, and the username when it is.',
              parameters: [],
              returns: { kind: 'object', properties: {
                enabled: { kind: 'primitive', primitive: 'boolean' },
                username: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'updateAuth',
              description: 'Apply a login (from SettingsManager only). A change signs every session out.',
              parameters: [
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Require login' },
                { name: 'username', type: { kind: 'primitive', primitive: 'string' }, description: 'Username' },
                { name: 'password', type: { kind: 'primitive', primitive: 'string' }, description: 'Password' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'security'],
      },
    });
    contractRequire(!!args?.authConfig && !!args.sessions, 'AuthGate needs the shared auth config and session store');
    this.authConfig = args.authConfig;
    this.sessions = args.sessions;
    this.setupHandlers();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(!this.authConfig.enabled || (this.authConfig.username !== '' && this.authConfig.password !== ''),
      'AuthGate: login enabled without credentials');
  }

  private setupHandlers(): void {
    this.on('getAuthState', () => ({
      enabled: this.authConfig.enabled,
      username: this.authConfig.enabled ? this.authConfig.username : '',
    }));

    this.on('updateAuth', async (msg: AbjectMessage) => {
      const caller = await this.resolveCallerIdentity(msg.routing.from);
      const segments = caller?.typeId ? String(caller.typeId).split('/').length : 0;
      contractRequire(!!caller && (AUTH_WRITERS as readonly string[]).includes(caller.name) && segments <= 3,
        'AuthGate takes login changes from SettingsManager only');
      const { enabled, username, password } = (msg.payload ?? {}) as {
        enabled?: unknown; username?: unknown; password?: unknown;
      };
      contractRequire(typeof enabled === 'boolean', 'enabled must be true or false');
      contractRequire(typeof username === 'string' && typeof password === 'string', 'username and password must be strings');
      contractRequire(!enabled || ((username as string) !== '' && (password as string) !== ''), 'a login needs a username and a password');

      const changed = this.authConfig.enabled !== enabled
        || this.authConfig.username !== username
        || this.authConfig.password !== password;
      this.authConfig.enabled = enabled as boolean;
      this.authConfig.username = username as string;
      this.authConfig.password = password as string;
      this.checkInvariants();
      if (!changed) return true;

      this.sessions.clearAll();
      log.info(`Login ${this.authConfig.enabled ? 'required' : 'not required'}; sessions cleared`);
      // A desktop's browser clients hold live connections made under the old
      // login: sign them out so they come back through the gate.
      const uiServerId = await this.discoverDep('UIServer');
      if (uiServerId) {
        try { await this.request(request(this.id, uiServerId, 'signOutClients', {})); } catch { /* no clients */ }
      }
      return true;
    });
  }
}
