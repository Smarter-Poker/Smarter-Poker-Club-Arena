# Lane D - purchase clearing: one record per purchase, a chargeback is a debt

Diamond Accounting Standard (`docs/DIAMOND-ACCOUNTING-STANDARD.md` 3.2
"Purchase", 3.3 DR1 / DR8 / DR9 / DR13, section 5 "Lane D"). Evidence:
`docs/audits/2026-09-02-diamond-economy/lane2-ramps-bridge-and-standard.md`
parts A and E, gaps G1, G2, G4, G5, G9.

Everything below is what was OBSERVED. Every number came from a query run
against production on 2026-09-03; every probe transcript is from a transaction
that was rolled back and then verified to have left nothing behind.

## What production looked like before (measured, not inferred)

| Reading                                                                                      | Value                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `diamond_purchases` rows                                                                     | 3 (2 completed, 1 pending since 2026-02-12)                                                                    |
| Rows with a non-null `stripe_checkout_session_id`                                            | 2                                                                                                              |
| Rows with a non-null `stripe_payment_intent_id`                                              | **0**                                                                                                          |
| Duplicate session ids / payment intents                                                      | 0 and 0                                                                                                        |
| Unique index on either Stripe order id                                                       | **none**                                                                                                       |
| CHECK on `diamond_purchases.status`                                                          | **none**; values present: completed 2, pending 1                                                               |
| `anon` / `authenticated` grants on `diamond_purchases`                                       | INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER (RLS blocks the writes; the grant should not have existed) |
| `profiles` rows                                                                              | 1,308; negative `diamonds` **0**; NULL `diamonds` **0**                                                        |
| CHECK `(diamonds >= 0)` on `profiles`                                                        | **none**                                                                                                       |
| `diamond_purchase_lots` / `diamond_debts` / `diamond_purchase_disputes` / `diamond_packages` | did not exist                                                                                                  |
| `charge.dispute.*` handling                                                                  | 0 grep hits in either repo; not subscribed at Stripe                                                           |

The one purchase that has never settled is `beb4725e`, `Micro`, 100 diamonds,
1.00 USD, `pending` since 2026-02-12. It is the only row in the database on
which a settle can be probed.

## Which functions could drive `profiles.diamonds` negative

Asked of `pg_proc.prosrc` directly, then each body was read. Six functions
subtract from `profiles.diamonds`:

| Function                       | Guard                                                                     | Verdict                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `transfer_diamonds_deduct`     | `WHERE id = sender_id AND diamonds >= deduct_amount`                      | safe                                                                                                                                     |
| `send_stream_gift`             | `WHERE id = v_sender AND diamonds >= p_amount`                            | safe                                                                                                                                     |
| `send_wallet_diamond_transfer` | `WHERE id = v_sender AND diamonds >= p_amount`                            | safe                                                                                                                                     |
| `deduct_diamonds`              | `SELECT ... FOR UPDATE` then `IF v_current < p_amount THEN RETURN`        | safe (the row lock makes the pre-check race-free)                                                                                        |
| `fn_atomic_buyin`              | `SELECT ... FOR UPDATE` then `IF v_diamonds < p_diamond_cost THEN RETURN` | safe                                                                                                                                     |
| `fn_purchase_time_banks`       | `SELECT ... FOR UPDATE` then `IF v_diamonds < v_total_cost THEN RETURN`   | safe, and separately broken: it inserts into a `reason` column that does not exist, so every call raises 42703. Lane A owns that repair. |

`reconcile_diamond_purchase_refund` was the seventh, and the only unguarded
one: it wrote `diamonds = COALESCE(diamonds, diamond_balance, 0) - v_delta`
with no floor at all and reported the result as `chargeback_debt: v_balance <
0`. That is what this lane fixed, and it is why the `CHECK` could be validated
without turning any currently-succeeding call into a 23514.

## What shipped

### Migration `20260903003327_diamond_d_purchase_clearing`

- `ux_diamond_purchases_stripe_session` and
  `ux_diamond_purchases_stripe_payment_intent`, both UNIQUE and partial
  (`WHERE ... IS NOT NULL`). Created clean; 0 duplicates existed.
- `diamond_purchases_status_known` CHECK on the four values the live code
  writes (`pending`, `completed`, `refunded`, `failed`), `NOT VALID`.
- `REVOKE INSERT, UPDATE, DELETE ON diamond_purchases FROM anon, authenticated`.
  After: `anon` and `authenticated` hold SELECT, REFERENCES and TRIGGER only.
- `diamond_packages`, 8 rows seeded verbatim from `VALID_DIAMOND_PACKAGES` in
  the World Hub `pages/api/store/create-checkout-session.js:44-52`. RLS on,
  SELECT to `authenticated` (the store page reads it), writes `service_role`.
- `diamond_purchase_lots`, `diamond_debts`, `diamond_purchase_disputes`. RLS
  on, `service_role` only.
- `settle_diamond_card_purchase_atomic` rewritten with every existing branch
  kept byte-for-byte (live body 4,710 chars before, 9,107 after; the growth is
  the three added blocks and their comments) plus: a DR7 log-only incident on a
  `cs_test_` session, a DR8 log-only incident when the purchase row disagrees
  with `diamond_packages`, the purchase lot, and `counterparty` /
  `issuance_class` on the journal row the credit produced.
- `reconcile_diamond_purchase_refund` rewritten, cumulative model, pro-rata
  target, redemption unwind and every reference shape kept (6,639 chars before,
  8,622 after). The clawback now debits `LEAST(delta, balance)` and books the
  remainder in `diamond_debts` as `chargeback_exceeds_balance`.
- `fn_diamond_purchase_dispute`, `SECURITY DEFINER`, `service_role` only,
  registered in `ca_money_rpc_registry`.

### Migration `20260903003403_diamond_d_the_balance_cannot_go_negative`

`ALTER TABLE profiles ADD CONSTRAINT profiles_diamonds_nonnegative CHECK
(diamonds >= 0) NOT VALID` then `VALIDATE CONSTRAINT`. Confirmed live:
`convalidated = true`.

### Why there are two migrations and not one

The first attempt was one file. It failed with:

```
ERROR:  40P01: deadlock detected
DETAIL:  Process 1644186 waits for AccessExclusiveLock on relation 2361885 of database 5;
         blocked by process 1644196.
         Process 1644196 waits for RowShareLock on relation 16495 of database 5;
         blocked by process 1644186.
```

Relation 2361885 is `public.profiles`; relation 16495 is `auth.users`. The
migration held its lock on `diamond_purchases` and then asked for ACCESS
EXCLUSIVE on `profiles`, with a live session on the other side of it.

**Nothing was applied.** Verified immediately afterwards: 0 of the 4 new
tables, 0 of the 2 new indexes, 0 `profiles_diamonds_nonnegative`,
`fn_diamond_purchase_dispute` absent, the refund body unchanged, and 0 rows in
`supabase_migrations.schema_migrations` matching the name. The transaction
rolled back whole, which is what one BEGIN/COMMIT is for.

Splitting is what the swarm brief already prescribes for a hot table, and the
ORDER is now load-bearing rather than incidental: the second file will not
apply unless `reconcile_diamond_purchase_refund` already books debts. If the
constraint existed while the old function was live, a chargeback larger than a
player's balance would raise 23514 inside the Stripe webhook and Stripe would
retry it forever.

### World Hub (repo `Smarter-Poker-World-Hub`), additive only

- `pages/api/store/webhooks/stripe.js`: three new dispatch cases and
  `handleDispute` / `correlateDiamondPurchase`. Correlation is the same shape
  `handleRefund` uses (payment intent first, then the Checkout Sessions
  listing), which matters here because both completed purchases carry a NULL
  payment intent and the primary lookup cannot find them. `closed` is passed as
  `charge.dispute.closed:won` or `:lost`. A dispute that does not correlate to
  a diamond purchase logs and returns: merchandise and VIP charges get disputed
  too, and throwing would make Stripe retry those forever. No existing branch
  was touched.
- `scripts/setup-stripe-webhook.js`: the three event names added to
  `WEBHOOK_EVENTS`. **Running that script is still a human action** and this
  lane did not run it; until someone does, the live Stripe endpoint is not
  subscribed to dispute events and the handler will never fire.
- `pages/api/store/create-checkout-session.js`: `loadDiamondPackages()` reads
  `diamond_packages` (60s cache) and `resolveDiamondPackage` takes the catalog
  as an argument. `VALID_DIAMOND_PACKAGES` stays as the fallback and one
  malformed row discards the whole table rather than selling at a wrong price.
- No test was added: there is no test file anywhere near these three, and
  inventing a framework for them is not this lane's job.

## Probes (every one inside BEGIN / ROLLBACK)

### (a) Settle the 202-day pending purchase with a test-mode session

`settle_diamond_card_purchase_atomic('beb4725e...', 'cs_test_probe_<uuid>', 'pi_test_probe_<uuid>')`

```
0_balance_before   { "diamonds": 493960 }
1_settle_result    { "success": true, "duplicate": false, "new_balance": 494060,
                     "redemption_status": "not_requested" }
2_lot_row          { "issued": 100, "consumed": 0, "refunded": 0, "frozen_at": null,
                     "settled_at": "2026-09-03T00:34:54Z",
                     "purchase_id": "beb4725e-7053-4d7a-8da8-b1a02e9742c4" }
3_journal_row      [ { "type": "purchase", "amount": 100, "balance_after": 494060,
                       "counterparty": "purchase_clearing",
                       "issuance_class": "purchased",
                       "reference_id": "beb4725e-7053-4d7a-8da8-b1a02e9742c4" } ]
4_incidents        [ { "rule": "DR7:test_mode_session_settled", "severity": "warning",
                       "amount": 100, "writer": "settle_diamond_card_purchase_atomic" } ]
5_dr8_fired        { "count": 0 }
6_purchase_after   { "status": "completed", "session": "cs_test_probe_d9" }
7_balance_after    { "diamonds": 494060 }
```

DR8 correctly did NOT fire: the row is `Micro` / 100 / 0 bonus / 1.00 and the
`micro` package row is 100 / 0 / 1.00.

After ROLLBACK: purchase back to `pending`, 0 lots, 0 incidents, 0 journal rows
for that reference, balance 493,960.

### (b) A chargeback larger than the balance

Constructed inside the rolled-back transaction, because no such purchase exists
in production: a 1,000 diamond package (10.00 USD) for a player holding **5**
diamonds, then a full reversal.

```
0_balance_before  { "diamonds": 5 }
1_refund_result   { "success": true, "new_balance": 0, "fully_refunded": true,
                    "balance_applied": 5, "chargeback_debt": true,
                    "refunded_diamonds": 1000, "chargeback_debt_amount": 995 }
2_balance_after   { "diamonds": 0, "diamond_balance": 0 }
3_debt_row        [ { "amount": 995, "reason": "chargeback_exceeds_balance",
                      "settled_at": null } ]
4_journal_row     [ { "type": "refund", "amount": -5, "balance_after": 0,
                      "counterparty": "purchase_clearing", "issuance_class": "refund",
                      "metadata": { "reversal_owed": 1000, "balance_applied": 5,
                                    "debt_booked": 995, "chargeback_debt": true } } ]
5_lot_after       { "issued": 1000, "consumed": 0, "refunded": 1000 }
6_incident        [ { "rule": "DR1:chargeback_exceeds_balance", "severity": "critical",
                      "amount": 995 } ]
7_purchase_after  { "status": "refunded", "refunded_diamonds": 1000,
                    "chargeback_debt_amount": 995 }
8_replay_is_noop  { "success": true, "balance_applied": 0, "chargeback_debt": false }
9_after_replay    { "debt_rows": 1, "balance": 0 }
```

The balance stopped at 0. Under the old function it would have been -995. The
journal row carries -5, the amount that actually moved, so the journal net and
the balance movement agree; the 995 that did not move is the debt row.

### (c) The dispute lifecycle, and a replay

```
1_created                      { "success": true, "lots_frozen": 1,
                                 "evidence_deadline": "unknown" }
2_lot_frozen                   { "frozen_at": true }
3_created_REPLAY               { "success": true, "duplicate": true }
4_incident_count_after_replay  { "dispute_opened_incidents": 1, "dispute_rows": 1 }
5_funds_withdrawn              { "success": true,
                                 "reversal": { "refunded_diamonds": 100,
                                               "balance_applied": 100,
                                               "chargeback_debt": false,
                                               "new_balance": 493860 } }
6_balance_after_reversal       { "diamonds": 493860 }
7_journal                      [ { "type": "refund", "amount": -100,
                                   "counterparty": "purchase_clearing",
                                   "issuance_class": "refund" } ]
8_closed_won                   { "success": true, "lots_unfrozen": 1 }
9_lot_final                    { "issued": 100, "refunded": 100, "frozen_at": null }
a_dispute_rows                 [ created, funds_withdrawn, closed:won ]
b_incidents                    [ DR10:dispute_opened (critical),
                                 DR10:dispute_funds_withdrawn (critical),
                                 DR10:dispute_closed_won (info) ]
c_unsupported_event            { "success": false, "error": "unsupported_event",
                                 "event": "charge.dispute.updated" }
```

`created` fired twice and produced one dispute row and one incident. The PK on
`(dispute_id, event)` is the whole guard, claimed before any side effect.

### Rollback verification, after all three probes

```
purchases 3   lots 0   debts 0   disputes 0   incidents in 10 min 0
balance 47965354: 493960 (unchanged)   balance 3207d865: 5 (unchanged)
profiles with a negative diamond balance: 0
```

## What is LOG-ONLY, and why

- **DR7**, a `cs_test_` session settling in the live database. One such
  purchase already exists (`fe35f19d`, 100 diamonds, 2026-02-12). Refusing a
  settle refuses a charge Stripe has already taken, so it records and settles.
- **DR8**, the purchase row disagreeing with `diamond_packages`. Same reason: a
  package renamed or repriced between checkout and settle is a reason to look,
  not a reason to leave a paying customer with nothing.
- Both blocks, and the lot write, swallow their own errors. A paid charge must
  never fail because an incident row could not be written. A failed lot write
  files `DR9:purchase_lot_write_failed` at critical instead.

## What was NOT built, and why

- **FIFO consumption attribution.** `diamond_purchase_lots.consumed` exists and
  stays 0. Attribution has to happen at the SINK, which means inside
  `deduct_diamonds` - Lane C's function, being rewritten in parallel. Two lanes
  editing one body is how a rewrite loses half of itself. Until it lands,
  `purchased_liability = SUM(issued - consumed - refunded)` overstates the
  liability by whatever has been spent. Roadmap.
- **Foreign keys on the three new tables.** `diamond_purchases` carries
  `user_id -> profiles ON DELETE CASCADE`, so a CASCADE from the lot would
  erase a paying customer's record inside the chargeback window (D15 forbids
  it) and a RESTRICT would make account deletion RAISE - 77 profiles were
  deleted on 2026-09-02, and all 77 would have failed. They carry no FK at all.
  When Lane C's `fn_ca_retire_profile` replaces the CASCADE and becomes the only
  deletion path, RESTRICT becomes safe.
- **Provider reconciliation** (`fn_ca_purchase_reconcile` against the Stripe
  balance report, D11 / G3). It needs a Stripe API caller, which belongs in an
  Open Claw cron in the World Hub, not in a migration.
- **Settling a debt.** Nothing pays a `diamond_debts` row down. Whether the
  next credit settles it or it is written off to the house is Dan's decision.
- **Subscribing the live Stripe endpoint.** The three event names are in
  `scripts/setup-stripe-webhook.js`, but running that script against the live
  Stripe account is a human action with a credential this lane does not use.

## Decisions that are Dan's

1. **The chargeback receivable** (standard 6.2). A `diamond_debts` row exists
   now and nothing settles it. Is the next credit applied to the debt first, or
   is the debt written off to the house?
2. **The test-mode purchase** `fe35f19d` (standard 6.11), 100 diamonds credited
   from a `cs_test_` session on 2026-02-12. Reverse it or leave it. DR7 will
   record any future one; it will not refuse it.
3. **Whether a `cs_test_` session should eventually REFUSE** in the live
   database rather than warn. That is a real refusal on a paid path and needs
   Dan's word.
4. **The 202-day `pending` purchase** `beb4725e`. It has sat since 2026-02-12
   and `handleCheckoutExpired` never closed it. Expire it to `failed`, or leave
   it. This lane touched nothing about it outside a rolled-back transaction.
5. **Running `scripts/setup-stripe-webhook.js`** so the live endpoint actually
   receives dispute events. Until that happens the handler is dead code.
6. **The purchased-lot dispute window** (standard 6.14) before a purchased lot
   may be spent or deposited into the arena. Stripe's dispute window for this
   account is UNVERIFIED.
