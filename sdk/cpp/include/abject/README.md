# sdk/cpp/include/abject/ - The C++ SDK Headers

The whole C++ SDK: one header for the object model and ABI glue, and the JSON
library it uses. Include `<abject/abject.hpp>`; it pulls in `json.hpp` with
`JSON_NOEXCEPTION` defined.

## Files

- **abject.hpp**: everything a module needs, in namespace `abject`:
  - host imports from module `abjects` (`emit`, `log`, `time_ms`);
  - `InitInfo`, `Result`, `Request` (an inbound request or event:
    `payload()`, `reply()`, `error()`, `defer()`, `message_id()`);
  - `ManifestBuilder` and `MethodBuilder`;
  - `Object`, the base class (`manifest()`, `on_init()`, `snapshot()`, `on()`,
    `request()`, `send_event()`, `changed()`, `persist()`, `reply_to()`,
    `error_to()`, `log()`, `now_ms()`);
  - `ABJECT_OBJECT(Class)`, which emits the ABI exports (`abject_abi_version`,
    `abject_alloc`, `abject_manifest`, `abject_init`, `abject_handle`,
    `abject_snapshot`). Expand it exactly once, in one translation unit.
- **json.hpp**: vendored nlohmann/json 3.11.3 (single header). With
  exceptions off, a failed parse returns a discarded value and indexing a
  missing key on a `const json` aborts the module.

## Gotchas

- `abject.hpp` defines `JSON_NOEXCEPTION` before including `json.hpp`, and
  `json.hpp` has an include guard: a source that includes `json.hpp` first
  gets it without that define. Include `abject.hpp` first.
- The SDK queues outbound envelopes during a call and hands them to the host
  when the call returns; one result buffer is reused across calls, as the ABI
  allows.

## Related

- [../../README.md](../../README.md): the programming model and build
- [../../../../docs/WASM_ABI.md](../../../../docs/WASM_ABI.md): the ABI these headers implement
