/**
 * A response body made of recorded chunks, for the adapter tests, delivered
 * one chunk per read. After the last chunk it ends; or fails with `failWith`,
 * as a dropped connection does; or, given `openUntil`, stays open until that
 * signal aborts and then fails the way fetch does.
 */
export function recordedBody(
  chunks: readonly string[],
  ending: { failWith?: Error; openUntil?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream({
    start(controller) {
      const { openUntil } = ending;
      if (!openUntil) return;
      const abort = () =>
        controller.error(new DOMException("This operation was aborted", "AbortError"));
      if (openUntil.aborted) return abort();
      openUntil.addEventListener("abort", abort, { once: true });
    },
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk !== undefined) return controller.enqueue(encoder.encode(chunk));
      if (ending.failWith) return controller.error(ending.failWith);
      // An open body just stops sending; the reader waits until the signal aborts.
      if (!ending.openUntil) controller.close();
    },
  });
}
