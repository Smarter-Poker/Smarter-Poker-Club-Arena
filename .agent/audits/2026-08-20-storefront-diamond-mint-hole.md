# Storefront review — players could mint their own diamonds

Found while reviewing the Club Arena storefront (marketplace) top to bottom.
This is the most serious thing on that surface, so it was fixed first.

## The hole

Diamonds are the real-money currency — bought through Stripe
(`/api/store/create-checkout-session`) and spent in the marketplace. Two
tables hold a diamond balance, and **both were writable by the owner of the
balance**:

| table | policy | cmd | roles | WITH CHECK |
|---|---|---|---|---|
| `diamond_wallets` | `diamond_wallets_self` | ALL | PUBLIC | **null** |
| `user_diamond_balance` | `Users update own balance` | UPDATE | PUBLIC | **null** |
| `user_diamond_balance` | `Auto-create balance on first claim` | INSERT | PUBLIC | `auth.uid() = user_id` |

When `WITH CHECK` is null Postgres reuses the `USING` expression as the check,
so the only condition on a write was *"this row is mine"*. Nothing constrained
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

* every writer is server-side and uses the **service role**, which has
  `rolbypassrls` — WH `pages/api/auth/ensure-profile.js`,
  `delete-account.js`, the Stripe checkout routes, and the SECURITY DEFINER
  grant/spend functions (both tables are owned by `postgres` with
  `force_rls` off, so definer functions are unaffected);
* the client only ever **reads** a balance — CA `ClubLobby.tsx` (x3), the
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
* `club_members.chip_balance` — the club shop's actual currency. No
  INSERT/UPDATE/ALL policy exists at all, so a member cannot write it.
* `club_diamond_wallets`, `diamond_ledger`, `club_shop_items`,
  `club_shop_purchases`, `club_shop_inventory` — reads only for players;
  all writes go through World Hub API routes running as service_role.
* `commander_time_purchases` — `USING (false)`, denies everything.

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
