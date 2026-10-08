# Horse Brain Phase 14: closure record, October 7, 2026

Horse Brain only. This record closes Phase 14 (accepted-source review and qualified learning: plan packages P14-A, P14-B, P14-C and P14-D of the [completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md)) against production. It uses the maintained gate vocabulary: verified now, implemented but unverified, defective, unavailable external input, not applicable with reason. Nothing is averaged into a percentage.

**Outcome.** Phase 14 is delivered and closed as **inactive by design**:

- The accepted-time roster producer (P14-A), the audit selection receipts and private mapping (P14-B) and the atomic diagnostic publication (P14-C) are built, installed in production and verified on naturally accepted hands.
- The qualified-learning path (P14-D) is built with every selection `null`. It cannot activate until three unavailable external inputs exist: a qualified reference producer, an independent signer and key, and a decision-time corrective applier.
- No live horse decision changed in Phase 14.

Package records and changelogs:

- [P14.1 atomic hand review](changelog/2026-10-07-horse-brain-phase14-1-atomic-hand-review.md) and [split-writer retirement](changelog/2026-10-07-horse-brain-phase14-1-split-writer-retired.md)
- [P14.2 accepted roster](changelog/2026-10-07-horse-brain-phase14-2-accepted-roster.md)
- [P14.3 source selection](changelog/2026-10-07-horse-brain-phase14-3-source-selection.md)
- [P14.4 inactive admission](horse-brain-phase14-4-inactive-admission-2026-10-07.md)

## Delivery and exact source

| Item                                                                          | Identity and installation                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P14.1 (P14-C) atomic hand-review publication                                  | [#6352](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6352), merged `5f768074` 2026-10-07T08:09:50Z. Migration `20261007020953` installed through Apply Merged Migration and read back at 09:12Z (definer, `search_path pg_catalog, pg_temp`, `service_role` only, ledger row present). Engine `/health` served `5f768074` at 10:30Z                                                                                       |
| P14.1 cutover: split writer retired                                           | [#6404](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6404), merged 11:31Z. Migration `20261007103144` installed and read back at 11:32Z: `fn_hhr_rollup_add` ACL `{postgres=X/postgres}`                                                                                                                                                                                                                                  |
| P14.2 (P14-A) roster at settlement + P14.3 (P14-B) audit receipts and mapping | [#6409](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6409), merged 12:19Z; it supersedes [#6394](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6394), which carried the same P14.2 commit. Migration `20261007024757` installed at 12:20Z. Door preimage `ad4eadeb4df8113db0ba2b598d219aaf` read back from production before merge; postimage `a40343a901e12f134f0e876c08f604bd` read back after install |
| Row level security on the roster record                                       | [#6413](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6413), merged 12:58Z. Migration `20261007122326` installed at 13:09Z. Its first attempt at 13:04Z hit its 2 s lock budget behind a separate schema-dump session holding a read lock; it rolled back with no change. It was retried once after that session ended. Read back: `relrowsecurity` true, no API-role privilege                                            |
| P14.3 audit migration                                                         | Migration `20261007075304` (in #6409) was first refused at 12:21:30Z by its own guard, because the roster record lacked row level security; it rolled back with no change. It installed at 13:10Z after #6413. Read back: audit step body md5 `418ef5b18e2470629130e5074790878e` (the reviewed postimage over live preimage `45ffa0eff534e385828b0316bd4268e8`); both new readers `service_role` only; pass receipts table RLS on           |
| P14.4 (P14-D) inactive admission                                              | [#6408](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6408), merged 12:08Z. Engine code only; no live caller imports it                                                                                                                                                                                                                                                                                                    |

## Natural evidence (production, read-only)

- **P14-C.** From the first atomic receipt at 10:01:02Z to 11:32:40Z, 2,567 receipts were written. Every horse hand review created since 10:01:02Z has its receipt and its rollup row; none is missing. After the cutover, `service_role` can no longer call the old split writer.
- **P14-A.** From the install at 12:20:42Z to 12:22:19Z, 1,320 hands were accepted and 1,320 rosters captured, with 0 `unavailable`. Hands kept settling at the normal rate, and the stored payloads and hashes are unchanged by design. By 13:12:15Z, 38,309 hands had been accepted and 38,309 rosters captured, still 0 `unavailable`, including every hand after row level security was enabled at 13:09Z. The live engine container (`68b28e5b`, the #6409 merge, also carrying #6408 and #6404) logged no `HandHistory.accepted_roster_unusable`, `phase14_accepted_roster_refused` or `HorseHandReview.record_atomic` report in the 50 minutes before 13:20Z.
- **P14-B.** The audit step has run on its new body since 13:10Z. The selection-receipt reader, called read-only as `service_role`, returned the real state for 2026-10-04: pass 1 unfinished, cursor at 13:51:14Z of that day, 1,085,184 hands scanned, 227,637 flagged horse reviews, 0 gaps, coverage `not_established`. No pass receipt exists yet. The passes in flight at install began before the receipt columns existed and finish without one by design; receipts start with each day's next pass.

## Defects found and fixed during delivery

- The `ci.yml` source pin in `scripts/qualification/cash-native-hosted.manifest.json` must be restamped by every PR that edits `ci.yml`. Done for #6352 and #6409 with audit entries.
- The P14.3 install guard refused the P14.2 roster table, which had no row level security. The P14.3 fixture had modelled the table with it, so CI passed while production refused. The refusal rolled back with no change. Fixed by [#6413](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6413); the P14.2 qualification passes all 56 assertions with RLS on.
- One accounting shard failure on #6394 came from a pinned Sep 8 Spin reader plan assertion that never loads this work's migrations. It passed on a single re-run, recorded on the PR.

## Gate ledger

| Gate               | P14-A roster at settlement                                                                         | P14-B source selection and mapping                                                                                  | P14-C atomic publication                                                | P14-D references, holdout, admission                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| G1 Domain          | verified now: every accepted hand on every door path; legacy and lightning anchors refused by name | verified now: three closed UTC days; late and missing hands named                                                   | verified now: every flagged horse review                                | verified now: 45 variant/format domains, uncovered domains refused                               |
| G2 Inputs          | verified now: seat generation and `profiles.is_horse` read inside the acceptance transaction       | verified now: accepted rows, lease generation and the protected roster in one snapshot                              | verified now: immutable review identity digest                          | implemented but unverified: no real reference input exists                                       |
| G3 Calculation     | verified now (56 PostgreSQL assertions)                                                            | verified now (58 new checks; 85/24/27 controls unchanged)                                                           | verified now (19 PostgreSQL cases; arithmetic equal to the old writer)  | verified now (catalog, leakage and completeness tests)                                           |
| G4 Authority       | verified now: private, insert-once record; caller roster key refused                               | not applicable with reason: produces no authority; coverage stays `not_established`                                 | verified now: definer door, `service_role` only, old writer revoked     | verified now: every selection `null`; admission refuses before any file read                     |
| G5 Actual use      | verified now (natural: 1,320 of 1,320 captured)                                                    | verified now (natural: the reader returns the real unfinished day state); pass receipts not yet written, see limits | verified now (natural: 2,567 receipts, 0 missing)                       | not applicable with reason: no applier, nothing selected                                         |
| G6 Outcomes        | verified now: captured / unavailable / legacy_missing named                                        | verified now: missing_source, late_arrival, unreadable named                                                        | verified now: applied / replayed / historical_unknown                   | verified now: proposed_inactive only                                                             |
| G7 Correctness     | verified now: spoofing hole closed; forced builder error leaves money byte-identical               | verified now: drift refusals, immutable receipts                                                                    | verified now: lost reply and replay safe; no deadlock under concurrency | verified now: mixed evidence and stale generation refused                                        |
| G8 Work and replay | verified now: replay returns the stored capsule without re-reading profiles                        | verified now: bounded, resumable, read-only                                                                         | verified now: replay after prune is `replayed`                          | verified now: sticky withdrawal, higher-generation rollback                                      |
| G9 Promotion       | not applicable with reason                                                                         | not applicable with reason                                                                                          | not applicable with reason                                              | unavailable external input: qualified reference producer, independent signer, corrective applier |
| G10 Publication    | verified now: installed, read back, natural use                                                    | verified now: installed, read back, engine serving                                                                  | verified now: installed, engine serving, natural use                    | verified now: merged; inactive                                                                   |

## Remaining limits (kept open, not closed by this record)

- The roster is not yet signed as independently qualified evidence; a reviewed signer is an owner dependency.
- The daily audit still classifies by current profile until it adopts the P14-A roster.
- Late arrival is proven only against the previous pass.
- A retained hand finished at table start is still not observed by the journal.
- Historical reviews written by the old split writer keep their unknown rollup status by design.
- The daily audit cannot keep pace with production volume, a pre-existing limit that Phase 14 makes visible rather than fixes. It scans about 425,000 hands a day against about 1.3 million accepted: 2026-10-04 reached 13:51 of its day after about 61 hours. Days therefore leave the three-day window unfinished, and the receipts and the batch now say so explicitly instead of implying coverage. Raising the scan rate would change the audit's batch size and cadence and is not part of this phase.

## Statement

Phase 14 is complete and closed as **inactive by design**. The accepted-source chain (roster at settlement, audit receipts, private mapping and atomic diagnostic publication) is built, installed and verified on naturally accepted hands. The qualified-learning path exists with every selection `null`, and stays unavailable until a qualified reference producer, an independent signer and a corrective applier exist. Horses play exactly as before.

## Audit Of October 7, 2026

Read-only audit of everything Phase 14 built, against `origin/main` at `761aeb8b`, production `kuklfnapbkmacvwxktbh` and the serving engine release `6b1af5c5` (container started 2026-10-07T16:55:48Z). Statuses use the maintained vocabulary.

### Checklist

- **Packages on main.** P14.1 atomic publication (#6352: `HorseHandReview.ts`, migration `20261007020953`, `scripts/ci/test-horse-hand-review-atomic.py`) and its cutover (#6404: migration `20261007103144`); P14.2 roster at settlement and P14.3 receipts and mapping (#6409: migrations `20261007024757` and `20261007075304`, `supabase/handHistory.ts`, `horseAcceptedRoster/acceptance.ts`, the worker boundary, `horseDailyCorrectiveReview/{selection,mapping,transport,source,batch}.ts`, `scripts/horseDailyMappingProducer.ts`); row level security (#6413: migration `20261007122326`); P14.4 inactive admission (#6408: `HorsePhase14Authority.ts`, `horseCorrectiveReview/{domain,candidateCatalog,review,authority,contract}.ts`). Verified now: every file exists on main; no `TODO`, `FIXME`, placeholder or stub left by the work.
- **Producers and consumers (imports and call sites).** `handHistory.ts` calls `readAcceptedRosterReturn` on the door's private receipt and passes only a captured, hand-bound roster to `observeCompletedHand`; the worker rechecks it (`acceptedRosterBindsToHand`) and journals it; `horseDecisionJournal/review.ts` reads it back. `recordHorseHandReviews` makes one `fn_hhr_record_atomic` call; no engine source calls `fn_hhr_rollup_add`, and the only database function that writes `horse_review_rollup` is `fn_hhr_record_atomic`. `selection.ts` and `transport.ts` are consumed by `source.ts` and `batch.ts`; `mapping.ts` by the mapping producer CLI. `candidateCatalog.ts` and `domain.ts` are consumed by `HorsePhase14Authority.ts`, which no non-test source imports, exactly as the P14.4 record declares (no applier exists). Verified now.
- **Selection and authority.** `PHASE14_PROTECTED_RELEASE_SELECTIONS` is frozen with all 45 domains `null`, identical on main and in the served release; `horsePhase14CorrectiveMode` never returns an active mode. Verified now.

### Database read back (production, read-only)

- Migration ledger rows present for `20261007020953`, `20261007024757`, `20261007075304`, `20261007103144` and `20261007122326`. Verified now.
- `md5(prosrc)` of every function each migration defines equals the md5 of the dollar-quoted body in the file on main: `fn_hhr_record_atomic` `161e5883ca636e898463e3957b1b6f45`; `accepted_hand_roster_build` `b7eae333989b74f2fcbb5aec0bc710c9`, `_first` `92f6fb3149144ded050e3b6996d32bd9`, `_guard` `d1b74469f2d61604119409f124d289d1`, `_replay` `7c10c0c753ff08570e077c3afc67ebd9`; `fn_horse_commitment_audit_step` `418ef5b18e2470629130e5074790878e` (the closure's postimage); `fn_horse_commitment_selection_receipt` `24ac066dc355f768b16adb6078a80fd9`; `fn_horse_accepted_source_rows` `e1d69afc3cfb325b6a27510a4092ccc0`; `fn_horse_commitment_audit_pass_immutable` `ad293bf1a915523f12c04a7776e50c4f`. The settlement door's `md5(pg_get_functiondef)` is `a40343a901e12f134f0e876c08f604bd`, the reviewed postimage, and its body calls the roster first-write and replay functions. Verified now: no drift.
- ACLs and settings: `fn_hhr_record_atomic`, the two readers and the audit step are `{postgres=X/postgres,service_role=X/postgres}`, definer, with `search_path` `pg_catalog, pg_temp` (the audit step `pg_catalog, public, pg_temp`); `fn_hhr_rollup_add` is `{postgres=X/postgres}`; the four roster functions are `postgres` only. `smarter_private.accepted_hand_rosters`, `horse_hand_review_receipts`, `horse_commitment_audit_passes` and `horse_commitment_audit_days` have row level security on, no policy and no API-role privilege; the roster and pass tables carry their immutability and no-truncate triggers. Verified now.

### Tests

- Local, fresh worktree of `761aeb8b`: `npx vitest run src/services/HorseHandReview.atomic.test.ts src/engine/theDeadlineClockBelongsToNoTournament.test.ts src/services/supabase/handHistory.test.ts src/services/horseCorrectiveReview src/services/horseDailyCorrectiveReview src/testing/horseRegression/daily src/testing/horseRegression/merged src/engine/HorseQualifiedAuthority.test.ts src/engine/HorsePhase14Authority.test.ts src/engine/HorsePhase10Authority.test.ts src/engine/HorsePhase11Authority.test.ts src/engine/HorsePhase12Authority.test.ts src/services/horseDecisionJournal/lifecycleVersion.test.ts`: 30 files, 1,381 passed, none skipped. Root `tests/unit/horseCi.test.ts` and `tests/horse-accepted-roster-at-settlement.guard.test.ts`: 2 files, 58 passed. Verified now.
- PostgreSQL runners: the scheduled CI run on main [37659059600](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37659059600) ran `test-horse-hand-review-atomic.py`, `test-accepted-hand-roster.py` and `test-horse-commitment-audit.py` in the accounting PostgreSQL 17 shards, all four shards successful. Verified now.

### Publication

`5f768074`, `1cfde06d`, `68b28e5b`, `91c98ed7` and `de0b8a51` are each ancestors of the serving release `6b1af5c5`; every migration is installed and read back above. Phase 14 changed no client file. Verified now.

### Natural evidence today (bounded, read-only)

- **P14-C.** 26,181 receipts from the first at 10:01:02Z to 21:12:31Z. Of the 26,229 reviews written since the first receipt's review id, none lacks its receipt; no receipt lacks its review row or its rollup row. In the 30 minutes to 21:12Z, 1,374 of 1,374 reviews have their receipt. Verified now.
- **P14-A.** From the install at 12:20:42Z to 21:00:00Z, 417,772 accepted `hand_history` rows and 417,772 rosters, every one `captured` (430,152 by 21:13Z, 0 `unavailable`). In the 20 minutes to 21:12Z, 11,898 of 11,898 accepted hands join their roster by table and hand number with the same hand id. Verified now.
- **P14-B.** The selection-receipt reader, called read-only as `service_role`, returns day 2026-10-04 finished at 21:06:15Z: 1,819,891 hands scanned, 390,882 flagged horse hands, 0 gaps, coverage `not_established`, no pass receipt. `horse_commitment_audit_passes` is empty, by design: the passes for 2026-10-04, 10-05 and 10-06 began before the receipt counters existed, and the step writes a receipt only for a pass that counted from its first batch. The first receipt is expected from day 2026-10-07's pass. Pass receipts: implemented but unverified.
- **Engine.** In the 4.3 hours since the container started: no `HandHistory.accepted_roster_unusable` and no `HorseHandReview.record_atomic` report; `horse_brain_telemetry` has no `phase14_accepted_roster_refused` count on 2026-10-06 or 10-07. Verified now.

### Findings and fixes

- **Wiring (fixed).** The worker's authority admission counters for Phases 8 to 13 were taken before telemetry was armed and never reached `horse_brain_telemetry`; the same PR removes the unused destructured binding at the P14.2 worker boundary that `eslint` reported on every run. [#6439](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6439), merged `71ab03df` (2026-10-07T22:42:43Z). Publication: Engine Release run [37697966313](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37697966313) succeeded and the engine `/health`serves`71ab03df`(container started 2026-10-07T22:55:30Z). Verified now in production: at 22:56:31Z`horse*brain_telemetry`recorded all 18`phaseN_authority_worker*\*\_unselected` counters for the first time, 2 each (one per decision worker), and no other state.
- **Documentation (fixed in this record's PR).** The P14.4 record still said its work was not committed, pushed, merged or released; it now carries a dated delivery note naming #6408.
- **Superseded limit.** "The daily audit cannot keep pace with production volume" (Remaining limits) is fixed by [#6432](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6432) (`6b1af5c5`, the serving release): the audit runs on its own clock. Measured today: 613,363 hands scanned in the 4.3 hours since the container started (about 3.4 million a day against about 1.3 to 1.8 million accepted), and 2026-10-04 finished. Verified now.
- No defect, drift, stub, regression or unpublished change was found in the roster producer, the atomic publication, the selection receipts or the inactive admission path.

### Remaining open

- The first P14-B pass receipt: implemented but unverified until day 2026-10-07's pass completes.
- A natural replay of an accepted roster (a retried settlement returning the stored capsule) has not been observed in production: implemented but unverified (source and PostgreSQL tests verify it).
- `horse_hand_review_receipts` is never pruned, by the P14.1 design (a resend after the 30-day review prune must still answer `replayed`); it grows with volume, about 57,000 rows a day at today's rate. Not applicable with reason: a retention bound would change the replay contract and needs its own decision.
- The roster signer, the profile-based audit classification, late arrival proven only against the previous pass, a retained hand finished at table start, historical split-writer rows, and every P14-D external input (qualified reference producer, independent signer, corrective applier) stay exactly as listed above: unavailable external input or implemented but unverified as stated there.

## Audit Identity Basis (October 8, 2026)

Closes the limit "The daily audit still classifies by current profile until it adopts the P14-A roster."

### Delivery

- [#6470](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6470), head `b8d17e56`, squash-merged `4dbbd067` at 2026-10-08T05:20:17Z by the autopilot. Record: `docs/changelog/2026-10-08-horse-brain-audit-accepted-roster-identity.md`.
- Migration `20261008041707_horse_commitment_audit_accepted_roster_identity.sql`, installed through Apply Merged Migration run [37731991443](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37731991443) at 05:23:39Z, one transaction. Its preimage guard held the live bodies read back from production before merge: step `418ef5b18e2470629130e5074790878e`, selection reader `24ac066dc355f768b16adb6078a80fd9`, review page `769ff23dd4d9473a772a78585b12349b`.

### What the audit now does

- `horse_commitment_roster_epoch` names the first accepted roster ever captured (2026-10-07T12:20:42.398511Z). A hand created before it was accepted before the roster existed and is the only hand classified by the current profile.
- From the epoch, a hand is classified only by its own accepted roster, bound by table, hand number, hand id and accepted payload hash. An unavailable, malformed, missing or mismatched roster is named (`accepted_roster_unavailable`, `_invalid`, `_legacy_missing`, `_mismatch`), classifies no horse, and is never replaced by the current profile.
- Day rows, P14.3 pass receipts and both readers name the basis: `current_profile_is_horse`, `accepted_roster` or `current_profile_then_accepted_roster` (a mixed day). Four counters (`roster_identity_hands`, `profile_identity_hands`, `roster_unavailable_hands`, `roster_missing_hands`) sum to the hands scanned, enforced by a CHECK.
- Guards, cursor, receipts, prune, batch 256, `lock_timeout` 2 s and `statement_timeout` 5 s are unchanged.

### Database read back (production, read-only, 05:24Z)

- Step md5 `0f09e8b00b60a88a81452163fe76d097`, definer, owner `postgres`, ACL `{postgres=X/postgres,service_role=X/postgres}`, config `search_path=pg_catalog, public, pg_temp`, `lock_timeout=2s`, `statement_timeout=5s`. Selection reader `705109c742385d8889886b6580343e5f`, review page `fda55f4218c93e1ecc1f87ca79e77ac8`. Epoch row present (table `72453d90...`, hand number 27115089), RLS on. Ledger row `20261008041707` present. Verified now.
- Readers called as `service_role` inside a read-only transaction: `identityBasis` is `current_profile_is_horse` for 2026-10-05 and 2026-10-06 and `current_profile_then_accepted_roster` for 2026-10-07 (the epoch day), from both `fn_horse_commitment_selection_receipt` and `fn_horse_commitment_review_page`. Verified now.

### Natural evidence (production, read-only)

- Day 2026-10-05's pass, begun under the profile-only body, finished at 05:29:58Z on the new body (1,296,015 hands). Its identity counters stay NULL and its basis is `current_profile_is_horse`, as designed for a pass under way at install. Verified now.
- Day 2026-10-06's pass is the first counted from its start: at 05:32:09Z, 3,328 hands scanned, `profile_identity_hands` 3,328, the three roster counters 0, basis `current_profile_is_horse` (the whole day precedes the epoch). Verified now.
- Step duration (`pg_stat_statements`, the PostgREST call of the step): 72 calls between 05:24:23Z and 05:32:14Z, all on the new body, mean 230 ms against the previous body's 251 ms over 23,862 calls; the cumulative maximum stayed 2,432.8 ms, so no call on the new body exceeded it. Inside the 5 s budget with the same margin. Verified now.
- Roster path read-only preview over 2026-10-07 18:00Z to 18:10Z: 9,112 accepted hands, each joins a `captured` roster bound to its hand id and payload hash, 0 missing, 0 mismatched, 0 unavailable, 0 `unknown` seats, and the roster's horse count equals the current profile's in all 9,112. The batch read with the roster join (256 hands, cold) took 198 ms by primary key. Verified now.
- The step classifying production hands by the roster: implemented but unverified. The audit works the oldest unfinished day first at about 2,700 hands a minute; it reaches the rostered part of 2026-10-07 after 2026-10-06 completes (expected later on October 8 UTC), and day 2026-10-08, wholly after the epoch, is created as `accepted_roster` at 00:00Z on October 9. The first pass receipt with identity counters is written when 2026-10-06's pass completes.

### Tests

- `python3 -B scripts/ci/test-horse-commitment-audit.py` (PostgreSQL 17.11): 7 jobs pass, including the new `roster-basis.sql` (40 checks: roster-classified hand, profile changed after acceptance follows the roster, pre-roster hand falls back and is named, unavailable roster named, mixed day) and the retained 85, 24 and 58 controls on the new bodies, with refusals on no roster, header drift, body drift, reader drift and repeat. Run on the PR in the accounting PostgreSQL 17 shard 3 of CI run [37728982261](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37728982261), successful. Verified now.
- Server vitest `src/testing/horseRegression/daily src/services/horseDailyCorrectiveReview`: 8 files, 224 passed. Root `tests/unit/horseCi.test.ts tests/horse-accepted-roster-at-settlement.guard.test.ts`: 2 files, 61 passed. `tsc --noEmit` clean. Verified now.

### Remaining open

- Production classification by the accepted roster and the first identity-counted pass receipt: implemented but unverified, for the reason and times above.
- Every other limit listed in this record is unchanged.
