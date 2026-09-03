# 2026-09-02 - The shine only on the clock, and owners play out of a player wallet

**Dan:** "THE 'SHINE EFFECT' THAT GOES OVER EVERY PLAYER, EVERY COUPLE OF
SECONDS ... SHOULD ONLY APPEAR WHEN IT'S A PLAYER'S TURN, AND THEY HAVE BEEN ON
THE CLOCK FOR AT LEAST 3 SECONDS. IT SHOULD NEVER APPEAR ON IDLE PLAYERS, OR
PLAYERS IF THE ACTION ISN'T ON THEM."

**Dan:** "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER WALLET (ADMIN'S
SHOULD NOT) I KNOW WE'VE SAID THEY SHOULDN'T PREVIOUSLY, BUT NOW IM SEEING THE
VALUE IN IT. IN THE TRANSACTION LEDGER, IT NEEDS TO SPECIFY WHICH WALLET A USER
IS TRANSFERRING TO REGARDLESS OF ROLE, 'KINGFISH TRANSFERRED XXX FROM HIS AGENT
WALLET TO PLAYER WALLET' ETC."

## 1. The shine is an "on the clock" cue

The holo scan line on VIP bust art (`.seat__avatar--holo::after`) ran on every
VIP seat forever: a 7 s cycle, phased per seat by `breathingStyle()`, so
somewhere on a full table a player lit up every second or two. That was the
"every player, every couple of seconds".

Now (`SeatSlot.tsx`):

- The class is applied only when `showHolo` is true, and `showHolo` needs
  eligible art AND `holoOnClockDelayMs !== null`, which is only non-null for the
  seat that is acting. Idle seats and seats the action is not on get no class,
  no pseudo-element, nothing to see.
- The first sweep waits `HOLO_ON_CLOCK_MS = 3_000` on the clock. The delay is
  measured on the engine's clock through the same elapsed figure the countdown
  ring uses, and it is frozen once per turn on the ring's paint anchor. A value
  that shrank on every countdown tick would re-time the running animation and
  bring the sweep forward of three seconds; a mid-turn rejoin with more than
  three seconds already gone lands at 0 and shines at once.
- `breathingStyle()` no longer hands the shine an idle phase; the CSS default
  for `--sp-holo-delay` is 3 s.

Pinned by `tests/unit/theShineIsAnOnTheClockCue.test.ts` (6 tests).

## 2. Owners and co-owners hold a player wallet; admins do not

`walletRows.ts`: `clubWalletRows` gives every role except `admin` a Player
Wallet row; the compact lobby rows for owner and co_owner are Club Bank +
Player Wallet (admin and super_agent keep Club Bank + Agent Wallet). This
reverses the 2026-08-21 / 08-23 rulings on Dan's instruction above.
`tests/unit/walletRows.test.ts` moved with it.

Database half, migration
`20260902215043_owners_and_co_owners_play_out_of_a_player_wallet_admins_do_not`
(applied via Supabase MCP, mirror byte-exact from `schema_migrations`):

- `fn_agent_wallet_self_stake` admits owner and co_owner: they have always held
  an agent wallet and now hold the player wallet the chips move into. Admin
  stays refused.
- `fn_club_bank_send` refuses `destination = player_wallet` when the recipient
  is an admin, so chips can never land in a balance no surface shows them.

Both are CREATE OR REPLACE of functions already in the schema manifest; the
probe was run inside a rolled-back transaction before the apply.

## 3. The ledger names both wallets

New `src/components/wallet/describeChipTransaction.ts`, pure and unit-tested
(`tests/unit/describeChipTransaction.test.ts`, 9 tests). For every wallet-moving
type the cashier writes (`agent_wallet_send`, `agent_wallet_self_stake`,
`club_bank_send`, `club_bank_reversal`, `agent_wallet_claim_back`,
`club_bank_claim_back`, `admin_removal`) it turns the row's own structure
(`from_user_id`, `to_user_id`, `metadata.destination`) into one sentence:

> KINGFISH Sent 1,250.5 From KINGFISH's Agent Wallet To Bob's Player Wallet
> You Transferred 2,000 From The Club Bank To Your Player Wallet
> KINGFISH Claimed Back 1 From Bob's Agent Wallet To The Club Bank

and a compact route ("Agent Wallet To Player Wallet"). It never invents a route
for a row that is not a wallet move, and a name that did not load prints as
"A Member", never a uuid.

Wired into:

- `TransactionHistoryPage` (the Transaction Ledger): the select now carries
  `from_user_id, to_user_id, metadata`, profiles are loaded for both sides, and
  the description is the sentence, falling back to `notes` for non-wallet rows.
- `CashierTradePage` (the Trade Ledger): the select carries `metadata`; each row
  shows the route next to its type, the receipt gains "Wallets" and "Summary"
  facts, and the search box matches the route.

## Also in this PR

The pin in `tests/config/walletCreditIntegrity.test.ts` on a boot-time
`atomic_seat_cashout_locked` call had main's client suite red after #2713 and
blocked the publish of #2696. This branch carried the same move as #2717;
#2718 landed it first, so this PR takes main's version of the file unchanged.

## Verification

`tsc --noEmit` clean; client suite 11,542 passed before the pin move, the moved
pin and the 15 new tests green after it.
