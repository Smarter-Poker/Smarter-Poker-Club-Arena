# Final Deal Review Parks Before Consent

## Cause

The exact-proposal correction still waited for unanimity before parking the dealer. When players agreed during an active hand, the durable boundary changed the hand, stacks and proposal revision. Correct rejection then resumed play, potentially repeating the same expired-consent cycle.

## Correction

Only an explicit durable review request starts admission. The manager parks its exact current engine, refreshes the surviving roster, and calls the scoped begin-review authority to publish the stable post-hand proposal. A recovered review also proves that physical boundary before manager adoption. Partial consent preserves the same dealer fence across the existing scheduler, so players can accept one unchanged proposal in separate decisions.

The database owns the human review deadline and proposal generation. No getter starts a review, no client or engine extends the deadline, and no changed proposal inherits votes. Engine expiry merely requests serialized closure. Play resumes only from the exact cancelled or expired review envelope with no remaining proposal or votes. Malformed or unavailable closure retains the fence. A still-running engine replaced in either owner map remains fenced until its owner retires it; this manager never restarts that detached dealer. Completed or unknown financial outcomes keep the terminal receipt and fencing rules.

## Verification

The initial requested-review regression failed before the change. Independent review found three further edges; eight failing cases reproduced a changed post-hand roster, contradictory closure envelopes and a replaced engine. All are corrected in this commit.

The focused suite passes 175 tests in nine files, including 45 review and consensus cases. The controlled lifecycle holds an active hand open, proves activation waits for its commit, accepts separate player decisions across scheduler checks, and requests one terminal settlement against the unchanged post-hand proposal. Additional cases verify cancellation, expiry, transport loss, stale proposal, changed roster, owner handoff, and unknown-outcome fencing. Full server TypeScript and diff validation pass.

Logs: `/tmp/codex-chip-deal-review-before.log`, `/tmp/codex-chip-deal-review-hostile-before.log`, `/tmp/codex-chip-deal-review-owner-before.log`, `/tmp/codex-chip-deal-review-owner-tests.log`, and `/tmp/codex-chip-deal-review-owner-tsc.log` with explicit exit status files. Existing shared dependencies were used without installation or copies.

## Rollout Gate

This follow-up depends on the payout lane's reviewed session schema and scoped begin/close/consensus authority. Native SQL composition and the ordered SQL, engine, client and activation rollout remain coordinator-owned. This source commit performs no production write or deployment and does not declare Phase 3 complete.
