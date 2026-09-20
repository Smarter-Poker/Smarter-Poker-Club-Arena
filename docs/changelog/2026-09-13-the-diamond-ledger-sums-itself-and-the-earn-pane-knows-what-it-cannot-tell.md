# The diamond ledger sums itself, and the Earn pane knows what it cannot tell

**Date:** 2026-09-13
**Branch:** `agent/cw-wallet2/audit/the-wallet-line-by-line`
**Surface:** `/wallet` (PlayerWalletPage), `DiamondService`, one migration
**Companion:** World Hub `agent/cw-hubwallet2/fix/the-earn-pane-knows-what-it-cannot-tell`

A line-by-line pass over the wallet as it stands on `main` after #4490. Four
findings, all fixed here; none is cosmetic.

## 1. Lifetime diamonds were a browser-side sum with a silent zero

`DiamondService.getLifetimeStats` read up to 5,000 rows of
`diamond_transactions` into the page and added them up in JavaScript, and on
a failed read returned `{ lifetimeEarned: 0, lifetimeSpent: 0 }`. The Earn
pane then printed `0` under "Earned" - a figure indistinguishable from a new
account, presented as a lifetime. The World Hub's
`/api/store/diamond-transactions` did the same sum with the same ceiling.

Measured before the fix: 1,166 players hold diamond rows, the longest ledger
is 431. The cap has not bitten; it is a cliff with a date on it. The zero is a
10.86 violation today.

**Fix, at the root.** Migration `20260913171905_the_diamond_ledger_sums_itself`
adds `fn_diamond_lifetime_totals(p_user_id uuid default auth.uid())`: one
`STABLE`, `SECURITY INVOKER` SQL function summing the whole ledger where the
ledger lives. INVOKER means `diamond_transactions_select_own` still decides
what an `authenticated` caller can see - probed on production in a rolled-back
`DO` block: as another player, a stranger's ledger sums to 0 rows; one's own
to 124 rows / 4,095 earned, matching a raw `SUM` exactly. `service_role` (the
World Hub API) sees the whole table as before. Applied 2026-09-13 17:20 UTC,
outside the break window; recorded as `the_diamond_ledger_sums_itself`.

`getLifetimeStats` now calls the RPC and returns **`null`** when it cannot
tell. The page holds three states - `undefined` reading, `null` failed, an
object known - and renders Checking / Unavailable + Retry / the figure. The
lifetime panel also re-sums on `BALANCE_UPDATED` while open, so a claim made
on the same pane no longer shows the number from before it. The World Hub API
reads the same RPC for its headline earned/spent (`lifetime.exact: true`) and
keeps its 5,000-row window only for the week/month/gift breakdowns, which is
what `lifetime.truncated` now describes.

Pinned by `tests/unit/theDiamondLedgerSumsItself.test.ts`.

## 2. The Earn pane offered a claim it knew was already taken

`/api/rewards/progress` computed `days.has(today)` inside its streak walk and
threw the answer away. The Club Arena page initialised `claimedToday` to
`false`, so a player who had already claimed saw an enabled "Claim Daily
Diamonds" button and learned otherwise only from the click's toast. The route
also returned `partial: true` when it had degraded, and the page ignored it,
rendering the degraded zeros as fact.

**Fix.** The route now returns `loginClaimedToday` (`true` / `false` / `null`
= could not tell) and `nextLoginReward`, the next claim's payout from the
catalog's own `scaling` rule (`min(base + (day-1)*increment, max)`), so it
cannot drift from `award_diamonds_v2`. The streak arithmetic moved to
`src/lib/rewards/loginStreak.mjs` (World Hub) where a plain `node --test` can
reach it; the route only does the read. The page sets the button to "Claimed
Today" from `true` only - `null` leaves it live, because refusing a claim on a
read failure would cost a real player a real payout - prints "Your Next Claim
Pays N" / "Tomorrow Pays N", and shows a one-line notice when `partial`.

World Hub test: `__tests__/the-earn-pane-knows-what-it-cannot-tell.test.mjs`
(7 cases including the Chicago day boundary and the catalog cap).

## 3. A guard inside the try left the transfer button stuck

`handleTransfer` set `isTransferring` to true and then, inside the `try`,
`if (!user?.id) return;` - which skipped the reset at the bottom of the
function and left "Transferring..." on screen for the life of the page. The
guard now runs before the flag flips. Unreachable in practice (the page needs
a user to render), which is why it survived; still wrong.

## 4. Two small parity gaps

- The Send pane's own ledger ("Diamonds You Have Sent") gained the same
  end-of-ledger line the Receive pane has, so a player can tell a complete
  list from a truncated one on both sides.
- The diamond amount input carries `max` = the balance, so the browser's own
  validation agrees with the handler's.

## Verified

`tsc` clean, eslint clean, 478 wallet-adjacent tests + 9 new pass,
`check-route-targets` 134 routes / 0 dead. Production: the RPC's sums equal a
raw `SUM` for the longest ledger; RLS probe as above.

## Not changed, deliberately

`/api/rewards/daily-login` keeps its own streak walk. It keys on the
server-written `reference_id` date rather than `created_at`, it is a money
path, and the shared module's formula is pinned to the catalog string the
claim route documents. Merging the two walks is a separate, probed change.

## 5. (second commit) Every Send from this page was refused, and the floor was invented

Found on the second pass, reading the route rather than this page's comments.

**Every send failed.** `/api/store/diamond-transfer` has required an
`X-Idempotency-Key` since #1696 (2026-09-09), refusing without one - 400
"Invalid Transfer Request" - and `storeFetch` never sent one. So for four days
a player pressing Send Diamonds here got that sentence every time, and nothing
in this repo said why. `storeFetch` now takes `idempotencyKey` and sends the
header; the page mints one key per send intent (`sendKeyRef`), reuses it on a
retry (the route answers 503 "Retry With The Same Request ID" when a receipt is
unconfirmed, and `send_wallet_diamond_transfer` replays its own answer for a
repeated `request_id`), clears it on success, and rotates it only after a
`definitive` refusal - the StoreTab pattern, for the same money reason.

**The floor was 10, and the comment blamed the route.** The RPC refuses only
`p_amount <= 0`; the anti-farming cap governs everything else. The page now
allows 1, and the copy no longer promises a minimum that did not exist.

**The route's shape was misread.** The page typed the response as
`{ transferred, newBalance, recipientName }`; the route returns the transfer
row (`amount`, `recipient_id`, `request_id`). Harmless by luck (every read had
a fallback), now typed as what arrives.

**Who the gift was with.** `send_wallet_diamond_transfer` writes a generic
description and puts the other player's id in `metadata`. The hook now reads
`metadata` and surfaces `counterpartyId` by direction; the page resolves it
through the friend list it already loads (now for the Receive tab too), so a
row reads "Sent To Alice (#123)" / "Received From Bob (#77)" instead of
"Diamonds Sent To A Friend".

Pins: `tests/wallet-casino-realism.test.ts` (floor = 1, key on the send, no
key rotation on an ambiguous outcome), `tests/unit/theDiamondLedgerSumsItself.test.ts`.
