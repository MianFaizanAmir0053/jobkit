import type { Share } from "./pendingUploads";
import { keepsUpload, type Submitted } from "./submit";

/**
 * What New job does as it opens (intake spec, "Inputs" and "Upload path",
 * step 3). A share the service worker kept is taken out of the store, so it
 * starts one job at most, and its ID leaves the address, so a reload or Back
 * takes nothing again. An upload kept from before is finished first, as the
 * page promised. Then the share goes into the form and starts with no tap,
 * or waits for the owner's tap on Start when the page cannot tell the owner
 * sent it, or when an upload came first, since the share may be the same
 * post shared again. A share held for the tap goes back into the store,
 * marked so, and shows again when the owner comes back. At the spend cap a
 * share goes with no trace, since the page says why. The browser's pieces
 * come in as deps, so this is tested without a browser.
 */

export const OPENING = {
  starting: "Starting the job…",
  shareGone: "The shared screenshots are gone. Share them again, or use Choose screenshots.",
  fromAnotherSite: "This share may have come from another site. Check it, then press Start.",
  openedBefore:
    "This share was opened before, so it waits for your tap. Check it, then press Start.",
  afterUpload:
    "An upload from before came first, so this share waits for your tap. If it is the same post, clear it.",
  elsewhere:
    "Another tab is finishing an upload from before, so this share waits for your tap. If it is the same post, clear it.",
  startFailed: "This share's start did not finish. Check it, then press Start.",
  takenElsewhere: "This share was started in another tab. Look for it in the Jobs list.",
  uploadedBefore: "The job started before is uploaded: find it in the Jobs list.",
} as const;

export interface OpeningDeps {
  /** The share ID in the address as the page opens. */
  shareId: () => string | null;
  dropShareId: () => void;
  /** How the browser reached the page: "navigate", "reload", "back_forward", or "" when it cannot say. */
  navigation: () => string;
  takeShare: (id: string) => Promise<Share | null>;
  /** Keeps a share in the store, marked as waiting for the tap, and why. */
  holdShare: (share: Share, reason: string) => Promise<void>;
  /** The share waiting for the tap in the store, if any. */
  heldShare: () => Promise<Share | null>;
  sweepShares: () => Promise<void>;
  /** Finishes an upload kept from before; "elsewhere" when another tab is, null when none waits. */
  /** Finishes an upload kept from before: that job's alone, when one is named. */
  finishKept: (
    onStatus: (status: string) => void,
    jobId?: string,
  ) => Promise<Submitted | "elsewhere" | null>;
  start: (share: Share, onStatus: (status: string) => void) => Promise<Submitted>;
}

/** What the form shows as the page opens. */
export interface OpeningUi {
  /** A step the form waits on, which keeps Start from being offered. */
  status: (status: string) => void;
  /**
   * Puts a share's screenshots, text and link into the form: shown when it
   * waits for the tap, and stored when the store holds it for later.
   */
  hold: (share: Share, how: { shown: boolean; stored: boolean }) => void;
}

export type Opened =
  | { kind: "nothing" }
  /** An upload kept from before, finished or not, with no share: its job opens. */
  | { kind: "finished"; outcome: Submitted }
  | { kind: "started"; outcome: Submitted }
  /** A share in the form, waiting for the tap, after any upload kept from before. */
  | { kind: "held"; reason: string; before: Submitted | null }
  | { kind: "gone"; before: Submitted | null };

export async function openPage(
  deps: OpeningDeps,
  page: {
    autoStart: boolean;
    capped: boolean;
    /**
     * The job whose screenshots the page uploads again: it finishes that
     * job's kept upload alone, and takes no share, held or in the address.
     */
    againOf?: string;
  },
  ui: OpeningUi,
): Promise<Opened> {
  void deps.sweepShares().catch(() => undefined);
  const id = page.againOf ? null : deps.shareId();
  let share: Share | null = null;
  if (id) {
    share = await deps.takeShare(id).catch(() => null);
    deps.dropShareId();
  }
  const before = await deps.finishKept(ui.status, page.againOf);
  const finished = before === "elsewhere" ? null : before;
  if (page.capped) return finished ? { kind: "finished", outcome: finished } : { kind: "nothing" };
  if (!id) {
    // A share waiting for the tap stays for New job; this page uploads one job's screenshots again.
    const held = page.againOf ? null : await deps.heldShare().catch(() => null);
    if (held?.held) {
      ui.hold(held, { shown: true, stored: true });
      return { kind: "held", reason: held.held, before: finished };
    }
    return finished ? { kind: "finished", outcome: finished } : { kind: "nothing" };
  }
  if (!share) return { kind: "gone", before: finished };
  const reason = heldFor(share, before, page.autoStart, deps.navigation());
  if (reason) {
    const stored = await deps.holdShare(share, reason).then(
      () => true,
      () => false,
    );
    ui.hold(share, { shown: true, stored });
    return { kind: "held", reason, before: finished };
  }
  // Busy before the form fills, so Start is never offered for a share that is starting.
  ui.status(OPENING.starting);
  ui.hold(share, { shown: false, stored: false });
  const outcome = await deps.start(share, ui.status);
  // A start that failed leaves the share for Start, kept should the owner leave; one whose
  // upload is kept for New job to finish leaves nothing to start again.
  if (!outcome.ok && !keepsUpload(outcome)) {
    await deps.holdShare(share, OPENING.startFailed).catch(() => undefined);
  }
  return { kind: "started", outcome };
}

/**
 * Why a share waits for the tap, or null to start it: a share starts
 * untapped only when the page's request says the owner or jobkit's own page
 * sent it, on its first opening as the worker counts them and as the
 * browser reached the page (a reload that skips the worker is not counted),
 * and with no upload from before, here or in another tab, which may be the
 * same post. Another site comes first, since its share is no repeat of the
 * owner's.
 */
function heldFor(
  share: Share,
  before: Submitted | "elsewhere" | null,
  autoStart: boolean,
  navigation: string,
): string | null {
  if (!autoStart) return OPENING.fromAnotherSite;
  if (before === "elsewhere") return OPENING.elsewhere;
  if (before) return OPENING.afterUpload;
  if (share.openings !== 1 || navigation !== "navigate") return OPENING.openedBefore;
  return null;
}
