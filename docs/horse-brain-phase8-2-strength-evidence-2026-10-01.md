# Horse Brain Phase 8.2 Strength Evidence, 2026-10-01

Horse Brain only. Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason.

Status: **NOT PROMOTED. No qualifying matrix exists yet.** Both blockers of the first attempt are cleared and a Linux matrix ran, but it ran on a league harness with a bounty defect and is superseded (historical only). The full 18-run matrix on the fixed source, the merge commit of [#5786](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5786) (`216a383f389429ca070ff94d19ce5c32a48de4ba`), had not started on the hosts at 2026-10-02T07:05Z. Until it runs and is assembled, there is no qualification file, `PHASE8_PROTECTED_RELEASE_SELECTION` stays `null`, and every Horse decision stays in shadow for Phase 8.

## Verified Now

### The Assembler

`server/scripts/phase8-strength-assemble.mjs` turns the 18 run directories written by `horseTournamentEvaluate.ts` into the P8.2 record. It never plays a tournament and never decides promotion itself: it imports the real `summarizeTournamentPromotion` and `tournamentRunCanPromote` from `server/src/benchmark/HorseTournamentLeague.ts` through tsx.

- **Refuses by name, writes nothing, exits 2** on a missing, duplicate or unexpected run, a missing receipt, a run not in promotion mode, a requested pair count below 1,024, a dirty checkout, a `head` / `sourceSha256` / `sourceFiles` / `serverLockSha256` / continuation version that differs between runs, a `summary.json` or `baseline-verification.json` or `promotionEligible` that does not match its result when recomputed, a run without a host record, or a policy source (`HorseTournamentPostflop.ts`, `HorseTournamentContinuation.ts`, `HorseTournamentFutureHand.ts`, `HorseQualifiedAuthority.ts`) that differs between the runs' head and the assembling checkout.
- **Keeps unfavorable runs.** A run that asked for 1,024 pairs and stopped early is recorded with its completed and missing pairs; the contract marks it not promotable. A run that produced no result is recorded only through `--defective` with a status and reason, and a run that has a result can never be declared defective.
- **Writes** `<out>/strength.json` (contract, source identity, per-run host and exit code, per-run eligible / fired / completed / changed / named refusals / illegal / conservation / truncated / p99 / 99% interval / mean difference / promotable, defective runs, the whole-matrix verdict and reasons, production context, the superseded matrix), copies every result and receipt to `<out>/runs/` in the repository Prettier shape (formatting is the only difference; the parsed JSON is checked identical, and `sourceSha256` of the host bytes and `committedSha256` of the committed file are both recorded), and writes `docs/evidence/phase8/phase8-qualification-<date>.json` with `schema: "horse-phase8-qualification-v1"`, `qualified` (true only when the contract returns `promoted: true` in promotion mode), `sourceSha`, `continuationVersion`, `packId`, `domain`, `policyDigest`, `evidencePath`, `evidenceSha256` and `reasons`, exactly the fields `admitHorseQualifiedAuthority` checks.
- `packId` is `horse-tournament-postflop`. No production module defines a pack id; the value is derived the way `HorseQualifiedAuthority.test-support.ts` does and the file names that source in `packIdSource`. `policyDigest` is `horsePhase8PolicyDigest()` of the assembling checkout, valid for the runs because the policy files are checked identical at the runs' head.
- Same inputs give a byte-identical `strength.json`; an existing record is never overwritten.

Test: `server/src/benchmark/phase8StrengthAssemble.test.ts`, 6 tests. All synthetic runs are fixture mode, so they can never qualify: a complete fixture matrix assembles deterministically with `qualified: false` (and `admitHorseQualifiedAuthority` refuses the file with `evidence_mismatch`); the same runs are refused in a promotion assembly; an incomplete matrix is refused by name; a run stopped short is kept as not promotable; a declared defective run is recorded and a result cannot be declared away; duplicate, mixed-source, shrunk and unhosted runs are refused.

Smoke on real host output (2026-10-01): the 4-pair `--hydrate` fixture run from host A (`/root/p82/smoke-mtt`, mtt, seed 8101101) placed as `mtt-8101101` is refused with `not_promotion_mode:mtt-8101101:fixture/fixture`, `pairs_below_contract` for the manifest and request, and `missing_run` for the other 17; with `--fixture` the same input is refused for pairs and the 17 missing runs. Nothing was written.

### Hosts For The Matrix

Two Hetzner Cloud servers created for this matrix only, Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic, Node v26.10.0, a clean checkout with `npm ci` in `server/`, league children at nice 19 under the qualified Linux launcher. Neither is the production engine host.

| Host | Name                          | Server                                                                                            | Fixed assignment for the fixed-source matrix                                                     |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A    | `horse-league-p82-20261001`   | cpx41, 8 shared vCPU, AMD EPYC-Rome 2.0 GHz, 16 GB                                                | satellite, pko and mystery for all three seeds; spin 8102203 and 8103307 (7 slots, 75 s stagger) |
| C    | `horse-league-p82-c-20261001` | ccx23, 4 dedicated vCPU, AMD EPYC-Milan 2.0 GHz, 16 GB (the production engine host's server type) | sng and mtt for all three seeds; spin 8101101 (4 slots, 90 s stagger)                            |

The assignment was fixed before any result of that matrix existed.

### Useful Completion Under The Unchanged 4 ms Work Budget

| Where                                                      | Eligible | Fired      | Completed  | Main named refusal                    |
| ---------------------------------------------------------- | -------- | ---------- | ---------- | ------------------------------------- |
| Development Mac, P8.1 cold, frozen population              | 181      | 137 to 141 | 137 to 141 | `continuation_operation_budget`       |
| Host A, 4-pair fixture smoke (mtt 8101101)                 | 14       | 0          | 0          | `continuation_operation_budget` 14    |
| Host C, 4-pair fixture smoke (mtt 8101101)                 | 14       | 0          | 0          | `continuation_operation_budget` 14    |
| Production engine host, `horse_brain_telemetry` 2026-10-01 | 3,185    | 416        | 412        | `continuation_operation_budget` 2,325 |

Production counters were read with a read-only SELECT on 2026-10-01 (UTC day counters as of 23:21Z, not a closed day); the other production refusals that day were `context_incomplete` 1,312 and `budget_exhausted` 427. Useful completion under the same 4 ms work budget is far lower on x86 hosts than on the Mac. This is a measured fact; no budget was changed.

## Historical Only: The Superseded 88217ac6 Matrix

The first Linux matrix ran on source `88217ac61335385b6127dbb04b8bcac3bea4a380` on the same two hosts from 2026-10-01T22:21Z until it was stopped at 2026-10-02T05:20Z. Its league harness paid a full bounty to every winner of a split knockout pot (`attributeKnockout` gives each splitter weight 1), so one knockout was paid more than once: mystery runs ended early at the champion residual conservation check (seed 8102203 pair 36 paid 19,000 from an 18,000 pool, on both sides) and PKO returns were overstated on both sides. Fixed in [#5786](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5786). Its 16 league results are kept (Prettier-formatted, both hashes listed) with the per-run numbers and the runs that produced no result in [`evidence/phase8/strength-2026-10-01-88217ac6-superseded/`](evidence/phase8/strength-2026-10-01-88217ac6-superseded/README.md). They carry no verdict.

Measured there and kept as historical observations: across its 10 complete runs every 99% lower bound was at or below 0 (fired 49 to 963 of 4,443 to 20,580 eligible, p99 4.75 to 6.36 ms, no illegal action, truncation or conservation error), and three runs on host C failed solver-store hydration with `supabase_timeout` when four processes hydrated at once; started 90 seconds apart, the same runs hydrated cleanly.

## Historical Only: The First Attempt On The Mac

On 2026-10-01 all 18 runs were launched on the development Mac from source `4948e0ffd527adee5d898426f7abd84be0be09ab` and all 18 were refused before the first paired tournament: the solver-store credential was rejected (`Unregistered API key`) and the league launcher refuses every platform other than Linux. Both blockers are cleared: a dedicated `sb_secret_` key is in the canonical agent credential file, and the two hosts above exist. The 18 refusal receipts stay in [`evidence/phase8/strength-2026-10-01/`](evidence/phase8/strength-2026-10-01/runs/) with [`strength-2026-10-01.json`](evidence/phase8/strength-2026-10-01.json).

## Exact Commands

Per run, on its host (one process, one log, one new output directory):

```text
/root/run-league.sh <objective> <seed> /root/p82/runs/<objective>-<seed> --promotion
# = cd /opt/club-arena/server && npx tsx src/scripts/horseTournamentEvaluate.ts --output=/root/p82/runs/<objective>-<seed> --objective=<objective> --seed=<seed> --promotion
```

Assembly, from `server/` after copying the 18 run directories off the hosts:

```text
npx tsx scripts/phase8-strength-assemble.mjs \
  --runs=<directory with the 18 <objective>-<seed> directories> \
  --hosts=../docs/evidence/phase8/strength-<date>/hosts.json \
  --context=../docs/evidence/phase8/strength-<date>/context.json \
  --superseded=../docs/evidence/phase8/strength-<date>/superseded.json \
  [--defective=../docs/evidence/phase8/strength-<date>/defective.json] \
  --out=../docs/evidence/phase8/strength-<date>
```

## P8.2 Gate Statuses

| Gate               | Status                     | Reason                                                                                                                                             |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | not applicable with reason | Only the NLH single-board tournament domain is implemented; all other domains are refused. The six declared objectives are the full in-domain set. |
| G2 Inputs          | verified now               | Solver-store hydration from the approved project succeeded on both hosts (240 charts, 7,747 postflop cells) with the dedicated secret key.         |
| G3 Calculation     | unavailable external input | The fixed-source matrix has not run; the 88217ac6 results are historical only because of the league bounty defect.                                 |
| G4 Authority       | implemented but unverified | The assembler binds source, policy digest and evidence hash in the exact fields the P8.3 authority admits; no qualifying matrix exists to bind.    |
| G5 Actual use      | not applicable with reason | P8.2 produces offline evidence only; selection belongs to a protected release.                                                                     |
| G6 Outcomes        | unavailable external input | Completed versus named-refusal counts exist only for the superseded matrix.                                                                        |
| G7 Correctness     | verified now               | The assembler's refusals and acceptance are pinned by 6 tests; the league suite passes on the merged tree.                                         |
| G8 Work and replay | implemented but unverified | Frozen seeds and pairs, fixed host assignment and byte-for-byte receipts are in place; p99 evidence for the fixed source does not exist yet.       |
| G9 Promotion       | unavailable external input | No fixed-source matrix result exists. P8.2 does not promote.                                                                                       |
| G10 Publication    | not applicable with reason | Nothing is activated or deployed by P8.2.                                                                                                          |
