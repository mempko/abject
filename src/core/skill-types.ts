/**
 * Shared type definitions for the Skill system.
 *
 * Skills are SKILL.md files (YAML frontmatter + markdown instructions) installed
 * in ~/.abject/skills/. They are compatible with Claude Code and OpenClaw formats.
 */

/** Information about a discovered skill. */
export interface SkillInfo {
  name: string;
  description: string;
  version?: string;
  source: 'claude-code' | 'openclaw' | 'unknown';
  enabled: boolean;
  error?: string;
  /** Claude Code allowed-tools field (e.g. ["Read", "Grep", "Bash"]). */
  allowedTools?: string[];
  /** OpenClaw required binaries. */
  requiredBins?: string[];
  /** OpenClaw required environment variables. */
  requiredEnv?: string[];
  /** User-configured environment variable values (keys only, values masked). */
  configuredEnvKeys?: string[];
}

/** Per-skill configuration stored by SkillRegistry. */
export interface SkillConfig {
  env: Record<string, string>;
}

/** Summary of an enabled skill, used for prompt injection. */
export interface EnabledSkillSummary {
  name: string;
  description: string;
  /** Full markdown body from SKILL.md. */
  instructions: string;
  /** Claude Code allowed-tools (for context). */
  allowedTools?: string[];
  /** Merged environment variables from skill config (for runtime injection). */
  env?: Record<string, string>;
}
