# src/objects/capabilities/ - Capability Objects

Built-in objects that provide system-level services to user objects. Each wraps a browser API or implements a virtual service, exposed through the standard Abject message interface.

## Common Pattern

Each capability object:
1. Extends `Abject` with full manifest including `providedCapabilities`
2. Wraps a browser API (`fetch`, `IndexedDB`, `Clipboard`, `setTimeout`) or implements a virtual service
3. Provides methods via message handlers
4. Tagged with `['capability', '<name>']`

## Files

### http-client.ts

HTTP requests via the Fetch API.

- **Methods**: `request`, `get`, `post`, `postJson`
- **Security**: `allowedDomains`/`deniedDomains` sets for domain filtering
- **Timeout**: via `AbortController` (default 30s)
- **Capability**: `HTTP_REQUEST`
- **Well-known ID**: `HTTP_CLIENT_ID`

### storage.ts

Persistent key-value storage using IndexedDB.

- **Methods**: `get`, `set`, `delete`, `has`, `keys`, `clear`
- **Backend**: IndexedDB (`abjects-storage` database, `kv` object store), falls back to in-memory `Map`
- **Init**: database opened in `onInit()` lifecycle hook
- **Capabilities**: `STORAGE_READ`, `STORAGE_WRITE`
- **Well-known ID**: `STORAGE_ID`

### timer.ts

Timing and scheduling service.

- **Methods**: `setTimeout`, `setInterval`, `clearTimer`, `getTimerInfo`, `delay`
- **Events**: `timerFired` (sent to owning object when timer fires)
- **Security**: owner-only cancellation (other objects cannot clear your timers)
- **Cleanup**: all timers cleared in `onStop()`
- **Capability**: `TIMER`
- **Well-known ID**: `TIMER_ID`

### clipboard.ts

System clipboard access via the Clipboard API.

- **Methods**: `read`, `write`, `hasText`
- **Error handling**: graceful for permission denials
- **Capabilities**: `CLIPBOARD_READ`, `CLIPBOARD_WRITE`
- **Well-known ID**: `CLIPBOARD_ID`

### console.ts

Debug logging with buffered output.

- **Methods**: `debug`, `info`, `warn`, `error`, `getLogs`, `clear`, `setEnabled`
- **Buffer**: circular, max 1000 entries
- **Log entries**: objectId, timestamp, level, message, optional data
- **Output**: also writes to browser `console`
- **Capability**: `CONSOLE`
- **Well-known ID**: `CONSOLE_ID`

### filesystem.ts

In-memory virtual filesystem.

- **Methods**: `readFile`, `writeFile`, `deleteFile`, `mkdir`, `rmdir`, `readdir`, `stat`, `exists`
- **Structure**: tree of `FileEntry` nodes (file info + content or children)
- **Paths**: normalization supporting `..` traversal
- **Content**: `Uint8Array` storage with `TextEncoder`/`TextDecoder`
- **Capabilities**: `FILESYSTEM_READ`, `FILESYSTEM_WRITE`
- **Well-known ID**: `FILESYSTEM_ID`
