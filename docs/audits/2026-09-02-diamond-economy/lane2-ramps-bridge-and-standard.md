# Lane 2 - Diamond on-ramps, off-ramps, the bridge and the industry standard (READ-ONLY audit, 2026-09-02/03)

**Read-only. Nothing applied, written to the database, committed or pushed.** Every number below comes from a
SELECT run against production `kuklfnapbkmacvwxktbh` between ~23:10 and ~23:55 UTC on 2026-09-02, or from a
`grep -rn` / `sed` run against the two repos on Dan's Mac (World Hub `~/Documents/Smarter-Poker-World-Hub`,
club-arena worktree `~/Documents/.agent-trees/club-arena/diamond-audit`). Function bodies are the LIVE bodies
(`pg_get_functiondef`), not the repo mirror. Anything not measured is labelled UNVERIFIED or UNKNOWN. No em dashes,
no emoji.

## 0. The answer in ten lines

1. **Stripe Checkout is the only live purchase provider.** No StoreKit, RevenueCat or Google Play code exists in either
   repo (0 files for each grep). The webhook verifies signatures (`constructEvent`), claims each `event.id` through a
   primary-keyed table, and settles through a SECURITY DEFINER RPC. It is the best-built money path in the whole
   diamond economy. It has also processed **3 purchases in its life, all on 2026-02-12, 300 diamonds, $3.00**, and the
   `stripe_webhook_events` claim table has **0 rows** (created 08-30, no event since).
2. **Those 3 purchases were never journaled.** `diamond_transactions` holds **zero** rows of type `purchase` and zero rows
   for that buyer on 2026-02-12. The credit went straight to a wallet table under the old handler. The modern path
   (`settle_diamond_card_purchase_atomic` -> `add_diamonds_to_balance`) does journal, but has never fired.
3. **Refunds reverse the grant, disputes do not exist.** `charge.refunded` is handled (pro-rata clawback, can drive the
   balance negative as `chargeback_debt`); `charge.dispute.*` is neither subscribed (`scripts/setup-stripe-webhook.js`)
   nor handled (0 grep hits). There is **no provider-vs-internal reconciliation** of any kind (no cron, no
   balance-transaction pull, no daily trial balance against Stripe).
4. **Purchased and earned diamonds are one column** (`profiles.diamonds`, CONFIRMED by the brief) and one type string in
   the journal; nothing separates the customer-liability pool from the promotional pool.
5. **The diamond -> chip bridge is LIVE for owners, DEAD for players, and does not touch the Mint register.**
   `fn_mint_chips_from_diamonds` (authenticated may execute; 3 calls, 3 diamonds, 300 chips on 08-21) debits the
   owner's diamonds via `deduct_diamonds` with **no reference_id** and credits chips outside `fn_ca_mint`; `ca_mint_ledger`
   has 0 rows. The 08-19 rule ("chips can NEVER be bought with diamonds") and the 08-21 rule ("100 diamonds = 10,000
   chips at the union/club mint") coexist because they address different actors; the code matches that split.
6. **Time-bank purchase is broken in production.** The live `fn_purchase_time_banks` (replaced 08-24) inserts into a column
   `diamond_transactions.reason` that does not exist and hardcodes 2 diamonds/use while `feature_pricing` says 5. Every
   call raises 42703 and rolls back; no `purchase_time_bank` row exists in the journal.
7. **Account deletion destroys diamonds AND their history.** 77 profiles were deleted today (04:47 to 19:33 UTC, all via
   PostgREST as `postgres`, 0 horses) carrying **198,525 diamonds**; not one `diamond_transactions` burn row exists for
   them. Both FKs on `diamond_transactions` and on `diamond_purchases` are `ON DELETE CASCADE`, and
   `pages/api/auth/delete-account.js:213` deletes the user's `diamond_transactions` explicitly. The journal is not
   append-only.
8. **`profiles.diamonds` has no CHECK (>= 0)** and `reconcile_diamond_purchase_refund` writes it directly, by design
   allowing negatives.
9. **The Mint register knows nothing about diamonds in practice.** `fn_ca_mint` is registered in `ca_money_rpc_registry`;
   `fn_ca_burn` is **not**; neither has ever written `ca_mint_ledger`; both are EXECUTE-able by `authenticated` with an
   in-body admin/god gate. None of the eleven diamond sink/on-ramp RPCs is registered.
10. **Prices live in five places** (code constants in two WH routes, `feature_pricing`, `promo_vault_catalog`, a dead
    `vip_pricing` with bronze/silver/gold tiers nobody reads) and one function (`buy_streak_freeze`) hardcodes 5,000.

---

## PART A - THE PURCHASE ON-RAMP

### A.1 Which providers exist (grep, both repos, node_modules/dist/.next/public excluded)

| Term                                  | World Hub files                             | club-arena files                        | Verdict                         |
| ------------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------- |
| `stripe`                              | 50 (many are `striped` CSS)                 | 12 (all `striped`/`stripe_customer_id`) | Stripe is the provider          |
| `StoreKit`                            | 0                                           | 0                                       | No iOS IAP                      |
| `RevenueCat`                          | 0                                           | 0                                       | none                            |
| `androidpublisher` / Google Play      | 0                                           | 0                                       | No Android IAP                  |
| `diamond_purchases`                   | 19                                          | 2                                       | table used                      |
| `award_purchase_diamonds`             | 0                                           | 0                                       | dead stub (see A.4)             |
| `settle_diamond_card_purchase_atomic` | 3 (webhook + 2 migrations)                  | 0                                       | live settle RPC                 |
| `reconcile_diamond_purchase_refund`   | 5                                           | 0                                       | live refund RPC                 |
| `checkout.session.completed`          | 2                                           | 0                                       | handled                         |
| `charge.refunded`                     | 2                                           | 0                                       | handled                         |
| `charge.dispute`                      | **0**                                       | 0                                       | **not handled, not subscribed** |
| `payment_intent`                      | 8                                           | 1                                       | correlation key                 |
| `constructEvent`                      | 1 (`pages/api/store/webhooks/stripe.js:83`) | 0                                       | signature verified              |

Env variable NAMES referenced in code (values never read): `STRIPE_SECRET_KEY` (17 refs), `STRIPE_WEBHOOK_SECRET`
(2 refs), `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`. VIP price ids come from per-plan env vars resolved in
`create-checkout-session.js:116-129` (names not enumerated here).

### A.2 The webhook, `pages/api/store/webhooks/stripe.js` (1,038 lines)

- **Signature**: raw body read, `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)` at line 83; missing
  secret -> 500, missing header -> 400, bad signature -> 400. No rate limiting by design (comment at line 51).
- **Event idempotency**: lines 88-132 call `claim_stripe_webhook_event(p_event_id, p_event_type, 300)`, which is
  `INSERT ... ON CONFLICT (event_id) DO NOTHING` on `stripe_webhook_events` (PK `event_id`), with a 300s lease and
  reclaim on expiry. `state='done'` -> 200 duplicate; live lease -> 409. On handler failure the claim row is DELETED
  (line 190) so Stripe's retry can reprocess. **Design note**: a claim failure is treated as "process anyway" (line 108),
  which is the correct bias for paid events but means the guard is advisory when the DB is degraded.
- **Events handled** (lines 133-172): `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created|updated|deleted`,
  `invoice.payment_succeeded|failed`, `charge.refunded`. **Not handled**: `charge.dispute.created`,
  `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `payment_intent.*`, `refund.*`.
- **Subscribed at Stripe** (`scripts/setup-stripe-webhook.js:11-18`): 7 events; no dispute events, and the two
  `async_payment_*` events the handler supports are not in the subscription list either (UNVERIFIED whether the live
  Stripe endpoint was configured by this script or by hand).
- **Diamond settle** (`handleCheckoutCompleted`, lines 212-251): requires `mode='payment'`, `payment_status='paid'`,
  `metadata.type='diamonds'` and `metadata.purchase_id`; reads the row; short-circuits if already `refunded` for the same
  session; calls `settle_diamond_card_purchase_atomic(purchase_id, session.id, payment_intent)`; throws (-> 500 ->
  Stripe retry) if the RPC refuses.
- **Refund** (`handleRefund`, lines 789-830): correlates by `stripe_payment_intent_id` using `.maybeSingle()`; if no
  purchase row, lists Checkout Sessions for the payment intent and correlates by metadata; calls
  `reconcile_diamond_purchase_refund(purchase_id, charge.amount, charge.amount_refunded)`; throws on refusal.
  **Gap**: `.maybeSingle()` errors if two rows share a payment intent, and nothing prevents that (A.3).

### A.3 `diamond_purchases` (3 rows)

Columns: `id, user_id, package_name, diamonds_amount, bonus_diamonds, price_usd, status, stripe_checkout_session_id,
stripe_payment_intent_id, completed_at, refunded_at, created_at, updated_at, refunded_amount_cents, refunded_diamonds,
metadata`.

| id       | user     | pkg   | diamonds | usd  | status      | session       | payment_intent | completed        | metadata keys |
| -------- | -------- | ----- | -------- | ---- | ----------- | ------------- | -------------- | ---------------- | ------------- |
| fe35f19d | 47965354 | Micro | 100      | 1.00 | completed   | `cs_test_...` | NULL           | 2026-02-12 04:22 | none          |
| beb4725e | 47965354 | Micro | 100      | 1.00 | **pending** | NULL          | NULL           | never            | none          |
| b82a2fe0 | 47965354 | Micro | 100      | 1.00 | completed   | `cs_live_...` | NULL           | 2026-02-12 15:35 | none          |

- One of the two completed purchases is a **Stripe TEST-mode session** (`cs_test_`) credited as real diamonds.
- Both completed rows have **NULL `stripe_payment_intent_id`**, so `handleRefund`'s primary correlation cannot find them;
  only the sessions-list fallback could.
- The pending row from 05:03 has sat for 202 days; `handleCheckoutExpired` never closed it (UNVERIFIED why; likely the
  session was never created or the event was not delivered).
- **Indexes**: PK; `idx_diamond_purchases_user_id`; `ux_diamond_checkout_request UNIQUE (user_id, metadata->>'checkout_request_id')`.
  **There is NO unique index on `stripe_checkout_session_id` or `stripe_payment_intent_id`.** The Stripe event id is
  unique (PK on `stripe_webhook_events`), the Stripe session/payment ids are not.
- **Constraints**: `refund_progress_nonnegative CHECK (refunded_amount_cents >= 0 AND refunded_diamonds >= 0) NOT VALID`;
  FK `user_id -> auth.users ON DELETE CASCADE`; FK `user_id -> profiles ON DELETE CASCADE`. **Deleting a profile deletes
  the purchase record of a paying customer.** No `status` CHECK.
- **RLS**: enabled, one policy (`SELECT` where `auth.uid() = user_id`, role `public`). Table grants give
  `anon`/`authenticated` INSERT/UPDATE/DELETE, but with RLS on and no write policy those are blocked. Not a live hole,
  but the grant should not exist.

### A.4 Live bodies

**`award_purchase_diamonds(uuid,int,text,numeric)`** - SECURITY INVOKER, `RETURN;` stub with comment "the Stripe webhook
handler updates diamond_wallets directly". Dead. Grants: postgres, service_role.

**`claim_stripe_webhook_event` / `complete_stripe_webhook_event`** - SECURITY DEFINER, service_role only, as described in
A.2. `stripe_webhook_events` columns: `event_id, event_type, processed_at, processing_status, locked_at, completed_at`;
PK `event_id`; RLS on, 0 policies, **0 rows**.

**`settle_diamond_card_purchase_atomic(uuid,text,text)`** - SECURITY DEFINER, service_role only, 4,710 chars.
`FOR UPDATE` on the purchase; `completed` with a different session -> `settlement_conflict`, same session -> duplicate
success; `refunded` + `refund_before_settlement` -> terminal ack; otherwise requires `pending`; credits
`diamonds_amount + bonus_diamonds` through `add_diamonds_to_balance(user, total, 'purchase', ..., purchase_id::text)`
(so the journal `reference_id` is the purchase id; the `purchase` type bypasses the diamond multiplier); then runs an
optional `redemption_intent` (`club_shop` via `fn_purchase_club_shop_item_diamonds`, or `vip_daily` via
`purchase_vip_with_diamonds_atomic_v2` at a **hardcoded 150**); marks `completed` with `redemption_status`
completed / needs_review / not_requested. Correct shape: compare-and-set on status, single transaction, journaled.

**`reconcile_diamond_purchase_refund(uuid,int,int)`** - SECURITY DEFINER, service_role only, 6,639 chars. Cumulative
refund model (`GREATEST(prior, LEAST(charge, refunded))`); `pending` + full refund -> `refund_before_settlement`;
`completed` -> pro-rata target `round(total * cumulative / charge)`, delta = target - already refunded; if fully refunded
and a redemption completed, unwinds it (`fn_refund_shop_purchase`, or VIP daily minus one day and +150 via
`add_diamonds_to_balance` type `refund`), else records `debt_recorded`. **The clawback writes `profiles.diamonds`
directly** (not through `add_diamonds_to_balance`), and **deliberately allows a negative balance** (`chargeback_debt`
flag). Journals a `refund` row with reference `diamond-refund:<purchase>:<target>` (unique per target, so idempotent by
constraint on `idx_diamond_transactions_reference_id`).

**`add_diamonds_to_balance`** (the shared credit/debit primitive, service_role only): idempotent on
`(user_id, reference_id)` via lookup plus the two unique indexes on `diamond_transactions`
(`diamond_transactions_user_reference_uidx (user_id, reference_id)` and, stricter, `idx_diamond_transactions_reference_id
(reference_id)` GLOBAL); refuses `new_balance < 0`; applies `diamond_multiplier` to earn types only.

**`purchase_vip_with_diamonds_atomic` v1/v2/v3** (all SECURITY DEFINER, service_role only; `SET search_path public,
extensions`):

| version          | args                                                  | what it adds                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1 (2,848 chars) | `(user, cost, days, plan, reference_id, description)` | validates plan in (daily, monthly, annual), `FOR UPDATE` profile, debits via `add_diamonds_to_balance(-cost, 'vip_daily' or 'vip_membership', ref)`, extends `vip_expires_at`, tier rank logic |
| v2 (677)         | same                                                  | refuses `vip_tier='lifetime'`, delegates to v1                                                                                                                                                 |
| v3 (1,177)       | + `p_request_hash`                                    | advisory lock on reference, `vip_diamond_purchase_requests` (0 rows) replay table keyed by reference + sha256 request hash, delegates to v2                                                    |

**The cost is a caller argument.** `pages/api/store/purchase-vip-with-diamonds.js` derives it server-side as
`round(usd * 100)` from `VIP_MEMBERSHIP` (monthly $19.99 -> 1,999; annual $199.99 -> 19,999) with a 100..100,000 band and
calls v3; `purchase-daily-vip.js` uses 150 and calls v2; the Stripe redemption path hardcodes 150 and calls v2. The DB
does not know the price. `vip_pricing` (9 rows: bronze/silver/gold x 7/30/90 days, 100..4,800) is **read by nothing**
(0 grep hits in either repo outside the table name) and describes tiers that do not exist in code.

### A.5 Packages and prices

- Diamond packages are **code constants** in `pages/api/store/create-checkout-session.js:44-52`
  (`VALID_DIAMOND_PACKAGES`): micro 100/$1, small 500/$5, medium 1,000/$10, standard 2,500/$25, large 5,000/$50,
  value 10,000+500/$100, premium 25,000+1,250/$250, whale 50,000+2,500/$500. Mirrored by hand in club-arena
  `src/pages/marketplace/marketplaceShared.ts:279`. **No `diamond_packages` table exists** (0 tables matching
  `diamond_package|diamond_bundle|store_package`). The webhook credits `diamonds_amount + bonus_diamonds` from the
  pending row, so the row is the price oracle at settle time; the constant is the oracle at checkout time.
- Rate everywhere: 1 diamond = $0.01 (`diamond-liability.js` `USD_PER_DIAMOND = 0.01`; `purchase-vip-with-diamonds.js`
  `DIAMONDS_PER_DOLLAR = 100`). The bonus tiers (5%) break that rate for the three largest packages.
- `feature_pricing`: 69 rows, `diamond_cost` 1..600, none zero (rabbit_hunt 5, throwable 1, time_bank_seconds 5,
  club_creation 100, card backs 100..300, studio items 175..600).
- `promo_vault_catalog`: 13 rows (columns `item_key, category, label, duration_days, pack_size, tier, diamond_cost, ...`).
- `buy_streak_freeze`: `FREEZE_COST constant := 5000` in the function body; refuses any other `p_cost`.

### A.6 Questions answered

| Question                                                                              | Answer                                                                                                                                                            | Evidence                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------ | ------------------------------ |
| Is the Stripe event id enforced unique?                                               | Yes, PK on `stripe_webhook_events.event_id`, claimed before any handler                                                                                           | body of `claim_stripe_webhook_event`        |
| Is the session id / payment intent enforced unique?                                   | **No.** Only a compare-and-set inside the settle RPC                                                                                                              | `pg_indexes` on `diamond_purchases`         |
| Does a refund reverse the grant?                                                      | Yes, pro-rata, and can go negative; unwinds a club_shop or vip_daily redemption if the refund is full                                                             | body of `reconcile_diamond_purchase_refund` |
| Does a dispute reverse the grant?                                                     | **No handler exists**                                                                                                                                             | grep `charge.dispute` = 0                   |
| Does the reversal chain through what the diamonds bought AFTER the redemption intent? | No. Merch, VIP monthly, time banks, promo vault bought later with the credited diamonds are untouched; the design is "debit the balance, record debt if negative" | same body                                   |
| Provider-vs-internal reconciliation?                                                  | **None.** No cron reads Stripe balance transactions; `diamond-liability.js` is an internal liability view only                                                    | grep `balanceTransactions                   | charges.list | refunds.list` in pages/api = 0 |
| Purchased vs earned distinguishable?                                                  | Only by `diamond_transactions.type='purchase'` per row; the balance is one integer. Historic purchases have **no** such rows at all                               | query A.3 / section 0.2                     |
| Were the 3 purchases journaled?                                                       | **No.** 0 rows of type purchase/stripe_purchase; 0 rows for user 47965354 between 2026-02-12 and 02-13                                                            | `diamond_transactions` query                |

---

## PART B - OFF-RAMPS / SINKS

### B.0 What the journal says was spent (all-time, `amount < 0`, grouped by `coalesce(transaction_type,type)`)

| type              | rows | net     | last       |
| ----------------- | ---- | ------- | ---------- |
| live_gift_sent    | 11   | -160    | 2026-05-12 |
| chip_purchase     | 6    | -200    | 2026-08-19 |
| game_cost         | 6    | -60     | 2026-08-12 |
| adjustment        | 5    | -14,120 | 2026-08-23 |
| diamond_gift_sent | 5    | -10,155 | 2026-05-17 |
| pvp_stake         | 3    | -120    | 2026-08-15 |
| chip_mint         | 3    | -3      | 2026-08-21 |
| test_ref_id       | 2    | -2      | 2026-05-17 |
| feature_purchase  | 1    | -2,500  | 2026-08-23 |
| trivia_arcade     | 1    | -10     | 2026-08-06 |
| feature_unlock    | 1    | -25     | 2026-03-01 |

30-day view (570 rows): 488 `pvp_refund` (+14,240), 45 `daily_login` (+1,467), 7 `adjustment` (-13,680), 6
`chip_purchase` (-200), 5 `easter_egg`, 4 `game_cost` (-40), 4 `training_reward`, 3 `pvp_stake` (-120), 3 `chip_mint`
(-3), 1 `feature_purchase` (-2,500), 1 `trivia_arcade`, 1 `video_favorite`, 1 `trivia_run`, 1 untyped `credit` (+20,
`transaction_type` NULL). **Zero rows in 30 days for**: vip_daily, vip_membership, purchase, refund, rabbit_hunt,
throwable, streak_freeze, purchase_time_bank, burn, mint, merch. The sinks below are, with two exceptions, unused.

### B.1 Merchandise (`purchase_merch_with_diamonds_atomic`, `refund_diamond_merch_order_atomic`, `merchandise_orders`)

- Grants: both SECURITY DEFINER, `postgres, service_role` only. Caller: `pages/api/store/purchase-with-diamonds.js:242`
  (server route) and admin refund tooling (UNVERIFIED which route calls the refund RPC).
- Purchase (10,152 chars): uses `add_diamonds_to_balance` (journaled), no direct profile write, `p_purchase_reference` +
  `p_request_hash` (sha256 of lines + address) for idempotency, advisory lock. Refund (3,329 chars): refuses shipped /
  delivered / provider-submitted orders, credits `diamonds_spent - refunded_diamonds` via `add_diamonds_to_balance(...,
'refund', p_reference_id)`, restores stock via `release_merch_order`, writes `merchandise_order_events`.
- Volume: `merchandise_orders` **0 rows** all-time; 0 diamond-paid orders. Sink is built, never used.

### B.2 VIP (three RPCs, `vip_pricing`)

- See A.4. Journaled through `add_diamonds_to_balance` with types `vip_daily` / `vip_membership`. Idempotent by
  `reference_id` (v1) plus request-hash replay table (v3, 0 rows). Refund path: only the Stripe-redemption unwind in
  `reconcile_diamond_purchase_refund` (minus one day, +150); there is no general "refund a VIP diamond purchase" RPC.
- Volume: **0** `vip_daily` / `vip_membership` rows in the journal all-time. `vip_diamond_purchase_requests` 0 rows.

### B.3 Promo vault (`ca_promo_vault_buy`, `promo_vault_catalog`, `promo_vault_records`)

- SECURITY DEFINER, **EXECUTE by `authenticated`**, uses `auth.uid()` and `fn_promo_vault_can_manage(club)`. Debits
  **`club_diamond_wallets.balance`** (2 rows, both 0.00, `total_withdrawn` 0), increments `promo_vault_inventory`,
  writes `promo_vault_records` (0 rows). **Does not write `diamond_transactions`**, has **no idempotency key**, no
  refund path, no CHECK on the wallet (guarded only by `IF v_balance < v_cost` inside the function).
- Because both club wallets are 0.00 and nothing funds them (UNVERIFIED: no writer to `club_diamond_wallets.balance`
  was searched in this lane; lane 1 owns writers), the sink cannot fire today. Caller: club-arena
  `src/pages/PromoVaultPage.tsx:337`.

### B.4 Time banks (`fn_purchase_time_banks(p_quantity)`)

- SECURITY DEFINER, `SET search_path public, pg_temp`, **EXECUTE by `authenticated`**, caller `src/pages/TablePage.tsx:17934`.
- **Live body is broken.** It hardcodes `v_unit_cost INT := 2`, updates `profiles.diamonds` directly, then
  `INSERT INTO diamond_transactions (user_id, amount, reason) VALUES (...)`. `diamond_transactions` has **no `reason`
  column** (columns: `id, user_id, type, amount, balance_after, description, reference_id, created_at, transaction_type,
source, metadata`). Every call raises `42703 column "reason" does not exist` after the balance UPDATE, and the whole
  call rolls back. Net effect: **time banks cannot be bought since 2026-08-24**, no diamonds are lost, the UI shows an
  error. Not probed (lane rule); verified statically against `information_schema.columns`.
- Provenance: `20260823_fn_purchase_time_banks_balance_key.sql` documents the working version (priced from
  `feature_pricing` at 5/use, debited through `deduct_diamonds`, reference `tbank_<user>_<qty>_<ts>`), and production
  holds its proof: **one** journal row, -2,500, "Time banks x500", metadata `unit_cost: 5`, 2026-08-23 19:36 UTC, with
  `feature_purchases` rows for `time_bank_seconds` (3 rows, `cost` sum 986). `20260824_consolidate_time_banks.sql`
  then replaced it with the 2/use `reason` version; `20260826173758_secdef_functions_pin_their_search_path.sql` only
  pinned the search path. The client comment ("prices it server-side from feature_pricing") describes the 08-23
  function, not the live one.
- Price disagreement: `feature_pricing.time_bank_seconds = 5`; live function = 2.

### B.5 Throws (`fn_use_throwable`, `throw_usage.paid_diamonds`)

- SECURITY DEFINER, `authenticated`, advisory-locked per user; 500 free VIP throws/month, then club-shop pack credits
  (`feature_purchases.feature='throwable'`, 6 rows), then `deduct_diamonds(uid, 1, 'Throwable: ...', 'throwable')` with
  **no reference_id** (not idempotent; the lock prevents concurrent double-spend, not a client retry). Journaled.
- Volume: `throw_usage` 95 rows, **0 with `paid_diamonds = true`**; 0 `throwable` journal rows. Never sold a paid throw.

### B.6 Premium features (`premium_feature_access.diamonds_spent`, `feature_pricing.diamond_cost`)

- `premium_feature_access`: 1 row (`bankroll_manager`, 25 diamonds, 2026-03-01, expired 03-02); matches the single
  `feature_unlock -25` journal row. Feature grants otherwise live in `feature_purchases` (11 rows). Legacy sink.

### B.7 Rabbit hunt (`fn_reveal_rabbit_hunt`)

- SECURITY DEFINER, `authenticated`. Price read from `feature_pricing WHERE feature='rabbit_hunt'` (= **5**, the
  `rabbit_hunt_costs_five_diamonds` intent is live in data), VIP gets 100 free/month via `vip_feature_usage_monthly`,
  paid path is `deduct_diamonds(..., 'feature_purchase', 'rabbit_hunt', reference 'rabbit_<table>_<hand>_<user>')`:
  deterministic reference, idempotent by constraint. Best-shaped sink after Stripe.
- Volume: `rabbit_hunt_reveals` 1 row, charged 0. Never sold a paid hunt.

### B.8 Club shop (`fn_purchase_club_shop_item_diamonds`)

- SECURITY DEFINER, `postgres, service_role` only (browser cannot call it; the Stripe redemption path and a WH route do).
  Requires a 16..160 char `p_charge_reference`, replays from `club_shop_purchases.charge_reference`, advisory lock per
  (user, item), stock decrement, debit via `add_diamonds_to_balance(-price, 'purchase', ref)`, exception block
  converts business errors. Refund path `fn_refund_shop_purchase` (service_role).
- Volume: `club_shop_purchases` 15 rows all-time (12 in 30 days), **all `currency='chips'`**, price sum 23,410, 1 refunded.
  Zero diamond-currency shop purchases.

### B.9 Streak freeze (`buy_streak_freeze`)

- SECURITY DEFINER, `authenticated`, `p_cost` must equal constant 5,000, reference `streak_freeze:<uid>:<request_id>`
  when a request id is supplied (NULL otherwise -> not idempotent), debits via `deduct_diamonds`. Journaled.
- Volume: 0 `streak_freeze` journal rows.

### B.10 THE BRIDGE: diamonds -> chips

**Rules on record**

| date       | file                                                                    | rule                                                                                                                                                                                           | actor                                             |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 2026-08-19 | WH `supabase/migrations/20260819_forbid_diamond_to_chip_conversion.sql` | "chips can NEVER be bought with diamonds"; REVOKE ALL on `fn_purchase_chips` and `fn_purchase_club_chips` from PUBLIC, anon, authenticated, **service_role**; route returns 410                | player buying club chips                          |
| 2026-08-21 | CA `20260821_fn_mint_chips_from_diamonds.sql`                           | Dan verbatim: "UNIONS ARE WHERE ALL THE CHIPS FLOW FROM ... CONVERT DIAMONDS INTO CHIPS, 100 DIAMONDS EQUALS 10,000 CHIPS ... IF A CLUB EVER JOINS THE UNION, THEIR CHIP MINT GETS TURNED OFF" | union owner / standalone club owner issuing chips |
| 2026-08-31 | `ca_money_rpc_registry`                                                 | `fn_mint_chips_from_diamonds` and `fn_atomic_buyin` "grandfathered at phase-1 baseline"                                                                                                        | registry                                          |
| 2026-09-01 | `20260901173329_the_mint.sql`                                           | `fn_ca_mint` / `fn_ca_burn` / `ca_mint_ledger` created as "the front door"                                                                                                                     | admin                                             |

**Current state, function by function (live grants)**

| function                                             | secdef           | EXECUTE                                              | state                                                                                                                                                                                            | diamond leg                                                                                        | chip leg                                                                                                                                   | Mint register                    |
| ---------------------------------------------------- | ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `fn_purchase_chips(uuid,numeric,int,text)`           | yes              | **postgres only**                                    | DEAD (revoked 08-19)                                                                                                                                                                             | `deduct_diamonds`                                                                                  | -                                                                                                                                          | no                               |
| `fn_purchase_club_chips(uuid,uuid,numeric,int,text)` | yes              | **postgres only**                                    | DEAD                                                                                                                                                                                             | `deduct_diamonds`                                                                                  | `fn_credit_chips`                                                                                                                          | no                               |
| `fn_atomic_buyin(uuid,uuid,int,int)`                 | **no** (invoker) | postgres, service_role                               | REACHABLE, **no caller** in WH or CA (grep 0)                                                                                                                                                    | direct `UPDATE profiles SET diamonds`, journal row `chip_purchase` with no reference               | `club_members.chip_balance` + `chip_transactions 'buyin'`, ledger category `mint` vs `issuance_reserve`                                    | no                               |
| `orb1_buyin_transaction`                             | no               | service_role                                         | DEAD: body is `RAISE EXCEPTION 'deprecated'`; the only caller `pages/api/club-arena/buyin.js:115` still calls it with the wrong signature and a "38 diamonds = 100 chips (75% Cheaper Law)" rate | -                                                                                                  | -                                                                                                                                          | no                               |
| `fn_mint_chips_from_diamonds(uuid,numeric,uuid)`     | yes              | **authenticated**, service_role                      | **LIVE**                                                                                                                                                                                         | `deduct_diamonds(actor, n, ..., 'chip_mint', 'chip_mint', metadata{op_id}, **reference NULL**, 0)` | union: `union_wallets.chip_balance += n*100`; standalone: `clubs.chip_treasury += n*100`; `chip_transactions 'mint'` with `metadata.op_id` | **no** (`ca_mint_ledger` 0 rows) |
| `mint_club_chips(uuid,numeric,uuid,numeric,text)`    | no               | service_role                                         | reachable from `pages/api/club-arena/mint-chips.js:247` fallback                                                                                                                                 | UNVERIFIED (body head references diamonds_cost as a parameter only)                                | `clubs.chip_pool`                                                                                                                          | no                               |
| `fn_ca_mint` / `fn_ca_burn`                          | yes              | authenticated (admin/god gate in body), service_role | live, never used                                                                                                                                                                                 | `profiles.diamonds` +/- with journal `mint`/`burn`, `source='the_mint'`, op_id in metadata         | `chip_treasury` / `union_wallets` with `chip_ledger` declaration                                                                           | **yes**, writes `ca_mint_ledger` |

**Answers**

- **Is the bridge live?** Yes for issuers (union owner/admin into the union bank; standalone owner/co-owner/admin into
  `clubs.chip_treasury`), through `fn_mint_chips_from_diamonds` from the browser (`ChipMintModal.tsx:229`) and from
  `pages/api/club-arena/mint-chips.js:204` (caller-JWT client). Dead for players: both player conversion functions are
  revoked from every application role, `/api/club-arena/buyin` raises in the DB, and `marketplaceShared.ts:10-11`
  says the conversion UI was removed 2026-08-19. The two rules do not contradict each other in code.
- **Is a diamond burned when chips are minted?** The diamond is **debited from the owner's `profiles.diamonds` with no
  counterparty**: it leaves circulation, journaled as `chip_mint -1` (3 rows, 08-21, all 1-diamond test mints). It is
  not a `burn` in `ca_mint_ledger`, so `fn_ca_mint_supply('diamonds')` (= sum of that register = 0) does not see it.
  Supply accounting for diamonds therefore cannot reconcile mints against burns: the burn side is in
  `diamond_transactions.chip_mint`, the mint side (Stripe) is in nothing.
- **Does it go through `fn_ca_mint` / `fn_ca_burn`?** No. Neither the chip issuance nor the diamond retirement touches
  the Mint RPCs. The chip side declares `app.ledger_category` for the `chip_ledger` trigger (fn_atomic_buyin) or writes
  `chip_transactions 'mint'` (fn_mint_chips_from_diamonds) but never `ca_mint_ledger`.
- **Idempotency**: chip side keyed on `chip_transactions.metadata->>'op_id'` (plus advisory lock); diamond side has
  **no reference_id**, so a replay that finds the chip row returns `replayed: true` without re-debiting (correct), but
  a crash between the debit and the chip insert rolls back atomically (same transaction), so the pair is safe. The
  concern is only that the diamond journal row cannot be matched to the op by constraint, only by `metadata.op_id`.
- **Rate**: 1 diamond = 100 chips in code (`v_chips := v_diamonds * 100`), matching "100 diamonds = 10,000 chips". At
  $0.01/diamond that prices a chip at $0.0001. `mint-chips.js:194` agrees (`1/100`). `buyin.js:109` disagrees (38 per
  100 chips) but is dead.
- **Volume**: 3 mints, 3 diamonds, 300 chips, all 2026-08-21 (two by the union owner on club a41434bb and one on club
  a0000000, all into union fade0000). 6 `chip_purchase` rows (-200 diamonds) on 2026-08-19 by the same user are the
  last player-level conversions before the revoke.

### B.11 Account deletion (`ca_profile_deletions`, `fn_ca_journal_profile_deletion`)

- Trigger `trg_ca_profile_deletion_journal` (BEFORE DELETE on `profiles`) -> `fn_ca_journal_profile_deletion` (service_role
  grant, SECURITY DEFINER): inserts `(profile_id, username, is_horse, diamonds, diamond_balance, profile_created_at)` into
  `ca_profile_deletions`, swallowing errors with a WARNING. It **records**; it does not burn, does not write
  `diamond_transactions`, does not write `ca_mint_ledger`.
- Data: **77 rows**, all 2026-09-02 (04:47:33 to 19:33:48 UTC), `application_name = 'PostgREST 14.5'`,
  `deleted_by_role = 'postgres'` (service-role API), **0 horses**, **38 with diamonds > 0, total 198,525 diamonds, max
  18,125** in one account. **0** `diamond_transactions` rows of any burn/deletion type exist.
- **The journal is not append-only under deletion.** `diamond_transactions` has two FKs `ON DELETE CASCADE` (to
  `auth.users` and to `profiles`), so the deleted accounts' entire history left with them (row count lost: UNKNOWN,
  unrecoverable from the table). `pages/api/auth/delete-account.js:212-213` additionally deletes
  `diamond_transactions` by `user_id` explicitly ("Remove diamond transactions") and `user_diamond_balance` at line 207.
  `diamond_purchases` cascades too, so a paying customer's Stripe purchase record is deleted with the account
  (Stripe still has it; the platform does not).
- UNVERIFIED: whether the 77 deletions were the delete-account route or a bulk cleanup script; `application_name`
  cannot distinguish them.

### B.12 Grants summary for the sinks (who can execute)

| RPC                                                                     | authenticated        | service_role | registered in `ca_money_rpc_registry` |
| ----------------------------------------------------------------------- | -------------------- | ------------ | ------------------------------------- |
| settle_diamond_card_purchase_atomic                                     | no                   | yes          | no                                    |
| reconcile_diamond_purchase_refund                                       | no                   | yes          | no                                    |
| add_diamonds_to_balance                                                 | no                   | yes          | no                                    |
| deduct_diamonds                                                         | no                   | yes          | no                                    |
| purchase_vip_with_diamonds_atomic v1/v2/v3                              | no                   | yes          | no                                    |
| purchase_merch_with_diamonds_atomic / refund_diamond_merch_order_atomic | no                   | yes          | no                                    |
| fn_purchase_club_shop_item_diamonds                                     | no                   | yes          | no                                    |
| ca_promo_vault_buy                                                      | **yes**              | yes          | no                                    |
| fn_purchase_time_banks                                                  | **yes**              | yes          | no                                    |
| fn_use_throwable                                                        | **yes**              | yes          | no                                    |
| fn_reveal_rabbit_hunt                                                   | **yes**              | yes          | no                                    |
| buy_streak_freeze                                                       | **yes**              | yes          | no                                    |
| fn_mint_chips_from_diamonds                                             | **yes**              | yes          | yes (grandfathered)                   |
| fn_atomic_buyin                                                         | no                   | yes          | yes (grandfathered)                   |
| fn_ca_mint                                                              | yes (admin/god gate) | yes          | yes                                   |
| fn_ca_burn                                                              | yes (admin/god gate) | yes          | **no**                                |
| fn_ca_mint_supply                                                       | no                   | yes          | n/a                                   |

---

## PART C - THE MINT FOR DIAMONDS

- **`fn_ca_mint(asset, destination, target, amount, reason, op_id)`** (6,499 chars) and **`fn_ca_burn(asset, source,
target, amount, reason, op_id)`** (6,833 chars): SECURITY DEFINER, `search_path public, pg_temp`; refuse unless
  `auth.role() = 'service_role'` or `profiles.role IN ('admin','god')`; diamonds may only be minted to / burned from a
  `player`; whole numbers; reason >= 10 chars; op_id required and claimed in `ca_op_claims` (replay returns the stored
  result); advisory lock `ca_mint_ledger:<asset>`; diamonds path writes `profiles.diamonds` directly (**not** via
  `add_diamonds_to_balance`) and a `diamond_transactions` row (`type earn/spend`, `transaction_type mint/burn`,
  `source the_mint`, metadata op_id, **no reference_id**), then a `ca_mint_ledger` row with `supply_after`. Burn refuses
  below zero. Caps: 1e7 diamonds per call.
- **`fn_ca_mint_supply(asset)`**: `SUM(mint) - SUM(burn)` over `ca_mint_ledger`; service_role only; returns **0** for
  diamonds because the register has **0 rows**.
- **`ca_mint_ledger`**: 0 rows; RLS on, 1 policy.
- **`ca_money_rpc_registry`** (249 rows; columns `proname, status, notes, added_at`): rows mentioning diamonds are
  exactly two, `fn_mint_chips_from_diamonds` and `fn_ca_mint`. `fn_ca_burn` is **absent**. `fn_atomic_buyin` is present.
  No other diamond writer (A.4, B.1-B.9) is registered; the registry was built for chips and its guard (UNVERIFIED which
  trigger consumes it) does not cover diamond writers.
- **Executable by `authenticated`**: both `fn_ca_mint` and `fn_ca_burn` carry `authenticated=X`; the body gate is the
  only thing between a logged-in player and issuance. A `profiles.role` column write by any other path would open it.
  (Lane 1 owns `profiles.role` write paths.)
- **No diamond issuance has ever gone through the Mint.** The three doors that have created diamonds are Stripe
  (`add_diamonds_to_balance 'purchase'`, 0 journal rows historically), the earn engines (lane 3) and `adjustment`
  (7 rows, -13,680 in 30 days). The register cannot reconcile a supply it never saw.

---

## PART D - INDUSTRY RESEARCH: what a closed-loop purchased currency is held to

### D.1 What the sources say

**Accounting (ASC 606 / IFRS 15)**

- Playtika (NASDAQ: PLTK), FY2025 10-K: payments for virtual items "are required at the time of purchase, are
  non-refundable ... cannot be redeemed for cash nor exchanged for anything other than virtual items within the games";
  "Deferred revenues, which represent a contract liability, represent mostly unrecognized fees billed for virtual items
  which have not yet been consumed at the balance sheet date"; the performance obligation is to display the item "over
  the estimated life of the paying player" ([SEC 10-K FY2025](https://www.sec.gov/Archives/edgar/data/1828016/000182801626000010/playtika-20251231.htm)).
- Deloitte, "Recognizing Revenue From Sales in a Virtual World": revenue for virtual currency/goods depends on whether
  the good is consumable (recognized on consumption) or durable (over the estimated player life); breakage on unused
  currency is recognized in proportion to the pattern of consumption, and the estimate must be updated
  ([IAS Plus](https://iasplus.com/content/77789247-efc2-4236-ace1-bfdfb95e1f57)).
- RevenueHub, "Common ASC 606 Issues: Gaming Entities" and "Unexercised Rights (Breakage)": players buy in-game currency
  in pre-set increments; "chips and tokens in possession of customers represent potential breakage"; expected breakage is
  recognized in proportion to the pattern of rights exercised, never on sale
  ([gaming entities](https://www.revenuehub.org/article/common-asc-606-issues-gaming-entities),
  [breakage](https://www.revenuehub.org/article/unexercised-rights)).
- BDO, Revenue Recognition Under ASC 606 Blueprint (Oct 2025): variable consideration, breakage, and the requirement
  that a contract liability be measured at the transaction price of the unfulfilled obligation
  ([BDO](https://arch.bdo.com/getContentAsset/118430f1-fe4d-4112-adf6-884d6a0347f3/bb620d56-5e9c-4774-8d17-fb9323eefdf4/Revenue-Recognition-Under-ASC-606-BDO-Blueprint-10-2025.pdf?language=en)).

**Money transmission / sweepstakes**

- FinCEN 2013 guidance (FIN-2013-G001): a "user" of virtual currency is not an MSB; an "administrator" (issues AND
  redeems) or "exchanger" is a money transmitter unless exempt. Closed-loop prepaid access redeemable only with the
  issuer for goods/services is outside prepaid-access program rules under $2,000/day
  ([FinCEN guidance](https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-persons-administering),
  [prepaid access final rule](https://www.fincen.gov/resources/statutes-regulations/guidance/final-rule-definitions-and-other-regulations-relating),
  [Wilson Sonsini on gaming companies as inadvertent MSBs](https://www.wsgr.com/en/insights/how-gaming-companies-can-become-inadvertent-money-services-businesses.html)).
- California DFPI, Stored Value - Closed Loop opinion: closed-loop stored value redeemable only for the issuer's goods is
  not money transmission ([DFPI](https://dfpi.ca.gov/wp-content/uploads/sites/337/2019/07/6-25-19-Stored-Value-%E2%80%93-Closed-Loop.pdf)).
- Sweepstakes casino bans 2025-2026: Montana (eff. 2025-10-01) classifies "any form of currency, including virtual
  coins and dual-currency structures, for play and redemption" as illegal gambling; New York's ban took effect
  2025-12-05 after the AG's cease-and-desist letters of 2025-06-06; California AB 831 effective 2026-01-01; Connecticut,
  Nevada, Michigan, Washington also prohibit; Idaho prohibits redemptions
  ([Reed Smith on NY](https://www.reedsmith.com/articles/new-york-enacts-law-prohibiting-sweepstakes-casinos/),
  [NY AG letters](https://ag.ny.gov/sites/default/files/letters/sweepstakes-casinos-letters-letters-2025.pdf),
  [state guide](https://www.concordp2c.com/sweepstakes-casino-laws-by-state)). The trigger in every statute is
  **redemption for value**; a currency that can only be consumed in-platform stays on the social-casino side of the line.

**App stores**

- Apple App Review Guideline 3.1.1: digital goods consumed in-app must use IAP; a restore mechanism is required for
  non-consumables and subscriptions (not consumables); cross-platform consumables may be honoured only if also sold as IAP
  ([guidelines](https://developer.apple.com/app-store/review/guidelines/)). App Store Server API: Send Consumption
  Information informs Apple's refund decisions; App Store Server Notifications V2 `REFUND` covers consumables, with
  `revocationDate`, `originalTransactionId`, `revocationReason`; Get Refund History lists refunded transactions; signed
  JWS transactions are verified server-side
  ([handling refund notifications](https://developer.apple.com/documentation/storekit/handling-refund-notifications),
  [notificationType](https://developer.apple.com/documentation/AppStoreServerNotifications/notificationType),
  [In-App Purchase](https://developer.apple.com/in-app-purchase/)).
- Google Play Billing: consumables are consumed (`consumeAsync` / server `purchases.products:consume`) which
  acknowledges them; **unacknowledged purchases are auto-refunded after three days** and the entitlement revoked; verify
  with `purchases.products:get` (`consumptionState`, `purchaseState`); Voided Purchases API for refunds/chargebacks
  ([integrate](https://developer.android.com/google/play/billing/integrate),
  [RevenueCat on Play edge cases](https://www.revenuecat.com/blog/engineering/google-play-edge-cases/),
  [codelab](https://codelabs.developers.google.com/maximise-your-play-billing-integration)).

**Stripe**

- Webhooks: verify `stripe-signature` against the raw body with the SDK; Stripe delivers at-least-once and retries with
  backoff for up to 72 hours, so store every `event.id` under a UNIQUE constraint and short-circuit; respond within 10 s
  or the delivery is marked failed; process asynchronously; return 2xx only after durable state is written
  ([Hookray best practices](https://hookray.com/blog/stripe-webhook-best-practices-2026),
  [Hooklistener security guide](https://www.hooklistener.com/learn/stripe-webhook-security-guide),
  [dev.to signature + idempotency](https://dev.to/whoffagents/stripe-webhook-security-signature-verification-idempotency-and-local-testing-1lk3)).
- Disputes: `charge.dispute.created` fires on every chargeback; the merchant has 7 to 21 days to submit evidence or loses
  by default; funds are withdrawn at creation (`charge.dispute.funds_withdrawn`) and only returned on a win
  ([Stripe disputes](https://docs.stripe.com/disputes), [responding](https://docs.stripe.com/disputes/responding),
  [dispute API](https://docs.stripe.com/api/disputes)).
- Reconciliation: the Balance report and the Payout reconciliation report match every payout to its underlying charges,
  refunds, disputes and fees; custom pipelines list balance transactions by `payout`
  ([payout reconciliation](https://docs.stripe.com/reports/payout-reconciliation),
  [balance report](https://docs.stripe.com/reports/balance),
  [reporting and reconciliation](https://docs.stripe.com/plan-integration/get-started/reporting-reconciliation)).

**Gaming regulators (carried over from the chip lane, still applicable)**

- NJ N.J.A.C. 13:69O-1.3: adjustments above $500 need supervisory authorization before entry; every adjustment needs
  documented patron notification; segregated account >= cashable balances + funds on game + pending withdrawals
  ([LII](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-3)).
- NJ 13:69O-1.9: a daily Patron Account Adjustments Report reviewed daily; variance reports; **non-cashable promotional
  balances reported separately from cashable** ([LII](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-9)).
- GLI-19 v3.0: no wager that would cause a negative balance; theoretical-vs-actual comparison with logged escalation
  ([gamingcompliance.io](https://gamingcompliance.io/gli-19-v3-0-what-every-online-casino-game-must-meet-to-pass-certification/)).

### D.2 Principles for a purchased, closed-loop currency (for `docs/DIAMOND-ACCOUNTING-STANDARD.md`)

| #   | Principle                                                                                                                                                                                                                                                                                                 | Source                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | **Purchased diamonds are a customer liability (deferred revenue) until consumed.** Cash in, liability up; the liability is released only by a consumption event (a sink), never by the sale itself.                                                                                                       | Playtika 10-K; Deloitte virtual world; ASC 606                                         |
| D2  | **Purchased and promotional balances are separate pools** with separate ledgers and separate reports, even if the player sees one number. Regulators report non-cashable promo separately; accountants value them differently (promo is a marketing cost, not a liability at price).                      | NJ 13:69O-1.9; ASC 606 material rights                                                 |
| D3  | **Consumption is classified consumable vs durable at the sink.** A time bank or rabbit hunt is consumed on use; a card back or theme is durable and released over the expected player life. Every sink row carries its class.                                                                             | Deloitte; RevenueHub gaming                                                            |
| D4  | **Breakage is estimated and recognized in proportion to consumption, never on sale, and the estimate is re-measured.** Requires an aging of purchased balances by cohort.                                                                                                                                 | RevenueHub breakage; BDO Blueprint                                                     |
| D5  | **Closed loop is a hard property, enforced by absence of code.** No RPC may credit fiat, chips redeemable for fiat, or any transferable store of value from diamonds. Redemption for value converts the operator into an MSB / administrator and into the sweepstakes statutes' definition of gambling.   | FinCEN 2013; DFPI closed-loop; MT/NY/CA 2025 bans                                      |
| D6  | **Player-to-player transfer of purchased value is redemption by proxy.** If sends exist, they are capped, logged, promo-only or clawback-able, and never available from purchased balance without a policy decision by Dan. (Lane 1 owns `send_wallet_diamond_transfer`.)                                 | FinCEN exchanger definition; sweepstakes dual-currency rulings                         |
| D7  | **Provider event id is claimed under a UNIQUE constraint before any side effect; provider order ids (session, payment intent, transaction id) are UNIQUE on the purchase record.** Idempotency by constraint, not by lookup.                                                                              | Stripe webhook practice; GLI-19                                                        |
| D8  | **Every provider signal is verified server-side**: Stripe signature over raw body; Apple JWS transaction verification or App Store Server API; Google `purchases.products:get`. Client receipts are never trusted.                                                                                        | Stripe docs; Apple StoreKit 2; Google Play Billing                                     |
| D9  | **A refund, chargeback, dispute or voided purchase reverses the grant in the same unit of account**, journaled as its own row with the provider reference, and the reversal chains through anything the grant already bought where the platform can (revoke the item) and records a debt where it cannot. | Apple REFUND; Google voided purchases; Stripe `charge.refunded` and `charge.dispute.*` |
| D10 | **Disputes are handled, not just refunds.** `charge.dispute.created` freezes the purchased grant (or claws it back) and opens an evidence task with a deadline; `funds_withdrawn` / `closed` are journaled. Losing by silence is a money defect.                                                          | Stripe disputes                                                                        |
| D11 | **Provider-vs-ledger reconciliation runs daily**: every settled charge, refund, dispute and fee in the provider's balance report matches exactly one purchase/reversal row; unmatched items are incidents.                                                                                                | Stripe payout reconciliation; NJ 1.9 daily reports                                     |
| D12 | **Store-mandated behaviour is honoured in the ledger**: Google's 3-day acknowledgement (consume server-side on grant), Apple's consumption information on refund requests, Apple/Google no-real-money-redemption.                                                                                         | Google Play Billing; Apple 3.1.1                                                       |
| D13 | **No negative balance, ever, by constraint.** A chargeback that exceeds the balance is a receivable row (`diamond_debts`), not a negative integer on the player.                                                                                                                                          | GLI-19; NJ 1.3                                                                         |
| D14 | **Double entry with both sides named.** A purchase is `stripe_clearing -> player`; a sink is `player -> revenue:<sink>`; a bridge mint is `player -> chip_issuance_reserve`; a burn is `player -> retired`. Suspense is zero at every close.                                                              | chip standard S3/S9; ASC 606                                                           |
| D15 | **Append-only journal, including under account deletion.** Deleting a profile burns the balance through the Mint (journaled), anonymizes the journal rows, and never cascades them away. Purchase records survive deletion for the tax/chargeback window.                                                 | NJ 1.9 retention; ASC 606 audit trail; Stripe dispute window                           |
| D16 | **One price oracle per sink, in the database, read by the function that debits.** The caller never names its own price; a client-supplied cost is compared, not trusted.                                                                                                                                  | Apple/Google server-side pricing; internal (A.5 drift)                                 |
| D17 | **One issuer register for diamonds.** Every grant from a provider, every promotional issuance, every burn (bridge, deletion, admin) is a row in `ca_mint_ledger` (or a diamond-specific twin) with `supply_after`; ISSUED - RETIRED = sum of all player balances at every trial balance.                  | chip standard P1/S17; GLI-19 theoretical-vs-actual                                     |
| D18 | **Four-eyes on admin issuance and adjustments over a threshold; patron notification on every adjustment.**                                                                                                                                                                                                | NJ 13:69O-1.3                                                                          |
| D19 | **Daily trial balance**: purchased liability pool + promo pool = sum(profiles.diamonds) + debts; Stripe net receipts (minus refunds/disputes) = purchased issuance; deviations logged with escalation.                                                                                                    | NJ 1.9; GLI-19                                                                         |
| D20 | **The bridge is issuance and belongs to the Mint.** Chips created from diamonds are minted through `fn_ca_mint` against the diamonds retired through `fn_ca_burn` in one transaction, with one op_id on both rows, at one rate stored in one place.                                                       | chip standard P1; internal (B.10)                                                      |

---

## PART E - GAP LIST vs the principles (numbers from this audit)

| #   | Gap                                                                                                                                                                                                                                                                                           | Principle   | Evidence             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------- |
| G1  | Purchased and earned diamonds share one column and one journal; **0 journal rows exist for the 300 purchased diamonds**; no liability pool can be computed                                                                                                                                    | D1, D2      | A.6                  |
| G2  | **No dispute handling** (0 grep hits, not subscribed); refund handler correlates by a nullable, non-unique `stripe_payment_intent_id` that is **NULL on both completed purchases**                                                                                                            | D7, D9, D10 | A.2, A.3             |
| G3  | **No provider reconciliation** of any kind; `stripe_webhook_events` 0 rows; `diamond-liability.js` is internal-only                                                                                                                                                                           | D11, D19    | A.6                  |
| G4  | `stripe_checkout_session_id` / `stripe_payment_intent_id` not UNIQUE; one completed purchase is a **test-mode session** credited as live diamonds; one `pending` row open 202 days                                                                                                            | D7          | A.3                  |
| G5  | `profiles.diamonds` has **no CHECK (>= 0)**; refund path writes negatives by design                                                                                                                                                                                                           | D13         | A.3 constraints, A.4 |
| G6  | **Account deletion**: 77 deletions today, 198,525 diamonds, **0 burn rows**; `diamond_transactions` and `diamond_purchases` cascade on delete; `delete-account.js:213` deletes the journal explicitly                                                                                         | D15, D17    | B.11                 |
| G7  | **Bridge bypasses the Mint**: `fn_mint_chips_from_diamonds` debits with no reference_id and credits chips outside `fn_ca_mint`; `ca_mint_ledger` 0 rows; `fn_ca_burn` unregistered                                                                                                            | D17, D20    | B.10, C              |
| G8  | **`fn_purchase_time_banks` is broken** (nonexistent `reason` column, hardcoded 2 vs `feature_pricing` 5); every purchase fails since 08-24                                                                                                                                                    | D16         | B.4                  |
| G9  | Prices in five places; `vip_pricing` dead with wrong tiers; VIP cost is a caller argument; `buy_streak_freeze` hardcodes 5,000; redemption hardcodes 150                                                                                                                                      | D16         | A.5                  |
| G10 | `ca_promo_vault_buy`: authenticated-executable, debits `club_diamond_wallets` (both 0.00), **no journal row, no idempotency key, no refund**                                                                                                                                                  | D7, D14     | B.3                  |
| G11 | `fn_use_throwable` and `fn_mint_chips_from_diamonds` debit with **no reference_id**; `buy_streak_freeze` only when the client sends one                                                                                                                                                       | D7          | B.5, B.9, B.10       |
| G12 | Eleven diamond-writing RPCs unregistered in `ca_money_rpc_registry`; `fn_ca_mint`/`fn_ca_burn` executable by `authenticated` behind a body gate                                                                                                                                               | D17, D18    | B.12, C              |
| G13 | Dead/contradictory code left reachable: `/api/club-arena/buyin` with a "38 diamonds = 100 chips" rate calling a function that raises; `fn_atomic_buyin` executable by service_role with no caller; `award_purchase_diamonds` stub; `anon`/`authenticated` table grants on `diamond_purchases` | D5, D16     | B.10, A.3            |
| G14 | No consumable/durable classification on sink rows; no purchased-balance aging; breakage cannot be estimated                                                                                                                                                                                   | D3, D4      | B.0                  |
| G15 | No mobile IAP path exists; if one is added it must land on the same settle RPC with the store's transaction id as the unique key and the 3-day Google acknowledgement handled server-side                                                                                                     | D8, D12     | A.1                  |

### What is NOT a gap (so nobody "fixes" it)

- The Stripe webhook's signature check, event-id claim, compare-and-set settle and pro-rata refund are correct and
  should be the template for every other on-ramp.
- The 08-19 "no player conversion" rule and the 08-21 "owner mint at 1:100" rule are consistent in code; the bridge
  being live for owners is Dan's design, not drift. What is missing is the Mint register underneath it (G7).
- `add_diamonds_to_balance` and `deduct_diamonds` are sound primitives (row lock, non-negative check, journal in the
  same transaction, idempotent when given a reference). The defects are in callers that bypass them or omit the
  reference.

### Decisions that are Dan's

1. Whether purchased diamonds may ever be sent player-to-player (D6) or minted into chips by a player (the 08-19 rule).
2. Whether a chargeback that exceeds the balance becomes a debt row (D13) or is written off.
3. Whether deleted accounts' balances are burned (D15) or escheated to a platform account, and the journal retention
   period after deletion.
4. Whether the test-mode purchase `fe35f19d` (100 diamonds) is reversed.
5. The bridge rate (1 diamond = 100 chips = $0.0001/chip) and whether it belongs in a table rather than a function body.

## Appendix - queries and greps run (for reproduction)

- `information_schema.columns` for `diamond_purchases`, `diamond_transactions`, `stripe_webhook_events`,
  `feature_pricing`, `promo_vault_catalog`, `promo_vault_records`, `feature_purchases`, `ca_profile_deletions`.
- `pg_indexes`, `pg_constraint`, `pg_policies`, `role_table_grants`, `pg_class.relrowsecurity` for the tables above.
- `pg_proc` identity/prosecdef/proacl/length(prosrc)/proconfig for 29 functions; `pg_get_functiondef` for 19 of them
  (settle, reconcile, add_diamonds_to_balance, deduct_diamonds, award_purchase_diamonds, claim/complete webhook, VIP
  v1/v2/v3, merch refund, promo vault buy, time banks, club shop, streak freeze, rabbit hunt, throwable,
  fn_mint_chips_from_diamonds, fn_atomic_buyin, fn_ca_mint, fn_ca_burn) plus regex probes of `purchase_merch_with_diamonds_atomic`.
- Counts: 16 tables; `diamond_transactions` grouped by type (30-day and all-time negative); `ca_profile_deletions`
  grouped by application_name/role; `ca_money_rpc_registry` filtered by name.
- Greps: provider terms x13 in WH (`pages src lib scripts supabase`) and x15 in CA (`src server/src supabase`); WH
  `pages/api` files mentioning "diamond" (70 files, ranked); callers of every RPC named above; migrations
  `20260819_forbid_diamond_to_chip_conversion.sql` (WH), `20260820_revoke_chip_minting_rpcs.sql`,
  `20260821_fn_mint_chips_from_diamonds.sql`, `20260823_fn_purchase_time_banks_balance_key.sql`,
  `20260824_consolidate_time_banks.sql`, `20260827214020_close_browser_chip_minting_and_privilege_escalation.sql` (CA).
