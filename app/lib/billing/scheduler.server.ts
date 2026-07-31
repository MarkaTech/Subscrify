/**
 * Billing scheduler decision logic — Phase 4 billing engine.
 *
 * Two small pure decisions live here, factored out from the network/DB glue
 * (run-scheduler.server.ts) so the rules that decide "is this due, and which
 * cycle" are unit-testable without a live Shopify store or queue:
 *
 *   1. isContractDue    — should we even look at this contract this tick?
 *   2. pickDueCycle     — given its billing cycles, which one (if any) do we
 *                         actually charge?
 *
 * Shop-scoping (invariant #2) is enforced by construction one level up: every
 * caller here already has a per-shop admin client, so nothing in this module
 * ever sees more than one shop's data at a time.
 */

export interface ContractDueCheck {
  status: string;
  nextBillingDate: string | null;
}

/** Only ACTIVE contracts with a nextBillingDate that has already arrived are due. */
export function isContractDue(contract: ContractDueCheck, now: Date): boolean {
  if (contract.status !== "ACTIVE") return false;
  if (!contract.nextBillingDate) return false;
  return new Date(contract.nextBillingDate).getTime() <= now.getTime();
}

export interface BillingCycleCandidate {
  cycleIndex: number;
  billingAttemptExpectedDate: string;
  status: "BILLED" | "UNBILLED";
  skipped: boolean;
}

/**
 * Among a contract's billing cycles, pick the earliest UNBILLED, unskipped
 * cycle whose billingAttemptExpectedDate has already arrived. Earliest-first
 * so a backlog (the app was down, cycles piled up) is worked in order rather
 * than jumping straight to the newest cycle and silently never charging for
 * the missed ones — each cycle is still its own, separately
 * idempotency-keyed charge either way.
 *
 * Returns null when there is nothing to charge (e.g. everything already
 * billed, or the only unbilled cycles aren't due yet) — the caller should
 * treat that as "nothing to do," not an error.
 */
export function pickDueCycle(
  cycles: BillingCycleCandidate[],
  now: Date,
): BillingCycleCandidate | null {
  const due = cycles
    .filter((c) => !c.skipped && c.status === "UNBILLED")
    .filter(
      (c) => new Date(c.billingAttemptExpectedDate).getTime() <= now.getTime(),
    )
    .sort((a, b) => a.cycleIndex - b.cycleIndex);

  return due[0] ?? null;
}
