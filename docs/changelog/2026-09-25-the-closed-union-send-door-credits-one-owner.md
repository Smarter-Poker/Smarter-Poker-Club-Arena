# The closed union send door credits one owner, and the square-up checks the ECO record's own arithmetic

2026-09-25. Migration `20260925145748`. Two refusals added to two existing
writers. No new object, no second payer, no watcher, no historical row rewritten.

## A. A chip-minting transfer with none of the three guards

`public.fn_union_send_chips_to_club` resolved ONE club owner with `LIMIT 1` and
no `ORDER BY`, and then credited **every** `role = 'owner'` row:

```sql
SELECT user_id INTO v_owner_user_id
  FROM club_members WHERE club_id = p_club_id AND role = 'owner' LIMIT 1;
...
UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + p_amount
 WHERE club_id = p_club_id AND role = 'owner';
```

The union wallet was debited once. A club with two owner rows would have received
`2 x p_amount` for a `1 x p_amount` debit and the difference would have been
minted. There was no authorization check of any kind, no idempotency key, and no
`chip_ledger` row.

**It had no caller.** `20260903201301` closed it - revoked from PUBLIC, `anon`,
`authenticated` and `service_role`, registered `closed` in
`ca_money_rpc_registry` - after finding zero callers and zero rows in 30 days.
Verified again on production 2026-09-25: `proacl` is `{postgres=X/postgres}`,
zero clubs carry more than one `role='owner'` row, and neither `chip_ledger` nor
`union_wallet_transactions` holds a row from it. The one mention in `src/` is a
comment in `UnionDashboardPage.tsx` recording the 2026-07-21 decision to call
`fn_union_send_to_club_atomic` instead.

**And it was jammed.** Found while rehearsing this change on production's exact
catalog: step 6 inserted its audit row with `wallet = 'main'`, and
`union_wallet_transactions_wallet_check` is validated on production and permits
only `chip_balance`, `rake_wallet`, `bbj_wallet`, `promo_wallet`,
`insurance_wallet`, `spin_reserve_wallet`. Every call this door ever received
aborted there with SQLSTATE 23514 and rolled the debit, the double credit and the
audit row back together. That, not only the absence of callers, is why no chip
has gone through it. The 2026-04-15 BUG 011 fix moved the INSERT to the right
table and left the wrong wallet name in it.

### What it does now

The destination is unchanged - this door pays a union distribution into the club
owner's pocket, and moving it to `clubs.chip_treasury` would make it a second
payer beside `fn_union_send_to_club_atomic`, which is the canonical union to club
route. What changed is that it may no longer guess whose pocket:

- the owner is resolved from `clubs.owner_id`, the platform's single
  authoritative owner, which `trg_club_owner_has_a_player_wallet` keeps a member
  row for;
- anything other than exactly one `role='owner'` row, or one that is not
  `clubs.owner_id`, is **refused** (`union_send_club_owner_is_ambiguous`);
- exactly that one row is credited, by `user_id`;
- authorization is the house pattern - `fn_caller_is_engine()` or the union's
  owner, as `fn_execute_union_rakeback` and `fn_union_fund_promo_from_bank` do -
  plus `fn_union_send_to_club_atomic`'s club-in-union check;
- the idempotency key is declared by the caller on
  `app.union_send_chips_op_id`, and a caller that declares none is refused. The
  four-argument signature cannot grow a fifth parameter: that would be a new
  overload with default PUBLIC EXECUTE, which is the closed door reopening;
- one `chip_ledger` leg is written by the function itself - `union_bank` ->
  `player_wallet`, category `union_send`, carrying the key, both sides' balances
  and `club_id` declared the way `atomic_distribute_rake` and
  `fn_settle_tournament_rake` declare theirs - with both anonymous auto-journals
  stood down under the one autoskip contract;
- the audit row names `chip_balance`, so it can actually be written.

**The door stays closed.** The migration restates the revoke and grants nothing.
It is not made `SECURITY DEFINER`.

## B. A guard that could not fire

`fn_union_issue_weekly_invoices` raises `union_squareup_eco_disagrees_with_record`
when a square-up's ECO disagrees with `union_eco_ledger`. Since
`20260921040847`, `fn_union_club_invoice` RETURNS the recorded ECO
(`COALESCE(rec.eco_amount, eco.eco_amount)`), so for the only arm that reaches
the comparison the guard compares the record with itself. A rehearsal mutated a
recorded `eco_amount` by 0.01 and the invoice restated the mutated figure in
silence.

The naive repair is the 2026-09-14 defect: comparing against a fresh
`fn_union_eco_adjustment` call is what overstated one club's debt by 1.21,
because `fn_union_pnl_evidence_report` is VOLATILE and every call is another
READ COMMITTED snapshot.

**Option (a): a genuinely independent, non-volatile basis, taken from inside the
record.** `union_eco_ledger` stores `eco_base`, `eco_rate` and `eco_amount` side
by side, all three NOT NULL, and the producer defines the amount as
`round(-eco_rate * eco_base, 2)` (`fn_union_pnl_evidence_report`). Three stored
numerics; no recomputation of the week; nothing that can move between two calls.
It holds on all 14 rows `union_eco_ledger` carries on production today, and the
migration refuses to install if any recorded row fails it.

The new refusal is `union_squareup_eco_record_fails_its_own_arithmetic`, raised
before `settlement_invoices` is written. **Nothing is weakened**: both existing
arms are kept under their existing name, restructured but behaviourally
identical, including the ECO-disabled arm, which is the one arm of the old
comparison that was never a tautology.

A limit, recorded: that ECO-disabled arm cannot be exercised from a fixture,
because since `20260917230515` the commercial terms are observed at their
original write and travel with the period's recorded evidence, so flipping
`unions.settings` does not change what an already-recorded week reports. It is
asserted by shape.

## Evidence

Sept 28 dress rehearsal on a PG17 cluster carrying production's exact installed
catalog, driven by the real due coordinator at a simulated 2026-09-28T09:00Z,
armed and unarmed:

|                                           | unarmed           | armed             |
| ----------------------------------------- | ----------------- | ----------------- |
| repo fixture chain                        | CHAIN-COMPLETE    | CHAIN-COMPLETE    |
| send door preimage (the mint and the jam) | PASS              | PASS              |
| `union-send-door` regression              | **FAIL** (RED)    | **PASS** (GREEN)  |
| `union-eco-record-arithmetic` regression  | **FAIL** (RED)    | **PASS** (GREEN)  |
| cascade rounds 1-4                        | all true          | all true          |
| round receipts                            | 8                 | 8                 |
| union cursor                              | 2026-09-21T07:00Z | 2026-09-21T07:00Z |
| club cursor                               | 2026-09-21T07:00Z | 2026-09-21T07:00Z |
| rakeback paid                             | 2.00              | 2.00              |
| square-ups issued                         | 6                 | 6                 |
| every recorded ECO exact                  | true              | true              |
