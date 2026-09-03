# Phase 3 - Conflict audit of the diamond fix lanes (READ-ONLY, 2026-09-03)

Read-only audit run 2026-09-03 00:45 to 01:00 UTC against production
`kuklfnapbkmacvwxktbh`. Nothing was applied, written, committed or pushed. Every
statement below is a SELECT, a `pg_get_functiondef` / `pg_proc.prosrc` read, a
`git` read command, or a GitHub REST GET. Sources: the six lane changelogs in
`/Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-{a,b,c,d,e,g}/docs/changelog/2026-09-03-diamond-*.md`,
the migration files in each worktree's `supabase/migrations/`, and the live
database.

## Deploy state discovered during the audit (context for every item)

| Fact                                                           | Evidence                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All eleven lane migrations are registered live                 | `supabase_migrations.schema_migrations` versions `20260903000735` (foundation), `002248`, `002317`, `002333`, `002841`, `003036`, `003128`, `003327`, `003403`, `003714`, `004002`                                             |
| The orchestrator's baseline correction is **NOT applied**      | No row named `diamond_p3_the_baseline_is_circulation_not_the_house` in `schema_migrations` at 00:54 UTC                                                                                                                        |
| Lane C's PR #2744 is MERGED into `main`                        | GitHub API: `merged=True merged_at=2026-09-03T00:42:38Z`; `git ls-tree origin/main` contains `supabase/migrations/20260903031500_diamond_c_...sql` and `tests/law/DiamondJournalNamesBothSidesAndSurvivesDeletion.law.test.ts` |
| The other five PRs are open, non-draft and `dirty`             | GitHub API on #2745, #2748, #2750, #2751, #2752: `state=open draft=False mergeable=False mergeable_state=dirty`                                                                                                                |
| The supply identity holds                                      | `fn_ca_mint_supply('diamonds')` = 1030092.00 = `SUM(profiles.diamonds)` = 1030092                                                                                                                                              |
| The platform was idle across the whole window                  | `diamond_transactions` rows since 2026-09-03 00:07 UTC: **0**. No live traffic exercised any rewritten writer                                                                                                                  |
| One chip-side write failure landed inside the migration window | `ca_ledger_write_failures` id 704, 00:31:49 UTC, `40P01 deadlock detected`, `fn_ca_fund_overlay_on_lock` tournament `1068cd04`, 18.00 chips, club `fade0000-...-0001`                                                          |

## Verdict table

| #   | Item                                                                                              | Verdict                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                              | Fix owner                           |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1a  | `fn_ca_mint` / `fn_ca_burn`: B's 7th arg + house destination vs A's revoke-by-name                | **NO CONFLICT**                                            | `fn_ca_mint(text,text,uuid,numeric,text,text,text)` prosrc 8281 (B claimed 8281), `p_class` and `ca_diamond_house` present; ACL `postgres=X \| service_role=X` (A's revoke took). Same for `fn_ca_burn` 8449. Both edits live simultaneously                                                                                                                                                                          | none                                |
| 1b  | `fn_ca_mint` chip branch vs the repo mint file                                                    | **NO CONFLICT**                                            | Live chip ELSE branch is byte-identical to `20260902172915_the_mint_issuance_and_retirement.sql` lines 215-249 except one added line `v_holder := p_target_id;`                                                                                                                                                                                                                                                       | none                                |
| 1c  | `deduct_diamonds` (C) vs `fn_purchase_time_banks` (A)                                             | **NO CONFLICT**                                            | `deduct_diamonds` prosrc 3020 = C's number, returns `success`/`balance`/`idempotent`; `fn_purchase_time_banks` 5422 calls it and derives nothing itself                                                                                                                                                                                                                                                               | none                                |
| 1d  | `add_diamonds_to_balance` (C) vs E's trivia edit and D's settle/refund                            | **NO CONFLICT**                                            | prosrc 5462 = C's number. `settle_diamond_card_purchase_atomic` and `reconcile_diamond_purchase_refund` both call it; `enter_trivia_tournament_v2` calls it                                                                                                                                                                                                                                                           | none                                |
| 1e  | D's `UPDATE diamond_transactions SET counterparty, issuance_class` vs C's append-only guard       | **NO CONFLICT (two independent reasons)**                  | (i) the guard's generic ELSE branch permits an UPDATE when `amount` and `created_at` are unchanged; (ii) C's `add_diamonds_to_balance` already writes `purchase_clearing`/`purchased` for `p_type='purchase'`, so `WHERE counterparty IS NULL` matches 0 rows                                                                                                                                                         | none                                |
| 1f  | `award_diamonds_v2` patched by E, untouched by C and G                                            | **NO CONFLICT (confirmed)**                                | prosrc 25204 = E's post-apply number (25090 + 114); contains `issuance_class` and `counterparty`, 2 x `FOR UPDATE`; neither C's nor G's migration names it (grep of both files)                                                                                                                                                                                                                                       | none                                |
| 1g  | `handle_new_user` (B) vs G's audit trigger firing on its INSERT                                   | **NO CONFLICT**                                            | prosrc 8369 = B's number; the trigger it fires (`zz_ca_audit_diamond_change`, G) has no reachable `RAISE EXCEPTION` and is wrapped in `EXCEPTION WHEN OTHERS`                                                                                                                                                                                                                                                         | none                                |
| 1h  | `fn_ca_journal_profile_deletion` (C) vs D's three new tables with no FK                           | **NO CONFLICT**                                            | prosrc 2888 = C's number, writes `ca_diamond_journal_archive` and a `deletion:<uuid>` burn; `diamond_purchase_lots` / `diamond_debts` / `diamond_purchase_disputes` carry no FK to `profiles`, so a deletion neither cascades into them nor is refused by them                                                                                                                                                        | none                                |
| 1i  | `fn_ca_journal_append_only` (C) vs E's AFTER INSERT trigger on the same table                     | **NO CONFLICT**                                            | The append-only trigger is `BEFORE DELETE OR UPDATE` only; E's is `AFTER INSERT`. Disjoint events, no ordering interaction                                                                                                                                                                                                                                                                                            | none                                |
| 1j  | `fn_ca_diamond_snapshot` (A) vs G's trial balance reading `ca_diamond_snapshots.profile_diamonds` | **NO CONFLICT**                                            | G reads `s0.profile_diamonds`, the column A left untouched and which has always meant `SUM(profiles.diamonds)`. A changed `total`, which G never reads                                                                                                                                                                                                                                                                | none                                |
| 1k  | `fn_ca_audit_diamond_change` (G) vs B's `zz_ca_diamond_born_with_balance`                         | **NO CONFLICT**                                            | Two distinct triggers, distinct functions, both log-only, both `EXCEPTION WHEN OTHERS`, both `RETURN NULL`. Firing order by name: `zz_ca_audit_diamond_change` then `zz_ca_diamond_born_with_balance`                                                                                                                                                                                                                 | none                                |
| 2   | Trigger order on `profiles`                                                                       | **NO CONFLICT**                                            | 19 non-internal triggers; 9 BEFORE INSERT, 3 AFTER INSERT + 1 shared, no duplicates, no second name for either new trigger. Neither new AFTER trigger can raise                                                                                                                                                                                                                                                       | none                                |
| 3   | Triggers on `diamond_transactions`                                                                | **NO CONFLICT, one RISK**                                  | Order: `trg_enforce_anti_farming_caps` (BEFORE INSERT), row, `trg_ca_diamond_earn_ledger` (AFTER INSERT WHEN amount>0). E's trigger **does** fire on B's signup rows (class `promotional`/`seeded` are not in the skip list) and charges the `signup` budget line. It does **not** fire on Mint rows at default class `admin`. No double count                                                                        | RISK: Lane E, noise only            |
| 4   | Reference-id shapes vs the two UNIQUE indexes and `ca_mint_ledger.op_id`                          | **NO CONFLICT, one latent RISK**                           | `idx_diamond_transactions_reference_id` is UNIQUE on `reference_id` **globally**, not per user. Every shape a lane writes embeds a uuid (`signup:`, `tbank_<user>_`, `trivia_tourn_*_<tid>_<uid>`, `diamond-refund:<pid>:<target>`, the bare purchase uuid), so none can collide. Any future unscoped shape would collide platform-wide                                                                               | RISK: whoever writes the next shape |
| 5   | The baseline booked to `holder_type='house'`                                                      | **CONFLICT (live, unfixed) and the correction is BLOCKED** | `ca_mint_ledger` holds exactly one row, `baseline:diamonds:2026-09-03`, `holder_type='house'`, 1030092.00. `fn_ca_diamond_trial_balance` still reports `diamond_house` difference **-1030092.00**. The correction migration is not applied. **`ca_mint_ledger_holder_type_check` allows only club, union, player, house - a re-post to `circulation` raises 23514 unless the CHECK is widened in the same migration** | Orchestrator                        |
| 6a  | New `ca_payout_freeze` scopes vs `fn_settle_tournament_obligation`                                | **NO CONFLICT**                                            | Live body reads `f.scope = 'tournament_payouts' AND f.cleared_at IS NULL` and nothing else. 0 open freezes                                                                                                                                                                                                                                                                                                            | none                                |
| 6b  | `ca_manual_adjustments.asset` vs propose / approve / reject                                       | **NO CONFLICT**                                            | One overload of `fn_ca_propose_manual_adjustment` (8 args, `p_asset` defaults NULL and derives from target kind). `fn_ca_approve_manual_adjustment` and `fn_ca_reject_manual_adjustment` never mention `asset` or `target_kind`. Table holds 0 rows                                                                                                                                                                   | none                                |
| 6c  | Chip `fn_ca_trial_balance` unchanged                                                              | **NO CONFLICT**                                            | Only one lane file mentions it: `diamond_g_controls.sql` line 15, inside a comment. No lane redefines it                                                                                                                                                                                                                                                                                                              | none                                |
| 6d  | `ca_money_rpc_registry` consumer                                                                  | **NO CONFLICT**                                            | Sole consumer `fn_ca_money_rpc_drift` scans `pg_proc` for CHIP-balance writers and warns on those NOT in the registry. A row can only suppress its own name; it can never create a warning. 274 rows, 4 diamond keys present                                                                                                                                                                                          | none                                |
| 6e  | Cost of the new `profiles` triggers to chip paths                                                 | **NO CONFLICT (zero cost on UPDATE)**                      | G **replaced** `zz_ca_audit_diamond_change` under the same name (DROP + CREATE, migration line 518-520). B added one AFTER **INSERT** trigger. A chip function that UPDATEs `profiles` pays exactly the same trigger count as before                                                                                                                                                                                  | none                                |
| 7   | Live behaviour since landing                                                                      | **NO CONFLICT, one RISK**                                  | 2 incidents (both DR11, 00:38:39). 0 journal rows since 00:07, so no writer was exercised in production. 1 chip write failure (40P01 deadlock) at 00:31:49, inside the A/G migration window                                                                                                                                                                                                                           | RISK: the DDL burst, see below      |
| 8a  | `docs/LAWS.md`                                                                                    | **CONFLICT (repo, all pairs)**                             | `git merge-tree --write-tree --messages`: `CONFLICT (content): Merge conflict in docs/LAWS.md` for **all 15 branch pairs** and for 5 of 6 branches against `origin/main`                                                                                                                                                                                                                                              | Whoever merges each PR              |
| 8b  | Test file names, LAWS row ids, migration versions                                                 | **NO CONFLICT**                                            | Six distinct `tests/law/Diamond*.law.test.ts` names, six distinct row ids, eleven distinct migration version numbers. Only shared changed file across branches is `docs/LAWS.md`                                                                                                                                                                                                                                      | none                                |
| 8c  | Lane C's migration filename vs its registered version                                             | **RISK (cosmetic)**                                        | File is `20260903031500_...`, registered version is `20260903002317`. Documented in C's changelog. A future agent sorting by filename will place C after every other lane                                                                                                                                                                                                                                             | Lane C / roadmap                    |

---

## Item 1 - functions two or more lanes touched

### Live marker matrix

Query:

```sql
select p.proname, p.oid::regprocedure::text, length(p.prosrc), md5(p.prosrc),
 (p.prosrc like '%house%'), (p.prosrc like '%issuance_class%'),
 (p.prosrc like '%counterparty%'), (p.prosrc like '%FOR UPDATE%'),
 (p.prosrc like '%fn_ca_diamond_incident%'), (p.prosrc like '%deletion:%'),
 (p.prosrc like '%ca_diamond_house%'), (p.prosrc like '%p_class%'),
 (p.prosrc like '%ca_diamond_journal_archive%'),
 array_to_string(p.proacl,' | ')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (...);
```

| function                                            | live len | lane claim              | house | class | cparty | FOR UPDATE | incident | archive | ACL                                         |
| --------------------------------------------------- | -------- | ----------------------- | ----- | ----- | ------ | ---------- | -------- | ------- | ------------------------------------------- |
| `fn_ca_mint(text,text,uuid,numeric,text,text,text)` | 8281     | B: 8281                 | yes   | yes   | yes    | yes        | no       | no      | postgres, service_role                      |
| `fn_ca_burn(...,text)`                              | 8449     | B: 8449                 | yes   | yes   | yes    | yes        | no       | no      | postgres, service_role                      |
| `handle_new_user()`                                 | 8369     | B: 8369                 | no    | yes   | yes    | no         | yes      | no      | postgres, service_role, supabase_auth_admin |
| `add_diamonds_to_balance`                           | 5462     | C: 5462                 | no    | yes   | yes    | yes        | yes      | no      | postgres, service_role                      |
| `deduct_diamonds`                                   | 3020     | C: 3020                 | no    | yes   | yes    | yes        | no       | no      | postgres, service_role                      |
| `fn_ca_journal_profile_deletion()`                  | 2888     | C: 2888                 | no    | yes   | yes    | no         | yes      | yes     | postgres, service_role                      |
| `fn_ca_journal_append_only()`                       | 5428     | C: 5428                 | no    | yes   | yes    | no         | yes      | yes     | postgres, service_role                      |
| `award_diamonds_v2`                                 | 25204    | E: 25204                | no    | yes   | yes    | yes (x2)   | no       | no      | postgres, service_role                      |
| `enter_trivia_tournament_v2`                        | 3908     | E (edited)              | yes   | no    | no     | yes        | yes      | no      | postgres, service_role                      |
| `fn_ca_diamond_snapshot()`                          | 5472     | A: 5472                 | no    | no    | no     | no         | yes      | no      | postgres, service_role                      |
| `fn_purchase_time_banks(int)`                       | 5422     | A: 5422                 | no    | yes   | yes    | no         | no       | no      | postgres, **authenticated**, service_role   |
| `settle_diamond_card_purchase_atomic`               | 9107     | D: 9107                 | no    | yes   | yes    | yes        | yes      | no      | postgres, service_role                      |
| `reconcile_diamond_purchase_refund`                 | 8622     | D: 8622                 | no    | yes   | yes    | yes        | yes      | no      | postgres, service_role                      |
| `fn_ca_audit_diamond_change()`                      | 4176     | G (writer + money_path) | no    | no    | no     | no         | yes      | no      | postgres, **authenticated**, service_role   |
| `fn_ca_diamond_trial_balance`                       | 13158    | G                       | yes   | no    | yes    | no         | no       | no      | postgres, service_role                      |
| `fn_ca_diamond_earn_ledger()`                       | 4036     | E                       | no    | yes   | no     | no         | yes      | no      | postgres, service_role                      |

**Every lane's claimed post-apply length matches the live body exactly.** No
lane's edit was clobbered by a later lane. The two edits that most plausibly
collided (Lane B recreating `fn_ca_mint` with a seventh argument at 00:22, Lane
A revoking EXECUTE on it at 00:30) are BOTH present: `p_class` is in the body
and `authenticated` is out of the ACL. A's changelog section 7 item 2 records
exactly this near-miss - its first apply raised 42883 on a hardcoded
six-argument signature and it switched to a loop over `pg_proc` by name.

### 1e - the one interaction that looked like a conflict and is not

`settle_diamond_card_purchase_atomic` (Lane D) contains, verbatim from the live
body:

```sql
    UPDATE public.diamond_transactions
       SET counterparty = 'purchase_clearing', issuance_class = 'purchased'
     WHERE reference_id = v_purchase.id::text
       AND user_id = v_purchase.user_id
       AND counterparty IS NULL;
```

An UPDATE on `diamond_transactions` fires Lane C's `trg_ca_append_only`
(`BEFORE DELETE OR UPDATE`). It does not fail, for two independent reasons:

1. The live guard's generic branch (read in full from `pg_proc`) is

   ```sql
   ELSE
     v_allowed_update :=
       NEW.amount IS NOT DISTINCT FROM OLD.amount
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
   END IF;
   ...
   IF TG_OP = 'UPDATE' AND v_allowed_update THEN RETURN NEW; END IF;
   ```

   `diamond_transactions` falls into that ELSE, and this UPDATE changes neither
   column, so it is permitted with no `app.ledger_maintenance` and no incident.

2. `add_diamonds_to_balance` (Lane C) already sets both columns for
   `p_type = 'purchase'`, so `AND counterparty IS NULL` matches zero rows and
   the trigger never fires at all. Lane D's probe (a) confirms this: the journal
   row came back with `counterparty purchase_clearing`, `issuance_class
purchased` while `5_dr8_fired {count: 0}`.

Even in the failure case the settle is safe: the UPDATE sits inside a
`BEGIN ... EXCEPTION WHEN OTHERS` that files `DR9:purchase_lot_write_failed`
and lets the paid purchase stand.

**A documentation correction falls out of this.** Lane C's changelog section 6
says the historical backfill of `counterparty` / `issuance_class` was not built
because "the append-only trigger refuses" an UPDATE "without
`app.ledger_maintenance`". The live guard's ELSE branch says otherwise: an
UPDATE that touches neither `amount` nor `created_at` is permitted outright. The
decision to defer the backfill is still sound; the stated reason is wrong.

### 1b - the chip branch of `fn_ca_mint`, diffed

Live body from `position('fn_ca_declare_ledger(''mint''' in prosrc)` for 2100
characters, against
`/Users/smarter.poker/Documents/club-arena/supabase/migrations/20260902172915_the_mint_issuance_and_retirement.sql`
lines 215-249. Identical through the club branch (`clubs.chip_treasury`,
`chip_transactions` `treasury_mint`), the union branch (`union_wallets` upsert,
`FOR UPDATE`, `chip_balance`), the `chip_ledger` id lookup and the three
`set_config` resets. One added line before `END IF;`:

```
    v_holder := p_target_id;
```

which feeds B's new `holder_id` variable (needed because the diamond/house
branch substitutes the sentinel `00000000-0000-0000-0000-00000000d1a0`). No
chip behaviour changed.

---

## Item 2 - trigger order on `profiles`

`select tgname, tgtype, pg_get_triggerdef(oid) from pg_trigger where
tgrelid='public.profiles'::regclass and not tgisinternal order by tgname` returns
19 rows, all `tgenabled='O'`, all FOR EACH ROW.

**BEFORE INSERT, in firing order (name order):**

1. `tr_generate_referral_code`
2. `trg_aa_diamond_balance_mirrors_canonical` (BEFORE INSERT OR UPDATE OF diamonds, diamond_balance)
3. `trg_normalize_username`
4. `trg_profiles_assign_player_number`
5. `trg_profiles_cosmetics_ownership`
6. `trg_protect_profile_username_and_gate`
7. `trg_reject_horse_name_on_human`
8. `trg_sync_mfa_required_on_role_change`
9. `trg_validate_home_url_fields`

**AFTER INSERT, in firing order:**

1. `trg_auto_connect_dan`
2. `trg_mirror_profile_into_legacy_users`
3. `zz_ca_audit_diamond_change` (**Lane G**, `AFTER INSERT OR UPDATE OF diamonds`)
4. `zz_ca_diamond_born_with_balance` (**Lane B**, `AFTER INSERT ... WHEN (new.diamonds IS NOT NULL AND new.diamonds <> 0)`)

**AFTER UPDATE OF diamonds, in firing order:**

1. `trg_daily_challenge_revision_from_diamonds`
2. `trg_diamond_side_tables_follow_profiles` (**Lane A** rewrote its function)
3. `zz_ca_audit_diamond_change` (**Lane G**)

**Nothing fires twice and nothing was duplicated under a second name.** G's
migration line 518-520 is `DROP TRIGGER IF EXISTS zz_ca_audit_diamond_change ON
public.profiles;` then `CREATE TRIGGER zz_ca_audit_diamond_change` - a
replacement, so the AFTER UPDATE path carries exactly the trigger count it
carried before. The only net addition on `profiles` is B's AFTER **INSERT**
trigger, which no chip path executes.

**Both new AFTER triggers are log-only.** Full bodies read:

- `fn_ca_diamond_born_with_balance` (B): two `BEGIN ... EXCEPTION WHEN OTHERS
THEN RAISE WARNING` blocks around `fn_ca_diamond_incident` and a `ca_mint_ledger`
  INSERT with `ON CONFLICT (op_id) DO NOTHING`, then `RETURN NULL`. Zero
  `RAISE EXCEPTION`.
- `fn_ca_audit_diamond_change` (G): `prosrc like '%RAISE EXCEPTION%'` is
  **false**; G's changelog records the whole body inside `BEGIN ... EXCEPTION
WHEN OTHERS` with a `ca_ledger_write_failures` sink and an unconditional
  `RETURN NEW`.

**One ACL anomaly worth recording (not a conflict).** `fn_ca_audit_diamond_change`
carries `authenticated=X/postgres`. It is a trigger function, so Postgres
refuses to call it as an RPC and the grant cannot be used - the same inert
grant Lane A noted on `fn_diamond_side_tables_follow_profiles` (its section 7
item 3). Noise in the ACL, not a door.

---

## Item 3 - triggers on `diamond_transactions`

```
trg_enforce_anti_farming_caps   BEFORE INSERT              fn_enforce_anti_farming_caps
trg_ca_append_only              BEFORE DELETE OR UPDATE    fn_ca_journal_append_only   (Lane C rewrote the fn)
trg_ca_diamond_earn_ledger      AFTER INSERT WHEN (new.amount > 0)  fn_ca_diamond_earn_ledger (Lane E)
```

Firing order for an INSERT: anti-farming (BEFORE), row written, earn ledger
(AFTER). The append-only guard never participates in an INSERT. **No ordering
conflict.**

**Does E's trigger run on rows written by B's `handle_new_user`? YES.** The live
skip list is `issuance_class IN ('purchased','transferred','refund','admin','arena')`
plus `type/transaction_type = 'purchase'`. B writes `promotional` (this function
granted the 500) or `seeded` (it arrived with the profile) - neither is skipped,
and `type` is `signup_bonus`. Attribution confirmed by calling the pure mapper:

```sql
select public.fn_ca_diamond_engine_of('signup_bonus','signup_bonus','handle_new_user',
       'Welcome bonus','signup:11111111-1111-1111-1111-111111111111');
-- signup
```

`diamond_reward_budgets` carries a `signup` line at 2,500,000 for 2026-09 and
2026-10, so the charge lands somewhere real.

**Does it run on Mint rows? Only if the caller asks for it.** `fn_ca_mint`'s
`p_class` defaults to `'admin'`, which IS in the skip list, so a default Mint
issuance charges no budget. A caller passing `promotional` or `earned` would
charge a line - which is the intended behaviour, not a defect.

**Does anything double-count? No.** One journal row per signup produces one
budget increment and one daily-award increment. B's register write is in a
different table (`ca_mint_ledger`) and is additionally deduped three ways: NOT
EXISTS on the journal by type or reference, NOT EXISTS on the register by this
user's `signup:` or `seed:` op_id, and `ca_mint_ledger.op_id` UNIQUE underneath.
B's probe (c)/(d) showed the register keeping **one** row per user, the `seed:`
one, with the `signup:` one correctly skipped.

**RISK (noise, bounded).** The horse seeder created 416 profiles at 500 diamonds
each since 2026-09-01 (B's measurement). Every future seeded profile now writes
a `signup` journal row that charges the `signup` budget line and a
`DR2:balance_born_outside_the_mint` warning. At 419 signups per 48 hours that is
about 105,000 diamonds a month against a 2,500,000 placeholder line - no
`DR7:engine_over_budget`, but roughly 200 DR2 warnings a day in
`ca_diamond_incidents`. B's changelog anticipates this ("expect roughly one
warning per new profile"). It refuses nothing.

---

## Item 4 - key shapes vs consumers

Indexes read from `pg_index`:

| index                                      | unique  | definition                                                                 |
| ------------------------------------------ | ------- | -------------------------------------------------------------------------- |
| `idx_diamond_transactions_reference_id`    | **yes** | `(reference_id) WHERE reference_id IS NOT NULL` - **global, not per user** |
| `diamond_transactions_user_reference_uidx` | yes     | `(user_id, reference_id) WHERE reference_id IS NOT NULL`                   |
| `ca_mint_ledger_op_id_key`                 | yes     | `(op_id)`                                                                  |

The global index is the strict one; the per-user index is redundant beneath it.

| shape                                              | writer                                   | table                                      | collision risk                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup:<uid>`                                     | `handle_new_user` (B)                    | journal + `ca_mint_ledger`                 | none, uuid-scoped                                                                                                                                                               |
| `seed:<uid>`                                       | `fn_ca_diamond_born_with_balance` (B)    | `ca_mint_ledger`                           | none; different prefix from `signup:`, and B's handle_new_user skips its own register row when either exists                                                                    |
| `tbank_<user>_<qty>_<epoch_seconds>`               | `fn_purchase_time_banks` (A)             | journal                                    | none across users; a same-second retry for the same user replays through `deduct_diamonds`'s `idempotent: true` and A added a guard that skips the entitlement insert on replay |
| `trivia_tourn_entry_<tid>_<uid>`                   | `enter_trivia_tournament_v2` (E)         | journal                                    | none                                                                                                                                                                            |
| `trivia_tourn_cut_<tid>_<uid>`                     | `enter_trivia_tournament_v2` (E)         | `ca_diamond_house_ledger.reference` UNIQUE | none                                                                                                                                                                            |
| `<purchase_id>` (bare uuid)                        | `add_diamonds_to_balance` via settle (D) | journal                                    | none                                                                                                                                                                            |
| `diamond-refund:<purchase_id>:<cumulative_target>` | `reconcile_diamond_purchase_refund` (D)  | journal                                    | none; a second partial refund carries a different target, and an identical replay returns early (D probe 8: `balance_applied 0`)                                                |
| `deletion:<uid>`                                   | `fn_ca_journal_profile_deletion` (C)     | `ca_mint_ledger`                           | none                                                                                                                                                                            |
| `baseline:diamonds:2026-09-03`                     | B's migration                            | `ca_mint_ledger`                           | none, one row                                                                                                                                                                   |

**No shape two writers could collide on.** The latent RISK is structural rather
than lane-specific: because `idx_diamond_transactions_reference_id` is global,
any future reference shape that does not embed a uuid becomes a platform-wide
singleton, and the second writer to use it gets 23505 rather than a per-user
duplicate. Every lane happened to get this right; nothing in the schema
enforces it.

---

## Item 5 - the baseline conflict (the one live break)

**Current state, read at 00:54 UTC.**

```sql
select op_id, action, holder_type, holder_label, amount, balance_before,
       balance_after, supply_after, created_at from public.ca_mint_ledger;
```

```
baseline:diamonds:2026-09-03 | mint | house
  | "all player wallets (pre-standard circulation, not ca_diamond_house)"
  | 1030092.00 | 0.00 -> 1030092.00 | supply_after 1030092.00
  | 2026-09-03 00:22:48.447506+00
```

```sql
select public.fn_ca_mint_supply('diamonds'),
       (select sum(diamonds) from public.profiles),
       (select balance from public.ca_diamond_house where id=1),
       (select count(*) from public.ca_diamond_house_ledger);
-- 1030092.00 | 1030092 | 0 | 0
```

`fn_ca_diamond_trial_balance(now() - interval '24 hours')` at 00:55 UTC:

| account             | balance_now | balance_delta | journal_net | mint_net       | difference      |
| ------------------- | ----------- | ------------- | ----------- | -------------- | --------------- |
| player_diamonds     | 1030092     | 115           | 115         | 0              | **0**           |
| **diamond_house**   | **0**       | **0**         | null        | **1030092.00** | **-1030092.00** |
| diamond_debts       | 0           | null          | null        | null           | null            |
| promo_budgets_spent | 0           | null          | null        | null           | null            |
| mirror_mismatch     | 0           | null          | null        | null           | null            |
| dead_stores         | 37241.00    | null          | null        | null           | null            |
| suspense            | 0           | null          | 0           | null           | null            |
| total               | 1030092     | 115           | 115         | 1030092.00     | 0               |

**The break is live and unfixed.** `ca_diamond_incidents` holds exactly two rows,
both from the watch's single manual run at 00:38:39 UTC:
`DR11:trial_balance_break` (warning, amount -1030092, writer `diamond_house`) and
`DR11:trial_balance_summary` (info). The hourly cron
`ca-diamond-trial-balance-hourly` (`20 * * * *`, jobid 247) will file the same
warning at 01:20 and every hour until the baseline is moved.

**The correction migration is not applied.** No row named
`diamond_p3_the_baseline_is_circulation_not_the_house` exists in
`supabase_migrations.schema_migrations`.

### BLOCKER the correction must handle

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid='public.ca_mint_ledger'::regclass and contype='c';
```

```
ca_mint_ledger_holder_type_check
  CHECK (holder_type = ANY (ARRAY['club','union','player','house']))
```

**`circulation` is not an allowed `holder_type`.** A re-post to a `circulation`
holder raises 23514 unless the same migration widens this CHECK first. Lane B
widened it once (adding `house`); the correction has to widen it again.

Two other constraints shape the correction:

- `ca_mint_ledger_amount_check CHECK (amount > 0)` - the reversal must be
  `action = 'burn'`, not a negative mint.
- `ca_mint_ledger_reason_check CHECK (length(btrim(reason)) >= 10)`.

### No consumer misreads a `circulation` holder

Every function and view that names `ca_mint_ledger`, from
`pg_proc.prosrc like '%ca_mint_ledger%'` and `pg_get_viewdef(...) like ...`:

| consumer                                                                               | holder filter                                                                    | behaviour after the correction                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_ca_mint_supply(text)`                                                              | **none** - `WHERE asset = p_asset` only                                          | burn 1030092 + mint 1030092 nets to zero change; supply stays 1,030,092                                                                                                                                                                                 |
| `fn_ca_mint_overview()`                                                                | none (delegates to `fn_ca_mint_supply`)                                          | unchanged                                                                                                                                                                                                                                               |
| `fn_ca_mint`, `fn_ca_burn`                                                             | writers only                                                                     | unchanged                                                                                                                                                                                                                                               |
| `fn_ca_diamond_born_with_balance`, `fn_ca_journal_profile_deletion`, `handle_new_user` | writers only (`holder_type='player'`)                                            | unchanged                                                                                                                                                                                                                                               |
| `fn_ca_diamond_trial_balance`                                                          | `holder_type='player'` on the player row, `holder_type='house'` on the house row | house `mint_net` becomes 0, `difference` becomes 0 (`v_delta 0 - v_mint 0`). **The break clears.** `total.mint_net` drops from 1030092.00 to 0, which is cosmetic: `total.difference` is `delta - journal_net`, not a mint comparison, and is already 0 |
| `fn_ca_mint_velocity_watch()`                                                          | **does not read `ca_mint_ledger` at all**                                        | cannot trip. Its live body (1594 chars) reads `public.chip_ledger` filtered on `from_type IN ('system_mint','issuance_reserve')` and `to_type IN ('system_burn','chip_retirement')`. Lane B's changelog says the same and is correct                    |
| any view                                                                               | **zero views name `ca_mint_ledger`**                                             | n/a                                                                                                                                                                                                                                                     |

**Verdict:** the correction is safe on every reader, and it is BLOCKED on the
CHECK constraint. Widen `ca_mint_ledger_holder_type_check` in the same
transaction or the migration aborts at its first statement.

---

## Item 6 - chip-side interactions

### 6a - `ca_payout_freeze`

```
ca_payout_freeze_scope_check
  CHECK (scope = ANY (ARRAY['tournament_payouts','diamond_issuance',
                            'diamond_tournament_payouts','arena_withdrawals']))
```

`fn_settle_tournament_obligation` (12270 chars) consults, verbatim:

```sql
IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
            WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
```

Scope equality on one literal. The three new scopes cannot refuse a chip payout.
0 rows with `cleared_at IS NULL`. **NO CONFLICT.**

### 6b - `ca_manual_adjustments.asset`

```
ca_manual_adjustments_asset_check          CHECK (asset IN ('chips','diamonds'))
ca_manual_adjustments_asset_matches_target CHECK ((asset='diamonds')
                                                  = (target_kind IN ('diamond_wallet','diamond_house')))
ca_manual_adjustments_target_kind_check    CHECK (target_kind IN (11 chip kinds
                                                  + 'diamond_wallet','diamond_house'))
```

A chip proposal keeps `asset` at its `'chips'` default and a chip `target_kind`,
so `false = false` satisfies the pairing CHECK. `fn_ca_propose_manual_adjustment`
exists as exactly **one** overload
(`text,numeric,text,uuid,uuid,uuid,text,text`) with `p_asset` last and
defaulting to NULL, so every seven-argument positional call still resolves.
`fn_ca_approve_manual_adjustment` (2588 chars) and `fn_ca_reject_manual_adjustment`
(1452 chars) contain no occurrence of the string `asset` at all. Table holds 0
rows. **NO CONFLICT.**

### 6c - the chip trial balance

`grep -l "fn_ca_trial_balance" diamond-{a,b,c,d,e,g}/supabase/migrations/2026090300*.sql`
returns one file, `diamond-g/.../20260903003128_diamond_g_controls.sql`, at line
15, which is a comment:

```
-- fn_ca_trial_balance knows fourteen CHIP accounts and no diamond account
```

Live `fn_ca_trial_balance(timestamptz)` is 5224 chars, md5
`54dafd8727bb80259dadd770cc476d85`. No lane redefines it. Its cron
`ca-trial-balance-hourly` is intact. **NO CONFLICT.**

Minor RISK: `ca-trial-balance-hourly` and `ca-diamond-trial-balance-hourly` are
both scheduled `20 * * * *`. They take different advisory locks
(`hashtext('ca-trial-balance')` vs `hashtext('ca-diamond-trial-balance')`) so
neither blocks the other, but two full-table money scans now start in the same
minute every hour. Not a correctness problem.

### 6d - `ca_money_rpc_registry`

274 rows. The four new key names are present (`fn_ca_burn`, `fn_ca_mint`,
`fn_diamond_purchase_dispute`, `handle_new_user`). The sole consumer is
`fn_ca_money_rpc_drift`, which scans `pg_proc` for functions writing CHIP
balance tables and warns about those NOT in the registry. **A registry row can
only ever suppress a warning for its own name; it can never create one.** Most
of the newly registered functions write `profiles.diamonds`, which that scan
does not look at, so they were never flagged and these rows are an inventory
declaration. **NO CONFLICT.** (Independently reached and stated in Lane A's
changelog section 3; verified here against the live registry count and the
drift function's body.)

### 6e - the cost of the new `profiles` triggers to chip paths

From the migration files:

| lane                             | statement                                                                                            | net effect on `profiles`                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| G, `20260903003714` line 518-520 | `DROP TRIGGER IF EXISTS zz_ca_audit_diamond_change` then `CREATE TRIGGER zz_ca_audit_diamond_change` | replacement. Widened from `AFTER UPDATE OF diamonds` to `AFTER INSERT OR UPDATE OF diamonds`. **Zero new triggers on the UPDATE path** |
| B, `20260903002333` line 110-111 | `DROP TRIGGER IF EXISTS zz_ca_diamond_born_with_balance` then `CREATE TRIGGER ... AFTER INSERT`      | one new trigger, INSERT only                                                                                                           |
| A, C, D, E                       | no `CREATE TRIGGER` on `profiles`                                                                    | none                                                                                                                                   |

**A chip function that UPDATEs `profiles` pays exactly the same trigger count it
paid before the lanes landed.** The two additions both land on INSERT, which is
the signup path. A `profiles` INSERT now runs two more AFTER triggers than it
did at 00:00 UTC; both are log-only and both swallow their own exceptions.

### 6f - `fn_ca_mint` chip branch

Covered under item 1b. One added assignment (`v_holder := p_target_id;`), no
behavioural change.

---

## Live behaviour since landing

All figures read 2026-09-03 00:54 to 01:00 UTC.

### `ca_diamond_incidents`

```sql
select rule, severity, count(*), min(occurred_at), max(occurred_at)
from public.ca_diamond_incidents group by rule, severity order by count(*) desc;
```

| rule                         | severity | n   | first                         | last |
| ---------------------------- | -------- | --- | ----------------------------- | ---- |
| `DR11:trial_balance_summary` | info     | 1   | 2026-09-03 00:38:39.873573+00 | same |
| `DR11:trial_balance_break`   | warning  | 1   | 2026-09-03 00:38:39.873573+00 | same |

Two rows, both from Lane G's single manual watch run. **No DR1, DR2, DR3, DR4,
DR5, DR6, DR7, DR8, DR9 or DR10 incident has fired in production.** That is
consistent with the traffic figure below, not with the rules being inert.

### `ca_diamond_snapshots`

Rows after 00:40 UTC: **0.** The newest row is id 53, `taken_at 2026-09-03
00:10:00.595693+00`, written by the OLD body:

```
id 53 | profile_diamonds 1030092 | wallet_diamonds 619879 | cert 234480
     | total 1649971 | journaled_delta 0 | delta_vs_prev 0 | unexplained 0
     | total = SUM(profiles.diamonds)?  FALSE
```

The cron `ca-diamond-snapshot-hourly` (jobid 201, `10 * * * *`) had not fired
since Lane A's 00:40 apply at the time of this audit. **The 01:10 UTC row will
be the first written under A's new identity** and is the row that must show
`total = 1030092` and `unexplained = 0`. Lane A's rolled-back probe produced
exactly that (`id 54, total 1030092, total_equals_profiles_sum true`), but the
committed proof does not exist yet. **UNVERIFIED until 01:10 UTC.**

### `diamond_transactions`

```sql
select count(*) from public.diamond_transactions where created_at >= '2026-09-03 00:07:00+00';
-- 0
```

**Zero journal rows in the 47 minutes since the foundation landed.** Therefore
`counterparty` and `issuance_class` coverage since the foundation is 0 of 0, and
no rewritten writer has been exercised by live traffic. Every claim about what
those writers now do rests on the lanes' rolled-back probes and on the bodies
read here, not on committed production rows. This is also why Lane G's
`suspense` row reads 0 and why `player_diamonds` shows `difference 0`: the
window is empty, not clean.

### `ca_diamond_balance_audit`

Rows since 00:37 UTC (G's apply): **0**, so `writer` and `journaled` populated:
0 of 0. Columns confirmed present on the table: `id, occurred_at, user_id,
old_diamonds, new_diamonds, delta, is_cert, db_role, app_name, journaled,
writer, money_path`. Lane G's two new columns exist. **UNVERIFIED in
production** for the same reason as above.

### Other registers

| register                                       | rows             |
| ---------------------------------------------- | ---------------- |
| `ca_mint_ledger`                               | 1 (the baseline) |
| `diamond_reward_budgets` `SUM(spent_diamonds)` | 0                |
| `diamond_user_daily_awards`                    | 0                |
| `ca_diamond_journal_archive`                   | 0                |
| `diamond_purchase_lots`                        | 0                |
| `diamond_debts`                                | 0                |
| `ca_manual_adjustments`                        | 0                |
| `ca_payout_freeze` open                        | 0                |
| `profiles` with `diamonds < 0`                 | 0                |

### `signup_errors`

Rows since 00:20 UTC (Lane B's apply): **0**. All-time total **24**, exactly the
figure Lane B measured before its change. **B's `handle_new_user` rewrite has
caused no signup error.** No signup has occurred in the window either, so this
is a "no regression observed" rather than a positive proof of the new path.

### `ca_ledger_write_failures`

One row since 00:07 UTC, and it is a CHIP failure:

```
id 704 | 2026-09-03 00:31:49.727516+00
club fade0000-0000-0000-0000-000000000001 | delta 18.00 | sqlstate 40P01
"fn_ca_fund_overlay_on_lock (tournament 1068cd04-41c8-4168-83cb-243ebe693918):
 deadlock detected"
```

**RISK, and the timing is the evidence.** 00:31:49 sits between Lane A's apply
(00:30:36) and Lane G's first apply (00:31:28), inside a window in which four
migrations took `ACCESS EXCLUSIVE` locks on hot tables in eleven minutes. Lane D
recorded a deadlock of the identical class in the same window
(`40P01 ... Process waits for AccessExclusiveLock on relation 2361885`
= `public.profiles`, `blocked by ... RowShareLock on relation 16495`
= `auth.users`) and split its migration in two because of it. This overlay
funding is not diamond code and no lane touched it; the honest reading is that
a live chip tournament lost an 18.00 overlay top-up to lock contention created
by the migration burst. It is a single occurrence, it self-reported into the
failure sink that exists for it, and the correct lesson is CLAUDE.md section 2:
batch the DDL, one migration per lane, and prefer a quiet window.

---

## Repo-side

### Branch inventory and merge state

```
fix/diamond-a-identity   62d96de73  ahead 3  behind 2  merged_into_main=NO
fix/diamond-b-mint       ba882b023  ahead 1  behind 5  merged_into_main=NO
fix/diamond-c-journal    f6386cdd6  ahead 1  behind 5  merged_into_main=NO (squash-merged, see below)
fix/diamond-d-purchase   73c7ed8f2  ahead 2  behind 5  merged_into_main=NO
fix/diamond-e-earn       8aa1ed2aa  ahead 1  behind 5  merged_into_main=NO
fix/diamond-g-controls   8b63fa676  ahead 1  behind 5  merged_into_main=NO
origin/main              d2619dbb1
origin/audit/diamond-economy         (exists)
```

Lane C's branch is not an ancestor of main because the PR was **squash**-merged;
its content IS on main:

```
git ls-tree -r origin/main --name-only | grep diamond_c
  supabase/migrations/20260903031500_diamond_c_the_journal_keeps_both_sides_and_survives_deletion.sql
  tests/law/DiamondJournalNamesBothSidesAndSurvivesDeletion.law.test.ts
```

### Files each branch changes (`git diff --name-only origin/main...HEAD`)

| lane | files                                                                            | law test                                                                |
| ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A    | LAWS.md, changelog, `schema-manifest.d/diamond-a.json`, 2 migrations, 1 law test | `tests/law/DiamondSupplyIdentityReadsTheCanonicalStoreOnce.law.test.ts` |
| B    | LAWS.md, changelog, `diamond-b.json`, 2 migrations, 1 law test                   | `tests/law/DiamondIssuancePassesThroughTheMint.law.test.ts`             |
| C    | LAWS.md, changelog, `diamond-c.json`, 1 migration, 1 law test                    | `tests/law/DiamondJournalNamesBothSidesAndSurvivesDeletion.law.test.ts` |
| D    | LAWS.md, changelog, `diamond-d.json`, 2 migrations, 1 law test                   | `tests/law/DiamondPurchasesClearThroughOneRecord.law.test.ts`           |
| E    | LAWS.md, changelog, `diamond-e.json`, 1 migration, 1 law test                    | `tests/law/DiamondEarnEnginesAreBudgeted.law.test.ts`                   |
| G    | LAWS.md, changelog, `diamond-g.json`, 2 migrations, 1 law test                   | `tests/law/DiamondControlsNameTheAccountAndTheWriter.law.test.ts`       |

**Six distinct law-test filenames, six distinct LAWS.md row ids, eleven distinct
migration version numbers, six distinct manifest files, six distinct changelog
files. The intersection of changed files across any two branches is exactly
`docs/LAWS.md` and nothing else.** The swarm brief's file-ownership discipline
held.

### The `docs/LAWS.md` conflict

`git merge-tree --write-tree --messages` on all 15 pairs and on each branch
against `origin/main`:

```
vs origin/main:
  fix/diamond-a-identity  : CONFLICT (content): docs/LAWS.md
  fix/diamond-b-mint      : CONFLICT (content): docs/LAWS.md
  fix/diamond-c-journal   : clean          <- already merged
  fix/diamond-d-purchase  : CONFLICT (content): docs/LAWS.md
  fix/diamond-e-earn      : CONFLICT (content): docs/LAWS.md
  fix/diamond-g-controls  : CONFLICT (content): docs/LAWS.md

pairwise: all 15 pairs CONFLICT (content) in docs/LAWS.md, and nothing else.
```

This is precisely the state the five `dirty` PRs report. The cause is visible in
the diffs: lanes **A, C and E rewrote the entire LAWS.md table** (Prettier
reflowed every row's column widths when their new row was longer than the widest
existing one), while B, D and G appended a single row to the table as it stood.
C merged first at 00:42:38, putting its reflowed table on main, so every other
branch now carries a table whose every line differs from main's.

It is the exact failure mode the chip precedent recorded
(`lane3-conflicts.md`: "only `docs/LAWS.md` conflicts"), and it is the one the
swarm brief rule 10 pre-authorises: **resolve by union.** No lane's law is
contested; five identical-in-kind conflicts have to be resolved by hand or by
Agent Autopilot refreshing each branch in turn, one at a time, because each
merge moves main's table again.

### Pull request status (GitHub REST, `Smarter-Poker/Smarter-Poker-Club-Arena`)

| PR       | head                     | state                         | draft     | mergeable | mergeable_state | title                                                                               |
| -------- | ------------------------ | ----------------------------- | --------- | --------- | --------------- | ----------------------------------------------------------------------------------- |
| 2744     | `fix/diamond-c-journal`  | **closed (merged 00:42:38Z)** | false     | n/a       | n/a             | fix(diamond): C - every journal row names its class and counterparty, a deletion... |
| 2745     | `fix/diamond-e-earn`     | open                          | false     | false     | **dirty**       | fix(diamond): E - every earn engine has a budget line and a daily cap ledger        |
| 2748     | `fix/diamond-b-mint`     | open                          | false     | false     | **dirty**       | fix(diamond): B - the Mint issues diamonds to the house, the signup 500 is...       |
| 2750     | `fix/diamond-a-identity` | open                          | false     | false     | **dirty**       | fix(diamond): A - the supply identity reads the canonical store once, the m...      |
| 2751     | `fix/diamond-d-purchase` | open                          | false     | false     | **dirty**       | fix(diamond): D - purchases clear through one record, a chargeback is a debt        |
| 2752     | `fix/diamond-g-controls` | open                          | false     | false     | **dirty**       | fix(diamond): G - an hourly trial balance that names the account, four-eyes...      |
| **2735** | `audit/diamond-economy`  | **open**                      | **false** | -         | -               | audit/diamond economy                                                               |

All six lane PRs are non-draft. The orchestrator's audit PR **#2735** is open and
non-draft.

### Lane C's filename / version mismatch

C's migration file is named `20260903031500_diamond_c_...` but is registered in
`supabase_migrations.schema_migrations` as version `20260903002317` with the
FILE NAME as its `name` column. C's changelog records this openly. It is
cosmetic today; the practical consequence is that a future agent sorting
`supabase/migrations/` by filename will place Lane C last, after Lane G's 00:37
migration, when it actually applied third at 00:23. Worth a one-line note in the
roadmap.

---

## What this audit did NOT do

- **No probe of any money path.** Every finding about a writer's behaviour comes
  from reading its live body or from a lane's own rolled-back transcript. No
  transaction was opened.
- **No verification of the 01:10 UTC snapshot** (it had not run) or of any
  post-lane journal row, audit row, budget increment or incident from real
  traffic (`diamond_transactions` since 00:07 = 0). Those are the numbers that
  will confirm or refute the lanes in production, and they do not exist yet.
- **No reading of the World Hub repo.** Lane D's PR #1257 there
  (Stripe dispute webhook, `diamond_packages` catalog read) was not examined.
- **No causal proof** that the migration burst caused the 00:31:49 chip overlay
  deadlock. The timing and the matching SQLSTATE from Lane D's own failed apply
  are the evidence; a deadlock has two sides and only one is recorded.
