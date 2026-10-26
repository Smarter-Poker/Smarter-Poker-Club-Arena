# Main vacancies take the first completed hand boundary

A must-move planned during a feeder hand was excluded from settlement unless it had already been announced at that hand's start. It therefore waited through the next complete feeder hand, even though Main already had a reserved vacancy. Owner direction on October 23 removes that extra-hand delay.

Settlement and the final pre-deal check now execute ordinary must-moves at the first safe source hand boundary, through the existing atomic, occupancy-bound executor and presence transfer. Announced optional changes still execute as before; unannounced swaps, voluntary seat changes, balancing and table breaks retain their prior announcement rule. Unknown reads remain unknown. Active hands, lifecycle authority, maintenance freezes and durable conservation receipts remain enforced.

The full pending list remains available for swap-hold reconciliation. A shared execution selector admits Main feeding without executing unannounced optional changes or swaps. Pre-deal transfers retain the seat-boundary mutex until the original request settles, even after the outer time budget. The prepared deal revalidates the resulting roster.

Regression coverage exercises the post-hand pipeline, between-hand plans, swap holds, freezes, delayed replies, replacement occupancies, actual PostgreSQL transfers and reconnects. Deployment and live proof are recorded in the task evidence checkpoint.
