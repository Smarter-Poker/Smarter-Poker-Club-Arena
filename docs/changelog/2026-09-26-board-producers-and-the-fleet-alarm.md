# 2026-09-26 - Board producers measure what they name, and the fleet alarm

Runbook for `MttFleetNotDealing` (infra/monitoring/tournament-rules.yml) and the
record of migration `20260926023322_board_producers_measure_what_they_name`.

## If MttFleetNotDealing fired

Most eligible RUNNING MTTs dealt no hand in 15 minutes: the tournament fleet has
stopped, not one event. In order:

1. `curl -s https://engine.smarter.poker/health` - read `quarantinedTournamentManagers`,
   `tournamentLease` (claimErrors, conflicts) and `leaseCustodyRetained`.
2. `poker_tournaments_owned` against `poker_tournaments_running` on /metrics.
3. `maintenance` in /health: a recovery window (`reason: "Deployment Recovery"`)
   parks tables on purpose; the rule is break-guarded and should not fire inside one.
4. Hand production by event, from the database:
   `SELECT count(DISTINCT tournament_id) FROM hand_history WHERE created_at > now() - interval '15 minutes' AND tournament_id IS NOT NULL;`

## Why it exists

`MttPlayStopped` (poker_mtt_stalled_running > 0) was loaded and FIRING for three
days - 483 five-minute samples, 2026-09-23 02:35 to 2026-09-26 02:30, at 89-116
stalled MTTs - while hand_history shows 2-15 MTT events dealing per 30 minutes
for five days outside three post-restart bursts (09-22 13:00: 104, 09-25 16:00:
32, 09-26 02:00: 80). Around 55 events are permanently stuck (unranked busts,
tables of one), so the stalled count never falls to zero and the alert was
always on. The missing thing was a DENOMINATOR, not a rule.

`fn_tournament_progress_metrics` now returns `progressing_running` (same eligible
population, did deal), the engine publishes `poker_mtt_progressing_running` only
when the database answered (an absent column is "could not tell", never zero),
and the rule alarms on the share: `< 0.25` for 10 minutes with at least 10
eligible events, behind the maintenance break guard.

Threshold derivation (CLAUDE.md 10.84): outage-week share at most 0.13;
healthy after the 02:00 restart 68 / (68 + 60) = 0.53. The `for:` is 10 minutes
because on the outage night recovery windows raised the break guard every 15-45
minutes and a longer wait never survived the gaps.

The rule is inert until BOTH the migration is applied and an engine built from
this change is running. Check with
`curl -s https://engine.smarter.poker/metrics | grep poker_mtt_progressing_running`.

## Production engine behind main - nothing missing

`EngineReleaseGateNeverOpens` fired continuously from 2026-09-19 01:07 to
2026-09-25 13:37 and again from 19:07; `PokerEngineCannotBeReplaced` from
2026-09-25 16:07 (its series first exists on the build that landed then). Both are
loaded (`/api/v1/rules`, 149 rules, health ok) and firing now. The engine being
behind main was alarmed for seven days; what failed was the reader - a critical
that is always on goes to email and the codex inbox, not a phone. Paging is a
World Hub allowlist change (`the-pager-list-is-exactly-six`), an owner decision;
no duplicate rule was added.

## The three producers

1. `fn_tournament_chip_conservation_check` called Sunday Funday Six-Card Closer
   (c7f21a83) -30,000 chip drift (incident 0f8f8cc6). No chips are missing: four
   seated horses hold the 120,000 they were issued; the fifth registration
   (5330edb2, 2026-09-22 14:08, status registered, chips 0, never seated) was never
   issued a stack. The check now subtracts stacks owed to never-seated
   registrations. `fn_ca_tournament_chip_supply` is NOT changed - the
   felt-may-not-exceed-supply guard reads it at seating time. Seat-or-refund for
   that registration is an owner decision and stays open.
2. `fn_ca_absent_tournament_players` could not see a chair never given. It now
   clocks such a registrant from `registered_at`. Measured: exactly one such row
   platform-wide, so the obligation is carried by the absent-players finding.
3. `fn_ca_tables_that_cannot_deal` clocked from the newest seating. Five-Card
   Bounty (6a6d0385) busted to one player per table at 02:15:47 and read as stuck
   for 11,602 minutes; with the newest `left_at` included it reads 18. The
   condition itself is real and still reported.

Each new body was run as a plain query before the migration was written: the
conservation check returns zero rows; cannot-deal returns the same four events
with corrected clocks (1dda107b 602.7 min, not 4,731); absent players returns 60
events / 151 players including c7f21a83.

## Incidents closed in this pass

- 6d571adf and 7cb6829a (blind clock ran while stalled): `verified_remeasured`.
  The source financial_alerts are resolved with restoration migration
  20260923165845 and root fix PR #5140, which is an ancestor of the running build
  778075b4. Re-measured: every sampled RUNNING event whose `level_started_at`
  moved in 3 h without a hand still carries its last dealt hand's blinds.
