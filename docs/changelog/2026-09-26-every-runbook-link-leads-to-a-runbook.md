# Every runbook link leads to a runbook

2026-09-26.

## What was wrong

`Deploy Monitoring (on infra/monitoring changes)` was red on `main` at its
step "Every runbook link leads somewhere" (`scripts/ci/check-runbook-links.mjs`).
The check was right. Twenty-two alert rules across four files carried
`runbook: https://monitor.smarter.poker/runbooks/<slug>`, nineteen distinct
slugs, and every one answered 404: `*.smarter.poker` is a wildcard to Vercel,
no record sends `monitor` anywhere that runs `infra/monitoring/Caddyfile`, and
no document existed behind any slug in the first place. Re-measured today:
`https://monitor.smarter.poker/runbooks/engine-down` and
`https://engine.smarter.poker/runbooks/03-engine-down` both 404.

The rules were `EngineDown` (alert-rules.yml); `PokerTablesFrozen`,
`PokerTournamentTableNeverStarted`, `PokerEngineCannotBeReplaced` and
`PokerRestartGateHeldByStuckPermit` (engine-freeze-rules.yml, one shared slug);
`SpinDrawFairnessDrift`, `SpinMetricsStale`, `SpinPrizeUnpaid`,
`SpinDrawBookingGapOpened`, `SpinDrawNeverBooked`, `SpinFleetProducingNothing`,
`RakeAttributionBacklog`, `SpinRevealChronicallyLate`, `SpinReservePoolThin`,
`SpinUnfilledBacklog` (spin-rules.yml); and `TournamentNeverStarted`,
`TournamentFleetUnserved`, `TournamentStuckCompleting`,
`TournamentSeatlessPhantoms`, `TournamentCompletedUnpaid`,
`TournamentMetricsStale`, `TournamentLobbyEmpty` (tournament-rules.yml).

## The fix

Not a host. The runbooks did not exist anywhere, so serving the path would
have served nothing. Nineteen runbooks were written under `docs/runbooks/`,
one per slug, each from the alert's expression, the engine code that emits the
metric and the SQL behind it, read from the live database today. Each says what
the alert means, what the expression measures, the first checks (the public
`/health` fields, read-only SQL that was parsed against production with
`EXPLAIN` inside one rolled-back `DO` block), likely causes, what not to do
(no repair job as the fix, no hand-written money rows, money probes only as one
rolled-back block), and where the owning code lives. Every annotation now names
its document as a repo-relative path, the form most rules already used, which
`check-monitoring-drift.mjs` resolves as a file during the build.

Writing them against the live code found three alert descriptions telling the
reader about mechanisms that no longer exist, and those were corrected in the
same change:

- `SpinPrizeUnpaid` said `fn_backpay_spin_unpaid_winners` sweeps every ten
  minutes and would clear the count. The GameServer caller was removed when
  `fn_spin_draw_and_settle_atomic` became the one settlement transaction
  (`docs/BAND-AIDS-REGISTER.md`, TIER 1 section 9). Nothing clears it; a
  standing count is the live path failing.
- `RakeAttributionBacklog` said an engine loop runs
  `fn_repair_tournament_rake_attribution` and
  `fn_backpay_tournament_rake_attribution`. No engine code calls either, and
  both are now read-only counters naming `fn_process_weekly_accounting`.
- `TournamentSeatlessPhantoms` said a seatless-phantom backstop clears these in
  about two minutes. There is no such backstop in the engine any more.

## The checks, made to hold

- `scripts/ci/check-runbook-links.mjs` resolved only http(s) targets and exited
  2 ("the scan is broken") if it found none, which after this change would have
  been the healthy state. It now resolves every runbook target: a repo-relative
  path must name a file here, a GitHub link into this repository is resolved the
  same way, anything else is fetched. It still exits 2 on a scan that finds no
  runbook at all. Proved by pointing `EngineDown` at a missing file: exit 1,
  naming the rule.
- `tests/a-runbook-link-leads-somewhere.law.test.ts` gains two pins: every
  repo-relative runbook exists, and no rule may point at `monitor.smarter.poker`.
  Its vacuity guard now counts every runbook target rather than only http(s)
  ones, which would otherwise have fallen to two and failed.
- `SpinUnfilledBacklog`'s source block is pinned by hash in
  `scripts/ci/check-alert-rules-match.mjs`; the hash and the contract's
  `runbook` field were updated with the annotation, as that script requires.
- `check-monitoring-drift.mjs` named the wrong command as the live fetcher in
  its NOTE line; it now names `check-runbook-links.mjs`.
- The `infra/monitoring/Caddyfile` runbook handler comment and
  `infra/monitoring/engine-01/README.md` no longer claim runbooks are served
  from a host.

## Found while writing them

`SpinUnfilledBacklog` is firing by construction today. At 06:50 UTC
`v_spin_unfilled_waits` held 33 rows. Twenty were ordinary waits under the
30-minute fill policy. Thirteen had a multiplier set and a `jackpot_draw`
booked, no `spin_draw_receipts` row, and had never started; the oldest had
waited 17 days and they held 244.00 in seats. `fn_spin_expire_unfilled`
correctly refuses to cancel a drawn Spin, so those thirteen need their launch
or settlement resolved by their own authority. That is recorded in
`docs/runbooks/spin-unfilled-backlog.md` and is not changed here.
