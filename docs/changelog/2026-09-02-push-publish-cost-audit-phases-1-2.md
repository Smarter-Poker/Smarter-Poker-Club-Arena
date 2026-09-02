# Push/publish cost audit - phases 1 and 2 closeout (2026-09-02)

Full continuation handoff: `docs/HANDOFF-2026-09-02-push-publish-cost-audit.md`.
This file is the changelog pointer required by CLAUDE.md 10.9.

## Shipped (all on main; PR numbers)

- #2599 publisher test gate sharded 4 ways.
- #2619 publisher converges on the tip of main; convergence chain; watchdog
  retries 3x and ignores cancellations; in-app escalation when spent;
  `[skip ci]`-class markers refused at push; `no-commit-left-behind` law
  (21 pins); perf benchmarks measure the code not the machine.
- #2615 post-deploy Playwright job runs on the estate box.
- #2622 `scripts/ci/provision-ci-box.sh` codifies the box (swap, GC, caps,
  sweeper, browser libs, tools).
- #2633 psql on the box + routed-workflow tool audit + vitest default 4 workers.
- #2636 provisioner cannot wipe the crontab.
- #2640 this handoff.

## Box

`estate-ci-1` resized cpx31 -> cpx41 (8 vCPU / 16 GB, Ashburn); eight CA runners
and two WH runners; `VITEST_MAX_WORKERS=4`, 3 GB heap, 8 GB swap, nightly GC.

## Measured

- Worst gap between successful publishes before: 154 min. After: merge to
  live in ~4 min (run #3017).
- vitest full suite: 12.9 min hosted -> 3.1 min on the box (cap 4).
  TypeScript: 2.2 -> 1.0 min.
- Engine-restart theory of publish lag: disproven (45% bad in the window vs
  68% outside).
- CA scheduled runs: ~$47/mo, 69% one job - routed in phase 3.

## Not done

Phase 3 (remaining offload) is drafted in a stash, not shipped. Phase 4
(server-side skip guard, dead-PR detector, conflict-proof law registry),
phase 5 (cashier Reconcile Now dynamic state), phase 6 (measured closeout)
are specified in the handoff.
