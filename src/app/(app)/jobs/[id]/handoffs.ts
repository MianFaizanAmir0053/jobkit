import { useSyncExternalStore } from "react";

/**
 * The handoffs this page posted, for each job (review spec, "The outbound
 * gate"): those not landed yet, which Mark sent waits for, so it never
 * records the words handed off before the latest one; and the parts whose
 * last handoff jobkit could not record, which Mark sent says before it asks
 * whether anything changed.
 */

/** The parts of the email a handoff gives the owner. */
export type HandedOffPart = "address" | "subject" | "body";

/** How long a handoff may take before it counts as not recorded, and Mark sent waits no longer. */
export const HANDOFF_MS = 10_000;

const pending = new Map<string, Set<Promise<void>>>();
const NONE: ReadonlySet<HandedOffPart> = new Set();
let unrecorded: ReadonlyMap<string, ReadonlySet<HandedOffPart>> = new Map();
const listeners = new Set<() => void>();

function recorded(jobId: string, parts: readonly HandedOffPart[], ok: boolean): void {
  const now = new Set(unrecorded.get(jobId) ?? NONE);
  for (const part of parts) {
    if (ok) now.delete(part);
    else now.add(part);
  }
  unrecorded = new Map(unrecorded).set(jobId, now);
  for (const listener of listeners) listener();
}

/** A handoff of these parts posted for the job, until it lands: whether jobkit recorded it. */
export function inFlight(
  jobId: string,
  parts: readonly HandedOffPart[],
  handoff: Promise<boolean>,
): void {
  const forJob = pending.get(jobId) ?? new Set<Promise<void>>();
  pending.set(jobId, forJob);
  const settled: Promise<void> = handoff
    .catch(() => false)
    .then((ok) => recorded(jobId, parts, ok))
    .finally(() => forJob.delete(settled));
  forJob.add(settled);
}

/**
 * Once every handoff posted for the job so far has landed, or HANDOFF_MS
 * has passed: whether they all landed in time.
 */
export async function handoffsLanded(jobId: string): Promise<boolean> {
  const all = Promise.allSettled([...(pending.get(jobId) ?? [])]).then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), HANDOFF_MS);
  });
  try {
    return await Promise.race([all, late]);
  } finally {
    clearTimeout(timer);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The parts of the job's email whose last handoff jobkit could not record, as they change. */
export function useUnrecorded(jobId: string): ReadonlySet<HandedOffPart> {
  return useSyncExternalStore(
    subscribe,
    () => unrecorded.get(jobId) ?? NONE,
    () => NONE,
  );
}
