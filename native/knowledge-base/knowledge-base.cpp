// KnowledgeBase (C++/WASM) - the workspace knowledge store. It took over
// from a TypeScript implementation that no longer exists; its message
// vocabulary for TypeScript callers is src/core/knowledge.ts.
//
// Message surface: remember (dedup by normalized
// title+type, optional origin provenance), recall (BM25 full-text,
// title-boosted, snippets + scores, previews mode), weave (pattern
// selection by context match plus link expansion), match
// (exact lookup), get/forget/update/list, markUseful/archive curation, the
// entryAdded/entryUpdated/entryRemoved events, cross-peer merge through
// SharedState, and periodic distillation (stale entries are archived, not
// deleted; only the archive itself is bounded by hard deletes).
//
// Design notes, shaped by the WASM environment:
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
//   literal substring matching.
// - Distillation runs on load and is throttled to once per 30 minutes,
//   piggybacked on remember/update instead of a wall-clock timer: its
//   thresholds are days long, and a store nobody writes to has nothing new
//   to distill. Sync publishing is throttled too; a flush the throttle
//   deferred asks the Timer capability for one wakeup (timerFired), so the
//   change still reaches peers when nothing else touches the store. An idle
//   store sets no timers.
// - The legacy whole-array key is imported only into an empty store. The TS
//   version re-imported missing ids once per install, guarded by a marker in
//   its own SQLite file; without that marker a re-import would bring back
//   entries forgotten since the migration.

#include <abject/abject.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <random>
#include <set>
#include <vector>

#include "bm25.hpp"
#include "pattern.hpp"

using namespace abject;

static const char* LEGACY_STORAGE_KEY = "knowledge-base:entries";
static const char* ENTRY_KEY_PREFIX = "knowledge-base:entry:";
static const char* SYNC_NAMESPACE = "knowledge-base";
/// One CRDT register per entry: `entry:<id>`. A deletion publishes a
/// tombstone under the same key.
static const char* ENTRY_REGISTER_PREFIX = "entry:";
static constexpr int64_t SYNC_THROTTLE_MS = 2000;
static constexpr int64_t DAY_MS = 24LL * 60 * 60 * 1000;
static constexpr int64_t DISTILL_INTERVAL_MS = 30LL * 60 * 1000;
static constexpr size_t MAX_ENTRIES = 1000;
static constexpr size_t MAX_ARCHIVED = 2000;
static constexpr int64_t STALE_NEVER_ACCESSED_DAYS = 7;
static constexpr int64_t STALE_INACTIVE_DAYS = 30;
static constexpr int64_t ARCHIVED_PURGE_DAYS = 180;
/// Declarations kept on one application; repeats past this add nothing new.
static constexpr size_t MAX_DECLARATIONS = 20;
/// Recent no_effect/harmful applications returned with a woven pattern.
static constexpr size_t MAX_COUNTEREXAMPLES = 3;
/// Read counters (accessCount, lastAccessedAt) for every entry, kept in one
/// small key. A read updates this map instead of rewriting the entry, which
/// for a belief with a long learning history was megabytes per recall.
static const char* ACCESS_KEY = "knowledge-base:access";
static constexpr int64_t ACCESS_FLUSH_MS = 60LL * 1000;
/// A belief's learning history: the newest receipts stay whole, older ones
/// keep identity, action and evidence digests, and past RECEIPTS_KEPT the
/// oldest fold into a tally whose effect ids still identify them for sync.
static constexpr size_t RECEIPTS_KEPT_WHOLE = 20;
static constexpr size_t RECEIPTS_KEPT = 200;
/// A pattern's recorded uses, compacted the same way.
static constexpr size_t APPLICATIONS_KEPT_WHOLE = 40;
static constexpr size_t APPLICATIONS_KEPT = 400;
static constexpr size_t OBSERVATIONS_KEPT = 100;
static constexpr size_t FEEDBACK_IDS_KEPT = 200;
/// Text kept per field of an evidence digest, and of a receipt's prior text.
static constexpr size_t EVIDENCE_TEXT_CAP = 400;
static constexpr size_t BEFORE_CONTENT_CAP = 8000;
/// Effect ids of the newest observe_entry effects applied to an entry, kept
/// so a redelivered observation is answered as a duplicate without a receipt
/// in the learning history.
static constexpr size_t OBSERVED_EFFECTS_KEPT = 100;
/// Shown-only evidence (the entry was in front of the agent but not cited)
/// counts a quarter of a cited test.
static constexpr double SHOWN_WEIGHT = 0.25;
/// Days for the weight of past tests to halve: uncertainty grows back as an
/// entry goes untested.
static constexpr double EVIDENCE_HALF_LIFE_DAYS = 60.0;

// ── Entry model (JSON shape of KnowledgeEntry in src/core/knowledge.ts) ─

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

/// Every receipt a learning record holds, by effect id: whole and compacted
/// receipts in history, and the ones folded into its tally.
static std::set<std::string> learning_receipt_ids(const json& learning) {
  std::set<std::string> ids;
  if (!learning.is_object()) return ids;
  if (learning.contains("history") && learning["history"].is_array()) {
    for (const auto& r : learning["history"]) {
      const auto id = r.is_object() ? str_or(r, "effectId", "") : std::string();
      if (!id.empty()) ids.insert(id);
    }
  }
  if (learning.contains("rolledUp") && learning["rolledUp"].is_object()) {
    const json& rolled = learning["rolledUp"];
    if (rolled.contains("effectIds") && rolled["effectIds"].is_array()) {
      for (const auto& v : rolled["effectIds"]) if (v.is_string()) ids.insert(v.get<std::string>());
    }
  }
  return ids;
}

static double round3(double v) { return std::round(v * 1000.0) / 1000.0; }

/// How often the predictions and assumptions that rested on an entry held.
/// held/missed count the ones that cited it; shownHeld/shownMissed the ones
/// where it was only shown. Absent from storage means untested (all zero).
/// It is evidence about the claim, not part of it: recording a test changes
/// neither the entry's revision nor its updatedAt.
struct Evidence {
  int64_t held = 0, missed = 0, shown_held = 0, shown_missed = 0;
  int64_t last_tested_at = 0;
  /// When the claim these counters test was last changed (0: since the entry
  /// was written). A new claim starts untested; the stamp keeps a peer's
  /// counters for the old claim from coming back through sync.
  int64_t claim_at = 0;
  /// Recent observe_entry effect ids (OBSERVED_EFFECTS_KEPT), for idempotency.
  std::vector<std::string> effect_ids;

  bool tested() const { return held + missed + shown_held + shown_missed > 0; }
  bool stored() const { return tested() || last_tested_at > 0 || claim_at > 0 || !effect_ids.empty(); }
  /// The claim changed: the old holds and misses tested something else. The
  /// effect ids stay, so a redelivered old observation is still a duplicate.
  void reset_for_new_claim(int64_t now) {
    held = missed = shown_held = shown_missed = 0;
    last_tested_at = 0;
    claim_at = std::max(claim_at, now);
  }
  double weighted_tests() const { return held + missed + SHOWN_WEIGHT * (shown_held + shown_missed); }
  /// The chance the claim holds: a Laplace estimate over the tests.
  double confidence() const {
    return (1.0 + held + SHOWN_WEIGHT * shown_held) / (2.0 + weighted_tests());
  }
  /// 1 when untested; falls as tests accumulate and grows back as they age.
  double uncertainty(int64_t now) const {
    if (!tested()) return 1.0;
    const double days = last_tested_at > 0 ? std::max(0.0, double(now - last_tested_at) / double(DAY_MS)) : 0.0;
    const double n = weighted_tests() * std::pow(0.5, days / EVIDENCE_HALF_LIFE_DAYS);
    return 1.0 / (1.0 + n);
  }
  /// Misses outnumber holds after enough tests: it needs narrowing or a dispute.
  bool flagged() const { return missed >= 2 && missed > held; }
  bool knows(const std::string& effect_id) const {
    return std::find(effect_ids.begin(), effect_ids.end(), effect_id) != effect_ids.end();
  }
  void remember_effect(const std::string& effect_id) {
    if (effect_id.empty() || knows(effect_id)) return;
    effect_ids.push_back(effect_id);
    if (effect_ids.size() > OBSERVED_EFFECTS_KEPT) {
      effect_ids.erase(effect_ids.begin(), effect_ids.begin() + static_cast<std::ptrdiff_t>(effect_ids.size() - OBSERVED_EFFECTS_KEPT));
    }
  }
  json counters() const {
    json j = {{"held", held}, {"missed", missed}, {"shownHeld", shown_held}, {"shownMissed", shown_missed}};
    if (last_tested_at > 0) j["lastTestedAt"] = last_tested_at;
    return j;
  }
  /// As stored and synced: the counters and the recent effect ids.
  json to_json() const {
    json j = counters();
    if (claim_at > 0) j["claimAt"] = claim_at;
    j["effectIds"] = effect_ids;
    return j;
  }
  /// As readers get it: the counters with confidence, uncertainty and flagged.
  json view(int64_t now) const {
    json j = counters();
    j["confidence"] = round3(confidence());
    j["uncertainty"] = round3(uncertainty(now));
    j["flagged"] = flagged();
    return j;
  }
  static Evidence from_json(const json& j) {
    Evidence e;
    if (!j.is_object()) return e;
    e.held = std::max<int64_t>(0, int_or(j, "held", 0));
    e.missed = std::max<int64_t>(0, int_or(j, "missed", 0));
    e.shown_held = std::max<int64_t>(0, int_or(j, "shownHeld", 0));
    e.shown_missed = std::max<int64_t>(0, int_or(j, "shownMissed", 0));
    e.last_tested_at = std::max<int64_t>(0, int_or(j, "lastTestedAt", 0));
    e.claim_at = std::max<int64_t>(0, int_or(j, "claimAt", 0));
    if (j.contains("effectIds") && j["effectIds"].is_array()) {
      for (const auto& v : j["effectIds"]) if (v.is_string()) e.remember_effect(v.get<std::string>());
    }
    return e;
  }
  /// Fold in a peer's copy. Counters for a newer claim replace ours, those
  /// for an older claim are ignored; for the same claim each counter and the
  /// test time take the larger value. Effect ids always join. Monotone, so
  /// replicas converge (two observations made on different peers from the
  /// same count are counted once). Returns whether anything changed.
  bool merge(const Evidence& other) {
    bool changed = false;
    if (other.claim_at > claim_at) {
      held = other.held; missed = other.missed; shown_held = other.shown_held; shown_missed = other.shown_missed;
      last_tested_at = other.last_tested_at; claim_at = other.claim_at;
      changed = true;
    } else if (other.claim_at == claim_at) {
      auto up = [&changed](int64_t& mine, int64_t theirs) { if (theirs > mine) { mine = theirs; changed = true; } };
      up(held, other.held); up(missed, other.missed);
      up(shown_held, other.shown_held); up(shown_missed, other.shown_missed);
      up(last_tested_at, other.last_tested_at);
    }
    for (const auto& id : other.effect_ids) if (!knows(id)) { remember_effect(id); changed = true; }
    return changed;
  }
};

struct Entry {
  std::string id;
  std::string title;
  std::string content;
  std::string type;    // learned | fact | insight | reference | pattern
  std::vector<std::string> tags;
  std::string origin = "agent";  // user | agent | reviewer | scrum
  std::string created_by;
  /// The peer that authored this entry. UI attribution and the CRDT tie-break
  /// both read it. Empty means the entry predates provenance; the first
  /// publish from this peer stamps it.
  std::string creator_peer_id;
  int64_t created_at = 0;
  int64_t updated_at = 0;
  int64_t access_count = 0;
  int64_t last_accessed_at = 0;
  /// Times a reviewer judged this entry to have actually helped a task.
  int64_t useful_count = 0;
  int64_t last_useful_at = 0;
  /// Archived entries are hidden from recall/match but restorable.
  bool archived = false;
  json learning = nullptr;
  Evidence evidence;

  /// What the entry claims, for telling a claim change from a bookkeeping
  /// one: title and content, a pattern's without its own learning record.
  std::string claim_text() const {
    std::string body = content;
    if (type == "pattern") {
      if (auto p = kbpat::read(content, title)) { p->learning = nullptr; body = p->to_json().dump(); }
    }
    return title + "\n" + body;
  }
  std::string knowledge_ref() const { return json::array({id, updated_at, learning.is_object() ? int_or(learning, "revision", 0) : 0}).dump(); }
  bool applicable(const std::string& scope = "") const {
    if (archived) return false;
    if (!learning.is_object()) return true;
    const auto own = str_or(learning, "scope", "");
    if (!scope.empty() && !own.empty() && scope != own) return false;
    for (const auto& relation : learning.value("supersessions", json::array())) {
      const auto affected = str_or(relation, "scope", "");
      if (affected.empty() || affected == scope) return false;
    }
    return true;
  }
  /// A copy from a peer may replace this entry only if it keeps every
  /// receipt this one holds. Receipts are matched by effect id, not by
  /// content: a compacted receipt and the whole one it came from are the
  /// same receipt.
  bool preserves_learning(const json& incoming) const {
    if (!learning.is_object()) return true;
    if (!incoming.is_object() || int_or(incoming, "revision", -1) < int_or(learning, "revision", 0)) return false;
    const auto theirs = learning_receipt_ids(incoming);
    for (const auto& id : learning_receipt_ids(learning)) if (!theirs.count(id)) return false;
    return true;
  }

  /// The entry as its readers want it. Patterns are stored as structure and
  /// rendered here, so every path that hands an entry to a person, a prompt
  /// or the UI gets prose and the JSON stays an implementation detail of
  /// storage. Persistence and cross-peer sync use to_json().
  json to_presented_json() const {
    json j = to_json();
    j["knowledgeRef"] = knowledge_ref();
    j["evidence"] = evidence.view(static_cast<int64_t>(host::time_ms()));
    if (type == "pattern") {
      if (auto p = kbpat::read(content, title)) {
        if (!p->learning.is_object()) p->learning = {{"revision", 1}, {"applications", json::array()}, {"feedbackIds", json::array()}, {"history", json::array()}};
        j["patternRef"] = json::array({id, p->learning["revision"]}).dump();
        j["content"] = p->render();
        j["pattern"] = p->to_json();
      }
    }
    if (learning.is_object()) {
      std::string notices;
      const auto scope_of = [](const json& d) { const auto sc = str_or(d, "scope", ""); return sc.empty() ? std::string("all scopes") : sc; };
      const auto list = [this](const char* key) { return learning.contains(key) && learning[key].is_array() ? learning[key] : json::array(); };
      for (const auto& d : list("disputes")) notices += "DISPUTED (" + scope_of(d) + "): " + str_or(d, "explanation", "") + "\n";
      for (const auto& d : list("supersessions")) notices += "SUPERSEDED (" + scope_of(d) + "): use " + str_or(d, "replacementId", "") + "\n";
      if (!str_or(learning, "scope", "").empty()) notices += "Applies only in scope: " + str_or(learning, "scope", "") + "\n";
      if (!notices.empty()) j["content"] = notices + j["content"].get<std::string>();
    }
    return j;
  }

  json to_json() const {
    json j = {{"id", id},           {"title", title},
            {"content", content}, {"type", type},
            {"tags", tags},       {"origin", origin},
            {"createdBy", created_by},
            {"creatorPeerId", creator_peer_id},
            {"createdAt", created_at},
            {"updatedAt", updated_at},
            {"accessCount", access_count},
            {"lastAccessedAt", last_accessed_at},
            {"usefulCount", useful_count},
            {"lastUsefulAt", last_useful_at},
            {"archived", archived}, {"learning", learning}};
    if (evidence.stored()) j["evidence"] = evidence.to_json();
    return j;
  }

  /// Provenance/usefulness fields default when absent so entries from
  /// sources that predate them (legacy Storage arrays, older peers syncing
  /// over SharedState) round-trip correctly.
  static Entry from_json(const json& j) {
    Entry e;
    if (j.contains("learning") && j["learning"].is_object()) e.learning = j["learning"];
    e.id = str_or(j, "id", "");
    e.title = str_or(j, "title", "");
    e.content = str_or(j, "content", "");
    e.type = str_or(j, "type", "fact");
    if (j.contains("tags") && j["tags"].is_array()) {
      for (const auto& t : j["tags"]) {
        if (t.is_string()) e.tags.push_back(t.get<std::string>());
      }
    }
    e.origin = str_or(j, "origin", "agent");
    if (!valid_origin(e.origin)) e.origin = "agent";
    e.created_by = str_or(j, "createdBy", "");
    e.creator_peer_id = str_or(j, "creatorPeerId", "");
    e.created_at = int_or(j, "createdAt", 0);
    e.updated_at = int_or(j, "updatedAt", 0);
    e.access_count = int_or(j, "accessCount", 0);
    e.last_accessed_at = int_or(j, "lastAccessedAt", 0);
    e.useful_count = int_or(j, "usefulCount", 0);
    e.last_useful_at = int_or(j, "lastUsefulAt", 0);
    e.archived = j.contains("archived") && j["archived"].is_boolean() && j["archived"].get<bool>();
    if (j.contains("evidence")) e.evidence = Evidence::from_json(j["evidence"]);
    return e;
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────

/// What following a pattern did, judged after the fact. no_effect: it was
/// followed and the state it promises did not come about or did not matter.
static bool valid_feedback_verdict(const std::string& v) {
  return v == "helpful" || v == "no_effect" || v == "harmful" || v == "inconclusive";
}

static bool valid_type(const std::string& t) {
  return t == "learned" || t == "fact" || t == "insight" || t == "reference" || t == "pattern";
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

// ── Learning provenance, kept small ─────────────────────────────────────
//
// A receipt records why a belief changed. What it needs to say that is the
// prediction-level evidence: what was expected, what happened, the verdict,
// the reviewer's explanation and what it blamed. Whole task transcripts and
// raw results stay in GoalManager's evidence store, reachable by hash;
// copying them into every receipt made one belief carry megabytes. The
// digest fields match evidenceDigest in src/core/evidence.ts.

static std::string clipped_text(const json& v) {
  return clip_utf8(v.is_string() ? v.get<std::string>() : v.dump(), EVIDENCE_TEXT_CAP);
}

static json evidence_digest(const json& record) {
  json d = json::object();
  if (!record.is_object()) { d["value"] = clipped_text(record); return d; }
  for (const char* key : {"taskId", "step", "action", "outcome", "verdict", "phase", "revision", "missed", "agentName"}) {
    if (!record.contains(key)) continue;
    const json& v = record[key];
    if (v.is_string()) d[key] = clip_utf8(v.get<std::string>(), EVIDENCE_TEXT_CAP);
    else if (v.is_number() || v.is_boolean()) d[key] = v;
  }
  for (const char* key : {"expect", "explanation", "error", "result", "actual"}) {
    if (record.contains(key) && !record[key].is_null()) d[key] = clipped_text(record[key]);
  }
  if (record.contains("attribution") && record["attribution"].is_object()) {
    const json& a = record["attribution"];
    d["attribution"] = a.dump().size() <= EVIDENCE_TEXT_CAP ? a : json{{"source", str_or(a, "source", "")}};
  }
  return d;
}

/// Evidence as a receipt keeps it. GoalManager sends {hash, digest} per
/// reference; decisions recorded before that sent whole records, which are
/// reduced here to the same digest (without a hash, since none was taken).
static json slim_evidence(const json& evidence) {
  json out = json::object();
  if (!evidence.is_object()) return out;
  for (const auto& [ref, value] : evidence.items()) {
    if (value.is_object() && value.contains("digest")) { out[ref] = value; continue; }
    out[ref] = {{"digest", evidence_digest(value)}};
  }
  return out;
}

/// The entry as it stood before a change: its text and identity, without
/// the learning record (the receipt is part of it) and, for a pattern,
/// without the pattern's own recorded uses and revisions.
static json slim_before(json before) {
  if (!before.is_object()) return before;
  before.erase("learning");
  std::string content = str_or(before, "content", "");
  if (str_or(before, "type", "") == "pattern") {
    if (auto p = kbpat::read(content, str_or(before, "title", ""))) {
      p->learning = nullptr;
      content = p->to_json().dump();
    }
  }
  if (content.size() > BEFORE_CONTENT_CAP) {
    before["contentChars"] = static_cast<int64_t>(content.size());
    content = clip_utf8(content, BEFORE_CONTENT_CAP);
  }
  before["content"] = content;
  return before;
}

/// Bound a belief's learning history (see RECEIPTS_KEPT_WHOLE). Returns
/// whether anything changed. Idempotent: compacting twice changes nothing.
static bool compact_learning(json& learning) {
  if (!learning.is_object() || !learning.contains("history") || !learning["history"].is_array()) return false;
  bool changed = false;
  json& history = learning["history"];
  for (auto& r : history) {
    if (!r.is_object()) continue;
    if (r.contains("evidence")) {
      json slim = slim_evidence(r["evidence"]);
      if (slim != r["evidence"]) { r["evidence"] = std::move(slim); changed = true; }
    }
    if (r.contains("before") && r["before"].is_object()) {
      json slim = slim_before(r["before"]);
      if (slim != r["before"]) { r["before"] = std::move(slim); changed = true; }
    }
  }
  const size_t n = history.size();
  for (size_t i = 0; n > RECEIPTS_KEPT_WHOLE && i < n - RECEIPTS_KEPT_WHOLE; i++) {
    json& r = history[i];
    if (!r.is_object() || bool_or(r, "compacted", false)) continue;
    json slim = {{"compacted", true}};
    for (const char* key : {"effectId", "decisionId", "goalId", "revision", "at"}) if (r.contains(key)) slim[key] = r[key];
    if (r.contains("input") && r["input"].is_object()) slim["action"] = str_or(r["input"], "action", "");
    if (r.contains("evidence")) slim["evidence"] = r["evidence"];
    r = std::move(slim);
    changed = true;
  }
  if (history.size() > RECEIPTS_KEPT) {
    json& rolled = learning["rolledUp"];
    if (!rolled.is_object()) rolled = json::object();
    if (!rolled.contains("effectIds") || !rolled["effectIds"].is_array()) rolled["effectIds"] = json::array();
    if (!rolled.contains("actions") || !rolled["actions"].is_object()) rolled["actions"] = json::object();
    const size_t drop = history.size() - RECEIPTS_KEPT;
    for (size_t i = 0; i < drop; i++) {
      const json& r = history[i];
      if (!r.is_object()) continue;
      const auto id = str_or(r, "effectId", "");
      if (!id.empty()) rolled["effectIds"].push_back(id);
      const auto action = str_or(r, "action", r.contains("input") && r["input"].is_object() ? str_or(r["input"], "action", "") : "");
      if (!action.empty()) rolled["actions"][action] = int_or(rolled["actions"], action.c_str(), 0) + 1;
      rolled["count"] = int_or(rolled, "count", 0) + 1;
      const int64_t at = int_or(r, "at", 0);
      if (at && (!rolled.contains("firstAt") || int_or(rolled, "firstAt", at) > at)) rolled["firstAt"] = at;
      if (at > int_or(rolled, "lastAt", 0)) rolled["lastAt"] = at;
    }
    history.erase(history.begin(), history.begin() + static_cast<std::ptrdiff_t>(drop));
    changed = true;
  }
  return changed;
}

/// Bound a pattern's own learning record: recorded uses (newest whole, older
/// compacted, the oldest folded into verdict tallies), reviewer observations
/// and usefulness operation ids. Idempotent.
static bool compact_pattern_learning(json& pl) {
  if (!pl.is_object()) return false;
  bool changed = false;
  if (pl.contains("applications") && pl["applications"].is_array()) {
    json& apps = pl["applications"];
    const size_t n = apps.size();
    for (size_t i = 0; n > APPLICATIONS_KEPT_WHOLE && i < n - APPLICATIONS_KEPT_WHOLE; i++) {
      json& a = apps[i];
      if (!a.is_object() || bool_or(a, "compacted", false)) continue;
      json slim = {{"compacted", true}};
      for (const char* key : {"id", "goalId", "verdict", "patternRevision", "at"}) if (a.contains(key)) slim[key] = a[key];
      for (const char* key : {"context", "declaredContext", "evidence"}) if (a.contains(key) && a[key].is_string()) slim[key] = clip_utf8(a[key].get<std::string>(), 200);
      if (a.contains("declarations") && a["declarations"].is_array()) slim["declarationCount"] = static_cast<int64_t>(a["declarations"].size());
      a = std::move(slim);
      changed = true;
    }
    if (apps.size() > APPLICATIONS_KEPT) {
      json& rolled = pl["rolledUp"];
      if (!rolled.is_object()) rolled = json::object();
      if (!rolled.contains("verdicts") || !rolled["verdicts"].is_object()) rolled["verdicts"] = json::object();
      const size_t drop = apps.size() - APPLICATIONS_KEPT;
      for (size_t i = 0; i < drop; i++) {
        const auto verdict = apps[i].is_object() ? str_or(apps[i], "verdict", "applied") : std::string("applied");
        rolled["verdicts"][verdict] = int_or(rolled["verdicts"], verdict.c_str(), 0) + 1;
        rolled["applications"] = int_or(rolled, "applications", 0) + 1;
      }
      apps.erase(apps.begin(), apps.begin() + static_cast<std::ptrdiff_t>(drop));
      changed = true;
    }
  }
  if (pl.contains("observations") && pl["observations"].is_array() && pl["observations"].size() > OBSERVATIONS_KEPT) {
    json& obs = pl["observations"];
    obs.erase(obs.begin(), obs.begin() + static_cast<std::ptrdiff_t>(obs.size() - OBSERVATIONS_KEPT));
    changed = true;
  }
  if (pl.contains("feedbackIds") && pl["feedbackIds"].is_array() && pl["feedbackIds"].size() > FEEDBACK_IDS_KEPT) {
    json& ids = pl["feedbackIds"];
    ids.erase(ids.begin(), ids.begin() + static_cast<std::ptrdiff_t>(ids.size() - FEEDBACK_IDS_KEPT));
    changed = true;
  }
  return changed;
}

/// How many separate goals have met a belief: the distinct goals whose
/// learning decisions left receipts on it (saved, confirmed, revised,
/// disputed). A belief met in several goals describes something that
/// recurs. Receipts folded into the tally no longer name their goal.
static int64_t receipt_goals(const json& learning) {
  if (!learning.is_object() || !learning.contains("history") || !learning["history"].is_array()) return 0;
  std::set<std::string> goals;
  for (const auto& r : learning["history"]) {
    const auto goal = r.is_object() ? str_or(r, "goalId", "") : std::string();
    if (!goal.empty()) goals.insert(goal);
  }
  return static_cast<int64_t>(goals.size());
}

/// What readers of an entry get of its learning record unless they ask for
/// the whole history: revision and scope, the live disputes and
/// supersessions, how many receipts stand behind it, and how many goals
/// they came from.
static json learning_summary(const json& learning) {
  if (!learning.is_object()) return learning;
  json s = {{"revision", int_or(learning, "revision", 0)}};
  if (!str_or(learning, "scope", "").empty()) s["scope"] = learning["scope"];
  for (const char* key : {"disputes", "supersessions"}) {
    s[key] = learning.contains(key) && learning[key].is_array() ? learning[key] : json::array();
  }
  int64_t receipts = learning.contains("history") && learning["history"].is_array() ? static_cast<int64_t>(learning["history"].size()) : 0;
  if (learning.contains("rolledUp") && learning["rolledUp"].is_object()) receipts += int_or(learning["rolledUp"], "count", 0);
  s["receipts"] = receipts;
  s["goals"] = receipt_goals(learning);
  s["historyOmitted"] = true;
  return s;
}

/// An entry as change events carry it: whole, except that its learning
/// history is summarized (subscribers render entries, not receipts).
static json event_json(const Entry& e) {
  json j = e.to_json();
  j["evidence"] = e.evidence.view(static_cast<int64_t>(host::time_ms()));
  if (e.learning.is_object()) j["learning"] = learning_summary(e.learning);
  return j;
}

/// An entry as a reader gets it. The learning history comes only on request
/// (includeLearning); the summary keeps revision, scope, disputes and
/// supersessions, which is all an agent or prompt uses.
static json presented_json(const Entry& e, bool include_learning) {
  json j = e.to_presented_json();
  if (!include_learning && e.learning.is_object()) j["learning"] = learning_summary(e.learning);
  return j;
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

static bool contains_ci(const std::string& haystack, const std::string& needle_folded) {
  if (needle_folded.empty()) return false;
  return kb::fold_text(haystack).find(needle_folded) != std::string::npos;
}

/// A pattern's other names, as its Aliases section lists them.
static std::vector<std::string> pattern_aliases(const std::string& content, const std::string& title) {
  std::vector<std::string> out;
  const auto p = kbpat::read(content, title);
  if (!p) return out;
  std::string cur;
  for (char c : p->aliases + ",") {
    if (c == ',' || c == ';' || c == '\n') { if (!kbpat::trim(cur).empty()) out.push_back(kbpat::trim(cur)); cur.clear(); }
    else cur += c;
  }
  return out;
}

/// Regex metacharacters other than '|' mean the pattern is not a plain
/// alternation of literals and degrades to one literal.
static bool has_regex_meta(const std::string& p) {
  for (char c : p) {
    if (std::string("\\^$.*+?()[]{}").find(c) != std::string::npos) return true;
  }
  return false;
}

/// A pattern's links, read straight off its structure.
///
/// This used to hunt for a 'Links:' line in prose, so the links of every
/// pattern that wrote them as a '## Links' block were invisible and the weave
/// quietly stopped expanding through them.
static std::vector<std::string> parse_pattern_links(const std::string& content,
                                                    const std::string& title) {
  if (auto p = kbpat::read(content, title)) return p->links;
  return {};
}

// ── The object ───────────────────────────────────────────────────────────

class KnowledgeBase final : public Object {
 public:
  json manifest() override {
    ManifestBuilder m(
        "KnowledgeBase",
        "Persistent agent memory system (native C++/WASM module). Agents "
        "remember facts, insights, lessons learned, and patterns, then "
        "retrieve them four ways: recall (BM25 full-text search, "
        "title-boosted, returns snippets and scores; pass previews: true for "
        "compact results, then fetch winners with get), match (exact lookup "
        "for identifiers and precise strings, supports 'A|B' alternations), "
        "get (fetch one full entry by id), and weave (select patterns whose "
        "contexts match a goal, plus their linked patterns). Remember "
        "durable knowledge only: user preferences and personal facts (tag "
        "them 'profile'), workspace and project structure, stable patterns, "
        "and references. Types: 'learned' (behavioral lessons), 'fact' "
        "(discovered facts), 'insight' (agent analysis), 'reference' "
        "(pointers to resources), 'pattern' (Alexander/Coplien-style "
        "generative pattern-language entries with Context/Forces/Therefore "
        "sections and links to related patterns). Knowledge "
        "persists across restarts and syncs across peers.",
        "3.10.0", "abjects:knowledge-base");

    m.method("applyLearningDecision",
             "Apply an authenticated journaled correction with a durable idempotent receipt. "
             "observe_entry {id, outcome: 'held'|'missed', cited} records one prediction or "
             "assumption that rested on an entry: it counts toward the entry's evidence "
             "(held/missed when cited, shownHeld/shownMissed when only shown) and changes no "
             "claim, revision or updatedAt")
        .param("goalId", "string", "Evidence owner goal").param("decisionId", "string", "Durable decision")
        .param("effectId", "string", "Immutable effect identity").returns("object");
    m.method("remember",
             "Store a knowledge entry. Deduplicates by normalized title+type "
             "(updates if exists).")
        .param("title", "string", "Short summary (max 200 chars)")
        .param("content", "string", "The knowledge content (markdown)")
        .param("type", "string", "Entry type: 'learned' | 'fact' | 'insight' | 'reference' | 'pattern'")
        .param("tags", "array", "Tags for search/filtering", true)
        .param("origin", "string",
               "Who authored this: 'user' | 'agent' | 'reviewer' | 'scrum' (default 'agent')", true)
        .returns("object");
    m.method("recall",
             "Search knowledge entries by query (BM25-ranked full text, "
             "title-boosted), type, or tags. Each result carries a snippet "
             "and score. Pass previews: true for compact {id, title, snippet} "
             "results, then fetch winners with get. Full entries carry "
             "evidence {held, missed, shownHeld, shownMissed, lastTestedAt, "
             "confidence, uncertainty, flagged}: how often predictions resting "
             "on the entry held; previews carry it once the entry was tested.")
        .param("query", "string", "Search query (keywords)", true)
        .param("type", "string", "Filter by type", true)
        .param("tags", "array", "Filter by tags", true)
        .param("limit", "number", "Max results (default 10)", true)
        .param("scope", "string", "Explicit applicability scope", true)
        .param("previews", "boolean", "Return compact previews instead of full entries", true)
        .param("order", "string", "Without a query: 'recent' (default) or 'worth' (user-written first, then reviewer-confirmed useful, then recent). "
               "'uncertain' (with or without a query): entries relied on most and tested least first, by (1 + accessCount + 2 * usefulCount) * evidence.uncertainty", true)
        .param("includeLearning", "boolean", "Include each entry's whole learning history (receipts); by default only its summary", true)
        .param("minGoals", "number", "Only entries met in at least this many goals (distinct goals behind their learning receipts)", true)
        .returns("array");
    m.method("weave",
             "Select pattern entries (type 'pattern') whose contexts match "
             "the query (BM25-ranked), then follow their links to pull in "
             "linked patterns, best-supported links first. Pass `from` with "
             "the ids of patterns a plan already follows to get what their "
             "links lead to next. Returns { patterns, dangling, broken }: "
             "each pattern carries via ('matched', or 'linked-from: NAME' "
             "with how many goals used the two together), linkedFrom (the "
             "patterns that link to it) and counterexamples (its recent "
             "no_effect/harmful applications); dangling lists link names no "
             "pattern holds yet, broken lists links to archived patterns.")
        .param("query", "string", "Goal or task description to match pattern contexts against", true)
        .param("from", "array", "Ids of patterns already in use, to expand their links", true)
        .param("limit", "number", "Max directly matched patterns (default 5)", true)
        .param("scope", "string", "Explicit applicability scope", true)
        .param("hops", "number", "Link-expansion depth (default 1, max 2)", true)
        .returns("object");
    m.method("match",
             "Exact lookup over titles, content, and tags. Use for "
             "identifiers, names, and precise strings. Case-insensitive; "
             "'A|B' matches either literal.")
        .param("pattern", "string", "Literal substring or 'A|B' alternation")
        .param("scope", "string", "Explicit applicability scope", true)
        .param("limit", "number", "Max results (default 10)", true)
        .returns("array");
    m.method("get", "Fetch one full knowledge entry by id")
        .param("id", "string", "Entry ID")
        .param("includeLearning", "boolean", "Include the entry's whole learning history (receipts); by default only its summary", true)
        .returns("object");
    m.method("evidenceHashes",
             "The evidence hashes the learning receipts cite, so the evidence "
             "store keeps the bodies they refer to.")
        .returns("array");
    m.method("forget",
             "Forget an entry by ID. A live entry is archived: hidden from recall, "
             "match, and the default list, restorable with archive({archived:false}). "
             "Forgetting an entry that is already archived deletes it permanently, "
             "learning history included. Returns {success, archived:true} or "
             "{success, deleted:true}.")
        .param("id", "string", "Entry ID")
        .returns("object");
    m.method("update", "Update an existing knowledge entry")
        .param("id", "string", "Entry ID")
        .param("content", "string", "New content", true)
        .param("title", "string", "New title", true)
        .param("tags", "array", "New tags", true)
        .param("expectedRevision", "number", "Reject stale pattern revisions", true)
        .returns("object");
    m.method("list", "List knowledge entries, optionally filtered by type")
        .param("type", "string", "Filter by type", true)
        .param("limit", "number", "Max results (default 50)", true)
        .param("includeArchived", "boolean", "Include archived entries (default false)", true)
        .param("includeLearning", "boolean", "Include each entry's whole learning history (receipts); by default only its summary", true)
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
        .param("operationId", "string", "Deduplicate pattern feedback for a review", true)
        .returns("object");
    m.method("beginPatternApplication", "Capture an application before execution using an opaque selection receipt")
        .param("id", "string", "Pattern ID").param("patternRef", "string", "Selection receipt")
        .param("applicationId", "string", "Stable episode identity").param("goalId", "string", "Goal ID")
        .param("context", "string", "Reason for applying")
        .param("scope", "string", "Where it is applied (plan revision, task, step)", true).returns("object");
    m.method("assessPatternApplication", "Attach feedback to a captured application without supplying a revision")
        .param("id", "string", "Pattern ID").param("applicationRef", "string", "Application receipt")
        .param("goalId", "string", "Goal ID").param("verdict", "string", "helpful, no_effect, harmful, inconclusive")
        .param("evidence", "string", "Observed evidence").returns("object");
    m.method("recordPatternApplication", "Record contextual application evidence with an idempotent identity")
        .param("id", "string", "Pattern entry ID")
        .param("application", "object", "id, goalId, context, evidence, verdict and patternRevision")
        .returns("object");
    m.method("patternHistory", "Inspect pattern revision history and contextual application evidence")
        .param("id", "string", "Pattern entry ID")
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
    // store until the load finishes.
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
    object_id_ = info.object_id;

    // Peer identity for provenance and for breaking equal timestamps. Every
    // peer stamps ids drawn from ONE identity space (Identity's peerId, the
    // object id until it resolves) -- a peerId tie-break across two
    // different id spaces would compare incomparable values.
    request("@Identity", "getIdentity", json::object(), [this](const Result& r) {
      if (r.ok && r.payload.is_object()) {
        local_peer_id_ = r.payload.value("peerId", std::string());
        adopt_self_stamped_entries();
      }
    });

    request("@SharedState", "create", {{"name", SYNC_NAMESPACE}}, [this](const Result&) {
      request("@SharedState", "subscribe", {{"name", SYNC_NAMESPACE}}, [this](const Result&) {
        // A peer that was offline missed every stateChanged event, and
        // _syncFull is internal to SharedState -- it is never delivered to a
        // consumer. Reading the namespace whole is the only reconciliation
        // route available to us.
        request("@SharedState", "getAll", {{"name", SYNC_NAMESPACE}}, [this](const Result& r) {
          if (r.ok && r.payload.is_object()) reconcile_from_snapshot(r.payload);
        });
      });
    });

    log(LogLevel::Info, "KnowledgeBase (C++) initialized as " + info.object_id);
  }

 private:
  std::unordered_map<std::string, Entry> entries_;
  kb::Bm25Index index_;
  /// This object's id and this peer's id. self_peer_id() prefers the Identity
  /// peer id and falls back to the object id before Identity resolves.
  std::string object_id_;
  std::string local_peer_id_;
  /// Ids deleted locally or remotely, with the stamp of the deletion. A
  /// whole-array snapshot cannot express a deletion; without these any peer
  /// that still holds the entry resurrects it on its next merge.
  std::unordered_map<std::string, int64_t> tombstones_;
  /// Entry ids whose register still has to go out, flushed by flush_sync().
  std::set<std::string> pending_sync_ids_;
  /// Set by reconciliation: republish the local store once loading finishes.
  bool needs_republish_ = false;
  bool loaded_ = false;
  int64_t last_distill_ms_ = 0;
  int64_t last_sync_ms_ = 0;
  bool sync_pending_ = false;
  /// A one-shot Timer wakeup is on its way for a flush the throttle deferred.
  bool sync_wakeup_armed_ = false;
  size_t pending_loads_ = 0;

  // ── Loading ────────────────────────────────────────────────────────────

  /// What the full-text index should see. Patterns are stored as JSON, so
  /// indexing the stored body would feed BM25 braces and field names; the
  /// prose is indexed instead and recall keeps working as it always did.
  static std::string index_text(const Entry& e) {
    if (e.type == "pattern") {
      if (auto p = kbpat::read_structured(e.content)) return p->search_text();
    }
    return e.content;
  }

  void admit_entry(Entry e) {
    if (e.id.empty()) return;
    index_.add(e.id, e.title, index_text(e), e.tags);
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
    adopt_self_stamped_entries();
    heal_patterns();
    load_access_counters();
    compact_loaded_learning();
    log(LogLevel::Info, "KnowledgeBase (C++) loaded " +
                            std::to_string(entries_.size()) + " entries from Storage");
    distill();
  }

  /// Bound every learning record once at load. Stores written before
  /// compaction existed held receipts that each copied whole task evidence
  /// (entries of several megabytes); this rewrites them in the bounded form
  /// once and is a no-op afterwards. updated_at is left alone: the claims did
  /// not change, so a reviewer's selected version (knowledgeRef) stays valid,
  /// and our own older mirror copy carries the same stamp and is refused.
  void compact_loaded_learning() {
    size_t compacted = 0, before_bytes = 0, after_bytes = 0;
    for (auto& [id, e] : entries_) {
      bool changed = false;
      const size_t was = e.learning.is_object() || e.type == "pattern" ? e.to_json().dump().size() : 0;
      if (e.learning.is_object() && compact_learning(e.learning)) changed = true;
      if (e.type == "pattern") {
        if (auto p = kbpat::read(e.content, e.title); p && p->learning.is_object() && compact_pattern_learning(p->learning)) {
          e.content = p->to_json().dump();
          changed = true;
        }
      }
      if (!changed) continue;
      compacted++;
      before_bytes += was;
      after_bytes += e.to_json().dump().size();
      persist_entry(e);
      mark_dirty(id);
    }
    if (compacted == 0) return;
    request_sync();
    log(LogLevel::Info, "Compacted the learning records of " + std::to_string(compacted) + " entries (" +
                            std::to_string(before_bytes / 1024) + " KB to " + std::to_string(after_bytes / 1024) + " KB)");
  }

  /// Force a pattern body into the structured form at write time.
  ///
  /// Any agent can save an entry of type 'pattern' through the plain
  /// `remember` action, and those arrive as freehand prose. Converting on
  /// the way in means the store holds one shape, so nothing downstream has
  /// to guess how a given pattern was written. Prose that cannot be read as
  /// a pattern is stored as-is; refusing the write would lose it entirely.
  std::string structure_on_write(const std::string& title, const std::string& content) {
    if (kbpat::is_structured(content)) return content;
    const auto pattern = kbpat::read(content, title);
    if (!pattern) {
      log(LogLevel::Warn,
          "Pattern \"" + title + "\" could not be structured on write; stored as written");
      return content;
    }
    return pattern->to_json().dump();
  }

  static json initial_learning() {
    return {{"revision", 1}, {"applications", json::array()}, {"feedbackIds", json::array()}, {"history", json::array()}};
  }

  std::optional<std::string> revise_pattern(const std::string& title, const std::string& content,
                                           const std::string& previous = "") {
    auto pattern = kbpat::read(content, title);
    if (!pattern) return std::nullopt;
    const auto old = previous.empty() ? std::optional<kbpat::Pattern>() : kbpat::read(previous, title);
    json learning = old && old->learning.is_object() ? old->learning : initial_learning();
    if (old) {
      auto snapshot = *old;
      snapshot.learning = nullptr;
      learning["history"].push_back({{"revision", learning["revision"]}, {"content", snapshot.to_json().dump()}});
      while (learning["history"].size() > 20) learning["history"].erase(learning["history"].begin());
      learning["revision"] = learning["revision"].get<int64_t>() + 1;
    }
    pattern->learning = learning;
    return pattern->to_json().dump();
  }

  void application_receipt(Request& req, bool assess) {
    if (busy_learning(req, str_or(req.payload(), "id", ""))) return;
    const auto& payload = req.payload();
    const auto id = str_or(payload, "id", "");
    auto it = entries_.find(id);
    auto pattern = it != entries_.end() && it->second.type == "pattern"
      ? kbpat::read(it->second.content, it->second.title) : std::optional<kbpat::Pattern>();
    auto reject = [&](const std::string& error) { req.reply({{"success", false}, {"error", error}}); };
    if (!pattern) { reject("Pattern not found"); return; }
    if (!pattern->learning.is_object()) pattern->learning = initial_learning();
    const auto goal = str_or(payload, "goalId", "");
    const auto ref = str_or(payload, assess ? "applicationRef" : "applicationId", "");
    if (goal.empty() || ref.empty()) { reject("Missing goal or application identity"); return; }
    auto& applications = pattern->learning["applications"];
    auto old = std::find_if(applications.begin(), applications.end(), [&](const json& a) { return str_or(a, "id", "") == ref; });
    if (assess) {
      if (old == applications.end() || str_or(*old, "goalId", "") != goal || str_or(*old, "declaredContext", "").empty()) {
        reject("Unresolved application reference"); return;
      }
      const auto verdict = str_or(payload, "verdict", ""), evidence = str_or(payload, "evidence", "");
      if (!valid_feedback_verdict(verdict) || kbpat::trim(evidence).empty()) {
        reject("Invalid feedback verdict or evidence"); return;
      }
      if ((*old)["verdict"] != "applied") {
        if ((*old)["verdict"] == verdict && (*old)["evidence"] == evidence) req.reply({{"success", true}, {"duplicate", true}, {"applicationRef", ref}});
        else reject("Conflicting application feedback");
        return;
      }
      (*old)["verdict"] = verdict; (*old)["evidence"] = evidence;
    } else {
      const auto context = str_or(payload, "context", "");
      const auto scope = str_or(payload, "scope", "");
      const auto receipt = json::parse(str_or(payload, "patternRef", ""), nullptr, false);
      if (kbpat::trim(context).empty() || !receipt.is_array() || receipt.size() != 2 || receipt[0] != id || !receipt[1].is_number_integer() || receipt[1] < 1) {
        reject("Unknown pattern selection; retrieve the pattern before applying it"); return;
      }
      // A retry of a declaration already on record is answered first: it must
      // still resolve after the selected revision has aged out of history.
      bool known = receipt[1] == pattern->learning["revision"];
      for (const auto& h : pattern->learning["history"]) if (h["revision"] == receipt[1]) known = true;
      const json declaration = {{"context", context}, {"scope", scope}, {"patternRevision", receipt[1]}, {"at", now_ms()}};
      if (old != applications.end()) {
        if (str_or(*old, "goalId", "") != goal) { reject("Conflicting application identity"); return; }
        // The same pattern applied again within one task or one plan is the
        // same application, used once more: the declaration joins its record
        // as evidence of how it was used, and the one verdict covers them all.
        json& declarations = (*old)["declarations"];
        if (!declarations.is_array()) {
          declarations = json::array();
          declarations.push_back({{"context", str_or(*old, "declaredContext", "")}, {"scope", ""}, {"patternRevision", (*old)["patternRevision"]}, {"at", int_or(*old, "at", 0)}});
        }
        for (const auto& d : declarations) {
          if (str_or(d, "context", "") == context && str_or(d, "scope", "") == scope) {
            req.reply({{"success", true}, {"duplicate", true}, {"applicationRef", ref}}); return;
          }
        }
        if (!known) { reject("Selected pattern revision is no longer available"); return; }
        if (declarations.size() >= MAX_DECLARATIONS) { req.reply({{"success", true}, {"duplicate", true}, {"applicationRef", ref}}); return; }
        declarations.push_back(declaration);
      } else {
        if (!known) { reject("Selected pattern revision is no longer available"); return; }
        applications.push_back({{"id", ref}, {"goalId", goal}, {"context", context}, {"declaredContext", context},
          {"verdict", "applied"}, {"evidence", "Declared before execution; effect not yet assessed"}, {"patternRevision", receipt[1]},
          {"declarations", json::array({declaration})}, {"at", now_ms()}});
      }
    }
    compact_pattern_learning(pattern->learning);
    Entry& e = it->second;
    e.content = pattern->to_json().dump();
    e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
    index_.add(e.id, e.title, index_text(e), e.tags); save_entry(e); changed("entryUpdated", event_json(e));
    req.reply({{"success", true}, {"applicationRef", ref}});
  }

  void record_pattern_application(Request& req) {
    if (busy_learning(req, str_or(req.payload(), "id", ""))) return;
    const auto& p = req.payload();
    auto it = entries_.find(str_or(p, "id", ""));
    auto pattern = it != entries_.end() && it->second.type == "pattern"
      ? kbpat::read(it->second.content, it->second.title) : std::optional<kbpat::Pattern>();
    if (!pattern) { req.reply({{"success", false}, {"error", "Pattern not found"}}); return; }
    if (!p.contains("application") || !p["application"].is_object()) {
      req.error("CONTRACT_VIOLATION", "application must be an object"); return;
    }
    json application = p["application"];
    for (const auto* key : {"id", "goalId", "context", "evidence"}) {
      if (kbpat::trim(str_or(application, key, "")).empty()) {
        req.error("CONTRACT_VIOLATION", std::string("application.") + key + " must not be empty"); return;
      }
    }
    const auto verdict = str_or(application, "verdict", "");
    if (verdict != "applied" && !valid_feedback_verdict(verdict)) {
      req.error("CONTRACT_VIOLATION", "Invalid application verdict"); return;
    }
    if (!pattern->learning.is_object()) pattern->learning = initial_learning();
    application.erase("at");
    for (auto old : pattern->learning["applications"]) {
      if (!old.is_object() || old.value("id", json()) != application["id"]) continue;
      old.erase("at");
      if (old != application) req.reply({{"success", false}, {"error", "Conflicting evidence for the same application identity"}});
      else req.reply({{"success", true}, {"duplicate", true}});
      return;
    }
    if (!application.contains("patternRevision") || !application["patternRevision"].is_number_integer() ||
        application["patternRevision"] <= 0 || application["patternRevision"] > pattern->learning["revision"]) {
      req.error("CONTRACT_VIOLATION", "Unknown pattern revision"); return;
    }
    application["at"] = now_ms();
    pattern->learning["applications"].push_back(application);
    compact_pattern_learning(pattern->learning);
    Entry& e = it->second;
    e.content = pattern->to_json().dump();
    e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
    index_.add(e.id, e.title, index_text(e), e.tags);
    save_entry(e);
    changed("entryUpdated", event_json(e));
    req.reply({{"success", true}});
  }

  /// Bring every pattern into the structured form, and put back the ones an
  /// older bug took apart. Runs once per store, at load.
  ///
  /// Two things were wrong with patterns before they had a structure. They
  /// were stored as prose and their sections recovered by matching headings,
  /// which failed the moment an agent wrote '## Context' where the matcher
  /// expected 'Context:'. And update_pattern rebuilt entries out of the
  /// sections it had recognized, so a pattern it could not read came back
  /// FLATTENED: everything gone but a single Evidence line.
  ///
  /// Conversion fixes the first. The second needs the text back, and the only
  /// place it still exists is the store's own older snapshots, so a flattened
  /// pattern is looked up there (Storage.getPrevious) before being written.
  ///
  /// Entries already structured are skipped, and snapshots are asked for only
  /// when something is actually flattened. Once a store is healed this costs
  /// one pass over memory and no snapshot reads at all.
  void heal_patterns() {
    size_t converted = 0;
    size_t unreadable = 0;
    std::vector<std::string> flattened;

    for (auto& [id, e] : entries_) {
      if (e.type != "pattern") continue;
      auto p = kbpat::read(e.content, e.title);
      if (kbpat::is_structured(e.content) && p && p->learning.is_object()) continue;
      if (!p) {
        unreadable++;
        log(LogLevel::Warn, "Pattern \"" + e.title + "\" could not be structured; left as written");
        continue;
      }
      if (!p->learning.is_object()) p->learning = initial_learning();
      e.content = p->to_json().dump();
      e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
      index_.add(e.id, e.title, p->search_text(), e.tags);
      persist_entry(e);
      converted++;
      if (kbpat::is_flattened(*p)) flattened.push_back(e.id);
    }

    if (converted > 0) {
      log(LogLevel::Info, "Structured " + std::to_string(converted) +
                              " pattern(s) written before the format existed");
    }
    if (unreadable > 0) {
      log(LogLevel::Warn, std::to_string(unreadable) + " pattern(s) could not be structured");
    }
    for (const std::string& id : flattened) recover_pattern(id);
  }

  /// Ask Storage for an intact earlier version of one flattened pattern and
  /// write it back if the copy it finds is whole. A snapshot that is missing
  /// the entry, or holds a copy damaged the same way, leaves the marker in
  /// place: the reviewer can see the gap and rewrite the pattern.
  void recover_pattern(const std::string& id) {
    request("@Storage", "getPrevious", {{"key", ENTRY_KEY_PREFIX + id}},
            [this, id](const Result& res) {
              auto it = entries_.find(id);
              if (it == entries_.end()) return;
              Entry& e = it->second;

              const json& prev = res.payload;
              if (res.ok && prev.is_object() && restore_pattern_from(id, prev)) return;
              // The per-entry key may postdate the damage; the legacy array's
              // earlier snapshot can still hold the pattern whole.
              request("@Storage", "getPrevious", {{"key", LEGACY_STORAGE_KEY}}, [this, id](const Result& legacy) {
                auto still = entries_.find(id);
                if (still == entries_.end()) return;
                if (legacy.ok && legacy.payload.is_array()) {
                  for (const auto& j : legacy.payload) {
                    if (j.is_object() && str_or(j, "id", "") == id && restore_pattern_from(id, j)) return;
                  }
                }
                log(LogLevel::Warn, "Pattern \"" + still->second.title +
                                        "\" was flattened before every surviving snapshot");
              });
            });
  }

  /// Write back an earlier copy of a pattern when that copy is whole.
  bool restore_pattern_from(const std::string& id, const json& snapshot) {
    auto it = entries_.find(id);
    if (it == entries_.end() || !snapshot.contains("content") || !snapshot["content"].is_string()) return false;
    Entry& e = it->second;
    auto p = kbpat::read(snapshot["content"].get<std::string>(), e.title);
    if (!p || kbpat::is_flattened(*p)) return false;
    if (!p->learning.is_object()) p->learning = initial_learning();
    e.content = p->to_json().dump();
    e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
    index_.add(e.id, e.title, p->search_text(), e.tags);
    save_entry(e);
    changed("entryUpdated", presented_json(e, false));
    log(LogLevel::Info, "Restored flattened pattern \"" + e.title + "\" from an earlier snapshot");
    return true;
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  std::set<std::string> pending_learning_;
  bool busy_learning(Request& req, const std::string& id) {
    if (!pending_learning_.count(id)) return false;
    req.reply({{"success", false}, {"retryable", true}, {"error", "Knowledge revision is being persisted"}}); return true;
  }
  void apply_learning(Request& req) {
    json envelope = req.payload(); envelope["requester"] = req.from();
    const auto correlation = req.message_id(); req.defer();
    request("@GoalManager", "getLearningEffect", envelope, [this, correlation](const Result& r) {
      auto reject = [this, correlation](const std::string& error, bool retry = false) { reply_to(correlation, {{"success", false}, {"retryable", retry}, {"error", error}}); };
      if (!r.ok || !r.payload.is_object() || !bool_or(r.payload, "success", false)) { reject("Learning effect unavailable or unauthorized", !r.ok); return; }
      const json decision = r.payload["decision"], effect = r.payload["effect"], input = effect["input"];
      const std::string id = str_or(input, "id", ""), action = str_or(input, "action", ""), effect_id = str_or(effect, "id", "");
      auto it = entries_.find(id);
      // An observation already counted: its id is kept with the counters,
      // not as a receipt in the learning history.
      if (it != entries_.end() && action == "observe_entry" && it->second.evidence.knows(effect_id)) {
        reply_to(correlation, {{"success", true}, {"duplicate", true}, {"receipt", {{"effectId", effect_id}, {"decisionId", decision["id"]}, {"action", action}, {"evidence", it->second.evidence.counters()}}}}); return;
      }
      if (it != entries_.end() && it->second.learning.is_object()) {
        const json& held = it->second.learning;
        if (held.contains("history") && held["history"].is_array()) {
          for (const auto& receipt : held["history"]) if (receipt.is_object() && str_or(receipt, "effectId", "") == effect_id) {
            reply_to(correlation, {{"success", true}, {"duplicate", true}, {"receipt", receipt}}); return;
          }
        }
        // A receipt old enough to have been folded into the tally is still
        // this effect's receipt; answering it again keeps delivery idempotent.
        if (learning_receipt_ids(held).count(effect_id)) {
          reply_to(correlation, {{"success", true}, {"duplicate", true}, {"receipt", {{"effectId", effect_id}, {"decisionId", decision["id"]}, {"compacted", true}}}}); return;
        }
      }
      if (pending_learning_.count(id)) { reject("Knowledge revision is being persisted", true); return; }
      if (str_or(effect, "state", "") != "proposed") { reject("Effect is not awaiting application"); return; }
      if (r.payload.contains("validationError") && r.payload["validationError"].is_string()) { reject(r.payload["validationError"].get<std::string>()); return; }
      const bool creating = action == "save_entry";
      if (creating && it != entries_.end()) { reject("Target already exists"); return; }
      if (!creating && it == entries_.end()) { reject("Knowledge target unavailable"); return; }
      if (action == "observe_entry") { observe_entry(correlation, decision, effect, it->second); return; }
      // Pattern feedback (a recorded use's verdict, or an observation about a
      // pattern that was shown) lands on a pattern that agents keep using, so
      // its version moves constantly; neither rewrites the pattern's claims,
      // so neither needs the version the reviewer read.
      const bool pattern_feedback = action == "record_pattern_application" || action == "observe_pattern";
      if (!creating && !pattern_feedback && it->second.knowledge_ref() != str_or(input, "knowledgeRef", "")) {
        reply_to(correlation, {{"success", false}, {"retryable", false}, {"conflict", true}, {"currentRef", it->second.knowledge_ref()}, {"error", "Selected knowledge version changed"}}); return;
      }
      if (!creating && it->second.origin == "user" && action != "dispute_entry" && action != "confirm_entry" && !pattern_feedback) {
        reply_to(correlation, {{"success", false}, {"retryable", false}, {"protected", true}, {"error", "User-authored knowledge is protected; record a supported dispute instead"}}); return;
      }
      const std::string scope = str_or(input, "scope", "");
      if (action == "archive_entry" && !scope.empty()) { reject("Scoped retirement requires supersede_entry and an applicable replacement"); return; }
      json replacement_snapshot;
      if (action == "supersede_entry") {
        auto replacement = entries_.find(str_or(input, "replacementId", ""));
        if (replacement == entries_.end() || !replacement->second.applicable(scope) || (replacement->second.learning.is_object() && !str_or(replacement->second.learning,"scope","").empty() && str_or(replacement->second.learning,"scope","") != scope)) { reject("Replacement must be saved and applicable before supersession"); return; }
        std::string revised_id;
        for (const auto& candidate : decision["effects"]) {
          const auto& proposal = candidate["input"];
          const auto disposition = str_or(proposal, "action", "");
          if (str_or(proposal, "id", "") == replacement->second.id && (disposition == "save_entry" || disposition == "update_entry" || disposition == "confirm_entry")) revised_id = str_or(candidate, "id", "");
        }
        const auto history = replacement->second.learning.is_object() ? replacement->second.learning.value("history", json::array()) : json::array();
        const auto expected_ref = revised_id.empty() ? str_or(input, "replacementRef", "") : !history.empty() && str_or(history.back(), "effectId", "") == revised_id ? json::array({replacement->second.id, history.back()["at"], history.back()["revision"]}).dump() : "";
        if (replacement->second.knowledge_ref() != expected_ref) { reject("Replacement version changed; reread and reconcile its claims"); return; }
        replacement_snapshot = {{"id", replacement->second.id}, {"knowledgeRef", replacement->second.knowledge_ref()}, {"title", replacement->second.title}, {"content", replacement->second.content}};
      }
      Entry next = creating ? Entry() : it->second;
      const json before = creating ? json(nullptr) : slim_before(next.to_json());
      const int64_t now = std::max(static_cast<int64_t>(now_ms()), next.updated_at + 1);
      if (creating) { next.id = id; next.title = str_or(input,"title",""); next.content = str_or(input,"content",""); next.type = str_or(input,"type","learned"); next.origin = "reviewer"; next.created_by = object_id_; next.created_at = now; next.creator_peer_id = self_peer_id(); }
      if (creating || action == "update_entry") {
        if (input.contains("title") && input["title"].is_string()) next.title = clip_utf8(input["title"].get<std::string>(), 200);
        if (input.contains("content") && input["content"].is_string()) {
          auto content = input["content"].get<std::string>();
          if (next.type == "pattern") { auto revised = revise_pattern(next.title, content, creating ? "" : next.content); if (!revised) { reject("Invalid pattern content"); return; } next.content = *revised; }
          else next.content = content;
        }
        if (input.contains("tags") && input["tags"].is_array()) {
          next.tags.clear();
          for (const auto& t : input["tags"]) if (t.is_string()) next.tags.push_back(t.get<std::string>());
        }
      }
      if (!creating && action == "update_entry" && next.claim_text() != it->second.claim_text()) next.evidence.reset_for_new_claim(now);
      if (!next.learning.is_object()) next.learning = {{"revision",0},{"history",json::array()},{"disputes",json::array()},{"supersessions",json::array()}};
      if (action == "record_pattern_application") {
        auto pattern = next.type == "pattern" ? kbpat::read(next.content,next.title) : std::optional<kbpat::Pattern>();
        bool found = false;
        if (pattern && pattern->learning.is_object()) for (auto& app : pattern->learning["applications"]) {
          if (str_or(app,"id","") != str_or(input,"applicationRef","") || app["goalId"] != decision["goalId"]) continue;
          if (str_or(app,"verdict","") != "applied" && (app["verdict"] != input["verdict"] || app["evidence"] != input["evidence"])) { reject("Conflicting application feedback"); return; }
          app["verdict"] = input["verdict"]; app["evidence"] = input["evidence"]; found = true;
        }
        if (!found) { reject("Unresolved application reference"); return; }
        compact_pattern_learning(pattern->learning);
        next.content = pattern->to_json().dump();
      }
      if (action == "observe_pattern") {
        // The reviewer judged a pattern that this goal did not formally apply
        // (it was shown, or followed without a declaration). That is weaker
        // evidence than a recorded use: it is kept beside the uses, never
        // counted as one, and claims no pattern revision.
        auto pattern = next.type == "pattern" ? kbpat::read(next.content, next.title) : std::optional<kbpat::Pattern>();
        if (!pattern) { reject("Pattern not found"); return; }
        const auto verdict = str_or(input, "verdict", "");
        if (!valid_feedback_verdict(verdict)) { reject("Invalid pattern usefulness verdict"); return; }
        if (!pattern->learning.is_object()) pattern->learning = initial_learning();
        json& observations = pattern->learning["observations"];
        if (!observations.is_array()) observations = json::array();
        observations.push_back({{"goalId", decision["goalId"]}, {"verdict", verdict}, {"evidence", clip_utf8(str_or(input, "evidence", ""), EVIDENCE_TEXT_CAP)},
          {"relevance", clip_utf8(str_or(input, "relevance", "shown"), 40)}, {"effectId", effect_id}, {"at", now_ms()}});
        compact_pattern_learning(pattern->learning);
        next.content = pattern->to_json().dump();
      }
      if (action == "archive_entry") next.archived = true;
      if (action == "supersede_entry") next.learning["supersessions"].push_back({{"replacementId",input["replacementId"]},{"scope",scope},{"effectId",effect_id}});
      if (action == "dispute_entry") next.learning["disputes"].push_back({{"explanation",input["evidence"]},{"scope",scope},{"effectId",effect_id}});
      if (action == "narrow_entry" || (creating && !scope.empty())) next.learning["scope"] = scope;
      next.learning["revision"] = int_or(next.learning,"revision",0) + 1;
      next.updated_at = now;
      json receipt = {{"effectId",effect_id},{"decisionId",decision["id"]},{"goalId",decision["goalId"]},{"revision",next.learning["revision"]},{"at",now},{"before",before},{"input",input},{"evidence",slim_evidence(decision.contains("evidence") ? decision["evidence"] : json::object())}};
      if (!replacement_snapshot.is_null()) receipt["replacement"] = replacement_snapshot;
      next.learning["history"].push_back(receipt);
      compact_learning(next.learning);
      pending_learning_.insert(id);
      request("@Storage", "set", {{"key",ENTRY_KEY_PREFIX + id},{"value",next.to_json()}}, [this, correlation, next, receipt, creating](const Result& saved) {
        pending_learning_.erase(next.id);
        if (!saved.ok || saved.payload == false || (saved.payload.is_object() && saved.payload.contains("success") && !bool_or(saved.payload,"success",false))) {
          reply_to(correlation, {{"success",false},{"retryable",true},{"error","Knowledge persistence rejected"}}); return;
        }
        // Reads and usefulness credit that landed while the write was in
        // flight belong to the live entry; the revision must not erase them.
        Entry merged = next;
        auto live = entries_.find(next.id);
        if (live != entries_.end()) {
          merged.access_count = std::max(merged.access_count, live->second.access_count);
          merged.last_accessed_at = std::max(merged.last_accessed_at, live->second.last_accessed_at);
          merged.useful_count = std::max(merged.useful_count, live->second.useful_count);
          merged.last_useful_at = std::max(merged.last_useful_at, live->second.last_useful_at);
        }
        const bool counters_moved = merged.access_count != next.access_count || merged.useful_count != next.useful_count;
        entries_[next.id] = merged; index_.add(next.id,next.title,index_text(next),next.tags);
        if (counters_moved) persist_entry(entries_[next.id]);
        mark_dirty(next.id); request_sync(); changed(creating ? "entryAdded" : "entryUpdated", event_json(next));
        reply_to(correlation, {{"success",true},{"receipt",receipt}});
      });
    });
  }

  /// One prediction or assumption that rested on an entry held or missed.
  /// It counts toward the entry's evidence and changes no claim: no revision,
  /// no updatedAt (a reviewer's selected version for another effect stays
  /// valid), allowed on user-authored entries, and no receipt in the learning
  /// history (the effect id joins the entry's recent observations instead,
  /// which keeps redelivery idempotent). An archived entry is unavailable.
  void observe_entry(const std::string& correlation, const json& decision, const json& effect, const Entry& current) {
    const json input = effect.contains("input") && effect["input"].is_object() ? effect["input"] : json::object();
    const std::string effect_id = str_or(effect, "id", ""), outcome = str_or(input, "outcome", "");
    auto reject = [this, correlation](const std::string& error) { reply_to(correlation, {{"success", false}, {"retryable", false}, {"error", error}}); };
    if (current.archived) { reject("Knowledge target unavailable: the entry is archived"); return; }
    if (outcome != "held" && outcome != "missed") { reject("An entry observation is held or missed"); return; }
    if (!input.contains("cited") || !input["cited"].is_boolean()) { reject("Say whether the entry was cited or only shown"); return; }
    const bool cited = input["cited"].get<bool>(), held = outcome == "held";
    Entry next = current;
    int64_t& counter = cited ? (held ? next.evidence.held : next.evidence.missed)
                             : (held ? next.evidence.shown_held : next.evidence.shown_missed);
    counter++;
    const int64_t now = static_cast<int64_t>(now_ms());
    next.evidence.last_tested_at = std::max(next.evidence.last_tested_at, now);
    next.evidence.remember_effect(effect_id);
    const json receipt = {{"effectId", effect_id}, {"decisionId", decision["id"]}, {"goalId", decision["goalId"]}, {"action", "observe_entry"},
                          {"outcome", outcome}, {"cited", cited}, {"at", now}, {"knowledgeRef", next.knowledge_ref()}, {"evidence", next.evidence.counters()}};
    pending_learning_.insert(next.id);
    request("@Storage", "set", {{"key", ENTRY_KEY_PREFIX + next.id}, {"value", next.to_json()}}, [this, correlation, next, receipt](const Result& saved) {
      pending_learning_.erase(next.id);
      if (!saved.ok || saved.payload == false || (saved.payload.is_object() && saved.payload.contains("success") && !bool_or(saved.payload, "success", false))) {
        reply_to(correlation, {{"success", false}, {"retryable", true}, {"error", "Knowledge persistence rejected"}}); return;
      }
      // Reads and usefulness credit that landed while the write was in flight
      // belong to the live entry.
      Entry merged = next;
      auto live = entries_.find(next.id);
      if (live != entries_.end()) {
        merged.access_count = std::max(merged.access_count, live->second.access_count);
        merged.last_accessed_at = std::max(merged.last_accessed_at, live->second.last_accessed_at);
        merged.useful_count = std::max(merged.useful_count, live->second.useful_count);
        merged.last_useful_at = std::max(merged.last_useful_at, live->second.last_useful_at);
      }
      const bool counters_moved = merged.access_count != next.access_count || merged.useful_count != next.useful_count;
      entries_[next.id] = merged;
      if (counters_moved) persist_entry(entries_[next.id]);
      mark_dirty(next.id); request_sync(); changed("entryUpdated", event_json(merged));
      reply_to(correlation, {{"success", true}, {"receipt", receipt}});
    });
  }

  void register_handlers() {
    on("applyLearningDecision", [this](Request& req) { apply_learning(req); });
    on("remember", [this](Request& req) { handle_remember(req); });
    on("beginPatternApplication", [this](Request& req) { application_receipt(req, false); });
    on("assessPatternApplication", [this](Request& req) { application_receipt(req, true); });
    on("recordPatternApplication", [this](Request& req) { record_pattern_application(req); });
    // The evidence hashes every receipt cites, so GoalManager's evidence
    // store keeps those bodies when it sweeps the ones nothing references.
    on("evidenceHashes", [this](Request& req) {
      std::set<std::string> hashes;
      for (const auto& [_, e] : entries_) {
        if (!e.learning.is_object() || !e.learning.contains("history") || !e.learning["history"].is_array()) continue;
        for (const auto& r : e.learning["history"]) {
          if (!r.is_object() || !r.contains("evidence") || !r["evidence"].is_object()) continue;
          for (const auto& [ref, v] : r["evidence"].items()) {
            const auto hash = v.is_object() ? str_or(v, "hash", "") : std::string();
            if (!hash.empty()) hashes.insert(hash);
          }
        }
      }
      json out = json::array();
      for (const auto& h : hashes) out.push_back(h);
      req.reply(std::move(out));
    });
    on("patternHistory", [this](Request& req) {
      const auto it = entries_.find(str_or(req.payload(), "id", ""));
      const auto pattern = it != entries_.end() && it->second.type == "pattern"
        ? kbpat::read(it->second.content, it->second.title) : std::optional<kbpat::Pattern>();
      req.reply(pattern ? pattern->learning : json());
    });
    on("timerFired", [this](Request& req) {
      const json& p = req.payload();
      const std::string kind = p.contains("data") && p["data"].is_object() ? str_or(p["data"], "kind", "") : "";
      if (kind == "sync") { sync_wakeup_armed_ = false; flush_sync(static_cast<int64_t>(now_ms())); }
      if (kind == "access") flush_access();
    });
    on("recall", [this](Request& req) { handle_recall(req); });
    on("weave", [this](Request& req) { handle_weave(req); });
    on("match", [this](Request& req) { handle_match(req); });

    on("get", [this](Request& req) {
      const std::string id = str_or(req.payload(), "id", "");
      auto it = entries_.find(id);
      if (it == entries_.end()) { req.reply(nullptr); return; }
      touch(it->second);
      req.reply(presented_json(it->second, bool_or(req.payload(), "includeLearning", false)));
    });

    on("forget", [this](Request& req) {
      if (busy_learning(req, str_or(req.payload(), "id", ""))) return;
      const std::string id = str_or(req.payload(), "id", "");
      auto it = entries_.find(id);
      if (it == entries_.end()) { req.reply({{"success", false}, {"error", "No entry with id \"" + id + "\""}}); return; }
      // Forgetting is two-step. The first forget archives: the entry leaves
      // recall, match, and the default list, but nothing is lost and it can
      // be restored, so a lesson with learning history behind it is kept
      // whole. Forgetting an entry that is already archived is the user
      // saying it twice, and that deletes it for good, history included.
      Entry& e = it->second;
      if (!e.archived) {
        e.archived = true;
        e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
        save_entry(e);
        changed("entryUpdated", event_json(e));
        log(LogLevel::Info, "Forgot (archived): \"" + e.title + "\"");
        req.reply({{"success", true}, {"archived", true}});
        return;
      }
      const std::string title = e.title;
      index_.remove(id);
      entries_.erase(it);
      unpersist_entry(id);
      tombstone_entry(id, static_cast<int64_t>(now_ms()));
      request_sync();
      changed("entryRemoved", {{"id", id}});
      log(LogLevel::Info, "Forgot (deleted): \"" + title + "\"");
      req.reply({{"success", true}, {"deleted", true}});
    });

    on("update", [this](Request& req) { handle_update(req); });

    on("list", [this](Request& req) {
      const json& p = req.payload();
      const std::string type = str_or(p, "type", "");
      const size_t max = static_cast<size_t>(std::clamp<int64_t>(int_or(p, "limit", 50), 1, 200));
      const bool include_archived = bool_or(p, "includeArchived", false);

      std::vector<const Entry*> results = filtered_by_recency(type, {}, include_archived);
      if (results.size() > max) results.resize(max);
      json out = json::array();
      const bool include_learning = bool_or(p, "includeLearning", false);
      for (const Entry* e : results) out.push_back(presented_json(*e, include_learning));
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
        const auto operation = str_or(p, "operationId", "");
        if (it->second.type == "pattern" && !operation.empty()) {
          auto pattern = kbpat::read(it->second.content, it->second.title);
          if (pattern) {
            if (!pattern->learning.is_object()) pattern->learning = initial_learning();
            auto& ids = pattern->learning["feedbackIds"];
            if (std::find(ids.begin(), ids.end(), json(operation)) != ids.end()) continue;
            ids.push_back(operation);
            compact_pattern_learning(pattern->learning);
            it->second.content = pattern->to_json().dump();
          }
        }
        it->second.useful_count++;
        it->second.last_useful_at = now;
        persist_entry(it->second);
        mark_dirty(it->second.id);
        changed("entryUpdated", event_json(it->second));
        marked++;
      }
      if (marked > 0) request_sync();
      log(LogLevel::Info, "markUseful: " + std::to_string(marked) + "/" +
                              std::to_string(p["ids"].size()) + " entries");
      req.reply({{"marked", marked}});
    });

    on("archive", [this](Request& req) {
      if (busy_learning(req, str_or(req.payload(), "id", ""))) return;
      const json& p = req.payload();
      const std::string id = str_or(p, "id", "");
      if (id.empty()) { req.error("CONTRACT_VIOLATION", "id must not be empty"); return; }
      auto it = entries_.find(id);
      if (it == entries_.end()) {
        req.reply({{"success", false}, {"error", "No entry with id \"" + id + "\""}});
        return;
      }
      Entry& e = it->second;
      e.archived = bool_or(p, "archived", true);
      e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
      save_entry(e);
      changed("entryUpdated", event_json(e));
      log(LogLevel::Info,
          std::string(e.archived ? "Archived" : "Restored") + ": \"" + e.title + "\"");
      req.reply({{"success", true}});
    });

    // SharedState sync: merge per-entry registers published by peers.
    //
    // The namespace filter reads `name`, which is the field SharedState
    // actually emits ({ name, key, value }). It previously read `namespace`,
    // a field that is never sent, so this handler returned early on every
    // event and the merge below had never once run.
    on("changed", [this](Request& req) {
      const json& p = req.payload();
      if (str_or(p, "aspect", "") != "stateChanged") return;
      const json change = p.contains("value") && p["value"].is_object() ? p["value"] : json::object();
      if (str_or(change, "name", "") != SYNC_NAMESPACE) return;
      const std::string key = str_or(change, "key", "");
      if (key.empty()) return;
      const json remote = change.contains("value") ? change["value"] : json();

      // Per-entry register: the authoritative carrier for a single change.
      if (key.rfind(ENTRY_REGISTER_PREFIX, 0) == 0) {
        const std::string id = key.substr(std::string(ENTRY_REGISTER_PREFIX).size());
        if (apply_remote_entry(id, remote)) {
          log(LogLevel::Info, "Merged remote knowledge entry " + id + ", now " +
                                  std::to_string(entries_.size()) + " total");
        }
        return;
      }

      // Legacy whole-array key from a peer that predates per-entry registers.
      // Still accepted so a mixed-version mesh converges; never published.
      if (key == "entries" && remote.is_array()) {
        const int merged = merge_legacy_array(remote);
        if (merged > 0) {
          log(LogLevel::Info, "Merged " + std::to_string(merged) +
                                  " remote entries (legacy array), now " +
                                  std::to_string(entries_.size()) + " total");
        }
      }
    });
  }

  void handle_remember(Request& req) {
    const json& p = req.payload();
    const std::string title = str_or(p, "title", "");
    const std::string content = str_or(p, "content", "");
    const std::string type = str_or(p, "type", "");
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

    // Patterns are stored as structure whoever writes them. The reviewer
    // sends structure already; an agent using the plain `remember` action
    // sends whatever prose it composed, and that is structured here rather
    // than left to drift into a shape nothing can read back.
    const auto revised = type == "pattern" ? revise_pattern(title, content) : std::optional<std::string>(content);
    if (!revised) { req.error("CONTRACT_VIOLATION", "Pattern needs Context, Forces, Therefore and Evidence"); return; }
    const std::string body = *revised;

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
      if (busy_learning(req, existing->id)) return;
      if (existing->learning.is_object() && (existing->archived || !existing->learning.value("supersessions",json::array()).empty())) { req.reply({{"success",false},{"error","Retired knowledge requires an explicit revision"},{"id",existing->id}}); return; }
      const std::string old_claim = existing->claim_text();
      existing->content = type == "pattern" ? *revise_pattern(title, content, existing->content) : body;
      if (existing->claim_text() != old_claim) existing->evidence.reset_for_new_claim(now);
      if (p.contains("tags") && p["tags"].is_array()) existing->tags = tags;
      existing->archived = false;
      existing->updated_at = std::max(now, existing->updated_at + 1);
      index_.add(existing->id, existing->title, index_text(*existing), existing->tags);
      save_entry(*existing);
      changed("entryUpdated", event_json(*existing));
      log(LogLevel::Info, "Updated knowledge: \"" + title + "\" (" + type + ")");
      req.reply({{"id", existing->id}});
      maybe_distill(now);
      return;
    }

    Entry e;
    e.id = gen_id();
    e.title = clip_utf8(title, 200);
    e.content = body;
    e.type = type;
    e.tags = std::move(tags);
    e.origin = std::move(origin);
    e.created_by = req.from();
    e.creator_peer_id = self_peer_id();
    e.created_at = now;
    e.updated_at = std::max(now, e.updated_at + 1);
    e.access_count = 0;
    e.last_accessed_at = now;
    e.useful_count = 0;
    e.last_useful_at = 0;
    e.archived = false;

    index_.add(e.id, e.title, index_text(e), e.tags);
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
    const std::string scope = str_or(p,"scope","");
    const std::string query = str_or(p, "query", "");
    const std::string type = str_or(p, "type", "");
    const bool previews = bool_or(p, "previews", false);
    const size_t max = static_cast<size_t>(std::clamp<int64_t>(int_or(p, "limit", 10), 1, 50));
    const int64_t min_goals = int_or(p, "minGoals", 0);

    std::vector<std::string> tag_filter;
    if (p.contains("tags") && p["tags"].is_array()) {
      for (const auto& t : p["tags"]) {
        if (t.is_string()) tag_filter.push_back(t.get<std::string>());
      }
    }

    struct Row { const Entry* entry; std::string snippet; double score; bool scored; };
    std::vector<Row> rows;
    // 'uncertain': what agents rely on most but know least about first, the
    // entries most worth testing. Ranks the whole filtered pool, then cuts.
    const bool by_uncertainty = str_or(p, "order", "") == "uncertain";
    const size_t pool = by_uncertainty ? SIZE_MAX : max;

    const std::vector<std::string> query_terms = kb::tokenize(query);
    if (!query_terms.empty()) {
      // Rank over a generous pool, then apply type/tag filters so a filter
      // can't empty the results just because top hits were other types.
      for (const auto& hit : index_.search(query, 100)) {
        auto it = entries_.find(hit.id);
        if (it == entries_.end()) continue;
        const Entry& e = it->second;
        if (!e.applicable(scope)) continue;
        if (!type.empty() && e.type != type) continue;
        if (!tag_filter.empty() && !has_any_tag(e, tag_filter)) continue;
        if (min_goals > 0 && receipt_goals(e.learning) < min_goals) continue;
        const std::string shown = e.type == "pattern" ? e.to_presented_json()["content"].get<std::string>() : e.content;
        rows.push_back({&e, kb::make_snippet(shown, query_terms), hit.score, true});
        if (rows.size() >= pool) break;
      }
    } else {
      // Without a query the candidates are ordered by recency, or by worth
      // when asked: what the user wrote first, then what reviewers found
      // useful, then recency. A prompt that injects the top N of a tag (the
      // About the User block) wants worth, or an old identity fact loses its
      // place to whatever was updated last.
      std::vector<const Entry*> candidates = filtered_by_recency(type, tag_filter, false);
      if (str_or(p, "order", "") == "worth") {
        std::stable_sort(candidates.begin(), candidates.end(), [](const Entry* a, const Entry* b) {
          const bool au = a->origin == "user", bu = b->origin == "user";
          if (au != bu) return au;
          return a->useful_count > b->useful_count;
        });
      }
      for (const Entry* e : candidates) {
        if (!e->applicable(scope)) continue;
        if (min_goals > 0 && receipt_goals(e->learning) < min_goals) continue;
        // Patterns are stored as JSON; the snippet shows the prose a reader sees.
        const std::string shown = e->type == "pattern" ? e->to_presented_json()["content"].get<std::string>() : e->content;
        rows.push_back({e, clip_utf8(shown, 160), 0, false});
        if (rows.size() >= pool) break;
      }
    }
    if (by_uncertainty) {
      const int64_t now = static_cast<int64_t>(now_ms());
      auto worth_testing = [now](const Entry* e) { return reliance(*e) * e->evidence.uncertainty(now); };
      std::stable_sort(rows.begin(), rows.end(), [&](const Row& a, const Row& b) { return worth_testing(a.entry) > worth_testing(b.entry); });
      if (rows.size() > max) rows.resize(max);
    }

    // Count the read. Counters live in one small key (see ACCESS_KEY); the
    // entries themselves are not rewritten by a read.
    for (auto& row : rows) touch(entries_[row.entry->id]);
    const bool include_learning = bool_or(p, "includeLearning", false);

    json out = json::array();
    for (const auto& row : rows) {
      if (previews) {
        json preview = {{"id", row.entry->id},   {"title", row.entry->title},
                        {"type", row.entry->type}, {"tags", row.entry->tags},
                        {"snippet", row.entry->learning.is_object() ? clip_utf8(row.entry->to_presented_json()["content"].get<std::string>(), 240) : row.snippet}, {"knowledgeRef", row.entry->knowledge_ref()},
                        {"learning", include_learning ? row.entry->learning : learning_summary(row.entry->learning)}};
        // Compact: a preview carries evidence only once the entry was tested
        // (absent means untested).
        if (row.entry->evidence.tested()) preview["evidence"] = row.entry->evidence.view(static_cast<int64_t>(now_ms()));
        if (row.scored) preview["score"] = row.score;
        out.push_back(std::move(preview));
      } else {
        json full = presented_json(*row.entry, include_learning);
        full["snippet"] = row.snippet;
        if (row.scored) full["score"] = row.score;
        out.push_back(std::move(full));
      }
    }
    log(LogLevel::Info, "Recall \"" + (query.empty() ? "*" : query) + "\" => " +
                            std::to_string(out.size()) + " entries");
    req.reply(std::move(out));
  }

  /// The goals in which a pattern has a recorded application, of any verdict.
  static std::set<std::string> application_goals(const Entry& e) {
    std::set<std::string> goals;
    const auto pattern = kbpat::read(e.content, e.title);
    if (!pattern || !pattern->learning.is_object() || !pattern->learning["applications"].is_array()) return goals;
    for (const auto& a : pattern->learning["applications"]) {
      const auto goal = str_or(a, "goalId", "");
      if (!goal.empty()) goals.insert(goal);
    }
    return goals;
  }

  /// The pattern's most recent applications that did not help: the evidence
  /// a reader should weigh before following it again.
  static json recent_counterexamples(const Entry& e) {
    json out = json::array();
    const auto pattern = kbpat::read(e.content, e.title);
    if (!pattern || !pattern->learning.is_object() || !pattern->learning["applications"].is_array()) return out;
    std::vector<json> misses;
    for (const auto& a : pattern->learning["applications"]) {
      const auto verdict = str_or(a, "verdict", "");
      if (verdict == "no_effect" || verdict == "harmful") misses.push_back(a);
    }
    std::sort(misses.begin(), misses.end(), [](const json& a, const json& b) { return int_or(a, "at", 0) > int_or(b, "at", 0); });
    for (const auto& a : misses) {
      if (out.size() >= MAX_COUNTEREXAMPLES) break;
      out.push_back({{"goalId", str_or(a, "goalId", "")}, {"verdict", str_or(a, "verdict", "")},
                     {"evidence", clip_utf8(str_or(a, "evidence", ""), 300)}, {"at", int_or(a, "at", 0)}});
    }
    return out;
  }

  static std::string fixed2(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.2f", v);
    return buf;
  }

  void handle_weave(Request& req) {
    const json& p = req.payload();
    const std::string scope = str_or(p,"scope","");
    const std::string query = str_or(p, "query", "");
    // `from`: patterns a plan already follows. Their links say what the
    // language expects next, so a re-plan can grow from where the goal is.
    std::vector<std::string> from_ids;
    if (p.contains("from") && p["from"].is_array()) {
      for (const auto& v : p["from"]) if (v.is_string() && from_ids.size() < 20) from_ids.push_back(v.get<std::string>());
    }
    if (query.empty() && from_ids.empty()) { req.error("CONTRACT_VIOLATION", "query or from must not be empty"); return; }
    const size_t max = static_cast<size_t>(std::clamp<int64_t>(int_or(p, "limit", 5), 1, 20));
    const int64_t max_hops = std::clamp<int64_t>(int_or(p, "hops", 1), 0, 2);

    struct Woven { Entry* entry; std::string snippet; double score; bool scored; std::string via; bool seed; };
    std::vector<Woven> selected;
    std::set<std::string> seen;

    const std::vector<std::string> query_terms = kb::tokenize(query);
    if (!query_terms.empty()) {
      // Filter by entry type before capping candidates; facts cannot crowd patterns out.
      for (const auto& hit : index_.search(query, entries_.size())) {
        auto it = entries_.find(hit.id);
        if (it == entries_.end()) continue;
        Entry& e = it->second;
        if (!e.applicable(scope) || e.type != "pattern") continue;
        const std::string shown = e.to_presented_json()["content"].get<std::string>();
        selected.push_back({&e, kb::make_snippet(shown, query_terms), hit.score, true, "matched", false});
        if (selected.size() >= 100) break;
      }
      // Recorded outcomes in contexts like this one move a pattern up or
      // down: helpful raises it, no effect lowers it a little, harmful more.
      for (auto& row : selected) {
        std::set<std::string> helpful, no_effect, harmful;
        const auto pattern = kbpat::read(row.entry->content, row.entry->title);
        if (pattern && pattern->learning.is_object() && pattern->learning["applications"].is_array()) {
          for (const auto& application : pattern->learning["applications"]) {
            if (!application.is_object()) continue;
            size_t matches = 0;
            for (const auto& word : kb::tokenize(str_or(application, "context", ""))) {
              if (word.size() >= 3 && std::find(query_terms.begin(), query_terms.end(), word) != query_terms.end()) matches++;
            }
            if (matches < 2) continue;
            const auto verdict = str_or(application, "verdict", ""), goal = str_or(application, "goalId", "");
            if (verdict == "helpful") helpful.insert(goal);
            if (verdict == "no_effect") no_effect.insert(goal);
            if (verdict == "harmful") harmful.insert(goal);
          }
        }
        const double weight = std::clamp(1.0 + helpful.size() * 0.1 - no_effect.size() * 0.1 - harmful.size() * 0.2, 0.5, 1.5);
        row.score *= weight;
        row.via = "matched; contextual evidence weight=" + fixed2(weight);
      }
      std::stable_sort(selected.begin(), selected.end(), [](const Woven& a, const Woven& b) { return a.score > b.score; });
      if (selected.size() > max) selected.resize(max);
    }
    for (const auto& row : selected) seen.insert(row.entry->id);
    for (const auto& id : from_ids) {
      Entry* e = find_pattern_by_name(id);
      if (!e || !e->applicable(scope) || seen.count(e->id)) continue;
      seen.insert(e->id);
      selected.push_back({e, "", 0, false, "in the current plan", true});
    }

    // Breadth-first link expansion: a selected pattern pulls in the patterns
    // its links name, so the language's structure (not just keyword
    // overlap) shapes the selection. A source's links go out best-supported
    // first: those whose two patterns have been used together in the most
    // goals. Output is capped so a densely linked language can't flood the
    // prompt; patterns passed in `from` are not returned again.
    const size_t total_cap = max * 3;
    auto returned = [&]() { size_t n = 0; for (const auto& w : selected) if (!w.seed) n++; return n; };
    std::set<std::string> dangling;
    std::map<std::string, std::string> broken;
    size_t frontier_begin = 0;
    for (int64_t hop = 0; hop < max_hops && frontier_begin < selected.size(); hop++) {
      const size_t frontier_end = selected.size();
      for (size_t i = frontier_begin; i < frontier_end; i++) {
        const Woven source = selected[i];
        const auto source_goals = application_goals(*source.entry);
        std::vector<std::pair<Entry*, size_t>> linked_rows;
        for (const auto& name : parse_pattern_links(source.entry->content, source.entry->title)) {
          Entry* linked = find_pattern_by_name(name);
          if (!linked || !linked->applicable(scope)) {
            if (Entry* gone = find_pattern_by_name(name, true)) broken[name] = gone->id;
            else dangling.insert(name);
            continue;
          }
          if (seen.count(linked->id)) continue;
          size_t together = 0;
          for (const auto& g : application_goals(*linked)) together += source_goals.count(g);
          linked_rows.push_back({linked, together});
        }
        std::stable_sort(linked_rows.begin(), linked_rows.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
        for (const auto& [linked, together] : linked_rows) {
          if (seen.count(linked->id) || returned() >= total_cap) continue;
          seen.insert(linked->id);
          std::string via = "linked-from: " + source.entry->title;
          if (together > 0) via += "; used together in " + std::to_string(together) + (together == 1 ? " goal" : " goals");
          if (source.seed) via += " (in the current plan)";
          selected.push_back({linked, "", 0, false, via, false});
        }
      }
      frontier_begin = frontier_end;
    }

    // Inbound links of every returned pattern: which patterns lead here.
    std::map<std::string, json> linked_from;
    for (const auto& w : selected) if (!w.seed) linked_from[w.entry->id] = json::array();
    for (auto& [_, e] : entries_) {
      if (e.type != "pattern" || !e.applicable(scope)) continue;
      for (const auto& name : parse_pattern_links(e.content, e.title)) {
        Entry* target = find_pattern_by_name(name);
        if (target && target->id != e.id && linked_from.count(target->id)) linked_from[target->id].push_back(e.title);
      }
    }

    // Bump access counts so patterns participate in staleness signals.
    const int64_t now = static_cast<int64_t>(now_ms());
    json patterns = json::array();
    for (const auto& w : selected) {
      if (w.seed) continue;
      touch(*w.entry);
      json full = presented_json(*w.entry, false);
      if (w.scored) {
        full["snippet"] = w.snippet;
        full["score"] = w.score;
      }
      full["via"] = w.via;
      full["linkedFrom"] = linked_from[w.entry->id];
      full["counterexamples"] = recent_counterexamples(*w.entry);
      patterns.push_back(std::move(full));
    }
    flush_sync(now);

    json dangling_out = json::array();
    for (const auto& name : dangling) dangling_out.push_back(name);
    json broken_out = json::array();
    for (const auto& [name, id] : broken) broken_out.push_back({{"name", name}, {"archivedId", id}});
    log(LogLevel::Info, "Weave \"" + clip_utf8(query.empty() ? std::string("(from plan)") : query, 60) + "\" => " +
                            std::to_string(patterns.size()) + " patterns (" +
                            std::to_string(dangling_out.size()) + " dangling, " +
                            std::to_string(broken_out.size()) + " broken links)");
    req.reply({{"patterns", std::move(patterns)}, {"dangling", std::move(dangling_out)}, {"broken", std::move(broken_out)}});
  }

  void handle_match(Request& req) {
    const json& p = req.payload();
    const std::string scope = str_or(p,"scope","");
    const std::string pattern = str_or(p, "pattern", "");
    if (pattern.empty()) { req.error("CONTRACT_VIOLATION", "pattern must not be empty"); return; }
    const size_t max = static_cast<size_t>(std::clamp<int64_t>(int_or(p, "limit", 10), 1, 50));

    // 'A|B' alternations of literals; anything with other regex
    // metacharacters degrades to one literal (see file header).
    std::vector<std::string> needles;
    if (!has_regex_meta(pattern)) {
      size_t start = 0;
      while (start <= pattern.size()) {
        const size_t bar = pattern.find('|', start);
        const std::string piece =
            pattern.substr(start, bar == std::string::npos ? std::string::npos : bar - start);
        if (!piece.empty()) needles.push_back(kb::fold_text(piece));
        if (bar == std::string::npos) break;
        start = bar + 1;
      }
    }
    if (needles.empty()) needles.push_back(kb::fold_text(pattern));

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
      if (!e->applicable(scope)) continue;
      if (!matches(*e)) continue;
      results.push_back(e);
      if (results.size() >= max) break;
    }

    const int64_t now = static_cast<int64_t>(now_ms());
    json out = json::array();
    for (const Entry* e : results) {
      Entry& live = entries_[e->id];
      touch(live);
      out.push_back(presented_json(live, false));
    }
    flush_sync(now);

    log(LogLevel::Info, "Match \"" + pattern + "\" => " + std::to_string(out.size()) + " entries");
    req.reply(std::move(out));
  }

  void handle_update(Request& req) {
    if (busy_learning(req, str_or(req.payload(), "id", ""))) return;
    const json& p = req.payload();
    const std::string id = str_or(p, "id", "");
    if (id.empty()) { req.error("CONTRACT_VIOLATION", "id must not be empty"); return; }

    // Accept fields flat or nested under `updates` (both caller shapes exist).
    // A flat field that is null counts as absent, so the nested one applies.
    const json updates = p.contains("updates") && p["updates"].is_object() ? p["updates"] : json::object();
    auto pick = [&](const char* key) -> json {
      if (p.contains(key) && !p[key].is_null()) return p[key];
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
    Entry& e = it->second;
    const std::string old_claim = e.claim_text();
    const auto old_pattern = e.type == "pattern" ? kbpat::read(e.content, e.title) : std::optional<kbpat::Pattern>();
    const int64_t revision = e.type == "pattern"
      ? (old_pattern && old_pattern->learning.is_object() ? int_or(old_pattern->learning, "revision", 1) : 1) : e.updated_at;
    if (p.contains("expectedRevision") && !p["expectedRevision"].is_null() && p["expectedRevision"] != json(revision)) {
      req.reply({{"success", false}, {"conflict", true}, {"revision", revision}, {"error", "Knowledge changed; read it and reconcile before updating"}}); return;
    }
    if (content.is_null() && title.is_null() && tags.is_null()) {
      req.reply({{"success", false},
                 {"error", "No updatable fields provided (expected content, title, and/or tags)"}});
      return;
    }
    if ((!content.is_null() && !content.is_string()) || (!title.is_null() && !title.is_string()) || (!tags.is_null() && !tags.is_array())) {
      req.error("CONTRACT_VIOLATION", "content and title must be strings and tags an array"); return;
    }
    if (content.is_string()) {
      const auto body = e.type == "pattern" ? revise_pattern(title.is_string() ? title.get<std::string>() : e.title, content.get<std::string>(), e.content)
                                            : std::optional<std::string>(content.get<std::string>());
      if (!body) { req.error("CONTRACT_VIOLATION", "Pattern needs Context, Forces, Therefore and Evidence"); return; }
      e.content = *body;
    }
    if (title.is_string()) e.title = clip_utf8(title.get<std::string>(), 200);
    if (tags.is_array()) {
      e.tags.clear();
      for (const auto& t : tags) {
        if (t.is_string()) e.tags.push_back(t.get<std::string>());
      }
    }
    const int64_t now = static_cast<int64_t>(now_ms());
    if (e.claim_text() != old_claim) e.evidence.reset_for_new_claim(now);
    e.updated_at = std::max(now, e.updated_at + 1);
    index_.add(e.id, e.title, index_text(e), e.tags);
    save_entry(e);
    changed("entryUpdated", event_json(e));
    log(LogLevel::Info, "Updated: \"" + e.title + "\"");
    req.reply({{"success", true}});
    maybe_distill(now);
  }

  // ── Query helpers ──────────────────────────────────────────────────────

  /// How much agents lean on an entry: reads, and reviewer-confirmed help
  /// counted double.
  static double reliance(const Entry& e) {
    return 1.0 + static_cast<double>(e.access_count) + 2.0 * static_cast<double>(e.useful_count);
  }

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

  /// Resolve a link name to a pattern entry: an id (bare or 'id:'-prefixed),
  /// a normalized title, or one of the pattern's aliases. A merge records the
  /// absorbed pattern's name as an alias of the survivor, so links written
  /// against the old name keep resolving. Active patterns by default; the
  /// archived ones answer whether a dangling link is broken or unwritten.
  Entry* find_pattern_by_name(const std::string& name, bool archived = false) {
    const std::string raw = kbpat::trim(name);
    const std::string id = raw.rfind("id:", 0) == 0 ? kbpat::trim(raw.substr(3)) : raw;
    auto direct = entries_.find(id);
    if (direct != entries_.end() && direct->second.type == "pattern" && direct->second.archived == archived) return &direct->second;
    const std::string norm = normalize_title(raw);
    if (norm.empty()) return nullptr;
    for (auto& [_, e] : entries_) {
      if (e.type == "pattern" && e.archived == archived && normalize_title(e.title) == norm) return &e;
    }
    for (auto& [_, e] : entries_) {
      if (e.type != "pattern" || e.archived != archived) continue;
      for (const auto& alias : pattern_aliases(e.content, e.title)) if (normalize_title(alias) == norm) return &e;
    }
    return nullptr;
  }

  void touch(Entry& e) {
    e.access_count++;
    e.last_accessed_at = static_cast<int64_t>(now_ms());
    schedule_access_flush();
  }

  // ── Read counters ──────────────────────────────────────────────────────
  //
  // Reads are the commonest operation and change only two counters, so they
  // are written as one small map at most once per ACCESS_FLUSH_MS instead of
  // rewriting each entry read. An entry's own accessCount catches up the
  // next time the entry is saved for a real change, and on load the map wins
  // wherever it is ahead.

  bool access_dirty_ = false;
  bool access_wakeup_armed_ = false;

  void schedule_access_flush() {
    access_dirty_ = true;
    if (access_wakeup_armed_) return;
    access_wakeup_armed_ = true;
    request("@Timer", "setTimeout", {{"delayMs", ACCESS_FLUSH_MS}, {"data", {{"kind", "access"}}}},
            [this](const Result& r) { if (!r.ok) access_wakeup_armed_ = false; });
  }

  void flush_access() {
    access_wakeup_armed_ = false;
    if (!access_dirty_ || !loaded_) return;
    access_dirty_ = false;
    json counters = json::object();
    for (const auto& [id, e] : entries_) {
      if (e.access_count > 0) counters[id] = json::array({e.access_count, e.last_accessed_at});
    }
    request("@Storage", "set", {{"key", ACCESS_KEY}, {"value", std::move(counters)}}, [](const Result&) {});
  }

  void load_access_counters() {
    request("@Storage", "get", {{"key", ACCESS_KEY}}, [this](const Result& r) {
      if (!r.ok || !r.payload.is_object()) return;
      for (const auto& [id, v] : r.payload.items()) {
        auto it = entries_.find(id);
        if (it == entries_.end() || !v.is_array() || v.size() != 2 || !v[0].is_number() || !v[1].is_number()) continue;
        it->second.access_count = std::max(it->second.access_count, v[0].get<int64_t>());
        it->second.last_accessed_at = std::max(it->second.last_accessed_at, v[1].get<int64_t>());
      }
    });
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
    if (pending_learning_.count(e.id)) return;
    request("@Storage", "set",
            {{"key", ENTRY_KEY_PREFIX + e.id}, {"value", e.to_json()}},
            [](const Result&) {});
  }

  void unpersist_entry(const std::string& id) {
    request("@Storage", "delete", {{"key", ENTRY_KEY_PREFIX + id}}, [](const Result&) {});
  }

  /// This peer's id, falling back to the object id before Identity resolves.
  std::string self_peer_id() const {
    return local_peer_id_.empty() ? object_id_ : local_peer_id_;
  }

  /// Entries stamped while self_peer_id() was still the object-id fallback
  /// (a `remember` that raced the Identity reply) carry an id no browser
  /// recognises as ours, so they render as another peer's read-only entries
  /// forever. Once the real peer id is known, re-attribute them and republish.
  /// Runs from both the Identity reply and finish_load, whichever comes last.
  void adopt_self_stamped_entries() {
    if (local_peer_id_.empty() || !loaded_) return;
    bool adopted = false;
    for (auto& [id, e] : entries_) {
      if (e.creator_peer_id != object_id_) continue;
      e.creator_peer_id = local_peer_id_;
      persist_entry(e);
      mark_dirty(id);
      adopted = true;
    }
    if (adopted) request_sync();
  }

  /// Cross-peer sync publishes ONE REGISTER PER ENTRY (`entry:<id>`) rather
  /// than the whole array. The array was the wrong carrier for a single
  /// change: two peers remembering different things concurrently each wrote
  /// the entire set, and the later write silently dropped the other's entry.
  ///
  /// Publishing stays throttled -- the ids that changed accumulate here and
  /// flush together, at most once per SYNC_THROTTLE_MS -- so every existing
  /// request_sync()/flush_sync() call site keeps working unchanged.
  void mark_dirty(const std::string& id) { pending_sync_ids_.insert(id); }

  void tombstone_entry(const std::string& id, int64_t when) {
    tombstones_[id] = when;
    pending_sync_ids_.insert(id);
  }

  void request_sync() {
    sync_pending_ = true;
    flush_sync(static_cast<int64_t>(now_ms()));
  }

  void flush_sync(int64_t now) {
    // A republish scheduled by reconciliation waits for the local load to
    // finish: reconcile and load race, and publishing an empty store would
    // say nothing at all.
    if (needs_republish_ && loaded_) {
      needs_republish_ = false;
      for (const auto& [id, _] : entries_) pending_sync_ids_.insert(id);
      sync_pending_ = true;
    }
    if (!sync_pending_) return;
    if (now - last_sync_ms_ < SYNC_THROTTLE_MS) {
      // Deferred by the throttle: ask the Timer to wake us when it lifts, so
      // the change goes out even if nothing else touches the store.
      if (!sync_wakeup_armed_) {
        sync_wakeup_armed_ = true;
        request("@Timer", "setTimeout",
                {{"delayMs", SYNC_THROTTLE_MS - (now - last_sync_ms_) + 10}, {"data", {{"kind", "sync"}}}},
                [this](const Result& r) { if (!r.ok) sync_wakeup_armed_ = false; });
      }
      return;
    }
    sync_pending_ = false;
    last_sync_ms_ = now;

    std::set<std::string> ids;
    ids.swap(pending_sync_ids_);
    for (const auto& id : ids) {
      auto it = entries_.find(id);
      if (it != entries_.end()) {
        publish_entry_register(it->second);
      } else {
        auto t = tombstones_.find(id);
        publish_tombstone_register(id, t == tombstones_.end() ? now : t->second);
      }
    }
  }

  void set_register(const std::string& key, json value) {
    request("@SharedState", "set",
            {{"name", SYNC_NAMESPACE}, {"key", key},
             {"value", std::move(value)}, {"persist", true}},
            [](const Result&) {});
  }

  /// Publish one entry as its own register, stamping peer provenance the
  /// first time it goes out. An entry with no creator was authored here by
  /// definition: it either predates provenance or was just created locally.
  void publish_entry_register(Entry& e) {
    tombstones_.erase(e.id);
    if (e.creator_peer_id.empty()) {
      e.creator_peer_id = self_peer_id();
      persist_entry(e);
    }
    set_register(std::string(ENTRY_REGISTER_PREFIX) + e.id,
                 {{"entry", e.to_json()},
                  {"updatedAt", e.updated_at},
                  {"peerId", self_peer_id()}});
  }

  /// Publish a deletion as a tombstone register.
  void publish_tombstone_register(const std::string& id, int64_t when) {
    set_register(std::string(ENTRY_REGISTER_PREFIX) + id,
                 {{"deleted", true}, {"updatedAt", when}, {"peerId", self_peer_id()}});
  }

  /// Apply one register received from a peer.
  ///
  /// Last-writer-wins on updatedAt. Peer clocks are not synchronised, so an
  /// equal stamp is broken on peerId: each side compares the remote id
  /// against its own, exactly one comparison holds, and the replicas converge
  /// instead of trading the entry back and forth forever.
  bool apply_remote_entry(const std::string& id, const json& raw) {
    if (id.empty() || !raw.is_object()) return false;
    if (!raw.contains("updatedAt") || !raw["updatedAt"].is_number()) return false;
    const int64_t remote_stamp = raw["updatedAt"].get<int64_t>();
    const std::string remote_peer = str_or(raw, "peerId", "");

    bool have_local_stamp = false;
    int64_t local_stamp = 0;
    if (pending_learning_.count(id)) return false;
    auto local = entries_.find(id);
    // Evidence counters move without touching updatedAt, so last-writer-wins
    // cannot carry them: a peer's counters are folded in whether or not its
    // copy of the entry wins.
    const json* remote_body = raw.contains("entry") && raw["entry"].is_object() ? &raw["entry"] : nullptr;
    if (local != entries_.end() && remote_body && remote_body->contains("evidence") &&
        local->second.evidence.merge(Evidence::from_json((*remote_body)["evidence"]))) {
      persist_entry(local->second);
    }
    if (local != entries_.end() && !local->second.preserves_learning(raw.value("entry",json::object()).value("learning",json()))) return false;
    if (local != entries_.end()) {
      have_local_stamp = true;
      local_stamp = local->second.updated_at;
    } else {
      auto t = tombstones_.find(id);
      if (t != tombstones_.end()) { have_local_stamp = true; local_stamp = t->second; }
    }
    if (have_local_stamp) {
      if (remote_stamp < local_stamp) return false;
      if (remote_stamp == local_stamp && remote_peer <= self_peer_id()) return false;
    }

    if (bool_or(raw, "deleted", false)) {
      tombstones_[id] = remote_stamp;
      if (local == entries_.end()) return false;
      index_.remove(id);
      entries_.erase(local);
      unpersist_entry(id);
      changed("entryRemoved", {{"id", id}});
      return true;
    }

    const json& body = raw.contains("entry") ? raw["entry"] : raw;
    if (!body.is_object()) return false;
    Entry re = Entry::from_json(body);
    if (re.id.empty()) re.id = id;
    if (re.id != id) return false;
    // A peer that predates provenance sends no creator; the publishing peer
    // is the best available attribution.
    if (re.creator_peer_id.empty()) re.creator_peer_id = remote_peer;
    if (local != entries_.end()) re.evidence.merge(local->second.evidence);

    tombstones_.erase(id);
    const bool is_new = !entries_.count(id);
    if (!is_new) index_.remove(id);
    index_.add(re.id, re.title, index_text(re), re.tags);
    entries_[id] = std::move(re);
    persist_entry(entries_[id]);
    changed(is_new ? "entryAdded" : "entryUpdated", event_json(entries_[id]));
    return true;
  }

  /// Reconcile the whole namespace. A peer that was offline missed the
  /// individual stateChanged events, so on init it reads every register and
  /// applies it, then republishes what it holds so peers that only ever saw
  /// the legacy array key learn our entries as individual registers.
  void reconcile_from_snapshot(const json& snapshot) {
    if (!snapshot.is_object()) return;
    int merged = 0;
    const size_t plen = std::string(ENTRY_REGISTER_PREFIX).size();
    for (const auto& [key, value] : snapshot.items()) {
      if (key.rfind(ENTRY_REGISTER_PREFIX, 0) == 0) {
        if (apply_remote_entry(key.substr(plen), value)) merged++;
      } else if (key == "entries" && value.is_array()) {
        merged += merge_legacy_array(value);
      }
    }
    if (merged > 0) {
      log(LogLevel::Info, "Reconciled " + std::to_string(merged) +
                              " knowledge entries from peers, now " +
                              std::to_string(entries_.size()) + " total");
    }
    needs_republish_ = true;
    request_sync();
  }

  /// Legacy whole-array snapshot from a peer that predates per-entry
  /// registers. Accepted on merge (newer wins, tombstones still respected)
  /// but never published.
  int merge_legacy_array(const json& arr) {
    int merged = 0;
    for (const auto& j : arr) {
      if (!j.is_object()) continue;
      Entry re = Entry::from_json(j);
      if (re.id.empty()) continue;
      auto tomb = tombstones_.find(re.id);
      if (tomb != tombstones_.end() && tomb->second >= re.updated_at) continue;
      auto it = entries_.find(re.id);
      if (pending_learning_.count(re.id) || (it != entries_.end() && !it->second.preserves_learning(re.learning))) continue;
      if (it == entries_.end() || re.updated_at > it->second.updated_at) {
        if (it != entries_.end()) re.evidence.merge(it->second.evidence);
        const std::string rid = re.id;
        const bool is_new = it == entries_.end();
        if (!is_new) index_.remove(rid);
        index_.add(re.id, re.title, index_text(re), re.tags);
        entries_[rid] = std::move(re);
        persist_entry(entries_[rid]);
        changed(is_new ? "entryAdded" : "entryUpdated", event_json(entries_[rid]));
        merged++;
      }
    }
    return merged;
  }

  /// Structural save: durable write of the changed entry + throttled sync.
  void save_entry(const Entry& e) {
    persist_entry(e);
    mark_dirty(e.id);
    request_sync();
  }

  // ── Distillation ───────────────────────────────────────────────────────

  void maybe_distill(int64_t now) {
    if (now - last_distill_ms_ >= DISTILL_INTERVAL_MS) distill();
  }

  /// An entry the automated cleanup must never touch: user-authored entries
  /// (origin 'user'), user facts (tagged 'user'/'person'), patterns (they
  /// retire only through explicit curation, never by staleness), and entries
  /// a reviewer has confirmed useful.
  bool is_protected(const Entry& e) const {
    if (e.learning.is_object() || pending_learning_.count(e.id)) return true;
    if (e.origin == "user") return true;
    if (e.type == "pattern") return true;
    for (const auto& t : e.tags) {
      // Facts about the person (the About the User block reads 'profile').
      if (t == "profile") return true;
      if (e.type == "fact" && (t == "user" || t == "person")) return true;
    }
    return e.useful_count > 0;
  }

  /// Archive (not delete): hidden from recall/match, restorable.
  void archive_entry(Entry& e, const char* why) {
    log(LogLevel::Info,
        std::string("Distill: archiving \"") + e.title + "\" (" + why + ")");
    e.archived = true;
    e.updated_at = std::max(static_cast<int64_t>(now_ms()), e.updated_at + 1);
    persist_entry(e);
    mark_dirty(e.id);
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
      // Ages compare in milliseconds: dividing into whole days first moved
      // every threshold one day later than it says.
      const int64_t age_ms = now - e.created_at;
      const int64_t idle_ms = e.last_accessed_at > 0 ? now - e.last_accessed_at : age_ms;

      // Archive 'learned' entries never surfaced after 7 days
      if (e.type == "learned" && e.access_count == 0 && age_ms > STALE_NEVER_ACCESSED_DAYS * DAY_MS) {
        archive_entry(e, "never accessed in 7d");
        archived_count++;
        continue;
      }
      // Archive 'learned' or 'reference' entries inactive for 30 days
      if ((e.type == "learned" || e.type == "reference") &&
          idle_ms > STALE_INACTIVE_DAYS * DAY_MS) {
        archive_entry(e, "inactive 30d");
        archived_count++;
      }
    }

    // Cap the ACTIVE store by archiving the least useful entries first
    // (usefulCount, then flagged evidence, then accessCount). Protected
    // entries are exempt. An entry whose tests mostly missed goes before an
    // equally useful one however often it was read: reads alone do not keep
    // a belief that keeps failing.
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
        if (a->useful_count != b->useful_count) return a->useful_count < b->useful_count;
        if (a->evidence.flagged() != b->evidence.flagged()) return a->evidence.flagged();
        return a->access_count < b->access_count;
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
      if (e.archived && e.origin != "user" && !e.learning.is_object() && !pending_learning_.count(e.id)) archived.push_back(&e);
    }
    std::sort(archived.begin(), archived.end(), [](const Entry* a, const Entry* b) {
      return a->updated_at < b->updated_at;
    });
    std::vector<std::string> purge_ids;
    for (const Entry* e : archived) {
      const bool over_cap = archived.size() - purge_ids.size() > MAX_ARCHIVED;
      if (now - e->updated_at > ARCHIVED_PURGE_DAYS * DAY_MS || over_cap) purge_ids.push_back(e->id);
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
