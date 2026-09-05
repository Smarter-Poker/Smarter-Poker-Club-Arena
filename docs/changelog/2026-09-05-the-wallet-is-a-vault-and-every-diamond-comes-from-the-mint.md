# The wallet is a vault, and every diamond comes from the Mint (2026-09-05)

Dan, 2026-09-04, three instructions in one session:

1. "When you click the wallet from the global header, it takes you to
   marketplace. It's supposed to take you to the wallet."
2. "This entire wallet page needs a full audit, enhancement, improvement, bug
   hunt and optimization ... add the #SMARTERCASINOREALISM ... make sure that
   wallets can send and receive, as well as earn." And: "You can't actually
   buy anything with diamonds anywhere, you get an error message from any and
   all pages."
3. "All diamond wallets need to be connected to 'The Mint'. That's where all
   purchased diamonds come from, and all 'earned' diamonds derive and send
   from the Mint. Make sure that functionality is fully built and implemented."

## What was true, measured

- `GlobalHeader.tsx` wallet button: `navigate('/marketplace?tab=diamonds')`,
  aria-label "Diamond Wallet". A store, not a wallet.
- `PlayerWalletPage.tsx` (733 lines) had no `#SMARTERCASINOREALISM` tag, no
  Rajdhani, no rendered art beyond the shared header strip, no reduced-motion
  handling, three tabs (Wallets / Transfer / Ledger). "Add Chips" and "Cash
  Out" opened `DepositWithdrawModal`, whose `FUNDING_ENDPOINT` is `null`; the
  sheet explains that nothing happens. No way to send diamonds to another
  player, no receive surface, "Earn" was a link to rakeback.
- Diamond purchases: the DB layer worked (every purchase RPC exists with the
  argument names the code sends; `fn_purchase_feature('throwable')` returned
  `success:true` as Dan's user, rolled back). The errors were client and API:
  - `MembershipTab` sold "Extend For 150 Diamonds", "Pay 1,999 Diamonds" and
    "Pay 19,999 Diamonds" to a **lifetime** member; every press was a 409
    "Lifetime VIP already includes this pass" rendered as a red toast. The
    only real purchase request in the World Hub's last 24h of logs was that 409.
  - `MarketplacePage` resolved the storefront club as the first
    `club_members` row PostgREST returned (`.limit(1)`, no ORDER BY): for Dan
    that was Deep Stack Society with 0 items, while Shark Club had 12. "The
    Club Shop Is Currently Empty."
  - `StoreTab` minted one idempotency key per modal open; the durable server
    cache replays the first status for five minutes, so a refused attempt
    ("Insufficient diamonds") replayed after a top-up.
  - `DiamondService.getBalance` ran two `wallet_transactions` reads whose
    category filters are rejected by the table's CHECK constraint; every
    caller reads `.balance` only. Two dead round trips per balance load.
- The Mint: `ca_mint_ledger` held diamond rows from exactly four writers
  (baseline, `fn_ca_mint` seeds, `fn_ca_burn` deletions). Register net
  418,767 against 1,030,607 diamonds in balances. Purchases, rewards, refunds
  and spends never reached the register. The chip side has had "the register
  follows the journal" since Phase 3.1; the diamond side had nothing.

## What changed

### Club Arena

- Header wallet button -> `/wallet`, labelled "My Wallet".
- `PlayerWalletPage` rebuilt as a rendered vault room:
  - `public/images/wallet/value-vault-hero-v1.webp` (1600x865, 70 KB),
    derived from the cashier vault render, mirrored and cool-graded so the
    vault sits left and the live console sits right.
  - The four wallet plates (`assets/club-buttons/wallets/square/*`) carry the
    live figures in their machined bays: Diamonds, Player, Promo, Business.
  - Five panes: **Wallets**, **Send** (diamonds to an accepted friend via
    `POST /api/store/diamond-transfer`, friend list from `friendships` both
    directions, minimum 10, confirm dialog; chips between own wallets via the
    existing `internalTransfer`), **Receive** (player number, player id and
    profile link with copy; every credit in `diamond_transactions` newest
    first, refreshed on `BALANCE_UPDATED`), **Earn** (daily login claim via
    `POST /api/rewards/daily-login`, streak / earned-today / multiplier from
    `GET /api/rewards/progress`, lifetime earned/spent from the diamond
    ledger, doors to Rakeback, Challenges, Bonuses, Promotions, Achievements,
    VIP), **Ledger** (unchanged components in the new frame).
  - Add Chips / Cash Out open the club cashier when a club is in context.
  - Counter honours `prefers-reduced-motion`; tablist takes Home/End.
  - Every bus listener still forces a refetch; the header pins, the label
    pins, the emoji and toast-casing house rules all hold (tests below).
- `MembershipTab`: a lifetime member sees "Included With Lifetime VIP" on
  every plan; the handlers refuse with an info toast before any request.
- `MarketplacePage`: club resolution prefers the club the player is inside,
  then the membership with the most active `club_shop_items`, then any.
- `StoreTab`: a refused purchase mints a fresh idempotency key for the next
  press.
- `DiamondService.getBalance` drops the two dead reads;
  `getLifetimeStats` reads the diamond ledger by sign, on demand.

### Supabase (applied to production, `20260905041033`)

- `trg_ca_diamond_register_follows_journal` on `diamond_transactions`: every
  issuance (purchase, reward, promotion, refund, adjustment, arena) writes a
  `ca_mint_ledger` `mint` row from the Mint to the player; every retirement
  (spend, bridge, adjustment) writes a `burn`. Player-to-player transfers and
  the Mint's own rows (`source = 'the_mint'`) are skipped. Never raises: a
  register failure files `MINT:register_follow_failed`.
- `origin` (generated) learns the diamond-journal prefixes; unique index on
  `diamond_tx_id`.
- Backfilled 6 live journal rows since the 2026-09-03 baseline, then one
  labelled opening correction (mint 611,325 to circulation) so the register
  equals the meter (`profiles.diamonds` + `ca_diamond_house`) at 1,030,607.
- `fn_ca_diamond_register_vs_supply()` and a `diamonds` block in
  `fn_ca_mint_overview()` (register, meter, difference, balanced, 24h and
  since-baseline issuance/retirement, headroom, by origin).
- Proven live (rolled back): `add_diamonds_to_balance(daily_login, 7)`
  produced `diamond-journal:reward:<tx>` / mint / 7 / supply_after 1,030,614
  and the register still equalled the meter afterwards.

## Verification

- `npx tsc --noEmit`: exit 0.
- Targeted suites (wallet, cashier realism, route families, balance events,
  live pool, migration uniqueness): 9 files, 124 tests, all passed.
- Migration probed in one self-aborting transaction before apply; asserted
  difference 0 after apply.

## Still open (World Hub, separate branch)

- `/api/vip/check-status` turns a DB read error into `{diamonds: 0}` (200),
  which disables every Buy button with "Insufficient Diamonds" and no error.
- `pages/api/club-arena/marketplace-items.js` has the same first-membership
  club resolution; the Hub club shop page cannot pick a club.
- The Mint panel (`pages/horses/index.js`) should render the new `diamonds`
  reconciliation block.
