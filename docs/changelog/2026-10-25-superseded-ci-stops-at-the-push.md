# Superseded CI stops at the push, so the publisher is not starved

## What was measured (2026-10-24/25, GitHub Actions API)

- The account sat at ~176-203 queued runs with ~20 jobs running.
- `Publish Club Arena` published nothing from 21:16 to ~23:15 UTC. It was not
  losing its place: a group-pending publish has no jobs queued, and every
  successful run converges on the tip of main. The time went on the RUNNING
  run's three sequential stages, each waiting for a runner. Run 40142820116
  (created 23:27:35): `publish-needed` waited 19.5 min, its shards and build
  35-45 min, `publish-to-origin` 30.5 min. Push to live: 1 h 47 min.
- 300 pull-request CI runs (2026-10-23 22:07 to 2026-10-25 03:36 UTC) over 152
  branches: 124 were superseded while still alive. In a 70-run sample they used
  348,787 runner-seconds, and 159,019 of those (46%, 2,272 s per run) were
  spent after a newer push of the same branch already existed. By job:
  accounting shards 46,361 s, client shards 19,409 s, server shards 17,003 s,
  compilation 5,744 s, Diamond playfield 5,060 s, CSS beats 4,167 s, build
  1,503 s (time in jobs that STARTED after the newer push).
- A full PR CI run is ~12,000 runner-seconds (accounting 4 shards ~6,100,
  client 4 x ~400, server 4 x ~350, compilation ~600, CSS ~1,000, playfield
  ~690, build ~230). Jobs waited 1,250-3,700 s for a runner.

## Why the existing retire step did not help in time

`ci.yml` keys its group on the PR number and head sha with
`cancel-in-progress: false` (pinned by `tests/ci-tells-the-truth-faster.law.test.ts`:
it is what stopped six PRs being stranded and a duplicate costing 54 minutes).
Its bounded retire step lives in `changes`, so it only acts after the NEW run
gets a runner - the same 25-45 minute queue. And a normal cancel does not stop
`always()` jobs, so every heavy job (all `always() && ...`) kept starting in a
cancelled run; the step needs force-cancel for that.

## What changed

1. **`.github/workflows/ci-supersede.yml` (new).** On `synchronize` it joins
   `ci-<number>-<before>`, the group of the head the push replaced; on `closed`
   the group of the closing head. `cancel-in-progress: true`, `permissions: {}`,
   one job that is `if: false`. Concurrency groups are repository-wide and are
   applied when GitHub creates the run, so the old CI run is cancelled at the
   event, with no runner. `before` is never the head after the push, so the
   current head's run is never in that group; `ci.yml`'s own key is unchanged.
2. **`ci.yml` heavy jobs `always()` -> `!cancelled()`**: `fixture_native`,
   `unit_shards`, `accounting_postgres`, `server_shards`, `css-beats-e2e`,
   `diamond-playfield-e2e`. They still run when `changes` failed (fail open);
   they no longer start inside a cancelled run. The required aggregates
   (`TypeScript Check`, `Client Unit Tests (vitest)`, `Server Engine`,
   `Production Build`, `CSS Beat E2E`) and `What this run verified` stay on
   `always()`: a cancelled run still reports red (`FIXTURE_GATE_NO_VERDICT_CANCELLED`,
   "A shard did not pass (cancelled)"), never skipped-as-green.
3. **`operational-alert-addressing.yml`** PR runs now cancel per PR; its
   `workflow_run` live reader keeps the non-cancelling `live` group.

Expected saving: the ~2,272 runner-seconds a superseded run spent after the
newer push, less what still runs in a cancelled run (five aggregates of a few
seconds each, plus `Production Build` ~230 s when the diff touches `src/`):
about 2,000 runner-seconds per superseded run, ~124 runs a day, roughly 2.4
runners continuously out of a ~20-job pool, and those jobs leave the queue the
moment the push lands instead of after it. Runs of PRs that merge or close are
cancelled at the close.

## What was deliberately not changed

- **ci.yml's group and `cancel-in-progress: false`.** Switching it to a
  per-PR cancelling group would make the next run wait for the cancelled run's
  `always()` aggregates to get runners (a full queue wait per push), and
  gating those aggregates on `!cancelled()` instead would let a cancelled run
  report required checks as skipped, which the ruleset counts as satisfied.
- **Docs-only skipping.** Already done by `scripts/ci/classify-ci-changes.mjs`:
  a PR touching only `docs/**` and `*.md` runs no shard, no accounting, no
  build and no browser job; `docs/laws.d/` and `docs/evidence/` still admit
  their readers. Now pinned. The ungated repository checks (compilation,
  source windows, stub gate) still run for it by design.
- **Shard counts.** Runner-seconds are dominated by test work, not per-shard
  setup (30-60 s), so fewer shards would save little and lengthen every PR.
- **The publisher.** Its pre-publish client suite stays (CLAUDE.md 5 rule 8).
  The tree-reuse proof hit 3 of the last 25 publishes; recording CI's tested
  merge tree would not raise that, because main moved 60-109 minutes between
  a PR's last CI event and its merge in every sampled case. Collapsing its jobs
  would either join the release-secret job to the build/test runner (the
  isolation the publisher exists for) or put a ~27-minute serial suite on one
  2-core runner. Its stages wait on the same queue this change empties.
- **`money-trigger-recovery.yml`**, the trusted reporter of a required check,
  keeps its head-sha group and never cancels.
- The classifier's existing per-file routing for `scripts/**` and
  `.github/scripts/**` (pinned by many routing tests) is unchanged.

Pinned by `tests/superseded-ci-stops-at-the-push.law.test.ts`.
