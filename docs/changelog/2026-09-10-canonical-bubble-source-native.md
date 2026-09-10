# Canonical Bubble source correction

The prepared normal-place batch now re-reads the actual settled Bubble obligation after payment. Its batch source therefore matches the native payer's engine.fn_settle_tournament_bubble_protection source, while bubble_amount_paid_before retains the original pre-credit value. Bubble identity/source checks now reject NULL safely. No schema or guard expansion was added.

Three rollback-only native cash variants passed with all seven financial guards active:

| Initial Bubble paid | Native assertions | Final place / Bubble | Result                                   |
| ------------------- | ----------------- | -------------------- | ---------------------------------------- |
| 0.00                | 13                | 9.00 / 1.00          | Exact settled batch and unchanged replay |
| 0.40                | 14                | 9.00 / 1.00          | Exact settled batch and unchanged replay |
| 1.00                | 14                | 9.00 / 1.00          | Exact settled batch and unchanged replay |

Prior payments were created by the real private obligation payer with actual wallet/payout journals. Opening custody and standings were synthetic. These cash proofs stop at COMPLETING with prize escrow zero; they do not claim whole-terminal Bubble completion.

The NULL-source and NULL-recipient attempts were refused by existing batch and obligation check constraints, respectively, with exact rollback. No guard was disabled to reach the new verifier's NULL branches. Those branches were checked in independent source review.

A separate Spin fixture defect was identified: 10x uses an 80/20 ladder, but the old fixture supplied a 100%-winner contract and required one payout. Expected amounts/count now come from the immutable funded draw receipt and must independently match the native calculator and total custody. The final corrected mixed-weight run passed at observed 2x, including late receipt rollback, terminal closure and immutable replay. A single-tier 10x attempt was refused by the real manifest validator before drawing; no 10x success is claimed and the unsupported option was removed. The original generic failed run did not record its multiplier, so attributing that particular failure to the discovered 10x mismatch remains an inference.

Actual runtime body MD5 values are 2fb9eb9761e248315f36df617e519512 for normal cash and 393570c0639c1b01acfc8f7db733f9b2 for its verifier. The normal block SHA-256 is 5463368592ace44854fe970e8dbc2c12499e82328e9bc7c49986a68d0d922692. Every successful run restored the same retained 12-event baseline, public function/trigger catalogs and all 34 tracked table states exactly.

Full source/runtime pins, observations, assertion lists and boundaries are in docs/audits/2026-09-10-canonical-bubble-batch-native.json. Earlier terminal evidence remains unchanged as a historical checkpoint.

**Stage B remains blocked and NOT APPLIED.** Final-deal v2 is absent following automatic approval-review rejection. The header now correctly identifies it as the remaining blocker; the exact-hand prerequisite is resolved. No production database changes were made. Python syntax and git diff --check passed.
