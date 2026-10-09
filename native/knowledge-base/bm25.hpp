// bm25.hpp - inverted index with field-weighted BM25 ranking and snippets.
//
// Replaces SQLite FTS5 for the C++ KnowledgeBase: title/content/tags fields
// with 10/1/5 weights (the weights FTS5's bm25(entries_fts,10,1,5) was tuned to),
// OR semantics across query terms, and FTS5-style [bracketed] snippets.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace kb {

// ── Tokenization ─────────────────────────────────────────────────────────
// Text is read as UTF-8 code points. Word characters are ASCII letters and
// digits and any non-ASCII code point that is not punctuation or a space, so
// letters in every script stay inside their word. Typographic punctuation
// (curly quotes, dashes, ellipsis, no-break space) and '_' separate words,
// which keeps "User's" and "User’s", or "foo_bar" and "foo bar", the same
// words. Case is folded for Latin, Greek and Cyrillic; other scripts match
// as written. Offsets stay byte offsets into the original string.

/// Decode one code point at byte i; `len` receives its byte length. A
/// malformed sequence reads as one U+FFFD byte, which still counts as a word
/// character, so bad input degrades to matching by bytes.
inline uint32_t decode_utf8(const std::string& s, size_t i, size_t& len) {
  const auto b = [&](size_t k) { return static_cast<unsigned char>(s[k]); };
  const unsigned char c = b(i);
  len = 1;
  if (c < 0x80) return c;
  size_t need = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
  if (need == 0 || i + need >= s.size()) return 0xFFFD;
  uint32_t cp = c & (0x3F >> need);
  for (size_t k = 1; k <= need; k++) {
    if ((b(i + k) & 0xC0) != 0x80) return 0xFFFD;
    cp = (cp << 6) | (b(i + k) & 0x3F);
  }
  len = need + 1;
  return cp;
}

inline void append_utf8(std::string& out, uint32_t cp) {
  if (cp < 0x80) { out += static_cast<char>(cp); return; }
  if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); return; }
  if (cp < 0x10000) {
    out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F)); return;
  }
  out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
  out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F));
}

/// Non-ASCII code points that separate words rather than belong to them.
inline bool is_separator_cp(uint32_t cp) {
  if (cp >= 0xA0 && cp <= 0xBF) return cp != 0xAA && cp != 0xB2 && cp != 0xB3 && cp != 0xB5 && cp != 0xB9 && cp != 0xBA;
  if (cp == 0xD7 || cp == 0xF7) return true;            // multiplication and division signs
  if (cp >= 0x2000 && cp <= 0x206F) return true;        // General Punctuation: spaces, dashes, quotes, ellipsis
  if (cp >= 0x3000 && cp <= 0x303F) return true;        // CJK symbols and punctuation
  return cp == 0xFEFF || cp == 0xFF0C || cp == 0xFF0E;  // BOM, fullwidth comma and full stop
}

inline bool is_word_cp(uint32_t cp) {
  if (cp < 0x80) return (cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') || (cp >= '0' && cp <= '9');
  return !is_separator_cp(cp);
}

/// Simple case folding for the cased scripts agents write in most.
inline uint32_t fold_case(uint32_t cp) {
  if (cp >= 'A' && cp <= 'Z') return cp + 32;
  if (cp < 0xC0) return cp;
  if (cp <= 0xDE) return cp == 0xD7 ? cp : cp + 32;                          // Latin-1
  if (cp == 0x130) return 'i';
  if (cp == 0x178) return 0xFF;
  if ((cp >= 0x100 && cp <= 0x137) || (cp >= 0x14A && cp <= 0x177)) return cp % 2 == 0 ? cp + 1 : cp;
  if ((cp >= 0x139 && cp <= 0x148) || (cp >= 0x179 && cp <= 0x17E)) return cp % 2 == 1 ? cp + 1 : cp;
  if (cp >= 0x391 && cp <= 0x3AB && cp != 0x3A2) return cp + 32;              // Greek
  if (cp >= 0x410 && cp <= 0x42F) return cp + 32;                             // Cyrillic
  if (cp >= 0x400 && cp <= 0x40F) return cp + 80;
  return cp;
}

/// The text with every code point case-folded: the key literal matching uses.
inline std::string fold_text(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    size_t len = 1;
    const uint32_t cp = decode_utf8(s, i, len);
    if (cp == 0xFFFD && len == 1) out += s[i];
    else append_utf8(out, fold_case(cp));
    i += len;
  }
  return out;
}

inline std::string to_lower_ascii(const std::string& s) {
  std::string out = s;
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

struct Token {
  std::string text;  // case-folded
  size_t begin = 0;  // byte offsets into the original string
  size_t end = 0;
};

inline std::vector<Token> tokenize_with_offsets(const std::string& text) {
  std::vector<Token> tokens;
  const size_t n = text.size();
  size_t i = 0;
  while (i < n) {
    size_t len = 1;
    uint32_t cp = decode_utf8(text, i, len);
    if (!is_word_cp(cp)) { i += len; continue; }
    Token t;
    t.begin = i;
    while (i < n) {
      cp = decode_utf8(text, i, len);
      if (!is_word_cp(cp)) break;
      if (cp == 0xFFFD && len == 1) t.text += text[i];
      else append_utf8(t.text, fold_case(cp));
      i += len;
    }
    t.end = i;
    tokens.push_back(std::move(t));
  }
  return tokens;
}

inline std::vector<std::string> tokenize(const std::string& text) {
  std::vector<std::string> out;
  for (auto& t : tokenize_with_offsets(text)) out.push_back(std::move(t.text));
  return out;
}

// ── The index ────────────────────────────────────────────────────────────

class Bm25Index {
 public:
  static constexpr double W_TITLE = 10.0;
  static constexpr double W_CONTENT = 1.0;
  static constexpr double W_TAGS = 5.0;
  static constexpr double K1 = 1.2;
  static constexpr double B = 0.75;
  static constexpr size_t MAX_QUERY_TERMS = 24;

  void add(const std::string& id, const std::string& title,
           const std::string& content, const std::vector<std::string>& tags) {
    remove(id);

    std::unordered_map<std::string, double> tf;
    double weighted_len = 0;

    auto accumulate = [&](const std::string& text, double weight) {
      for (auto& term : tokenize(text)) {
        tf[term] += weight;
        weighted_len += weight;
      }
    };
    accumulate(title, W_TITLE);
    accumulate(content, W_CONTENT);
    for (const auto& tag : tags) accumulate(tag, W_TAGS);

    Doc doc;
    doc.weighted_len = weighted_len;
    doc.terms.reserve(tf.size());
    for (auto& [term, freq] : tf) {
      postings_[term][id] = freq;
      doc.terms.push_back(term);
    }
    total_len_ += weighted_len;
    docs_[id] = std::move(doc);
  }

  void remove(const std::string& id) {
    auto it = docs_.find(id);
    if (it == docs_.end()) return;
    for (const auto& term : it->second.terms) {
      auto pit = postings_.find(term);
      if (pit == postings_.end()) continue;
      pit->second.erase(id);
      if (pit->second.empty()) postings_.erase(pit);
    }
    total_len_ -= it->second.weighted_len;
    docs_.erase(it);
  }

  struct Hit {
    std::string id;
    double score;
  };

  /// OR semantics: any query term contributes; higher score is better.
  std::vector<Hit> search(const std::string& query, size_t limit) const {
    std::vector<std::string> terms = tokenize(query);
    if (terms.size() > MAX_QUERY_TERMS) terms.resize(MAX_QUERY_TERMS);
    if (terms.empty() || docs_.empty()) return {};

    const double n_docs = static_cast<double>(docs_.size());
    const double avg_len = total_len_ / n_docs;

    std::unordered_map<std::string, double> scores;
    std::unordered_set<std::string> seen_terms;  // dedupe repeated query terms
    for (const auto& term : terms) {
      if (!seen_terms.insert(term).second) continue;
      auto pit = postings_.find(term);
      if (pit == postings_.end()) continue;

      const double df = static_cast<double>(pit->second.size());
      const double idf = std::log(1.0 + (n_docs - df + 0.5) / (df + 0.5));

      for (const auto& [id, tf] : pit->second) {
        const double len = docs_.at(id).weighted_len;
        const double denom = tf + K1 * (1.0 - B + B * (avg_len > 0 ? len / avg_len : 1.0));
        scores[id] += idf * (tf * (K1 + 1.0)) / denom;
      }
    }

    std::vector<Hit> hits;
    hits.reserve(scores.size());
    for (auto& [id, score] : scores) hits.push_back({id, score});
    std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) {
      return a.score != b.score ? a.score > b.score : a.id < b.id;
    });
    if (hits.size() > limit) hits.resize(limit);
    return hits;
  }

  size_t size() const { return docs_.size(); }

 private:
  struct Doc {
    double weighted_len = 0;
    std::vector<std::string> terms;
  };
  std::unordered_map<std::string, Doc> docs_;
  std::unordered_map<std::string, std::unordered_map<std::string, double>> postings_;
  double total_len_ = 0;
};

// ── Snippets ─────────────────────────────────────────────────────────────
// FTS5-style: a ~12-token window around the first matching term, matched
// terms wrapped in [brackets], '…' where the window clips the text.

inline std::string make_snippet(const std::string& content,
                                const std::vector<std::string>& query_terms,
                                size_t window_tokens = 12) {
  std::unordered_set<std::string> wanted(query_terms.begin(), query_terms.end());
  const std::vector<Token> tokens = tokenize_with_offsets(content);
  if (tokens.empty()) return content.substr(0, 160);

  size_t first_match = tokens.size();
  for (size_t i = 0; i < tokens.size(); i++) {
    if (wanted.count(tokens[i].text)) {
      first_match = i;
      break;
    }
  }
  if (first_match == tokens.size()) {
    // No content match (the hit was on title/tags) — lead of the content.
    return content.substr(0, 160);
  }

  const size_t start = first_match >= 2 ? first_match - 2 : 0;
  const size_t end = std::min(start + window_tokens, tokens.size());

  std::string out;
  if (start > 0) out += "…";
  for (size_t i = start; i < end; i++) {
    if (i > start) {
      // Preserve the original bytes between consecutive tokens.
      out += content.substr(tokens[i - 1].end, tokens[i].begin - tokens[i - 1].end);
    }
    const std::string original = content.substr(tokens[i].begin, tokens[i].end - tokens[i].begin);
    if (wanted.count(tokens[i].text)) {
      out += "[" + original + "]";
    } else {
      out += original;
    }
  }
  if (end < tokens.size()) out += "…";
  return out;
}

}  // namespace kb
