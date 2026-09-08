# 2026-09-08 - In-app purchases settle through the one idempotent path (store readiness, phase 3a)

Audit tier 0: "Replace external Stripe Checkout with StoreKit and Play Billing.
Diamonds are a consumable; VIP monthly and annual are auto-renewing
subscriptions ... Apple 3.1.1 and Play's Payments policy require the
platform's own billing. RevenueCat runs one integration across both."

This is the database and server half. The client half (the purchase sheet in
the app, replacing `window.location.assign(stripeUrl)` on native) is phase 3b,
on the branch after phase 2's auth work merges, because it touches the same
marketplace files. The web keeps Stripe, unchanged.

## What was built, and the rule it follows

10.9 and 10.12 say the same thing about money: one live path, atomic,
idempotent, no second mechanism beside it. So an in-app purchase does not get
its own crediting code. It gets a `diamond_purchases` row and is settled by
`settle_diamond_card_purchase_atomic` - the function every Stripe purchase
settles through - with `iap:<store transaction>` where Stripe's session id
would go. `add_diamonds_to_balance` keyed by the purchase id, the purchase lot,
DR7/DR8 incidents: all of it runs unchanged and unaware which store paid.

Migration `20260908000009_in_app_purchases_settle_through_the_same_idempotent_diamond_.sql`,
applied to production 2026-09-08:

- `iap_products` - what each store product id means; seeded from
  `diamond_packages` (8 packs) plus VIP monthly 9.99 / yearly 99.99 by one
  rule, `poker.smarter.clubarena.<kind>.<key>`, that `src/lib/iapProducts.ts`
  derives identically. Readable by `authenticated`.
- `iap_events` - one row per RevenueCat event, keyed by its event id. A replay
  returns its stored result and moves nothing. Service role only.
- a unique index on `diamond_purchases (metadata->>'iap_transaction_id')`, so
  one store transaction is one purchase row whatever the webhook does.
- `fn_iap_settle_event(p_event)` - service role only (revoked from anon and
  authenticated, and it asks `auth.role()` too). Diamonds: as above. VIP
  (INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE): the Stripe
  webhook's rules in intent - lifetime is never downgraded, a longer prepaid
  expiry on a higher tier is never shortened - applied to `profiles`, with
  `vip_subscriptions` kept in step under `iap:<original transaction>`.
  CANCELLATION marks `cancel_at_period_end` (access runs to the paid-through
  date, as the stores require); EXPIRATION ends it and clears `is_vip` unless
  something else still covers the player; BILLING_ISSUE marks `past_due`.
  A refunded diamond purchase is NOT clawed back (10.9 rule 3; the store has
  already refunded the customer) - it files `IAP:diamond_refund_received` so a
  human looks. A SANDBOX event settles (App Review buys diamonds and must get
  them) and files `IAP:sandbox_event_settled`, exactly as DR7 logs a Stripe
  test-mode session.

World Hub: `POST /api/store/webhooks/revenuecat`
(`pages/api/store/webhooks/revenuecat.js`, logic in
`src/lib/store/revenuecatWebhook.js`, branch `feat/revenuecat-webhook`).
Constant-time check of `REVENUECAT_WEBHOOK_AUTH` (unset refuses with 503,
never "accept everything"), shapes the event to strings, calls the RPC with the
service role. 200 on success and on terminal answers (`unknown_user`,
`unknown_product` - a retry cannot change them), 500 otherwise so RevenueCat
retries. `__tests__/revenuecat-webhook.test.mjs` in the build safety gate.

## Proved before it was trusted (11.5, one self-aborting DO block)

Against production, rolled back by its own RAISE, on the service identity's
profile (705 diamonds):

| step                                                                   | result                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| NON_RENEWING_PURCHASE micro, event `probe-evt-1`                       | 705 -> 805, `duplicate:false`                          |
| the same event id again                                                | `duplicate:true`, balance 805                          |
| a NEW event id, the SAME transaction (RevenueCat retries with new ids) | settlement `duplicate:true`, balance 805               |
| unknown product id                                                     | `unknown_product`, `IAP:unknown_product` filed         |
| VIP monthly INITIAL_PURCHASE on a lifetime profile                     | tier stays `lifetime`, `vip_subscriptions` row written |
| EXPIRATION on that profile                                             | `is_vip` stays true, `other_coverage_still_active`     |

After the rollback: `iap_events` 0 rows, 0 iap purchase rows, 705 diamonds.

## Found on the way, not changed

`pages/api/store/webhooks/stripe.js` calls `reconcile_diamond_purchase_refund`
in its refund handler. That function does not exist in this database (checked
2026-09-08). The Stripe refund path is therefore a thrown error today. Recorded
here and in the World Hub audit note; it is a separate fix.

## Dan's, to make it live

- Create the RevenueCat project; add the iOS app (bundle id
  `poker.smarter.clubarena`) and the Android app; create the ten products in
  App Store Connect and the Play Console with EXACTLY the ids in
  `iap_products` (`select product_id from iap_products`), and attach them in
  RevenueCat.
- RevenueCat > Integrations > Webhooks: URL
  `https://smarter.poker/api/store/webhooks/revenuecat`, an Authorization
  value of 16+ characters; the same value in Vercel as
  `REVENUECAT_WEBHOOK_AUTH`.
- The RevenueCat public SDK keys for iOS and Android go to the Club Arena
  native build as `VITE_REVENUECAT_IOS_KEY` / `VITE_REVENUECAT_ANDROID_KEY`
  (public keys by design; phase 3b reads them).

## Pinned

`tests/unit/iapProducts.test.ts`: the naming rule both halves share; the
migration seeds it; diamonds settle only through
`settle_diamond_card_purchase_atomic`; idempotent on event id; unique per
transaction; service-role only; refunds never claw back.
