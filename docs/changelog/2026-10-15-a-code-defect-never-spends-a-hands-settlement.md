# A Code Defect Never Spends A Hand's One Settlement Claim

Date: 2026-10-15

## What Happened

The 100 Chip Guarantee Freeroll 6:00 AM (`a38b88a9`) sat RUNNING from 2026-10-13 13:14:51 UTC with 58 seated players and no hand. Each of its 8 tables held one finished hand whose settlement request had been retained. The successor engine generation took each hand's one financial claim, and the settlement rolled back on a code defect: `record "new" has no field "metadata"`, a trigger reading a column its table did not have (fixed by `20261013133012`). `fn_ca_resume_hand_submission` recorded each rollback as the hand's financial refusal, so every later admission read `successor_financial_claim_spent` and the table could never deal again.

The same defect stranded 217 hands. `launch_typed209_source_correction_proof` rescued 209 of them through a hard-coded list; these 8 were outside it.

## The Fix (migration `20261015011723`)

1. **Root.** `fn_ca_settle_hand_stacks_absolute` now returns the SQLSTATE of the error that rolled it back. `fn_ca_resume_hand_submission` treats a rollback of class 42, 0A or XX (an undefined column or function, an internal error) like a lease or lock refusal: it raises, so the claim, handoff and dispatch roll back and the next admission settles the hand once the defect is fixed. A genuine financial refusal still spends the claim exactly as before. `original_hand_correction_sources_match` moves its pin on the settlement function with it.
2. **Recovery through the existing door.** `smarter_private.metadata_defect_source_correction_proof` proves the same cause from a hand's own rows with every `launch_typed209` condition read live, and returns the row digests so the resume's re-proof refuses any row that moves before the claim. The proof dispatcher falls back to it after the three existing proofs.
3. **The 8 hands** are certified through `certify_original_hand_source_correction`, the operator-only door every earlier correction used. It pays nothing; the engine's own resume then settles each hand once with its original request.

## Proof Before Install

Self-aborting production trials on 2026-10-15, with the new proof built only in `pg_temp`:

- Exactly these 8 submissions qualify, in one tournament, with no overlap with the 209 already claimed or any existing correction.
- Each passes the resume's state checks: seats and stacks unchanged, no blocking late seat, nothing dealt since.
- The real `fn_ca_commit_hand_settlement` on one of them returned success, atomic commit and conservation checked, then rolled back.
- Every post-image round-trips exactly.

Pinned by `tests/a-code-defect-never-spends-a-hands-settlement.law.test.ts`.
