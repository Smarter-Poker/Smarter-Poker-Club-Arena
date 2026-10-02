# 2026-10-01: two deterministic reds in Post-Deploy E2E

Run 36803327636 (`Post-Deploy E2E (production)`, live `ca_sha` 369057c5f9)
failed `Client browser verification`: 352 passed, 4 failed. Two of the four
failures were not about timing. Each one gives the same answer on every run, so
a rerun cannot clear it.

## 1. Club Data: agent and downline names were under the touch floor across

`tests/e2e/club-data-deep.spec.ts:150` measured the live page at 390px. It
found every drillable agent name in the Rake Snapshot panel 44px tall but
narrower than 44px across: EarlI 27, Waffle 36, RaySA 37, Sam02 39, DrWolf 40,
Giaruiz 41, Lake13 42, and more.

Cause: `.drillIn` and `.drill` in `RakeSnapshotPanel.module.css` declared
`min-width: 0`. #5112 put both floors on every other control in that file. It
left these two out because `tests/unit/clubDataTouchTargets.test.ts` said they
"take their width from the row they sit in". They do not. Each one is a flex
child of `.rowName` and gets its width from its own text, so a short name is a
narrow target.

Fix: both rules now carry `min-width: 44px`. The unit test now checks both
selectors on both axes. It fails on the old CSS and passes on the new. A name
longer than 44px is unchanged. It still truncates with an ellipsis inside the
row.

## 2. Daily Missions settlement: the fixture recorded a paid milestone the way no paid milestone is recorded

`tests/e2e/daily-missions-database-settlement.spec.ts:488` expected
`milestoneDiamonds: 0` on the first prior claim. Production returned
`milestoneDiamonds: 10, diamondsCredited: 32`, and the wallet moved by the same 32.

Cause: since #5680 (`20260930233000`), `fn_award_daily_mission_milestones`
counts a milestone claim as paid exactly when the journal holds a credit under
`daily_mission_milestones:<user>:<run>:<days>`. Any other claim is an owed
debt, and the next claim pays it. The spec's historical fixture inserted a
claim row (777 days, 10 Diamonds) but journaled its 15 Diamonds under
`daily-missions-historical-multiplier:<run>`. By the live contract that claim
was unpaid, so the live path paid it. Production behaved correctly. The
fixture described a state production never has.

Measured on production: 2,491 milestone claims with a reward, all with a
journal credit under their own reference. There are 2,491
`daily_mission_milestone` journal rows, and every one has the
`daily_mission_milestones:` prefix. No other reference shape exists. So there
is no real historical row to double-pay.

Fix: the fixture now journals the historical milestone under
`daily_mission_milestones:<user>:<run>:777`, the reference the live path reads
as paid. The multiplier metadata (raw 10, actual 15, 1.5x) is unchanged. No
assertion was loosened. The spec still requires `milestoneDiamonds: 0` on
every prior claim and exactly two milestone journal rows after day seven.

## The other two failures

`production-cashier-statements.spec.ts:41` (totals RPC returned 500) and
`production-daily-missions.spec.ts:310` (60s wait for the balance refresh)
both ran in a minute of heavy database load. At 02:30 UTC there were 170
statement timeouts. They are covered by the rerun of the same SHA and are
reported separately.
