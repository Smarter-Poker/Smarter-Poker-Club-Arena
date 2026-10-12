# 2026-10-02 - Every chip store refuses

## For Dan

You asked that chip drift not be possible. As of this change it is refused at
the moment it would happen, in every place chips are held: player wallets,
promo balances, agent wallets, club treasuries and club wallets, insurance
banks, the felt, union banks and wallets, jackpot pools, Spin reserves,
tournament prize pools, unredeemed tickets, and the two pass-through accounts
for club openings and leaderboard payouts. A database transaction that moves
chips in any of them without writing the matching ledger row, to the cent,
does not commit; nothing is fixed up afterwards. The nine stores added today
were measured live before being switched on: zero mismatches under full
traffic. The one money function the reading found that could have created
chips without a ledger row (an old agent "clawback" that took chips from a
column that holds none) never ran and is now retired; the real undo is the
agent wallet claim back.

## The measurement (observe, 20261002030942, applied 04:14:45 UTC)

- Zero findings on any store from 04:14:45 UTC. At 04:28 UTC the window
  already held, on the new stores: 543 tournament buy-ins, 236 prizes, 107
  event rakes, 93 burns, 12 bounties, 107 Spin entries and 106 Spin prizes
  through the reserve, 3 jackpot promo sweeps into the club promo float, 8
  club opening allocations through the opening clearing store, 330 escrow
  writes and 201 events completing, plus satellite seat transfers
  (escrow to escrow) at 04:17 and 04:20.
- Static cross-check: all 19,142 chip tournament escrows opened in the 24
  hours to 04:27 UTC equal the net of their prize and bounty legs to the cent
  (0 differ).
- Doors with no traffic, proved in one rolled-back DO block each (store check
  fired at the end): fn_agent_wallet_self_stake (one agent_wallet ->
  player_wallet leg, balanced); fn_club_promo_wallet_send to a player wallet
  and to an agent promo wallet (balanced); a stand-down with no leg on the
  legacy union promo fund (recorded in observe, refused in refuse - the live
  wiring of both modes).
- Club wallets and insurance banks: no function in pg_proc stands their
  journal trigger down or posts its own leg for them, so the trigger always
  writes their leg; they balance by construction.

## What changed

- Migration `20261002042417_every_chip_store_refuses`: the nine
  `ca_ledger_invariant_store_mode` rows become `refuse` (preimage: still
  observe, zero findings since 04:14:45); `fn_clawback_chips_atomic` is
  retired (pinned to md5 8f766700e80f50630983cb1fccbff194): it debited
  agents.player_balance (a mirror, 0.00 on every row) or the dead
  public.wallets pool and credited agents.business_balance, which
  sync_agent_wallet_columns turns into an agent_wallet_balance move that the
  column-listed journal trigger never sees. It had 0 uses.
- Law `tests/every-chip-store-balances-with-its-ledger-row.law.test.ts`
  requires the flip to be the last write to the store modes, and the retired
  clawback to move nothing.

## Follow-up outside this repo

The World Hub route `/api/club-arena/clawback-chips` still calls the retired
function; it now receives `clawback_retired` and moves nothing (the route
already reverts its claim note on a failed RPC).
