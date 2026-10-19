# A terms-refused tournament fee is recaptured at its close

2026-10-19. Migration `20261019211349_a_terms_refused_tournament_fee_is_recaptured_at_its_close.sql`.

## What happened

At 15:43:07 UTC the 1,717 current horse memberships in KingFish's clubs were moved under KingFish as plain players (#7458). KingFish is the owner of those clubs and had no agent agreement in them, so the earning contract (`fn_accounting_earning_contract`) refused every contributor reporting to him with `accounting_terms_not_observed`.

The tournament fee producer (`fn_stamp_accounting_tournament_fee`) is written so that this refusal cannot destroy a proved fee charge. Instead of failing the buy-in it saves the whole fee batch as `legacy_unverified`, with the contributor manifest it had already proved and the refusal in `capture_reason`. Between 15:43:16 and 19:07:16 UTC that happened to **1,167 fee records (4,753.55 chips) in 1,011 tournaments**, including Spin batch-mates from clubs `a0000000-...-0001` and `a41434bb...`, whose fee shared a batch with a club `2a1132b9` contributor.

#7458 fixed the contract at 19:07, and no batch has been saved that way since. But nothing could make the 1,167 saved batches payable again. The batch row is immutable, and the net plan refuses any batch that is not `captured`. The legacy-custody fallback in the finish refuses post-cutover fees ("legacy fee custody requires exact unpaid named source and completed player banks"). So every one of those tournaments was decided but could not finish, and its winners were not paid. At 21:00 UTC 714 Spins and 269 SNGs were stuck with one player left, along with 11 running MTTs; 17 registering MTTs carried the same fees and would have stuck at their own finish. The engine retried the decided ones continuously, and that retry load slowed engine shutdown and boot through every hourly release.

## The root fix

The defect was that a refusal which was correct at the charge instant stranded the prize permanently once its cause was gone. The tournament's own close (`fn_settle_tournament_rake`) now recaptures such a batch inside the close transaction, from the batch's own recorded manifest, before the net plan runs. The recapture function is `fn_accounting_recapture_terms_refused_tournament_fee`. It makes every evidence check the producer `fn_capture_accounting_tournament_fee` makes, uses the same largest-remainder allocation, and prices each contributor through the same contract at the same charge instant. It writes ordinary `accounting_tournament_fee_sources` rows and one immutable receipt in `accounting_tournament_fee_terms_recaptures`, which keeps the untouched original batch.

This follows the existing mixed-cutover Spin qualification exactly. The net plan and the week-quality reader accept this receipt in the same places they accept that one. The original batch is never updated or deleted, and no trigger is bypassed.

The recapture has no schedule and no sweep. It runs only in the close of the event that owns the fee. If the terms are still unobservable it refuses in the same words the close already handles, so the result is no worse than before.

## Who was paid, and why

Every affected tournament is paid by the engine's own terminal path (`fn_complete_tournament_terminal`), using its own places and structure and its idempotent credit keys. Nothing here writes a wallet. Each winner and placed player receives exactly the prize the event's structure owed them when it was decided, once. Each fee is attributed to the players who paid it, at the terms in force when they paid it. Horses and humans go through the same path; no line reads `is_horse`.

The proof was run in a rolled-back transaction against production (CLAUDE.md 11.5). It used one Spin (`eba0977d`, 20.00 to the winner, fee 2.40 to 3 contributors), one SNG (`9a429c3c`, 38.00 to the winner, fee 2.00 to 2 contributors) and one MTT (`05236455`, 80.00 across 46 places, fee 1.60 to 16 contributors, 8 of them recaptured). Each one completed, closed its escrow at exactly zero, wrote one credit key per payout and no duplicate payout, and recognized its fee.

## Cash rake

The same refusal blocked cash rake sources from 15:43:12 to 18:48. Since the producer fix, every retry of those sources has accrued; none has been refused. They drain through the existing bounded retry in the engine's rakeback settler. The live counts are in the PR.
