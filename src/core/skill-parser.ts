/**
 * SKILL.md parser -- handles Claude Code and OpenClaw YAML frontmatter formats.
 *
 * Both ecosystems use YAML frontmatter between `---` markers followed by a
 * markdown body containing instructions for the LLM.
 */

import { parse as parseYaml } from 'yaml';

/** Result of parsing a SKILL.md file. */
export interface ParsedSkill {
  /** All YAML frontmatter fields (preserved as-is). */
  frontmatter: Record<string, unknown>;
  /** Skill name (from frontmatter or directory name fallback). */
  name: string;
  /** Skill description. */
  description: string;
  /** Markdown body after the second `---`. */
  instructions: string;
  /** Detected source ecosystem. */
  source: 'claude-code' | 'openclaw' | 'unknown';
  /** Parsed from Claude Code's `allowed-tools` field. */
  allowedTools?: string[];
  /** Parsed from OpenClaw's `metadata.openclaw.requires.bins`. */
  requiredBins?: string[];
  /** Parsed from OpenClaw's `metadata.openclaw.requires.env`. */
  requiredEnv?: string[];
  /** Version string if present. */
  version?: string;
}

/**
 * Parse a SKILL.md file into structured data.
 *
 * @param content  Raw file contents of SKILL.md
 * @param dirName  Directory name (used as fallback for skill name)
 */
export function parseSkillMd(content: string, dirName: string): ParsedSkill {
  const { frontmatter, body } = extractFrontmatter(content);

  const name = typeof frontmatter.name === 'string' ? frontmatter.name : dirName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const version = typeof frontmatter.version === 'string' ? frontmatter.version : undefined;
  const source = detectSource(frontmatter);

  const result: ParsedSkill = {
    frontmatter,
    name,
    description,
    instructions: body.trim(),
    source,
    version,
  };

  // Parse Claude Code allowed-tools (can be comma-separated string or YAML list)
  const allowedToolsRaw = frontmatter['allowed-tools'];
  if (typeof allowedToolsRaw === 'string') {
    result.allowedTools = allowedToolsRaw.split(',').map(t => t.trim()).filter(Boolean);
  } else if (Array.isArray(allowedToolsRaw)) {
    result.allowedTools = allowedToolsRaw.filter((t): t is string => typeof t === 'string');
  }

  // Parse env var requirements from metadata
  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === 'object') {
    const m = metadata as Record<string, unknown>;

    // OpenClaw: metadata.openclaw.requires.env (array of strings)
    const ocMetadata = m.openclaw;
    if (ocMetadata && typeof ocMetadata === 'object') {
      const oc = ocMetadata as Record<string, unknown>;
      const requires = oc.requires;
      if (requires && typeof requires === 'object') {
        const req = requires as Record<string, unknown>;
        if (Array.isArray(req.bins)) {
          result.requiredBins = req.bins.filter((b): b is string => typeof b === 'string');
        }
        if (Array.isArray(req.env)) {
          result.requiredEnv = req.env.filter((e): e is string => typeof e === 'string');
        }
      }
    }

    // Direct: metadata.env (object with env var names as keys)
    // e.g. metadata.env.THETAEDGE_API_KEY: { required: true, description: "..." }
    const envObj = m.env;
    if (envObj && typeof envObj === 'object' && !Array.isArray(envObj)) {
      const envNames = Object.keys(envObj as Record<string, unknown>);
      if (envNames.length > 0) {
        const existing = new Set(result.requiredEnv ?? []);
        for (const name of envNames) existing.add(name);
        result.requiredEnv = [...existing];
      }
    }
  }

  return result;
}

/**
 * Detect which ecosystem a skill comes from based on frontmatter fields.
 */
function detectSource(fm: Record<string, unknown>): 'claude-code' | 'openclaw' | 'unknown' {
  // OpenClaw: has metadata.openclaw
  if (fm.metadata && typeof fm.metadata === 'object') {
    const m = fm.metadata as Record<string, unknown>;
    if ('openclaw' in m) return 'openclaw';
  }

  // Claude Code: has any of these fields
  if ('allowed-tools' in fm || 'user-invocable' in fm || 'disable-model-invocation' in fm
      || 'argument-hint' in fm || 'context' in fm || 'agent' in fm) {
    return 'claude-code';
  }

  return 'unknown';
}

/**
 * Extract YAML frontmatter and markdown body from a SKILL.md file.
 */
function extractFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    // No frontmatter -- entire file is the body
    return { frontmatter: {}, body: content };
  }

  // Find the closing ---
  const afterFirst = trimmed.slice(3);
  const closingIdx = afterFirst.indexOf('\n---');
  if (closingIdx === -1) {
    // No closing --- found, treat everything as frontmatter with empty body
    const yamlStr = afterFirst.trim();
    const parsed = safeParseYaml(yamlStr);
    return { frontmatter: parsed, body: '' };
  }

  const yamlStr = afterFirst.slice(0, closingIdx).trim();
  // Body starts after the closing --- line
  const afterClosing = afterFirst.slice(closingIdx + 4); // skip \n---
  const bodyStart = afterClosing.indexOf('\n');
  const body = bodyStart === -1 ? '' : afterClosing.slice(bodyStart + 1);

  const parsed = safeParseYaml(yamlStr);
  return { frontmatter: parsed, body };
}

/**
 * Safely parse YAML, returning an empty object on failure.
 */
function safeParseYaml(yamlStr: string): Record<string, unknown> {
  try {
    const result = parseYaml(yamlStr);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
