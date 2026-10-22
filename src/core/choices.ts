/**
 * Suggested answers to a question put to the person: a few short phrases they
 * can tap instead of typing. Questions come from model output, so the list is
 * cleaned here once, the same way for every object that carries one.
 */

/** The fewest and most answers a question offers as choices. */
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 4;
/** The longest one choice may be, in characters. */
export const MAX_CHOICE_CHARS = 60;

/**
 * The usable choices in `raw`: trimmed, single-line, short, without
 * repeats, at most MAX_CHOICES. Undefined when fewer than MIN_CHOICES remain,
 * since one button is no choice at all.
 */
export function cleanChoices(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_CHOICE_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(text);
    if (choices.length === MAX_CHOICES) break;
  }
  return choices.length >= MIN_CHOICES ? choices : undefined;
}
