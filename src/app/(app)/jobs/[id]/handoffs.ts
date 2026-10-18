/**
 * The handoffs this page posted that have not landed yet: Mark sent waits
 * for them, so it never records the words handed off before the latest one
 * (review spec, "The outbound gate").
 */
const pending = new Set<Promise<unknown>>();

/** A handoff posted, until it lands, refused or not. */
export function inFlight(handoff: Promise<unknown>): void {
  const settled = handoff.catch(() => undefined).finally(() => pending.delete(settled));
  pending.add(settled);
}

/** Once every handoff posted so far has landed. */
export async function handoffsLanded(): Promise<void> {
  await Promise.allSettled([...pending]);
}
