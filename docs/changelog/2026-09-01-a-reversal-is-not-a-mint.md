# A reversal is not a mint

2026-09-01. Two defects, both of which made a healthy platform look broken, and
one of which stopped the engine shipping for two hours.

## 1. The chip-supply guard could not tell a reversal from a mint

`fn_ca_supply_snapshot` classified movement across the circulation boundary
asymmetrically:

```
mint = sum(amount) where from_type IN ('system_mint','issuance_reserve')
burn = sum(amount) where to_type   IN ('system_burn','chip_retirement')
```

`chip_retirement` was recognised as a sink and never as a source;
`issuance_reserve` as a source and never as a sink. So the moment anybody
**reversed** a retirement, supply legitimately rose, a ledger row explained
exactly why, and the snapshot booked the whole amount as `unexplained`.

It had never fired because no retirement had ever been reversed. The whole
ledger, at the time of writing:

| direction                       | rows  | amount       |
| ------------------------------- | ----- | ------------ |
| `to_type = 'chip_retirement'`   | 38    | 9,908,714.22 |
| `from_type = 'chip_retirement'` | **1** | 4,159,644.00 |
| `issuance_reserve`, either side | 0     | —            |

That one row is `deep-stack-horse-memberships:restore-20260901`, a hash-chained
reversal restoring 416 Deep Stack Society horse memberships an earlier
quarantine had retired. Both directions were recorded correctly. Only the
accounting had no term for the return trip.

### What it cost

The 12:05 snapshot recorded `unexplained = 4,159,902.13`.
`scripts/ci/check-chip-conservation.mjs` fails above a trailing-4h sum of 5,000,
and that check is the **Financial health-gate** in `auto-deploy-hetzner.yml`. So
from the 10:26 forced deploy onward every engine deploy was refused, the engine
froze, and issue #2435 opened.

The guard was not wrong to shout — supply really did move by 4.16M. The defect
is that it could not distinguish a ledgered reversal from an unbacked mint, and
that distinction is the entire reason it exists.

### The fix

`fn_ca_noncirculating_chip_stores()` names the boundary once. Out of one of
those stores is issuance; into one is retirement. A store cannot now be added to
one side and forgotten on the other.

Verified on the exact interval before applying:

```
delta_vs_prev   4,159,902.13
as shipped      4,159,902.13  unexplained   gate FAILS
corrected             258.13  unexplained   gate passes
```

258.13 sits inside the ordinary noise band — the ten preceding intervals ran
between -954.57 and +44.89. After applying, the real CI script reports
`ok trailing 4h unexplained chip supply 2523.65 (n=5)` and exits 0.

### One thing the dry run caught, recorded because it would trap the next person

Recomputing every historical row from the ledger is the obvious move and it is
wrong. The 10:05 row carries `delta_vs_prev = 9,901,483.86` with `unexplained`
stored as `0` — arithmetic the function cannot produce, so somebody had already
reconciled that interval by hand. A blanket recompute would have reverted their
correction and re-broken the very gate this was unblocking: the dry run put the
trailing 4h at 9,904,007.51 instead of 2,523.65.

The UPDATE and both assertions are therefore scoped to intervals carrying a
movement the old rule could not see. That predicate matches exactly one row.
This migration proves its own work and does not sit in judgement on anyone
else's.

## 2. The engine watchdog was measuring against a deadline that does not exist

`#2343` (2026-08-31) stopped the engine restarting on merge: `auto-deploy-hetzner.yml`
only lets a restart through during scheduled hours — 04, 10, 14, 18, 22
America/Chicago. `engine-watchdog.sh` still used a flat 45-minute grace.

Between the 04:00 and 10:00 windows that is a six-hour stretch in which any
engine commit is behind **by design** and the watchdog fires anyway. It was
guaranteed to raise an issue every morning about a platform doing exactly what
it was told. It also dispatched a deploy on each pass and then wrote "one
automatic retry has been dispatched" into the issue — while outside a window
that dispatch exits in twenty seconds having shipped nothing. An alarm that
states something untrue is worse than no alarm.

The deadline is now the first restart window at or after the commit, plus one
deploy's worth of time, and never sooner than `GRACE_MIN` — strictly more
patient than what it replaced, never less. It dispatches only when a window is
actually open, and the issue body carries the next window.

Checked at the boundaries:

| commit                      | checked at | verdict                                 |
| --------------------------- | ---------- | --------------------------------------- |
| 05:26 CDT                   | 07:20 CDT  | silent — its window is 10:00            |
| 05:26 CDT                   | 10:30 CDT  | alarm — window opened and passed        |
| 10:05 CDT (inside a window) | +15m       | silent                                  |
| 10:05 CDT                   | +50m       | alarm — it had its window and missed it |
| 03:50 CDT                   | 04:40 CDT  | alarm                                   |

The first row is the false alarm that opened #2435 this morning.

## 3. A gate caught me, twice, and was right both times

`check-definer-authorization` blocked the first push: the migration re-declared
a SECURITY DEFINER writer without naming its grants, so a replay on a fresh
database would inherit `anon` and `authenticated`. Production's ACL was already
`{postgres, service_role}` and `CREATE OR REPLACE` preserved it, so nothing was
ever exposed -- but the gate is arguing about the replay, and on the replay it
is right.

Then the new helper came out of `CREATE` holding `authenticated=X` anyway.
Supabase's default privileges grant EXECUTE on every new public function, and
`REVOKE ALL ... FROM PUBLIC` does not touch a grant held by a _named_ role. That
is the same trap the gate's own help text warns about, arriving from the other
direction: the remedy has to name the roles.

Both closed and asserted in `20260902060100`.

## Left alone deliberately

**#2439, the publish watchdog.** Production was 45 minutes behind main on the
client bundle. That is merge velocity, not breakage: pushes land every two to
three minutes against a twelve-minute pipeline, so a queued run is cancelled
while pending and the newest one publishes. The workflow already carries a long
comment block reasoning about exactly this, and it was self-correcting while I
watched (`1067e9a2` -> `d921311e`). It is someone's live tuning problem and not
mine to restructure mid-flight.

**The 10:05 hand-reconciled snapshot row.** See above.
