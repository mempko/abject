/**
 * Word-wrap utilities for multi-line text rendering.
 */

/**
 * Wrap text to fit within maxWidth, using measureFn for precise measurement.
 * Splits on word boundaries first, falls back to character-level breaking
 * for words wider than maxWidth. Returns an array of wrapped lines.
 */
export async function wrapText(
  text: string,
  maxWidth: number,
  measureFn: (text: string) => Promise<number>,
): Promise<string[]> {
  if (maxWidth <= 0) return [text];

  const hardLines = text.split('\n');
  const result: string[] = [];

  for (const hardLine of hardLines) {
    if (hardLine === '') {
      result.push('');
      continue;
    }

    const words = hardLine.split(/(\s+)/);
    let currentLine = '';

    for (const word of words) {
      if (word === '') continue;

      const candidate = currentLine + word;
      const candidateWidth = await measureFn(candidate);

      if (candidateWidth <= maxWidth) {
        currentLine = candidate;
      } else if (currentLine === '') {
        // Single word wider than maxWidth — break at character level
        const chars = Array.from(word);
        let charLine = '';
        for (const ch of chars) {
          const charCandidate = charLine + ch;
          const charWidth = await measureFn(charCandidate);
          if (charWidth > maxWidth && charLine !== '') {
            result.push(charLine);
            charLine = ch;
          } else {
            charLine = charCandidate;
          }
        }
        currentLine = charLine;
      } else {
        // Push current line and start new one with this word
        result.push(currentLine);
        // If the word starts with whitespace, trim leading whitespace for the new line
        const trimmedWord = word.trimStart();
        if (trimmedWord === '') {
          currentLine = '';
        } else {
          // Check if the trimmed word itself fits
          const trimmedWidth = await measureFn(trimmedWord);
          if (trimmedWidth > maxWidth) {
            // Character-level break
            const chars = Array.from(trimmedWord);
            let charLine = '';
            for (const ch of chars) {
              const charCandidate = charLine + ch;
              const charWidth = await measureFn(charCandidate);
              if (charWidth > maxWidth && charLine !== '') {
                result.push(charLine);
                charLine = ch;
              } else {
                charLine = charCandidate;
              }
            }
            currentLine = charLine;
          } else {
            currentLine = trimmedWord;
          }
        }
      }
    }

    result.push(currentLine);
  }

  return result;
}

/**
 * Sync heuristic to estimate the number of wrapped lines.
 * Uses fontSize * 0.55 as average character width.
 * Handles existing \n in text.
 */
export function estimateWrappedLineCount(
  text: string,
  maxWidthPx: number,
  fontSize: number,
): number {
  if (maxWidthPx <= 0 || !text) return 1;

  const avgCharWidth = fontSize * 0.55;
  const charsPerLine = Math.max(1, Math.floor(maxWidthPx / avgCharWidth));

  const hardLines = text.split('\n');
  let totalLines = 0;

  for (const line of hardLines) {
    if (line.length === 0) {
      totalLines += 1;
    } else {
      totalLines += Math.ceil(line.length / charsPerLine);
    }
  }

  return totalLines;
}
