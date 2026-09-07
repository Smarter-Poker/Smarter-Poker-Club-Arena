# Cancelled Spin draws return to their recorded reserve

The cancellation trigger credited NEW.club_id even when the original draw came from a different reserve owner. It also tested FOUND after set_config calls instead of immediately after the bank UPDATE.

The original trigger now groups draw and prior-return legs by their recorded reserve owner, returns each positive remainder to that bank and requires exactly one updated bank row before recording the return. Errors roll back the original cancellation transaction. The existing paid-prize guard and cancellation replay guard remain.

The original actual-function probe reproduced the wrong-bank return. Candidate and installed probes passed recorded ownership, prior partial return, replay, missing bank refusal, journal-failure rollback and the paid-prize guard. Fixtures were temporary and self-aborted. Actual bank/escrow triggers and concurrent sessions were not simulated.

Applied migration: 20260907222512. The inspected historical cancelled draw was already returned to the matching owner; no historical balances were changed.

Separate open finding: cancelled Spin 98e4b933-60d8-4506-9861-3d755d243a72 has 6 chips of entry debits and 6 refunded, but an aggregate fn_spin_book_entry rake row of 0.48 remains. Its metadata has no user_id, so the per-user cancellation fee reversal does not select it. Fee distribution, reserve contribution reversal and escrow accounting still require a complete original-transaction correction; this draw-routing fix does not claim to settle those.
