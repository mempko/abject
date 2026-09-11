import type { LLMMessage, LLMProvider } from './provider.js';

export const EXECUTION_CONTEXT_VERSION = 'abject-bus-v1';
export interface ProviderExecution {
  transport: string;
  nativeAccess: 'none' | 'restricted' | 'available';
}
export interface ExecutionProvenance extends Omit<ProviderExecution, 'nativeAccess'> {
  provider: string;
  model: string;
  contextVersion: string;
  /**
   * `denied` is a per-request fact, not a provider property: the provider
   * reported that the model reached for a native tool and was refused, so
   * the reply (usually empty) is the model abandoning the turn.
   */
  nativeAccess: ProviderExecution['nativeAccess'] | 'denied';
  /** Native tools the provider refused on this request, when it said. */
  deniedActions?: string[];
  /** Which provider prompt guidance was applied, so abandonment can be measured per wording. */
  promptGuidanceVersion?: string;
}

/**
 * Prompt text a provider asks to ride on every request routed to it.
 *
 * Providers differ in what their models believe about their surroundings: a
 * CLI-hosted model sees a tool catalog it cannot use here, an API model sees
 * nothing of the kind. The prefix joins the system context; the suffix is
 * the last thing before the model answers, which is where a long prompt's
 * recency lies. Both are versioned, because wording changes behavior in
 * ways only the ledger can show.
 */
export interface PromptGuidance {
  version: string;
  prefix?: string;
  suffix?: string;
}

export const ABJECT_EXECUTION_CONTEXT = `You are reasoning inside Abject. When actions are requested, express the next action using the caller's Abject response protocol; the runtime sends messages to the responsible Abjects through the bus. Use Ask to understand how another Abject can help. File access, shell execution and other external effects belong to capability-owning Abjects. Base claims about permissions and completed operations on their responses. A worker explanation without supporting evidence is a hypothesis. Follow the requested response format.`;

export const NATIVE_PROVIDER_CONTEXT = `Your provider's filesystem, sandbox and approval settings apply to the provider process. Abject capabilities have their own permissions. A provider-side restriction does not establish that an Abject operation is unavailable. Express an Abject action to request the operation, or Ask its owner about access. Do not invoke provider-native file, shell, browser, app or MCP capabilities; request external effects through Abject messages. Return the requested answer or action as the final response.`;

export function executionProvenance(provider: LLMProvider, model: string): ExecutionProvenance {
  const guidance = provider.promptGuidance?.();
  return { provider: provider.name, model, contextVersion: EXECUTION_CONTEXT_VERSION,
    ...(provider.executionContext?.() ?? { transport: 'api', nativeAccess: 'none' }),
    ...(guidance ? { promptGuidanceVersion: guidance.version } : {}) };
}

/**
 * The messages as the provider will see them: the shared execution context
 * first, the provider's own prefix with it, and the provider's suffix at the
 * very end. The caller's messages are never mutated; a suffix joins a copy
 * of the last user message rather than adding a second user turn, which some
 * APIs refuse.
 */
export function withExecutionContext(messages: LLMMessage[], execution: Pick<ExecutionProvenance, 'nativeAccess'>, guidance?: PromptGuidance): LLMMessage[] {
  const system = [
    ABJECT_EXECUTION_CONTEXT,
    execution.nativeAccess === 'none' ? '' : NATIVE_PROVIDER_CONTEXT,
    guidance?.prefix ?? '',
  ].filter(Boolean).join('\n\n');
  const out: LLMMessage[] = [{ role: 'system', content: system }, ...messages];
  const suffix = guidance?.suffix?.trim();
  if (suffix) {
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
      out[out.length - 1] = typeof last.content === 'string'
        ? { ...last, content: `${last.content}\n\n${suffix}` }
        : { ...last, content: [...last.content, { type: 'text', text: `\n\n${suffix}` }] };
    } else {
      out.push({ role: 'user', content: suffix });
    }
  }
  return out;
}
