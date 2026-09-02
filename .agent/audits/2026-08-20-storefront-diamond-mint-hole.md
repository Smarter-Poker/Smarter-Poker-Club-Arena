# Storefront review — players could mint their own diamonds

Found while reviewing the Club Arena storefront (marketplace) top to bottom.
This is the most serious thing on that surface, so it was fixed first.

## The hole

Diamonds are the real-money currency — bought through Stripe
(`/api/store/create-checkout-session`) and spent in the marketplace. Two
tables hold a diamond balance, and **both were writable by the owner of the
balance**:

| table                  | policy                               | cmd    | roles  | WITH CHECK             |
| ---------------------- | ------------------------------------ | ------ | ------ | ---------------------- |
| `diamond_wallets`      | `diamond_wallets_self`               | ALL    | PUBLIC | **null**               |
| `user_diamond_balance` | `Users update own balance`           | UPDATE | PUBLIC | **null**               |
| `user_diamond_balance` | `Auto-create balance on first claim` | INSERT | PUBLIC | `auth.uid() = user_id` |

When `WITH CHECK` is null Postgres reuses the `USING` expression as the check,
so the only condition on a write was _"this row is mine"_. Nothing constrained
`balance`.

Proven against production, in a rolled-back transaction, as a plain
authenticated user:

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"<a real player>","role":"authenticated"}',true);
INSERT INTO diamond_wallets (user_id, balance) VALUES ('<that player>', 1000000)
ON CONFLICT (user_id) DO UPDATE SET balance = 1000000;
-- -> balance = 1000000
```

No server code is involved: this is one PostgREST call from any browser
holding a valid session. `user_diamond_balance` currently holds 456,445
diamonds across 5 rows; `diamond_wallets` has 416 rows.

## The fix

Both tables are SELECT-only for their owner now. Nothing legitimate breaks:

- every writer is server-side and uses the **service role**, which has
  `rolbypassrls` — WH `pages/api/auth/ensure-profile.js`,
  `delete-account.js`, the Stripe checkout routes, and the SECURITY DEFINER
  grant/spend functions (both tables are owned by `postgres` with
  `force_rls` off, so definer functions are unaffected);
- the client only ever **reads** a balance — CA `ClubLobby.tsx` (x3), the
  marketplace wallet load, WH `src/lib/authUtils.js`.

Re-verified after applying: INSERT blocked with `insufficient_privilege`,
UPDATE affects 0 rows, own-balance SELECT still returns the row, and neither
table has a non-SELECT policy left for a non-service role.

## How it was found, and what else the sweep turned up

Rather than checking one table, every money table was swept for write
policies that have no `WITH CHECK` of their own and are not restricted to
`service_role`:

```sql
SELECT c.relname, p.polname, p.polcmd, p.polroles::regrole[]
FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND p.polcmd IN ('*','w','a')
  AND p.polwithcheck IS NULL
  AND NOT ('service_role'::regrole = ANY(p.polroles))
  AND c.relname ~ '(wallet|balance|chip|diamond|credit|ledger|payout|rakeback|cashout|purchase|invoice|treasur)';
```

Checked and found SAFE:

- `club_members.chip_balance` — the club shop's actual currency. No
  INSERT/UPDATE/ALL policy exists at all, so a member cannot write it.
- `club_diamond_wallets`, `diamond_ledger`, `club_shop_items`,
  `club_shop_purchases`, `club_shop_inventory` — reads only for players;
  all writes go through World Hub API routes running as service_role.
- `commander_time_purchases` — `USING (false)`, denies everything.

## Still open — NOT fixed here, needs an owner decision

`public.cashout_requests` has `cashout_update`: FOR UPDATE, PUBLIC,
`USING (player_id = auth.uid() OR <club staff>)`, **WITH CHECK null**. The
table carries `amount` and `status`, so on the face of it a player can edit
their own cashout request after submitting it — including those two columns.

It is left alone deliberately: cashouts are the agent/cashier workflow, not
the storefront, and the legitimate flow (player edits a pending request,
staff acknowledge/complete it) has to be understood before the policy is
tightened, or real payouts break. The fix shape is the same one-liner — a
`WITH CHECK` that pins `amount` and restricts `status` transitions by role.

> ### CLOSED 2026-08-25 — and it was not the one-liner above
>
> `cashout_update` no longer exists. `20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow`
> dropped it, and `cashout_insert` with it, and moved every write onto
> SECURITY DEFINER functions (`fn_cashout_request` / `fn_cashout_approve` /
> `fn_cashout_release`). Re-probed against production as a real player, in a
> rolled-back transaction: **SELECT 1 row, UPDATE amount 0 rows, UPDATE status
> 0 rows, DELETE 0 rows.** There was no live write exposure left to close.
>
> Two things were still worth doing, and were done in
> `20260826020000_cashout_requests_client_writes_are_restricted`:
>
> 1. The protection was the ABSENCE of a policy on top of grants that still
>    give `anon` and `authenticated` INSERT/UPDATE/DELETE. One permissive
>    `for all ... using (true)` would have re-opened `amount` and `status`
>    silently. Three RESTRICTIVE policies now deny client writes in a way that
>    adding permission cannot undo — sabotage-tested by adding exactly that
>    permissive policy and re-running the probe: still 0 / 0 / refused.
> 2. `ClubsService.leaveClub` was still performing the dropped policy's write.
>    It had become a NO-OP, not an error, so a member leaving with a pending
>    cashout kept the request `pending` and the escrow unreleased — the chips
>    were not returned to `chip_balance` and so were not in the treasury
>    return either, and then the membership was deleted. It goes through
>    `fn_cashout_release` now and a refusal stops the departure.
>
> Nothing was stranded by this in practice: `cashout_requests` holds 0 rows and
> `chip_escrow` holds 0 unreleased rows.

---

# Storefront UI / CX review — what was checked and what was found

The rest of the storefront review. Recorded in full because most of it is a
list of things that turned out to be RIGHT, and the next person should not
have to re-derive that.

## Already correct — verified, deliberately not touched

`StoreTab` (the customer-facing surface) is in good shape:

- **Buy confirmation** — `role="dialog"`, `aria-modal`, `aria-labelledby`,
  initial focus on Confirm, Escape to close (in its own effect so it reads the
  live `processing` value), background scroll locked.
- **Empty states are distinguished** — "Loading the shop..." vs "The club shop
  is currently empty" (with an admin-only _Add First Item_ CTA) vs "No items
  match your filters" with a _Clear Filters_ button. The three are genuinely
  different states, which is the bug class that bit the audit log.
- **Sale pricing** — struck-through original beside the effective price, and
  `effectivePrice()` is shared with the server-side decision.
- **Insufficient funds** — states the exact shortfall, and correctly does NOT
  upsell a chip purchase (chips are not purchasable).
- **Availability** — `unavailableReason()` mirrors `fn_shop_item_availability`
  (sold out / not yet / ended / owned / limit reached) so the card and the
  server agree before the member commits.
- **Mobile** — `.categoryFilters` scrolls horizontally, breakpoints at 640px
  and 480px, and a `prefers-reduced-motion` block.
- **Purchase integrity** — `/api/club-arena/marketplace-purchase` runs as
  service_role, re-decides the price server-side, claims stock atomically via
  `fn_claim_shop_purchase`, debits with `fn_debit_chips`, and releases the
  stock claim if a later step fails. The client never sends a price.

## Fixed here

- **Category chips had no toggle semantics.** Seven identical "button" nodes
  to a screen reader, with the active state carried only by a CSS class. Now a
  labelled `role="group"` with `aria-pressed` per chip.
- **Stale doc comment** at the top of `MarketplacePage.tsx` still described a
  "Get Chips — diamonds -> club chips" tab. That tab and that conversion were
  removed on 2026-08-19; the comment now records that instead of advertising a
  path that no longer exists.

## Not changed, on purpose

The five tab components are ~2,700 lines and were being actively rebuilt by
other agents during this review (stackable consumables, sale pricing, promos,
refunds, limited stock, the admin purchase ledger all landed within hours).
Sweeping edits there would have collided with in-flight work for marginal
gain, so the storefront changes here are deliberately small and surgical. The
substantive win from this review is the diamond-minting hole above.

---

# Storefront pass 2 — refunds were invisible in purchase history

Reviewed the tabs not covered in pass 1 (`MyItemsTab`, `MembershipTab`,
`DiamondsTab`, `PurchaseLedger`, `ShopAnalytics`) line by line.

**Found:** `/api/club-arena/marketplace-items` selected the caller's purchases
WITHOUT `refunded_at`, and `ShopPurchase` had no such field. So the My Items
purchase history rendered a reversed purchase identically to a live one:

- the member saw chips they had **already been given back**, listed as a
  normal purchase with no indication;
- an admin got an **enabled Refund button** on it, whose only possible answer
  was "already refunded" after a server round trip.

The column was already understood in that endpoint — line 84 uses
`.is('refunded_at', null)` to compute `my_purchase_count` for per-user limits.
It simply was never surfaced.

Fixed across both repos:

- WH `marketplace-items.js` — `refunded_at` added to the FK-join select AND
  the fallback select, and passed through in both mappers so the response
  shape does not depend on which path ran. (WH PR #614, merged.)
- CA `ShopPurchase` gains `refunded_at`; the history table gains a
  Paid/Refunded status badge (with the refund time on hover), and the Refund
  action becomes a dash once the purchase is reversed rather than an enabled
  button that cannot work.

**Checked and found correct** in the same pass, so deliberately untouched:
`MyItemsTab` redemption (confirm dialog, per-row disabled state, grant-aware
success messages, sr-only actions header, distinct empty states), the
entitlement strip, `isOwnedRow()` fail-safe status vocabulary, and
`PurchaseLedger`, which already reads `refunded`/`refundedAt` from
`/api/club-arena/shop-purchases` and renders them.
