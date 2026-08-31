# The rake law gets an alarm

**2026-08-31 — Phase 2 of the live cash games audit, item 2B**

## What 2B was asked to find

Every live cash table carries `rake_percent = -1.00` and `rake_cap_bb = -1.00`,
which reads like a broken column. It is not. `-1` is `RAKE_INHERIT`, the
documented sentinel meaning "use the published schedule", honoured identically
in three places — `isRakeSet` in `src/config/RakeConfig.ts`, `pick` in
`src/lib/rakeOverride.ts`, and `ServerTableEngineBase.getRakeOverride` — with
`scripts/ci/check-rake-schedule-parity.mjs` already stopping the client and
server copies drifting. The one surface that renders the column raw, the Club
Data page, never prints `-1%`: `ca_club_data_snapshot` converts it back to
`NULL` first (`CASE WHEN COALESCE(t.rake_percent,-1) >= 0 THEN t.rake_percent
END`) and the row only renders when the value is non-null.

There was nothing to fix in the resolution. Verified, not assumed.

## What was actually missing

Nothing asserted that the rake **taken** obeys the rake **resolved**.

Adherence was measured by hand for this audit and it is perfect on the cap. Over
24 hours, across all nine live stakes, the largest rake at each stake equals that
stake's cap to the cent, with zero hands over cap and zero hands over 10% of the
pot:

| stake    | hands  | max rake | cap   | source            |
| -------- | ------ | -------- | ----- | ----------------- |
| 0.1/0.2  | 405    | 3.00     | 3.00  | schedule          |
| 0.25/0.5 | 486    | 3.00     | 3.00  | schedule          |
| 0.5/1    | 752    | 5.00     | 5.00  | schedule          |
| 1/2      | 10,378 | 5.00     | 5.00  | schedule          |
| 2/4      | 749    | 7.50     | 7.50  | schedule          |
| 2/5      | 977    | 7.50     | 7.50  | schedule          |
| 5/10     | 192    | 12.50    | 12.50 | schedule          |
| 10/25    | 119    | 15.00    | 15.00 | schedule          |
| 25/50    | 139    | 20.00    | 20.00 | `nosebleeds` tier |

25/50 has no schedule row and resolves through the tier. That is the design —
the schedule names stakes, the tiers cover everything else — and both are now
seeded in the database so the gap cannot be mistaken for a missing entry.

## But the same pass found a rule being broken

"No flop, no drop" holds on 3,234 of 3,234 flopped hands and on 7,276 of 7,278
unflopped ones. Over 24 hours, **34 cash hands were raked with no board
recorded, 80.75 chips in total**, and they are two different defects:

**19 hands, 9.05 chips — a real rake violation.** Ended preflop, no showdown, at
most three aggressive actions. Two examined in full are unambiguous: a 2/4
heads-up walk (SB posts 2, BB posts 4, SB folds, 2 returned) and a 1/2 PLO4
open-fold. Both pots 4.00, both raked 0.20 — exactly the 5% heads-up rate on a
hand that never saw a flop. `calculateRake` returns 0 when `noFlopNoDrop &&
!sawFlop`, and `noFlopNoDrop` is `true` on every live table, so `sawFlop` was
true on a hand with no flop. The money is small. Being raked on a walk is not.

**15 hands, ~71 chips — a hand-history recording gap.** Reached a showdown, or
ran 6–14 aggressive actions into pots up to 704.00, with `community_cards`
empty. Those hands did see a board; the rake is correct and the history is
wrong. It breaks hand replay for the player, and it silently corrupts any
analysis that asks whether a hand saw a flop — including this one, which is why
the two classes are separated on evidence rather than lumped together.

Neither is fixed here. Both are engine-side and belong with the Phase 3 cash
rule guards. What is fixed here is that they were invisible.

## What changed

`20260831140000_the_rake_law_gets_an_alarm.sql`:

- `ca_rake_schedule` and `ca_rake_tier`, mirrors of `RAKE_SCHEDULE` and
  `STAKES_TIERS`, so the alarm can resolve a cap without a code deploy.
- `fn_effective_rake_cap(sb, bb)` — exact schedule row first, then the tier,
  the same precedence `getRakeConfig` applies.
- `fn_rake_law_violations(interval)` — four kinds, kept apart because they have
  different fixes: `over_cap`, `over_percent`, `no_flop_no_drop`,
  `board_not_recorded`.
- `fn_rake_law_check(interval)` — writes into `ledger_reconcile_log` beside the
  money-integrity checks so there is one place to look. Idempotent by hand id,
  so the self-overlapping window costs nothing and a repaired hand stops
  reappearing on its own. `board_not_recorded` logs at `warning`: it costs a
  player their hand history, not their chips.
- pg_cron `rake-law-adherence-hourly` at `40 * * * *` over a 2-hour window, off
  the `:00` and `:20` marks so it does not queue behind the existing alarms.

DB-side for the same reason the bomb-pot repair is: it cannot drift from an
engine build, and it keeps working through a deploy that — per
`auto-deploy-hetzner.yml`'s drain gate — may report green and ship nothing.

## Verification

- Cap resolution proven against live stakes: 1/2 → 5.0, 10/25 → 15.0 (schedule),
  25/50 → 20.0 and 7/14 → 15.0 (tier fallback).
- The whole migration was executed inside a transaction and rolled back;
  `to_regclass` / `to_regprocedure` confirm production carries none of it yet.
- The violation predicates are the same ones used to produce the counts above
  against live data.
