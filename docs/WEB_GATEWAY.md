# The web gateway

`WebGateway` is the one object that listens for inbound HTTP. Each workspace's
`WebExposure` says which of its abjects are reachable and how; the gateway
serves them under `/<workspace>/<abject>`, both addressed by a slug of their
name so routes survive restarts.

It is off until enabled (`WebGateway.setEnabled`), listens on `WS_PORT+5`
(`HTTP_PORT`), and binds loopback unless `HTTP_BIND` says otherwise. It serves
plain HTTP; put a TLS proxy in front to expose it.

## Two ways to serve an abject

A `WebExposure` entry (`setEntry { name, access, methods?, mode?, handler? }`)
chooses one:

| Mode | Routes | For |
|---|---|---|
| `methods` (default) | `POST /<ws>/<abject>/<method>`, JSON body in, JSON out; `GET /<ws>/<abject>` shows a generated form page and `openapi.json` | APIs |
| `http` | Every request under `/<ws>/<abject>`, any HTTP method, any sub-path, goes to one handler method (`handleHttp` unless the entry names another) | Web pages, sign-in flows, webhooks |

`access` is `public` or `authenticated`. Authenticated routes need a bearer
token: an API token minted with `WebGateway.mintToken`, or a desktop session.
A web portal with its own sign-in uses a `public` entry and keeps its own
session cookie.

Meta and editing methods (`describe`, `ask`, `getSource`, `updateSource`, …)
are never reachable, as methods or as handlers.

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
  bodyBase64?: string;
  json?: unknown;                  // sets application/json
  redirect?: string;
}
```

A script package can serve pages (types in `sdk/script/abject.d.ts`):

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
- **Errors do not leak.** A handler that throws or times out answers the
  client with a plain 500 or 504; the error goes to the log.
- **Bodies.** Requests up to 1 MB; the text form is exactly the bytes sent
  (UTF-8), so a webhook signature over the raw body can be checked.
  Responses up to 16 MB.

The settings window rewrites every entry when it saves and knows only access
levels; an entry keeps its `mode` and `handler` unless the save names a mode.
