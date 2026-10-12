# A frozen engine minute is not a stuck minute (2026-10-03)

Migration: `20261003030700_a_frozen_engine_minute_is_not_a_stuck_minute`.
Law: `tests/a-frozen-engine-minute-is-not-a-stuck-minute.law.test.ts`
(`docs/laws.d/a-frozen-engine-minute-is-not-a-stuck-minute.md`).

## Symptom

Tournament-side CRITICAL drift incidents, 2026-10-01 00:00 -> 2026-10-03
02:20 UTC, that can still recur after the fixes already merged:

- `financial_alerts:fn_ca_tournament_finished_but_not_completed` - 31
  incidents. The last one, 2026-10-02 21:10, named ten Spins/SNGs decided
  20:53:02-20:53:27. Hourly break 20:55:00-21:02:29, release break
  21:05:05-21:12:54, all ten paid 21:12:54-21:13:10. About 20 wall minutes,
  4.6 live minutes. 15:05 and 15:45 are the same shape (release breaks 14:33
  and 15:36 beside the 14:55 hourly break).
- `fn_ca_conservation_sweep:fn_ca_orphaned_running_tournaments` - 2026-10-02
  20:52 named cc4a0294 and a7f0cf4f "no engine has claimed this event, so
  nobody is dealing it". `hand_atomic_commits`: a7f0cf4f committed hands at
  20:52:01, :08, :15, :22, :41, :49, :54; cc4a0294 at 20:52:24, :43, :46 and
  20:54:08. Their tournament lease row was absent for a moment (a manager stop
  releases it before the successor claims it); the `no_lease` branch had no
  dwell on the absence.
- `fn_ca_absent_tournament_players` / `fn_ca_tables_that_cannot_deal` -
  2026-10-02 18:52 was real (engine 1c155771 had stopped running elimination
  and balance; cured by the 19:13 takeover). Both clock wall minutes, so a
  release break reads as stuck time.

The hourly conservation sweep starts at :52 and runs 3-10 minutes
(`cron.job_run_details`, job 233), so its late checks (orphaned, cannot-deal)
evaluate inside the :55 break while their `now()` is still :52.

## Measurements

- Declared breaks (`engine_maintenance_break_log`): hourly :55 -> :00-:04,
  327-588 s; release breaks 340-530 s, six on 2026-10-02.
- Backtest, every non-satellite event COMPLETED 10-01 00:00 -> 10-02 22:00,
  waits >= 15 minutes wall vs live, per hour: 10-02 15h 171 -> 0, 16h 21 -> 1,
  21h 10 -> 0. Every lane-saturation hour still alerts (10-02 18h 386 -> 246,
  19h 631 -> 529; 10-01 20h 695 -> 655).
- Since the cash commission batch fix (10-02 19:15/19:57): about 1,000
  completions an hour, live wait p99 42-107 s, max 4.8 live minutes; the only
  waits over 3 wall minutes straddle a break (decided :52-:54, paid :00-:02).

## Change

- `fn_ca_engine_live_minutes(from, to)`: wall minutes minus declared breaks
  (log intervals plus the break in progress, the latter bounded to 20
  minutes), merged with `range_agg`. Undeclared downtime is live time.
- `fn_ca_tournament_finished_but_not_completed`: pages on 15 LIVE minutes, or
  on max(3 x threshold, 45) wall-clock minutes whatever the breaks. The first
  200 characters of the message are unchanged; context and message carry
  `live_minutes` and `frozen_minutes`.
- `fn_ca_orphaned_running_tournaments`: `no_lease` also needs no hand
  committed on the event's tables for the dwell in live minutes, measured to
  `clock_timestamp()`. `lease_not_renewed` unchanged.
- `fn_ca_absent_tournament_players`, `fn_ca_tables_that_cannot_deal`: wall
  prefilter kept, live condition added.

No severity, schedule, job or money row changes.

## Already fixed, verified live (no change here)

- `Tournament.atomic_finish_refused` (none since 10-02 00:30): #5734/#5735,
  `20261001160953` (transient refusals alert on a streak of 3),
  `20261001225325`.
- `Tournament.atomic_finish_outcome_unknown` (10-02 02:16): `20261002034540`
  (the engine reads legacy fee custody from the database).
- `postHandTasks.leave_pending_failed` (10-01): `20261001160953`; only
  warnings since.
- `ledger_invariant.refused`: one deliberate probe, one fixed by
  `20261002201605_spin_deactivation_names_the_reserve_row`.
- Satellite 65e8497e: `20261003023500`; COMPLETED 02:33:28, winner seated in
  the target with one 200.00 seat award, source tables closed.
