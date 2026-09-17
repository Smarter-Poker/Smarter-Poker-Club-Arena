# Committed-over10BB daily Horse audit

The new Horse-only consumer flags cumulative hand commitment strictly above10BB, including returned uncalled wagers. It reads immutable accepted contribution/refund facts from committed hands and keeps this population separate from the existing absolute20BB win/loss reviews and their tuning denominators. Winners, losers, split pots and refunded bets use the same commitment test.

The new records are eligibility and evidence triage. Every flagged hand has `gto_verdict=unverified`, with unmatched decision-replay and reference reasons. No outcome tag or diagnostic result changes a policy. Full matched replay, counterfactual/reference evaluation, causal proposals and gated corrective learning remain required Phase14 work.

## Actual caller and data path

`horseAdaptiveJournal/worker.ts` passes `processHorseCommittedPotAudit` to the existing isolated loop. One separately bounded turn follows four ordinary journal turns. The service calls only `fn_horse_commitment_audit_step`; neither settlement nor the action-clock worker calls it. Unknown transport or malformed receipts back off this consumer while journal, capture and model work continue. The runtime kill switch is `HORSE_COMMITMENT_AUDIT=off`; an unrecognized value refuses work.

One database transaction owns the diagnostic cursor, review/gap inserts and pass counters. A nonblocking Horse-specific advisory lock serializes consumers without locking source or financial rows. The query reads at most256 source hands per turn, using the existing created-time index and hand-identity lookup. An explicit cursor lower bound prevents rescanning earlier day prefixes when the database caches a generic plan. Stable timestamp/UUID ordering preserves tied page boundaries.

The sweep revisits the last three closed UTC days, with another pass after24hours. A completed pass is not a complete-source watermark. Late visible records are recovered on a subsequent pass; records older than this window, source retention, changing historical horse identity and a missing authoritative complete feed remain explicit coverage limits. Horse identity is read from current `profiles.is_horse`, not invented as an immutable historical fact.

Variant comes from the accepted hand's effective variant, including a bomb-pot override. Cash/HU cash and recognized MTT/SNG/Spin/HU-SNG metadata are partitioned. Unknown tournament metadata remains `tournament_unknown`. Invalid/missing contribution/refund maps, digest mismatches, invalid blinds/rosters and missing identities produce explicit gaps or unknown eligibility. A missing blind is never replaced with1. Changed source cannot overwrite the original review silently.

## Privacy, bounds and receipts

The three private tables deny direct access even to `service_role`; only the bounded function is executable by that role. Anonymous and authenticated clients cannot execute it. The tables contain hand references and diagnostic amounts/reasons, with no private cards or action payloads. Only finite aggregate status crosses worker IPC. Received counters describe acknowledged passes and cannot repair an unknown response or prove source completeness.

The source payload cap is256KiB per hand. The transport deadline is5seconds. Review/gap retention is32days, pruned in chunks of4096, without changing source retention. One pass can produce at most2560 Horse entries. Diagnostic storage and sustained fleet throughput still need natural capacity observation after publication.

## Verified evidence

- Native PostgreSQL fixture:294 source hands; strict10BB boundary; returned wagers; all nine canonical variants; recognized/unknown tournament formats; malformed facts; same-timestamp pagination; late visibility recovery; replay deduplication; source tampering; transaction rollback and role isolation.
- Native load fixture:5,000 ten-Horse source hands plus100,000 older unrelated hands. Three256-hand/2560-Horse turns took98.825ms,88.194ms and89.952ms. This is component evidence, not sustained production capacity.
- Service, loop and parent-worker checks:98 passed. Final server build passed; integrated suite12,866 passed,157 declared skips across844 passing files and one skipped file.
- Database installation: source reservation20260914155815, applied history20260914161209 at16:12UTC. SQL SHA256 `1c763cd40a9b6292f15d03fdb133dad7714a01d81de4e0289a8968a0c83f9c51`; function-body MD5 `0f4895601a3c6bc039de8960ad8e582d`. Native and installed definitions, security-definer/search-path/deadline configuration, RLS and service-only function ACLs match. Do not reapply this migration.

The worker source is still local. The qualified native delivery path, exact served source and natural execution remain unverified. Installation alone does not start this worker consumer, complete GTO review or certify Phase14/15 or the first fifteen phases.
