// bm25.hpp - inverted index with field-weighted BM25 ranking and snippets.
//
// Replaces SQLite FTS5 for the C++ KnowledgeBase: title/content/tags fields
// with 10/1/5 weights (matching the TS version's bm25(entries_fts,10,1,5)),
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
// Word characters: ASCII alphanumerics, '_', and any non-ASCII byte (UTF-8
// continuation-safe: multi-byte sequences stay inside one token). ASCII is
// lowercased; non-ASCII is matched byte-exact.

inline bool is_word_byte(unsigned char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '_' || c >= 0x80;
}

inline std::string to_lower_ascii(const std::string& s) {
  std::string out = s;
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

struct Token {
  std::string text;  // lowercased
  size_t begin = 0;  // byte offsets into the original string
  size_t end = 0;
};

inline std::vector<Token> tokenize_with_offsets(const std::string& text) {
  std::vector<Token> tokens;
  const size_t n = text.size();
  size_t i = 0;
  while (i < n) {
    while (i < n && !is_word_byte(static_cast<unsigned char>(text[i]))) i++;
    if (i >= n) break;
    const size_t begin = i;
    while (i < n && is_word_byte(static_cast<unsigned char>(text[i]))) i++;
    tokens.push_back({to_lower_ascii(text.substr(begin, i - begin)), begin, i});
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
