// Pattern bodies: the C++ half of the structured pattern format.
//
// Mirrors src/core/pattern.ts. Patterns are STORED AS JSON and RENDERED for
// people. Storing prose and recovering sections by matching headings was
// tried first and it lost: patterns arrived written three different ways
// ('## Context', 'Context:', '**Context:**'), the matcher understood one of
// them, and every update rebuilt the entry out of the sections it had failed
// to find.
//
// parse_legacy() survives only to carry pre-format entries across once, at
// load. Nothing at steady state parses prose.
#pragma once

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include <abject/abject.hpp>

namespace kbpat {

using abject::json;

/// Marks a stored body as structured. Bumped only if the shape changes.
inline constexpr int kFormat = 1;

/// One section this vocabulary does not name, carried through verbatim.
struct Note {
  std::string heading;
  std::string body;
};

/// A pattern, in full. context/forces/therefore/evidence are what make an
/// entry a pattern rather than a tip; the rest sharpen it.
struct Pattern {
  std::string name;
  std::string aliases;
  std::string context;
  std::string problem;
  std::string forces;
  std::string therefore;
  std::string contract;
  std::string program;
  std::string resulting_context;
  std::string consequences;
  std::string evidence;
  std::string applies_to;
  std::vector<std::string> links;
  std::vector<Note> notes;

  bool complete() const {
    return !name.empty() && !context.empty() && !forces.empty() && !therefore.empty() &&
           !evidence.empty();
  }

  json to_json() const {
    json j = {{"format", kFormat}, {"name", name}, {"context", context},
              {"forces", forces}, {"therefore", therefore}, {"evidence", evidence},
              {"links", links}};
    const auto put = [&j](const char* key, const std::string& value) {
      if (!value.empty()) j[key] = value;
    };
    put("aliases", aliases);
    put("problem", problem);
    put("contract", contract);
    put("program", program);
    put("resultingContext", resulting_context);
    put("consequences", consequences);
    put("appliesTo", applies_to);
    if (!notes.empty()) {
      json arr = json::array();
      for (const Note& n : notes) arr.push_back({{"heading", n.heading}, {"body", n.body}});
      j["notes"] = arr;
    }
    return j;
  }

  /// The pattern as people read it: a markdown document, sections in order.
  /// Nothing parses this back, so it is free to be shaped for reading.
  std::string render() const {
    std::string out = "# " + name;
    const auto section = [&out](const char* heading, const std::string& body) {
      if (!body.empty()) out += "\n\n## " + std::string(heading) + "\n" + body;
    };
    section("Aliases", aliases);
    section("Context", context);
    section("Problem", problem);
    section("Forces", forces);
    section("Therefore", therefore);
    section("Contract", contract);
    section("Program", program);
    section("Resulting context", resulting_context);
    section("Consequences", consequences);
    section("Evidence", evidence);
    section("Applies-to", applies_to);
    for (const Note& n : notes) section(n.heading.c_str(), n.body);
    if (!links.empty()) {
      out += "\n\n## Links";
      for (const std::string& l : links) out += "\n-> " + l;
    }
    return out;
  }

  /// Everything worth searching, without the JSON punctuation.
  std::string search_text() const {
    std::string out = name;
    for (const std::string* s : {&aliases, &context, &problem, &forces, &therefore, &contract,
                                 &program, &resulting_context, &consequences, &evidence,
                                 &applies_to}) {
      if (!s->empty()) out += "\n" + *s;
    }
    for (const Note& n : notes) out += "\n" + n.heading + "\n" + n.body;
    for (const std::string& l : links) out += "\n" + l;
    return out;
  }
};

// ── Small string helpers (no regex: this file exists to stop guessing) ────

inline std::string trim(const std::string& s) {
  const size_t b = s.find_first_not_of(" \t\r\n");
  if (b == std::string::npos) return {};
  const size_t e = s.find_last_not_of(" \t\r\n");
  return s.substr(b, e - b + 1);
}

inline std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

inline std::string upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  return s;
}

inline std::string str_field(const json& j, const char* key) {
  return (j.contains(key) && j[key].is_string()) ? trim(j[key].get<std::string>()) : std::string();
}

/// Link names, de-duplicated case-insensitively, order preserved.
inline std::vector<std::string> normalize_links(const std::vector<std::string>& raw) {
  std::vector<std::string> out;
  for (const std::string& r : raw) {
    std::string name;
    for (size_t i = 0; i < r.size(); i++) {
      if (r[i] == '-' && i + 1 < r.size() && r[i + 1] == '>') { i++; continue; }
      name += r[i];
    }
    name = trim(name);
    if (name.empty()) continue;
    const std::string key = lower(name);
    bool seen = false;
    for (const std::string& e : out) {
      if (lower(e) == key) { seen = true; break; }
    }
    if (!seen) out.push_back(name);
  }
  return out;
}

/// Parse the JSON form. Returns nothing if this is not a structured body.
/// JSON_NOEXCEPTION is on, so parsing must never be allowed to throw.
inline std::optional<Pattern> read_structured(const std::string& content) {
  const std::string trimmed = trim(content);
  if (trimmed.empty() || trimmed[0] != '{') return std::nullopt;
  const json j = json::parse(trimmed, nullptr, /*allow_exceptions=*/false);
  if (j.is_discarded() || !j.is_object()) return std::nullopt;
  if (!j.contains("format") || !j["format"].is_number()) return std::nullopt;

  Pattern p;
  p.name = upper(str_field(j, "name"));
  p.aliases = str_field(j, "aliases");
  p.context = str_field(j, "context");
  p.problem = str_field(j, "problem");
  p.forces = str_field(j, "forces");
  p.therefore = str_field(j, "therefore");
  p.contract = str_field(j, "contract");
  p.program = str_field(j, "program");
  p.resulting_context = str_field(j, "resultingContext");
  p.consequences = str_field(j, "consequences");
  p.evidence = str_field(j, "evidence");
  p.applies_to = str_field(j, "appliesTo");

  std::vector<std::string> raw_links;
  if (j.contains("links") && j["links"].is_array()) {
    for (const json& l : j["links"]) {
      if (l.is_string()) raw_links.push_back(l.get<std::string>());
    }
  }
  p.links = normalize_links(raw_links);

  if (j.contains("notes") && j["notes"].is_array()) {
    for (const json& n : j["notes"]) {
      if (!n.is_object()) continue;
      Note note{str_field(n, "heading"), str_field(n, "body")};
      if (!note.heading.empty() && !note.body.empty()) p.notes.push_back(note);
    }
  }
  return p.complete() ? std::optional<Pattern>(p) : std::nullopt;
}

/// Stands in for a section a pre-format pattern never recorded.
inline const char* kUnrecorded = "(not recorded before this pattern was structured)";

/// True when a pattern has been flattened: the old update path rebuilt
/// entries out of the sections it had recognized, so one written in a shape
/// it could not read came back with nothing but its Evidence line.
inline bool is_flattened(const Pattern& p) {
  const std::string marker = kUnrecorded;
  return p.context == marker && p.forces == marker && p.therefore == marker;
}

inline bool is_structured(const std::string& content) {
  return read_structured(content).has_value();
}

// ── One-time conversion of pre-structure patterns ────────────────────────

/// A labelled section recovered from legacy prose.
struct RawSection {
  std::string heading;
  std::string body;
};

/// Headings the old corpus used, mapped to the field they became.
/// Everything here is matched whole and case-insensitively; there is no
/// pattern matching beyond string equality.
inline const std::string* legacy_field(const std::string& heading_lower) {
  static const std::vector<std::pair<std::string, std::string>> kMap = {
      {"aliases", "aliases"},
      {"also known as", "aliases"},
      {"context", "context"},
      {"problem", "problem"},
      {"forces", "forces"},
      {"therefore", "therefore"},
      {"solution", "therefore"},
      {"contract", "contract"},
      {"program", "program"},
      {"resulting context", "resultingContext"},
      {"consequences", "consequences"},
      {"consequences / caveats", "consequences"},
      {"caveats", "consequences"},
      {"evidence", "evidence"},
      {"known uses", "evidence"},
      {"applies-to", "appliesTo"},
      {"applies to", "appliesTo"},
      {"links", "links"},
  };
  for (const auto& [heading, field] : kMap) {
    if (heading == heading_lower) return &field;
  }
  return nullptr;
}

/// Split legacy prose into a preamble and its labelled sections. Recognizes
/// markdown headings, bold labels, and bare 'Heading:' lines, because the
/// corpus was written by many agents over months and uses all three.
inline void split_legacy(const std::string& content, std::string& preamble,
                         std::vector<RawSection>& sections) {
  std::vector<std::string> preamble_lines;
  RawSection current;
  bool open = false;
  std::vector<std::string> body_lines;

  const auto flush = [&]() {
    if (!open) return;
    std::string body;
    for (size_t i = 0; i < body_lines.size(); i++) {
      if (i) body += "\n";
      body += body_lines[i];
    }
    current.body = trim(body);
    sections.push_back(current);
    body_lines.clear();
  };

  size_t pos = 0;
  while (pos <= content.size()) {
    const size_t eol = content.find('\n', pos);
    const std::string line =
        content.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);

    std::string heading;
    std::string rest;
    bool is_heading = false;

    const size_t first = line.find_first_not_of(" \t");
    if (first != std::string::npos && line[first] == '#') {
      size_t hashes = 0;
      while (first + hashes < line.size() && line[first + hashes] == '#') hashes++;
      const std::string after = trim(line.substr(first + hashes));
      if (!after.empty() && hashes <= 6) {
        // A level-1 heading before any section is the pattern's own name.
        if (hashes == 1 && !open && legacy_field(lower(after)) == nullptr) {
          preamble_lines.push_back(line);
          pos = (eol == std::string::npos) ? content.size() + 1 : eol + 1;
          continue;
        }
        heading = after;
        is_heading = true;
      }
    }

    if (!is_heading) {
      // '**Aliases:** text' and 'Context: text'. Both are accepted only when
      // the label is one this vocabulary knows, so ordinary prose containing
      // a colon is never mistaken for a section break.
      std::string candidate = line;
      const size_t b = candidate.find_first_not_of(" \t");
      if (b != std::string::npos) candidate = candidate.substr(b);
      bool bold = candidate.rfind("**", 0) == 0;
      if (bold) candidate = candidate.substr(2);
      const size_t colon = candidate.find(':');
      if (colon != std::string::npos && colon <= 40) {
        std::string label = candidate.substr(0, colon);
        if (bold) {
          const size_t close = label.find("**");
          if (close != std::string::npos) label = label.substr(0, close);
        }
        label = trim(label);
        if (!label.empty() && legacy_field(lower(label)) != nullptr) {
          heading = label;
          std::string tail = candidate.substr(colon + 1);
          const size_t close = tail.find("**");
          if (bold && close != std::string::npos) tail = tail.substr(close + 2);
          rest = trim(tail);
          is_heading = true;
        }
      }
    }

    if (is_heading) {
      flush();
      current = RawSection{trim(heading), std::string()};
      if (!current.heading.empty() && current.heading.back() == ':') {
        current.heading.pop_back();
      }
      open = true;
      if (!rest.empty()) body_lines.push_back(rest);
    } else if (open) {
      body_lines.push_back(line);
    } else {
      preamble_lines.push_back(line);
    }

    if (eol == std::string::npos) break;
    pos = eol + 1;
  }
  flush();

  std::string pre;
  for (size_t i = 0; i < preamble_lines.size(); i++) {
    if (i) pre += "\n";
    pre += preamble_lines[i];
  }
  preamble = trim(pre);
}

/// Recover a pattern from the prose it used to be stored as. Anything that
/// cannot be placed is kept as a note; dropping is the failure this whole
/// format exists to end.
inline std::optional<Pattern> parse_legacy(const std::string& content, const std::string& title) {
  std::string preamble;
  std::vector<RawSection> sections;
  split_legacy(content, preamble, sections);

  Pattern p;
  std::vector<std::string> raw_links;
  std::vector<std::string> provenance;

  const auto field_ref = [&p](const std::string& field) -> std::string* {
    if (field == "aliases") return &p.aliases;
    if (field == "context") return &p.context;
    if (field == "problem") return &p.problem;
    if (field == "forces") return &p.forces;
    if (field == "therefore") return &p.therefore;
    if (field == "contract") return &p.contract;
    if (field == "program") return &p.program;
    if (field == "resultingContext") return &p.resulting_context;
    if (field == "consequences") return &p.consequences;
    if (field == "evidence") return &p.evidence;
    if (field == "appliesTo") return &p.applies_to;
    return nullptr;
  };

  for (const RawSection& s : sections) {
    const std::string key = lower(s.heading);
    const std::string* field = legacy_field(key);
    if (field != nullptr && *field == "links") {
      // Comma-separated or one '-> NAME' per line; both occur in the corpus.
      std::string piece;
      for (char c : s.body + "\n") {
        if (c == ',' || c == '\n') {
          if (!trim(piece).empty()) raw_links.push_back(trim(piece));
          piece.clear();
        } else {
          piece += c;
        }
      }
      continue;
    }
    if (field != nullptr) {
      if (s.body.empty()) continue;
      std::string* target = field_ref(*field);
      if (target == nullptr) continue;
      if (target->empty()) {
        *target = s.body;
      } else {
        // A second Context/Evidence block (merges produced these): append
        // rather than let the later one win or vanish.
        *target += "\n\n" + s.body;
      }
      continue;
    }
    if (!s.body.empty()) {
      p.notes.push_back(Note{s.heading, s.body});
    } else {
      // A heading with nothing under it carries its meaning in the heading.
      provenance.push_back(s.heading);
    }
  }

  if (!provenance.empty()) {
    std::string body;
    for (size_t i = 0; i < provenance.size(); i++) {
      if (i) body += "\n";
      body += provenance[i];
    }
    p.notes.push_back(Note{"Provenance", body});
  }

  p.links = normalize_links(raw_links);
  p.name = upper(trim(title));
  if (p.name.empty()) return std::nullopt;

  // Legacy entries predate the requirement that a pattern state all four
  // essentials. Converting is not the moment to lose one, so anything
  // missing gets a marker the reviewer can see and repair.
  if (p.context.empty()) p.context = kUnrecorded;
  if (p.forces.empty()) p.forces = kUnrecorded;
  if (p.therefore.empty()) p.therefore = kUnrecorded;
  if (p.evidence.empty()) p.evidence = "unproven (predates evidence tracking)";

  return p.complete() ? std::optional<Pattern>(p) : std::nullopt;
}

/// Read a stored body from whatever era it comes from.
inline std::optional<Pattern> read(const std::string& content, const std::string& title) {
  if (auto structured = read_structured(content)) return structured;
  return parse_legacy(content, title);
}

}  // namespace kbpat
