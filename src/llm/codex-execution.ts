import { ABJECT_EXECUTION_CONTEXT, NATIVE_PROVIDER_CONTEXT } from './execution-context.js';

/** Configured for the structured CLI transport; never weaken these on retry. */
export function codexExecutionArgs(): string[] {
  const disabled = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'enable_mcp_apps',
    'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'multi_agent_v2',
    'code_mode', 'code_mode_host', 'js_repl', 'plugins', 'hooks', 'skill_mcp_dependency_install'];
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'default_permissions="abject-generation"',
    '-c', 'permissions.abject-generation.filesystem={":minimal"="read",":workspace_roots"="read"}',
    '-c', 'permissions.abject-generation.network.enabled=false',
    '-c', 'mcp_servers={}',
    '-c', `developer_instructions=${JSON.stringify(`${ABJECT_EXECUTION_CONTEXT}\n\n${NATIVE_PROVIDER_CONTEXT}`)}`,
    ...disabled.flatMap(feature => ['--disable', feature])];
}

/** Stop at the first native execution event; never parse it as an Abject action. */
export function checkCodexEvent(line: string): void {
  let event: any;
  try { event = JSON.parse(line); } catch { return; }
  const kind = event.item?.type;
  if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'tool_call', 'function_call', 'computer_call', 'image_generation'].includes(kind)
      || typeof kind === 'string' && kind.endsWith('_tool_call')) {
    throw new Error(`PROVIDER_BOUNDARY: Codex attempted native ${kind}. Abject actions must travel through the message bus. No Abject permission denial was observed.`);
  }
}
