# Diamond Stats Asset Dimension

Status: The Client Half Is Merged. The SQL Below Is Not Applied.

Owner action required. Everything in this note was read off production
read-only on 2026-09-20. Nothing here has been applied: production database
writes were refused for the delivery lane that found it, and the repository's
pre-push hook refuses a pull request carrying a migration that is not already
live.

## The Finding

`fn_project_hand_side_effects_after_post_commit_20260908` runs four projections
after a hand commits. Three of them know about Diamonds:

| Projection | Writes                                      | Gate                                                             |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------- |
| 1          | club member / table / day state             | `IF v_club IS NOT NULL AND NOT COALESCE(v_diamond,false)`        |
| 2          | legacy `player_stats` totals                | `IF NOT COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL` |
| 3          | positional aggregates                       | `IF NOT COALESCE(v_diamond,false)`                               |
| 4          | `ca_hand_player_idx`, `ca_hand_player_stat` | **none**                                                         |

Projection 3 even records the reason in its own comment: "Positional profit has
no asset dimension. Keep Diamond amounts out of" it.

`ca_hand_player_stat` has 28 columns and not one of them is a club or an asset:

```
aggro_cnt, big_blind, call_cnt, cbet_made, cbet_opp, created_at,
faced_three_bet, folded, folded_to_three_bet, game_variant, hand_id,
hand_secs, invested_actions, is_cash, is_winner, my_blind, n_players, pfr,
profit, seat_position, showdown, small_blind, three_bet, three_bet_opp,
tournament_id, user_id, vpip, won_amt
```

So the first Diamond cash hand ever played adds its `profit`, `won_amt`, `net`
and `rake_paid` to that player's chip totals. The distinction is lost at WRITE
time, which is what makes this urgent rather than cosmetic: no later read, and
no later repair, can take the two apart again.

This has not happened yet only because `ca_arena_settings.cash_games_enabled`
has never been true. It is scheduled to happen on the day it is.

## What Is Already Fine

Five of the seven readers never touch `ca_hand_player_stat`. They read
`public.ca_hand_facts` (and `ca_hand_transfers`), and **both of those already
carry `club_id`**. They need a predicate, not a column, and no backfill:

| Reader                                                                                | Reads                                | Needs          |
| ------------------------------------------------------------------------------------- | ------------------------------------ | -------------- |
| `ca_player_ev_curve(p_user, p_days, p_limit)`                                         | `ca_hand_facts`                      | predicate only |
| `ca_player_hand_grid(p_user, p_position, p_variant, p_days)`                          | `ca_hand_facts`                      | predicate only |
| `ca_player_class_hands(p_user, p_hand_class, p_position, p_variant, p_days, p_limit)` | `ca_hand_facts`                      | predicate only |
| `ca_player_rake_stats(p_user, p_days)`                                                | `ca_hand_facts`                      | predicate only |
| `ca_player_nemesis(p_user, p_days, p_min_hands, p_limit)`                             | `ca_hand_facts`, `ca_hand_transfers` | predicate only |
| `ca_player_stats_overview_v2(p_user, p_days, p_tz)`                                   | `ca_hand_player_stat`                | **new column** |
| `ca_player_stats_pulse(p_user)`                                                       | `ca_hand_player_idx`                 | **new column** |

`ca_hand_player_stat_state` is the single-row rollup cursor (`id`,
`rolled_ceil`, `rolled_floor`, `complete`, `updated_at`), not per-hand data. It
needs nothing.

Neither the projection nor any of the seven readers is on
`fn_ca_guard_watchlist()`, so no `ca_guard_defs` baseline moves with this.

## What Ships Already

Merged in the pull request that produced this note:

- `src/services/statsScope.ts` - every stats read names the asset it is about.
  A chip read calls the unscoped RPC (exact today, because every row in the
  fact table is a chip row) and a Diamond read is refused outright rather than
  answered with a chip total wearing a Diamond label.
- `STATS_RPCS_ARE_SCOPED = false` - the single switch to flip when the SQL
  below lands.
- `tests/chip-and-diamond-figures-never-sum.law.test.ts` - pins the two halves
  to each other. Land the migration without flipping the client and it goes
  red; flip the client without the migration and it goes red.

## Step 1: Reserve A Version

```
bash scripts/reserve-migration-version.sh a_diamond_hand_keeps_its_own_statistics
```

Never hand-type the 14-digit version (CLAUDE.md 4.5). Never apply between :50
and :03 of any hour (CLAUDE.md section 2 rule 8).

## Step 2: The Column And The Labelled Write

The body is written and ready at
`_needs_apply/20260920T000000_a_diamond_hand_keeps_its_own_statistics.sql` on
branch `agent/cw-diamond-stats/needs-apply/a-diamond-hand-keeps-its-own-statistics`
(local only, never pushed). Move it into the reserved file.

It adds `asset text NOT NULL DEFAULT 'chips'` with a check constraint and a
covering index to `ca_hand_player_stat` and `ca_hand_player_idx`, then edits
projection 4 in place by substitution against the catalogue, pinning the
starting md5 `c13af0167961f3071d18342e00200844` and verifying the postimage.

The `DEFAULT 'chips'` backfill is asserted, not assumed: the preflight counts
rows in `ca_hand_player_stat` whose hand belongs to a `diamonds` club and
aborts if any exist rather than mislabelling them.

It labels rather than skips. Projections 1 to 3 drop Diamond hands because
their aggregates have nowhere to put an asset; this table is per-hand and can
carry the dimension, so a Diamond player keeps a full statistical history
instead of having it thrown away to protect a chip total.

## Step 3: The Seven Reader Predicates

Not in the migration file, on purpose: each reader is 1.2k to 3.1k characters
with a different `WHERE` clause, and a regex written blind against seven bodies
at once is how a money path gets mangled. Edit each against its own text.

**Five readers, predicate only.** `ca_hand_facts` and `ca_hand_transfers`
already carry `club_id`, so the scope is a join to `clubs.asset`:

```sql
-- in ca_player_ev_curve, ca_player_hand_grid, ca_player_class_hands,
-- ca_player_rake_stats: the scan is `FROM public.ca_hand_facts f`
  AND EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id = f.club_id AND c.asset = p_asset)

-- ca_player_nemesis has two scans; the second is `FROM public.ca_hand_transfers t`
  AND EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id = t.club_id AND c.asset = p_asset)
```

**Two readers, the new column.**

```sql
-- ca_player_stats_overview_v2: the two scans of ca_hand_player_stat
  AND hs.asset = p_asset

-- ca_player_stats_pulse: `FROM public.ca_hand_player_idx WHERE user_id = p_user`
  AND asset = p_asset
```

Add `p_asset text DEFAULT 'chips'` as the LAST parameter of each, so every
existing caller keeps returning exactly what it returns today.

### DROP The Old Signature First. This Is Not Optional.

`CREATE OR REPLACE FUNCTION` with an extra defaulted parameter does **not**
replace the function. It adds an **overload**, and every existing one-argument
call then fails with:

```
ERROR:  function ca_player_stats_pulse(unknown) is not unique
HINT:   Could not choose a best candidate function.
```

That would take every stats panel in the app down the moment the migration
committed, while the client is still passing the old argument list. The
isolated fixture below hit exactly this and is the reason it is written here.
So, for each reader, inside the same transaction:

```sql
DROP FUNCTION IF EXISTS public.ca_player_stats_pulse(uuid);
CREATE OR REPLACE FUNCTION public.ca_player_stats_pulse(p_user uuid, p_asset text DEFAULT 'chips')
  ...
```

and re-state the grants after the drop, explicitly, as the estate requires:

```sql
REVOKE ALL ON FUNCTION public.ca_player_stats_pulse(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_pulse(uuid, text) TO authenticated;
```

Keep `SECURITY DEFINER`, `SET search_path = public, pg_temp` and each
function's existing `ca_assert_self` identity gate. Those gates are what stop a
DEFINER function handing one player another player's mucked hole cards.

## Step 4: Flip The Client Half

In `src/services/statsScope.ts`:

```ts
export const STATS_RPCS_ARE_SCOPED = true;
```

`statsScopeArgs` then starts sending `p_asset`, and a Diamond-scoped read
becomes readable instead of refused. The law test requires this to move with
the migration and not before.

## Step 5: Verify

```
python3 tests/sql/run-diamond-stats-asset-dimension.py
npx vitest run tests/chip-and-diamond-figures-never-sum.law.test.ts
```

Then read back the installed state:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations
 WHERE name = 'a_diamond_hand_keeps_its_own_statistics';
```

## The Isolated Proof

`tests/sql/run-diamond-stats-asset-dimension.py` starts its own PostgreSQL 17
cluster in a temporary directory, never touching production. It builds the two
fact tables in the shape production has them today, reproduces projection 4's
ungated write, and asserts the defect before asserting the fix. Run on
PostgreSQL 17.11 on 2026-09-20:

```
BEFORE - production shape, projection 4 ungated:
  reproduced - 250 chips and 7 diamonds summed to 257.00 in one figure
  and the rows carry no asset or club column to separate them afterwards

AFTER - asset dimension and the labelled write applied:
  chips read 250.00 / 900.00 / 12.50 and diamonds read 7.00 / 40.00 / 1.00
  the two figures exist side by side and neither is the sum
  the Diamond hand is kept and labelled, not thrown away
  an existing unscoped caller still reads the chip figure, unchanged
  an unknown asset is refused by the check constraint
```

The before half matters as much as the after half: a regression that only ever
passes proves nothing about the bug it claims to fix.
