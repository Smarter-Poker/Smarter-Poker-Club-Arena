# An Owner Floor Park Is Not An Outage

Migration `20261015222118` (held draft; the owner installs it). It replaces
held PR #7006 (migration `20261015181538`), which was refused at install with
"substituted text is not the derived postimage". Re-derived over the live text
on 2026-10-15 at 22:2x UTC: every preimage md5 still matches, every anchor
occurs once, and every postimage md5 is replace() run read-only on production
over this migration's own text. The pg_temp helper is renamed so it cannot
meet another held body's helper of the same name in one session.

## What Happened

On 2026-10-15 at 16:53 UTC the owner parked the floor for a horse wallet
reset (operation `3d9c1ba1`, seven clubs holding every live cash table), closed
115 cash tables at 17:01, renewed the lease once at 17:41 and resumed at
18:10:56. Play came back at once: 2,665 hands by 18:19, 71 tournaments
RUNNING, both held 17:00 MTTs started.

While the park ran, five pages measured it as an outage:

- `fn_ca_operator_floor_hold_watchdog` raised a critical alert because the
  hold was ten minutes old, although its owner was renewing it;
- `TournamentNeverStarted` counted two MTTs whose start the park refused;
- `SpinFleetProducingNothing` and `SpinUnfilledBacklog` counted Spin boards
  the park refused to start;
- after the resume the watchdog alert stayed open, because nine closes name
  tables that no longer exist and can never be proven resumed.

## The Fix

- `fn_ca_operator_floor_park_holds(club, union)` is the predicate the
  tournament admission guard enforces, read without its locks.
- `fn_tournament_metrics.overdue_start`, `fn_spin_metrics.open_boards` and
  `fn_spin_fill_waits` leave out what the park holds, and count it again the
  moment the hold is gone. A club outside the park pages exactly as before.
- The watchdog pages a hold nobody keeps: a lease that ran out with no renewal
  and no resume (it is released in the same pass), or a hold renewed past 180
  minutes. Its alert resolves once no existing table is still refused.
- `fn_ca_operator_floor_park_share()` reports the share of the cash floor the
  hold refuses. The engine publishes it as `poker_operator_floor_park_share`
  for the fleet rules (separate pull request).

## Proof

`scripts/ci/test-owner-floor-park.py` (native PostgreSQL, workflow
`owner-floor-park.yml`): 27 checks, including the baseline defects on the
exact production text and the derived postimage md5 of every function.
