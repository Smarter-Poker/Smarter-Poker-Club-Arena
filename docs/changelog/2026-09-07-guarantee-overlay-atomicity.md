# Guarantee funding commits its bank debit and journal together

The start-time overlay trigger caught a final journal error after debiting its funding bank and increasing the tournament pool. It returned successfully, allowing unjournaled funding to commit. An isolated copy of the actual production trigger reproduced this outcome.

The original trigger now propagates journal failures. Transient deadlocks retain the existing three-attempt limit; an exhausted retry propagates too. PostgreSQL then rolls back the bank debit, pool change and status update together. Guarantee amounts, published ladders and union/private/fallback bank selection are preserved.

Validation: the original probe failed; candidate and installed-function probes passed ordinary journal refusal, exhausted deadlocks, two transient deadlocks followed by exactly one successful debit, status replay, club fallback and private-club routing. Each probe ended with an intentional exception to roll back all temporary fixtures. External ledger/escrow triggers and concurrent sessions were not simulated.

Migration applied: 20260907220945. No historical balances were changed. A recorded September 3 failure for tournament 1068cd04-41c8-4168-83cb-243ebe693918 names an 18-chip overlay; its full settlement history remains under investigation. This correction is not a claim that historical damage is settled.
