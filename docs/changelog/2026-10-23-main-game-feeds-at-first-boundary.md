# Main vacancies take the first completed hand boundary

A must-move planned during a feeder hand was excluded from settlement unless it had already been announced at that hand's start. It therefore waited through the next complete feeder hand, even though Main already had a reserved vacancy. Owner direction on October 23 removes that extra-hand delay.

Settlement now executes ordinary must-moves at the first completed source hand boundary, through the existing atomic, occupancy-bound executor and presence transfer. Announced optional changes still execute as before; unannounced swaps, voluntary seat changes, balancing and table breaks retain their prior announcement rule. Unknown reads remain unknown. Active hands, lifecycle authority, maintenance freezes and durable conservation receipts remain enforced.

Regression coverage exercises the actual post-hand pipeline with a mid-hand plan, mixed move reasons, swaps and an unavailable enumeration. Deployment and live proof are recorded in the task evidence checkpoint.
