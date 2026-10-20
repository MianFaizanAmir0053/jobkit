/**
 * Job states, their kinds and the moves between them: platform spec B9's
 * table, the single one every other spec cites. Only `running` jobs are
 * advanced by the runner; `waiting` and `owner` states move on the owner's
 * action, `client` on intake's requests, and `ready` and `final` never move
 * by themselves.
 */

export const JOB_STATES = [
  "manual_run",
  "uploading",
  "upload_failed",
  "queued",
  "extracting",
  "needs_role_pick",
  "checking",
  "needs_eligibility_decision",
  "needs_kit_type",
  "drafting",
  "judging",
  "kit_ready",
  "stopped",
  "failed",
  "closed",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export type StateKind = "owner" | "client" | "running" | "waiting" | "ready" | "final";

export const STAGES = [
  "extract",
  "extract_questions",
  "eligibility",
  "templates",
  "draft",
  "draft_answers",
  "address_read",
  "address_checks",
  "judge",
] as const;

export type StageName = (typeof STAGES)[number];

const STATES: Record<JobState, { kind: StateKind; next: readonly JobState[] }> = {
  manual_run: { kind: "owner", next: ["closed"] },
  uploading: { kind: "client", next: ["queued", "upload_failed"] },
  upload_failed: { kind: "owner", next: ["uploading", "closed"] },
  queued: { kind: "running", next: ["extracting"] },
  extracting: {
    kind: "running",
    next: ["needs_role_pick", "checking", "drafting", "stopped", "failed"],
  },
  needs_role_pick: { kind: "waiting", next: ["checking", "closed", "kit_ready"] },
  checking: {
    kind: "running",
    next: ["needs_eligibility_decision", "needs_kit_type", "drafting", "failed"],
  },
  needs_eligibility_decision: { kind: "waiting", next: ["needs_kit_type", "drafting", "closed"] },
  needs_kit_type: { kind: "waiting", next: ["drafting", "closed"] },
  drafting: { kind: "running", next: ["judging", "kit_ready", "drafting", "failed"] },
  judging: { kind: "running", next: ["kit_ready", "failed"] },
  kit_ready: { kind: "ready", next: ["extracting", "drafting", "needs_role_pick"] },
  stopped: { kind: "owner", next: ["extracting", "closed"] },
  failed: {
    kind: "owner",
    next: ["extracting", "checking", "drafting", "judging", "kit_ready", "closed"],
  },
  closed: { kind: "final", next: [] },
};

/**
 * The stages a running state can have pending: `extracting` runs `extract`
 * or `extract_questions`, `drafting` runs `templates` first, then `draft`
 * or `draft_answers`. `queued` runs nothing; the runner moves it on to
 * `extract`. The address stages are never pending: they run alongside
 * `templates` and `draft`.
 */
const PENDING: Partial<Record<JobState, readonly StageName[]>> = {
  queued: [],
  extracting: ["extract", "extract_questions"],
  checking: ["eligibility"],
  drafting: ["templates", "draft", "draft_answers"],
  judging: ["judge"],
};

export function kindOf(state: JobState): StateKind {
  return STATES[state].kind;
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value);
}

export function isStageName(value: unknown): value is StageName {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

/** The running state in which a stage is pending. */
export function stateOfStage(stage: StageName): JobState | null {
  for (const [state, stages] of Object.entries(PENDING)) {
    if (stages.includes(stage)) return state as JobState;
  }
  return null;
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };

// What an extraction may lead to, by the stage that ran: only new form questions on a
// ready kit go straight on to drafting (B9's table).
const AFTER_EXTRACTION: Partial<Record<StageName, readonly JobState[]>> = {
  extract: ["needs_role_pick", "checking", "stopped", "failed"],
  extract_questions: ["drafting", "failed"],
};

// What drafting may lead to, by the stage that ran (decisions A22): only `templates` goes
// straight to a ready kit, when the owner's templates drafted it, or on to `draft` when none
// fits; a drafted email is always judged.
const AFTER_DRAFTING: Partial<Record<StageName, readonly JobState[]>> = {
  templates: ["kit_ready", "drafting", "failed"],
  draft: ["judging", "failed"],
  draft_answers: ["judging", "failed"],
};

/**
 * Whether a job may move from one state to another, carrying `pending` as
 * its pending stage; `leaving` is the stage pending as a running job leaves
 * its state. A running state needs one of its own stages pending (`queued`
 * none), so a retried job can only resume in the state its stage belongs
 * to; `failed` keeps the very stage that failed; every other state has none.
 * The rows of the table that hold for one stage only are checked too: a new
 * job and a post the owner confirms start at `extract`, only
 * `extract_questions` leads from extracting to drafting, with
 * `draft_answers`, only `templates` leads from drafting to a ready kit, or
 * on to `draft`, and a failed job goes back to its kit only from `draft`,
 * `judge` or a form's add (`extract_questions`, `draft_answers`), named as
 * the stage it leaves.
 */
export function checkMove(
  from: JobState,
  to: JobState,
  pending: StageName | null,
  leaving: StageName | null = null,
): MoveCheck {
  if (!STATES[from].next.includes(to)) return { ok: false, reason: `${from} cannot move to ${to}` };
  const expected = to === "failed" ? PENDING[from] : PENDING[to];
  if (expected === undefined || expected.length === 0) {
    if (pending !== null) return { ok: false, reason: `${to} has no pending stage` };
  } else if (pending === null || !expected.includes(pending)) {
    return { ok: false, reason: `${to} needs one of ${expected.join(", ")} pending` };
  }
  if (to === "failed" && leaving !== null && pending !== leaving) {
    return { ok: false, reason: "a failed job keeps the stage it failed at" };
  }
  if (from === "extracting" && leaving !== null) {
    if (!(AFTER_EXTRACTION[leaving] ?? []).includes(to)) {
      return { ok: false, reason: `extracting cannot move to ${to} after ${leaving}` };
    }
    if (to === "drafting" && pending !== "draft_answers") {
      return { ok: false, reason: "new form questions are drafted by draft_answers" };
    }
  }
  if (from === "drafting" && leaving !== null) {
    if (!(AFTER_DRAFTING[leaving] ?? []).includes(to)) {
      return { ok: false, reason: `drafting cannot move to ${to} after ${leaving}` };
    }
    if (to === "drafting" && pending !== "draft") {
      return { ok: false, reason: "a post no template fits is drafted by draft" };
    }
  }
  // Back to its kit only from a Gemini draft asked for beside the templates' (decisions A22), or
  // from an add of a form's screenshots that failed (intake spec, item 4).
  if (
    from === "failed" &&
    to === "kit_ready" &&
    !(["draft", "judge", "extract_questions", "draft_answers"] as const).some(
      (stage) => stage === leaving,
    )
  ) {
    return {
      ok: false,
      reason: "a failed job goes back to its kit only from draft, judge or a form's add",
    };
  }
  if ((from === "queued" || from === "stopped") && to === "extracting" && pending !== "extract") {
    return { ok: false, reason: `${from} moves to extracting only with extract` };
  }
  return { ok: true };
}
