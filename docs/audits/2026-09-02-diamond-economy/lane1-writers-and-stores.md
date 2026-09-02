# Lane 1 - Diamond writers and stores (READ-ONLY audit, 2026-09-02/03)

Scope: every store that holds a diamond balance, every function that writes one, the trigger
stack on `profiles`, the snapshot job, and 30 days of measured use. Every number below comes
from a SELECT run against production `kuklfnapbkmacvwxktbh` during this session. Nothing was
written. Anything not measured is labelled UNVERIFIED.

Method note, same limitation as the chip lane: `track_functions` is off, so there are no
per-function call counts. Use is attributed from `diamond_transactions` (type / source /
transaction_type / description shapes), `ca_diamond_balance_audit` (db_role, app_name,
journaled), `ca_diamond_snapshots`, `ca_profile_deletions` and `diamond_purchases`, matched
to the function bodies that emit those shapes. Where a shape maps to more than one function
I say so.

---

## 1. Store inventory (measured 2026-09-02 late UTC)

| Store (column)                  | Rows  | Sum                            | Negatives | Rows > 0 | Role                                             |
| ------------------------------- | ----- | ------------------------------ | --------- | -------- | ------------------------------------------------ |
| `profiles.diamonds`             | 1,308 | 1,030,092                      | 0         | 1,081    | CANONICAL                                        |
| `profiles.diamond_balance`      | 1,308 | 1,030,092                      | 0         | 1,081    | BEFORE-trigger mirror, 0 rows mismatch canonical |
| `user_diamonds.balance`         | 1,308 | 1,030,092                      | 0         | 1,081    | AFTER-trigger mirror (since 17:29 UTC today)     |
| `user_diamond_balance.balance`  | 1,308 | 1,030,092                      | 0         | 1,081    | AFTER-trigger mirror                             |
| `diamond_wallets.balance`       | 416   | 619,879                        | 0         | 415      | AFTER-trigger mirror, PARTIAL (416 of 1,308)     |
| `user_progress.diamonds`        | 107   | 10,700                         | 0         | 107      | orphan store, 100 each, not mirrored             |
| `bot_profiles.diamonds`         | 139   | 26,541                         | 0         | 100      | separate horse-profile table                     |
| `club_members.diamonds`         | 1,935 | 0                              | 0         | 0        | dead column                                      |
| `club_memberships.diamonds`     | 1,935 | 0                              | 0         | 0        | dead column                                      |
| `club_diamond_wallets.balance`  | 2     | 0.00                           | 0         | 0        | club-level store, unused                         |
| `diamond_platform_budget`       | 3     | 7,500,000 budget / 2,493 spent | -         | -        | budget counter, not a balance                    |
| `ca_profile_deletions.diamonds` | 77    | 198,525                        | 0         | 38       | tombstone of deleted profiles                    |
| `public.wallets` PLAYER         | 1,301 | 732,581,244.02                 | 0         | -        | DEAD, frozen, last touch 2026-09-01 01:46 UTC    |
| `public.wallets` PROMO          | 447   | 10,700.00                      | 0         | -        | DEAD (note: equals `user_progress.diamonds` sum) |
| `public.wallets` BUSINESS       | 447   | 50.01                          | 0         | -        | DEAD                                             |

Three facts worth pulling out.

1. **`diamond_wallets` is a PARTIAL mirror.** It holds 416 rows against 1,308 profiles. Every
   one of the 416 equals its profile (0 mismatches measured), so the mirror trigger is doing
   its job for rows that exist, but 892 profiles have no wallet row at all. Anything that reads
   `diamond_wallets` as the balance sees 0 for those users. The 619,879 figure is exactly the
   number the snapshot double-counts (see section 4).
2. **No CHECK constraint anywhere on `profiles` mentions diamonds.** `pg_constraint` on
   `public.profiles` returns zero rows whose definition contains "diamond". The 0-negative
   state is enforced only inside function bodies, not by the database. Same shape as the chip
   lane found for `club_members.chip_balance`.
3. **`public.wallets` PROMO total (10,700.00) equals `user_progress.diamonds` total (10,700)**
   exactly, 107 rows of 100 in `user_progress` versus 447 wallet rows. That is the fossil of an
   older signup grant, and both stores are read by nothing on the canonical path.

### Horses versus humans

| Segment                   | Profiles | Sum `diamonds` | Max     | Rows > 0 |
| ------------------------- | -------- | -------------- | ------- | -------- |
| Humans (`is_horse` false) | 308      | 573,311        | 493,960 | 181      |
| Horses (`is_horse` true)  | 1,000    | 456,781        | 10,000  | 900      |

Horses hold 44.3 percent of all diamonds and 900 of the 1,081 funded rows. Any sweep, report or
retirement that filters `is_horse` therefore moves or hides most of the population; CLAUDE.md
10.5 forbids it. One human account holds 493,960 diamonds, 48 percent of the entire supply and
86 percent of the human supply.

---

## 2. The trigger stack on `profiles`

18 non-internal triggers exist on `public.profiles`; five of them are on the diamond path.
Postgres fires triggers of the same timing in NAME order, which is what the `aa_` and `zz_`
prefixes are buying.

| Order | Trigger                                      | Timing                                               | Function                                  | What it does to diamonds                                                                                                                                                     |
| ----- | -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `trg_aa_diamond_balance_mirrors_canonical`   | BEFORE INSERT OR UPDATE OF diamonds, diamond_balance | `fn_diamond_balance_mirrors_canonical`    | one line: `NEW.diamond_balance := NEW.diamonds`. This is why the mirror never drifts                                                                                         |
| 2     | `trg_guard_profile_privileged_columns`       | BEFORE UPDATE (all columns)                          | `fn_guard_profile_privileged_columns`     | raises 42501 if `diamonds`, `diamond_balance`, `diamond_multiplier`, `is_vip`, `vip_tier` or `vip_expires_at` changed outside a service context or an allowlisted call stack |
| 3     | `trg_daily_challenge_revision_from_diamonds` | AFTER UPDATE OF diamonds                             | `bump_daily_challenge_dashboard_revision` | cache bump only                                                                                                                                                              |
| 4     | `trg_diamond_side_tables_follow_profiles`    | AFTER UPDATE OF diamonds                             | `fn_diamond_side_tables_follow_profiles`  | upserts `user_diamonds` and `user_diamond_balance`, and UPDATEs `diamond_wallets`                                                                                            |
| 5     | `zz_ca_audit_diamond_change`                 | AFTER UPDATE OF diamonds                             | `fn_ca_audit_diamond_change`              | appends to `ca_diamond_balance_audit`; on failure appends to `ca_ledger_write_failures` and never blocks                                                                     |

Plus `trg_ca_profile_deletion_journal` (BEFORE DELETE, `fn_ca_journal_profile_deletion`) which
copies id, username, is_horse, diamonds, diamond_balance and created_at into
`ca_profile_deletions` before the row goes.

### Three defects in this stack, all measured

**2a. `diamond_wallets` can never gain a row.** The side-table trigger UPSERTs the first two
tables (`ON CONFLICT (user_id) DO UPDATE`) but does a bare `UPDATE public.diamond_wallets ...
WHERE user_id = NEW.id` for the third. A user with no wallet row gets nothing, forever. That is
the mechanical cause of 416 wallet rows against 1,308 profiles, and of the 619,879 versus
1,030,092 gap.

**2b. The privileged-columns guard allowlists by call-stack string, and the list is short.**
`fn_guard_profile_privileged_columns` returns early for `fn_is_service_context()`, and otherwise
matches `PG_CONTEXT` against exactly six names: `deduct_diamonds`, `fn_union_send_to_member`,
`claim_daily_challenge`, `claim_daily_challenges`, `fn_ca_mint`, `fn_ca_burn`. Every other
diamond writer passes only because it is SECURITY DEFINER and therefore already in a service
context. A stack-string allowlist is a fragile substitute for a grant: renaming a function or
inlining a call silently changes who is allowed to move money.

**2c. `ca_diamond_balance_audit.journaled` is a dead column.** Its default is `false`,
`fn_ca_audit_diamond_change` does not set it, and it is the ONLY function in the database whose
source mentions the table, so nothing ever sets it to true. Measured: **603 of 603 rows have
`journaled = false`**. Any report or gate that reads that flag is reading a constant.

Also measured on the same table: every one of the 603 rows carries `db_role = postgres` and
`app_name = 'PostgREST 14.5'`. Because every diamond writer is SECURITY DEFINER owned by
postgres, `db_role` cannot attribute a movement to a caller. It is not evidence of who moved the
diamonds; it is evidence that the audit runs. Attribution has to come from the journal.

---

## 3. The journal, and the two holes in it

`diamond_transactions` is the journal. Indexes measured:

- `idx_diamond_transactions_reference_id` UNIQUE on `(reference_id) WHERE reference_id IS NOT NULL`
- `diamond_transactions_user_reference_uidx` UNIQUE on `(user_id, reference_id) WHERE reference_id IS NOT NULL`

So idempotency IS enforced by constraint, not only by the pre-check inside the RPCs. Note the
first index is GLOBALLY unique on `reference_id`: two different users can never share one
reference. Any future two-sided movement (a transfer, a PvP stake and its opposite refund, a
tournament prize list) must therefore mint a per-user reference, or the second leg fails with 23505. This is a real constraint on the Diamond Arena design and is worth writing into the
standard rather than discovering at the table.

**Hole 1: the journal is not append-only in practice.** `trg_ca_append_only` ->
`fn_ca_journal_append_only` refuses UPDATE and DELETE, but it accepts both when
`app.ledger_maintenance` is set to a reason, recording the whole old row into
`ca_ledger_mutation_log` and raising a warning incident. Measured use of that bypass on
`diamond_transactions` since 2026-09-01 09:19 UTC: **2,860 rows deleted, 1,896,161 diamonds of
journal history erased**, in these three groups.

| Reason prefix                          | Rows  | Sum of `amount` | Distinct users | Window (UTC)                                     |
| -------------------------------------- | ----- | --------------- | -------------- | ------------------------------------------------ |
| `certification-cleanup:<uuid>`         | 2,718 | 635,761         | 305            | 2026-09-01 09:48 to 2026-09-02 19:xx, every hour |
| `retired-test-accounts-2026-09-01 ...` | 141   | 1,259,900       | 141            | 2026-09-02 00:57:33                              |
| `INC-2026-09-01-dss-probe-cleanup`     | 1     | 500             | 1              | 2026-09-01 09:19:02                              |

The certification fleet deletes journal rows on an HOURLY cadence and has done so continuously
for two days. That is not an incident, it is the steady state.

**Hole 2: the journal has two ON DELETE CASCADE parents.** `diamond_transactions.user_id` has a
FK to `auth.users(id) ON DELETE CASCADE` and a second FK to `profiles(id) ON DELETE CASCADE`.
Deleting a player therefore erases that player's entire money history. Combined with hole 1
(which is what lets the cascade through the append-only guard) this means the journal is a
record of living users only. A ledger you can delete by deleting the account is not an audit
trail.

---

## 4. The snapshot, and what `unexplained = 619,829` actually was

`cron.job` has exactly two diamond or mint jobs, both active:

| jobid | schedule      | jobname                      | command                                     |
| ----- | ------------- | ---------------------------- | ------------------------------------------- |
| 201   | `10 * * * *`  | `ca-diamond-snapshot-hourly` | `SELECT public.fn_ca_diamond_snapshot()`    |
| 205   | `*/5 * * * *` | `ca-mint-velocity-5m`        | `SELECT public.fn_ca_mint_velocity_watch()` |

Read from the live body of `fn_ca_diamond_snapshot`:

```
v_total := v_prof + v_wal;                       -- profiles + diamond_wallets
v_cert  := sum(profiles.diamonds) WHERE fn_ca_is_cert_account(id)
unexplained := (v_total - v_cert)
             - (prev.total - prev.cert_diamonds)
             - journal_noncert_since_prev
```

**The hypothesis in the brief is half right and half wrong, and both halves matter.**

- CONFIRMED: `total` double-counts. `v_total = v_prof + v_wal`, and since 17:29 UTC today
  `diamond_wallets` is a MIRROR of `profiles`. Every diamond held by one of the 416 wallet users
  is now counted twice. The 18:10 snapshot is the proof: `wallet_diamonds` jumps 50 to 619,879,
  `profile_diamonds` does not move (1,030,092 at 17:10 and at 18:10), `delta_vs_prev` = 619,829,
  `unexplained` = 619,829. Exactly the backfill, nothing else. Not a mint.
- REFUTED: `cert_diamonds` is NOT added on top. `total` is profiles plus wallets only; cert is
  SUBTRACTED on both sides of the drift subtraction, to exclude the nightly certification fleet
  from the gate. And `cert_diamonds` IS a subset of `profile_diamonds`: it is literally
  `sum(p.diamonds) FROM profiles p WHERE fn_ca_is_cert_account(p.id)`. Measured independently:
  519 rows in `ca_cert_accounts`, and the same expression evaluates to 234,480 right now, equal
  to the `cert_diamonds` column in every snapshot since 2026-09-01.

Every snapshot from 19:10 to 23:10 UTC reads `unexplained = 0` and `delta_vs_prev = 0` with
`total = 1,649,971`. The baseline is now permanently inflated by 619,879 and will move again
every time a wallet row is created or a wallet user's balance changes, so the gate is
measuring a quantity that no longer means "supply".

**The fix is one line in the snapshot** (`v_total := v_prof;`) plus a decision about whether
`diamond_wallets` should exist at all. It is not a money problem.

---

## 7. The 2026-09-02 00:10 to 01:10 drop of 1,259,900

CONFIRMED, and it was the test-account retirement.

- `profile_diamonds` in `ca_diamond_snapshots`: 2,289,877 at 00:10:02, 1,029,977 at 01:10:00.
  Delta exactly -1,259,900.
- `ca_ledger_mutation_log` records a single DELETE burst at **2026-09-02 00:57:33.227598 UTC**,
  `db_role = postgres`, `application = mgmt-api`, reason
  `retired-test-accounts-2026-09-01 (docs/audit/2026-09-01-retired-test-accounts.md)`:
  **141 `diamond_transactions` rows, 141 distinct users, `amount` summing to exactly 1,259,900**.
  Sampled rows are `signup_bonus` "Welcome bonus" grants from January and `reconciliation` rows
  dated 2026-05-03, i.e. every diamond those accounts ever received.
- The `journaled_delta = -1259900` and `unexplained = 0` on that snapshot row are NOT what the
  current function computes; they were written by migration
  `20260902040622_diamond_snapshot_explains_the_test_account_retirement` at 04:06 UTC, which
  UPDATEs that one row and says so in its own comment. It also records the rule that came out of
  the incident: "account-retirement flows must write a retirement row to diamond_transactions
  BEFORE deleting the profile." That rule is not yet enforced by anything.
- Note the shape: the retirement removed the accounts, their balances and their history in one
  step, and the only reason the amount is knowable today is that the append-only bypass copied
  the old rows into `ca_ledger_mutation_log`. `ca_profile_deletions` does not cover it: its
  earliest row is 2026-09-02 04:00 UTC, after the fact.

---

## 5. Every writer, classified

Two tiers. A small core of functions that touch a balance column directly, and a large ring of
callers that go through the core. The ring is healthy; the core is where the legacy lives.

### 5a. Core writers of `profiles.diamonds`

| Function (identity args)                                                                | Definer | Grants                 | Journals? | reference_id                     | Class      | Notes                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------- | ---------------------- | --------- | -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `add_diamonds_to_balance(uuid,int,text,text,text)`                                      | yes     | postgres, service_role | yes       | yes, required for 12 exact types | STANDARD   | floors at 0, applies `diamond_multiplier`, refuses duplicate reference                                                                  |
| `deduct_diamonds(uuid,int,text,text,text,jsonb,text,int)`                               | yes     | postgres, service_role | yes       | optional                         | STANDARD   | `auth.uid()` self-check, insufficient-funds guard, cooldown, idempotent return                                                          |
| `award_diamonds_v2(uuid,text,text,text,jsonb)`                                          | yes     | postgres, service_role | yes       | yes                              | STANDARD   | the earn engine; only writer of `diamond_platform_budget`                                                                               |
| `fn_ca_mint(text,text,uuid,numeric,text,text)`                                          | yes     | + authenticated        | yes       | `op_id` UNIQUE                   | STANDARD   | admin/god or service_role only, caps, reason >= 10 chars, whole diamonds                                                                |
| `fn_ca_burn(text,text,uuid,numeric,text,text)`                                          | yes     | + authenticated        | yes       | `op_id` UNIQUE                   | STANDARD   | same gate, the retirement door                                                                                                          |
| `claim_daily_challenge(uuid,uuid,numeric)` / `claim_daily_challenges(uuid,uuid[],uuid)` | yes     | + authenticated        | yes       | yes                              | STANDARD   | allowlisted in the privileged-columns guard by name                                                                                     |
| `send_wallet_diamond_transfer(uuid,int,text,text)`                                      | yes     | + authenticated        | yes       | yes                              | STANDARD   | player-to-player                                                                                                                        |
| `send_stream_gift(uuid,int,text,text)`                                                  | yes     | + authenticated        | yes       | yes                              | STANDARD   |                                                                                                                                         |
| `reconcile_diamond_purchase_refund(uuid,int,int)`                                       | yes     | postgres, service_role | yes       | yes                              | STANDARD   | Stripe refund reconciliation                                                                                                            |
| `fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)`                     | yes     | postgres, service_role | yes       | no                               | LEGACY-ish | journals but no reference; allowlisted in the guard under the shorter name `fn_union_send_to_member`                                    |
| `fn_purchase_time_banks(int)`                                                           | yes     | + authenticated        | yes       | no                               | LEGACY     | writes `diamonds` only, no `reference_id`, so replayable                                                                                |
| `complete_daily_challenge(uuid,uuid,int,numeric,int)`                                   | **no**  | postgres, service_role | yes       | no                               | LEGACY     | SECURITY INVOKER, superseded by `claim_daily_challenge(s)`                                                                              |
| `fn_atomic_buyin(uuid,uuid,int,int)`                                                    | **no**  | postgres, service_role | yes       | no                               | LEGACY     | SECURITY INVOKER                                                                                                                        |
| `fn_add_diamonds(uuid,int)`                                                             | **no**  | postgres, service_role | yes       | no                               | LEGACY     | 12-line credit, `type='credit'`, description = its own name                                                                             |
| `fn_credit_diamonds(uuid,int)` and `fn_credit_diamonds(uuid,int,text)`                  | **no**  | postgres, service_role | yes       | no                               | LEGACY     | two overloads of the same thing; the 3-arg one does not even set `balance_after`                                                        |
| `increment_diamonds(uuid,int)`                                                          | **no**  | postgres, service_role | yes       | no                               | LEGACY     | byte-for-byte `fn_add_diamonds` with a different label                                                                                  |
| `transfer_diamonds_credit(uuid,int)` / `transfer_diamonds_deduct(uuid,int)`             | **no**  | postgres, service_role | yes       | no                               | LEGACY     | a two-legged transfer split across two independently callable functions, no shared reference, no transaction guarantee between the legs |
| `award_diamonds(uuid,int,text,jsonb)`                                                   | **no**  | postgres, service_role | yes       | no                               | LEGACY     | ALSO writes `user_diamonds` directly, now redundant with the mirror trigger and double-counts `lifetime_earned`                         |
| `purchase_vip_with_diamonds_atomic(...)`                                                | yes     | postgres, service_role | via core  | via core                         | LEGACY     | v2 and v3 supersede it                                                                                                                  |
| `fn_reset_broken_streak_multipliers()` / `fn_sync_share_streak_multiplier(uuid)`        | yes     | postgres, service_role | n/a       | n/a                              | PLUMBING   | write `diamond_multiplier`, not a balance                                                                                               |

Six of those LEGACY entries are SECURITY INVOKER (`prosecdef = false`), which means they only
work when the caller already has UPDATE on `profiles` and they are NOT what the privileged-column
guard is protecting against. They are old service-role helpers, not player-reachable routes.

### 5b. Writers of the side stores

| Function                                          | Store written                                              | Journals? | Class     | Notes                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_diamond_side_tables_follow_profiles()`        | `user_diamonds`, `user_diamond_balance`, `diamond_wallets` | no        | PLUMBING  | the mirror trigger; see defect 2a                                                                                                                                                                                                      |
| `initialize_user_diamonds()`                      | `user_diamonds` seeded with 100                            | no        | LEGACY    | signup trigger granting 100 diamonds into a MIRROR, not into `profiles`; the next profile write silently overwrites it                                                                                                                 |
| `create_user_progress_on_signup()`                | `user_progress.diamonds` seeded with 100                   | no        | LEGACY    | the fossil that produced 107 rows x 100 = 10,700                                                                                                                                                                                       |
| `claim_reward(uuid,text,jsonb)`                   | `user_diamond_balance`                                     | no        | LEGACY    | full reward engine with a 500/day cap, writing to a table that is now an overwritten mirror                                                                                                                                            |
| `update_daily_streak(uuid)`                       | `user_diamond_balance`                                     | no        | LEGACY    | same                                                                                                                                                                                                                                   |
| `award_purchase_diamonds(uuid,int,text,numeric)`  | nothing                                                    | no        | DEAD STUB | body is `RETURN;` with a comment saying "the Stripe webhook handler updates diamond_wallets directly". If that is still true anywhere, it is a purchase crediting a mirror the trigger will overwrite. Worth one grep in the app repos |
| `heal_auth_integrity()`                           | `user_diamonds`, `public.wallets`                          | no        | PLUMBING  | repair job that touches the dead pool                                                                                                                                                                                                  |
| `ca_promo_vault_buy(uuid,text,int)`               | `club_diamond_wallets.balance`                             | **no**    | LEGACY    | executable by `authenticated`, debits a club diamond wallet with NO journal row at all                                                                                                                                                 |
| `mint_club_chips` / `fn_mint_chips_from_diamonds` | chips side; burns diamonds via `deduct_diamonds`           | via core  | STANDARD  | the diamonds-to-chips ramp                                                                                                                                                                                                             |

### 5c. The ring (route through the core, no direct balance write)

Measured by source reference: 30 functions call `add_diamonds_to_balance` or `deduct_diamonds`
and touch no balance column themselves. Credit side: `award_trivia_run`, `award_trivia_run_v2`,
`claim_lucky_wheel_spin`, `create_trivia_session_v2`, `create_trivia_pvp_session_v2`,
`enter_trivia_tournament_v2`, `fn_award_share_streak_diamonds`, `fn_trivia_award_diamonds`,
`fn_trivia_prize_wheel_spin`, `fn_trivia_tournament_payout`, `fn_purchase_club_shop_item_diamonds`,
`fn_refund_shop_purchase`, `purchase_merch_with_diamonds_atomic`, `refund_diamond_merch_order_atomic`,
`settle_diamond_card_purchase_atomic`, `purchase_vip_with_diamonds_atomic`,
`reconcile_diamond_purchase_refund`. Debit side: `buy_streak_freeze`, `fn_consume_rabbit_hunt`,
`fn_purchase_chips`, `fn_purchase_club_chips`, `fn_purchase_feature`, `fn_reveal_rabbit_hunt`,
`fn_use_throwable`, `fn_mint_chips_from_diamonds`, `reroll_daily_challenge`. This ring is the
part of the system that already looks like the chip standard.

### 5d. Measured use

**Journal, 30 days: 570 rows, net +187 diamonds, 14 types.**

| Type                                                         | Rows | Net     | Credits | Debits  | Users |
| ------------------------------------------------------------ | ---- | ------- | ------- | ------- | ----- |
| `pvp_refund`                                                 | 488  | +14,240 | 14,240  | 0       | 5     |
| `daily_login`                                                | 45   | +1,467  | 1,467   | 0       | 7     |
| `adjustment`                                                 | 7    | -13,680 | 440     | -14,120 | 6     |
| `chip_purchase`                                              | 6    | -200    | 0       | -200    | 1     |
| `easter_egg`                                                 | 5    | +960    | 960     | 0       | 4     |
| `game_cost`                                                  | 4    | -40     | 0       | -40     | 1     |
| `training_reward`                                            | 4    | +32     | 32      | 0       | 1     |
| `chip_mint`                                                  | 3    | -3      | 0       | -3      | 1     |
| `pvp_stake`                                                  | 3    | -120    | 0       | -120    | 1     |
| `feature_purchase`                                           | 1    | -2,500  | 0       | -2,500  | 1     |
| `trivia_run` / `trivia_arcade` / `video_favorite` / `credit` | 4    | +31     | 41      | -10     | 4     |

The whole month is five users doing 488 PvP refunds in a ten-day burst (2026-08-13 to 08-23) plus
a handful of logins. In the last 24 hours the journal has **2 rows, +115 diamonds**. There is no
production diamond traffic to speak of. Anything the Diamond Arena needs will be new load on
paths that have never carried it.

**Balance audit, all of it (the table starts 2026-09-02 04:45:08 UTC): 603 rows, net +160,140,
all `db_role = postgres`, all `app_name = 'PostgREST 14.5'`, all `journaled = false`.**

| Segment                   | Rows | Net      | Users | Rows with a journal row for the same user within 5 seconds |
| ------------------------- | ---- | -------- | ----- | ---------------------------------------------------------- |
| cert accounts (`is_cert`) | 601  | +160,025 | 77    | **0**                                                      |
| everyone else             | 2    | +115     | 2     | 2                                                          |

So: **601 of 603 diamond balance changes in the last 19 hours had no journal row.** Every one of
them is a certification-fleet account, which is why the snapshot gate does not fire, and it is
also why `ca_diamond_balance_audit` cannot yet answer the question it was built to answer. Both
real movements were journaled.

**Mint: `ca_mint_ledger` has 0 rows, for any asset.** `diamond_ledger` 0 rows (dead).
`diamond_arena_events` 0 rows. `ca_ledger_write_failures` 1 row.
`diamond_platform_budget`: 2026-07 spent 21, 2026-08 spent 2,252, 2026-09 spent 220, each against
a 2,500,000 budget; written only by `award_diamonds_v2`. Note the September figure (220) exceeds
what the September journal still shows (115) - consistent with cert-cleanup deletions removing
journal rows that the budget counter had already counted.

**Purchases: `diamond_purchases` has 3 rows, all 2026-02-12, all package "Micro" at 1.00 USD.**
Two completed (200 diamonds), one still `pending` after seven months. Total real money that has
entered the diamond economy through this table: 2.00 USD.

---

## 6. 30-day supply reconstruction, and why it cannot be closed

**It cannot be closed from the data that exists, and that is the finding.**

- `ca_diamond_snapshots` begins at **2026-08-31 23:57 UTC**, 52 rows. There is no snapshot older
  than 3 days, so there is no 30-day supply series to reconstruct against.
- Over the life of the snapshot table, `profile_diamonds` went 2,081,772 -> 1,030,092, a fall of
  1,051,680, of which -1,259,900 is the test-account retirement (section 7) and the rest is cert
  fleet churn plus +115 of real journal movement.
- The 30-day journal nets **+187**. The all-time journal nets +803,607 over 1,432 surviving rows,
  but that number is not a supply figure: 2,860 rows worth 1,896,161 have been deleted out of it
  in the last two days alone (section 3), and the deletions are ongoing.
- The one balance-audit total available (+160,140 since 04:45 today) is 99.9 percent cert fleet
  and does not describe the player economy.

The honest 30-day supply statement is therefore: **570 journal rows across 11 users, credits
+17,180, debits -16,993, net +187. Purchased 0 (no `diamond_purchases` row since 2026-02-12).
Granted 0 signup bonuses (the last `signup_bonus` row is also 2026-02-12). Transferred 0
player-to-player. Minted 0 and burned 0 through the Mint. Retired 1,259,900 by profile deletion
outside every ledger.** The
retirement is 99.99 percent of all diamond movement in the window and none of it went through a
money path.

---

## 8. Gap list against the chip standard

| #   | Principle                            | State on diamonds                                                                                                                                                                                                                                                     | Severity |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Segregation of stores                | Six stores hold the same number. One canonical, one BEFORE mirror, three AFTER mirrors (one of them partial), plus `user_progress`, `bot_profiles` and a dead `public.wallets` PROMO pool. Nothing tells a reader which one to trust                                  | HIGH     |
| 2   | Double entry                         | The journal has ONE side. `diamond_transactions` records a user and an amount; there is no counterparty, no account pair, no `from`/`to`. A transfer is two independent rows written by two independently callable functions (`transfer_diamonds_deduct` / `_credit`) | HIGH     |
| 3   | Append-only                          | Enforced by trigger, defeated by `app.ledger_maintenance`, and defeated structurally by two `ON DELETE CASCADE` FKs. 2,860 rows deleted in 2 days, hourly and ongoing                                                                                                 | HIGH     |
| 4   | Idempotency by constraint            | GOOD, and better than the chip side: two partial UNIQUE indexes on `reference_id`. But the global one forbids two users sharing a reference, which the Arena will need, and 9 of the core writers pass `reference_id = NULL` and are freely replayable                | MEDIUM   |
| 5   | No negatives                         | No CHECK constraint anywhere. 0 negatives today, held only by function bodies. `award_diamonds`, `fn_add_diamonds`, `increment_diamonds`, `fn_credit_diamonds` guard the SIGN of their argument but not the resulting balance                                         | HIGH     |
| 6   | Four eyes on issuance                | Only inside `fn_ca_mint` / `fn_ca_burn` (admin or god role, reason string, cap, `op_id`). Every other credit path issues diamonds with one pair of eyes                                                                                                               | HIGH     |
| 7   | Trial balance that names the account | `fn_ca_diamond_snapshot` sums `profiles + diamond_wallets` and calls it supply. Since 17:29 UTC today that is a double count of 619,879. The identity is wrong, not the data                                                                                          | HIGH     |
| 8   | One path per movement class          | Credit has at least 8 direct paths (`add_diamonds_to_balance`, `award_diamonds`, `award_diamonds_v2`, `fn_add_diamonds`, `fn_credit_diamonds` x2, `increment_diamonds`, `transfer_diamonds_credit`) doing the same thing with different labels                        | HIGH     |
| 9   | The Mint is the only door            | `ca_mint_ledger` has 0 rows. Every diamond in existence was issued around the Mint. The door exists and has never been opened                                                                                                                                         | HIGH     |
| 10  | Attribution                          | `ca_diamond_balance_audit.db_role` is `postgres` on 603 of 603 rows and `journaled` is `false` on 603 of 603 because nothing sets it. Neither column can attribute anything today                                                                                     | MEDIUM   |
| 11  | Retirement has a path                | It does not. The 2026-09-02 retirement deleted profiles, balances and history in one statement through `mgmt-api`. The rule "write a retirement row before deleting" exists only as a comment inside a migration                                                      | HIGH     |
| 12  | Horses are players                   | No horse-excluding filter found in any diamond writer. `fn_ca_is_cert_account` is a cert-fleet filter, not an `is_horse` filter, and it excludes cert accounts from the DRIFT MATH only, never from a payout. Clean on 10.5                                           | OK       |

---

## Writer classification (the deliverable)

**Safe to delete now (zero measured use, no caller in `pg_proc`, superseded):**

1. `award_purchase_diamonds(uuid,int,text,numeric)` - body is `RETURN;`. Verify no app-side
   caller first, because its comment claims a Stripe webhook writes `diamond_wallets` directly.
2. `fn_credit_diamonds(uuid,int,text)` - 3-arg overload, does not set `balance_after`.
3. `fn_credit_diamonds(uuid,int)` - duplicate of `fn_add_diamonds`.
4. `increment_diamonds(uuid,int)` - duplicate of `fn_add_diamonds`.
5. `fn_add_diamonds(uuid,int)` - keep at most one of items 2 to 5, and it should be
   `add_diamonds_to_balance`.
6. `transfer_diamonds_credit(uuid,int)` and `transfer_diamonds_deduct(uuid,int)` - superseded by
   `send_wallet_diamond_transfer`, and dangerous as separate callable halves.
7. `purchase_vip_with_diamonds_atomic(...)` v1 - v2 and v3 exist.
8. `complete_daily_challenge(uuid,uuid,int,numeric,int)` - superseded by `claim_daily_challenge(s)`.
9. `award_diamonds(uuid,int,text,jsonb)` - superseded by `award_diamonds_v2`, and it
   double-writes `user_diamonds.lifetime_earned` on top of the mirror trigger.
10. `create_user_progress_on_signup()` and the `user_progress.diamonds` column - a 10,700-diamond
    fossil nothing reads.

Caveat that applies to all ten: `track_functions` is off, so "zero use" here means no journal
shape attributable to them in 30 days AND no caller found in `pg_proc`. An app-side RPC call
would not appear. Each deletion needs one grep across the World Hub and Club Arena repos first.

**Must re-point before anything else changes:**

11. `initialize_user_diamonds()` - signup trigger granting 100 diamonds into `user_diamonds`,
    a table that is now an overwritten mirror. Re-point at `profiles` through
    `add_diamonds_to_balance` with a `signup:<user_id>` reference, or the grant is a no-op.
12. `claim_reward(uuid,text,jsonb)` and `update_daily_streak(uuid)` - a whole reward engine with
    a 500/day cap writing to `user_diamond_balance`. Same problem, and this one has real logic
    worth keeping.
13. `ca_promo_vault_buy(uuid,text,int)` - `authenticated`-executable, debits
    `club_diamond_wallets` with no journal row. Needs a club-side journal before the Arena uses it.
14. `fn_purchase_time_banks(int)` - `authenticated`-executable, no `reference_id`, replayable.
15. `fn_union_send_to_member_zd3core(...)` - journals without a reference; also note the
    privileged-column guard allowlists the name `fn_union_send_to_member`, not `..._zd3core`.
16. `fn_ca_diamond_snapshot()` - `v_total := v_prof + v_wal` must become `v_total := v_prof`
    (one line) or the gate stays wrong by 619,879 forever.
17. `fn_diamond_side_tables_follow_profiles()` - the `diamond_wallets` leg must UPSERT, or that
    mirror stays 892 users short.

**Plumbing (leave alone, they are load-bearing):**

18. `fn_diamond_balance_mirrors_canonical()` - the one-line BEFORE mirror.
19. `fn_ca_audit_diamond_change()` - the audit appender, with its own failure sink.
20. `fn_ca_journal_profile_deletion()` - the deletion tombstone.
21. `fn_ca_journal_append_only()` - the append-only guard (shared with the chip journals).
22. `fn_ca_mint()` / `fn_ca_burn()` - the Mint. Unused, correct, and the thing everything else
    should eventually route through.
23. `fn_reset_broken_streak_multipliers()`, `fn_sync_share_streak_multiplier(uuid)` - multiplier
    maintenance, not balances.
24. `economy_invariants()`, `fn_platform_invariants_health()`, `run_trivia_economy_audit_v1()`,
    `fn_ca_mint_velocity_watch()`, `verify_home_games_health_core()`, `audit_auth_integrity()` -
    read-only watchers.
25. `heal_auth_integrity()` - repair job, but it touches the dead `public.wallets` pool and
    should stop doing that.

Counts: **10 safe to delete after one grep, 7 must be re-pointed first, 8 plumbing groups to
leave alone**, on top of a healthy ring of 30 callers that already route through
`add_diamonds_to_balance` / `deduct_diamonds`.
