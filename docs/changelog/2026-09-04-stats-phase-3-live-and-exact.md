# Stats Page Programme, Phase 3: live from any tab, days in the player's zone, EV coverage watched

Branch `fix/stats-phase-3-live-and-exact`. Programme:
`docs/STATS-PAGE-PROGRAMME-2026-09-03.md` (section 8, phase 3: items 1.4,
1.5, 1.6, 1.15). Two migrations, both applied to production and recorded in
`supabase_migrations.schema_migrations`; one client hook; one engine gauge and
alert.

## What was found

### 1. "Live from any tab" had been dead since 10:11 UTC

The page's cross-tab liveness was a `postgres_changes` subscription on
`ca_hand_player_idx`, filtered to the player's own rows. At 10:11 UTC another
agent's migration (`20260904101140_unpublish_the_index_nobody_subscribes_to`)
removed that table from the `supabase_realtime` publication. It was right
about the cost: 4.5 million change records a day were being decoded out of
WAL for an audience of one page that is rarely open, and the replication slot
was 136 MB behind. It was wrong that nobody subscribed; this page did. From
that moment the subscription could never fire, the channel reported `SUBSCRIBED`
and nothing ever arrived, and a player grinding in one tab with Stats open in
another was back to seeing nothing move.

The realtime shape was the wrong one anyway. It could not be extended to
tournament finishes (item 1.5) without publishing `tournament_players` too,
and it made the platform pay per hand dealt anywhere rather than per stats
page open.

### 2. Day buckets were cut in UTC, then mislabelled

`ca_player_stats_full` grouped the daily series by `date(created_at)`, i.e.
UTC. A Chicago player's evening session was split across two bars. The page
then did `new Date('2026-09-03')`, which every browser parses as UTC
midnight, so west of Greenwich the label came out as the previous day: the
Sep 3 bar read "Sep 2".

### 3. All-in equity coverage was not watched, and the first measure of it was wrong

Item 1.4 asked what fraction of all-in hands carry the engine's all-in equity
(the EV line, "EV Adjusted" and the luck readouts are built from it). First
cut, seats that were all-in before the river and reached showdown: 715 in 7
days, 11 without equity, 98.46%. Reading the eleven against
`hand_history.actions`, ten were a short stack shoving into two opponents who
kept betting a side pot, one of whom folded on the river. That is not an
all-in runout: `HandController.advanceStage` parks the hand and
`broadcastAllInEquity` fires only when fewer than two players can still act,
which is the same rule every tracker applies to all-in EV. Those seats owe
nothing. The one real miss is `7be0defa-271a-4fe7-ace4-3ef4846f1c77`, a
three-way bomb-pot turn runout on 2026-09-01 12:27 UTC (two all-ins, one
covering call, no further action) whose equity broadcast never reached
settlement. One in 711 over the week; the capture is `void`-dispatched and a
runout that settles before the worker returns would look exactly like this.
Watched from here on; a second one in a week will page.

### 4. Sessions were already right

Item 1.6 asked for the session rule to be written down and moved into the
RPC. It already lives there: a new cash session starts after a 45-minute gap
between the player's hands, and session profit is the sum of the hands'
settlements. Verified on the heaviest account: 38 sessions, profit sum equal
to the cash total to the cent. This phase pins the rule in
`tests/stats-phase-3-live-and-exact.test.ts` and states it in the function
comment, so it cannot drift silently.

## What shipped

### `ca_player_stats_pulse(p_user)` and `useStatsPulse` (1.5, and the fix for 1)

The open page asks. The pulse is two index probes, owner-asserted through
`ca_assert_self`: the player's newest hand in `ca_hand_player_idx` and an md5
fingerprint of their `tournament_players` rows (id, status, position, prize,
bounty winnings, eliminated_at), returned as one string. 157 ms measured.
Any finish, prize, bounty or new entry changes it, so tournament results are
live for the first time.

`src/hooks/useStatsPulse.ts` polls it every 8 seconds while the document is
visible, feeds one debounced refetch into the page's existing 2-second window
(the same one the same-tab bus events use), reports a failing poll once and
retries silently. It also owns the tab return, replacing
`useVisibilityRefresh` on this page: a return after less than 30 seconds
polls and refetches only if the pulse moved; a return after longer refetches
once and takes the next sample as the new baseline, so a hand that landed
while away is never fetched twice. A hidden tab costs nothing. Cost scales
with open stats pages, not with hands dealt anywhere.

The dead `postgres_changes` block is gone from `PlayerStatsPage.tsx`, and the
2-second debouncer moved to component scope (`scheduleRefresh`) so both the
bus and the pulse reach the same window. Grants: `authenticated` and
`service_role` only.

### `p_tz` on `ca_player_stats_full` and `ca_player_stats_overview_v2` (1.15)

Both take `p_tz text DEFAULT 'UTC'`; the two-argument signatures are dropped
so PostgREST has one overload to choose. The zone is validated by running
`now() AT TIME ZONE p_tz` inside a `BEGIN ... EXCEPTION` block and falls back
to UTC on any name Postgres does not know; the daily series is bucketed by
`date(created_at AT TIME ZONE v_tz)`; the payload reports the zone it used as
`window_tz` and the contract as `range_tz`. The rolling window itself stays
absolute: only the day labels move.

Probed on the heaviest account before applying: `America/Chicago` produced 10
day buckets where UTC produced 11, with identical totals (377 hands,
-2,603.97), and the rest of the payload was byte-identical. A bad zone name
fell back to UTC. Overview 173 ms.

The page sends `p_tz: resolvedTimeZone()` (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
on both overview calls, and `src/lib/localTime.ts` parses the
`'YYYY-MM-DD'` labels as local midnight (`new Date(y, m - 1, d)`), so the
label is the day the server bucketed.

### EV coverage in the audit, on `/health`, on `/metrics`, and paged (1.4)

`ca_stats_witness_audit` gains `allin_showdown_7d` and
`allin_showdown_without_equity_7d` (two columns on the log table), and
`ca_stats_health()` publishes `evCoverage7d: { allInShowdowns, withoutEquity,
ratio }`. The second migration of the phase
(`20260904224726_stats_phase_3_ev_coverage_counts_runouts_only`) defines the
owed set the way the engine does: all-in before the river, reached showdown,
and no check, bet or raise after the hand's last all-in, read from
`hand_history.actions` by primary key for the ~400 all-in hands a week (990
ms). A hand the pruner has already taken is unknown and counted as neither.
Live after apply: 715 owed, 1 missing, ratio 0.9986; the audit took 14.6 s.

`StatsHealthMonitor` parses it, exposes `poker_stats_ev_coverage_7d` and
`poker_stats_allin_showdowns_7d`, and raises `ClubArenaStatsEvCoverage` when
the ratio is under 0.99 on fifty or more owed seats (resolves above it or on a
quiet week). `infra/monitoring/engine-freeze-rules.yml` carries the matching
`StatsAllInEquityCoverageLow` rule; it deploys only through the manual
`infra/monitoring/deploy.sh`, as before. The 99% bar is the programme's; the
first cut of the measure (98.46%) would have paged, which is why the audit
was refined rather than the bar lowered.

## Tests

- `tests/unit/useStatsPulse.test.ts` (8, fake timers): baseline then change;
  disabled and no-user do nothing; hidden costs nothing and polls on return;
  a return after the stale bar refetches once and re-baselines; a failing
  poll reports once, keeps polling, recovers; unmount stops it and drops a
  late sample; the current `onChange` is called without restarting the poll.
- `tests/stats-phase-3-live-and-exact.test.ts` (17): both migrations (one
  transaction, the pulse's probes and grants, the dropped two-argument
  signatures, `p_tz` validation and bucketing, `range_tz`, the 45-minute
  session rule, the audit columns and the runout-only refinement, the health
  block); the page (pulse wired as owner only, no `postgres_changes`, `p_tz`
  on both calls, local-day labels); the hook's constants and shape; the
  monitor's gauges, thresholds and alert; the Prometheus rule; the manifest
  fragment.
- `server/src/observability/StatsHealthMonitor.test.ts` (+5): parses the
  block and emits the gauges; the live 99.86% raises nothing and resolves;
  raises under the bar once the sample is large enough, never on a quiet week;
  a week with no runouts touches nothing; the first cut's 98.46% would have
  paged.
- `tests/stats-money-exact-and-live.test.ts`: the "live from any tab" pin now
  reads the pulse, with its history in the comment.
  `tests/stats-charts-stay-lazy.test.ts`: the tab-return pin reads the pulse.
- Schema manifest fragment `scripts/ci/schema-manifest.d/stats-phase-3.json`.

## Not in this phase

- Equity for a short stack whose side pot kept betting. The engine prices a
  runout only; pricing the all-in seat against the field at the moment of
  commitment while others still act is a different quantity (the field can
  change), and no tracker reports it. Left as the documented exclusion.
- The one missed runout above is watched, not root-caused: a single event in
  the week, with the capture path `void`-dispatched. If the gauge moves, the
  hand ids are one query away (in the alert text).
