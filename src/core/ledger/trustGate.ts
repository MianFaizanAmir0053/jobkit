/**
 * The trust gate (ledger spec, "Factual edits and the trust-gate counter";
 * ADR 0001 entry 20). Ten clean email outcomes in a row unlock it; once
 * unlocked, a factual edit locks it again, and five clean outcomes unlock
 * it. Skipped jobs and form and message kits do not count. In the MVP
 * nothing acts on it.
 */
export interface KitOutcome {
  kind: "email" | "form" | "message";
  skipped: boolean;
  factualEdit: boolean;
}

export interface TrustGate {
  unlocked: boolean;
  /** Clean email outcomes since the last factual edit. */
  cleanStreak: number;
  /** The streak that unlocks it now: ten at first, five after a relock. */
  needed: number;
}

const FIRST_UNLOCK = 10;
const UNLOCK_AGAIN = 5;

/** Reads the outcomes in time order. */
export function trustGateState(outcomes: readonly KitOutcome[]): TrustGate {
  let state: TrustGate = { unlocked: false, cleanStreak: 0, needed: FIRST_UNLOCK };
  for (const outcome of outcomes) {
    if (outcome.kind !== "email" || outcome.skipped) continue;
    if (outcome.factualEdit) {
      state = {
        unlocked: false,
        cleanStreak: 0,
        needed: state.unlocked ? UNLOCK_AGAIN : state.needed,
      };
      continue;
    }
    const cleanStreak = state.cleanStreak + 1;
    state = { ...state, cleanStreak, unlocked: state.unlocked || cleanStreak >= state.needed };
  }
  return state;
}
