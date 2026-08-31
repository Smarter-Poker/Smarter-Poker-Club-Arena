# 2026-08-31 — Phase 3: the rakeback settler was not slow, it was asked an O(week) question every page

Agent: Claude (Cowork). Phase 3 of the completion plan. Migration
`rakeback_recompute_reads_a_daily_rollup` applied via Supabase MCP; repo copy
in `supabase/migrations/`.

## The symptom, and why the daemon was innocent

`fn_union_treasury_selftest` had been reporting `rakeback_settler_lagging` for
a day: cursor stuck at 2026-08-30 05:37, backlog 22,611 rows at diagnosis and
**32,674 by the time this shipped**, ~574 arriving an hour. Every cycle logged
the same thing:

```
[RakebackSettler.period_recompute] fn_rakeback_recompute_periods failed
  for fade0000… 2026-08-24: Error: supabase_timeout
[RakebackSettler] Settled 0/221 period rows from 999 hand records
  in 67838ms (failures: 221)
[RakebackSettler.period_recompute_failures_hold_cursor] holding the watermark…
```

The settler was doing exactly the right thing. It refuses to advance past
records it could not settle, because `rake_generated` selects the rakeback tier
(5/10/15/20/30%) and a period computed from partial data can pay a player a
whole band low. **That refusal is correct and is untouched.** The bug was that
the question could not be answered in time.

## What the question actually cost

`fn_rakeback_recompute_periods` rebuilds a `(club, week)` **from source** —
the right design, and itself the fix for an older bug where incrementing
`rake_generated` double-counted on every engine restart. But the settler calls
it once per `(club, week)` **per page** of 1,000 `rake_records`, and one week of
the busy club is **274,783 records**.

Measured: **28.4 seconds for a single club-DAY** through the old path, so the
week ran ~400s. The engine's client deadline is 60s — and 15s before the outage
widened it. It could never have succeeded.

The old body called `fn_rake_shares_for_record` once per record through a
LATERAL, and that wrapper reads `rake_attributions` **twice per hand** (once to
read it, once for its own `NOT EXISTS`).

## Two changes, in order of size

**1. Set-based shares.** Read the attribution ledger as ONE grouped join, and
fall back to `fn_allocate_rake_credits` only for hands the ledger does not
cover — the same precedence the wrapper applies, and still the single source of
the share math, never re-derived. ~400s → **54s**.

Proven identical before shipping, not assumed:

| window           | users | old cents | new cents | users differing  |
| ---------------- | ----- | --------- | --------- | ---------------- |
| 6 hours          | 406   | 595,843   | 595,843   | **0**            |
| full day (08-24) | 564   | 6,089,636 | 6,089,636 | — (totals equal) |

**2. A daily rollup — this is what made it fit.** 54s is still most of a 60s
deadline and all of a 15s one. A week is now the sum of its days:
`rakeback_daily_user` holds integer cents per `(club, day, user)`, a day is
recomputed from source only when its record count has changed
(`rakeback_daily_state.rows_seen`), and the weekly figure is a trivial
aggregate over seven small rows.

Cents are integers and addition is associative, so summing days then the week
is **exactly** summing the week. The rollup is derived data with no authority —
drop it and the next call rebuilds it from `rake_records`.

Measured after:

| operation      | before | after                     |
| -------------- | ------ | ------------------------- |
| one club-day   | 28.4s  | **4.6s**                  |
| full club-week | ~400s  | **7.5s** (all days fresh) |

Cross-check after building: the rollup's 2026-08-24 totals are **564 users and
6,089,636 cents** — the same numbers the old path produced.

## Live without a deploy

Both functions are DB-side and the settler calls them by name, so the fix took
effect immediately rather than waiting on the engine's drain gate.

## What was deliberately NOT changed

- The watermark-holding behaviour on failure. It is the reason no player was
  paid a wrong tier while this was broken.
- The recompute-from-source design. Incremental accumulation is what caused the
  double-count bug this replaced; the rollup keeps "rebuild from source",
  it just rebuilds a day instead of a week.
- `fn_player_rakeback_rate` still runs per user (589 calls ≈ most of the
  remaining 7.5s). Inlining it would duplicate rate policy across two places;
  at an 8x margin on the deadline that trade is not worth making yet.
