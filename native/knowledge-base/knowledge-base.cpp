// KnowledgeBase (C++/WASM) - native replacement for the TypeScript
// KnowledgeBase system object.
//
// Same message surface and semantics: remember (dedup by normalized
// title+type, optional origin provenance), recall (BM25 full-text,
// title-boosted, snippets + scores, previews mode), match (exact lookup),
// get/forget/update/list, markUseful/archive curation, the
// entryAdded/entryUpdated/entryRemoved events, cross-peer merge through
// SharedState, and periodic distillation (stale entries are archived, not
// deleted; only the archive itself is bounded by hard deletes).
//
// Differences from the TS version, by design of the WASM environment:
// - Persistence goes through the workspace Storage abject by message passing
//   instead of a direct SQLite file: one key per entry
//   ('knowledge-base:entry:<id>'), so a write serializes one entry, never
//   the store. The legacy 'knowledge-base:entries' array is imported once.
//   All capability access is envelopes; the module touches no filesystem.
// - Ranking is a hand-written field-weighted BM25 inverted index (bm25.hpp)
//   with the same 10/1/5 title/content/tags weights FTS5 was tuned to.
// - match supports case-insensitive literals and '|' alternations of
//   literals (the documented agent usage). Full regex is unavailable:
//   std::regex reports invalid patterns by exception, and exceptions do not
//   exist in this build, so patterns with other metacharacters degrade to
//   literal substring matching - the same fallback the TS version applies
//   to invalid regexes.
// - Distillation runs on load and is throttled to once per 30 minutes,
//   piggybacked on remember/update instead of a wall-clock timer.

#include <abject/abject.hpp>

#include <algorithm>
#include <random>
#include <vector>

#include "bm25.hpp"

using namespace abject;

static const char* LEGACY_STORAGE_KEY = "knowledge-base:entries";
static const char* ENTRY_KEY_PREFIX = "knowledge-base:entry:";
static const char* SYNC_NAMESPACE = "knowledge-base";
static constexpr int64_t SYNC_THROTTLE_MS = 2000;
static constexpr int64_t DAY_MS = 24LL * 60 * 60 * 1000;
static constexpr int64_t DISTILL_INTERVAL_MS = 30LL * 60 * 1000;
static constexpr size_t MAX_ENTRIES = 1000;
static constexpr size_t MAX_ARCHIVED = 2000;
static constexpr int64_t STALE_NEVER_ACCESSED_DAYS = 7;
static constexpr int64_t STALE_INACTIVE_DAYS = 30;
static constexpr int64_t ARCHIVED_PURGE_DAYS = 180;

// ── Entry model (JSON shape identical to the TS KnowledgeEntry) ─────────

static bool valid_origin(const std::string& o) {
  return o == "user" || o == "agent" || o == "reviewer" || o == "scrum";
}

// Type-checked payload access. This build has no exceptions (JSON_NOEXCEPTION
// maps throw to abort), so json::value()'s typed get on a present-but-
// mistyped key would trap the whole module. LLM callers routinely send
// null or stringified values for advertised optional params; wrong types
// must fall back to the default, never abort.
static std::string str_or(const json& p, const char* key, const std::string& dflt) {
  return (p.contains(key) && p[key].is_string()) ? p[key].get<std::string>() : dflt;
}
static bool bool_or(const json& p, const char* key, bool dflt) {
  if (!p.contains(key)) return dflt;
  const json& v = p[key];
  if (v.is_boolean()) return v.get<bool>();
  if (v.is_string()) {
    const std::string s = v.get<std::string>();
    if (s == "true") return true;
    if (s == "false") return false;
  }
  return dflt;
}
static int64_t int_or(const json& p, const char* key, int64_t dflt) {
  return (p.contains(key) && p[key].is_number()) ? p[key].get<int64_t>() : dflt;
}

struct Entry {
  std::string id;
  std::string title;
  std::string content;
  std::string type;    // learned | fact | insight | reference
  std::vector<std::string> tags;
  std::string origin = "agent";  // user | agent | reviewer | scrum
  std::string created_by;
  int64_t created_at = 0;
  int64_t updated_at = 0;
  int64_t access_count = 0;
  int64_t last_accessed_at = 0;
  /// Times a reviewer judged this entry to have actually helped a task.
  int64_t useful_count = 0;
  int64_t last_useful_at = 0;
  /// Archived entries are hidden from recall/match but restorable.
  bool archived = false;

  json to_json() const {
    return {{"id", id},           {"title", title},
            {"content", content}, {"type", type},
            {"tags", tags},       {"origin", origin},
            {"createdBy", created_by},
            {"createdAt", created_at},
            {"updatedAt", updated_at},
            {"accessCount", access_count},
            {"lastAccessedAt", last_accessed_at},
            {"usefulCount", useful_count},
            {"lastUsefulAt", last_useful_at},
            {"archived", archived}};
  }

  /// Provenance/usefulness fields default when absent so entries from
  /// sources that predate them (legacy Storage arrays, older peers syncing
  /// over SharedState) round-trip correctly.
  static Entry from_json(const json& j) {
    Entry e;
    e.id = j.value("id", std::string());
    e.title = j.value("title", std::string());
    e.content = j.value("content", std::string());
    e.type = j.value("type", std::string("fact"));
    if (j.contains("tags") && j["tags"].is_array()) {
      for (const auto& t : j["tags"]) {
        if (t.is_string()) e.tags.push_back(t.get<std::string>());
      }
    }
    e.origin = str_or(j, "origin", "agent");
    if (!valid_origin(e.origin)) e.origin = "agent";
    e.created_by = str_or(j, "createdBy", "");
    e.created_at = int_or(j, "createdAt", 0);
    e.updated_at = int_or(j, "updatedAt", 0);
    e.access_count = int_or(j, "accessCount", 0);
    e.last_accessed_at = int_or(j, "lastAccessedAt", 0);
    e.useful_count = int_or(j, "usefulCount", 0);
    e.last_useful_at = int_or(j, "lastUsefulAt", 0);
    e.archived = j.contains("archived") && j["archived"].is_boolean() && j["archived"].get<bool>();
    return e;
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────

static bool valid_type(const std::string& t) {
  return t == "learned" || t == "fact" || t == "insight" || t == "reference";
}

static std::string gen_id() {
  static std::random_device rd;
  static const char* hex = "0123456789abcdef";
  std::string s;
  s.reserve(36);
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { s += '-'; continue; }
    if (i == 14) { s += '4'; continue; }
    uint32_t r = rd() & 0xf;
    if (i == 19) r = (r & 0x3) | 0x8;
    s += hex[r];
  }
  return s;
}

/// Truncate to at most max_bytes without splitting a UTF-8 sequence.
static std::string clip_utf8(const std::string& s, size_t max_bytes) {
  if (s.size() <= max_bytes) return s;
  size_t end = max_bytes;
  while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0) == 0x80) end--;
  return s.substr(0, end);
}

/// Lowercase, punctuation stripped, whitespace collapsed - dedupe key.
static std::string normalize_title(const std::string& title) {
  std::string out;
  for (const auto& tok : kb::tokenize(title)) {
    if (!out.empty()) out += ' ';
    out += tok;
  }
  return out;
}

static bool contains_ci(const std::string& haystack, const std::string& needle_lower) {
  if (needle_lower.empty()) return false;
  const std::string h = kb::to_lower_ascii(haystack);
  return h.find(needle_lower) != std::string::npos;
}

/// Regex metacharacters other than '|' mean the pattern is not a plain
/// alternation of literals and degrades to one literal.
static bool has_regex_meta(const std::string& p) {
  for (char c : p) {
    if (std::string("\\^$.*+?()[]{}").find(c) != std::string::npos) return true;
  }
  return false;
}

// ── The object ───────────────────────────────────────────────────────────

class KnowledgeBase final : public Object {
 public:
  json manifest() override {
    ManifestBuilder m(
        "KnowledgeBase",
        "Persistent agent memory system (native C++/WASM module). Agents "
        "remember facts, insights, and lessons learned, then retrieve them "
        "three ways: recall (BM25 full-text search, title-boosted, returns "
        "snippets and scores; pass previews: true for compact results, then "
        "fetch winners with get), match (exact lookup for identifiers and "
        "precise strings, supports 'A|B' alternations), and get (fetch one "
        "full entry by id). Remember durable knowledge only: user "
        "preferences and personal facts (tag them 'profile'), workspace and "
        "project structure, stable patterns, and references. Types: "
        "'learned' (behavioral lessons), 'fact' (discovered facts), "
        "'insight' (agent analysis), 'reference' (pointers to resources). "
        "Knowledge persists across restarts and syncs across peers.",
        "3.1.0", "abjects:knowledge-base");

    m.method("remember",
             "Store a knowledge entry. Deduplicates by normalized title+type "
             "(updates if exists).")
        .param("title", "string", "Short summary (max 200 chars)")
        .param("content", "string", "The knowledge content (markdown)")
        .param("type", "string", "Entry type: 'learned' | 'fact' | 'insight' | 'reference'")
        .param("tags", "array", "Tags for search/filtering", true)
        .param("origin", "string",
               "Who authored this: 'user' | 'agent' | 'reviewer' | 'scrum' (default 'agent')", true)
        .returns("object");
    m.method("recall",
             "Search knowledge entries by query (BM25-ranked full text, "
             "title-boosted), type, or tags. Each result carries a snippet "
             "and score. Pass previews: true for compact {id, title, snippet} "
             "results, then fetch winners with get.")
        .param("query", "string", "Search query (keywords)", true)
        .param("type", "string", "Filter by type", true)
        .param("tags", "array", "Filter by tags", true)
        .param("limit", "number", "Max results (default 10)", true)
        .param("previews", "boolean", "Return compact previews instead of full entries", true)
        .returns("array");
    m.method("match",
             "Exact lookup over titles, content, and tags. Use for "
             "identifiers, names, and precise strings. Case-insensitive; "
             "'A|B' matches either literal.")
        .param("pattern", "string", "Literal substring or 'A|B' alternation")
        .param("limit", "number", "Max results (default 10)", true)
        .returns("array");
    m.method("get", "Fetch one full knowledge entry by id")
        .param("id", "string", "Entry ID")
        .returns("object");
    m.method("forget", "Delete a knowledge entry by ID")
        .param("id", "string", "Entry ID")
        .returns("object");
    m.method("update", "Update an existing knowledge entry")
        .param("id", "string", "Entry ID")
        .param("content", "string", "New content", true)
        .param("title", "string", "New title", true)
        .param("tags", "array", "New tags", true)
        .returns("object");
    m.method("list", "List knowledge entries, optionally filtered by type")
        .param("type", "string", "Filter by type", true)
        .param("limit", "number", "Max results (default 50)", true)
        .param("includeArchived", "boolean", "Include archived entries (default false)", true)
        .returns("array");
    m.method("listTags",
             "List tags in use across active (non-archived) entries with "
             "usage counts, most-used first. Lets agents discover the tag "
             "vocabulary instead of guessing.")
        .param("limit", "number", "Max tags (default 50)", true)
        .returns("array");
    m.method("markUseful",
             "Record that entries genuinely helped a task (reviewer "
             "feedback). Bumps usefulCount, which protects entries from "
             "staleness eviction.")
        .param("ids", "array", "Entry IDs that proved useful")
        .returns("object");
    m.method("archive",
             "Archive an entry (hidden from recall/match, restorable) or "
             "restore it with archived: false")
        .param("id", "string", "Entry ID")
        .param("archived", "boolean", "Target state (default true)", true)
        .returns("object");

    m.event("entryAdded", "A knowledge entry was added");
    m.event("entryUpdated", "A knowledge entry was updated");
    m.event("entryRemoved", "A knowledge entry was removed");
    m.tag("system").tag("knowledge");
    return m.build();
  }

  void on_init(const InitInfo& info) override {
    register_handlers();

    // Load persisted entries from the workspace Storage abject (one key per
    // entry). Reads that arrive before the load completes see an empty
    // store, mirroring the TS version's deferred SQLite open.
    request("@Storage", "keys", json::object(), [this](const Result& res) {
      std::vector<std::string> entry_keys;
      if (res.ok && res.payload.is_array()) {
        for (const auto& k : res.payload) {
          if (!k.is_string()) continue;
          const std::string key = k.get<std::string>();
          if (key.rfind(ENTRY_KEY_PREFIX, 0) == 0) entry_keys.push_back(key);
        }
      }
      if (entry_keys.empty()) {
        load_legacy_array();
        return;
      }
      pending_loads_ = entry_keys.size();
      for (const auto& key : entry_keys) {
        request("@Storage", "get", {{"key", key}}, [this](const Result& r) {
          if (r.ok && r.payload.is_object()) admit_entry(Entry::from_json(r.payload));
          if (--pending_loads_ == 0) finish_load();
        });
      }
    });

    // Cross-peer sync via SharedState (create is idempotent-ish; failures
    // just mean no sync, never a broken store).
    request("@SharedState", "create", {{"name", SYNC_NAMESPACE}}, [this](const Result&) {
      request("@SharedState", "subscribe", {{"name", SYNC_NAMESPACE}}, [](const Result&) {});
    });

    log(LogLevel::Info, "KnowledgeBase (C++) initialized as " + info.object_id);
  }

 private:
  std::unordered_map<std::string, Entry> entries_;
  kb::Bm25Index index_;
  bool loaded_ = false;
  int64_t last_distill_ms_ = 0;
  int64_t last_sync_ms_ = 0;
  bool sync_pending_ = false;
  size_t pending_loads_ = 0;

  // ── Loading ────────────────────────────────────────────────────────────

  void admit_entry(Entry e) {
    if (e.id.empty()) return;
    index_.add(e.id, e.title, e.content, e.tags);
    entries_[e.id] = std::move(e);
  }

  /// One-time import of the legacy whole-array key (data written by older
  /// builds). Imported entries are re-persisted under per-entry keys; the
  /// legacy value is left in place so rollback loses nothing.
  void load_legacy_array() {
    request("@Storage", "get", {{"key", LEGACY_STORAGE_KEY}}, [this](const Result& res) {
      if (res.ok && res.payload.is_array()) {
        for (const auto& j : res.payload) {
          Entry e = Entry::from_json(j);
          if (e.id.empty()) continue;
          admit_entry(std::move(e));
        }
        for (const auto& [_, e] : entries_) persist_entry(e);
        if (!entries_.empty()) {
          log(LogLevel::Info, "Imported " + std::to_string(entries_.size()) +
                                  " legacy entries from the array key");
        }
      }
      finish_load();
    });
  }

  void finish_load() {
    loaded_ = true;
    log(LogLevel::Info, "KnowledgeBase (C++) loaded " +
                            std::to_string(entries_.size()) + " entries from Storage");
    distill();
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  void register_handlers() {
    on("remember", [this](Request& req) { handle_remember(req); });
    on("recall", [this](Request& req) { handle_recall(req); });
    on("match", [this](Request& req) { handle_match(req); });

    on("get", [this](Request& req) {
      const std::string id = req.payload().value("id", std::string());
      auto it = entries_.find(id);
      if (it == entries_.end()) { req.reply(nullptr); return; }
      touch(it->second);
      persist_entry(it->second);
      flush_sync(static_cast<int64_t>(now_ms()));
      req.reply(it->second.to_json());
    });

    on("forget", [this](Request& req) {
      const std::string id = req.payload().value("id", std::string());
      auto it = entries_.find(id);
      if (it == entries_.end()) { req.reply({{"success", false}}); return; }
      const std::string title = it->second.title;
      index_.remove(id);
      entries_.erase(it);
      unpersist_entry(id);
      request_sync();
      changed("entryRemoved", {{"id", id}});
      log(LogLevel::Info, "Forgot: \"" + title + "\"");
      req.reply({{"success", true}});
    });

    on("update", [this](Request& req) { handle_update(req); });

    on("list", [this](Request& req) {
      const json& p = req.payload();
      const std::string type = p.value("type", std::string());
      const size_t max = std::min<int64_t>(p.value("limit", static_cast<int64_t>(50)), 200);
      const bool include_archived = bool_or(p, "includeArchived", false);

      std::vector<const Entry*> results = filtered_by_recency(type, {}, include_archived);
      if (results.size() > max) results.resize(max);
      json out = json::array();
      for (const Entry* e : results) out.push_back(e->to_json());
      req.reply(std::move(out));
    });

    on("listTags", [this](Request& req) {
      const json& p = req.payload();
      const size_t max = static_cast<size_t>(std::min<int64_t>(int_or(p, "limit", 50), 200));
      std::map<std::string, int64_t> counts;
      for (const auto& [id, e] : entries_) {
        if (e.archived) continue;
        for (const auto& t : e.tags) counts[t]++;
      }
      std::vector<std::pair<std::string, int64_t>> sorted(counts.begin(), counts.end());
      std::sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) {
        if (a.second != b.second) return a.second > b.second;
        return a.first < b.first;
      });
      if (sorted.size() > max) sorted.resize(max);
      json out = json::array();
      for (const auto& [tag, count] : sorted) {
        out.push_back({{"tag", tag}, {"count", count}});
      }
      req.reply(out);
    });

    on("markUseful", [this](Request& req) {
      const json& p = req.payload();
      if (!p.contains("ids") || !p["ids"].is_array() || p["ids"].empty()) {
        req.error("CONTRACT_VIOLATION", "ids must be a non-empty array");
        return;
      }
      const int64_t now = static_cast<int64_t>(now_ms());
      int64_t marked = 0;
      for (const auto& v : p["ids"]) {
        if (!v.is_string()) continue;
        auto it = entries_.find(v.get<std::string>());
        if (it == entries_.end()) continue;
        it->second.useful_count++;
        it->second.last_useful_at = now;
        persist_entry(it->second);
        changed("entryUpdated", it->second.to_json());
        marked++;
      }
      if (marked > 0) request_sync();
      log(LogLevel::Info, "markUseful: " + std::to_string(marked) + "/" +
                              std::to_string(p["ids"].size()) + " entries");
      req.reply({{"marked", marked}});
    });

    on("archive", [this](Request& req) {
      const json& p = req.payload();
      const std::string id = p.value("id", std::string());
      if (id.empty()) { req.error("CONTRACT_VIOLATION", "id must not be empty"); return; }
      auto it = entries_.find(id);
      if (it == entries_.end()) {
        req.reply({{"success", false}, {"error", "No entry with id \"" + id + "\""}});
        return;
      }
      Entry& e = it->second;
      e.archived = bool_or(p, "archived", true);
      e.updated_at = static_cast<int64_t>(now_ms());
      save_entry(e);
      changed("entryUpdated", e.to_json());
      log(LogLevel::Info,
          std::string(e.archived ? "Archived" : "Restored") + ": \"" + e.title + "\"");
      req.reply({{"success", true}});
    });

    // SharedState sync: merge remote entries that are new or newer.
    on("changed", [this](Request& req) {
      const json& p = req.payload();
      if (p.value("aspect", std::string()) != "stateChanged") return;
      const json change = p.value("value", json::object());
      if (change.value("namespace", std::string()) != SYNC_NAMESPACE) return;
      if (change.value("key", std::string()) != "entries") return;
      const json remote = change.value("value", json());
      if (!remote.is_array()) return;

      int merged = 0;
      for (const auto& j : remote) {
        Entry re = Entry::from_json(j);
        if (re.id.empty()) continue;
        auto it = entries_.find(re.id);
        if (it == entries_.end() || re.updated_at > it->second.updated_at) {
          index_.add(re.id, re.title, re.content, re.tags);
          const std::string rid = re.id;
          entries_[rid] = std::move(re);
          persist_entry(entries_[rid]);
          merged++;
        }
      }
      if (merged > 0) {
        log(LogLevel::Info, "Merged " + std::to_string(merged) + " remote entries, now " +
                                std::to_string(entries_.size()) + " total");
      }
    });
  }

  void handle_remember(Request& req) {
    const json& p = req.payload();
    const std::string title = p.value("title", std::string());
    const std::string content = p.value("content", std::string());
    const std::string type = p.value("type", std::string());
    if (title.empty()) { req.error("CONTRACT_VIOLATION", "title must not be empty"); return; }
    if (content.empty()) { req.error("CONTRACT_VIOLATION", "content must not be empty"); return; }
    if (!valid_type(type)) { req.error("CONTRACT_VIOLATION", "Invalid knowledge type: " + type); return; }

    std::vector<std::string> tags;
    if (p.contains("tags") && p["tags"].is_array()) {
      for (const auto& t : p["tags"]) {
        if (t.is_string()) tags.push_back(t.get<std::string>());
      }
    }
    std::string origin = str_or(p, "origin", "agent");
    if (!valid_origin(origin)) origin = "agent";

    const int64_t now = static_cast<int64_t>(now_ms());

    // Dedup by normalized title+type: update the existing entry if found. A
    // re-remembered archived entry revives; its origin is preserved so a
    // reviewer refresh can never downgrade a user-authored entry.
    // User-authored entries are dedup-updatable only by user-origin writes:
    // an agent/reviewer remember whose title happens to collide must not
    // replace the user's content (it would keep origin 'user', making the
    // corruption look user-authored and eviction-protected). Such writes
    // fall through and create a separate entry instead.
    Entry* existing = find_by_title_and_type(title, type);
    if (existing && existing->origin == "user" && origin != "user") {
      log(LogLevel::Info, "Remember: title collides with user entry; creating separate " + origin + " entry");
      existing = nullptr;
    }
    if (existing) {
      existing->content = content;
      if (p.contains("tags")) existing->tags = tags;
      existing->archived = false;
      existing->updated_at = now;
      index_.add(existing->id, existing->title, existing->content, existing->tags);
      save_entry(*existing);
      changed("entryUpdated", existing->to_json());
      log(LogLevel::Info, "Updated knowledge: \"" + title + "\" (" + type + ")");
      req.reply({{"id", existing->id}});
      maybe_distill(now);
      return;
    }

    Entry e;
    e.id = gen_id();
    e.title = clip_utf8(title, 200);
    e.content = content;
    e.type = type;
    e.tags = std::move(tags);
    e.origin = std::move(origin);
    e.created_by = req.from();
    e.created_at = now;
    e.updated_at = now;
    e.access_count = 0;
    e.last_accessed_at = now;
    e.useful_count = 0;
    e.last_useful_at = 0;
    e.archived = false;

    index_.add(e.id, e.title, e.content, e.tags);
    json entry_json = e.to_json();
    const std::string id = e.id;
    entries_[id] = std::move(e);
    save_entry(entries_[id]);
    changed("entryAdded", entry_json);
    log(LogLevel::Info, "Remembered: \"" + entries_[id].title + "\" (" + type + ")");
    req.reply({{"id", id}});
    maybe_distill(now);
  }

  void handle_recall(Request& req) {
    const json& p = req.payload();
    const std::string query = p.value("query", std::string());
    const std::string type = p.value("type", std::string());
    const bool previews = p.value("previews", false);
    const size_t max = std::min<int64_t>(p.value("limit", static_cast<int64_t>(10)), 50);

    std::vector<std::string> tag_filter;
    if (p.contains("tags") && p["tags"].is_array()) {
      for (const auto& t : p["tags"]) {
        if (t.is_string()) tag_filter.push_back(t.get<std::string>());
      }
    }

    struct Row { const Entry* entry; std::string snippet; double score; bool scored; };
    std::vector<Row> rows;

    const std::vector<std::string> query_terms = kb::tokenize(query);
    if (!query_terms.empty()) {
      // Rank over a generous pool, then apply type/tag filters so a filter
      // can't empty the results just because top hits were other types.
      for (const auto& hit : index_.search(query, 100)) {
        auto it = entries_.find(hit.id);
        if (it == entries_.end()) continue;
        const Entry& e = it->second;
        if (e.archived) continue;
        if (!type.empty() && e.type != type) continue;
        if (!tag_filter.empty() && !has_any_tag(e, tag_filter)) continue;
        rows.push_back({&e, kb::make_snippet(e.content, query_terms), hit.score, true});
        if (rows.size() >= max) break;
      }
    } else {
      for (const Entry* e : filtered_by_recency(type, tag_filter, false)) {
        rows.push_back({e, clip_utf8(e->content, 160), 0, false});
        if (rows.size() >= max) break;
      }
    }

    // Bump access counts on returned entries (each bump persists only that
    // entry, like the TS version's per-row UPDATE).
    const int64_t now = static_cast<int64_t>(now_ms());
    for (auto& row : rows) {
      Entry& live = entries_[row.entry->id];
      live.access_count++;
      live.last_accessed_at = now;
      persist_entry(live);
    }
    flush_sync(now);

    json out = json::array();
    for (const auto& row : rows) {
      if (previews) {
        json preview = {{"id", row.entry->id},   {"title", row.entry->title},
                        {"type", row.entry->type}, {"tags", row.entry->tags},
                        {"snippet", row.snippet}};
        if (row.scored) preview["score"] = row.score;
        out.push_back(std::move(preview));
      } else {
        json full = row.entry->to_json();
        full["snippet"] = row.snippet;
        if (row.scored) full["score"] = row.score;
        out.push_back(std::move(full));
      }
    }
    log(LogLevel::Info, "Recall \"" + (query.empty() ? "*" : query) + "\" => " +
                            std::to_string(out.size()) + " entries");
    req.reply(std::move(out));
  }

  void handle_match(Request& req) {
    const json& p = req.payload();
    const std::string pattern = p.value("pattern", std::string());
    if (pattern.empty()) { req.error("CONTRACT_VIOLATION", "pattern must not be empty"); return; }
    const size_t max = std::min<int64_t>(p.value("limit", static_cast<int64_t>(10)), 50);

    // 'A|B' alternations of literals; anything with other regex
    // metacharacters degrades to one literal (see file header).
    std::vector<std::string> needles;
    if (!has_regex_meta(pattern)) {
      size_t start = 0;
      while (start <= pattern.size()) {
        const size_t bar = pattern.find('|', start);
        const std::string piece =
            pattern.substr(start, bar == std::string::npos ? std::string::npos : bar - start);
        if (!piece.empty()) needles.push_back(kb::to_lower_ascii(piece));
        if (bar == std::string::npos) break;
        start = bar + 1;
      }
    }
    if (needles.empty()) needles.push_back(kb::to_lower_ascii(pattern));

    auto matches = [&](const Entry& e) {
      for (const auto& n : needles) {
        if (contains_ci(e.title, n) || contains_ci(e.content, n)) return true;
        for (const auto& t : e.tags) {
          if (contains_ci(t, n)) return true;
        }
      }
      return false;
    };

    std::vector<const Entry*> results;
    for (const Entry* e : sorted_by_recency()) {
      if (e->archived) continue;
      if (!matches(*e)) continue;
      results.push_back(e);
      if (results.size() >= max) break;
    }

    const int64_t now = static_cast<int64_t>(now_ms());
    json out = json::array();
    for (const Entry* e : results) {
      Entry& live = entries_[e->id];
      live.access_count++;
      live.last_accessed_at = now;
      persist_entry(live);
      out.push_back(live.to_json());
    }
    flush_sync(now);

    log(LogLevel::Info, "Match \"" + pattern + "\" => " + std::to_string(out.size()) + " entries");
    req.reply(std::move(out));
  }

  void handle_update(Request& req) {
    const json& p = req.payload();
    const std::string id = p.value("id", std::string());
    if (id.empty()) { req.error("CONTRACT_VIOLATION", "id must not be empty"); return; }

    // Accept fields flat or nested under `updates` (both caller shapes exist).
    const json updates = p.value("updates", json::object());
    auto pick = [&](const char* key) -> json {
      if (p.contains(key)) return p[key];
      if (updates.contains(key)) return updates[key];
      return json();
    };
    const json content = pick("content");
    const json title = pick("title");
    const json tags = pick("tags");

    auto it = entries_.find(id);
    if (it == entries_.end()) {
      req.reply({{"success", false}, {"error", "No entry with id \"" + id + "\""}});
      return;
    }
    if (content.is_null() && title.is_null() && tags.is_null()) {
      req.reply({{"success", false},
                 {"error", "No updatable fields provided (expected content, title, and/or tags)"}});
      return;
    }

    Entry& e = it->second;
    if (content.is_string()) e.content = content.get<std::string>();
    if (title.is_string()) e.title = clip_utf8(title.get<std::string>(), 200);
    if (tags.is_array()) {
      e.tags.clear();
      for (const auto& t : tags) {
        if (t.is_string()) e.tags.push_back(t.get<std::string>());
      }
    }
    const int64_t now = static_cast<int64_t>(now_ms());
    e.updated_at = now;
    index_.add(e.id, e.title, e.content, e.tags);
    save_entry(e);
    changed("entryUpdated", e.to_json());
    log(LogLevel::Info, "Updated: \"" + e.title + "\"");
    req.reply({{"success", true}});
    maybe_distill(now);
  }

  // ── Query helpers ──────────────────────────────────────────────────────

  bool has_any_tag(const Entry& e, const std::vector<std::string>& wanted) const {
    for (const auto& w : wanted) {
      for (const auto& t : e.tags) {
        if (t == w) return true;
      }
    }
    return false;
  }

  std::vector<const Entry*> sorted_by_recency() const {
    std::vector<const Entry*> all;
    all.reserve(entries_.size());
    for (const auto& [_, e] : entries_) all.push_back(&e);
    std::sort(all.begin(), all.end(), [](const Entry* a, const Entry* b) {
      return a->updated_at != b->updated_at ? a->updated_at > b->updated_at : a->id < b->id;
    });
    return all;
  }

  std::vector<const Entry*> filtered_by_recency(const std::string& type,
                                                const std::vector<std::string>& tags,
                                                bool include_archived) const {
    std::vector<const Entry*> out;
    for (const Entry* e : sorted_by_recency()) {
      if (!include_archived && e->archived) continue;
      if (!type.empty() && e->type != type) continue;
      if (!tags.empty() && !has_any_tag(*e, tags)) continue;
      out.push_back(e);
    }
    return out;
  }

  Entry* find_by_title_and_type(const std::string& title, const std::string& type) {
    const std::string norm = normalize_title(title);
    for (auto& [_, e] : entries_) {
      if (e.type == type && normalize_title(e.title) == norm) return &e;
    }
    return nullptr;
  }

  void touch(Entry& e) {
    e.access_count++;
    e.last_accessed_at = static_cast<int64_t>(now_ms());
  }

  // ── Persistence + sync ─────────────────────────────────────────────────

  json entries_array() const {
    json arr = json::array();
    for (const auto& [_, e] : entries_) arr.push_back(e.to_json());
    return arr;
  }

  /// Durable write of ONE entry — a write serializes one entry, never the
  /// whole store (the JSON boundary makes whole-store writes O(N) per call).
  void persist_entry(const Entry& e) {
    request("@Storage", "set",
            {{"key", ENTRY_KEY_PREFIX + e.id}, {"value", e.to_json()}},
            [](const Result&) {});
  }

  void unpersist_entry(const std::string& id) {
    request("@Storage", "delete", {{"key", ENTRY_KEY_PREFIX + id}}, [](const Result&) {});
  }

  /// Cross-peer sync carries the whole array (the SharedState key's value is
  /// the full entry set, same as the TS version), so it is throttled: at
  /// most one sync per SYNC_THROTTLE_MS, with a pending flag flushed by the
  /// next handler activity.
  void request_sync() {
    sync_pending_ = true;
    flush_sync(static_cast<int64_t>(now_ms()));
  }

  void flush_sync(int64_t now) {
    if (!sync_pending_ || now - last_sync_ms_ < SYNC_THROTTLE_MS) return;
    sync_pending_ = false;
    last_sync_ms_ = now;
    request("@SharedState", "set",
            {{"name", SYNC_NAMESPACE}, {"key", "entries"},
             {"value", entries_array()}, {"persist", true}},
            [](const Result&) {});
  }

  /// Structural save: durable write of the changed entry + throttled sync.
  void save_entry(const Entry& e) {
    persist_entry(e);
    request_sync();
  }

  // ── Distillation ───────────────────────────────────────────────────────

  void maybe_distill(int64_t now) {
    if (now - last_distill_ms_ >= DISTILL_INTERVAL_MS) distill();
  }

  /// An entry the automated cleanup must never touch: user-authored entries
  /// (origin 'user'), user facts (tagged 'user'/'person'), and entries a
  /// reviewer has confirmed useful.
  bool is_protected(const Entry& e) const {
    if (e.origin == "user") return true;
    if (e.type == "fact") {
      for (const auto& t : e.tags) {
        if (t == "user" || t == "person") return true;
      }
    }
    return e.useful_count > 0;
  }

  /// Archive (not delete): hidden from recall/match, restorable.
  void archive_entry(Entry& e, const char* why) {
    log(LogLevel::Info,
        std::string("Distill: archiving \"") + e.title + "\" (" + why + ")");
    e.archived = true;
    e.updated_at = static_cast<int64_t>(now_ms());
    persist_entry(e);
  }

  /// Periodic cleanup: archive stale, low-value entries and cap the active
  /// store. Nothing is hard-deleted except archived entries that outlive the
  /// purge window, keeping the store bounded.
  void distill() {
    const int64_t now = static_cast<int64_t>(now_ms());
    last_distill_ms_ = now;

    size_t archived_count = 0;
    for (auto& [_, e] : entries_) {
      if (e.archived || is_protected(e)) continue;
      const int64_t age_days = (now - e.created_at) / DAY_MS;
      const int64_t last_access_days =
          e.last_accessed_at > 0 ? (now - e.last_accessed_at) / DAY_MS : age_days;

      // Archive 'learned' entries never surfaced after 7 days
      if (e.type == "learned" && e.access_count == 0 && age_days > STALE_NEVER_ACCESSED_DAYS) {
        archive_entry(e, "never accessed in 7d");
        archived_count++;
        continue;
      }
      // Archive 'learned' or 'reference' entries inactive for 30 days
      if ((e.type == "learned" || e.type == "reference") &&
          last_access_days > STALE_INACTIVE_DAYS) {
        archive_entry(e, "inactive 30d");
        archived_count++;
      }
    }

    // Cap the ACTIVE store by archiving the least useful entries first
    // (usefulCount, then accessCount). Protected entries are exempt.
    size_t active_count = 0;
    for (const auto& [_, e] : entries_) {
      if (!e.archived) active_count++;
    }
    if (active_count > MAX_ENTRIES) {
      std::vector<Entry*> candidates;
      for (auto& [_, e] : entries_) {
        if (!e.archived && !is_protected(e)) candidates.push_back(&e);
      }
      std::sort(candidates.begin(), candidates.end(), [](const Entry* a, const Entry* b) {
        return a->useful_count != b->useful_count ? a->useful_count < b->useful_count
                                                  : a->access_count < b->access_count;
      });
      size_t excess = active_count - MAX_ENTRIES;
      for (Entry* e : candidates) {
        if (excess == 0) break;
        archive_entry(*e, "active-store cap");
        archived_count++;
        excess--;
      }
    }

    // Bound the archive itself: hard-delete archived entries past the purge
    // window, oldest first when over the archive cap. User-authored entries
    // are never purged.
    std::vector<const Entry*> archived;
    for (const auto& [_, e] : entries_) {
      if (e.archived && e.origin != "user") archived.push_back(&e);
    }
    std::sort(archived.begin(), archived.end(), [](const Entry* a, const Entry* b) {
      return a->updated_at < b->updated_at;
    });
    std::vector<std::string> purge_ids;
    for (const Entry* e : archived) {
      const int64_t archived_days = (now - e->updated_at) / DAY_MS;
      const bool over_cap = archived.size() - purge_ids.size() > MAX_ARCHIVED;
      if (archived_days > ARCHIVED_PURGE_DAYS || over_cap) purge_ids.push_back(e->id);
    }
    for (const auto& id : purge_ids) {
      log(LogLevel::Info, "Distill: purging archived \"" + entries_[id].title + "\"");
      index_.remove(id);
      entries_.erase(id);
      unpersist_entry(id);
    }

    if (archived_count > 0 || !purge_ids.empty()) {
      request_sync();
      log(LogLevel::Info, "Distill: archived " + std::to_string(archived_count) +
                              ", purged " + std::to_string(purge_ids.size()) + ", " +
                              std::to_string(entries_.size()) + " entries total");
    }
  }
};

ABJECT_OBJECT(KnowledgeBase)
