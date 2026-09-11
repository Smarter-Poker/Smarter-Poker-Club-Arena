# Final Deal V2 Uses The Real Terminal Claim

The current canonical final-deal cash payer proved and paid its complete cash plan, then wrote `COMPLETING` directly. The existing finish guard correctly refused that unclaimed transition. A cash-payer proof alone could not certify whole-event completion.

The explicitly approved prepared bundle is `scripts/deploy/phase-three-final-deal-terminal-v2.sql`. It keeps the canonical payer and its original validations, adding an immutable version 2 batch only after genuine obligations, wallet-credit receipts, payouts and final standings have passed. The batch captures the locked chip-chop inputs, durable prior standings, exact-cent plan and original escrow delta. Only then does the payer call `fn_claim_tournament_finish` and verify its real receipt and lifecycle transition. A failure rolls the entire statement back.

The owner-only verifier independently reconstructs the chip chop and fixed tail from canonical inputs, verifies the recipient debts and wallet receipts, rejects orphaned obligation-scoped wallet keys, and checks final custody and seats when terminal verification is requested. Replays verify the stored batch and finish receipt without rewriting money or presentation state. Existing zero-share refusal remains unchanged.

Version 1 batches retain their original Bubble constraint semantics and original verifier. New version 2 batches require explicit canonical Bubble provenance. The completion guard and readiness dispatcher select the correct version. The existing obligation freeze permits only the exact `terminal_closed_at` marker after genuine completion, with monetary fields unchanged. A separate trigger makes version 2 batch updates and deletes fail.

The same bundle installs the three already-reviewed owner-only cash leaves and compatible readiness dispatch atomically. Both this bundle and Stage B accept only the exact original or exact installed leaf source. Unknown function, trigger, schema or privilege state refuses installation. A nine-function postflight verifies the resulting source and access contract.

Stage B now requires the exact final-deal verifier, writer and completion guards. Its public obligation wrapper preserves the live `exact_refund_authority_required` refusal before any compatibility dispatch. This corrects a prepared-cutover regression, not an observed production refund change.

Validation status at preparation: the exact Bubble constraint was applied and rolled back in native PG17 solely to derive its catalog postimage; all eight catalog snapshots and the batch table were restored. Full bundle, idempotent reapplication and current terminal financial acceptance are being run separately. This document does not claim those results before their evidence is recorded.

No production migration, money movement, guard activation or feature activation is recorded by this change. The release coordinator owns production application and live adoption verification.

## Resumed closeout, 2026-09-10

The final-deal bundle now preserves the public terminal function OID while installing the genuine seat-capability wrapper and an owner-only copy of the existing terminal implementation. The first-install and reapplication paths both run in native PostgreSQL. It preserves the current refusal against creating a second finishing-place debt and checks the current shared rolling settlement lane before any relation changes.

Version 2 receipts use timezone-independent input fingerprints, verify the actual accepted obligations, wallet credits and standings, and integrate with the genuine finish claim and enabled financial certificate guards. Immutable batch, obligation and standing tampering is refused. A late terminal receipt fault rolls back every financial and seat effect.

Validation: 41 assertions each for the paid, unpaid and partially paid fixed tail (123 total). Every variant reaches COMPLETED through the real terminal authority, pays the exact funded total, empties and closes the required escrow buckets, removes seats through consumed capabilities, and makes replay payment-free. Every variant restores all observed business rows and all eight catalog snapshots. The deploy bundle is byte-identical to reserved migration 20260910181508.

This evidence covers the complete final-deal bundle and selected strict Stage B blocks. The entire Stage B transaction, remaining format acceptance, production deployment and publication are still pending. Phase 3 is not closed. Automatic approval review blocked the GitHub publication attempt and two delegated remote repository reviews; no rejected command ran.
