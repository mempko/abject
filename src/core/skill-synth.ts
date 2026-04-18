/**
 * Small helpers shared by CatalogBrowser and SkillAgent for turning a
 * registry search result into a local SKILL.md ready for SkillRegistry.install.
 */

/**
 * Registry record we care about. Covers both the current MCP registry
 * schema (`registryType` + `identifier`, per the 2025-12-11 schema) and
 * earlier drafts (`registry_name` + `name`). A stale cache from an older
 * client build can still be read without crashing.
 */
export interface McpPackageRef {
  registryType?: string;
  identifier?: string;
  version?: string;
  /** Legacy fields from earlier registry drafts. */
  registry_name?: string;
  name?: string;
}

/**
 * Resolve a registry package reference to a local command + args pair
 * suitable for `mcp-command` / `mcp-args` in a SKILL.md file.
 * Returns an empty command when the registry is unsupported.
 */
export function packageToMcpCommand(pkg: McpPackageRef | undefined): { command: string; args: string[] } {
  if (!pkg) return { command: '', args: [] };
  const registry = pkg.registryType ?? pkg.registry_name ?? '';
  const ident = pkg.identifier ?? pkg.name;
  if (!ident) return { command: '', args: [] };
  const spec = pkg.version ? `${ident}@${pkg.version}` : ident;
  switch (registry) {
    case 'npm':
      return { command: 'npx', args: ['-y', spec] };
    case 'pypi':
      return { command: 'uvx', args: [spec] };
    case 'docker':
    case 'oci':
      return { command: 'docker', args: ['run', '--rm', '-i', spec] };
    default:
      return { command: '', args: [] };
  }
}

/** Normalise a remote server name into a safe skill directory name. */
export function sanitiseSkillName(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'skill';
}

/** Build a SKILL.md file body that wraps an MCP server install. */
export function buildMcpSkillMd(opts: {
  name: string;
  description: string;
  mcpCommand: string;
  mcpArgs: string[];
}): string {
  const frontmatter = [
    '---',
    `name: ${opts.name}`,
    `description: ${JSON.stringify(opts.description)}`,
    `mcp-command: ${opts.mcpCommand}`,
    `mcp-args: ${JSON.stringify(opts.mcpArgs)}`,
    '---',
  ].join('\n');
  const body = `# ${opts.name}\n\nInstalled from the MCP registry. Configure any required environment variables via the skill's config.\n`;
  return `${frontmatter}\n\n${body}`;
}
