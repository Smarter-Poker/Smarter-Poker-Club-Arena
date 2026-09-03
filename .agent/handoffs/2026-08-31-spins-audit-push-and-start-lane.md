# HANDOFF — the Spins audit: push these three files, then chase the start lane

**Author:** cowork-claude · **Written:** 2026-08-31 ~15:10 UTC
**Repo:** `club-arena` (Smarter-Poker/Smarter-Poker-Club-Arena)

## 0. Read this first

**The database work is DONE and LIVE.** Migration `20260831135007_zero_attribution_is_not_success`
is applied to production, the 21,562-settlement back-pay is fully drained, and
both the gap view and the repair queue are empty. Nothing below is urgent money
work. What remains is (a) getting three files into the repo, which I could not
do, and (b) one performance regression I found, measured, and deliberately did
not guess at.

## 1. WHY I COULD NOT PUSH — this blocks every agent, not just me

**The GitHub MCP token is dead.** Every call returns
`Authentication Failed: Bad credentials` — including plain reads
(`get_file_contents` on `CLAUDE.md`). It is not a scope problem.

`device_bash` has no network route to GitHub either (`git fetch` →
`Connection closed by UNKNOWN port 65535`), and the cloud sandbox is proxy-
blocked from `github.com` and from `smarter.poker`. So as of today there is
**no path at all from a Cowork session to a commit**. CLAUDE.md RULE 0 names
the GitHub MCP as the primary ship route for every agent on this estate; that
route is down. Replacing the token should probably come before any other
agent work.

Secondary: **the device VM's disk is 100% full** (9.8G, 0 available), so
`vitest` cannot create its temp dirs and the suite cannot run there.

## 2. WHAT TO PUSH — three files, already written, already verified

They are staged in **two** places, identical:

- `~/Desktop/spins-audit-2026-08-31/` (mirrors the repo tree)
- and copied into the `club-arena` worktree at their final paths, untracked

| path                                                                          | what it is                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `supabase/migrations/20260831135007_zero_attribution_is_not_success.sql`      | the migration, byte-for-byte what was applied to production |
| `tests/config/rakeAttributionZeroIsNotSuccess.test.ts`                        | 25 pins over that migration                                 |
| `docs/changelog/2026-08-31-spins-end-to-end-audit-and-zero-is-not-success.md` | the full audit record                                       |

**Do not re-apply the migration.** It is already in
`supabase_migrations.schema_migrations` as version `20260831135007`. The file
exists so the repo matches production and so the schema manifest check does not
report drift.

**The test has been executed** — all 25 pins pass. Because `vitest` could not
run (disk), I ran the identical assertions with a standalone node script
against the staged migration. Please still let CI run the real suite; if a pin
fails there it is a real disagreement worth reading, not a formatting nit.

Suggested commit message:

    fix(rake): zero attribution is not success - 21,562 settlements that reached nobody

## 3. WHAT THE MIGRATION DOES (one paragraph, so you can review it)

`fn_settle_tournament_rake` stamped `attributed_at` whenever attribution
returned `ok:true`, and attribution returns `ok:true` when it credits **nobody**.
`fn_repair_tournament_rake_attribution` selects on `attributed_at IS NULL`, so
it was structurally blind to exactly that shape. 21,562 settlements — 17,504
spins, 3,834 SNGs, 198 MTTs, 21,080 chips of banked rake — earned no VIP
credit, no agent commission and no rakeback basis, back to 2026-08-19, every
one recorded as a completed attribution. The migration stores
`attributed_users` on the settlement, has `fn_attribute_tournament_rake` return
`members` so "credited nobody" can be told from "nobody to credit", stamps
`attributed_at` only when somebody was credited or nobody could be, adds
`fn_backpay_tournament_rake_attribution(p_limit)` and
`v_tournament_rake_attribution_gaps`. Nothing filters on `is_horse` in either
direction (10.5).

Result: **69,561 VIP ledger rows across 21,947 tournaments to 585 players,
23,314.76 chips / 23,225 points, plus 2,248 agent commission rows to 74
agents.** Every day in the last ten went from 36-42% attributed to **100%**.

## 4. THE OPEN ITEM — the start lane is 2-4x slower than round 18 shipped

Round 18 (2026-08-30) moved the wheel to fire on the **draw** and measured
third paid seat → reveal at p50 **3.02s**, p90 4.70s. Same clock, today:

| hour UTC | p50   | p90   |
| -------- | ----- | ----- |
| 08:00    | 3.2s  | 5.9s  |
| 11:00    | 7.3s  | 14.3s |
| 13:00    | 13.7s | 28.3s |
| 14:00    | 6.7s  | -     |

The query that produced it (`spin_reserve_ledger.kind='jackpot_draw'` is the
reveal anchor):

```sql
with s as (select t.id, t.started_at from tournaments t
            where t.tournament_type='SPIN' and t.started_at > now()-interval '6 hours'),
third as (select tb.tournament_id tid,
                 (array_agg(ts.joined_at order by ts.joined_at))[3] third_at
            from table_seats ts join tables tb on tb.id=ts.table_id
            join s on s.id=tb.tournament_id group by 1),
draw as (select tournament_id tid, min(created_at) drawn_at
           from spin_reserve_ledger where kind='jackpot_draw'
            and created_at > now()-interval '7 hours' group by 1)
select date_trunc('hour', s.started_at) h, count(*) n,
  round(percentile_cont(0.5) within group
        (order by extract(epoch from (d.drawn_at-t.third_at)))::numeric,2) p50,
  round(percentile_cont(0.9) within group
        (order by extract(epoch from (d.drawn_at-t.third_at)))::numeric,2) p90
from s join third t on t.tid=s.id join draw d on d.tid=s.id
where t.third_at is not null group by 1 order by 1 desc;
```

**What I ruled out**

- Not a runaway — it recovers (14:00 back to 6.7s).
- Not engine starvation — `hand_history` is flat at 10-13k hands/hour right
  through the degradation.
- Not an in-process leak — three engine restarts in the window (06:37, 09:26,
  13:22, visible as sub-60-hand minutes in `hand_history`) did not reset it.
- Not the partial-board filler — the 12-second per-game throttle on
  `fillPartialSeatFirstGame` is intact.
- Not my back-pay — the climb starts at 09:00, hours before I began, and the
  14:00 figure is _better_ while it was running.

**The one concrete lead.** The fast lane's own board read is slow for what it
returns: `EXPLAIN ANALYZE` on `discoverSeatFirstStarts`'s first query
(`status='REGISTERING' AND variant IN ('spin','sng')`, 63 rows) measured
**305ms** — 240ms execution over 1,782 shared buffers plus 75ms planning, on an
index scan. `tournaments` is 13% dead tuples with only 3 autovacuums. That is
one of three reads in a loop that is supposed to complete every second.

**THE TRAP TO AVOID.** Measuring this against `tournaments.started_at` instead
of the draw shows a much worse, apparently monotonic curve (3s → 27s). That is
the **wrong clock** — since round 18 the player sees the wheel at the draw, and
`started_at` lands after the bookkeeping. I reported the wrong number first for
exactly this reason. Anchor on `jackpot_draw`.

## 5. WHAT I VERIFIED AND FOUND HEALTHY — do not re-audit these

All against production, all in the changelog with the queries:

- buy-in collection exact to the chip (531 debits / 177 spins / 15,012.00)
- payouts exact (749 spins, 50,684 owed = 50,684 credited)
- multi-place splits exact (0.80/0.20 and 0.80/0.12/0.08 across 249 games)
- RNG fair (21,250 draws, observed E = 2.7628 vs specified 2.7638)
- horses paid like humans (1,584 credits, none filtered)
- stack depth tracks the drawn tier (300/1000/5000 in ladder proportions)
- the wheel paints on a 375x667 phone from the **deployed** bundle; longest
  shipped beat 1,800ms against a 14,800ms engine hold; reduced motion drops
  motion but keeps every element at opacity 1
- no stubs or TODOs anywhere in the spin client path
- `spin_tournaments` is dead (0 rows, lifetime) — spins live in `tournaments`
  with `tournament_type='SPIN'`. Worth a deliberate DROP one day; harmless now.
