# VIP is Monthly, Yearly or Lifetime (Club Arena side)

2026-09-05

Dan: **"We don't sell bronze silver or gold, just vip, monthly, yearly or
lifetime, add lifetime for $499."**

The storefront and the source of truth are in the World Hub
(`fix/vip-monthly-yearly-lifetime` there). This is the database migration those
changes need, plus Club Arena's own Membership tab.

## The migration, `20260905153833`

Four vocabularies described the same thing and none agreed:

```
profiles.vip_tier              'lifetime' | 'monthly' | null      the truth
purchase_vip_with_diamonds_..  'daily' | 'monthly' | 'annual'     the seller
vip_subscriptions.tier CHECK   'monthly' | 'annual'               the Stripe row
vip_pricing.tier               'bronze' | 'silver' | 'gold'       nine dead rows
```

All four are now monthly / yearly / lifetime.

- The CHECK on `vip_subscriptions.tier` accepted neither `yearly` nor
  `lifetime`, so the Stripe webhook's unconditional write would have thrown and
  Stripe would have retried forever. Free to widen: the table is empty.
- `purchase_vip_with_diamonds_atomic` rejected any plan outside
  `('daily','monthly','annual')` **and demanded `p_days > 0`**, so a lifetime
  purchase had no way to say "forever". It takes the three terms now, ignores
  `p_days` for lifetime, and writes `vip_tier = 'lifetime'` with a **NULL**
  expiry - not a distant one. `expire_lapsed_vip` is guarded twice
  (`vip_expires_at IS NOT NULL` and `vip_tier <> 'lifetime'`) and NULL
  satisfies the first on its own.
- `vip_pricing`'s nine bronze/silver/gold rows are replaced by the three real
  terms. Nothing reads that table - no function, no view, no client code - but
  a table that lies is a trap for whoever reads it next.

Probed inside a rolled-back transaction before applying (CLAUDE.md 11.5):

```
monthly  -> tier monthly,  expires 2026-10-05, 1,999 charged
yearly   -> tier yearly,   expires 2027-10-05, 19,999 charged
lifetime -> tier lifetime, expires_at NULL,    49,900 charged
daily    -> invalid_arguments
annual   -> invalid_arguments
```

Safe to change: **not one VIP membership has ever been sold**, on any plan, by
card or diamonds. 0 `vip_subscriptions` rows, 0 VIP diamond transactions, 0
profiles on a `daily` or `annual` tier. The migration opens with a guard that
re-reads all three and aborts if any moved.

## The Membership tab

- Three plan cards: Monthly $19.99 / 1,999, Yearly $199.99 / 19,999, Lifetime
  $499 / 49,900.
- `buyDailyPass` is deleted with the endpoint it called.
- **No card button on Lifetime.** Its `checkoutPlan` is null because the World
  Hub's session builder has no one-time VIP mode and its webhook no one-time VIP
  grant - a card session would be paid and grant nothing. The card button is
  rendered only when `checkoutPlan` is set, so when that path ships this file
  needs no further change.
- `VipArt` gains a `lifetime` variant in brass, the colour the rest of the
  platform reserves for a membership that is earned rather than rented.

## And one thing that was not mine

`tests/global-css-does-not-leak-across-pages.law.test.ts` was **failing on
`origin/main`** when this branch was cut: 244 leakable class names against a
baseline of 243. Verified by running the ratchet against a clean stash of this
branch's base - the count is 244 there too, and my diff adds none of them.

Fixed rather than worked around, because the ratchet may fall and never rise.
`VIPPage.css` still carried the deleted tier ladder's stylesheet - `.tiers-list`,
`.tier-card`, `.tier-header`, `.tier-info`, `.tier-rakeback`, `.current-badge` -
none of them referenced by any `.tsx` any more. Two were doing harm while dead:
`.tier-card` was declared bare here and bare again in `VIPUpgradeModal.css` with
a different background, border and padding, which is a collision decided by
route chunk order; and `.tier-card.current` and `.current-badge` both painted
`#ffd700`. Deleting the block takes the count to 243.
