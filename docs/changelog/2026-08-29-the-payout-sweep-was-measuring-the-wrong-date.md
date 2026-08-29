# 2026-08-29 — the payout sweep's window was measuring the wrong date

`fn_tournament_payout_sweep` is the safety net under tournament prize money:
prizes are emitted incrementally (places 2..N as players bust, place 1 at
finish), and this is the only thing that ever checks a pool was actually
disbursed in full. It picked its candidates like this:

```sql
AND t.updated_at > now() - make_interval(days => GREATEST(p_days, 1))
ORDER BY t.updated_at DESC
```

**`tournaments.updated_at` is not maintained.** Nothing in the engine writes
it and there is no trigger, so it still holds the moment the row was created.
Measured across the whole table today:

|                                                     |                     |
| --------------------------------------------------- | ------------------- |
| COMPLETED events                                    | 39,338              |
| `updated_at >= ended_at`                            | **0**               |
| `updated_at < ended_at`                             | 39,328              |
| completed in the last 2 days                        | 3,763               |
| …of those, `updated_at` still equal to `created_at` | 3,763 — all of them |

For a scheduled recurring event, row creation is when it went on the calendar.
So "look at the last 30 days" meant "look at events **scheduled** in the last
30 days", and an event scheduled 31 days ago and finished yesterday was
invisible to the one job that exists to catch it.

The narrow every-cycle pass was losing about 77 of 3,763 events, 2%, silently.
The deep pass was losing the ones that mattered: the 38 events repaired this
morning, carrying **11,238.80** of prize money players had earned and never
been given, were every one of them outside a 30-day `updated_at` window and had
never been asked once.

The window is now measured on `coalesce(ended_at, started_at, updated_at)` —
the fallbacks because `ended_at` is null on 10 completed rows, and a row with
no date should still be reachable rather than quietly dropped.

## The second half: a limit that shrinks the window without saying so

`LIMIT GREATEST(p_limit, 1)` binds the **scan**, not the report. A limit below
the window's population turns "30 days" into "the N most recent events" and
then reports zero findings for everything it never looked at — which is the
exact failure this sweep exists to prevent, one level up.

A previous agent knew, and worked around it by passing `p_limit: 40000` by hand
with a comment explaining why. That is knowledge living in the wrong place: it
is true until someone calls the RPC without reading the comment, and the
default is still 50.

So the result now carries `candidates_matched`, `candidates_scanned` and
`truncated`, and `RakebackSettlerService` reports a truncated pass as an error
instead of treating it as a clean one. Verified live:

```
{ days: 2, candidates_matched: 3754, candidates_scanned: 20, truncated: true }
```

The return shape is purely additive — every key the existing caller reads is
unchanged, so the RPC and the service can land independently.

## Not done

`updated_at` is still dead. Giving it a trigger would fix this class of bug
everywhere at once rather than at this one call site, but it also rewrites a
column on a table in the realtime publication, on every tournament write, and
that cost belongs in its own change with its own measurement. Anything else
filtering on `tournaments.updated_at` is still wrong; this fixes the one that
was demonstrably losing money.
