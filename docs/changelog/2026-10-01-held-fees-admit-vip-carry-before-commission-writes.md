# Held fees admit VIP carry before commission writes

A historical fee settlement holds its host bank while awarding VIP credit. A cash hand can already own a contributor's VIP carry row and then request that bank, forming a lock cycle. The existing five-second settlement budget prevents an unbounded wait but does not remove the cycle.

The strongly admitted historical recognition branch now locks exactly the existing VIP carry rows for its positive aggregate contributors, in player order and without waiting, before commission writes. A busy row or missing row aborts the whole operation with a named refusal that escapes the payer's lock-timeout retry. The ordinary recognition path and canonical VIP writer remain unchanged, including fractional carry, unique award keys, point totals, bank proof and deferred final receipts. No timeout, rate, player payment or historical record is changed.

The regression is part of the maintained native held-fee qualification. It exercises the actual owner and VIP writer in isolated PostgreSQL, comparing refusal, rollback, ordinary recognition and financial outcomes before and after the migration. Production installation and historical settlement completion are separate evidence and are not claimed by this source change.

The production phase profile measured 48 missing captures in 1.033 seconds and 199 commission entries taking 1.461 seconds before expiry during VIP processing. That does not establish that all elapsed time was lock waiting or promise that this correction alone brings every historical operation below five seconds. The change removes the independently established bank-to-VIP wait edge without removing financial checks.
