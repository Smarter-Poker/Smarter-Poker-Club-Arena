# Phase 3: one SET clause was costing a quarter of the database

2026-09-02. Started as "why is the Spin wheel still outside Dan's 1-to-3 second
window" and ended somewhere else entirely.

## The Spin question, and why the answer was not in the Spin code

Only **6.1%** of Spins reveal inside the three-second window. p50 11.0s, p90
18.9s - but the best is **1.66s**, so the fast path exists and something is
stealing the rest.

First I checked the metric itself, because optimising against a lying number is
worse than doing nothing. `spin_reveal_lag_ms` is anchored on the `created_at`
of the last `tournament_buyin` debit. Measured across 49 recent Spins, the gap
between that debit and the last seat being taken is **0.00s** - they commit in
the same transaction, exactly as designed. The anchor is honest and the 13.6
seconds is real.

Then I counted the work. Between the third paid seat and the draw there are
seven serial database round trips: three fleet-wide reads in
`discoverSeatFirstStarts` and four per-tournament reads in `start()`. Seven
round trips cannot cost thirteen seconds unless each one costs about two, and
there were **no lock waits at all**. So the round trips were not slow. The
database was.

## What was actually eating the platform

```
get_club_home   40,670 calls · 2,143.8 ms mean · 87,187 s total · 28.0% of ALL database time
```

Inside it, one predicate. `fn_club_home_in_scope` decides whether a table
belongs on a club's home page, and it is evaluated against every live table on
the platform - 1,243 rows on the plan, 1,090 of them immediately discarded.

The function was already the right shape: `LANGUAGE sql`, `IMMUTABLE`,
`PARALLEL SAFE`, a single CASE over six scalar arguments, no table access of
any kind. Postgres should fold that into the calling query and never call it.

**It could not, because it carried `SET search_path TO 'public'`.** A SQL
function with a SET clause is not inlinable: the planner must keep a real
function call so the setting can be established and torn down around each
invocation. One line of hardening, added for a reason that does not apply to
this function, turned a free expression into 1,243 function calls per load.

Proved read-only before changing anything - same query, same rows, the body
pasted in by hand:

|                        |                                               |
| ---------------------- | --------------------------------------------- |
| with the function call | **491.5 ms** (460 ms of it inside the Filter) |
| with the body inlined  | **76.6 ms**                                   |

## Result

Same call, nothing else changed:

| club                                   | before   | after        |
| -------------------------------------- | -------- | ------------ |
| Deep Stack Society (1,090 open tables) | 843.9 ms | **257.7 ms** |
| Midway Union (155)                     | 851.7 ms | **109.0 ms** |
| a club with no tables at all           | 480.9 ms | **12.8 ms**  |
| another with none                      | 288.2 ms | **27.8 ms**  |

Note the third row. A club with _no tables_ was paying 480 ms, because the
count is platform-wide and scope-filtered rather than club-scoped - every
viewer of every club paid for every live table on the platform.

## Why dropping the SET is safe here, and where it would not be

`search_path` exists to stop a caller resolving an unqualified name to an
object they control. **This function references no objects.** Its whole body is
`=`, `COALESCE` and `ANY` over its own parameters, all resolved from
`pg_catalog`, which is always on the path and cannot be shadowed. It is not
`SECURITY DEFINER`, so it runs as the caller and gains no privilege to abuse.

Do not carry this reasoning to a function that reads a table. There the SET is
load-bearing and the call overhead is the price of safety. The law test pins
exactly that distinction: it fails if the body ever grows a `FROM`.

The migration asserts its own inlinability at apply time - SET absent,
IMMUTABLE, cost 1 - and re-checks all four scope answers, because speed must
never buy a wrong page.

## The wider pattern, measured rather than assumed

Nineteen other `IMMUTABLE`/`STABLE`, non-`SECURITY DEFINER`, table-free SQL
functions carry a SET clause and the default cost of 100, so none of them can
be inlined either. I checked before touching any of them: **none is used in an
RLS policy**, which is where a per-row call would explode the same way. They
are called by other functions rather than per row, so the payoff is far smaller
and the risk of nineteen speculative changes is not. Recorded here as a known
pattern, with the query that finds them, rather than fixed on spec.

## What this does and does not do for the wheel

It gives the whole platform - including the engine's seven round trips - a much
faster database to run against. It does not by itself put the reveal inside
three seconds: the seven serial round trips are still seven, and the poll is
still up to a second. The next Spin-specific step is collapsing those four
`start()` reads into one `Promise.all` (they are independent once the debits
read drops its redundant `.in('user_id', …)` filter) and replacing the three
discovery reads with a single RPC. That is engine code, so it lands on the next
deploy rather than instantly.
