import { describe, expect, it } from "vitest";

import { checkMove, JOB_STATES, type JobState, kindOf, type StageName } from "./jobStates";

// Platform spec B9's table, written out again so the test does not read the code's copy.
const TABLE: Record<JobState, { kind: string; next: JobState[] }> = {
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
  drafting: { kind: "running", next: ["judging", "failed"] },
  judging: { kind: "running", next: ["kit_ready", "failed"] },
  kit_ready: { kind: "ready", next: ["extracting", "drafting", "needs_role_pick"] },
  stopped: { kind: "owner", next: ["extracting", "closed"] },
  failed: { kind: "owner", next: ["extracting", "checking", "drafting", "judging", "closed"] },
  closed: { kind: "final", next: [] },
};

// A pending stage each state can be entered with, where it needs one.
const ENTRY_STAGE: Partial<Record<JobState, StageName>> = {
  extracting: "extract",
  checking: "eligibility",
  drafting: "draft",
  judging: "judge",
};

// The stage pending as a running job leaves its state: new form questions on a ready kit
// are the only extraction that goes straight on to drafting.
function leavingFor(from: JobState, to: JobState): StageName | null {
  if (from === "extracting") return to === "drafting" ? "extract_questions" : "extract";
  return from === "queued" ? null : (ENTRY_STAGE[from] ?? null);
}

// The pending stage a move carries: a failed job keeps the stage it failed at.
function pendingFor(from: JobState, to: JobState): StageName | null {
  if (to === "failed") return leavingFor(from, to);
  if (from === "extracting" && to === "drafting") return "draft_answers";
  return ENTRY_STAGE[to] ?? null;
}

describe("job states", () => {
  it("has exactly the spec's states, each of the spec's kind", () => {
    expect([...JOB_STATES].sort()).toEqual(Object.keys(TABLE).sort());
    for (const state of JOB_STATES) expect(kindOf(state)).toBe(TABLE[state].kind);
  });

  it("allows every move in the table and refuses every other", () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const allowed = TABLE[from].next.includes(to);
        const move = checkMove(from, to, pendingFor(from, to), leavingFor(from, to));
        expect(move.ok, `${from} → ${to}`).toBe(allowed);
      }
    }
  });

  it("enters a running state only with a pending stage that belongs to it", () => {
    expect(checkMove("queued", "extracting", "extract").ok).toBe(true);
    expect(checkMove("kit_ready", "extracting", "extract_questions").ok).toBe(true);
    expect(checkMove("kit_ready", "drafting", "draft_answers").ok).toBe(true);
    expect(checkMove("queued", "extracting", null).ok).toBe(false);
    expect(checkMove("queued", "extracting", "judge").ok).toBe(false);
    expect(checkMove("drafting", "judging", "address_checks").ok).toBe(false);
    expect(checkMove("uploading", "queued", null).ok).toBe(true);
    expect(checkMove("uploading", "queued", "extract").ok).toBe(false);
  });

  it("enters a state that runs nothing with no pending stage, except failed, which keeps the stage that failed", () => {
    expect(checkMove("extracting", "needs_role_pick", "extract").ok).toBe(false);
    expect(checkMove("judging", "kit_ready", null).ok).toBe(true);
    expect(checkMove("drafting", "failed", "draft").ok).toBe(true);
    expect(checkMove("drafting", "failed", null).ok).toBe(false);
    expect(checkMove("drafting", "failed", "judge").ok).toBe(false);
  });

  it("holds the rows of the table that depend on the stage being left", () => {
    // Only new form questions on a ready kit go from extracting straight to drafting.
    expect(checkMove("extracting", "drafting", "draft", "extract").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft_answers", "extract").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft", "extract_questions").ok).toBe(false);
    expect(checkMove("extracting", "drafting", "draft_answers", "extract_questions").ok).toBe(true);
    expect(checkMove("extracting", "checking", "eligibility", "extract_questions").ok).toBe(false);
    // A new job, and a post the owner confirms, start at extract.
    expect(checkMove("queued", "extracting", "extract_questions").ok).toBe(false);
    expect(checkMove("stopped", "extracting", "extract_questions").ok).toBe(false);
    expect(checkMove("stopped", "extracting", "extract").ok).toBe(true);
    // A failed job keeps the very stage it left.
    expect(checkMove("extracting", "failed", "extract_questions", "extract").ok).toBe(false);
  });

  it("retries a failed job only into the running state of the stage it failed at", () => {
    expect(checkMove("failed", "drafting", "draft_answers").ok).toBe(true);
    expect(checkMove("failed", "extracting", "draft").ok).toBe(false);
    expect(checkMove("failed", "closed", null).ok).toBe(true);
  });
});
