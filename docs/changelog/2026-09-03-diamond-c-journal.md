# Diamond Lane C: the journal names both sides, and it survives deletion

**2026-09-03. Branch `fix/diamond-c-journal`. Migration
`20260903031500_diamond_c_the_journal_keeps_both_sides_and_survives_deletion`
(recorded in `supabase_migrations.schema_migrations` as version
`20260903002317`, the timestamp the MCP assigned; the name is the file name).
Everything below was measured, not intended. Every probe was rolled back.**

Diamond Accounting Standard 2.2, 3.2 "Account deletion", DR3 / DR4 / DR5.
Nothing in this lane refuses a movement, moves a balance, or changes who may
call what. It records.

---

## 1. What production said before the change

| Fact                                                            | Measured                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `diamond_transactions` rows                                     | 1,432                                                                                          |
| rows with `counterparty` or `issuance_class` set                | 0 (both columns existed, nothing wrote either)                                                 |
| `ca_mint_ledger` rows for diamonds                              | 1 (Lane B's acknowledged baseline, supply 1,030,092)                                           |
| `ca_profile_deletions` rows                                     | 77, all 2026-09-02, 38 of them carrying 198,525 diamonds                                       |
| burn rows for those 77                                          | 0                                                                                              |
| `diamond_transactions` FKs                                      | 2, both `ON DELETE CASCADE` (`auth.users`, `profiles`)                                         |
| `ca_mint_ledger` FKs                                            | **none** (checked in `pg_constraint`: 5 CHECKs, 1 PK, 1 UNIQUE on `op_id`, zero `contype='f'`) |
| journal rows deleted under `app.ledger_maintenance` since 09-01 | 2,860 rows / 1,896,161 diamonds; 2,718 / 635,761 of them the certification fleet               |
| certification-fleet deletes per hour (last ten hours with any)  | 138, 11, 70, 77, 78, 9, 7, 141, 70, 70 rows (10 to 14 distinct users an hour)                  |

Function bodies read live from `pg_proc` (the repo mirror is stale in places):
`add_diamonds_to_balance` 3,403 chars, `deduct_diamonds` 2,303,
`fn_ca_journal_profile_deletion` 423, `fn_ca_journal_append_only` 3,681.

---

## 2. What changed

### 2.1 `add_diamonds_to_balance(uuid,int,text,text,text)` (3,403 -> 5,462 chars)

Reconstruction proved by diff against the live body before applying: the only
differences are three new DECLARE lines, the class/counterparty derivation
block, two columns on the journal INSERT, and the DR4 incident block. Every
existing behaviour is byte-identical, including the twelve-name exact-type
list and its `reference_id_required` return, the `duplicate_reference` return
with the stored balance, `SELECT ... FOR UPDATE`, `profile_not_found`, the
multiplier eligibility list and rounding, `insufficient_diamonds`, both
balance columns, the boost suffix, the metadata object and the return value.

The row it writes now carries:

| `p_type`                                                                      | `issuance_class` | `counterparty`        |
| ----------------------------------------------------------------------------- | ---------------- | --------------------- |
| `purchase`                                                                    | `purchased`      | `purchase_clearing`   |
| `refund` or anything ending `_refund`                                         | `refund`         | `revenue:<type>`      |
| `transfer`, `diamond_gift_received`, `live_gift_received`, `diamond_received` | `transferred`    | `player:unknown`      |
| `adjustment`                                                                  | `admin`          | `adjustment`          |
| `union_grant`, `signup_bonus`                                                 | `promotional`    | `promo_budget:<type>` |
| any negative amount not caught above                                          | `spend`          | `revenue:<type>`      |
| everything else                                                               | `earned`         | `promo_budget:<type>` |

`player:unknown` is deliberate: this entry point never receives the sender, so
the sender is named as unknown rather than invented. The two-sided transfer
functions are Lane F.

**DR4 is LOG ONLY.** A positive credit with `p_reference_id IS NULL` files
`fn_ca_diamond_incident('DR4:credit_without_reference', 'warning', ...)` after
the journal row is written, inside its own exception block, and the credit
proceeds exactly as before. Today that is every credit outside the twelve
settlement types: nine core writers pass NULL, and the two UNIQUE indexes on
`reference_id` protect nothing for them.

### 2.2 `deduct_diamonds(uuid,int,text,text,text,jsonb,text,int)` (2,303 -> 3,020)

Same proof by diff: two DECLARE lines, the derivation block, and two columns
on the INSERT. `issuance_class = 'spend'` and
`counterparty = 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown')`,
except for sources `wallet_transfer`, `wallet_diamond_transfer`, `stream_gift`
and transaction types `diamond_gift_sent`, `live_gift_sent`, which are
`transferred` to `player:<p_metadata->>'recipient_id'>` (or `player:unknown`).

### 2.3 `fn_ca_journal_profile_deletion()` (423 -> 2,888)

The BEFORE DELETE trigger on `profiles` already existed, so no trigger was
created on that table. The function keeps its `ca_profile_deletions` insert
verbatim and gains two steps, each in its own `BEGIN/EXCEPTION` block:

- every `diamond_transactions` row of the leaving profile is copied into the
  new `ca_diamond_journal_archive` (this runs before the CASCADE fires, so
  the rows are still there), stamped with `deleted_profile_id` and the
  current `app.ledger_maintenance` reason;
- if the leaving balance is above zero, a `ca_mint_ledger` burn row
  (`op_id = 'deletion:<uuid>'`, asset `diamonds`, holder `player`,
  `balance_after 0`, `supply_after = fn_ca_mint_supply('diamonds') - balance`,
  `performed_by NULL`) and a `DR5:deleted_with_balance` warning incident.

It contains no `RAISE EXCEPTION`. A deletion that would have succeeded still
succeeds.

### 2.4 `fn_ca_journal_append_only()` (3,681 -> 5,428)

Shared with the chip journals, so the refusal logic is untouched, proved by
diff: the allowed-UPDATE shapes for `chip_transactions` and `chip_ledger`, the
mutation log, the drift incident and the `P0403` exception are byte-identical.
The single addition, guarded by `TG_TABLE_NAME = 'diamond_transactions' AND
TG_OP = 'DELETE'`, copies the old row into the archive and files
`DR5:journal_row_deleted_under_maintenance` (info). The certification fleet
keeps working; what it removes stops being unrecoverable.

### 2.5 `ca_diamond_journal_archive`

Same columns as `diamond_transactions` plus `archived_at`,
`deleted_profile_id`, `deletion_reason`, `archived_by_role`, `archived_app`.
**No foreign keys** (asserted in the migration), RLS on, `REVOKE ALL FROM
PUBLIC, anon, authenticated`, `GRANT SELECT, INSERT TO service_role`, one
service-role policy. A table that referenced `profiles` could not outlive a
deleted profile, which is the whole point of it.

---

## 3. Rolled-back probe transcripts

### (a) `add_diamonds_to_balance` names the class and files DR4

`BEGIN; ... ROLLBACK;` on horse `00000000-0000-0000-0000-000000000025`
(drawingslim, 280 diamonds):

```
add_diamonds_to_balance(<horse>, 1, 'easter_egg', 'probe', NULL)
  -> {"amount":1,"success":true,"multiplier":1,"new_balance":281,"old_balance":280,
      "transaction_id":"35ccb1a0-5102-4c91-9e18-0e61ffec004b"}
journal row: amount 1, type easter_egg, transaction_type easter_egg,
             issuance_class "earned", counterparty "promo_budget:easter_egg",
             reference_id NULL, balance_after 281
DR4 incidents for this user: 1, detail {"type":"easter_egg","description":"probe"}
ROLLBACK
```

### (b) `deduct_diamonds` classes a sink debit

Same horse, `SET LOCAL "request.jwt.claims" = '{"role":"service_role"}'`
(the body's self-check exempts `service_role`):

```
deduct_diamonds(<horse>, 1, 'probe', 'feature_purchase', 'rabbit_hunt',
                '{}'::jsonb, 'probe:<uuid>', 0)
  -> {"balance":279,"charged":1,"success":true}
journal row: amount -1, type rabbit_hunt, issuance_class "spend",
             counterparty "revenue:rabbit_hunt",
             reference_id "probe:bb3a78d4-4dbe-44e4-b703-a9e419936d88"
ROLLBACK
```

### (c) Retirement

Two transactions, both rolled back.

**c1, no maintenance reason set**, on horse `4ffcc7ec` (barrelblitz, 415
diamonds, 100 closed seats):

```
DELETE FROM profiles WHERE id = '4ffcc7ec-...'
  -> SQLSTATE P0403
     "DELETE on chip_transactions is forbidden: financial journals are
      append-only ... Set app.ledger_maintenance ..."
ROLLBACK
```

That is the append-only guard refusing the CASCADE. It fires on whichever
journal the player has rows in first; for a player with diamond history it
fires on `diamond_transactions` the same way.

**c2, with the reason set**, on horse `e4d609b4` (harborvoss, 500 diamonds,
no seats). One journal row was inserted inside the transaction to give the
retirement something to archive, then:

```
SET LOCAL app.ledger_maintenance = 'probe: lane C retirement';
SET LOCAL app.deep_stack_teardown = 'on';        -- see 3.1 below
DELETE FROM profiles WHERE id = 'e4d609b4-...'

archived_rows                1
archived_detail              [{"type":"easter_egg","amount":1,
                               "issuance_class":"earned",
                               "counterparty":"promo_budget:easter_egg",
                               "deletion_reason":"probe: lane C retirement"}]
burn_row                     {"op_id":"deletion:e4d609b4-96aa-4159-bc42-988bc762557e",
                              "action":"burn","asset":"diamonds","holder_type":"player",
                              "amount":500,"balance_before":500,"balance_after":0,
                              "supply_after":1029592,"performed_by":null,
                              "db_role":"postgres"}
dr5_incident                 {"rule":"DR5:deleted_with_balance","severity":"warning",
                              "amount":500,"writer":"profiles DELETE",
                              "detail":{"is_horse":true,"username":"harborvoss",
                                        "journal_rows_archived":1,
                                        "ledger_maintenance":"probe: lane C retirement"}}
cascade_delete_incidents     1     (DR5:journal_row_deleted_under_maintenance,
                                    filed by the append-only path when the CASCADE
                                    removed the row the deletion trigger had just archived)
journal_rows_left            0
profile_rows_left            0
ROLLBACK
```

State after every probe, re-read: harborvoss 1 row / 500 diamonds, barrelblitz
1 row, `ca_diamond_journal_archive` 0 rows, `ca_diamond_incidents` 0 rows,
`ca_mint_ledger` 1 row, `diamond_transactions` 1,432 rows,
`ca_profile_deletions` 77 rows. Nothing committed.

### 3.1 Three things the deletion probe found on the way, none of them Lane C's

1. **A profile DELETE is refused outright unless `app.ledger_maintenance` is
   set**, because the CASCADE into `chip_transactions` and
   `diamond_transactions` hits the append-only trigger (probe c1). This is
   almost certainly why the 77 profiles deleted on 09-02 show no journal rows
   in `ca_ledger_mutation_log`: a profile with journal history cannot be
   deleted by a path that does not set the reason.
2. **`profiles` cannot be deleted at all while the player has a row in
   `user_daily_challenges` or `challenge_streak_state`.** Both carry
   `AFTER INSERT OR DELETE OR UPDATE` triggers running
   `bump_daily_challenge_dashboard_revision()`, which INSERTs into
   `daily_challenge_dashboard_revisions` for a `user_id` the CASCADE has just
   removed: `23503 ... violates foreign key constraint
daily_challenge_dashboard_revisions_user_id_fkey`. That is why
   `cleanup_reserved_certification_account` deletes those two tables by hand
   first. The probe reproduced the failure and then followed the same order.
3. **`fn_deep_stack_society_cannot_be_deleted_by_accident()`** refuses the
   `club_members` cascade for club 11192 unless
   `app.deep_stack_teardown = 'on'`, exactly as its own HINT says. The probe
   used that transaction-local switch and rolled back.

A fourth observation, from a probe that timed out: deleting a heavily-played
profile is O(journal rows) `ca_drift_incidents` upserts, one per deleted chip
or diamond journal row, through `fn_ca_raise_drift_incident`. A horse with 100
seats and its chip history exceeded a 40-second statement timeout on that
UPDATE alone. Nothing was committed. Worth knowing before anyone builds a bulk
retirement.

---

## 4. The certification-fleet cleanup (read, not modified)

`cleanup_reserved_certification_account(p_user_id uuid)`, 3,481 chars,
SECURITY DEFINER, `search_path ''`, `statement_timeout 10min`. It:

1. locks `auth.users` for the id and REFUSES unless the email matches
   `ca-customization-cert-%@example.invalid`;
2. sets `app.ledger_maintenance = 'certification-cleanup:<uuid>'` with
   `set_config(..., true)` so the permission is transaction-local;
3. deletes 23 tables by `user_id`, `diamond_transactions` and
   `diamond_wallets` among them, then `public.users` and `auth.users`;
4. asserts the identity is gone and returns.

Cadence and volume, from `ca_ledger_mutation_log` (source_table
`diamond_transactions`, operation DELETE, reason `certification-cleanup:%`):
2,718 rows / 635,761 diamonds since 2026-09-01, hourly; the last ten hours
with any activity were 138, 11, 70, 77, 78, 9, 7, 141, 70, 70 rows across 10
to 14 distinct users each.

It is not modified. Item 2.4 above already preserves every row it deletes,
which is the outcome the standard asks for, and rewriting a cleanup that
guards itself on an email pattern would be a refusal risk for no gain.

---

## 5. World Hub follow-up (not edited in this lane)

`pages/api/auth/delete-account.js` line 207 deletes `user_diamond_balance` and
line 213 deletes `diamond_transactions` by `user_id`. It does **not** set
`app.ledger_maintenance` anywhere in the file (grepped). So:

- the `diamond_transactions` delete is refused by `trg_ca_append_only` with
  `P0403`. `eraseFrom` catches that, pushes `{table, error}` onto
  `erasureFailures` and **returns false without stopping**;
- the route then deletes `profiles` (line ~236), whose CASCADE hits the same
  trigger and is refused the same way. That error is NOT swallowed: the route
  returns HTTP 500 with "Your profile could not be removed, so the deletion
  was stopped before your login was destroyed."

**Therefore self-service account deletion currently fails for any user who has
a single `chip_transactions` or `diamond_transactions` row** (and separately,
per 3.1 item 2, for any user with a daily-challenge row). The user is told to
contact support. Nothing is half-deleted, which is the one thing the route
gets right.

Recommended change, for a World Hub PR (not this repo, and not this lane):
replace the hand-rolled table sweep with a single `retire_profile` RPC that
sets `app.ledger_maintenance` to a deletion reference once, deletes the two
challenge tables before the profile (as the certification cleanup does), and
lets the trigger written here archive the journal and record the burn. Until
then, the route deletes no diamond history at all, so nothing is being lost by
it either.

---

## 6. What is log only, and what is not built

- **Log only:** DR4 (`add_diamonds_to_balance` records a credit without a
  reference and still pays it), DR5's two incidents, and the archive. No
  refusal anywhere in this migration.
- **Not built, deliberately:** the CASCADE foreign keys stay CASCADE.
  Standard 3.2 asks for `ON DELETE RESTRICT` with a retire function as the
  only path; that would refuse a live deletion flow, which is Dan's stated
  risk rule, and the archive achieves the retention without the refusal.
- **Not built:** `counterparty` and `issuance_class` are not NOT NULL and the
  1,432 historical rows are not backfilled to `unknown`. Backfilling them
  means UPDATEing the journal, which the append-only trigger refuses without
  `app.ledger_maintenance`, and setting that GUC to rewrite history is the
  exact bypass this lane exists to make loud. It belongs in a four-eyes
  maintenance window, not in a migration.
- **Not built:** the certification cleanup does not write reversal rows
  instead of deleting (standard Lane C). Its deletes are now archived, which
  answers the retention question; turning its DELETEs into reversals changes
  a working cleanup and is Dan's call.

## 7. Decisions that are Dan's

1. **When does DR4 stop being log only** and start refusing a positive credit
   with no reference. Nine core writers pass NULL today, so flipping it now
   would refuse real credits.
2. **The historical backfill** of `counterparty` / `issuance_class` to
   `unknown`, and whether the columns ever become NOT NULL.
3. **Account deletion policy** (standard 6.5): burn the balance, which is
   what the register now records, or escheat it to the house. The trigger
   records a burn; if the answer is escheat, the burn row becomes a transfer
   to `ca_diamond_house` and this trigger is where it changes.
4. **The two blockers a real deletion hits** (3.1 items 1 and 2): whether the
   append-only guard should learn a sanctioned `account-deletion:<id>` reason,
   and whether the daily-challenge triggers should skip a user that no longer
   exists. Both are outside this lane and both currently make self-service
   deletion impossible.
