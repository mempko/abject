/**
 * Helpers for rendering MCP tool definitions as human-readable prompts.
 *
 * Both SkillAgent and MCPBridge surface MCP tools in their ask-protocol
 * responses; this module keeps the rendering consistent so every caller
 * sees tools described the same way.
 */

/**
 * Lax shape used by both the MCPBridge (fully-typed MCPToolDefinition) and
 * skill-registry summaries (where inputSchema can be unknown). Keeping the
 * formatter permissive means both callers use the same helper without a
 * cast at every site.
 */
export interface FormattableMCPTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Render an MCP tool's JSON Schema (the `inputSchema` field) as a compact,
 * human-readable parameter list. Callers pass the exact parameter names
 * back to the tool, so the formatting preserves case.
 *
 * Returns null when the schema lacks properties — callers omit the line.
 */
export function formatMCPInputSchema(schema: Record<string, unknown> | undefined): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== 'object') return null;

  const required = new Set<string>(
    Array.isArray((schema as { required?: unknown[] }).required)
      ? ((schema as { required: unknown[] }).required as string[])
      : [],
  );

  const entries = Object.entries(props);
  if (entries.length === 0) return null;

  return entries.map(([name, rawDef]) => {
    const def = (rawDef ?? {}) as { type?: string | string[]; enum?: unknown[]; description?: string };
    const type = Array.isArray(def.type) ? def.type.join('|') : (def.type ?? 'any');
    const enumPart = Array.isArray(def.enum) && def.enum.length > 0
      ? ` = ${def.enum.map(v => JSON.stringify(v)).join('|')}`
      : '';
    const req = required.has(name) ? '' : '?';
    const desc = def.description ? ` — ${def.description}` : '';
    return `${name}${req}: ${type}${enumPart}${desc}`;
  }).join('; ');
}

/**
 * Render a single tool as a multi-line block:
 *
 *   - `tool_name`: Description.
 *     Parameters: arg1: type — description; arg2?: type = "a"|"b" — ...
 *
 * The leading dash keeps things flat inside a "Tools:" section; consumers
 * that want a richer layout can call formatMCPInputSchema directly.
 */
export function formatMCPTool(tool: FormattableMCPTool): string {
  const desc = tool.description ? `: ${tool.description}` : '';
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema as Record<string, unknown>
    : undefined;
  const params = formatMCPInputSchema(schema);
  const paramLine = params ? `\n  Parameters: ${params}` : '';
  return `- \`${tool.name}\`${desc}${paramLine}`;
}

/**
 * Render an entire tool list as a single block. Returns an empty string
 * when the list is empty so callers can safely concatenate it.
 */
export function formatMCPToolList(tools: ReadonlyArray<FormattableMCPTool>): string {
  if (tools.length === 0) return '';
  return tools.map(formatMCPTool).join('\n');
}
