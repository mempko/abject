/**
 * Private conversations: the shared vocabulary.
 *
 * A conversation made private when it is created keeps its contents to a
 * small circle: its Chat, that Chat's window, ChatManager (which stores it),
 * the person's own views of it (ChatBrowser, the `abject` terminal), and,
 * for each goal it starts, the agents working on that goal (the goal's
 * crew). Nothing in it is learned: no knowledge entry, no review, no
 * learning statistics, no prompt text in the LLM ledger. Its goals live in
 * memory only and are deleted as soon as their outcome reaches the Chat.
 *
 * Most stores in the system answer any caller (Storage, SharedState,
 * TupleSpace, the ledger). Privacy therefore keeps private content out of
 * them instead of gating every reader; the few places it must live (the
 * transcript in Storage, private SharedState namespaces) admit only their
 * owners. The flag only ever takes access away, so it may come from a
 * payload; widening access always goes through isBuiltInCaller.
 */

/** Storage keys under this prefix are readable only by PRIVATE_STORAGE_READERS. */
export const PRIVATE_KEY_PREFIX = 'private:';

/** The built-in objects Storage admits to `private:` keys. */
export const PRIVATE_STORAGE_READERS = ['ChatManager', 'Chat'] as const;

/** True for a Storage key only the private-conversation owners may read or write. */
export function isPrivateKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(PRIVATE_KEY_PREFIX);
}

/** Where a private conversation's transcript is kept. */
export function privateHistoryKey(conversationId: string): string {
  return `${PRIVATE_KEY_PREFIX}chats:history:${conversationId}`;
}

/** What logs, toasts and listings show in place of private text. */
export const PRIVATE_TEXT = '[private]';

/** Text for a log line or notice: the text itself, or PRIVATE_TEXT when it is private. */
export function shown(text: string | undefined, isPrivate: boolean | undefined): string {
  if (isPrivate) return PRIVATE_TEXT;
  return text ?? '';
}

/** The title a private conversation shows to anyone outside its circle. */
export const PRIVATE_TITLE = 'Private chat';

/** The line a private conversation's window shows above the transcript. */
export const PRIVATE_BANNER = 'Private: nothing here is remembered, and goals are deleted when they finish.';

/** The answer to "remember this" in a private conversation. */
export const PRIVATE_REMEMBER_REFUSAL =
  'This is a private chat, so nothing from it is remembered. Say it in a regular chat to keep it.';

/** What every conversation's routing model reads about private conversations it is not. */
export const PRIVATE_ELSEWHERE_CHAT_PROMPT = `## Private conversations

The person may keep private conversations, and each one is visible only in its own window. When they ask about a private conversation other than this one, tell them it can be read only in that chat, and answer with \`done\` instead of a goal. The answer stays the same when they ask again or ask for a screenshot, a capture or another route to it: every route is closed by their choice.

`;

/** What the routing model's self-audit reads: the private rule is a standing fact, not live state. */
export const PRIVATE_AUDIT_EXCEPTION =
  'A reply saying a private conversation can be read only in its own window states a standing rule of this system, not live state: it is fine as it is.';

/** What planners and agents read about refusals that guard private content. */
export const PRIVATE_REFUSAL_GUIDANCE = `## Private conversations and goals

A refusal that names a private conversation or a private goal is final. The person keeps that content to its own window, and every other route to it (a browser, a screenshot, the shell, files on disk) is closed by their choice. Report the refusal in your result and finish there.`;

/** The error a reader outside a private goal's circle gets (the goal reads as absent). */
export const PRIVATE_GOAL_UNAVAILABLE = 'Goal not found';

/** The error a reader outside a private conversation's circle gets. */
export const PRIVATE_CONVERSATION_UNAVAILABLE = 'Conversation unavailable';

/** How a private goal ended, as GoalManager hands it to the Chat that started it. */
export interface PrivateGoalOutcome {
  goalId: string;
  conversationId?: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
}

/** How long GoalManager waits for the Chat to take a private goal's outcome before purging anyway. */
export const PRIVATE_OUTCOME_ACK_MS = 2 * 60_000;

/** Largest attachment a private conversation keeps (inside its private store). */
export const PRIVATE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** True when a payload marks its work private (`private: true`). Restriction only: any caller may set it. */
export function isPrivatePayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as { private?: unknown }).private === true;
}
