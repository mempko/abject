# LLM providers implemented by abjects

The LLM object routes model calls to providers. Most are built in (Anthropic,
OpenAI, Ollama, the coding CLIs and so on). Any abject can add one more: it
registers with the LLM object by message, and the calls routed to it arrive as
messages. Shipped as a package (`docs/PACKAGES.md`), a provider is added to
an instance by configuration, with no change to the server.

Once registered, a provider is used like a built-in one:

- **Visible:** it appears in Settings → AI (tier routing, fallbacks), in `listProviders`, and in `listProviderDescriptions`. `SettingsManager` follows each registration, so its tiers can be set to the provider at once (from Settings, `abject settings`, or `setSettings`), and a tier saved for it is kept while it is not registered.
- **Routed:** tier routing, fallbacks, goal budgets, the ledger and streaming to callers all apply to it.

The adapter on the LLM object's side is `src/llm/remote-provider.ts`.

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

| Field | Meaning |
|---|---|
| `name` | Required. The provider id (rules below) |
| `label` | Shown in the provider dropdown, at most 64 characters. Defaults to the name |
| `models` | `[{ id, name, vision?, efforts?, contextWindow? }]`: the models offered in tier dropdowns, and the list used when `providerModels` fails |
| `defaultTierModels` | Model per tier (`smart`, `balanced`, `fast`, `code`) when routing names none |
| `streaming` | `true` when the abject answers `providerStream` |
| `liveModels` | `true` when the abject answers `providerModels` |
| `timeoutMs` | How long one call may go without progress, 5000 to 3600000 ms (default 600000, 10 minutes) |

The reply is `{ name, registered: true, backends }`, where `backends` is how
many abjects now serve the name. A malformed registration is refused with a
message saying which field is wrong.

**Names:**

- A name is 1 to 48 characters: lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit.
- Built-in provider names are reserved.
- A name is held by one abject, or by every abject of one installed package. A package spawns in every workspace; each copy joins the same provider, any of them may serve, and a copy that goes away is dropped.
- Another abject cannot take a name while its holder is running. Once the holder is gone, the name is free.

**Registration is in memory and lasts as long as the LLM object.** Register on
startup, and register again whenever your configuration changes. Registering
again from the same abject updates it. `unregisterProvider { name }` withdraws
the sender (only an abject serving the name may send it); the provider is
removed when no abject serves it. The LLM object announces each change as
`changed` with aspect `providersChanged` and value `{ name, registered }`.

## Serving calls

The LLM object always fills in `options.model`: the model the request or tier
routing names, else your `defaultTierModels` entry for the tier, else your
`balanced` entry, else your first model.

| Message to your abject | You reply |
|---|---|
| `providerComplete { messages, options }` | `{ content, finishReason?, usage? }` |
| `providerStream { streamId, messages, options }` (with `streaming: true`) | Emit `providerChunk { streamId, content }` events to the LLM object, then reply `{ chunks, stopReason?, usage? }`, where `chunks` is how many you emitted |
| `providerModels {}` (with `liveModels: true`) | `[{ id, name, vision?, efforts?, contextWindow? }]` |

- **Messages** are `{ role, content }`, where `content` is a string or an array of
  `{ type: 'text', text }`, `{ type: 'image', mediaType, data }` and
  `{ type: 'document', mediaType, data }` parts.
- **Usage** is `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }`.
  Reporting `costUsd` prices the call in the ledger. Without it, the call is
  priced from `setModelPricing` overrides, or counted as unpriced.
- **Streams.** Chunks are accepted only from the abject serving that stream.
  The reply can overtake chunk events still in flight, so the LLM object waits
  for the `chunks` count you report before it ends the stream (briefly, when
  you report none). A stream reply that carries `content` and no chunks is
  taken as one chunk.
- **Models.** When `providerModels` fails or answers something that is not a
  list, the registered `models` are used.
- **Liveness** uses the `ping` every abject answers. A backend that no longer
  exists is dropped, and the call goes to the next abject serving the name.
- **Errors:** throw and the caller gets your error message. A configured
  fallback route is tried next, as for a built-in provider, unless a stream
  had already sent text or the error says the context was too long.

A call may run up to `timeoutMs` (default 10 minutes) without progress.

## Credentials and settings

Settings → AI shows no credential row for an abject-backed provider; the
provider manages its own. In a package, declare what it needs in
`abject.json` `settings` (a `secret` type for keys), and read the values with
`Packages.getSettings`, which answers only that package's own abjects. Observe
the `Packages` object and handle `changed` (aspect `settingsChanged`, value
`{ package }`) to re-register when they change.

## Network access

A provider that calls an HTTP API goes through the `HttpClient` abject.
`HttpClient` refuses private and internal addresses (`localhost`, `10.x`,
`172.16-31.x`, `192.168.x`, `169.254.x`, IPv6 loopback and local ranges)
unless the instance owner lists them under **Private hosts** in Settings →
Permissions → Web (the `web.privateHosts` setting; from a terminal,
`abject settings add web.privateHosts localhost:11434`). It checks the
addresses a host resolves to, so a public name that points at an internal
address is refused too, and it checks every redirect the same way.

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

The built-in providers are not abjects: they call the endpoints configured in
Settings > AI directly, and the web rules in Settings > Permissions do not
apply to them.

## Example

`examples/openai-compatible-provider`: a provider for any OpenAI-compatible
chat endpoint, written in TypeScript as a workspace-scope script package
tagged `autostart`. Its settings are the base URL, an API key, the model list,
and the provider id and label. It registers on startup, re-registers when its
settings change, and maps messages (text and images) and usage between the
two formats. It answers `providerComplete` only (no streaming).

```bash
pnpm forge examples/openai-compatible-provider   # install
pnpm awaken                                     # it registers on startup
```

Then fill in its settings in Settings → Packages → OpenAICompatible, and pick
its models in Settings → AI.
