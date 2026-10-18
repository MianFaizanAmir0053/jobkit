/**
 * The email's words after each decision this page made (review spec, "The
 * outbound gate"). A decision names the words the page showed, and the
 * server refuses one made on others; until the page is drawn again with the
 * words its own decision left, the next one names those instead, so the
 * owner's second tap is not refused for a change they made themselves, while
 * a change from anywhere else still is. Drawn again, the page keeps only
 * what its decisions left from the words it now shows, as when quick taps
 * outrun the drawing, and refused, it keeps nothing: words that come back
 * later, as after an Undo on the other device, are the page's own again,
 * never the ones a decision once left.
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

/** A decision was refused, and the page will be drawn again: what its decisions left no longer counts. */
export function forget(jobId: string): void {
  after.delete(jobId);
}

/**
 * The page was drawn with these words: what its decisions left from them
 * still counts, as a tap made before this drawing named them; the rest is
 * spent.
 */
export function drawnWith(jobId: string, words: string): void {
  const chain = after.get(jobId);
  if (!chain) return;
  const kept = new Map<string, string>();
  for (let current = words; chain.has(current) && !kept.has(current);) {
    const next = chain.get(current)!;
    kept.set(current, next);
    current = next;
  }
  if (kept.size === 0) after.delete(jobId);
  else after.set(jobId, kept);
}
