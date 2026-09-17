# Horse Brain decision-read consistency audit

The sequential Phase8–15 audit found three further context defects while checking the real HorseLogic, worker and executor paths. These repairs do not certify the full fifteen-phase program.

## Dealt seats own the observation scope and action order

The live observation scope previously counted players who were not currently sitting out. A three-player hand became a heads-up observation when one dealt player sat out, even though the cards, position and hand population were unchanged. HorseLogic now uses the validated dealt-seat census; a seat explicitly not dealt in is excluded. Legacy offline inputs without a census use their supplied complete dealt list. The same correction preserves a dealt away button in Phase7's action order. Voluntary actors still exclude folded, away and all-in seats.

Before repair, nine per-variant observation tests and one real preflop HorseLogic-to-Phase7 test failed. They now preserve the correct observation bucket and closing-action position. The nine variants are NLH, PLO4/5/6/8, FLO8, FLH, Pineapple and Short Deck. These tests establish census-to-observation wiring; broader scope calibration and natural use remain separate gates.

## A second look retains the original opponent reads

The fast decision's RNG and public input did not freeze HorseMind. Another table could update an opponent's statistics between fast and deep execution, so the second look silently analyzed different opponent evidence. A regression through the real worker and HorseLogic reproduced that change in the actual exploit reader.

After each fast decision, the worker now copies the table's at-most-ten players' pooled/scoped statistics, pair reads and current-hand plans/outlooks. It performs bounded key lookups rather than scanning global memory. The read view contains no observation dedupe or dirty rows. Deep execution enters this private view with observation disabled and plan writes captured; it cannot overwrite newer live reads or persistence state. The sandbox also restores the surrounding scope after success or failure and refuses to cross an active live effect capture.

Read views remain inside the worker, never IPC, health output or telemetry. They are bound to generation, fence, full decision digest, exact captured time and starting RNG. The store holds at most128 views, expires them after60seconds, consumes each view once and clears on shutdown. Duplicate indistinguishable fast identities disable that second look. Missing, expired, evicted, ambiguous or mismatched views produce a recoverable rejection; the existing client/executor retains its original fast action. The copy and retention work are included in the fast compute measurement.

This fixes HorseMind consistency within a running worker. It is not restart replay: source/policy stores, complete effective work, other consumed mutable inputs, full state history and durable executor reconciliation still require their own replay contract. Newer solver stores or a changed resource governor are not pinned by this read view. No historical GTO judgment or learning activation follows from it.

## Execution evidence belongs to its actor and betting round

Execution witness version2 includes the original Horse seat. A controller record with a different seat or street is retained as evidence but marked `unverified`, with `accepted_context_mismatch` and no inferred executed action. Matching action and amount alone are insufficient. A missing actor in a malformed fallback snapshot also remains unverified. Accepted actions emitted before a later callback failure remain accepted; this repair does not authorize another fallback or change financial execution.

## Verification

The pre-repair tests reproduced two witness-context failures, ten dealt-seat failures and one actual second-look read failure. The integrated focused group passes321 tests and the TypeScript build passes. It includes real executor fixtures, real worker/HorseLogic reads, expiry/eviction/reuse/identity errors, scope/effect isolation and FIFO recovery. The first full run found one missing monitoring registry entry; that entry and the prior false completed-versus-declined partition claim were corrected. Final verification passes12,894 tests with157 declared skips across845 passing files and one skipped file; the final TypeScript build passes. Exact source identity is recorded in the owning task's checkpoint.

A10,000-iteration local read-copy measurement on Node22.23.2, macOS arm64, with4,000 pooled rows,16,000 scoped rows,20,000 pairs and8,000 entries in each plan store measured p50=0.035917ms and p99=0.070541ms. A128-view worst populated table sample serialized to5,991,297bytes. This is a bounded copy measurement, not complete worker/fleet or Phase8 latency qualification.

The >10BB daily eligibility audit is installed separately, with all GTO verdicts still unverified until adequate replay/reference evidence exists. Complete source authority, causal proposals/holdout/rollback, the Phase15 durable ledger/restart replay, domain/performance/external gates and qualified native publication remain open. GitHub is prohibited; no publication is claimed.
