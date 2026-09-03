# Diamond Accounting Standard, Lane A: the supply identity, the mirrors and the doors

Branch `fix/diamond-a-identity`. Two migrations:

- `20260903003036_diamond_a_identity_and_doors` (one transaction, applied once at
  2026-09-03 00:30:36 UTC, all seven post-apply assertion groups green) - the work.
- `20260903004002_diamond_a_the_snapshot_is_not_a_browser_rpc` (applied 00:40:02 UTC) -
  a companion the pre-push guard asked for, and was right to ask for. Section 7.3.

Everything below is what was OBSERVED against production, not what was intended.

---

## 1. What the supply identity said before, and what it says now

`fn_ca_diamond_snapshot` computed `total = SUM(profiles.diamonds) + SUM(diamond_wallets.balance)`.
Since the mirror backfill of 2026-09-02 17:29 UTC, `diamond_wallets` IS `profiles`, so every
diamond held by one of the 416 wallet users was counted twice.

Snapshot rows read straight out of `ca_diamond_snapshots`:

| id  | taken_at (UTC)      | profile_diamonds | wallet_diamonds | total     | delta_vs_prev | unexplained |
| --- | ------------------- | ---------------- | --------------- | --------- | ------------- | ----------- |
| 46  | 2026-09-02 17:10:00 | 1,030,092        | 50              | 1,030,142 | 105           | 0           |
| 47  | 2026-09-02 18:10:02 | 1,030,092        | 619,879         | 1,649,971 | 619,829       | 619,829     |
| 53  | 2026-09-03 00:10:00 | 1,030,092        | 619,879         | 1,649,971 | 0             | 0           |

Row 47 is the whole defect in one line: `profile_diamonds` does not move between 17:10 and
18:10, `wallet_diamonds` jumps by 619,829, and the snapshot calls that jump unexplained drift.
It was a mirror backfill. Nothing was minted.

`total` is now `SUM(profiles.diamonds)` alone. `wallet_diamonds` is still recorded, because
DR10 wants the mirrors COMPARED, and a figure that is not recorded cannot be compared. It is
never added.

### The first-run drift, and why no correcting row was written

Changing `v_total` alone would have been a live incident, not a fix. The drift arithmetic
subtracted the previous row's stored `total`, and every historical row carries the OLD identity.
The next hourly snapshot would have computed roughly -619,879 of unexplained drift.

That number is not cosmetic. `scripts/ci/check-chip-conservation.mjs` (lines 143 to 150) fails
when the trailing four hours of `ca_diamond_snapshots.unexplained` exceed 500 in absolute value,
and `.github/workflows/auto-deploy-hetzner.yml` line 310 runs it as the engine deploy money gate.
That gate blocked 26 consecutive engine deploys on 2026-09-02. Re-arming it with an accounting
correction would have been the same outage with a different cause.

It reads `prev.profile_diamonds` instead. That column is NOT NULL on all 53 historical rows and
has always meant exactly `SUM(profiles.diamonds)`, so it is a continuous basis across the change.
The arithmetic on the live previous row (id 53: profile_diamonds 1,030,092, cert 234,480) is

    (1,030,092 - 234,480) - (1,030,092 - 234,480) - journal_noncert = -journal_noncert

which is what the old identity produced for the same interval. **No correcting row was written
and none is needed.** The 619,829 spike of 18:10 had already aged out of the gate's four-hour
window; snapshots 48 through 53 all read `unexplained = 0`.

Grep for consumers of `ca_diamond_snapshots` across the worktree found exactly one:
`scripts/ci/check-chip-conservation.mjs:145`. There is no other reader in `scripts/`,
`server/src`, `.github/workflows/`, or any `pg_proc` body.

### Rolled-back probe: the snapshot

```
BEGIN;
SELECT public.fn_ca_diamond_snapshot();
SELECT id, taken_at, profile_diamonds, wallet_diamonds, cert_diamonds, total,
       journaled_delta, delta_vs_prev, unexplained,
       (total = (SELECT COALESCE(sum(diamonds),0) FROM profiles)) AS total_equals_profiles_sum
  FROM ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 2;
ROLLBACK;

 id | taken_at             | profile_diamonds | wallet_diamonds | cert    | total     | delta | unexpl | total_equals_profiles_sum
 54 | 2026-09-03 00:31:25  | 1030092          | 1030092         | 234480  | 1030092   | 0     | 0      | true       <- new body
 53 | 2026-09-03 00:10:00  | 1030092          | 619879          | 234480  | 1649971   | 0     | 0      | false      <- old body
```

`unexplained = 0`, not -619,879. The gate stays green. No `DR10:mirror_mismatch` incident fired,
which means all three mirrors agreed for all 1,308 profiles at that moment.

---

## 2. The diamond_wallets mirror could never gain a row

`fn_diamond_side_tables_follow_profiles` upserts `user_diamonds` and `user_diamond_balance` but
did a bare `UPDATE` on `diamond_wallets`. A profile with no wallet row could therefore never get
one.

Measured before: 1,308 profiles, 416 wallet rows, 892 missing, and the 410,213 diamonds those 892
profiles hold were absent from that mirror entirely.

Measured after: 1,308 wallet rows, 0 missing, `sum(diamond_wallets.balance) = 1,030,092 =
sum(profiles.diamonds)`.

**This moved no diamonds.** `diamond_wallets` is a mirror; nothing on the canonical path reads it,
`profiles.diamonds` was not written by this migration, and the supply identity above no longer
adds it. `lifetime_earned` on a backfilled row is set equal to the mirrored balance so the row is
internally consistent; this migration knows no history for those users and did not invent one.

---

## 3. The Mint doors

`fn_ca_mint` and `fn_ca_burn` were both granted to `authenticated`. Both repos were grepped for
browser callers (club-arena `src`, `server`, `scripts`, `tests`; World Hub `pages`, `src`,
`scripts`; excluding `node_modules`, `dist`, `.next`, `public/hub`): **zero callers of either,
from any role.** EXECUTE is revoked from `authenticated` and `anon`; `postgres` and `service_role`
keep it.

The revoke is written as a loop over `pg_proc` by NAME rather than a hardcoded signature. See
section 7: a hardcoded signature aborted the first apply.

`fn_ca_burn` and 21 diamond RPCs were registered in `ca_money_rpc_registry` (registry rows
251 -> 273). `fn_union_send_to_member_zd3core` was already registered on 2026-08-31, and Lane B
registered `fn_ca_burn` and `handle_new_user` at 00:22 UTC while this was being written; the
insert is guarded by `WHERE NOT EXISTS`, so those were skipped rather than duplicated.

**Registering changed no behaviour, and this was checked before writing the rows.** The registry
has exactly one consumer, `fn_ca_money_rpc_drift`, which scans `pg_proc` for functions writing
CHIP balance tables (`club_members`, `club_wallets`, `union_wallets`, `unions`, `table_seats`,
`bbj_pools`, `clubs`, `agents`, `wallets`, `spin_bonus_pools`, `tournament_players`) and warns
about the ones NOT EXISTS in the registry. A row can only suppress a warning for its own name; it
can never create one. Most of these functions write `profiles.diamonds`, which that scan does not
look at, so they were never flagged and these rows are an inventory declaration.

---

## 4. fn_purchase_time_banks was broken in production, on every call

The live body inserted into `diamond_transactions (user_id, amount, reason)`. **There is no
`reason` column on that table.** Every call raised 42703. No player could buy a time bank.

It got that way on 2026-08-24: `20260824_consolidate_time_banks.sql` overwrote
`20260823_fn_purchase_time_banks_balance_key.sql` and in doing so reintroduced a hardcoded price
of 2 (against `feature_pricing.time_bank_seconds = 5`), dropped the idempotency reference, and
wrote the nonexistent column.

Restored: price from `feature_pricing`, debit through `deduct_diamonds` with reference
`tbank_<user>_<qty>_<epoch_seconds>`, the `auth.uid()` self-check and the grant to `authenticated`
kept, quantity bounded 1 to 500 as in the 08-23 body.

Two things were deliberately KEPT rather than reverted:

- **The single consolidated `feature_purchases` row** from 08-24, not the 08-23 loop of N rows.
  That part of 08-24 was a real fix: hundreds of single-use rows hit the PostgREST row limit in
  the client's `loadEntitlements` and the player's purchased banks stopped showing.
  `fn_time_bank_allowance` reads `SUM(uses_remaining)`, so one row of N is exactly N rows of 1.
- **`p_source = 'feature_purchase'`.** Lane C landed at 00:22 UTC and `deduct_diamonds` now
  derives `counterparty` and `issuance_class` itself, from `p_source`. Passing `'time_bank'`
  would have produced the more specific `revenue:time_bank` named in the lane brief, but
  `p_source` is also written to `diamond_transactions.transaction_type`, and
  `src/components/wallet/DiamondWalletModal.tsx` line 119 maps exactly `feature_purchase` to a
  wallet label. The comment above that line records that a previous release shipped a key no
  wallet map had and the row rendered unlabelled. Sharpening an accounting label at the cost of
  re-shipping a known UI bug is a bad trade. The row carries `counterparty =
revenue:feature_purchase`, `issuance_class = spend`, and the sink stays identifiable through
  `metadata.sink = 'time_bank'` and `metadata.feature = 'time_bank_seconds'`.

A replay guard was added that the 08-23 body did not have: if `deduct_diamonds` returns
`idempotent: true`, the entitlement row is NOT inserted and the earlier outcome is returned.
Without it, a retry inside the same one-second reference bucket would have granted free time
banks while charging nothing.

### Rolled-back probe: a horse buys three time banks

Subject `00000000-0000-0000-0000-000000000017` ("combo draw"), a horse. Horses are players
(CLAUDE.md 10.5), so a horse is the correct subject for a purchase probe.

```
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000017","role":"authenticated"}', true);
SELECT public.fn_purchase_time_banks(3);
...
ROLLBACK;

diamonds_before  300
diamonds_after   285                     <- 3 x 5 from feature_pricing, not 3 x 2
journal_row      revenue:feature_purchase | spend | amount=-15 | type=feature_purchase
                 | ref=tbank_00000000-0000-0000-0000-000000000017_3_1788395517
                 | desc=Time Banks x3
entitlement_row  uses_remaining=3 cost=15 feature=time_bank_seconds
```

No 42703. The bounds hold, returning Title Case messages:

```
fn_purchase_time_banks(600)  -> {"error": "Quantity Must Be Between 1 And 500", "success": false}
fn_purchase_time_banks(0)    -> {"error": "Quantity Must Be Between 1 And 500", "success": false}
fn_purchase_time_banks(9999) -> {"error": "Quantity Must Be Between 1 And 500", "success": false}
fn_purchase_time_banks(3)    -> {"success": true, "quantity": 3, "unit_cost": 5,
                                 "total_cost": 15, "diamonds_remaining": 285}
```

---

## 5. LOG-ONLY: the union diamond grant (DR2)

`fn_union_send_to_member_zd3core` with `kind = 'diamonds'` credits up to 100,000 diamonds per
call and debits nothing anywhere: no union diamond wallet, no Mint row, no budget. It is an
unfunded mint.

It is RECORDED and still credits. Under Dan's risk rule a guard that can refuse a live union
grant is not an agent's decision, and whether this door is funded or removed is Dan's decision
6.6 in the standard. The journal row now names `counterparty = union:<union_id>` and
`issuance_class = promotional`.

Body-length proof that nothing else changed: `length(prosrc)` went 10,271 -> 11,194, a delta of
923, which is the incident call plus the two column names. Every other branch (chips, promo, the
duplicate-send suppression, the three club-resolution fallbacks) is byte-identical to the body
read from `pg_proc` before the edit.

### Rolled-back probe: the union diamonds branch

```
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT public.fn_union_send_to_member_zd3core(
  'fade0000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000017',
  'diamonds', 1, NULL, 'LANE A ROLLED BACK PROBE');
...
ROLLBACK;

diamonds_after  301                      <- the credit PROCEEDED. Log-only, not refused.
incident_row    DR2:union_diamond_grant_unfunded | warning | amount=1
                | writer=fn_union_send_to_member_zd3core
                | detail={"note": "diamonds credited with no debit on any wallet and no mint
                   row; unfunded issuance", "actor": null,
                   "club_id": "a41434bb-8d0c-400a-8f0d-e8b3d65afed4",
                   "union_id": "fade0000-0000-0000-0000-000000000001",
                   "source_wallet": null}
journal_row     union:fade0000-0000-0000-0000-000000000001 | promotional | amount=1
                | type=union_grant
```

---

## 6. LOG-ONLY: the club promo vault debit (DR3)

`ca_promo_vault_buy` debits `club_diamond_wallets` with no `diamond_transactions` row and no
idempotency key, so the movement is invisible to the journal and a double-submit debits twice.
`promo_vault_records` is a receipt, not a ledger. It now records
`DR3:club_diamond_debit_unjournaled` at info severity with the club, item, quantity, cost and
balance before, and changes nothing else. Journalling it and giving it a reference is Lane G.
`length(prosrc)` 2,567 -> 3,568.

---

## 7. Two failed applies, both fully rolled back, and what they taught

Reported because both are reproducible traps, not because either left a mark. After each
failure `diamond_wallets` still had 416 rows, `fn_ca_diamond_snapshot` was still 3,038
characters, and `fn_ca_mint` still carried its old ACL. Nothing partial survived either.

1. **An assertion that could not tell code from prose.** The assertion
   `IF v_src LIKE '%prev.total%'` matched my own explanatory COMMENT inside the function body,
   which used the words it was scanning for. This is the identical failure the
   `20260823_fn_purchase_time_banks_balance_key.sql` migration documented in its own header
   ("an assertion that cannot tell code from prose is not checking the thing it claims to
   check"). Fixed by rewording the comment so prose stops impersonating code, keeping the
   assertion strict.
2. **A hardcoded function signature in a repo where two lanes edit the same function in the same
   hour.** `REVOKE EXECUTE ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text)`
   raised 42883, because Lane B had recreated both Mint functions with a seventh argument
   (`p_class text DEFAULT 'admin'`) at 00:22 UTC, about forty minutes after I read the six-argument
   signature. Fixed by revoking in a loop over `pg_proc` by name, which does not care what the
   argument list is today. The law test pins the loop so it cannot regress to a literal signature.

3. **A migration that assumed its access posture instead of declaring it.** The pre-push
   `check-definer-authorization` guard BLOCKED the push on `fn_ca_diamond_snapshot`: SECURITY
   DEFINER, it writes, and it never calls `auth.uid()`, `auth.role()` or `auth.jwt()`, so it
   cannot know who is asking. The guard reads a branch's migrations statically and starts every
   function from the Postgres default of EXECUTE to PUBLIC, and the migration said nothing about
   grants.

   Checked against production before responding: the door was **already shut**. The live ACL is
   `postgres=X/postgres | service_role=X/postgres` and `has_function_privilege` is false for both
   `authenticated` and `anon`; `CREATE OR REPLACE` preserves the existing ACL, so replacing the
   body widened nothing. The guard was reasoning from the file, not from a real exposure.

   It is still a real requirement and the fix is not a suppression. Swarm brief rule 8 asks for an
   in-file REVOKE/GRANT stating who may call, and an assumption that happens to be true today is
   not a declaration. The companion migration states it explicitly, naming PUBLIC as well as the
   two roles (a REVOKE that names one role while PUBLIC still holds the privilege reads as a fix
   and does nothing). It is a no-op against the current grants and fires no PostgREST reload,
   because GRANT and REVOKE are not in `pgrst_ddl_watch`'s statement list.

   The reason it matters beyond tidiness: every call to the snapshot appends a row to
   `ca_diamond_snapshots`, and that table's trailing four hours ARE the engine deploy money gate.
   A caller who could invoke it at will could move the gate.

   Noted and NOT changed, because it is inert and out of this lane's scope:
   `fn_diamond_side_tables_follow_profiles` is granted to `authenticated`. It is a trigger
   function, so Postgres refuses to call it as an RPC and the grant cannot be used; the guard does
   not flag it for that reason. It is noise in the ACL, not a door.

Because Lane B and Lane C both landed mid-flight, the five bodies this lane replaces were
re-read immediately before the successful apply and confirmed unchanged (2,567 / 3,038 / 1,420 /
1,346 / 10,271). `deduct_diamonds` HAD changed (2,303 -> 3,020) and is called by this lane, so
its contract was re-read too: it still returns `success`, `balance` and `idempotent`, which is
what `fn_purchase_time_banks` depends on.

---

## 8. Verification

Body lengths after apply, as proof each replacement took:

| function                               | before | after  |
| -------------------------------------- | ------ | ------ |
| fn_ca_diamond_snapshot                 | 3,038  | 5,472  |
| fn_diamond_side_tables_follow_profiles | 1,420  | 2,216  |
| fn_purchase_time_banks                 | 1,346  | 5,422  |
| fn_union_send_to_member_zd3core        | 10,271 | 11,194 |
| ca_promo_vault_buy                     | 2,567  | 3,568  |

Every probe rolled back. Re-measured afterwards: horse 17 back to 300 diamonds, 0 entitlement
rows, 0 union probe journal rows, 0 incident rows, 53 snapshot rows (the probe's row 54 gone),
supply unchanged at 1,030,092. The single surviving `tbank_%` journal row is the historical
purchase of 2026-08-23 19:36 UTC, not from any probe here.

Tests: `npx vitest run tests/law/DiamondSupplyIdentity*.law.test.ts tests/law-registry.law.test.ts`
-> 2 files, 73 tests passed. `npx tsc --noEmit` -> exit 0.

---

## 9. What this lane did NOT build, and why

- **`CHECK (diamonds >= 0)` on `profiles` (DR1).** In the lane list but not built here. It is a
  constraint on a hot table that can refuse a live write, and one writer
  (`reconcile_diamond_purchase_refund`) drives the balance negative BY DESIGN on a chargeback.
  Adding the CHECK before the `diamond_debts` receivable exists (Lane D) would convert a
  chargeback into a failed transaction. It needs to land WITH its receivable, not before it.
- **Refusing the union diamond grant, or journalling the club vault debit.** Both are LOG-ONLY
  by Dan's risk rule. The union door is Dan's decision 6.6; the vault journal is Lane G.
- **`counterparty` and `issuance_class` written by `fn_purchase_time_banks` directly.** The
  journal is append-only, so a row cannot be amended after `deduct_diamonds` writes it, and
  `deduct_diamonds` is Lane C's. The intent is passed in metadata and Lane C's landed body
  derives both columns correctly.
- **Anything about the mirrors other than making them correct.** Whether `diamond_wallets`,
  `user_diamonds` and `user_diamond_balance` should exist AT ALL is a live question: they are
  three tables carrying a copy of one column. Retiring them is Lane G, after the seven-day
  zero-use gate.

## 10. Decisions that are Dan's

1. **The union diamond grant (standard 6.6).** Fund it from a union diamond balance, or remove
   it. Today it mints up to 100,000 diamonds per call from nothing, and it has no caller on
   disk. It is now instrumented, so the next real use will be visible in `ca_diamond_incidents`.
2. **Whether the three mirror tables survive.** Making them correct cost a backfill of 892 rows.
   Keeping three copies of one integer forever costs a trigger on the hottest table in the
   schema. Recommendation: retire all three once nothing reads them.
3. **The time bank price.** `feature_pricing.time_bank_seconds` is 5 diamonds and the sink has
   charged nobody anything since 2026-08-24 because it was raising 42703. Purchases resume at 5
   the moment this ships. If 2 was ever the intended price, the catalogue row is where to say so.
