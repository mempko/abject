// EchoCpp - demonstration abject written in C++ and compiled to WASM.
//
// Exercises the full ABI surface: manifest declaration, request handlers with
// sync replies, dependents notification (changed), durable state via
// snapshot/persist, and guest-initiated requests with deferred replies.

#include <abject/abject.hpp>

using namespace abject;

class Echo final : public Object {
 public:
  json manifest() override {
    ManifestBuilder m("EchoCpp",
                      "Demonstration abject written in C++ (WASM). Echoes "
                      "payloads, relays requests to other abjects, and counts "
                      "calls across restarts.",
                      "1.0.0", "abjects:echo-cpp");
    m.method("echo", "Echo the payload back, with the running call count")
        .param("value", "string", "Any value to echo")
        .returns("object");
    m.method("count", "Number of echo calls handled so far").returns("number");
    m.method("relay", "Request another abject and return its reply")
        .param("to", "string", "Target AbjectId or @Name (Registry discovery)")
        .param("method", "string", "Method to call on the target")
        .param("payload", "object", "Payload to send", /*optional=*/true)
        .returns("object");
    m.event("echoed", "Fired after every echo with the running count");
    m.tag("demo");
    return m.build();
  }

  void on_init(const InitInfo& info) override {
    if (info.data.is_object()) count_ = info.data.value("count", 0);

    on("echo", [this](Request& req) {
      ++count_;
      changed("echoed", {{"count", count_}});
      persist();
      req.reply({{"echo", req.payload()}, {"count", count_}});
    });

    on("count", [this](Request& req) { req.reply(count_); });

    on("relay", [this](Request& req) {
      const json& p = req.payload();
      const std::string to = p.value("to", std::string());
      const std::string method = p.value("method", std::string());
      if (to.empty() || method.empty()) {
        req.error("INVALID_ARGS", "relay requires 'to' and 'method'");
        return;
      }

      req.defer();
      const std::string correlation = req.message_id();
      request(to, method, p.value("payload", json::object()),
              [this, correlation](const Result& res) {
                if (res.ok) {
                  reply_to(correlation, {{"relayed", res.payload}});
                } else {
                  error_to(correlation,
                           res.code.empty() ? "RELAY_FAILED" : res.code,
                           res.message);
                }
              });
    });

    log(LogLevel::Info, "EchoCpp initialized as " + info.object_id);
  }

  json snapshot() override { return {{"count", count_}}; }

 private:
  int count_ = 0;
};

ABJECT_OBJECT(Echo)
