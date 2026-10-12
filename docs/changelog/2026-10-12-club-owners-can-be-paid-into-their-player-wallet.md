# Club owners can be paid into their player wallet

Dan, 2026-10-11: "Club owners can play and have chips sent to their player
wallets. They currently aren't selectable to receive chips."

## What was wrong

The database was never the problem. Read from production on 2026-10-12:

- `fn_club_cashier_members` returns the owner in every staff roster (owner
  role rank 100), and the owner holds an active `club_members` row in all four
  chip clubs (Club JAQK, SHARK CLUB, Deep Stack Society, Midway Union). The
  only club without one is Diamond Arena, which holds no chips by design.
  `trg_club_owner_has_a_player_wallet` already creates that row for any new
  chip club, so no wallet row needs writing by hand.
- `fn_club_bank_send` credits `p_destination = 'player_wallet'` for an owner or
  co-owner, refuses it only for an admin, and has no self-send guard.

The client never asked it to. Every screen that spends the Club Bank chose the
destination from the recipient's role,
`canHoldAgentWallet(role) ? 'agent_wallet' : 'player_wallet'`, and an owner
"holds an agent wallet", so an owner - including the owner sending to himself -
was always paid into his agent float. Production had recorded exactly one Club
Bank send to an owner, ever: into his agent wallet. Not one Club Bank send into
any player wallet. On the Trade grid the owner's own row had no action at all,
and Send Out (`fn_agent_wallet_send`) correctly refuses a self-send.

## What changed

- `walletRows.holdsPlayerWallet(role)`: everyone but an admin (mirrors
  `fn_has_player_wallet`).
- `cashierModes.clubBankRecipientWallets` / `clubBankDestinationFor`: the
  wallets a Club Bank send may credit are the ones the recipient holds; when
  there are two, the sender chooses. The default stays the agent float, so
  Member Management's "fund the agent you just promoted" is unchanged.
- `ChipTransferModal` (Member Management, Agent Management) and the classic
  Cashier's Distribute tab offer "Into Agent Wallet / Into Player Wallet" when
  the Club Bank pays someone who holds both, and send the chosen one.
- Trade grid: the owner's own row offers **Fund Me**, which opens the Club Bank
  cashier with the owner preselected on their own player wallet. Shown only to
  a role that both spends the bank and holds a player wallet, and never inside
  a union house (no player wallet there).
- `WalletCashierModal` accepts a preset recipient and wallet, still gated by
  the same `blockFor`, and now marks an admin "No Player Wallet" instead of
  offering a player-wallet send the server refuses.

Every send still goes through `fn_club_bank_send` with its exact-intent retry
key and one `chip_transactions` row. No new money path, no migration.

Agent wallet sends are unchanged on purpose: `fn_agent_wallet_send` pays a
staff or agent recipient into their float whatever is asked ("agent to agent
always credits the agent wallet").

Union sends had no such filter: `fn_union_player_directory` lists each member
club's owner and the union cashier lets them be picked. Note that
`fn_union_send_to_member` derives the wallet server-side and pays any staff
recipient, an owner included, into their agent float; the owner then moves it
to play through the Club Bank route above. Changing that is a server decision
and was left alone here.

Pinned by `tests/a-club-owner-can-be-paid-into-their-player-wallet.law.test.ts`.
