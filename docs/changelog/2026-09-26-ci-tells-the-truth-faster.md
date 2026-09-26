# CI tells the truth, faster (2026-09-26)

Phase 7 of the mobile spins programme. Four CI defects measured on the Diamond pull requests (#5242, #5260), each fixed at its cause, plus a visual baseline for the Diamond games. No gate was weakened, skipped or removed; the required check names are unchanged.

## 1. The accounting job was 29.5 minutes of serial suites

**Measured.** `Accounting transactions (PostgreSQL 17)` took 29.8 min (run 36148980089), 28.5 min (36154167205) and 29.5 min (36195659277, job 108270970154). Queue wait was about 2 seconds every time; the time was execution. The job ran about 90 steps one after another on one runner: Full weekly accounting 467s, Spin expiry 198s, BBJ replay 164s, MTT 109s, Diamond SQL acceptance 78s, F06 lanes 76s, and seventy smaller suites. In the same runs Production Build took 3 min, compilation 7 to 9 min, the server shards 3 min each and CSS Beat E2E 18 min, so accounting was the whole critical path of every server-touching pull request.

**Fixed.** `accounting_postgres` is now a four-way matrix (`fail-fast: false`). Every suite builds its own disposable PostgreSQL 17 cluster, so no suite depends on another's state; each step keeps its body, its environment and its evidence upload, and gains only `if: matrix.shard == N`. Shards 3 and 4 build the native isolation tester because their suites use it (its evidence artifact name now carries the shard). BBJ runs in shard 1, and the BBJ deadline probe (`scripts/ci/probes/bbj-bank-replay/funded/current_ci.py`) now reads the job named `Accounting transactions (PostgreSQL 17) shard 1/4`. The required `Server Engine (typecheck + tests)` aggregate still reads `needs.accounting_postgres.result`, which is `success` only when all four shards succeeded.

**Expected after.** About 9 minutes for the slowest shard (shard 1: about 8 minutes of suites plus about 1 minute of checkout and PostgreSQL install; shard 2 about 8.7, shard 3 about 7.7, shard 4 about 7.2, plus 4.5 when the Phase 4 V31 gate runs). The critical path of a server-touching pull request moves to CSS Beat E2E (about 18 minutes). Cost: three more job setups per run, roughly four more billed minutes.

**Routing.** PR #5260 bought the whole accounting job and four server shards with one file, `scripts/dev/diamond-scene-perf.mjs`, a headless Chromium frame-time tool. `scripts/dev/` admits the accounting job because its `test-*.sh` and `probe-*` files are what that job runs. The two Diamond screenshot and perf harnesses (`diamond-test-shots.mjs`, `diamond-scene-perf.mjs`) are now named out of that lane exactly; nothing invokes them from any server or accounting path. Every other `scripts/dev/` path still admits the job, and a harness changed beside a migration or server source still runs it (tests in `tests/unit/diamondGamesCiRouting.test.ts`). Nothing touching `supabase/`, `server/`, money code or the classifier's own inputs was narrowed.

## 2. A duplicate run cancelled the real one and reported a failure

**Measured.** On PR #5242's last push, two pushes of the same commit landed in the same second (push ids 44577774264 and 44577774629, both `before=52a70166e2 after=6a4c6fdc17`), so GitHub opened two `synchronize` runs: 36154166920 and 36154167205. Every pull request workflow doubled, not only CI; nothing in the workflows re-dispatches, and it was the only duplicate head sha in the last 100 CI runs. The concurrency group (keyed on the head sha) had `cancel-in-progress: true`, so the newer run cancelled the older. The cancel reached only the four jobs that had not started, `What changed` among them; every heavy job fails open on `needs.changes.result != 'success'`, so the cancelled run then executed the entire heavy matrix anyway (accounting until 15:50:47), its always() gate reported `FIXTURE_GATE_COMPILATION_REQUIRED` because compilation was `cancelled`, and the surviving run sat pending until 15:51. Push to green: 54 minutes.

**Fixed.** `cancel-in-progress: false`: a duplicate for the same sha now waits and the first run finishes untouched, so no job is cancelled and no gate reads a cancellation. A third event replaces the pending one, which never started a job. The group key is unchanged, so a newer push still cannot kill the run a required check is evaluated against. The double push itself came from outside the repository (the agent tooling pushed the same ref twice); no workflow trigger was wrong.

The fixture gate (`scripts/ci/fixture-native-gate.mjs`) now names a cancelled compilation or native job `FIXTURE_GATE_NO_VERDICT_CANCELLED` and exits 3, the estate's "could not tell" code, instead of calling it a compilation failure. It is never green, and when anything it certifies actually failed, that failure is what is reported.

## 3. The Diamond playfield suite ran with no retry on software WebGL

`tests/e2e/css/diamond-games-playfield.spec.ts` ran with `--retries=0` on SwiftShader, so a timing flake blocked a merge over nothing in the diff. It now has `--retries=1`, like the suites beside it, and writes a JSON report. The next step (`scripts/ci/playwright-flaky-summary.mjs`) names every case that passed only on retry as a `FLAKY (passed only on retry)` warning and in the job summary, and fails the job if the suites reported success without a readable report. A case that fails twice still fails the job.

## 4. A visual baseline for the Diamond games

`.github/workflows/diamond-visual-baseline.yml` runs on pull requests that touch the crash, plinko, games or wheel components, the Diamond pages, the fixture page or the harness. It builds the commit, serves `diamond-test.html`, runs `scripts/dev/diamond-test-shots.mjs` for plinko, crash, crossing and mines at 393 and 1280 through each phase, uploads the PNGs as an artifact and lists them in the job summary. It is informational: not in the ruleset, so it cannot block a merge. It is never silent: `scripts/ci/diamond-visual-baseline.mjs` fails the job, naming the game, when the harness crashes or a game draws no idle frame or too few frames. Local dry run against a served build: 30 frames (plinko 7, crash 8, crossing 9, mines 6) in 105 seconds; against a dead server it failed all four games with named errors.

## Source pins restamped

`scripts/ci/classify-ci-changes.mjs` and `tests/unit/fixtureNativeCi.test.ts` are pinned by the earlybird, legacy-fee, sep8 and full-weekly source bindings, and those two plus `.github/workflows/ci.yml` by `scripts/qualification/cash-native-hosted.manifest.json`. Each current pin moved to the reviewed new bytes with a `restamp_audit` row saying why; the nested binding hashes in the full-weekly binding cascade; historical records are untouched. `python3 scripts/ci/verify-source-bindings.py` checks 759 pins across 15 binding files and all agree; `test_cash_native_pgcron.py` passes 6 cases.

## Pinned

`tests/ci-tells-the-truth-faster.law.test.ts` (registered in `docs/laws.d/ci-tells-the-truth-faster.md`) pins all four. The existing accounting step tests now accept exactly one condition on a suite step, its shard, and nothing else.
