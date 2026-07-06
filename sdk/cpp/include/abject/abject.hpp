// abject.hpp - C++ SDK for writing Abjects that compile to WebAssembly.
//
// Implements the guest side of docs/WASM_ABI.md (ABI v1). An abject written
// with this SDK is a normal object in the system: it declares a manifest,
// handles methods, replies, emits events, notifies dependents, and calls
// other abjects — all by message passing through the host.
//
// Usage (single translation unit defines the object):
//
//   #include <abject/abject.hpp>
//   using namespace abject;
//
//   class Echo final : public Object {
//   public:
//     json manifest() override {
//       ManifestBuilder m("EchoCpp", "Echoes payloads back", "1.0.0", "abjects:echo-cpp");
//       m.method("echo", "Echo the payload back")
//         .param("value", "string", "Value to echo")
//         .returns("object");
//       m.event("echoed", "Fired after every echo");
//       m.tag("demo");
//       return m.build();
//     }
//     void on_init(const InitInfo& info) override {
//       on("echo", [this](Request& req) {
//         changed("echoed", req.payload());
//         req.reply({{"echo", req.payload()}});
//       });
//     }
//   };
//
//   ABJECT_OBJECT(Echo)
//
// Build as a WASI reactor with the WASI SDK:
//   clang++ --target=wasm32-wasi -mexec-model=reactor -fno-exceptions -O2 \
//     -I sdk/cpp/include echo.cpp -o echo.wasm
// (or use sdk/cpp/build.sh, which sets all of this up.)
//
// Constraints of the environment:
// - Single-threaded; the host never re-enters the module.
// - Exceptions are disabled. JSON parse errors return a `discarded` value
//   (test with is_discarded()); accessing missing keys on a const json
//   aborts, so prefer value()/contains().
// - No filesystem/sockets. Persistent state goes through the workspace
//   Storage abject (request envelopes) or the `persist` snapshot mechanism.

#pragma once

#define JSON_NOEXCEPTION 1
#include "json.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace abject {

using json = nlohmann::json;

// ── Host imports ─────────────────────────────────────────────────────────

namespace host {
__attribute__((import_module("abjects"), import_name("emit")))
void emit(const char* ptr, int32_t len);

__attribute__((import_module("abjects"), import_name("log")))
void log(int32_t level, const char* ptr, int32_t len);

__attribute__((import_module("abjects"), import_name("time_ms")))
double time_ms();
}  // namespace host

enum class LogLevel : int32_t { Debug = 0, Info = 1, Warn = 2, Error = 3 };

// ── Init info ────────────────────────────────────────────────────────────

struct InitInfo {
  std::string object_id;
  std::string type_id;  // empty when the object has no durable identity
  std::string name;
  json data;            // restored durable state; null on first spawn
  double now = 0;
};

// ── Result continuation for guest-initiated requests ────────────────────

struct Result {
  bool ok = false;
  json payload;         // reply payload when ok
  std::string code;     // error code when !ok
  std::string message;  // error message when !ok
};

using ResultHandler = std::function<void(const Result&)>;

class Object;

namespace detail {
struct Runtime;
Runtime& rt();
void queue_envelope(json env);
}  // namespace detail

// ── Inbound request/event context ────────────────────────────────────────

class Request {
 public:
  Request(json message) : message_(std::move(message)) {
    const auto& routing = message_.value("routing", json::object());
    const auto& header = message_.value("header", json::object());
    method_ = routing.value("method", std::string());
    from_ = routing.value("from", std::string());
    message_id_ = header.value("messageId", std::string());
    is_event_ = header.value("type", std::string()) == "event";
    payload_ = message_.value("payload", json());
  }

  const json& payload() const { return payload_; }
  const std::string& method() const { return method_; }
  const std::string& from() const { return from_; }
  /// The inbound messageId — pass to Object::reply_to for deferred replies.
  const std::string& message_id() const { return message_id_; }
  bool is_event() const { return is_event_; }
  const json& raw_message() const { return message_; }

  /// Reply to this request (no-op for events).
  void reply(json payload = nullptr) {
    if (is_event_ || responded_) return;
    responded_ = true;
    detail::queue_envelope({{"kind", "reply"},
                            {"correlationId", message_id_},
                            {"payload", std::move(payload)}});
  }

  /// Error-reply to this request (no-op for events).
  void error(const std::string& code, const std::string& message) {
    if (is_event_ || responded_) return;
    responded_ = true;
    detail::queue_envelope({{"kind", "error"},
                            {"correlationId", message_id_},
                            {"code", code},
                            {"message", message}});
  }

  /// Take responsibility for replying later (e.g. from a request
  /// continuation) via Object::reply_to / Object::error_to.
  void defer() { responded_ = true; }

  bool responded() const { return responded_; }

 private:
  json message_;
  json payload_;
  std::string method_;
  std::string from_;
  std::string message_id_;
  bool is_event_ = false;
  bool responded_ = false;
};

using Handler = std::function<void(Request&)>;

// ── Manifest builder ─────────────────────────────────────────────────────

inline json type_decl(const std::string& type) {
  if (type == "object") return {{"kind", "object"}, {"properties", json::object()}};
  if (type == "array") return {{"kind", "array"}};
  return {{"kind", "primitive"}, {"primitive", type}};
}

class MethodBuilder {
 public:
  MethodBuilder(std::string name, std::string description) {
    decl_ = {{"name", std::move(name)},
             {"description", std::move(description)},
             {"parameters", json::array()}};
  }

  /// type: "string" | "number" | "boolean" | "null" | "object" | "array"
  MethodBuilder& param(const std::string& name, const std::string& type,
                       const std::string& description, bool optional = false) {
    json p = {{"name", name}, {"type", type_decl(type)}, {"description", description}};
    if (optional) p["optional"] = true;
    decl_["parameters"].push_back(std::move(p));
    return *this;
  }

  MethodBuilder& returns(const std::string& type) {
    decl_["returns"] = type_decl(type);
    return *this;
  }

  json decl_;
};

class ManifestBuilder {
 public:
  ManifestBuilder(std::string name, std::string description,
                  std::string version, std::string interface_id)
      : name_(std::move(name)),
        description_(std::move(description)),
        version_(std::move(version)),
        interface_id_(std::move(interface_id)) {}

  MethodBuilder& method(const std::string& name, const std::string& description) {
    methods_.emplace_back(name, description);
    return methods_.back();
  }

  ManifestBuilder& event(const std::string& name, const std::string& description) {
    events_.push_back({{"name", name},
                       {"description", description},
                       {"payload", type_decl("object")}});
    return *this;
  }

  ManifestBuilder& tag(const std::string& t) {
    tags_.push_back(t);
    return *this;
  }

  ManifestBuilder& icon(const std::string& glyph) {
    icon_ = glyph;
    return *this;
  }

  ManifestBuilder& requires_capability(const std::string& capability,
                                       const std::string& reason,
                                       bool required = true) {
    required_capabilities_.push_back(
        {{"capability", capability}, {"reason", reason}, {"required", required}});
    return *this;
  }

  json build() const {
    json methods = json::array();
    for (const auto& m : methods_) methods.push_back(m.decl_);

    json manifest = {
        {"name", name_},
        {"description", description_},
        {"version", version_},
        {"interface",
         {{"id", interface_id_},
          {"name", name_},
          {"description", description_},
          {"methods", std::move(methods)},
          {"events", events_}}},
        {"requiredCapabilities", required_capabilities_},
        {"tags", tags_},
    };
    if (!icon_.empty()) manifest["icon"] = icon_;
    return manifest;
  }

 private:
  std::string name_, description_, version_, interface_id_, icon_;
  std::deque<MethodBuilder> methods_;
  json events_ = json::array();
  json tags_ = json::array();
  json required_capabilities_ = json::array();
};

// ── The Object base class ────────────────────────────────────────────────

class Object {
 public:
  virtual ~Object() = default;

  /// The object's full AbjectManifest (use ManifestBuilder).
  virtual json manifest() = 0;

  /// Called once after the module loads, before any message. Register
  /// handlers here; `info.data` carries restored durable state.
  virtual void on_init(const InitInfo& info) { (void)info; }

  /// Durable data for the `persist` mechanism (clone/respawn/restore).
  /// Return a JSON object; null (the default) disables snapshots.
  virtual json snapshot() { return nullptr; }

  // ── Handler registration ──────────────────────────────────────────────

  /// Handle a method (requests and events). "*" is a catch-all.
  void on(const std::string& method, Handler handler) {
    handlers_[method] = std::move(handler);
  }

  // ── Outbound messaging ────────────────────────────────────────────────

  /// Request another abject; `to` is an AbjectId or "@Name" for Registry
  /// discovery. The continuation runs when the host delivers the result.
  void request(const std::string& to, const std::string& method, json payload,
               ResultHandler continuation, int timeout_ms = 30000) {
    std::string id = "r" + std::to_string(++next_request_id_);
    continuations_[id] = std::move(continuation);
    detail::queue_envelope({{"kind", "request"},
                            {"id", std::move(id)},
                            {"to", to},
                            {"method", method},
                            {"payload", std::move(payload)},
                            {"timeoutMs", timeout_ms}});
  }

  /// Fire-and-forget event to another abject.
  void send_event(const std::string& to, const std::string& method, json payload) {
    detail::queue_envelope({{"kind", "event"},
                            {"to", to},
                            {"method", method},
                            {"payload", std::move(payload)}});
  }

  /// Notify dependents (Smalltalk changed: protocol; host fans out).
  void changed(const std::string& aspect, json value = json::object()) {
    detail::queue_envelope(
        {{"kind", "changed"}, {"aspect", aspect}, {"value", std::move(value)}});
  }

  /// Ask the host to snapshot() and upsert durable data into the Registry.
  void persist() { detail::queue_envelope({{"kind", "persist"}}); }

  /// Deferred reply to an inbound request captured via Request::defer().
  void reply_to(const std::string& correlation_id, json payload = nullptr) {
    detail::queue_envelope({{"kind", "reply"},
                            {"correlationId", correlation_id},
                            {"payload", std::move(payload)}});
  }

  void error_to(const std::string& correlation_id, const std::string& code,
                const std::string& message) {
    detail::queue_envelope({{"kind", "error"},
                            {"correlationId", correlation_id},
                            {"code", code},
                            {"message", message}});
  }

  void log(LogLevel level, const std::string& message) {
    host::log(static_cast<int32_t>(level), message.data(),
              static_cast<int32_t>(message.size()));
  }

  double now_ms() { return host::time_ms(); }

  const std::string& id() const { return object_id_; }
  const std::string& type_id() const { return type_id_; }

  // ── SDK internals (driven by the export glue) ─────────────────────────

  void _dispatch_message(json message) {
    Request req(std::move(message));
    auto it = handlers_.find(req.method());
    if (it == handlers_.end()) it = handlers_.find("*");

    if (it == handlers_.end()) {
      if (!req.is_event()) {
        req.error("METHOD_NOT_FOUND", "No handler for method: " + req.method());
      }
      return;
    }

    it->second(req);

    // Mirror the TS convention: a request handler that neither replied nor
    // deferred gets an automatic null reply.
    if (!req.is_event() && !req.responded()) req.reply(nullptr);
  }

  void _dispatch_result(const json& env) {
    const std::string id = env.value("id", std::string());
    auto it = continuations_.find(id);
    if (it == continuations_.end()) {
      log(LogLevel::Warn, "result for unknown request id: " + id);
      return;
    }
    ResultHandler continuation = std::move(it->second);
    continuations_.erase(it);

    Result result;
    result.ok = env.value("ok", false);
    result.payload = env.value("payload", json());
    result.code = env.value("code", std::string());
    result.message = env.value("message", std::string());
    continuation(result);
  }

  void _set_identity(std::string object_id, std::string type_id) {
    object_id_ = std::move(object_id);
    type_id_ = std::move(type_id);
  }

 private:
  std::unordered_map<std::string, Handler> handlers_;
  std::unordered_map<std::string, ResultHandler> continuations_;
  uint64_t next_request_id_ = 0;
  std::string object_id_;
  std::string type_id_;
};

// ── Module runtime (singleton driven by the exports) ────────────────────

namespace detail {

struct Runtime {
  std::unique_ptr<Object> object;
  std::vector<json> out;        // envelopes queued during the current call
  std::string result_storage;   // len-prefixed return buffer, reused per call
};

inline Runtime& rt() {
  static Runtime instance;
  return instance;
}

inline void queue_envelope(json env) { rt().out.push_back(std::move(env)); }

/// Serialize queued envelopes into the length-prefixed result buffer.
/// Returns nullptr when nothing was queued.
inline const void* pack_result() {
  auto& r = rt();
  if (r.out.empty()) return nullptr;

  json arr = json::array();
  for (auto& env : r.out) arr.push_back(std::move(env));
  r.out.clear();

  // error_handler_t::replace: invalid UTF-8 in payloads must never trap the
  // module (dump() aborts on it in noexception mode otherwise).
  std::string body = arr.dump(-1, ' ', false, json::error_handler_t::replace);
  r.result_storage.resize(4 + body.size());
  uint32_t len = static_cast<uint32_t>(body.size());
  std::memcpy(&r.result_storage[0], &len, 4);
  std::memcpy(&r.result_storage[4], body.data(), body.size());
  return r.result_storage.data();
}

/// Pack an arbitrary JSON value (manifest/snapshot returns).
inline const void* pack_json(const json& value) {
  auto& r = rt();
  std::string body = value.dump(-1, ' ', false, json::error_handler_t::replace);
  r.result_storage.resize(4 + body.size());
  uint32_t len = static_cast<uint32_t>(body.size());
  std::memcpy(&r.result_storage[0], &len, 4);
  std::memcpy(&r.result_storage[4], body.data(), body.size());
  return r.result_storage.data();
}

/// Consume a host-written input buffer (takes ownership and frees it).
inline std::string take_input(char* ptr, int32_t len) {
  std::string input(ptr, static_cast<size_t>(len));
  std::free(ptr);
  return input;
}

inline const void* handle_envelope(char* ptr, int32_t len) {
  auto& r = rt();
  const std::string input = take_input(ptr, len);

  json env = json::parse(input, nullptr, false);
  if (env.is_discarded() || !env.is_object()) {
    const std::string msg = "malformed inbound envelope";
    host::log(3, msg.data(), static_cast<int32_t>(msg.size()));
    return pack_result();
  }

  const std::string kind = env.value("kind", std::string());
  if (kind == "message") {
    r.object->_dispatch_message(env.value("message", json::object()));
  } else if (kind == "result") {
    r.object->_dispatch_result(env);
  }

  return pack_result();
}

inline const void* init_object(Object* object, char* ptr, int32_t len) {
  auto& r = rt();
  r.object.reset(object);

  InitInfo info;
  if (ptr != nullptr && len > 0) {
    json parsed = json::parse(take_input(ptr, len), nullptr, false);
    if (parsed.is_object()) {
      info.object_id = parsed.value("objectId", std::string());
      info.type_id = parsed.value("typeId", std::string());
      info.name = parsed.value("name", std::string());
      info.data = parsed.value("data", json());
      info.now = parsed.value("now", 0.0);
    }
  }

  r.object->_set_identity(info.object_id, info.type_id);
  r.object->on_init(info);
  return pack_result();
}

}  // namespace detail
}  // namespace abject

// ── Export glue ──────────────────────────────────────────────────────────
//
// Expand ABJECT_OBJECT(ClassName) exactly once, in exactly one translation
// unit, after defining the class. It emits the ABI exports for the module.

#define ABJECT_OBJECT(ClassName)                                              \
  extern "C" {                                                                \
  __attribute__((export_name("abject_abi_version")))                          \
  int32_t abject_abi_version() { return 1; }                                  \
                                                                              \
  __attribute__((export_name("abject_alloc")))                                \
  void* abject_alloc(int32_t size) {                                          \
    return std::malloc(static_cast<size_t>(size));                            \
  }                                                                           \
                                                                              \
  __attribute__((export_name("abject_manifest")))                             \
  const void* abject_manifest() {                                             \
    ClassName probe;                                                          \
    return ::abject::detail::pack_json(probe.manifest());                     \
  }                                                                           \
                                                                              \
  __attribute__((export_name("abject_init")))                                 \
  const void* abject_init(char* ptr, int32_t len) {                           \
    return ::abject::detail::init_object(new ClassName(), ptr, len);          \
  }                                                                           \
                                                                              \
  __attribute__((export_name("abject_handle")))                               \
  const void* abject_handle(char* ptr, int32_t len) {                         \
    return ::abject::detail::handle_envelope(ptr, len);                       \
  }                                                                           \
                                                                              \
  __attribute__((export_name("abject_snapshot")))                             \
  const void* abject_snapshot() {                                             \
    auto& r = ::abject::detail::rt();                                         \
    if (!r.object) return nullptr;                                            \
    ::abject::json snap = r.object->snapshot();                               \
    if (snap.is_null()) return nullptr;                                       \
    return ::abject::detail::pack_json(snap);                                 \
  }                                                                           \
  }
