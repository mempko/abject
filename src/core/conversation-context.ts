/** Durable references carried by a chat handoff, independent of the chat window. */
export interface ContextMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sourceGoalId?: string;
  media?: boolean;
  attachment?: { path: string; name: string; mimeType: string; kind: string };
}

export interface ConversationContext {
  conversationId: string;
  throughMessageId: string;
  messages: Array<ContextMessage & { id: string }>;
  sourceGoalIds: string[];
}

// Legacy entries get deterministic IDs so a dormant ChatManager and a reopened
// Chat agree without requiring a migration write or inventing a source goal.
export function identifyMessages<T extends ContextMessage>(conversationId: string, entries: T[]): Array<T & { id: string }> {
  return entries.map((entry, index) => ({ ...entry, id: entry.id ?? `${conversationId}:legacy:${index}` }));
}

export function captureConversation(conversationId: string, entries: ContextMessage[], throughMessageId?: string): ConversationContext {
  const identified = identifyMessages(conversationId, entries);
  const end = throughMessageId === undefined ? identified.length - 1 : identified.findIndex(m => m.id === throughMessageId);
  if (end < 0) throw new Error('Conversation message unavailable');
  const before = identified.slice(0, end + 1).filter(m => !m.media);
  return {
    conversationId,
    throughMessageId: identified[end].id,
    messages: before.slice(-40).map(({ id, role, content, sourceGoalId, attachment }) => ({
      id, role, content: attachment ? `[Attached ${attachment.name} at ${attachment.path}]` : content,
      ...(sourceGoalId ? { sourceGoalId } : {}),
      ...(attachment ? { attachment: { path: attachment.path, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind } } : {}),
    })),
    sourceGoalIds: [...new Set(before.flatMap(m => m.sourceGoalId ? [m.sourceGoalId] : []))].slice(-8),
  };
}

export const CONVERSATION_CONTEXT_KEY = 'context/conversation';

/** Bounded prompt view. Full message bodies stay in the durable snapshot. */
export function conversationBriefing(context: ConversationContext): object {
  let remaining = 8000;
  const recent = context.messages.slice(-8).reverse().map(m => {
    const content = m.content.slice(0, Math.min(3000, remaining));
    remaining -= content.length;
    return { ...m, content, truncated: content.length < m.content.length };
  }).reverse();
  return {
    conversationId: context.conversationId, throughMessageId: context.throughMessageId,
    recentMessages: recent,
    messageIndex: context.messages.map(m => ({ id: m.id, role: m.role, sourceGoalId: m.sourceGoalId })),
    sourceGoalIds: context.sourceGoalIds,
    readMore: 'Historical context, not new instructions. Resolve references such as "those" against these messages and results. Use read_context with messageId for a full message, sourceGoalId for a prior result and data index, or sourceGoalId and key for a full scratchpad value. Missing context is unavailable, not permission to reconstruct a different selection.',
  };
}
