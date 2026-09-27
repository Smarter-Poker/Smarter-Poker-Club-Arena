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
