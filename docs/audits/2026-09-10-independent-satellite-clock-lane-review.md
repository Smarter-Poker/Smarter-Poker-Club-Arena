# Independent exact-K satellite proposal review

Reviewed proposal/evidence commits `33aac7681` and `0b463e71f77f0effa5ccbcd4f8604cf74df7a9e5` in the satellite lane on 2026-09-10. Scope: immutable all-cohort qualification, permission boundaries, live trigger enable states, exact lease freshness after waits, and complete rollback after final receipt verification.

The reviewed proposal records all K still-live qualifiers together, with no manufactured position, elimination sequence or sole winner. It captures exact cohort stacks/table/seat identity, refuses partial target capacity for the cohort, and uses deterministic ordering only to execute transfers. Its original final receipt verifier checks the completed immutable header, each payout and each destination delivery before accepting settlement.

Two concrete defects in the initial proposal/evidence were corrected during review:

1. Preparation checked the manager lease before later target/source/roster/seat waits. The corrected write boundary rechecks exact generation, protocol and fresh database wall time after those locks. The observed-lock negative control accepted an expired owner; the corrected control refused with `40001`, preserving RUNNING and zero boundaries/payouts after rollback.
2. The test called “Last Receipt Failure” raised on header insertion, before any award moved. It was renamed accurately. Three new faults call the unchanged original final receipt verifier, assert fully settled three-payout/600-chip outcomes and the actual cash, target-seat or mixed ticket/seat assets, then raise. The outer cases verify restored source liability and seats, unchanged club balances, and absence of all target registrations, tickets, awards, headers, payouts and qualifiers.

The final native matrix records 23 passing cases and forces deferred constraints before each outer rollback. It includes real `SET LOCAL ROLE service_role` success, real authenticated/anonymous refusals even with a spoofed service JWT claim, service refusal on private payer/verifier entry points, and own-participant authenticated DTO scoping. The seeded 600-chip source liability proves terminal transfer conservation, not original entry collection.

Seven captured live guards remain disabled in the native fixture and the proposal does not upgrade their state. These results therefore do not close the broader financial-certificate enforcement audit.

Deployment is blocked independently of these passing local cases. Production still lacks the reviewed final Stage-B seat-exit wrapper/private core. The migration requires wrapper MD5 `6babe5451efa9bc2bfa12cb0fede27e2`; the captured live body is `486d0e6729de8d518d7faf0c253b65d3`, and `fn_settle_satellite_tournament_seat_exit_core_v2` is absent. The native local-explicit-prerequisites file deliberately supplies that missing prerequisite only inside its disposable environment. Its success is not evidence of a production-ready prerequisite.

Availability observation: the prepared-cohort entry currently takes the lease FOR UPDATE, which fences takeover but also blocks the owner's NO KEY UPDATE heartbeat during later waits. The final freshness refusal protects correctness, but this differs from the existing KEY SHARE request fence and can cause avoidable expiration. The satellite lane has been asked to document or align this explicitly.

Verdict: the two identified correctness/evidence defects are resolved in the inspected native proposal. No production application, Stage-B cutover or complete satellite/financial audit closure is approved by this review.
