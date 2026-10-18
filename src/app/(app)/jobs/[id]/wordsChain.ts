/**
 * The email's words after each decision this page made (review spec, "The
 * outbound gate"). A decision names the words the page showed, and the
 * server refuses one made on others; until the page is drawn again with the
 * words its own decision left, the next one names those instead, so the
 * owner's second tap is not refused for a change they made themselves, while
 * a change from anywhere else still is. Once the page is drawn again, or a
 * decision is refused, the chain is spent: words that come back later, as
 * after an Undo on the other device, are the page's own again, never the
 * ones a decision once left.
 */
const after = new Map<string, Map<string, string>>();

/** The words the page's own decisions left, from the words it shows. */
export function wordsAfter(jobId: string, words: string): string {
  const chain = after.get(jobId);
  let current = words;
  const seen = new Set<string>();
  while (chain?.has(current) && !seen.has(current)) {
    seen.add(current);
    current = chain.get(current)!;
  }
  return current;
}

/** A decision from this page took the email from these words to those. */
export function decided(jobId: string, from: string, to: string): void {
  const chain = after.get(jobId) ?? new Map<string, string>();
  if (from === to) chain.delete(from);
  else chain.set(from, to);
  after.set(jobId, chain);
}

/**
 * The page was drawn with new words, or a decision was refused and it will
 * be: what its decisions left is what it shows now, or no longer counts.
 */
export function forget(jobId: string): void {
  after.delete(jobId);
}
