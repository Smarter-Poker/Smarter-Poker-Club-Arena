# Explicit investigation can replace an unverified age-out

The incident action RPC previously changed the explanation of an already resolved
age-out while retaining its unverified disposition. Both resolution triggers
skipped already resolved rows, leaving the linked financial alert open.

The supported explicit resolve now records the existing operator disposition,
requires new cause, correction reference and note when replacing an age-out,
preserves the previous disposition in a new event, and closes only linked
investigating inbox records. The original age-out event remains unchanged.
Exact repeated resolutions return authoritative already-resolved evidence without
another event, push or inbox stamp. Cause validation also protects changed
explanations on resolved rows. Relevant operator consumer failures roll back the
entire action; unrelated historical paths retain their existing behavior.

The real PostgreSQL regression captures the three installed function preimages,
reproduces the contradiction, and checks validation, authorization, historical
event preservation, linked outcomes, rollback, duplicates and grants. It runs in
the existing informational alert workflow. No money, hands, seats, detector
schedule or engine changes are included. Production installation must use the
protected merged migration applier; incident closure follows independent evidence
review and installed-function readback.
