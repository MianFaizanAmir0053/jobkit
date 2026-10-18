import type { KitBlock } from "@/core/drafting/kit";
import { NEVER_WEIGHED } from "@/core/drafting/verdict";
import { chosenRole } from "@/core/extraction/owner";
import { sameAddress } from "@/core/ledger/normalise";
import { changeStatus, setAddress, undoStatus } from "@/core/ledger/statuses";
import { loadJob } from "@/core/platform/jobs";
import type { Clock, Db } from "@/core/ports";
import { isUuid } from "@/lib/uuid";

import { applicationIdOf, kitRouteOf, openForJob } from "./applications";
import { keep, lockedKit, type ReviewOutcome } from "./kitReview";
import { FACTUAL_CLASSES } from "./edits";
import { type Handoff, type HandoffPart, NO_DECISIONS } from "./decisions";
import { type JobView, jobView, storedDecisions } from "./jobView";

/**
 * "Mark sent" on a ready email kit (review spec, "Handoffs"; ledger spec,
 * "Statuses" and "Factual edits"): in one transaction, under the kit's
 * review row's lock, so a decision made at the same moment waits and then
 * finds the kit sent. Only a kit the gate released is marked sent: one it
 * holds could not have gone from the page. The chosen role's application,
 * opened at the role pick or, for a job from before that, here, keeps the
 * address the email went to, the owner's typed one when the kit needed it.
 * It is marked kit_ready and sent, each with its audit row, and the kit's
 * outcome is recorded with the owner's answer to "Did you change anything
 * in Gmail?", so none of it is kept without the rest; an address the owner
 * typed in place of the one jobkit read is an edit of the address, and a
 * factual edit (ledger spec, "Factual edits"). The gate kept with the
 * decisions then says the kit is sent. The page names the kit and the
 * address it showed: a Mark sent from a page drawn on another, as in a tab
 * the owner has not looked at since typing the address again elsewhere, is
 * refused, so the ledger never keeps an address the email did not go to.
 * Only a role whose route is email is marked sent; a second tap changes
 * nothing. Before real use there is no timing arm. An email jobkit sent
 * from the owner's Gmail (decisions A20) is marked sent the same way, with
 * nothing changed in Gmail, and cannot be taken back: it went.
 */

export type MarkSent =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "not-email" | "held" | "refused" | "changed";
    };

/** The kit and the address the page showed as the owner sent it. */
export interface SentFrom {
  kit?: string;
  to?: string;
}

/** Locks a job's review row, made first if need be, so decisions and Mark sent take turns. */
export async function lockReview(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
  await deps.db.query(
    `insert into {{schema}}.kit_reviews (job_id, role_id, decisions, gate, updated_at)
     values ($1, $2, $3::jsonb, '[]'::jsonb, $4) on conflict (job_id, role_id) do nothing`,
    [jobId, roleId, storedDecisions("", NO_DECISIONS), deps.clock.now()],
  );
  await deps.db.query(
    "select 1 from {{schema}}.kit_reviews where job_id = $1 and role_id = $2 for update",
    [jobId, roleId],
  );
}

/** Keeps the gate as the kit now stands in the review row. */
export async function keepGate(deps: { db: Db; clock: Clock }, jobId: string, roleId: string) {
  const view = await jobView(deps, jobId);
  await deps.db.query(
    `update {{schema}}.kit_reviews set gate = $3::jsonb, updated_at = $4
      where job_id = $1 and role_id = $2`,
    [jobId, roleId, JSON.stringify(view?.review?.gate ?? []), deps.clock.now()],
  );
}

export function markSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
  shown: SentFrom = {},
): Promise<MarkSent> {
  return marking(deps, jobId, sessionId, answer, { by: "owner", shown });
}

/**
 * An email jobkit sent from the owner's Gmail (decisions A20), marked sent
 * as Mark sent marks one, nothing changed in Gmail, at the address it went
 * to. It went, so nothing on a page, nor a reason that now holds the kit,
 * refuses it.
 */
export function markSentByJobkit(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  to: string,
): Promise<MarkSent> {
  return marking(deps, jobId, sessionId, { changedInGmail: false }, { by: "jobkit", to });
}

/** Who marks the kit sent: the owner, from the page they saw, or jobkit, which sent it to `to`. */
type Marker = { by: "owner"; shown: SentFrom } | { by: "jobkit"; to: string };

/**
 * What the owner changed in jobkit, as an outcome records it (ledger spec,
 * "Factual edits"): the address, the subject (the default in place of a
 * format they declined), and each sentence they edited, deleted or added.
 * An edited or deleted claim or gap line is a factual edit, and so is a
 * sentence of their own; a sentence about the post is one when the
 * company's or the role's name changes with it. A sentence either the
 * drafter or the separate check called a claim is one (drafting spec,
 * "Stage judge"). The subject is no factual edit: the page has no subject
 * editor, so it changes only to the default subject, which says nothing
 * about the owner the post's format did not.
 */
export function changesOf(
  view: JobView,
  to: string,
  typed: boolean,
): { changed: string[]; factual: boolean } {
  const address = addressChanged(view, to, typed);
  const { subject, body } = partsChanged(view);
  return {
    changed: [...(address ? ["address"] : []), ...subject, ...body.changed],
    factual: address || body.factual,
  };
}

/** Whether the owner typed an address in the post's place that differs from it; none while none is typed. */
function addressChanged(view: JobView, to: string, typed: boolean): boolean {
  return typed && to !== "" && !sameAddress(to, view.role!.route.address);
}

/** What the owner changed in the email's two parts: its subject, and its body's sentences. */
function partsChanged(view: JobView): {
  subject: string[];
  body: { changed: string[]; factual: boolean };
} {
  const role = view.role!;
  const { edits, added, deleted } = view.review!.decisions;
  const edited = view.draft!.kit.blocks.filter(
    (block) => Object.hasOwn(edits, block.id) || deleted.includes(block.id),
  );
  const [now, drafted] = [view.kit!, view.draft!.kit];
  const subject =
    now.kind === "email" && drafted.kind === "email" && now.subject !== drafted.subject;
  const names = [view.extraction!.record.company.name, role.title].filter((name) => name);
  // A sentence the owner made a gap line, as they marked it, is factual whatever drafting's was.
  const standing = new Map(view.kit!.blocks.map((block) => [block.id, block.class]));
  // The sentences the separate check weighed as claims, whatever the drafter called them.
  const judgedClaims = new Set(
    (view.kitParts?.verdicts ?? [])
      .filter((verdict) => verdict.verdict !== "not_a_claim" && verdict.note !== NEVER_WEIGHED)
      .map((verdict) => verdict.blockId),
  );
  const factualChange = (block: KitBlock) => {
    if (standing.get(block.id) === "gap" || judgedClaims.has(block.id)) return true;
    if (block.class !== "post") return FACTUAL_CLASSES.has(block.class);
    const now = deleted.includes(block.id) ? "" : (edits[block.id] ?? block.text);
    return names.some((name) => block.text.includes(name) !== now.includes(name));
  };
  return {
    subject: subject ? ["subject"] : [],
    body: {
      changed: [
        ...edited.map((block) => `sentence:${block.id}`),
        ...added.map((sentence) => `sentence:${sentence.id}`),
      ],
      factual: added.length > 0 || edited.some(factualChange),
    },
  };
}

/**
 * The parts of the email a handoff gives the owner: Open in Gmail the
 * address, the subject and the body; a copy button the subject or the body.
 */
export type HandedOff = "address" | "subject" | "body";

/**
 * What Mark sent records from the owner's last handoffs (ledger spec,
 * "Factual edits"): the address Open in Gmail last handed off, else the one
 * the page shows, and each part as last handed off, a part never handed off
 * as it stands at the tap; the draft that went is the body's, as last
 * handed off or as it stands.
 */
function recordedFrom(
  view: JobView,
  handoff: Handoff,
  shownTo: string,
): { to: string; typed: boolean; changed: string[]; factual: boolean; draft: string | null } {
  const [to, typed] =
    handoff.to !== "" ? [handoff.to, handoff.typed] : [shownTo, Boolean(view.handoff?.typed)];
  const address = addressChanged(view, to, typed);
  const standing = partsChanged(view);
  const subject = handoff.subject?.changed ?? standing.subject;
  const body: Pick<HandoffPart, "changed" | "factual"> = handoff.body ?? standing.body;
  return {
    to,
    typed,
    changed: [...(address ? ["address"] : []), ...subject, ...body.changed],
    factual: address || body.factual,
    draft: handoff.body?.draft ?? view.picked,
  };
}

/**
 * A handoff from the page (Open in Gmail, a copy button), posted right after
 * the click (review spec, "The outbound gate"): for each part it handed off
 * (Open in Gmail the address, the subject and the body; Copy subject the
 * subject; Copy email the body), the draft, the words and what they
 * changed, and the address Open in Gmail composed to, kept for the job
 * whichever draft shows later, which Mark sent then records rather than
 * the email as it stands at its tap. Refused for a page that showed
 * another kit, other words or another address, which the server cannot
 * name, as for a kit sent or skipped, or one jobkit is sending.
 */
export async function recordHandoff(
  deps: { db: Db; clock: Clock },
  jobId: string,
  shown: { kit: string; words: string; to?: string; parts?: readonly HandedOff[] },
): Promise<{ ok: true } | Extract<ReviewOutcome, { ok: false }>> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { db: tx, clock: deps.clock };
    const locked = await lockedKit(at, jobId, shown);
    if (!("view" in locked)) return locked;
    const { view } = locked;
    // While jobkit sends the email, no decision is kept, a handoff's included (decisions A20).
    if (view.kitParts.sending) return { ok: false, reason: "sending" };
    // A page that showed another address, as one drawn before it was typed again elsewhere.
    if (shown.to !== undefined && shown.to !== (view.handoff?.to ?? "")) {
      return { ok: false, reason: "changed" };
    }
    const before = view.review?.decisions ?? NO_DECISIONS;
    const parts = shown.parts ?? ["address", "subject", "body"];
    const addressed = parts.includes("address");
    const { subject, body } = partsChanged(view);
    const part = (changed: string[], factual: boolean): HandoffPart => ({
      draft: view.picked,
      words: shown.words,
      changed,
      factual,
      at: deps.clock.now().toISOString(),
    });
    const handoff: Handoff = {
      to: addressed ? (view.handoff?.to ?? "") : (before.handoff?.to ?? ""),
      typed: addressed ? Boolean(view.handoff?.typed) : (before.handoff?.typed ?? false),
      subject: parts.includes("subject") ? part(subject, false) : (before.handoff?.subject ?? null),
      body: parts.includes("body")
        ? part(body.changed, body.factual)
        : (before.handoff?.body ?? null),
    };
    const kept = await keep(at, jobId, view.role!.id, view.kitKey, { ...before, handoff });
    return kept.ok ? { ok: true as const } : kept;
  });
}

/** A Mark sent the status machine refused after the checks: its writes are rolled back. */
class SendRefused extends Error {}

async function marking(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  answer: { changedInGmail: boolean },
  marker: Marker,
): Promise<MarkSent> {
  const job = await loadJob(deps.db, jobId);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.state !== "kit_ready") return { ok: false, reason: "not-ready" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-ready" };
  // Sending another way is Mark submitted, for form and message kits.
  if ((await kitRouteOf(deps.db, jobId, role)) !== "email")
    return { ok: false, reason: "not-email" };
  // An email's kit alone, whatever the application's route says: a message or a form is no email.
  const shownKit = (await jobView(deps, jobId))?.kit;
  if (shownKit && shownKit.kind !== "email") return { ok: false, reason: "not-email" };
  try {
    return await deps.db.tx(async (tx): Promise<MarkSent> => {
      const at = { ...deps, db: tx };
      await lockReview(at, jobId, role.id);
      const view = await jobView(at, jobId);
      if (view?.state !== "kit_ready" || !view.review) return { ok: false, reason: "not-ready" };
      const shownTo = view.handoff?.to ?? "";
      // The owner's tap records what they last handed off, which may be what went though they
      // changed the email or picked another draft since; jobkit's send, what it sent.
      const handoff = marker.by === "owner" ? view.review.decisions.handoff : null;
      const recorded =
        handoff && (handoff.subject || handoff.body) ? recordedFrom(view, handoff, shownTo) : null;
      if (marker.by === "owner") {
        const { shown } = marker;
        if (
          (shown.kit !== undefined && shown.kit !== view.kitKey) ||
          (shown.to !== undefined && shown.to !== shownTo)
        ) {
          return { ok: false, reason: "changed" };
        }
        // A second tap on a kit already sent changes nothing; any other open reason holds it.
        const held = view.review.gate.filter((reason) => reason.kind !== "sent");
        if (held.length > 0) return { ok: false, reason: "held" };
      }
      // The address the email went to: the one jobkit sent it to, the one last handed off, or the
      // one the page shows.
      const to = marker.by === "jobkit" ? marker.to : (recorded?.to ?? shownTo);
      const typed =
        marker.by === "jobkit"
          ? !sameAddress(to, role.route.address)
          : (recorded?.typed ?? Boolean(view.handoff?.typed));
      const applicationId =
        (await applicationIdOf(tx, jobId, role.id)) ?? (await openForJob(at, jobId, sessionId));
      if (!applicationId) return { ok: false, reason: "not-ready" };
      // jobkit's own move, under no session's tap: the email went, whatever the owner tapped since.
      if (marker.by === "jobkit") await unskipped(at, applicationId, null);
      // The address the email went to: the post's, the owner's typed in its place, or the one jobkit
      // sent it to, whatever the owner typed since.
      if (to !== "") await setAddress(at, applicationId, to);
      // Already kit_ready, or sent, after an earlier tap: the next move decides.
      await changeStatus(at, applicationId, "kit_ready", sessionId);
      const sent = await changeStatus(at, applicationId, "sent", sessionId);
      // Unreached after the checks above; were it reached, nothing of the owner's tap would be kept.
      // jobkit's, inside its send's own transaction, keeps where its email went.
      if (!sent.ok) throw new SendRefused();
      if (sent.changed) {
        const { changed, factual, draft } = recorded ?? {
          ...changesOf(view, to, typed),
          draft: view.picked,
        };
        await tx.query(
          `insert into {{schema}}.draft_outcomes
           (application_id, job_id, kind, changed, changed_in_gmail, factual_edit, recorded_at,
            draft)
         values ($1, $2, 'email', $3, $4, $5, $6, $7)
         on conflict (application_id) do update
           set changed = excluded.changed,
               changed_in_gmail = excluded.changed_in_gmail,
               factual_edit = excluded.factual_edit,
               recorded_at = excluded.recorded_at,
               draft = excluded.draft`,
          [
            applicationId,
            jobId,
            changed,
            answer.changedInGmail,
            answer.changedInGmail || factual,
            deps.clock.now(),
            // Which draft went (decisions A22): Gemini's, or a template's, the owner's own words.
            draft,
          ],
        );
      }
      await keepGate(at, jobId, role.id);
      return { ok: true, changed: sent.changed };
    });
  } catch (error) {
    if (error instanceof SendRefused) return { ok: false, reason: "refused" };
    throw error;
  }
}

/**
 * Takes back a skip of the application, if it was skipped: an email jobkit
 * was sending went after the owner skipped the job past the warning that it
 * may have gone. It went, so it is sent, with the audit rows of both moves
 * (ledger spec, "Statuses"). Were the take-back refused, marking it sent is
 * refused next, and the delivery says it could not record it.
 */
async function unskipped(
  deps: { db: Db; clock: Clock },
  applicationId: string,
  sessionId: string | null,
): Promise<void> {
  const { rows } = await deps.db.query<{ status: string; skipped_at: Date | null }>(
    "select status, skipped_at from {{schema}}.applications where id = $1",
    [applicationId],
  );
  const row = rows[0];
  if (row?.status === "skipped" && row.skipped_at) {
    await undoStatus(deps, applicationId, { status: "skipped", at: row.skipped_at }, sessionId);
  }
}

/**
 * Takes back a mistaken Mark sent (ledger spec, "Statuses"): the application
 * goes back to kit_ready, its outcome with it, and the kit opens again. The
 * page names the Mark sent it showed, by its time, so a late tap from a
 * page drawn before the owner marked it sent again changes nothing. An
 * email jobkit sent is not taken back: it went (decisions A20). One on a
 * kit the page can no longer read is taken back too, as the ledger allows;
 * that kit cannot be marked sent again, so its page does not offer it.
 */
export async function takeBackSent(
  deps: { db: Db; clock: Clock },
  jobId: string,
  sessionId: string | null,
  shownSentAt?: Date,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "not-sent" | "sent-by-jobkit" }> {
  if (!isUuid(jobId)) return { ok: false, reason: "not-found" };
  const role = await chosenRole(deps.db, jobId);
  if (!role) return { ok: false, reason: "not-found" };
  return deps.db.tx(async (tx) => {
    const at = { ...deps, db: tx };
    await lockReview(at, jobId, role.id);
    const { rows } = await tx.query<{ id: string; status: string; sent_at: Date | null }>(
      `select id, status, sent_at from {{schema}}.applications
        where job_id = $1 and role_id = $2`,
      [jobId, role.id],
    );
    const application = rows[0];
    if (application?.status !== "sent" || !application.sent_at) {
      return { ok: false as const, reason: "not-sent" as const };
    }
    const byJobkit = await tx.query(
      `select 1 from {{schema}}.kit_sends
        where job_id = $1 and role_id = $2 and status = 'sent' limit 1`,
      [jobId, role.id],
    );
    if (byJobkit.rows.length > 0) {
      return { ok: false as const, reason: "sent-by-jobkit" as const };
    }
    const undone = await undoStatus(
      at,
      application.id,
      { status: "sent", at: shownSentAt ?? application.sent_at },
      sessionId,
    );
    if (!undone.ok || !undone.changed) return { ok: false as const, reason: "not-sent" as const };
    await keepGate(at, jobId, role.id);
    return { ok: true as const };
  });
}
