# 2026-08-26 — closing out the remaining items

Four of the five leftovers are resolved below. Two turned out to be non-issues,
one was fixed, one is labelled rather than deleted, and the last is scoped
honestly because it is not a session-sized task.

---

## 1. Engine restart churn — WITHDRAWN, I overstated it

Corrected in full in `2026-08-26-seat-exit-detector-and-dead-refund-pool.md`.

Short version: I reported that the engine "force-cashes out every seated player
roughly every 33 minutes". The measurements were right, the conclusion was not,
because I never checked _who_ was being cashed out.

```
distinct users in startup-cleanup cash-outs (4d) .. 584
profiles.is_horse = true .......................... 584   (100%)
human .............................................   0
```

`auto-deploy-hetzner.yml` has carried a **drain gate** since 2026-08-24 that
reads `humansSeatedTotal` from `/health` and defers a restart while any human is
seated, paired with `MIN_RESTART_SPACING_SEC` (20 min) coalescing — which is
also the real explanation for the ~33 minute interval I measured and mistook for
a fault. Cashing horses out on a cold start and reseating them is intended.

I should have read the workflow before drawing a conclusion from the numbers.

**What still stands:** 1,891 `watchdog_kill_rebuild` events in four days, 228 of
them `start_failed:start_load_table` in the last two. Unrelated to the drain
gate, unexplained, still open.

---

## 2. The `TablePage.tsx:5181` beacon — FIXED

Removed. The reason is worth keeping: it was not merely made dead by the recent
EXECUTE revoke, it had **never worked at all**. `wallet_transactions` holds zero
rows matching `'Tab-close%'` for the entire life of the function.

Two independent causes, either sufficient:

1. It authenticated with `VITE_SUPABASE_ANON_KEY`, not the player's session JWT,
   so PostgREST ran it as `anon`. `player_leave_table` is not SECURITY DEFINER,
   so RLS on `table_seats` matched no row and it did nothing.
2. Since `20260826150000` the function's EXECUTE grant is `postgres` +
   `service_role` only, so the call is now rejected outright.

The `beforeunload` warning stays — that is the part that helps. The comment left
in its place says why it must not be "fixed" by re-pointing it at the session
token or making the function SECURITY DEFINER: a fire-and-forget beacon that
moves money cannot report failure, cannot be retried, and races the engine's own
cash-out.

---

## 3. Backup tables — LABELLED, NOT DROPPED

There are **eight**, not two. ~16 MB together, and `pg_stat_user_tables` reports
`seq_scan = 0` **and** `idx_scan = 0` for every one. Nothing has ever read any of
them.

| Table                                            | Rows    | Size   |
| ------------------------------------------------ | ------- | ------ |
| `club_member_daily_stats_profit_backup_20260826` | 123,463 | 13 MB  |
| `social_posts_thumbnail_backup_20260815`         | 14,906  | 2.4 MB |
| `vip_backfill_20260812_backup`                   | 470     | 104 kB |
| `horse_avatar_swap_backup`                       | 391     | 168 kB |
| `commander_finish_position_backup_20260820`      | 133     | 24 kB  |
| `commander_blind_structure_backup_20260822`      | —       | 32 kB  |
| `avatar_photo_migration_backup`                  | —       | 32 kB  |

Not dropped, deliberately. Dropping is irreversible, one of them was created
**today** by another agent mid-flight, and 16 MB is not worth an agent guessing
which migration each still insures.

What they lacked was a stated expiry, so
`20260826_label_orphaned_backup_tables_for_review` gives each one a
`COMMENT ON TABLE` saying what it insures and when it stops being worth keeping.
A future sweep is then a date comparison rather than a guess:

```sql
SELECT c.relname, obj_description(c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE '%backup%'
   AND obj_description(c.oid) LIKE 'ORPHANED BACKUP%';
```

Two of them (`horse_avatar_swap_backup`, `avatar_photo_migration_backup`) carry
no date in the name; their comments say to establish provenance before dropping.

---

## 4. Auth connection pool — NO ACTION NEEDED

This was carried on the roadmap as "switch to percentage-based". Measured:

```
max_connections .............. 120
in use ....................... 36
active .......................  5
idle in transaction ..........  0
longest idle-in-txn ..........  0s
```

Top consumers: `PostgREST 14.17` = 12, `realtime_connect` = 5,
`realtime_subscription_manager_pub` = 4, Storage = 2.

**30% utilised, nothing active, no idle-in-transaction leak.** There is no
pressure to relieve. Changing a pool setting with no measurable problem behind
it is churn, and the setting is dashboard-only anyway. Revisit if utilisation
approaches the reserve, or if `idle in transaction` becomes non-zero — that
second one is the number that actually precedes a pool exhaustion incident.

---

## 5. `TablePage.tsx` — SCOPED, NOT ATTEMPTED

The problem is not that the file is large. It is that **one function is 94% of
it**:

```
file ......................... 15,881 lines
export default TablePage() ... 14,970 lines   (94%)
useState ..................... 145
useEffect .....................  91
useRef ....................... 102
useCallback ...................  42
```

Every other top-level declaration in the file is under 300 lines; the next
largest is a 298-line `RANK_WORD` helper.

**Why this was not attempted here.** 91 interdependent effects sharing 145
pieces of state, with no tests isolating any of them, is not something to start
and leave half-done — and the file is one of the most contended in the repo
(42 of 60 open PRs were DIRTY at the time of writing). A partial extraction
would conflict with everyone and prove nothing.

**How it should be approached**, in order, each shippable alone:

1. **Characterise before moving anything.** There is no test isolating the
   effects. Extraction without them is a rewrite with extra steps.
2. **Extract by state cluster, not by visual region.** Group the 145 `useState`
   by which effects read them; the clusters that touch no shared refs come out
   first and safely. Timers, sound, and the spin/reveal logic look like the
   cleanest boundaries from the outside.
3. **One custom hook per cluster**, moved with its effects intact — no logic
   changes in the same commit as a move. A move that also edits is unreviewable.
4. Only then split the JSX.

The bundle argument for doing this is **not** what it was originally presented
as. Route-level splitting already exists — every route in `App.tsx` is
`lazyWithRetry(() => import(...))` and `TablePage` is already its own chunk. The
gain is maintainability and review throughput, not first-paint.
