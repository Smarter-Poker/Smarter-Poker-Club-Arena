# Horse Brain Phase 6D on the Serving Release e6b9dc5d (2026-09-27)

Phase 6D (4 of 4) evidence on the release the engine serves at the time of writing,
`e6b9dc5d472a040a118f537f65203a6cae45ce80` (container `club-arena-engine` started
2026-09-27T20:56:03Z, image `sha256:9ae87ba8cf21`). Horse Brain only. Every status uses the
handoff vocabulary: verified now, historical only, implemented but unverified, defective,
unavailable external input, not applicable with reason. Nothing is averaged into a percentage.
The gate reconciliation document is the coordinator's and is not edited here.

## 2026-09-27: population, replay on the same release, and the 68 incomplete chains

### 1. Declaration before any read

| Fact                             | Value                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Declaration                      | `docs/evidence/phase6d/population-declaration-2026-09-27-e6b9dc5d.json`                                                              |
| sha256                           | `48c3d07fdd2d7a4abfa18e23deaf20b5137fb0d3a82907074352db493d22a913`                                                                   |
| Written from                     | `/health`, `docker inspect club-arena-engine` and the host release audit, read 21:53:00Z; no journal record, segment or hand row     |
| Committed                        | 21:56:14Z (commit `0fb8e33c` on this branch)                                                                                         |
| First record read                | 21:56:22.262Z (first observer run), eight seconds after the commit                                                                   |
| Window                           | 20:57:00Z to 21:55:00Z, one hourly stratum, 400 hands, target 3 per cell, the same 3969 cells as the 2026-09-27 declaration          |
| Admitted release                 | e6b9dc5d only; a3806102 (the previous release) and 6b6eabb1 are rejected by name                                                     |
| Journal state stated before read | `mode=failed`, `termination_unverified` since 21:22:51.994Z on one decision shard; the declaration did not shorten the window for it |

### 2. Population

`node server/scripts/phase6d-population.mjs run --declaration docs/evidence/phase6d/population-declaration-2026-09-27-e6b9dc5d.json --out docs/evidence/phase6d --date 2026-09-27-e6b9dc5d`

The first run (21:56:22Z to 21:56:53Z) and the rerun with the capture marks added below
(22:19:56Z to 22:20:32Z, same declaration) admitted the identical 169 chains: same archive
rowids, decision times, cells and link marks. The committed files are the rerun's; observer image
equals the serving image before and after, qualified execution true both times.

| Count                     | Value                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hands read                | 400 (decisions 21:02:37Z to 21:04:56Z; the archive holds no e6b9dc5d record before 21:02:36Z)                                                                                                 |
| Decision records          | 1510, of them 946 preflop, all by e6b9dc5d; 564 postflop rejected                                                                                                                             |
| Cells                     | 62 observed (cash 13, mtt 20, spin 20, hu_sng 9, sng 0), 3907 unobserved and listed in the JSON                                                                                               |
| Chains admitted           | 169 (spin 55, mtt 52, cash 39, hu_sng 23)                                                                                                                                                     |
| Complete (all five links) | 168                                                                                                                                                                                           |
| Incomplete                | 1: a deep second look whose FAST action stood (`missing:accepted_action:second_look_unchanged`, completed hand `missing:hand_binding:execution_unavailable`); by design, no execution to bind |
| Attribution receipts      | unavailable 96, atlas_evaluated 38, bypassed 35                                                                                                                                               |

Capture continuity over the stratum and a 20,000-row tail: producer 1 archived 185,522 of
sequences 1 to 208,538 (23,016 not archived, first shed 21:08:39.572Z); producer 2 archived
53,858 of 1 to 77,703 (23,845 not archived, first shed 21:08:19.667Z, last record 21:22:49Z).
The walked hands end at 21:04:56Z, before either producer shed anything. A later declaration that
walks 21:08Z onwards will meet the shedding described in section 4.

### 3. G8: replay and latency on the same admitted decisions

`node scripts/phase6c-replay.mjs <export>.ndjson --engine-sha e6b9dc5d472a040a118f537f65203a6cae45ce80 --population ../../p6d-serving/docs/evidence/phase6d/population-2026-09-27-e6b9dc5d.json ...`
(exact line in `docs/evidence/phase6d/replay-2026-09-27-e6b9dc5d.md`). The 169 admitted decision
records were exported read-only by journal event id from the engine-host catalog (0 not found)
and replayed in a detached checkout of e6b9dc5d whose only change is this branch's harness
option `--population`; decision-code files differing between the serving release and the code
that ran: none.

| Verdict                                     | Count |
| ------------------------------------------- | ----- |
| reproduced (action, route, atlas cell, RNG) | 138   |
| diverged                                    | 0     |
| refused `reference_unavailable:chart_store` | 30    |
| refused `replay_unsupported:DECIDE_DEEP`    | 1     |

Independent qualification agreed on 138 and disagreed on none; the owning module was identical
in original and replay on all 138; every reproduced receipt digest equals its original. Of the
130 tournament decisions, 99 reproduced and 31 were refused as above. The 30 chart-store
refusals are chart-route decisions: the chart store is database-hydrated and was not loaded
offline, so it is unavailable external input for those 30, not a pass.

Latency and work per decision are in the JSON. Replay computeMs median 3.86, p95 26.69, max
46.18 (Mac Studio, not a production claim); the original production computeMs journaled beside
the same decisions median 7.37, p95 89.56, max 147.14; every replayed graph visited 8 nodes;
equity samples median 0, max 396. Production telemetry for e6b9dc5d in the window
(`horse_brain_flush_receipts`): 84,594 phase-15 graph decisions, mean
`phase15_node_reference` 9.20 ms and `phase15_node_tournament_utility` 20.07 ms (max 1400.4 ms).

The committed replay JSON has the 400 player-identity fields of the `m_state` covering-opponent
evidence removed; nothing else is changed.

### 4. Diagnosis of the 68 incomplete chains (2026-09-27 population on 6b6eabb1)

Aggregate evidence: `docs/evidence/phase6d/incomplete-chains-diagnosis-2026-09-27.json`.

**Root cause: Horse Brain decision-journal capture loss, not tournament custody.** The journal
publisher (`HorseDecisionJournal.ts`, `record()`) spends a sequence number and then sheds the
record when its queue holds 64 records or 4 MiB (`queue_capacity`). On 6b6eabb1 one decision
shard's publisher had failed at 16:15Z (`retry_exhausted`); from 16:18:28Z the surviving shard's
writer acknowledged about 9 records a second against several times that demand, and shed the
witnesses and completed-hand records of hands the engine committed normally.

Evidence, all counted:

- Database: every hand behind an incomplete chain is in `hand_history` and `hand_atomic_commits`
  with `post_commit_completed_at` set, committed 16:18:40Z to 16:21:27Z (19 + 20 + 13 + 1
  hand/category rows, as are the 49 complete ones). No submission was left retained. The
  frozen-MTT and F06 custody defects (#5477, #5478) did not touch these hands.
- Journal re-read about five and a half hours later: none of the 35 missing witnesses and none of
  the 54 missing completed hands had arrived. They were never archived.
- Sequence continuity in the 2026-09-27 stratum: one producer, sequences 1 to 153,668, 17,589
  archived, 136,079 not archived in 973 holes, the first hole right after 16:18:28.656Z and none
  before it. Every missing-witness decision is at or after 16:18:36Z; every missing-hand chain's
  hand still had records archived at or after 16:18:40Z. No incomplete chain's missing record was
  due before the first hole.
- Telemetry per minute on the surviving shard: `queue_capacity` 320, 905, 1357, 2048, 2883, 2951,
  4441 from 16:19Z to 16:25Z with no writer retry on it; recorded 400 to 800 a minute. From 16:20Z
  to 17:50Z it recorded 2.6k to 5.7k and shed 16k to 55k per ten minutes.
- Same code path later: one capturing shard on a3806102 (18:30Z to 18:50Z) and on e6b9dc5d
  (21:30Z to 22:00Z) recorded up to about 40k per ten minutes with at most a few hundred shed.

Not established: why the 6b6eabb1 writer was that slow. The container is gone and no per-batch
writer latency is recorded. The one known difference is that 6b6eabb1 predates #5415 and ran its
ring at the 500,000-segment ceiling, retiring on appends; releases with #5415 (2,000,000 segments)
did not shed on one shard. The archive stood at 7.77 GB of its 8.59 GB byte bound at 21:56Z and
grew about 0.25 GB an hour since 16:49Z, so the ring will retire on appends again within hours;
whether the writer then keeps up is not measured.

Owner: Horse Brain, phase 15 decision journal. The e6b9dc5d restart storm (both shards replacing
writers after SQLite lock refusals 21:08Z to 21:22Z, then `termination_unverified` stopping one
shard for good at 21:22:51Z) is being fixed in the p6b-serving lane's working tree ("a lock is not
a dead writer": retry in place, per-shard `/health`); it is not merged or deployed at this read, so
this lane does not duplicate it.

Root fix in this lane: the population observer could not tell a shed record from one that was
never produced. `phase6d-population.mjs` now reports each stratum's producer sequence continuity
and marks every chain with when its own producer first shed a record at or after the decision
(`capture`); incomplete chains are tallied by that mark. Each chain also carries its journal
decision id, so the replay can take exactly the admitted decisions (`--population`). Red before:
the three new tests in `phase6dPopulation.test.ts` failed on main (`captureContinuity is not a
function`); green after, 15 of 15.

### 5. Gate status, 6D on e6b9dc5d

| Gate                       | Status                     | Evidence                                                                                                                                         |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 Domain                  | verified now               | 62 declared cells observed on e6b9dc5d (cash 13, mtt 20, spin 20, hu_sng 9), 3907 unobserved and listed; sng never reached                       |
| G2 Inputs                  | verified now               | request link present on 169 of 169 admitted chains; replay rebuilt 168 of 169 exact inputs, 1 deep second look refused by name                   |
| G3 Computation             | verified now               | calculation link 169 of 169; independent qualification agreed 138 of 138 replayed, disagreed 0                                                   |
| G4 Immutable authority     | verified now               | declaration committed 21:56:14Z, first read 21:56:22Z; rerun under the same digest reproduced the same 169 chains; observer image = serving      |
| G5 Reachability            | verified now               | 168 complete five-link chains from e6b9dc5d                                                                                                      |
| G6 Outcome receipts        | verified now               | the 1 incomplete chain names its gap; capture marks name shedding per chain; the 68 of 6b6eabb1 diagnosed to journal shedding with evidence      |
| G7 Independent correctness | verified now               | `phase6dPopulation.test.ts` 15 passed (3 new, red before); the replay verifier imports no production policy module (6C)                          |
| G8 Performance and replay  | verified now               | 138 of 138 replayable admitted decisions reproduced on e6b9dc5d, 0 diverged; 30 chart-store decisions unavailable external input, 1 deep refused |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate                                                                                               |
| G10 Publication and use    | verified now               | e6b9dc5d's own archive, read by its own image, holds 169 admitted natural chains, 168 complete                                                   |

### 6. Limits and open items

- The walked population is 400 hands from 21:02Z to 21:05Z. It says nothing about 21:08Z
  onwards, where both producers shed and one stopped at 21:22:51Z.
- Journal capture on e6b9dc5d: one shard has captured nothing since 21:22:51Z. Until the
  p6b-serving fix is deployed, any later window is partly unobservable, and the population will
  name it through the capture marks.
- The 30 chart-store decisions need the chart store loaded offline with a verified identity
  (the 6C store-identity lane) before they can be replayed.
- Why the 6b6eabb1 writer shed without retries is not established; the approaching byte bound
  is the condition to watch.

## 2026-09-28: population, replay and G7 tests on the serving release 763e4cec, and archive-byte-cap shedding

The release that serves as of this read is `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f` (container
`club-arena-engine` started 2026-09-28T06:55:53Z). It contains the journal lock-retry and
per-shard `/health` fix (#5480), the 6D population tooling used here (#5485), the 6C store
identity and decision-scoped governor scale work (#5490/#5513, already verified on `d37a7de8`)
and journal retirement no longer scanning on retire, with hold budget and self-re-arming capture
(#5505). Horse Brain only. Every status below uses the handoff vocabulary: verified now,
historical only, implemented but unverified, defective, unavailable external input, not
applicable with reason. Nothing is averaged into a percentage. The gate reconciliation document
is the coordinator's and is not edited here.

Separately, and not part of this window: tournament `87a68e55` ("$100 Freeroll - 6:00 AM") has
43 tables frozen since about 12:19Z, a time-bank custody defect owned by other lanes (PRs #5522
and #5527). This lane's declared window starts at 14:12Z, so the frozen tournament's hands are
simply absent from what follows here, exactly as they are absent from the live archive; nothing
below hides, works around or is affected by that freeze.

### 1. Declaration before any read

| Fact                             | Value                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration                      | `docs/evidence/phase6d/population-declaration-2026-09-28-763e4cec.json`                                                                                  |
| sha256                           | `62bf12cfa417e79f450fa53bc3897e06f57b23c9eef733e85ac545623c78a4d0`                                                                                       |
| Written from                     | `/health`, `docker inspect club-arena-engine` and the host release audit, read 2026-09-28T15:08:00Z to 15:11:00Z; no journal record, segment or hand row |
| Committed                        | 2026-09-28T15:14:03Z (commit `c8c40525ed` on this branch)                                                                                                |
| First record read                | 2026-09-28T15:16:55.718Z (population observer start), about 2 minutes 52 seconds after the commit                                                        |
| Window                           | 2026-09-28T14:12:00Z to 15:12:00Z, one hourly stratum, 400 hands, target 3 per cell, the same 3969 cells as the 2026-09-27 e6b9dc5d declaration          |
| Admitted release                 | 763e4cec only; the previous `1c7e99935f` is rejected by name                                                                                             |
| Journal state stated before read | `mode=ready`, no `lastFailureReason`/`failedSince`; capture "2 of 2 decision-shard publishers running" (the #5480/#5505 fix is in this release)          |

### 2. Population

`node server/scripts/phase6d-population.mjs run --declaration docs/evidence/phase6d/population-declaration-2026-09-28-763e4cec.json --out docs/evidence/phase6d --date 2026-09-28-763e4cec`

Single run, 15:16:55.718Z to 15:17:55.389Z. Observer image equals the serving image before and
after (`sameServingIdentityAfter: true`), qualified execution true, not OOM-killed.

| Count                                   | Value                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hands read                              | 400 (no pending-custody or unreadable hands)                                                                                                                                                    |
| Decision records                        | 1,234 scanned; 716 preflop, 518 postflop rejected by street; of the 716 preflop, 327 fell outside the exact window bound and were rejected, leaving 389 in-window preflop decisions on 763e4cec |
| Cells                                   | 64 observed (cash 9, mtt 35, spin 13, hu_sng 7, sng 0), 3,905 unobserved and listed in the JSON                                                                                                 |
| Chains admitted                         | 137 of the 389 in-window decisions (the rest are per-cell overflow beyond target 3, not listed)                                                                                                 |
| Complete (all five links)               | 62                                                                                                                                                                                              |
| Incomplete                              | 75, every one capture-marked `shed_within_60s_of_decision` (none unexplained)                                                                                                                   |
| Attribution receipts                    | unavailable 86 (outside_tournament 25, incomplete_context 35, unsupported_variant 26), atlas_evaluated 21, bypassed 30                                                                          |
| Request / calculation / reference links | present on 137 of 137 admitted chains (all three)                                                                                                                                               |

Capture continuity over the stratum: producer 1 archived 201,071 of sequences 1,539,358 to
1,827,716 (87,288 not archived, 4,501 holes, first shed 2026-09-28T14:12:00.117Z); producer 2
archived 182,997 of 1,536,250 to 1,771,887 (52,641 not archived, 3,011 holes, first shed
2026-09-28T14:12:00.087Z). Both producers shed within the first tenth of a second of the window
opening, not partway through it.

**Root cause of the 75 incomplete chains: the archive is at its configured byte cap, not a
capture-path or writer defect.** At the moment of the read, `archive.storage.archive` reports
`compressedBytes: 8,589,933,656` against `maxBytes: 8,589,934,592` -- 936 bytes of headroom on an
8.59 GB budget (99.99999% full). With the byte bound essentially reached, every new segment the
two producers publish forces an immediate retirement of an old one to stay under budget, so a
freshly captured record can be shed within the same second it was written, well inside the 60
second window `phase6d-population.mjs` checks for `shed_within_60s_of_decision`. This is the
condition the 2026-09-27 e6b9dc5d evidence flagged as a risk ("the archive stood at 7.77 GB of
its 8.59 GB byte bound... so the ring will retire on appends again within hours") and it has now
been reached. It is unrelated to the frozen-tournament custody defect (#5522/#5527) and unrelated
to the 2026-09-27 lock/writer-restart defect fixed by #5480/#5505: both shards report `ready`,
2 of 2 publishers running, no restarts, no `termination_unverified`, throughout this window (see
the 6B `/health` before/after below). All 75 incomplete chains are accounted for by the capture
mark; none is unexplained. This is a capacity/retention condition on the archive's byte bound,
not a Horse Brain decision-correctness defect: 0 of the 137 admitted chains diverged in the G8
replay below, and 0 mismatched.

### 3. G8: replay and latency on the same admitted decisions

The 137 admitted decisions were exported read-only by their journaled `decisionId` (`eventId`)
from the engine-host catalog with a purpose-built exporter (`server/scripts/phase6d-chain-export.mjs`,
added on this branch; it re-walks the same declared strata/hands as the population tool and
collects only the records the population already admitted -- 137 wanted, 137 found on host, 0
missing, same serving identity before and after). None of the 3,905 unobserved cells, and no
record outside the 137, ever left the engine host.

`node scripts/phase6c-replay.mjs /tmp/<export>.ndjson --engine-sha 763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f --population docs/evidence/phase6d/population-2026-09-28-763e4cec.json --out docs/evidence/phase6d --label serving-763e4cec --negative-controls 3 --note "journal capture read 2026-09-28T15:08:26Z: mode=ready, 2 of 2 decision-shard publishers running"`

decision-code files differing between the serving release and the replay code that ran: none
(`decisionCodeDiff.servingToReplay` and `.recordedToReplay["763e4cec..."]` are both empty).

| Verdict                                     | Count |
| ------------------------------------------- | ----: |
| reproduced (action, route, atlas cell, RNG) |   106 |
| diverged                                    |     0 |
| refused `reference_unavailable:chart_store` |    28 |
| refused `replay_unsupported:DECIDE_DEEP`    |     3 |

Independent qualification agreed on 106 and disagreed on none; the owning module (authority) was
identical between original and replay on all 106; every reproduced receipt digest equals its
original. The 28 chart-store refusals are chart-route decisions replayed offline with no
Supabase-hydrated chart store loaded (`chart_store` rows 0 in the replay environment by design,
per the replay protocol's isolation), so they are unavailable external input, not a pass or a
fail -- the same class the e6b9dc5d evidence reported (30 there). The 3 `DECIDE_DEEP` refusals
are a decision type the standalone replay tool does not yet support, also a pre-existing,
unchanged limitation (1 on e6b9dc5d).

Three negative-control families were run this time (not run on e6b9dc5d) to prove the verifier
detects real divergence: `substituted_action` (3/3 correctly diverged with reason `action`),
`substituted_rng` (3/3 correctly refused `rng_stream_mismatch`), `stale_m_state` (3/3 correctly
refused by the independent M-state check, never reproduced). All three families passed 3 of 3.

Latency (Mac Studio, not a production claim): replay computeMs median 3.90, p95 19.79; original
production computeMs journaled beside the same decisions median 5.62, p95 45.62; wall median
4.48, p95 20.05. Every replayed graph visited a median of 8 nodes; equity samples median 0, max 320.

### 4. Diagnosis of the 75 incomplete chains

See section 2 above: the population report's own capture marks (`incompleteByCapture:
{"shed_within_60s_of_decision": 75}`) and the archive's `compressedBytes` sitting 936 bytes under
its 8,589,934,592-byte cap fully account for all 75; none is unexplained, none traces to the
frozen tournament, and none traces to the 2026-09-27 lock/writer-restart defect (both shards
were `ready` throughout, 2 of 2 publishers, no restart). No further per-hand database
cross-reference was needed beyond what the population tool already establishes, because the
capture mark accounts for every incomplete chain without a residual "unknown" bucket -- unlike
the 2026-09-27 population on `6b6eabb1`, whose 68 incomplete chains needed the deeper database
join because a shard had stopped capturing outright.

### 5. Gate status, 6A and 6D on 763e4cec

| Gate                       | Status                     | Evidence                                                                                                                                                                                                                          |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | verified now               | 64 declared cells observed on 763e4cec (cash 9, mtt 35, spin 13, hu_sng 7); sng not reached; 3,905 unobserved and listed                                                                                                          |
| G2 Inputs                  | verified now               | request link present on 137 of 137 admitted chains; v2 context receipts (calculation link) present on 137 of 137, matching their snapshot                                                                                         |
| G3 Computation             | verified now               | calculation link 137 of 137; independent qualification agreed 106 of 106 replayed, disagreed 0                                                                                                                                    |
| G4 Immutable authority     | verified now               | declaration committed 15:14:03Z, first read 15:16:55.718Z, about 2m52s later; observer image = serving image before and after                                                                                                     |
| G5 Reachability            | verified now               | 62 complete five-link chains from 763e4cec; reference link (atlas/attribution) present on 137 of 137                                                                                                                              |
| G6 Outcome receipts        | verified now               | attribution receipts: atlas_evaluated 21, bypassed 30, unavailable 86 (outside_tournament 25, incomplete_context 35, unsupported_variant 26); every incomplete chain names its gap and its capture mark                           |
| G7 Independent correctness | verified now               | `TournamentBrainContextCache.test.ts`, `TournamentBlindSnapshot.test.ts`, `HorsePhase6Tournament.test.ts` on main: 3 files, 91 of 91 passed; replay verifier's 3 negative-control families each caught 3 of 3 planted divergences |
| G8 Performance and replay  | verified now               | 106 of 106 replayable admitted decisions reproduced on 763e4cec, 0 diverged; 28 chart-store decisions unavailable external input, 3 DECIDE_DEEP not supported by the replay tool                                                  |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate                                                                                                                                                                                |
| G10 Publication and use    | verified now               | 763e4cec's own archive, read by its own image, holds 137 admitted natural chains, 62 complete; journal `mode=ready`, 2 of 2 publishers, before and after                                                                          |

### 6. Limits and open items

- The walked population is 400 hands inside one hourly stratum, 14:12Z to 15:12Z. It says
  nothing about hours outside that window.
- The archive is now at its configured byte cap (8,589,933,656 of 8,589,934,592 bytes); both
  producers shed within a tenth of a second of the window opening. This is a capacity condition,
  not a decision-correctness defect (0 diverged, 0 mismatched); raising `maxBytes` or the
  retention policy is an operational decision, not a Horse Brain code change, and is not made
  here.
- Tournament `87a68e55` has been frozen since about 12:19Z (43 tables, time-bank custody defect,
  owned by #5522/#5527) and its hands are absent from this and any later window until that defect
  is fixed. This is named, not hidden.
- The 28 chart-store replay refusals need the chart store loaded offline with a verified identity
  (the 6C store-identity lane) before they can be replayed; unchanged limitation from
  2026-09-27.
- `DECIDE_DEEP` decisions (3 of 137) are not yet supported by the standalone replay tool.

## Correction 2026-09-28: two conclusions above were wrong, and the G5, G6 and G8 statuses change

Written 2026-09-28 at about 19:50Z, against the same release `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f` that the section above describes (still serving at the time of this read: engine `/health` `releaseSha` 763e4cec, `horseJournal.mode` ready, 2 of 2 publishers). The section above is kept as written; this section supersedes its statements in the places named here. Evidence: `docs/evidence/phase6d/incomplete-chains-diagnosis-2026-09-28-763e4cec.json` and `docs/evidence/phase6d/phase6c-replay-serving-763e4cec-stores-2026-09-28T19-43-08-140Z.{md,json}`. Aggregate only; no hand key, player or table id, card or record content.

### C1. The 75 incomplete chains were shed by the producers' queue, not by the archive's byte cap

The section above (sections 2, 4 and 6) attributed all 75 incomplete chains to "the archive at its configured byte cap ... not a capture-path or writer defect". That is wrong, and the first sentence of its own evidence already contradicts it: both producers shed within a tenth of a second of the window opening, and a ring that is full does not refuse a new record, it retires an old one.

- The archive is a ring. Reaching `maxBytes` is its steady state: the oldest published segment outside the evidence hold is retired to make room, and nothing recently captured is lost by that (`heldSegments` 237,613, 1,485,549,598 of 4,294,967,296 hold-budget bytes, `holdTrimmedSegments` 0). The chains the population admitted were all found; what is missing from the 75 was never archived, the finding the 2026-09-27 diagnosis had already made for `6b6eabb1`.
- The records that were not archived are the records the producers refused. Over the declared hour (`collected_at` 14:12:00Z to 15:12:00Z, `source_release` 763e4cec, 104 flush receipts) the two decision-shard publishers counted `phase15_journal_queue_capacity` 142,745 against `phase15_journal_enqueued` 362,935: 28.2% of the 505,680 records offered were refused at the queue. The population's own per-producer sequence continuity counts 87,288 and 52,641, together 139,929, not archived in the same hour, within 2.0% of the refusals (the difference is the receipts' flush boundary against the sequence range). `phase15_journal_lock_retry` was 1,876 and `phase15_journal_capture_unavailable` 580 (14:12:29Z to 14:24:57Z), the same contention at smaller size.
- Cause: every decision-shard writer shared one SQLite archive catalog, so the fleet's batches serialised on one write lock and the 64-record / 4 MiB queue in front of each writer filled and refused. Measured locally, one shared catalog managed 1,368 records per second with a 252 ms p95 batch; one catalog per shard managed 2,204 records per second with 18 ms. The fix is PR #5541 (one archive catalog per shard writer, queue bound 4,096 records / 16 MiB, legacy-bootstrap race closed). It is not on 763e4cec. The section above's "raising `maxBytes` ... is an operational decision" was the wrong remedy for a defect that raising `maxBytes` would not have touched.

The same journal is what 6A/6D (this document) and the 6B route proof read, so the 75 incomplete chains here and the "retained journal records only" caveat on the 6B counts have one cause. It is a Horse Brain capture defect, and 0 of the 137 chains diverged in the replay below because the defect loses evidence, it does not change decisions.

### C2. The 28 chart-store decisions reproduce; only DECIDE_DEEP remains a named exclusion

The section above recorded 28 decisions as `reference_unavailable:chart_store` and called them "unavailable external input" that "need the chart store loaded offline with a verified identity ... before they can be replayed". That was already false when it was written: #5490 and #5513, both inside 763e4cec, load the stores offline by journaled identity (the protocol's sections 11 and 12), and the 763e4cec records carry `solverStoreIdentity`. The replay was run without `--store-snapshot`, so the refusal was the tool being given no store, not an input that could not be had.

Rerun, 2026-09-28T19:43Z, exactly as protocol sections 11 and 12:

- Store rows exported at 19:38:44Z to 19:39:26Z inside `club-arena-engine` by `server/scripts/phase6c-store-export-rows.mjs` (the Mac's database keys are stale), read-only, then passed through the loaders' completeness checks and the production store modules by `phase6c-store-snapshot.mjs --from-rows`: chart store 240 entries `2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf` revision 2026-07-19T15:11:48.555537Z, postflop store 7747 entries `dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d` revision 2026-09-03T18:18:13.594197Z. Both are the identities section 11.1 of the replay protocol pinned and section 12.1 found journaled by d37a7de8, so the stores did not change between then and the read.
- The 137 admitted decisions were re-exported by journaled `eventId` with `server/scripts/phase6d-chain-export.mjs` against the committed declaration (137 wanted, 137 found, 0 missing, observer image equal to the serving image after).
- `node scripts/phase6c-replay.mjs <export> --engine-sha 763e4cec... --population docs/evidence/phase6d/population-2026-09-28-763e4cec.json --label serving-763e4cec-stores --store-snapshot <chart> --store-snapshot <postflop> --negative-controls 3`, run from a checkout of the serving release itself: decision-code files that differ from the serving release, none. No pin file is passed; the journaled digest alone selects the store.

| Verdict                                     | Section above | This rerun |
| ------------------------------------------- | ------------: | ---------: |
| reproduced (action, route, atlas cell, RNG) |           106 |        134 |
| diverged                                    |             0 |          0 |
| refused `reference_unavailable:chart_store` |            28 |          0 |
| refused `replay_unsupported:DECIDE_DEEP`    |             3 |          3 |

All 134 replayed decisions are clean and every receipt digest equals its original; independent qualification agreed on 134 and disagreed on none. The 28 are the chart routes: 13 `chart_open_jam` and 4 `chart_bb_defend` in mtt, 2 and 3 in spin, 3 and 3 in hu_sng, each identified by the journaled chart-store digest. Negative controls on the batch's own records, three each, all passed: substituted action (diverged `action`), substituted RNG (`rng_stream_mismatch`), stale M state (refused by the independent M-state check), a re-signed record naming a different chart store of the same size (refused by name with the true store loaded), the same record with no pin (reproduced by digest alone), the store with one frequency moved at the same entry count (digest `c202612f0c72`, refused by name) and the untampered snapshot reloaded (reproduced). `DECIDE_DEEP` (3 of 137) stays the one named exclusion of protocol section 11.3.

The private exports (store rows, snapshots, the 137-record export) stayed on the archive volume outside the repository and were removed after this run.

### C3. Corrected gate status for 6A and 6D on 763e4cec

Only the rows named here change from the table in section 5 of the 2026-09-28 section above; every other row stands.

| Gate                      | Was          | Now                         | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G5 Reachability           | verified now | defective                   | 62 of 137 admitted chains are complete (five links). 75 are not because the journal refused the records that would have completed them (C1): 51 lack the execution witness for the accepted action, 38 lack the accepted hand, 36 the hand binding. Reachability of the request, calculation and reference links is real on 137 of 137; the outcome half of the chain is not, and a capture that loses 28% of decisions cannot be called reached. Fixed in #5541; unverified. |
| G6 Outcome receipts       | verified now | defective                   | The attribution receipts are counted, but the completed-hand and accepted-action receipts they join to are absent on 75 of 137 chains, every one marked shed within 60 seconds of its decision by its producer. Same cause and same fix as G5.                                                                                                                                                                                                                                |
| G8 Performance and replay | verified now | verified now (strengthened) | 134 of 134 replayable admitted decisions reproduced on 763e4cec, 0 diverged; the 28 chart-store decisions previously counted as unavailable external input reproduce (C2); 3 `DECIDE_DEEP` are the only named exclusion.                                                                                                                                                                                                                                                      |

G1, G2, G3, G4, G7, G9 and G10 are unchanged. The 6B route proof of the same window rests on the same shedding journal: its G5 and G6 rows in `docs/horse-brain-phase6b-route-proof-2026-09-26.md` ("retained records only") are `defective` on 763e4cec for the same reason, see the correction note there.

### C4. What to do next, and what is not claimed

- The target is a release containing #5541 whose own population shows complete five-link chains and capture continuity with no producer drops (`phase15_journal_queue_capacity` and `phase15_journal_lock_retry` near zero at load comparable to 13:00Z to 15:00Z). That is verified in a later section once such a release serves, not here.
- Nothing above changes a decision, a route or a payout; the correction is to what this document said about capture and about what could be replayed.
