# LLM providers implemented by abjects

The LLM object routes model calls to providers. Most are built in (Anthropic,
OpenAI, Ollama, the coding CLIs and so on). Any abject can add one more: it
registers with the LLM object by message, and the calls routed to it arrive as
messages. Shipped as a package (`docs/PACKAGES.md`), a provider is added to
an instance by configuration, with no change to the server.

Once registered, a provider is used like a built-in one:

- **Visible:** it appears in Settings → AI (tier routing, fallbacks) and in `listProviders`.
- **Routed:** tier routing, fallbacks, goal budgets, the ledger and streaming to callers all apply to it.

## Registering

Send `registerProvider` to the object named `LLM`, usually from a `startup`
handler (tag the abject `autostart`):

```js
async startup() {
  return this.call(this.dep('LLM'), 'registerProvider', {
    name: 'my-gateway',                 // id used by tier routing and the ledger
    label: 'My gateway',                // shown in the provider dropdown
    models: [{ id: 'big', name: 'Big' }, { id: 'small', name: 'Small' }],
    defaultTierModels: { smart: 'big', balanced: 'big', fast: 'small' },
    streaming: false,                   // true if you implement providerStream
    liveModels: false,                  // true if you implement providerModels
  });
}
```

The reply is `{ name, registered, backends }`.

**Names:**

- A name is lowercase letters, digits, `.`, `_` or `-`.
- Built-in provider names are reserved.
- A name is held by one abject, or by every abject of one installed package. A package spawns in every workspace; each copy joins the same provider, any of them may serve, and a copy that goes away is dropped.
- Another abject cannot take a name while its holder is running. Once the holder is gone, the name is free.

**Registration is in memory and lasts as long as the LLM object.** Register on
startup, and register again whenever your configuration changes. Registering
again from the same abject updates it. `unregisterProvider { name }` withdraws
the sender.

## Serving calls

The LLM object always fills in `options.model` (from the request, tier
routing, or your `defaultTierModels`).

| Message to your abject | You reply |
|---|---|
| `providerComplete { messages, options }` | `{ content, finishReason?, usage? }` |
| `providerStream { streamId, messages, options }` (with `streaming: true`) | Emit `providerChunk { streamId, content }` events to the sender, then reply `{ chunks, stopReason?, usage? }`, where `chunks` is how many you emitted |
| `providerModels {}` (with `liveModels: true`) | `[{ id, name, vision?, efforts?, contextWindow? }]` |

- **Messages** are `{ role, content }`, where `content` is a string or an array of
  `{ type: 'text', text }`, `{ type: 'image', mediaType, data }` and
  `{ type: 'document', mediaType, data }` parts.
- **Usage** is `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }`.
  Reporting `costUsd` prices the call in the ledger. Without it, the call is
  priced from `setModelPricing` overrides, or counted as unpriced.
- **Errors:** throw and the caller gets your error message. A configured
  fallback route is tried next, as for a built-in provider.

A call may take up to `timeoutMs` (default 10 minutes) without progress.

## Credentials and settings

Settings → AI shows no credential row for an abject-backed provider; the
provider manages its own. In a package, declare what it needs in
`abject.json` `settings` (a `secret` type for keys), and read the values with
`Packages.getSettings`, which answers only that package's own abjects. Observe
the `Packages` object and handle `changed` (aspect `settingsChanged`) to
re-register when they change.

## Network access

A provider that calls an HTTP API goes through the `HttpClient` abject.
`HttpClient` refuses private and internal addresses (`localhost`, `10.x`,
`172.16-31.x`, `192.168.x`, `169.254.x`, IPv6 loopback and local ranges)
unless the instance owner lists them under **Private hosts** in Settings →
Permissions → Web. It checks the addresses a host resolves to, so a public
name that points at an internal address is refused too, and it checks every
redirect the same way.

To use a model server on the local machine or a private network, add an entry
for it:

| Entry | Allows |
|---|---|
| `localhost:11434` | That name, on that port, whatever it resolves to |
| `models.internal` | That name, on any port |
| `*.corp.example` | Any subdomain of `corp.example` (not `corp.example` itself) |
| `127.0.0.1:8080`, `[::1]:8080` | That address, on that port, under any name |
| `10.0.0.0/8`, `fd00::/8` | Any address in the range, on any port |

Every private address a host resolves to must be covered, so `127.0.0.1`
alone does not open `localhost`, which also resolves to `::1`; list the name
instead. The domain allow and deny lists still apply on top. Prefer an entry
with a port: a bare `localhost` also exposes the instance's own local ports
(the UI and CLI gateway) to every abject.

The built-in providers send completions and model lists through `HttpClient`
too, so a built-in pointed at a local base URL needs the same entry. Their
streaming requests, OpenAI audio, and Ollama fetch directly.

## Example

`examples/openai-compatible-provider`: a provider for any OpenAI-compatible
chat endpoint, written in TypeScript. Its settings are the base URL, an API
key, the model list, and the provider id and label. It registers on startup,
re-registers when its settings change, and maps messages (text and images) and
usage between the two formats.

```bash
pnpm forge examples/openai-compatible-provider   # install
pnpm awaken                                     # it registers on startup
```

Then fill in its settings in Settings → Packages → OpenAICompatible, and pick
its models in Settings → AI.
