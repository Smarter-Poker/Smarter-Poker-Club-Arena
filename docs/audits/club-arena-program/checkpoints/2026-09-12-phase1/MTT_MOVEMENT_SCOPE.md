# Explicit MTT balancing, breaking and destination seating scope

The user explicitly emphasized this work on September11,2026: fully audit and enhance MTT table balancing, table breaking, and players moving to and being placed at destination tables. The request includes functionality, optimization and established tournament standards. It reinforces existing complete G2 prompt requirements at lines246,260,273; it does not replace the seven-project program or the G5 foundation gate.

Existing implementation is present at fixed Club Arena source575b9763a2c83f0a9c9e88ae04d5e5b75ac0c35d: TableBalancer.ts, TableBreakEngine.ts, tournamentSeatMoveRpc.ts and named balancing, move-boundary, retirement and seat-authority tests. Their presence does not prove functionality or adequate coverage. Recovered issue4094's historical missing-RPC title is explicitly subject to current delta review, not accepted as a present defect.

G5 remains accountable for stack custody, atomic seat transfer, immutable original move identity and recovery. The lifecycle reviewer owns the bounded movement algorithm/caller audit, with G2 delivery after foundation dependencies pass. The current official standards research has passed independent review0011 and bounded G8 intake. The Durability Evidence support task has advanced to shared Diamond accounting; its completed standards and recovery evidence remain preserved. G8 owns evidence intake, ownership resolution, independent acceptance and progression.

Required acceptance scope:

- Correct balance triggers, donor-table and donor-player selection, destination capacity and seat choice; distinguish a balancing move from a broken-table redistribution.
- Source and destination hand boundaries, blind/button position fairness, antes and owed-blind state, late registration, re-entry, elimination, hand-for-hand and final-table formation.
- One authoritative active seat and one playable stack; no disappearances, duplicate stack creation or transfer through an unresolved hand or settlement.
- Durable original source/destination/player/seat/epoch identity; reservations, simultaneous breaks, conflicting moves, stale owners, retries, lost acknowledgments, disconnects and restarts.
- Source-table retirement only after all required moves are committed and applicable hand/settlement obligations are resolved; recover incomplete original moves without inventing stack values or randomizing destinations again.
- Correct destination rendering, automatic navigation, movement notice, reconnect recovery and the next actual dealt hand for real participants.
- Measure balancing delay, moved-player disruption and work at meaningful field sizes; optimize demonstrated bottlenecks without changing fairness or durability requirements.
- Normal funded tournament progression through multiple balancing/breaking transitions to final results, plus independent interruption cases, exact release provenance and served-state proof. Existing valid tests and repairs are reused before new verification is commissioned.

Published TDA rules inform live tournament practice; G2 explicitly requires comparison with official online operator rules. The reviewed official2026 TDA release was posted September7,2026 even though the main rules page still labels2024. Current online/WSOP comparisons retain differences in balancing, random redistribution, break order and final-table sizes. No universal seating algorithm or new numeric fairness policy is inferred from these differences or a code comment.

Independent client/server/channel reviews0012–0014 have passed bounded source-evidence intake. MTT-CLIENT-001 retains both the pending-read and later-event stale navigation schedules under one callback-lifecycle cause. Existing authoritative parent seat rebuilding, atomic database move receipts and partial-break/retirement protections must be preserved. F18 retains ambiguous positive closed-source stacks as an unresolved recovery obligation; neither arbitrary selection nor stack merging is accepted. P02 remains a fairness-policy gap with a reasoned seat example, not an executed universal-rule violation. Ten fixture files and historical repairs were reviewed without new execution; actual moved-player destination rendering and next-hand eligibility still need proof.

All four support tasks use local reports and ordinary final responses. They must not call outbound status-message tools or request message-send approval. Internal agents use collaboration. No implementation, tournament action, financial test or completed phase is claimed by this scope record.

Independent0017 supplies18 explicit acceptance boundaries in the support task G8-BOOTSTRAP-MTT-REVIEW-0017-matrix.json. Its bounded intake is work/g8/acceptance/bootstrap-mtt-independent0017.json. All18 remain unexecuted acceptance requirements. Independent0019 supports CB011–015, including stale-account AutoSeat callbacks and destinations marked seen before cap/open acknowledgement; authoritative parent seat reconstruction and current-auth checks remain safeguards. Independent0018 qualifies F23–30 and current-owner mapping; neither it nor an MTT continuity certificate proves destination seating or next-hand eligibility.

Root TournamentService full review found only static dormant client balance/merge/final helper calls in the fixed src inventory. Their historical hardcoded choices do not describe the active server MTT system. The real move, destination hand barrier, original receipt, reconnect and table retirement path remains the required enhanced/certified implementation.
