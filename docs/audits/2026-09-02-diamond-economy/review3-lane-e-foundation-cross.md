# Review 3 - Lane E (earn budgets), the foundation objects, and the cross-cutting checks

Reviewer 3 of three. Read-only pass against production `kuklfnapbkmacvwxktbh`, 2026-09-07
~21:20 UTC. Every claim below is followed by the query or file read that produced it.
Nothing was written. No DDL, no probe, no git write.

Scope: `award_diamonds_v2`, `fn_ca_diamond_engine_of`, `fn_ca_diamond_earn_ledger`,
`diamond_engine_daily_caps`, `diamond_reward_budgets`, the three catalog history tables,
`enter_trivia_tournament_v2`, `ca_diamond_house` / `ca_diamond_house_ledger`, the
foundation objects (`fn_ca_diamond_incident`, `ca_diamond_incidents`), the
`issuance_class` CHECK, the two non-P3 `circulation` rows in `ca_mint_ledger`,
`fn_ca_mint_supply` semantics, and the cross-cutting grants / RLS / telemetry sweep.

---

## PART 1 - THE LANDSCAPE: what other agents did to the diamond economy in four days

`select version, name from supabase_migrations.schema_migrations where version >
'20260903010547' order by version` returns **577 migrations** applied between
2026-09-03 01:06 UTC and now. The diamond-relevant ones, in order:

| version                                   | name                                                                                                     | effect on this lane                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 20260903230339                            | `a_certification_club_is_retired_to_the_mint_and_then_it_is_gone`                                        | started the cert-fleet churn that dominates every number below                      |
| 20260904183408                            | `phase_3_1_one_mint_the_register_follows_the_journal`                                                    | chips                                                                               |
| 20260904194036                            | `the_mint_hardened`                                                                                      | `fn_ca_mint` / `fn_ca_burn` hardening                                               |
| 20260905041753                            | `20260905041033_one_mint_for_diamonds_the_register_follows_the_diamond_journ`                            | **wrote the 611,325 `circulation` mint** (see DEF-08)                               |
| 20260905065304                            | `20260905064901_the_signup_grant_is_registered_once_and_deletion_retires_wha`                            | **wrote the 18,000 `circulation` burn** (see DEF-08)                                |
| 20260905081408                            | `the_register_closes_the_definitional_era`                                                               | register/meter reconciliation                                                       |
| 20260905103722 / 103831                   | referral milestones + signup bonus pay diamonds not chips                                                | new diamond writers, new reference shapes                                           |
| 20260905114421                            | `a_mission_pays_diamonds_not_chips`                                                                      | **new writer: Daily Missions.** Source of 87,366 diamonds minted in September       |
| 20260906095736 / 111916 / 141022 / 151803 | daily mission certification repairs, serialized replay, rerolls cost one diamond, reroll replay proof    | more Daily Missions reference shapes, all unknown to `fn_ca_diamond_engine_of`      |
| 20260906210000                            | `deduct_diamonds_idempotency_binding`                                                                    | `deduct_diamonds` still carries `issuance_class` + `counterparty` (verified live)   |
| **20260907025144**                        | **`award_diamonds_v2_serialized_family_caps`**                                                           | **REPLACED `award_diamonds_v2` and dropped Lane E's issuance-class stamp. DEF-01.** |
| 20260907035121 / 035309                   | `a_profile_is_born_with_its_diamond_mirrors`, `a_mirror_never_invents_a_number`                          | mirror columns; DR10 incidents drop from 24/day to 4/day on 09-07                   |
| 20260907053216                            | `the_mint_reference_into_the_journal_gets_its_constraint_back`                                           | FK from `ca_mint_ledger.diamond_tx_id`                                              |
| 20260907070111 / 070134                   | `daily_mission_claim_receipts_account_for_every_diamond`, `daily_mission_freeze_history_survives_reload` | more Daily Missions writers                                                         |

Repo side, `git log --oneline origin/main --since=2026-09-03 -- supabase/migrations`
filtered on diamond/reward/mint/mission/challenge/signup/cert gives 21 merged PRs; the
ones that matter here are #3442 (daily challenges phase 9), #3425 (mint reference
constraint), #3128 (a mission pays diamonds), #3127 (achievement engine + referrals),
#3076 (the wallet is a vault, every diamond comes from the Mint) and #3000 (the Mint
audited and hardened).

`ls docs/laws.d | grep -i 'diamond|reward|mint'` returns six law files:
`a-reward-is-paid-in-diamonds.md`, `rewards-are-diamonds-and-the-schema-has-no-yellow.md`,
`tests-a-new-clubs-first-chips-come-from-the-mint.md`,
`tests-law-DiamondJournalNamesBothSidesAndSurvivesDeletion.md`,
`tests-one-mint-no-negatives-doors-closed.md`, `tests-the-mint-is-hardened.md`.

**None of them pins `award_diamonds_v2`.** Lane C's law covers "the two primitives"
(`add_diamonds_to_balance`, `deduct_diamonds`). `grep -rl "award_diamonds_v2" tests/`
in `~/Documents/club-arena` returns **nothing**. That is the structural reason DEF-01
landed silently four days after Lane E shipped.

### The single fact that colours every number below

The certification fleet creates and destroys accounts continuously. In four days it
produced, measured from `ca_mint_ledger` (`asset='diamonds'`, `holder_type='player'`,
`action='mint'`, `created_at>='2026-09-01'`):

| bucket                                                  |  rows |  diamonds |
| ------------------------------------------------------- | ----: | --------: |
| `Temporary Table Studio Commerce Cert...` (class admin) |   306 | 2,532,225 |
| `balance present at profile INSERT` (the signup seed)   | 1,341 |   670,500 |
| `Daily Missions ...`                                    |   210 |    87,366 |
| `Signup Grant Journaled At Creation`                    |    18 |     9,000 |
| `Diamond Rewards v2: ...`                               |    16 |       930 |

and 6,734 burns totalling 3,899,427. Read every finding below against that.

---

## PART 2 - DEFECT TABLE

| id     | object                                                | sev                          | what is wrong                                                                                                                                                                                                                                                                                                                                                                        | evidence                                                                                                                                                                                                                                                                              | fix                                                                                                                                                                                     |
| ------ | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEF-01 | `award_diamonds_v2`                                   | **critical**                 | Lane E's `issuance_class='promotional'` / `counterparty='promo_budget:catalog_v2'` stamp is GONE from the live body. `FOR UPDATE` survives (it was independently re-added). Every reward this function writes since 2026-09-07 02:51 UTC is an unclassified, uncounterpartied journal row.                                                                                           | live body has `has_for_update=true`, `has_issuance_class=false`, `has_counterparty=false`; the live INSERT names only `user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata, created_at`. 3 rows on 2026-09-07 carry `issuance_class IS NULL`. | Re-apply Lane E's two-column addition inside migration `20260907025144`'s own text (do not text-patch again), and add a law test that asserts the live `prosrc` contains both literals. |
| DEF-02 | Lane E's patch technique                              | **high**                     | Lane E patched `pg_get_functiondef()` at apply time with `replace()` and asserted the result. Nothing keeps the patch true afterwards: the next `CREATE OR REPLACE` from any agent silently removes it, which is exactly what happened four days later.                                                                                                                              | `supabase/migrations/20260903002841_...sql` lines 433-500 (the `DO $patch$` block); the asserts at lines 724-739 only run at apply time.                                                                                                                                              | Move the stamp into the canonical definition of the function, and pin it with `tests/*.law.test.ts` reading `prosrc` from production, not from the migration.                           |
| DEF-03 | `fn_ca_diamond_earn_ledger`                           | **high**                     | The budget counts issuance to certification accounts, and never decrements when the certification cleanup deletes the journal row. `diamond_reward_budgets` therefore reports 758,204 diamonds of promotional spend for 2026-09 against **2,150** that still exist.                                                                                                                  | `sum(spent_diamonds) where period='2026-09'` = 758,204; the same window's surviving positive non-excluded journal = 2,150. 1,421 of 1,435 `diamond_user_daily_awards` rows are orphaned (no `profiles` row).                                                                          | Skip rule below (DEF-03 fix), plus a one-time restatement migration.                                                                                                                    |
| DEF-04 | `fn_ca_diamond_engine_of`                             | **high**                     | Three Daily Missions reference shapes introduced after 2026-09-03 fall to `'other'`, and `'other'` is a bucket the caps table itself calls "a non-zero total here is itself the finding". Exactly 2,640 diamonds are misfiled.                                                                                                                                                       | `daily_mission_milestones:` (16 rows x 150 = 2,400) and `daily-missions-historical-multiplier:` (16 x 15 = 240) = **2,640**, which is the `other` line's `spent_diamonds` to the diamond.                                                                                             | Add the mappings in the proposal below.                                                                                                                                                 |
| DEF-05 | `diamond_engine_daily_caps`                           | medium                       | The `catalog_v2` cap row is seeded at 110, the non-VIP number, while `award_diamonds_v2` allows 150 for a VIP. All four `DR7:user_over_daily_cap` incidents are on VIP accounts and three of the four (115, 115, 135) are **below** the function's real ceiling. The detector cries wolf.                                                                                            | both users are `is_vip=true, vip_tier='lifetime', diamond_multiplier=1.00`; live function: `v_daily_cap := CASE WHEN v_is_vip THEN 150 ELSE 110 END`.                                                                                                                                 | Make the cap VIP-aware (see per-object section).                                                                                                                                        |
| DEF-06 | `diamond_user_daily_awards`                           | medium                       | No FK to `profiles`, no cleanup. 1,421 orphan rows in four days (~355/day) and the table is already 248 kB.                                                                                                                                                                                                                                                                          | `count(*) where not exists (select 1 from profiles ...)` = 1,421 of 1,435.                                                                                                                                                                                                            | `ON DELETE CASCADE` FK, or a retention sweep.                                                                                                                                           |
| DEF-07 | `ca_diamond_incidents` + `ca_diamond_journal_archive` | medium                       | Unbounded. 18,042 incidents / 9.08 MB and 14,174 archive rows / 8.40 MB, all written since 2026-09-03. ~3,600 incidents and ~3,500 archive rows per day, ~4 MB/day combined, ~120 MB/month, essentially all certification churn (`DR5:journal_row_deleted_under_maintenance` alone is 14,173 of 18,042). Nothing is ever resolved: `count(resolved_at)` is 0 for every rule but one. | per-day counts by rule, 2026-09-03..07.                                                                                                                                                                                                                                               | Retention on the `info` severities (DR5 journal-row-deleted, DR11 summary), and the cert skip of DEF-03 removes most of the source.                                                     |
| DEF-08 | `ca_mint_ledger` circulation rows                     | low (evidence, not a defect) | The two non-P3 `circulation` rows are legitimate, documented register-vs-meter corrections, but they use a **different holder id** (`...c1c0`) from the P3 baseline row (`...d1a0`), so the "circulation" holder does not have one continuous balance line.                                                                                                                          | P3 row `balance_before 0 -> after 1,030,092` on holder `d1a0`; the 09-05 row `balance_before 419,282 -> after 1,030,607` on holder `c1c0`.                                                                                                                                            | Not urgent. Record the two holder ids in the standard, or fold `d1a0` into `c1c0` with a zero-sum pair. Do not "tidy" the amounts.                                                      |
| DEF-09 | `enter_trivia_tournament_v2` / `ca_diamond_house`     | low                          | The DR14 house path is cold. `ca_diamond_house.balance = 0`, `ca_diamond_house_ledger` has **0 rows**, and `trivia_tournament_entries` has 0 rows since 2026-09-03 (208 lifetime). The rake slice has never been exercised in production.                                                                                                                                            | counts above.                                                                                                                                                                                                                                                                         | Nothing to fix. Flagged so nobody reads "balance 0" as a leak.                                                                                                                          |
| DEF-10 | `diamond_transactions_issuance_class_chk`             | low                          | Still `NOT VALID`. No row violates it (`group by issuance_class` returns only `null`, `promotional`, `spend`), so it can be validated, but 1,428 of 1,444 rows carry NULL and NULL is permitted by the CHECK itself, so validating buys little until DR12 is enforced.                                                                                                               | `convalidated = false`; class histogram below.                                                                                                                                                                                                                                        | `ALTER TABLE ... VALIDATE CONSTRAINT` is safe today. Low value until NULL is disallowed.                                                                                                |
| DEF-11 | `fn_ca_diamond_engine_of` grant                       | low                          | `EXECUTE` is granted to `authenticated`. It is `IMMUTABLE`, `SECURITY INVOKER`, takes no identity and returns a classification string, so it exposes nothing, but the grant is unnecessary and it is not in `ca_browser_definer_allowlist`.                                                                                                                                          | `proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`, `prosecdef=false`.                                                                                                                                                                                 | `REVOKE EXECUTE ... FROM authenticated`.                                                                                                                                                |
| DEF-12 | `fn_ca_diamond_earn_ledger` NULL-class fallthrough    | low                          | The skip list is `IN ('purchased','transferred','refund','admin','arena')` on `COALESCE(NEW.issuance_class,'')`, so a NULL class is counted as promotional issuance. Correct by accident today (DEF-01's NULL rows are genuinely promotional) but it means any future writer that forgets the class inflates the promotional budget.                                                 | live body, guard (a).                                                                                                                                                                                                                                                                 | Once DR12 is enforced, treat NULL as `unknown` and file it to an `unclassified` engine rather than the writer's engine.                                                                 |

Nothing in scope is a stub. Every object exists, is wired, and is firing.

---

## PART 3 - PER-OBJECT FINDINGS

### 3.1 `award_diamonds_v2` - VERDICT: Lane E's stamp is GONE, its lock survives

**(1) Is the live body still Lane E's? No.**

```sql
select p.oid::regprocedure, md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid)),
       pg_get_functiondef(p.oid) ilike '%FOR UPDATE%',
       pg_get_functiondef(p.oid) ilike '%issuance_class%',
       pg_get_functiondef(p.oid) ilike '%counterparty%',
       pg_get_functiondef(p.oid) ilike '%promo_budget:catalog_v2%'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='award_diamonds_v2';
```

| field                     | value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| signature                 | `award_diamonds_v2(uuid,text,text,text,jsonb)`                                  |
| md5                       | `4c35ae0b603b324e68f50cd9d4e6e35a`                                              |
| length                    | 30,270 (Lane E patched a 25,090-character body; it is a different function now) |
| `FOR UPDATE`              | **true**                                                                        |
| `issuance_class`          | **false**                                                                       |
| `counterparty`            | **false**                                                                       |
| `promo_budget:catalog_v2` | **false**                                                                       |

Replaced by migration `20260907025144 award_diamonds_v2_serialized_family_caps`
(33,091 characters of statements; its own header says it exists because
`20260806120000` "accidentally replaced the profile-row lock from the original v2
function with an unlocked SELECT" and because a multiplier could lift a payout above a
family ceiling).

**Did the intent survive? Half of it.** The lock did, and better than Lane E left it:
the live body takes a per-user advisory lock, then the profile row `FOR UPDATE`, then
the platform-budget row, with the order written into the header. That is Lane E's edit 1
re-derived independently and correctly. **Edit 2 was destroyed.** The live INSERT is:

```sql
INSERT INTO public.diamond_transactions (
    user_id, amount, transaction_type, type, description,
    balance_after, reference_id, metadata, created_at
) VALUES ( ... );
```

with no `counterparty` and no `issuance_class`. Lane E's version added exactly those two
columns and the two literals (`supabase/migrations/20260903002841_...sql`, `v_new_b`).

**(3) Live behaviour - the regression is already visible in the data and the lane's own
watcher has already caught it.**

```sql
select date_trunc('day',created_at)::date, transaction_type,
       coalesce(issuance_class,'(null)'), count(*), sum(amount)
  from public.diamond_transactions where created_at >= '2026-09-03' group by 1,2,3;
```

Every `daily_login` row from 09-03 to 09-06 carries `promotional`. On **2026-09-07: 3
rows, 30 diamonds, `issuance_class` NULL** - users `2d1cd6c3`, `47965354`, `9b027798`,
all at 10 diamonds. The break is exactly at 02:51 UTC on 09-07, when the migration
applied.

`DR12:suspense_nonzero` fired at 2026-09-07 17:20 UTC with, verbatim from
`ca_diamond_incidents.detail`: _"2 journal rows written since the counterparty column
existed (2026-09-03 00:07 UTC) name no counterparty. DR12: this must be zero."_ By
21:00 there were three. **The Lane G control works.** What is missing is anything that
stops the regression landing, not anything that notices it.

**(2) Line-by-line, the rest of the live body is sound.** `v_multiplier` is clamped to
(0,10]; the VIP test is `COALESCE(is_vip,false) AND (vip_tier='lifetime' OR
vip_expires_at > now())` with a comment saying the COALESCE is deliberate so NULL cannot
fail open; the daily/monthly usage read joins `diamond_reward_catalog` on
`counts_toward_daily_cap = true`; the `unique_violation` handler re-raises anything that
is not one of the two reference-id idempotency indexes. No new defect found in it.

**Exact proposed fix (DEF-01/DEF-02).** In a new migration, `CREATE OR REPLACE` the
whole `20260907025144` body with the two columns restored:

```sql
    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata, created_at,
        counterparty, issuance_class
    ) VALUES (
        p_user_id, v_award, p_action_key, p_action_key,
        format('Diamond Rewards v2: %s%s', p_action_key,
               CASE WHEN v_capped THEN ' (capped)' ELSE '' END),
        v_new_balance,
        CASE WHEN v_reference_id = '' THEN NULL ELSE v_reference_id END,
        v_metadata, v_now,
        'promo_budget:catalog_v2', 'promotional'
    );
```

and backfill the three orphaned rows:

```sql
UPDATE public.diamond_transactions
   SET issuance_class = 'promotional', counterparty = 'promo_budget:catalog_v2'
 WHERE issuance_class IS NULL
   AND created_at >= '2026-09-07'
   AND description LIKE 'Diamond Rewards v2:%';
```

(the journal is append-only via `trg_ca_append_only` on `diamond_transactions`; check
whether that trigger permits an UPDATE of these two columns before writing the backfill,
and if not, restate rather than update.)

Then a law test, because DEF-02 is the real defect:

```
tests/award-diamonds-v2-names-its-side.law.test.ts
  - prosrc contains 'promo_budget:catalog_v2' and 'promotional'
  - prosrc contains exactly 2 'FOR UPDATE'
  - no diamond_transactions row written after 2026-09-03 00:07 UTC has a NULL issuance_class
```

### 3.2 `fn_ca_diamond_engine_of` - the map is intact, the world moved

Live body md5 `c6bb8d289b7c9eb1620d1c24948a62b4`, 3,178 characters, `IMMUTABLE`,
`SECURITY INVOKER`, `search_path = public, pg_temp`. Clause-for-clause identical to
`supabase/migrations/20260903002841_...sql` lines 148-188. **Not replaced.**

Run over every journal row (`select fn_ca_diamond_engine_of(type, transaction_type,
source, description, reference_id), coalesce(transaction_type,type),
split_part(reference_id,'_',1), count(*), sum(amount) from diamond_transactions group by
1,2,3`), the shapes that map to `'other'` are:

| shape (`transaction_type` / reference prefix)                                                                                           | rows | diamonds | proposed engine                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---: | -------: | --------------------------------------------------------- |
| `reconciliation` / `reconcile`                                                                                                          |  418 |  678,549 | `reconciliation` (a 2026-05-03 data repair, not issuance) |
| `live_gift_received` / `live_gift_sent` / `live_`                                                                                       |   24 |    0 net | `live_gifts`                                              |
| `diamond_gift_sent` / `_received` / `_refund` / `transfer_`                                                                             |   10 |    0 net | `player_transfer` (class `transferred`, already skipped)  |
| `adjustment` / `pvp_`, `makegood_`, bare                                                                                                |    8 |   31,525 | `manual_adjustment`                                       |
| `chip_purchase`, `chip_mint`, `feature_purchase`, `feature_unlock`, `game_cost`, `trivia_arcade`, `pvp_stake`, `daily_challenge_reroll` |   25 | negative | `spend`                                                   |
| `profile_pic`, `profile_complete`, `share`                                                                                              |    4 |       70 | `catalog_v1`                                              |
| `test`, `test_verify`, `test_ref_id`                                                                                                    |    4 |        0 | `test_fixture`                                            |

and, the ones that actually cost money in the current period, three reference shapes
introduced by the Daily Missions migrations after Lane E shipped. Taken from
`ca_diamond_incidents.detail->>'reference_id'` on `DR5:journal_row_deleted_under_maintenance`
since 2026-09-06 (the rows themselves are deleted):

| reference shape                                               | rows since 09-06 | maps to                                                       | should map to    |
| ------------------------------------------------------------- | ---------------: | ------------------------------------------------------------- | ---------------- |
| `challenge_claim_batch:<uuid>:diamonds`                       |              162 | `daily_challenges` (via `starts_with(...,'challenge_claim')`) | `daily_missions` |
| `daily_mission_milestones:<uuid>:<uuid>:<n>`                  |               16 | **`other`**                                                   | `daily_missions` |
| `daily-missions-historical-multiplier:<uuid>`                 |               16 | **`other`**                                                   | `daily_missions` |
| `daily-missions-response-loss:<uuid>`                         |               16 | **`other`** (class `admin`, so skipped)                       | `daily_missions` |
| `customization-cert-fund:<uuid>`                              |              226 | **`other`**                                                   | `certification`  |
| `streak_freeze:<uuid>:<uuid>`                                 |               62 | `other` (negative, never counted)                             | `daily_missions` |
| `feat_studio:...`, `feat_<uuid>_<uuid>`, `feat_card_back_...` |            2,554 | `other` (negative)                                            | `commerce`       |
| `challenge_reroll:<uuid>`                                     |              288 | `daily_challenges` (negative)                                 | `daily_missions` |

**The arithmetic closes exactly.** `diamond_reward_budgets` shows `other` at
**2,640** spent for 2026-09. `daily_mission_milestones` is 16 rows at 150 diamonds
(2,400, confirmed by the mint ledger line `The Mint issued 150 diamonds (reward): Daily
Missions streak circuit`, 16 rows, 2,400) plus
`daily-missions-historical-multiplier` at 16 rows x 15 (240, mint line `Historical Daily
Missions Streak`, 16 rows, 240). 2,400 + 240 = **2,640**. That is the whole of `other`.

Proposed clause additions, inserted above the existing reference-shape block so the
more specific `daily_mission*` prefixes win over `challenge_claim`:

```sql
WHEN starts_with(p_reference_id, 'daily_mission')             THEN 'daily_missions'
WHEN starts_with(p_reference_id, 'daily-missions-')           THEN 'daily_missions'
WHEN starts_with(p_reference_id, 'challenge_claim_batch')     THEN 'daily_missions'
WHEN starts_with(p_reference_id, 'challenge_reroll')          THEN 'daily_missions'
WHEN starts_with(p_reference_id, 'streak_freeze')             THEN 'daily_missions'
WHEN starts_with(p_reference_id, 'customization-cert-fund')   THEN 'certification'
WHEN starts_with(p_reference_id, 'feat_')                     THEN 'commerce'
WHEN starts_with(p_reference_id, 'reconcile')                 THEN 'reconciliation'
WHEN starts_with(p_reference_id, 'transfer_')                 THEN 'player_transfer'
WHEN starts_with(p_reference_id, 'makegood')                  THEN 'manual_adjustment'
```

plus, in the `transaction_type` block:

```sql
WHEN COALESCE(p_transaction_type, p_type) IN ('reconciliation')                     THEN 'reconciliation'
WHEN COALESCE(p_transaction_type, p_type) IN ('live_gift_sent','live_gift_received') THEN 'live_gifts'
WHEN COALESCE(p_transaction_type, p_type) IN ('diamond_gift_sent','diamond_gift_received','diamond_gift_refund') THEN 'player_transfer'
WHEN COALESCE(p_transaction_type, p_type) IN ('adjustment')                          THEN 'manual_adjustment'
WHEN COALESCE(p_transaction_type, p_type) IN ('profile_pic','profile_complete','share') THEN 'catalog_v1'
WHEN COALESCE(p_transaction_type, p_type) LIKE 'test%'                               THEN 'test_fixture'
WHEN COALESCE(p_transaction_type, p_type) IN ('chip_purchase','chip_mint','feature_purchase',
        'feature_unlock','game_cost','trivia_arcade','pvp_stake','daily_challenge_reroll') THEN 'spend'
```

`ELSE 'other'` stays, and the caps-table note "a non-zero total here is itself the
finding" becomes true again. Seed `diamond_engine_daily_caps` and
`diamond_reward_budgets` rows for the new engine names in the same migration (the
trigger will self-create a budget row, but seeding makes the roster explicit).

### 3.3 `fn_ca_diamond_earn_ledger` - the budget is counting a fleet that no longer exists

Live md5 `57437c7094741611b7a49030aa9df168`, 4,215 characters, `SECURITY DEFINER`,
`search_path = public, pg_temp`. Matches the Lane E migration. **Not replaced.**
Trigger: `trg_ca_diamond_earn_ledger AFTER INSERT ON public.diamond_transactions FOR
EACH ROW WHEN (new.amount > 0)`.

**The inflation, broken down.** `diamond_reward_budgets` for 2026-09:

| engine             |         budget |                                            spent | of which still exists as a journal row |
| ------------------ | -------------: | -----------------------------------------------: | -------------------------------------- |
| `signup`           |      2,500,000 |                                          670,000 | 1,000 (2 rows)                         |
| `daily_challenges` |      2,500,000 |                                           84,134 | 0                                      |
| `other`            |      2,500,000 |                                            2,640 | 0                                      |
| `catalog_v2`       |      2,500,000 |                                              930 | 930                                    |
| eight others       | 2,500,000 each |                                                0 | -                                      |
| **total**          |                | **757,704** (758,204 including the 21:17 update) | **2,150**                              |

```sql
select (select sum(spent_diamonds) from diamond_reward_budgets where period='2026-09'),
       (select coalesce(sum(amount),0) from diamond_transactions
         where amount>0 and (created_at at time zone 'America/Chicago') >= '2026-09-01'
           and coalesce(issuance_class,'') not in ('purchased','transferred','refund','admin','arena'));
-- 758204 | 2150
```

**Yes, the ledger is counting the certification fleet, and it is the whole of the
problem.** The `signup` line is one-to-one with the mint's account-creation seed:

```sql
select fn_ca_is_cert_account(holder_id), count(*), sum(amount), count(distinct holder_id)
  from ca_mint_ledger
 where asset='diamonds' and holder_type='player' and action='mint'
   and reason='balance present at profile INSERT' group by 1;
-- false | 1340 | 670000.00 | 1340
-- true  |    1 |    500.00 |    1
```

1,340 x 500 = 670,000, exactly the `signup` budget line. They read `is_cert = false`
today **only because their `auth.users` rows have been deleted** - `fn_ca_is_cert_account`
resolves the flag through `auth.users.email`. The one surviving example proves the rule
would have fired at insert time: the 2026-09-07 21:00:59 signup row belongs to
`ca-customization-cert-postdeploy-1788816645517-...@example.invalid`, and
`fn_ca_is_cert_account` returns **true** for it.

`daily_challenges` 84,134 and `other` 2,640 are the Daily Missions rewards paid to the
same fleet (mint ledger, September: `Daily Missions ...` = 210 rows, 87,366 diamonds).

**Are cert-fleet MINTS being counted?** The `Temporary Table Studio Commerce Cert...`
mints - 306 rows, 2,532,225 diamonds, the single largest issuance on the platform - are
**not** in the budget, because they carry `issuance_class` in the skipped set (they are
`adjustment` / class `admin`). That guard is working. It is the **signup grant and the
mission rewards** that reach cert accounts as ordinary `promotional` issuance and are
counted.

**Exact proposed skip rule.** Insert as the first guard inside the inner `BEGIN`, before
`v_at` is computed:

```sql
        -- A certification account is a fixture, not a player. Its grants are
        -- issued and burned inside the same day and its journal row is deleted
        -- with the account, so counting it against a promotional budget
        -- measures the test harness, not the economy. (Horses are NOT covered
        -- by this: fn_ca_is_cert_account matches @horses.smarter.poker only as
        -- part of the fixture-email family; see the note below.)
        IF public.fn_ca_is_cert_account(NEW.user_id) THEN
            RETURN NULL;
        END IF;
```

**Warning, and it needs a decision before this ships.** `fn_ca_is_cert_account` matches
`u.email LIKE '%@horses.smarter.poker'`. Horses are players (CLAUDE.md 10.5), and a
horse that earns a diamond MUST be counted in the budget exactly as a human is. Adding
the guard as written would exclude the horse fleet from the earn ledger and would be a
10.5 violation. **The correct predicate is the fixture half only:**

```sql
        IF NEW.user_id::text LIKE '00000000-0000-0000-0000-%'
           OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                       WHERE c.user_id = NEW.user_id AND c.active)
           OR EXISTS (SELECT 1 FROM auth.users u
                       WHERE u.id = NEW.user_id AND u.email LIKE '%.invalid')
        THEN
            RETURN NULL;
        END IF;
```

Wrap that in its own `fn_ca_is_fixture_account(uuid)` so the horse-bearing predicate and
the fixture predicate never get confused again, and say in its comment why the horse
clause is absent.

**Second half of the fix: the budget must fall when the journal row is deleted.**
The skip rule only stops new inflation. `fn_ca_journal_profile_deletion` already sees
every deleted journal row (14,173 `DR5` incidents, 14,174 `ca_diamond_journal_archive`
rows). Give it the reciprocal write:

```sql
        UPDATE public.diamond_reward_budgets
           SET spent_diamonds = GREATEST(spent_diamonds - v_row.amount, 0),
               updated_at = now()
         WHERE period = to_char((v_row.created_at AT TIME ZONE 'America/Chicago'),'YYYY-MM')
           AND engine = public.fn_ca_diamond_engine_of(
                 v_row.type, v_row.transaction_type, v_row.source,
                 v_row.description, v_row.reference_id);
```

and the same for `diamond_user_daily_awards` (which also solves DEF-06's orphans).

**Third: restate the four period rows.** In the same migration, after the skip and the
decrement are in place, assert-and-set:

```sql
-- asserts the board has not moved underneath this migration
DO $$
DECLARE v_spent bigint;
BEGIN
  SELECT sum(spent_diamonds) INTO v_spent FROM public.diamond_reward_budgets WHERE period='2026-09';
  IF v_spent < 700000 THEN
     RAISE EXCEPTION 'diamond_reward_budgets 2026-09 already restated (spent=%), refusing', v_spent;
  END IF;
END $$;

UPDATE public.diamond_reward_budgets b
   SET spent_diamonds = COALESCE((
         SELECT sum(t.amount) FROM public.diamond_transactions t
          WHERE t.amount > 0
            AND to_char((t.created_at AT TIME ZONE 'America/Chicago'),'YYYY-MM') = b.period
            AND coalesce(t.issuance_class,'') NOT IN ('purchased','transferred','refund','admin','arena')
            AND public.fn_ca_diamond_engine_of(t.type,t.transaction_type,t.source,t.description,t.reference_id) = b.engine
       ),0),
       updated_at = now()
 WHERE b.period = '2026-09';
```

No diamond moves; only the bookkeeping line is corrected, which is within CLAUDE.md 10.9
(the outcome is READ from rows, nobody is paid or clawed back, and the assertion aborts
if the board moved).

**Other line-by-line notes on this function, none of them defects:**

- **Does it create a period row when missing? Yes.** The `INSERT ... ON CONFLICT
(period, engine) DO UPDATE` creates one, inheriting `budget_diamonds` from the
  engine's most recent EARLIER period (text-ordered `YYYY-MM`, which is correct
  lexicographically) or 2,500,000. So an unknown engine self-creates its line and a
  deliberately reduced budget carries forward. Correct.
- **Did 2026-10 get created? Yes, but not by the trigger** - all eleven 2026-10 rows have
  `updated_at = 2026-09-03 00:28:41`, the Lane E seed. They are seeded, not earned.
- `EXCEPTION WHEN OTHERS` never re-raises, by design ("the award already happened and
  the player keeps it"), and files `DR7:ledger_write_failed`. That also swallows
  deadlocks and serialization failures silently; acceptable for bookkeeping, worth a
  comment.
- The trigger is `WHEN (new.amount > 0)`, so no spend ever reaches it. Every negative
  shape in the `other` table above is therefore cosmetic.

### 3.4 `diamond_engine_daily_caps` - the seeded cap is the non-VIP number

Eleven rows, all `updated_at = 2026-09-03 00:28:41`, untouched by any other agent.
`catalog_v2 = 110`, `trivia = 2000`, the other nine NULL, each with a `note` saying
PROPOSED and that Dan sets the real number.

The four `DR7:user_over_daily_cap` incidents:

| when        | user       | day   | awarded_today | cap read | reference                            |
| ----------- | ---------- | ----- | ------------: | -------: | ------------------------------------ |
| 09-04 22:41 | `2d1cd6c3` | 09-04 |           260 |      110 | `easter_egg_..._beta_tester`         |
| 09-06 00:54 | `2d1cd6c3` | 09-05 |           115 |      110 | `easter_egg_..._meme_lord`           |
| 09-06 01:15 | `47965354` | 09-05 |           115 |      110 | `progress_..._cash-001_1_2026-09-06` |
| 09-06 14:33 | `47965354` | 09-06 |           135 |      110 | `hotd_..._daily-2026-09-06`          |

(The brief attributed 115/135/260 to `47965354`; two of the four are actually
`2d1cd6c3`.)

**Both users are VIP.** `select id, is_vip, vip_tier, vip_expires_at, diamond_multiplier
from profiles where id in (...)` returns `is_vip=true, vip_tier='lifetime',
vip_expires_at=null, diamond_multiplier=1.00` for both. So `award_diamonds_v2` allowed
150, and three of the four incidents (115, 115, 135) are **under** the function's own
ceiling: false positives created by a cap table that does not know about VIP. The
fourth, 260 on 09-04, is 250 of `easter_egg` plus a 10 login; `easter_egg` has its own
1,000/month family cap and is not in the `counts_toward_daily_cap` set, so it did not
breach the v2 ceiling either - it breached only the flat 110 in this table.

**Proposed cap fix.** Add the VIP dimension to the table rather than picking one number:

```sql
ALTER TABLE public.diamond_engine_daily_caps
  ADD COLUMN max_per_user_per_day_vip integer;

UPDATE public.diamond_engine_daily_caps
   SET max_per_user_per_day = 110, max_per_user_per_day_vip = 150,
       note = note || ' VIP ceiling added 2026-09-07: award_diamonds_v2 allows 150 for '
              'a VIP and 110 otherwise, and the flat 110 produced three false DR7 '
              'incidents on VIP accounts between 09-04 and 09-06.'
 WHERE engine = 'catalog_v2';
```

and in `fn_ca_diamond_earn_ledger` step (c):

```sql
        SELECT CASE WHEN COALESCE(pr.is_vip,false)
                     AND (pr.vip_tier = 'lifetime' OR pr.vip_expires_at > now())
                    THEN COALESCE(c.max_per_user_per_day_vip, c.max_per_user_per_day)
                    ELSE c.max_per_user_per_day END
          INTO v_cap
          FROM public.diamond_engine_daily_caps c
          LEFT JOIN public.profiles pr ON pr.id = NEW.user_id
         WHERE c.engine = v_engine;
```

The cap remains a detector, not a refusal (the award has already happened), which is
correct: this table is telemetry, and `award_diamonds_v2` is where the money is actually
gated.

Note that the cap is also compared against `diamond_user_daily_awards.awarded`, which is
the sum of ALL awards for that engine that day, whereas `award_diamonds_v2`'s 110/150
counts only actions with `counts_toward_daily_cap = true`. Those two denominators will
keep disagreeing on `easter_egg` even after the VIP fix. Either the caps row grows a
`counts_toward_daily_cap_only` flag, or the note says plainly that this cap is the
all-in number and the function's is the gated one. Recommend the note; two ceilings with
different denominators is a decision, not a bug, as long as it is written down.

### 3.5 `diamond_reward_budgets` - periods and self-creation

22 rows: eleven engines x 2026-09 and 2026-10. Every 2026-10 row is untouched at 0.
Primary key `(period, engine)`; no other index, and none is needed at this size.
`relrowsecurity = true`, zero policies, no `anon`/`authenticated` grants: service_role
only. See 3.3 for the counting defect and the restatement.

### 3.6 The three catalog history tables - working, and they caught other agents

```sql
select (select count(*) from diamond_reward_catalog_history),
       (select count(*) from daily_challenge_catalog_history),
       (select count(*) from trivia_diamond_award_limits_history);
-- 0 | 115 | 0
```

All three triggers are attached and enabled (`tgenabled='O'`), all three fire
`fn_ca_diamond_catalog_history`. The 115 rows are exactly the other agents' edits:

| day        | op     | db_role  | app_name   | rows |
| ---------- | ------ | -------- | ---------- | ---: |
| 2026-09-06 | UPDATE | postgres | `mgmt-api` |   58 |
| 2026-09-05 | UPDATE | postgres | `psql`     |   57 |

So the daily challenge catalog was rewritten twice in two days by other agents, and
**both edits were captured with their role and application name**. The reward catalog
and the trivia award limits were not touched. Lane E's control works as designed. No
defect.

### 3.7 `enter_trivia_tournament_v2`, `ca_diamond_house`, `ca_diamond_house_ledger`

Live md5 `ecf1d7fbcf1c0dc5565fb639aff38245`. **Still credits `ca_diamond_house`** with
the `v_fee - v_net` slice and writes `ca_diamond_house_ledger`, exactly as DR14
specified. Gated on `auth.role() = 'service_role'`; `proacl` is service_role only.

**Nothing has funded it.** `ca_diamond_house.balance = 0`, `ca_diamond_house_ledger` has
0 rows, `trivia_tournament_entries` has 208 rows lifetime and **0 since 2026-09-03**.
Five tournaments carry a non-zero `entry_fee`. The path is correct and cold.

Two small observations, neither a defect today:

- `v_net := v_fee - floor(v_fee*0.10)::int` means any fee below 10 produces a zero house
  cut. Intended rounding, worth stating in the standard.
- If the `id=1` house row is missing, the UPDATE affects nothing, `v_house_after` is
  NULL, `DR14:house_account_missing` is raised at `critical` - **but the player has
  already been charged and the cut is lost**. The row exists today. If DR14 is ever
  exercised at volume, the charge should be reversed or the cut parked, not just
  reported.

### 3.8 Foundation objects

`fn_ca_diamond_incident(text,text,uuid,numeric,text,jsonb)`, md5
`e35ec2f1cc82a8470d5464675ef3680d`, 625 characters, `SECURITY DEFINER`, `proacl`
service_role only. Every caller is itself `SECURITY DEFINER` and owned by `postgres`
(`fn_ca_audit_diamond_change`, `fn_ca_diamond_born_with_balance`,
`fn_ca_journal_append_only`, `fn_ca_journal_profile_deletion`,
`fn_ca_diamond_earn_ledger`, `enter_trivia_tournament_v2`), so the grant is sufficient.
The two `SECURITY INVOKER` trigger functions in the family
(`fn_diamond_side_tables_follow_profiles`, `fn_refuse_new_entries_while_frozen`) do not
call it. **No broken grant.**

`ca_diamond_incidents`: 18,042 rows, 9.08 MB, RLS on, zero policies, no browser grants.
Indexes: pkey, `(rule, occurred_at DESC)`, and `(occurred_at DESC) WHERE resolved_at IS
NULL`. Both secondary indexes are appropriate for how the table is read; because almost
nothing is ever resolved, the partial index covers the whole table, which is fine for
now and becomes wasteful only if a resolution sweep ever runs.

Growth, per rule per day:

| rule                                        | sev     | 09-03 | 09-04 | 09-05 | 09-06 | 09-07 |
| ------------------------------------------- | ------- | ----: | ----: | ----: | ----: | ----: |
| `DR5:journal_row_deleted_under_maintenance` | info    | 2,959 | 3,432 | 2,735 | 2,843 | 2,204 |
| `DR6:balance_changed_without_journal`       | warning |   287 |   329 |   257 |   356 |   326 |
| `DR2:balance_born_outside_the_mint`         | warning |   269 |   296 |   234 |   317 |   224 |
| `DR5:deleted_with_balance`                  | warning |   128 |   147 |   127 |   185 |   130 |
| `DR11:trial_balance_summary`                | info    |    24 |    24 |    24 |    24 |    22 |
| `DR10:mirror_mismatch`                      | warning |    18 |    24 |    24 |    24 |     4 |
| `DR11:trial_balance_break`                  | warning |     4 |     3 |     4 |    15 |    13 |
| `DR7:user_over_daily_cap`                   | warning |     0 |     1 |     0 |     3 |     0 |
| `DR12:suspense_nonzero`                     | info    |     0 |     0 |     0 |     0 |     2 |

Two things read off that table. `DR10:mirror_mismatch` drops from 24/day to 4 on 09-07,
which is migration `20260907035309 a_mirror_never_invents_a_number` working.
`DR11:trial_balance_break` rises from 3-4/day to 15 and 13 on 09-06/07, tracking the
Daily Missions rollout; its own detail says the journal is one-sided until DR3 is
enforced and that "Journal rows the certification cleanup deleted inside the window are
gone from journal_net and read as a difference" - so the rise is the same cert-fleet
signal as everything else in this report, correctly self-described.

`ca_diamond_journal_archive`: 14,174 rows, 8.40 MB, **0 foreign keys** (as Lane C's law
requires), every row written since 2026-09-03. Working.

**Retention (DEF-07).** 18,042 + 14,174 rows and 17.5 MB in four days, ~4 MB/day,
~120 MB/month, of which the `DR5:journal_row_deleted_under_maintenance` `info` rows are
14,173 (79%). Propose: prune `severity='info'` incidents older than 30 days; keep every
`warning` and `critical` and the whole archive (the archive is the surviving evidence of
a deleted journal row and must not be pruned). The DEF-03 fixture skip does not reduce
these, because the deletion is real and worth recording; it reduces the budget noise
only.

### 3.9 `diamond_transactions.issuance_class` CHECK

```sql
select conname, convalidated, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.diamond_transactions'::regclass;
```

`diamond_transactions_issuance_class_chk` is `convalidated = false` (NOT VALID). The
allowed set is `purchased, promotional, earned, transferred, seeded, refund, spend,
bridge, deletion, admin, arena, unknown`, plus NULL.

**No row violates it.** `select issuance_class, count(*) ... group by 1` over the whole
table:

| issuance_class | counterparty                     |  rows | diamonds |
| -------------- | -------------------------------- | ----: | -------: |
| NULL           | NULL                             | 1,428 |  800,137 |
| `promotional`  | `promo_budget:catalog_v2`        |    13 |      900 |
| `promotional`  | `issuance:signup`                |     2 |    1,000 |
| `spend`        | `revenue:daily_challenge_reroll` |     1 |      -10 |

So `VALIDATE CONSTRAINT` would succeed today. It is worth doing for the ratchet, but it
proves little while NULL is legal and 98.9% of rows are NULL - the meaningful ratchet is
DR12 (no NULL class after 2026-09-03 00:07 UTC), which is already a live detector and is
currently firing because of DEF-01.

### 3.10 The two `circulation` rows in `ca_mint_ledger`

```sql
select id, op_id, action, holder_type, holder_id, amount, balance_before, balance_after,
       supply_after, reason, performed_by_label, db_role, created_at, origin
  from ca_mint_ledger where asset='diamonds' and holder_type='circulation' order by created_at;
```

Three rows, not two. The P3 one and the two the brief asks about:

1. **P3 baseline**, `op_id baseline:diamonds:2026-09-03:v2`, mint 1,030,092, holder
   `00000000-0000-0000-0000-00000000d1a0`, by `migration
diamond_p3_the_baseline_is_circulation_not_the_house`, `origin='baseline'`.
2. **Mint 611,325**, `op_id register-opening-baseline-correction:diamonds:2026-09-05T04:17:53Z`,
   holder `...c1c0`, by `migration 20260905041033`, `origin='baseline'`. Reason,
   quoted in part: the register read 419,282 against a meter of 1,030,607, and the gap
   is "the history the register never carried before the diamond journal fed it:
   purchases, rewards, refunds and spends written between the 2026-09-03 baseline and
   today, and the archived journal of deleted certification accounts whose deletion
   burns retired more than their registered seeds." It ends "No diamond moved."
3. **Burn 18,000**, `op_id register-opening-baseline-correction:diamonds:2026-09-05T06:53:04Z`,
   holder `...c1c0`, by `migration 20260905064901`, `origin='baseline'`. Reason: two
   named, measured causes - "the signup grant was registered twice (the seed door and
   the journal trigger, 18 duplicate pairs) and a certification account whose balance
   was zeroed outside the journal was deleted holding 0, so its seed was never retired."

**Is another agent using `circulation` as a dumping ground? No.** Both rows are signed,
dated, `origin='baseline'`, name their migration, state the two numbers they reconcile,
give a cause, and say explicitly that no diamond moved and no player balance changed.
That is exactly the shape the standard asks for. The only untidiness is DEF-08: the P3
row is on holder `d1a0` and the two later rows on `c1c0`, so `circulation` does not
present as one continuous balance line - the 09-05 row's `balance_before` of 419,282 is
`c1c0`'s own running total, not the platform's.

**Does `fn_ca_mint_supply('diamonds') = SUM(profiles.diamonds)` still hold?**

```sql
select fn_ca_mint_supply('diamonds'), (select sum(diamonds) from profiles),
       (select balance from ca_diamond_house limit 1);
-- 1023512.00 | 1023512 | 0
```

**It holds exactly**, and it holds **because of** those two rows, not despite them: the
611,325 mint set the register to the meter and the 18,000 burn removed the double-count,
after which "the register follows the journal and the difference is asserted at zero"
(the row's own words). Without them the register would be 593,325 adrift.

### 3.11 `fn_ca_mint_supply` semantics under cert-account churn

```sql
CREATE OR REPLACE FUNCTION public.fn_ca_mint_supply(p_asset text) RETURNS numeric
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0)
    FROM public.ca_mint_ledger WHERE asset=p_asset; $$
```

323 characters, service_role only. It is a full scan of `ca_mint_ledger` (7.00 MB,
8,630 diamond rows plus every chip row) with no index and no `asset` filter pushdown
beyond the WHERE. At the current cert-fleet rate the diamond side alone grows by ~2,150
rows/day (1,891 mints + 6,734 burns over five days). **This function will get slower
linearly and forever.**

Semantically it is correct under mint/burn churn: a cert account minted 18,125 and then
burned 18,125 nets to zero, which is why the identity in 3.10 still holds after 306
studio-cert mints totalling 2.53M and 6,734 burns totalling 3.90M. The risk is not
correctness, it is that a `SUM` over an append-only register is an O(n) answer to a
question asked on every trial-balance tick (24/day) and every mint. Recommend a partial
index `ON ca_mint_ledger (asset) INCLUDE (action, amount)` at minimum, and a rolled-up
`ca_mint_supply_current` row maintained by the same trigger that appends, with
`fn_ca_mint_supply` reading the rollup and a nightly assertion that the rollup equals
the scan. Not urgent; flagged so it does not become urgent silently.

---

## PART 4 - CROSS-CUTTING CHECKS

### 4.1 Telemetry exposure - CLEAN

Both the database judgement and the CI script agree.

```sql
select * from public.fn_ca_browser_reachable_telemetry();
-- (0 rows)
```

```
$ SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ci/check-telemetry-exposure.mjs
[telemetry-exposure] no unscoped operator routine is reachable from a browser.
EXIT=0
```

(Values were read from `~/Documents/club-arena/.env` into the environment of that one
command and never printed.)

**No unscoped definer is reachable from a browser today, and none of ours is among any
exposure.** `fn_ca_diamond_snapshot`, `fn_ca_diamond_trial_balance`,
`fn_ca_diamond_trial_balance_watch`, `fn_ca_diamond_incident`, `fn_ca_mint`,
`fn_ca_burn`, `fn_ca_mint_supply`, `fn_diamond_purchase_dispute` and
`fn_ca_diamond_earn_ledger` are all `{postgres=X/postgres,service_role=X/postgres}`.

`ca_browser_definer_allowlist`: 29 rows, RLS on, no browser grants, every row carrying a
written reason. **No diamond function is on it, and none needs to be.**

### 4.2 EXECUTE grants on every function the six lanes created

`select proname, prosecdef, proacl from pg_proc ...` over the 27 function names the lane
migrations create:

| function                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | secdef           | acl                     | verdict                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------- | ----------------------------- |
| `add_diamonds_to_balance`, `deduct_diamonds`, `fn_ca_audit_diamond_change`, `fn_ca_browser_reachable_telemetry`, `fn_ca_burn`, `fn_ca_diamond_born_with_balance`, `fn_ca_diamond_catalog_history`, `fn_ca_diamond_earn_ledger`, `fn_ca_diamond_incident`, `fn_ca_diamond_snapshot`, `fn_ca_diamond_trial_balance`, `fn_ca_diamond_trial_balance_watch`, `fn_ca_journal_append_only`, `fn_ca_journal_profile_deletion`, `fn_ca_mint`, `fn_ca_mint_supply`, `fn_ca_open_payout_freeze`, `fn_ca_propose_manual_adjustment`, `fn_diamond_purchase_dispute`, `reconcile_diamond_purchase_refund`, `settle_diamond_card_purchase_atomic`, `enter_trivia_tournament_v2`, `award_diamonds_v2` | yes              | postgres + service_role | correct                       |
| `fn_diamond_side_tables_follow_profiles`, `fn_refuse_new_entries_while_frozen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no (trigger fns) | postgres + service_role | correct                       |
| `handle_new_user`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | yes              | + `supabase_auth_admin` | correct, required by GoTrue   |
| `ca_promo_vault_buy`, `fn_purchase_time_banks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | yes              | + `authenticated`       | correct, a browser calls them |
| **`fn_ca_diamond_engine_of`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **no**           | **+ `authenticated`**   | **DEF-11, unnecessary**       |

One unnecessary grant, no dangerous one.

### 4.3 RLS and browser grants on every table the lanes created

```sql
select relname, relrowsecurity, (policies), (anon/authenticated grants) ...
```

| table                                 | RLS |                             policies | anon/authenticated grants                                                        |
| ------------------------------------- | --- | -----------------------------------: | -------------------------------------------------------------------------------- |
| `ca_diamond_incidents`                | on  |                                    0 | none                                                                             |
| `ca_diamond_house`                    | on  |                                    0 | none                                                                             |
| `ca_diamond_house_ledger`             | on  |                                    0 | none                                                                             |
| `diamond_reward_budgets`              | on  |                                    0 | none                                                                             |
| `diamond_engine_daily_caps`           | on  |                                    0 | none                                                                             |
| `diamond_user_daily_awards`           | on  |                                    0 | none                                                                             |
| `diamond_reward_catalog_history`      | on  |                                    0 | none                                                                             |
| `daily_challenge_catalog_history`     | on  |                                    0 | none                                                                             |
| `trivia_diamond_award_limits_history` | on  |                                    0 | none                                                                             |
| `ca_browser_definer_allowlist`        | on  |                                    0 | none                                                                             |
| `diamond_platform_budget`             | on  |                 1 (service_role ALL) | none                                                                             |
| `ca_mint_ledger`                      | on  |      1 (admin/god/superadmin SELECT) | `authenticated:SELECT` - gated by the policy, correct                            |
| `diamond_transactions`                | on  | 2 (own-row SELECT; service_role ALL) | `anon:SELECT`, `authenticated:SELECT` - gated to `auth.uid() = user_id`, correct |
| `diamond_reward_catalog`              | on  |         1 (`TO public USING (true)`) | `anon:SELECT`, `authenticated:SELECT` - the reward list is public by design      |

**RLS is enabled on every table the lanes created, and no lane table carries an
`anon`/`authenticated` grant.** The four tables that do carry browser grants are
pre-existing and each has a policy that scopes it. Nothing to fix.

Note for the record: a table with RLS on and **zero policies** denies everything to
every non-superuser, non-owner role, which is the intended posture for all nine of the
lane tables above. It is a correct pattern here, not an oversight.

---

## PART 5 - WHAT I DID NOT VERIFY

- I did not execute `award_diamonds_v2`, `fn_ca_mint`, `fn_ca_burn` or any money path,
  even inside a rolled-back block. Every statement about their behaviour comes from
  reading `pg_get_functiondef()` and from rows they have already written.
- The claim that the 1,340 deleted signup recipients were certification accounts is
  inferred, not directly read: their `auth.users` rows are gone, so
  `fn_ca_is_cert_account` cannot answer for them today. The inference rests on (a) the
  one surviving example being a cert account, (b) the 1:1 match between the 1,340 mints
  and the 670,000 `signup` budget line, and (c) 1,421 of 1,435 `diamond_user_daily_awards`
  rows being orphaned. I would call that conclusive but it is labelled here as inference.
- `git log` was read from `~/Documents/club-arena` (the mirror), not fetched. If a
  diamond migration merged in the last few minutes it would not appear.
- I did not read the full 30,270-character live `award_diamonds_v2` body; I read the
  declarations, the profile read, the cap block, the family blocks through
  `streak_reward`, the INSERT and the exception handler. A defect in the untouched
  middle (the six server-only families) would not have been seen. That region is
  Reviewer 1/2 territory if it was in their scope.
