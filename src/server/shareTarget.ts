/**
 * The share target's switch (intake spec, "Share-target switch"). Turning
 * the share target off in the manifest reaches an installed app only when
 * Chrome next updates it, so the switch lives here: the service worker asks
 * `GET /api/share-target` (caching the answer for an hour at most) and
 * refuses every share while it is off. The phone's test sets it once
 * (docs/runbook/spikes.md): on when the screenshots arrive, off when Chrome
 * delivers nothing, and the upload button carries the flow. The test server
 * can set it for the end-to-end tests.
 */
export const SHARE_TARGET_ON = true;

const shared = globalThis as typeof globalThis & { jobkitShareTarget?: boolean };

export function shareTargetOn(): boolean {
  return shared.jobkitShareTarget ?? SHARE_TARGET_ON;
}

/** For the test server's route alone; undefined goes back to the switch. */
export function setShareTargetForTests(on: boolean | undefined): void {
  shared.jobkitShareTarget = on;
}
