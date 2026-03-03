# src/objects/capabilities/ - Capability Objects

Built-in objects that provide system-level services to user objects. Each wraps a browser API, Node.js API, or implements a virtual service, exposed through the standard Abject message interface.

## Common Pattern

Each capability object:
1. Extends `Abject` with full manifest including `providedCapabilities`
2. Wraps a browser/Node API (`fetch`, `IndexedDB`, `Clipboard`, `setTimeout`, `Playwright`) or implements a virtual service
3. Provides methods via message handlers
4. Tagged with `['capability', '<name>']`

## Files

| File | Class | Well-known ID | Capabilities | Description |
|------|-------|---------------|-------------|-------------|
| `http-client.ts` | `HttpClient` | `HTTP_CLIENT_ID` | `HTTP_REQUEST` | HTTP via Fetch API. Domain allow/deny lists, 30s timeout |
| `storage.ts` | `Storage` | `STORAGE_ID` | `STORAGE_READ`, `STORAGE_WRITE` | Persistent key-value store (IndexedDB in browser, JSON file on Node) |
| `timer.ts` | `Timer` | `TIMER_ID` | `TIMER` | setTimeout/setInterval service. Owner-only cancellation, auto-cleanup on stop |
| `clipboard.ts` | `Clipboard` | `CLIPBOARD_ID` | `CLIPBOARD_READ`, `CLIPBOARD_WRITE` | System clipboard access. Graceful permission denial handling |
| `console.ts` | `Console` | `CONSOLE_ID` | `CONSOLE` | Debug logging with circular buffer (max 1000 entries). Also writes to browser console |
| `filesystem.ts` | `FileSystem` | `FILESYSTEM_ID` | `FILESYSTEM_READ`, `FILESYSTEM_WRITE` | In-memory virtual filesystem with path normalization and `..` traversal |
| `web-browser.ts` | `WebBrowser` | `WEB_BROWSER_ID` | `WEB_BROWSER` | Headless browser automation via Playwright (server-only) |
| `web-parser.ts` | `WebParser` | `WEB_PARSER_ID` | `WEB_PARSER` | HTML parsing and content extraction (server-only, via linkedom) |

### http-client.ts

- **Methods**: `request`, `get`, `post`, `postJson`
- **Security**: `allowedDomains`/`deniedDomains` sets for domain filtering
- **Timeout**: via `AbortController` (default 30s)

### storage.ts

- **Methods**: `get`, `set`, `delete`, `has`, `keys`, `clear`
- **Backend**: IndexedDB (`abjects-storage` database, `kv` object store), falls back to in-memory `Map`
- **Init**: database opened in `onInit()` lifecycle hook

### timer.ts

- **Methods**: `setTimeout`, `setInterval`, `clearTimer`, `getTimerInfo`, `delay`
- **Events**: `timerFired` (sent to owning object when timer fires)
- **Security**: owner-only cancellation (other objects cannot clear your timers)
- **Cleanup**: all timers cleared in `onStop()`

### clipboard.ts

- **Methods**: `read`, `write`, `hasText`
- **Error handling**: graceful for permission denials

### console.ts

- **Methods**: `debug`, `info`, `warn`, `error`, `getLogs`, `clear`, `setEnabled`
- **Buffer**: circular, max 1000 entries
- **Log entries**: objectId, timestamp, level, message, optional data

### filesystem.ts

- **Methods**: `readFile`, `writeFile`, `deleteFile`, `mkdir`, `rmdir`, `readdir`, `stat`, `exists`
- **Structure**: tree of `FileEntry` nodes (file info + content or children)
- **Content**: `Uint8Array` storage with `TextEncoder`/`TextDecoder`

### web-browser.ts

Headless browser automation powered by Playwright. **Server-only** (requires Node.js).

- **Stateless methods**: `getRenderedHtml`, `screenshot`, `extractFromPage` — one-shot operations that open a page, act, and close
- **Stateful page API**: `openPage`, `navigateTo`, `click`, `fill`, `type`, `getContent`, `closePage` — multi-step interactions on persistent browser pages
- **Page management**: tracks open pages per owner, auto-closes on cleanup
- **Events**: `pageOpened`, `pageClosed`, `pageNavigated`

### web-parser.ts

HTML parsing and content extraction. **Server-only** (uses linkedom for DOM parsing).

- **Methods**: `parseHtml`, `extractElements`, `extractLinks`, `extractImages`, `extractMetadata`
- Parses raw HTML strings into a queryable DOM without a browser
- Used by `WebAgent` for processing fetched web pages
