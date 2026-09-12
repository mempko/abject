/**
 * Delta between two input values, expressed as the keystrokes the backend
 * already understands: N Backspace presses followed by inserted text.
 *
 * The mobile keyboard proxy receives edits it cannot intercept (IME
 * composition updates and autocorrect substitutions are not cancelable),
 * so text delivery diffs the proxy's value against the value already
 * forwarded and sends only the difference.
 */
export interface InputDelta {
  /** Characters removed after the common prefix — send this many Backspaces. */
  backspaces: number;
  /** Text inserted after the common prefix. */
  inserted: string;
}

/**
 * Compute the keystroke delta that turns `prev` into `cur`.
 *
 * Common-prefix diffing: everything before the first differing position is
 * shared, the rest of `prev` was deleted, the rest of `cur` was typed.
 * This handles both plain appends (normal typing) and in-place replacement
 * (autocorrect swapping a word, composition candidates shrinking), and
 * never sends more Backspaces than the previous value had characters.
 */
export function computeInputDelta(prev: string, cur: string): InputDelta {
  let i = 0;
  const min = Math.min(prev.length, cur.length);
  while (i < min && prev[i] === cur[i]) i++;
  return { backspaces: prev.length - i, inserted: cur.slice(i) };
}
