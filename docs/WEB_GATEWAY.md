# The web gateway

`WebGateway` is the one object that listens for inbound HTTP. Each workspace's
`WebExposure` says which of its abjects are reachable and how; the gateway
serves them under `/<workspace>/<abject>`, both addressed by a slug of their
name (lowercase, runs of other characters turned into `-`) so routes survive
restarts. Two workspaces whose names give the same slug are told apart by a
few characters of the workspace id.

It is off until enabled (`WebGateway.setEnabled`). It listens on `HTTP_PORT`
(default `WS_PORT+5`, so 7724) and binds loopback unless `HTTP_BIND` says
otherwise. Once it has listened, its port is saved and used again at the next
start; `WebGateway.setPort` changes it (0 lets the system pick), and a port
already in use falls back to one the system picks. `getStatus` reports the
address it is on. It serves plain HTTP; put a TLS proxy in front to expose it.

Both editions run the gateway. On the desktop, its window (WebGatewayBrowser)
turns it on and off, shows the live routes and mints and revokes API tokens,
and each workspace's Settings window has a Web tab for its entries. The
headless edition has neither window: send `WebGateway` its messages
(`setEnabled`, `mintToken`) from an abject in a local workspace, and edit a
workspace's web settings with the `abject` command (`/wset web.enabled on`,
`/wset web.entries.<Name> public|authenticated|none`).

`setEnabled`, `setPort`, `mintToken` and `revokeToken` are taken from the
gateway's window, the Peer Network window and abjects in a local workspace
this machine hosts; any other sender is refused, an abject in a shared or
public workspace included. A workspace's routes (`syncWorkspace`,
`dropWorkspace`) come only from that workspace's own `WebExposure`, and the
gateway reaches its abjects through the registry WorkspaceManager lists for
it. Reading (`getStatus`, `getRoutes`, `listTokens`, `getPort`) is open.

## Two ways to serve an abject

A workspace serves nothing until its `WebExposure` is enabled
(`setEnabled { enabled: true }`). An entry (`setEntry { name, access,
methods?, mode?, handler? }`, keyed by the abject's registered name) chooses
one mode:

| Mode | Routes | For |
|---|---|---|
| `methods` (default) | `POST /<ws>/<abject>/<method>`, JSON body in, JSON out; `GET /<ws>/<abject>` shows a generated form page and `openapi.json` | APIs |
| `http` | Every request under `/<ws>/<abject>`, any HTTP method, any sub-path, goes to one handler method (`handleHttp` unless the entry names another) | Web pages, sign-in flows, webhooks |

`access` is `public` or `authenticated` (anything else is taken as
`authenticated`). Authenticated routes need a bearer token: an API token
minted with `WebGateway.mintToken` (shown once, stored only as a hash), or a
session token from the instance's login, which AuthGate keeps for every socket
(the desktop UI, the terminal gateway and this one). A web portal with its own
sign-in uses a `public` entry and keeps its own session cookie.

The gateway finds the abject by name in the workspace's registry at request
time; one that is not running answers 404. The method or handler must be
declared in the abject's manifest. Meta and editing methods (`describe`,
`ask`, `getSource`, `updateSource`, `updateManifest`, `ping`, `getRegistry`,
`addDependent`, `removeDependent`, `probe`, `getResultContract`, `checkpoint`,
`snapshotTask`, `restoreTask`) are never reachable, as methods or as handlers.

`GET /` lists the workspaces that expose something and `GET /<ws>/` lists a
workspace's abjects, as HTML, or as JSON when the request accepts
`application/json`.

## methods mode

`methods` on the entry limits which methods are routes; without it, every
method the manifest declares (other than the meta methods) is one. The JSON
body is the payload (an empty body is `{}`), and the reply is
`{ ok: true, result }`. A domain failure comes back as 422 with
`{ ok: false, result }`: a result whose success field is `false`, where the
field is the one the method's result contract names, or `success` when the
method declares it returns an object with a boolean `success`. Errors answer `{ ok: false, error, code }`: 404
for an unknown method, 403 for a denial, 504 for a timeout, 500 otherwise. A
body that is not JSON is 400; one over 1 MB is 413.

## http mode

The handler receives one request, whole:

```ts
interface WebRequest {
  method: string;
  path: string;            // after the abject's route, from '/'
  basePath: string;        // '/<ws>/<abject>': prefix links and redirects with it
  query: Record<string, string | string[]>;
  headers: Record<string, string>;   // lowercased names
  cookies: Record<string, string>;
  body?: string;           // text bodies: JSON, forms, text, XML
  bodyBase64?: string;     // anything else
  remoteAddress?: string;
}
```

and answers:

```ts
interface WebResponse {
  status?: number;                 // default 200 (302 with redirect)
  headers?: Record<string, string>;
  cookies?: WebCookie[];           // { name, value (null deletes), path?, domain?, maxAge?,
                                   //   expires?, httpOnly?, secure?, sameSite? }
  body?: string;                   // Content-Type defaults to text/plain
  bodyBase64?: string;             // Content-Type defaults to application/octet-stream
  json?: unknown;                  // sets application/json
  redirect?: string;
}
```

`{}` is an empty 200. A script package can serve pages (types in
`sdk/script/abject.d.ts`); its manifest declares `handleHttp` like any other
method:

```js
({
  async startup() {
    const exposure = this.dep('WebExposure');
    await this.call(exposure, 'setEntry', { name: 'Portal', access: 'public', mode: 'http' });
    await this.call(exposure, 'setEnabled', { enabled: true });
  },
  handleHttp(msg) {
    const req = msg.payload;
    if (req.path === '/login') {
      return { redirect: req.basePath + '/home', cookies: [{ name: 'session', value: 'abc' }] };
    }
    return { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<h1>Hello</h1>' };
  }
})
```

What the gateway keeps for itself:

- **Cookies are scoped to the route.** A cookie's `Path` defaults to the
  abject's `basePath`, and it is `HttpOnly` and `SameSite=Lax` unless the
  handler says otherwise, so one workspace's portal never receives another's
  session on the same host. `Set-Cookie` in `headers` is dropped; cookies go
  through `cookies`. `SameSite=None` is always `Secure`.
- **Hop-by-hop headers and Content-Length** are the gateway's, not the
  handler's. `X-Content-Type-Options: nosniff` is set unless overridden.
- **A reply that is not a valid response** (a bad status, a header with a
  line break, a malformed cookie) becomes a 500, and nothing of it is sent.
- **Errors do not leak.** A handler that throws or times out (it has 2
  minutes) answers the client with a plain 500 or 504; the error goes to the
  log. An entry whose handler the manifest does not declare answers 500.
- **Bodies.** Requests up to 1 MB; the text form is exactly the bytes sent
  (UTF-8), so a webhook signature over the raw body can be checked.
  Responses up to 16 MB.

The workspace Settings window rewrites every entry when it saves and knows
only access levels; an entry keeps its `mode` and `handler` unless the save
names a mode. The `abject` command's `/wset web.entries.<Name>` changes only
the access level and keeps the rest of the entry.
