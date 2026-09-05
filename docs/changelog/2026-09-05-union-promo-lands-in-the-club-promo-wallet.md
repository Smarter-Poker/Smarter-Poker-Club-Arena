# Union Promo Lands In The Club Promo Wallet, 2026-09-05

Dan: "I JUST SENT PROMO CHIPS FROM MIDWAY UNION WALLET, TO SHARK CLUB, CLUB
JAQK AND KING FISH, BUT NONE OF THE CHIPS SHOWED UP IN THE WALLETS. GET TO THE
ROOT CAUSE OF THE BUG OR GLITCH, FIX IT, AND PREVENT IT FROM HAPPENING AGAIN."
And: "FULLY AUDIT, ENHANCE, AND UPGRADE THE UI FOR BOTH WALLETS ... MAKE SURE
YOU ADD AND HAVE A TRANSACTION LEDGER ATTACHED TO EVERY PROMO WALLET."

## What Actually Happened (Read From The Rows)

Three sends from the Midway Union Promo Wallet modal, 02:51 UTC, all by
KingFish (`47965354-0e56-43ef-931c-ddaab82af765`):

| Time     | Target    | What the modal called                                   | Where the money went                                                |
| -------- | --------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| 02:51:02 | Club JAQK | `unionApi.sendToClub` -> `fn_union_send_to_club_atomic` | union **chip bank** -5,000 -> Club JAQK **Club Bank**               |
| 02:51:14 | SHARK     | `unionApi.sendToClub` -> `fn_union_send_to_club_atomic` | union **chip bank** -5,000 -> SHARK **Club Bank**                   |
| 02:51:20 | KingFish  | `fn_union_send_to_member(kind => 'promo')`              | union promo -5,000 -> KingFish's **agent promo float** in Club JAQK |

The union promo wallet did not move for the two club sends. The union bank
lost 10,000. Each Club Bank gained 5,000 under the note "Promo Wallet to
club". The club Promo Wallet rows read 0.00. The KingFish send was correct
under the cashier law (an agent-shaped recipient takes promo into their promo
float) but the club lobby's Promo Wallet row reads `clubs.promo_balance`, not
`agents.promo_wallet_balance`, so it too read 0.00.

## Root Causes

1. **`UnionWalletModal.tsx` line 235.** Every club target, regardless of
   which wallet was open or which kind was picked, called
   `unionApi.sendToClub`. That RPC knows one route: union bank -> Club Bank.
   The Promo tab was decorative for club targets.
2. **`fn_union_promo_send(destination => 'club')`** - the RPC the modal
   should have called - credited `clubs.chip_treasury`. There was no path from
   the union promo wallet into a club promo wallet at all.
3. **Two accounts wear the name "Promo Wallet" on a club surface.** The
   lobby row shows `clubs.promo_balance` for a Club Bank role; the cashier it
   opens read and spent the viewer's `agents.promo_wallet_balance`. An owner
   could hold 5,000 in one and see 0.00 in the other.

## The Ruling (Dan, 2026-09-05)

The 2026-09-03 promo model (`promo-is-disbursed-by-the-owner.law.test.ts`)
had union promo to a club land as ordinary chips in the Club Bank, "never a
promo_balance", and refused a union club its own promo wallet. That written
rule and what Dan did today disagreed, so it was put to him as a choice. He
chose: **union promo to a club lands in that club's Promo Wallet
(`clubs.promo_balance`)**; club staff hand it out from there into player
wallets as cash or agent promo floats; every promo wallet carries a ledger.
Recorded in `docs/LAWS.md`, "Resolved conflicts".

## What Changed

### Database (both applied to production, one transaction each)

`20260905030103_union_promo_lands_in_the_club_promo_wallet.sql`

- `fn_union_promo_send`: `destination => 'club'` credits `clubs.promo_balance`.
  One declared `chip_ledger` row `union_wallet -> promo_wallet`, a
  `union_wallet_transactions` row (`promo_to_club`) and a `chip_transactions`
  row (`union_promo_to_club`). Refuses a caller who cannot manage the union's
  wallets (the World Hub route calls it as service_role and passes).
- `fn_club_promo_wallet_send` (new): spends the club promo pot into a player
  wallet (cash) or an agent promo float. Club Bank roles. Op-keyed replay,
  club row locked before the replay check, one declared ledger row.
- `fn_promo_wallet_ledger` (new): one read for every promo wallet. Scope
  `union` (any `union_wallets` column, from `union_wallet_transactions`),
  `club` (the club pot's rows on `chip_ledger`), `agent` (the caller's float
  in that club). Names the other side of every row. Totals in / out / net.
- **Reroute of the two club sends**, keyed on the original transaction ids
  (`4a363124...`, `a458f05e...`): each Club Bank gave back 5,000 to the union
  bank (`reversal`, one ledger row each), then the union promo wallet paid
  5,000 into each club Promo Wallet (`promo_send`, one ledger row each).
  Probed first in a single self-aborting `DO` block (CLAUDE.md 11.5 section
  2): `PROBE_OK rolled back: 2 club sends rerouted; union bank 52074.84 ->
62074.84, union promo 42482.58 -> 32482.58; ledger rows written in probe: 4`,
  and the balances were read back unchanged before the real apply. After:
  union bank 62,074.84, union promo 32,482.58, Club JAQK promo 5,000.00 (bank
  1,051,788.71), SHARK CLUB promo 5,000.00 (bank 1,376,610.47). The block
  asserts every one of those deltas and refuses to run twice.
- KingFish's 5,000 stays in his Club JAQK agent promo float. It is where the
  cashier law says it goes, and the cashier now shows it.

`20260905031715_the_club_promo_wallet_is_where_union_promo_lands.sql`

- `fn_promo_disburse` (the 2026-09-03 door) brought in line: `target =>
'club'` credits `clubs.promo_balance`; a club inside a union may spend its
  own promo wallet. Nothing else in it moves.

### Union Wallet modal (`src/components/union/UnionWalletModal.tsx`)

Rebuilt on the Club Bank cashier's hardware (`cbc-*`, smarter.poker palette,
44px targets, scrolling body) with a small `UnionWalletModal.css` on top.

- A club target is routed by `clubSendRoute(walletKey, kind)` in
  `unionWalletRoutes.ts`: promo wallet or Promo kind -> `unionApi.promoSend`
  into the club Promo Wallet; union bank / BBJ with Chips -> `sendToClub` into
  the Club Bank; rake wallet and diamonds are refused with a sentence and the
  club rows are marked, never silently routed through the bank.
- Every club row says where the chips will land before the send ("Into The
  Club Promo Wallet" / "Into The Club Bank"), and the tag on the row changes
  with the route.
- Send / Pull (Clawback) / **Ledger** tabs. The Ledger tab reads
  `fn_promo_wallet_ledger` scope `union` for the open wallet's column, with
  totals, the counterparty named, the actor named, the balance after, and
  Load More. The spin reserve keeps its read-only reserve ledger.
- Success notices name the landing account ("Into The Club JAQK Promo
  Wallet", "Into Their Promo Float").

### Club Promo Wallet cashier (`src/components/wallet/WalletCashierModal.tsx`)

- Reads BOTH promo accounts on open: the club pot off the club row and the
  viewer's float off their agents row. `promoSourceFor(role)` (cashierModes)
  decides which one a viewer stands at - Club Bank roles at the pot, agents at
  their float - so the balance the lobby row shows and the balance the
  cashier spends are the same account.
- A Club Bank role who also holds a float gets a two-way switch with both
  balances printed on it. This is how KingFish reaches his 5,000.
- The pot is spent through `fn_club_promo_wallet_send`, the float through
  `fn_promo_wallet_send` (`promoSendRpc`). The pot may fund the owner's own
  float, like the Club Bank; the float still refuses a self-send.
- **Transaction Ledger** tab (`cashierTabs('promo_wallet')` is now
  `['send', 'ledger']`, still no claim), read from `fn_promo_wallet_ledger`
  scope `club` or `agent`, following the source switch. CSV export.
- Realtime: `clubs.promo_balance` and `agents.promo_wallet_balance` both move
  the header while the cashier is open.

### Laws

- New: `tests/union-promo-goes-to-the-promo-wallet.law.test.ts` (22 pins) -
  the route table, the RPC landing account, the cashier's two accounts and
  their RPCs, the ledger on every promo wallet, and the reroute's keys.
- Amended: `tests/promo-is-disbursed-by-the-owner.law.test.ts` now reads the
  2026-09-05 definition and pins the ruling. `docs/laws.d/` entries updated.
- `tests/unit/cashierModes.test.ts` and `tests/cashier-ui-role-scoping.test.ts`
  updated in the same commit for the ledger tab and the two-argument
  `cashierRefusesSelfSend`.

## Verification

- `npx tsc --noEmit -p tsconfig.app.json`: 0 errors.
- `npx vitest run` on the eight touched and neighbouring files: 8 files,
  303 tests, all green (union-wallet-modal, union-promo law,
  promo-is-disbursed law, cashierModes, cashier-ui-role-scoping,
  spinReserveWalletView, law-registry, shipped-invariants).
- `check-title-case`, `check-ui-text` (no em dashes), `check-painted-text-case`,
  `check-maybe-single`: OK.
- `fn_promo_wallet_ledger` exercised on production as KingFish (`set local
role authenticated` + jwt claims): club scope for Club JAQK returns the
  5,000 from Midway Union with balance after 5,000.00; agent scope returns
  his float credit; union scope for the promo wallet returns the two
  `promo_to_club` rows and the sweeps, net 32,482.58 = the wallet.

## Still Open

- The World Hub route `pages/api/club-arena/union-wallet.js` still words its
  promo_send success as "sent to the club treasury" and reads
  `club_treasury_after` (now null). The Club Arena modal ignores that message
  and prints its own. A one-line World Hub follow-up will change the wording
  and read `club_promo_after`.
- The rake wallet has no route into a club. The modal now says so instead of
  drawing on the union bank; whether one should exist is Dan's call.
