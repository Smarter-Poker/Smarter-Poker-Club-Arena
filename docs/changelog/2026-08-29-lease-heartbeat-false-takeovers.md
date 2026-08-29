# 2026-08-29 — 204 live tables and tournaments an hour were stopped for a takeover that never happened

## What was happening

`[lease] lost the lease on table <id> — another engine instance has taken it
over. Stopping it here.` — **204 times in one hour**, on a box running exactly
one engine.

Both `ENGINE_LEASE_ENFORCE` (default on) and `ENGINE_TOURNAMENT_LEASE_ENFORCE`
are enforcing, so that message is not a log line. It stops the engine, drops
the table from the state hub, and on the tournament side stops the tournament
manager.

The message was false. Eight table ids the engine reported as stolen at
12:41Z were, in the database at that moment, held by **that very instance**
with a heartbeat **2.8 seconds old**. They had just been renewed successfully.

## Why

`heartbeat_table_leases` returns the rows it updated, and the caller subtracts
that from what it asked about:

```ts
const kept = new Set(data.map((r) => r.table_id));
const lost = tableIds.filter((id) => !kept.has(id)); // "another instance took these"
```

An id goes missing from that result in three situations and only one is a
takeover:

|                                |                                                       |
| ------------------------------ | ----------------------------------------------------- |
| another instance holds the row | the real thing — stop dealing                         |
| **there is no row at all**     | nobody took anything                                  |
| **the holder has gone quiet**  | reclaimable; `claim_table_lease` would grant it to us |

The second is not hypothetical. `claimTable` is deliberately fail-open: when
the claim RPC errors or times out it returns `true` and starts dealing
**without writing a row**. The engine logged **596 `supabase_timeout`s in the
same hour**. Every table that started that way is then reported stolen by a
phantom, once per five-second discovery sweep, forever.

A fail-safe that cannot tell "I could not find my lease" from "someone else
has my lease" is not a fail-safe. It was built to prevent the 2026-08-16
split-brain, and instead it was manufacturing one.

## The fix

`heartbeat_table_leases_v2` / `heartbeat_tournament_leases_v2` return one row
per **requested** id with what is actually true of it — `kept`, `taken`,
`stale`, `missing`. Only `taken` is a takeover. `missing` and `stale` are
re-claims and the table keeps dealing. An id the function does not answer for
at all is treated as reclaimable: silence is not evidence of a takeover.

The v1 functions are untouched and still granted, because the engine running
right now calls them and must keep working until it redeploys.

## The second defect: nothing reaped a dead lease

`release_*_leases` only runs on a graceful shutdown, so every hard-killed
container abandoned its rows permanently. `GameServer` pruned rows older than
**seven days, at boot only** — and deploys land many times a day, so the
tables grew faster than a weekly cutoff shed them.

|                            | live | dead  |
| -------------------------- | ---- | ----- |
| `engine_table_leases`      | 263  | 1,987 |
| `engine_tournament_leases` | 39   | 3,015 |

95% garbage, on a table read on every discovery sweep, from 52 dead instances
going back seven days.

`reap_dead_engine_leases(p_stale_seconds default 3600)` now runs hourly as
well as at boot. An hour is 120x the 30-second staleness window, so a row that
old has already lost every claim it could win and deleting it cannot race a
live engine. The function refuses any cutoff under ten minutes so a caller
cannot delete a briefly-stalled engine's leases out from under it.

Applied and swept once by hand: **2,048 table + 2,933 tournament rows
deleted**, 211 and 128 left, hands still dealing at 260/minute through it.

## Verification

`npx tsc --noEmit` exit 0. Lease suites 32 passed — including four new pins:
a missing lease is not a teardown, a stale lease is not a teardown, an
unanswered id is not a teardown, and only a genuinely `taken` lease reaches
`/health` as a conflict. The two tests that pinned the old subtract-and-guess
behaviour were updated in this same commit, as CLAUDE.md rule 8 requires —
they were pinning the bug.
