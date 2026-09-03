# WALLET SYSTEM — Agent Skill Reference

## Triple Wallet Architecture

Every user has three wallet types:

1. **PLAYER** — Gameplay wallet (buy-ins, prizes, cashouts)
2. **BUSINESS** — Commission/rake income (club owners, agents)
3. **PROMO** — Bonus/promotional chips (freerolls, referral rewards)

## Key RPCs (SECURITY DEFINER — bypass RLS)

- `credit_player_wallet(p_user_id, p_amount)` — Add chips to PLAYER wallet
- `deduct_player_wallet(p_user_id, p_amount)` — Remove chips from PLAYER wallet (returns false if insufficient)
- `log_wallet_transaction(p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id)` — Audit log

## Transaction Types

- `credit` / `debit` — Direction of the transaction
- Categories: `buy_in`, `cash_out`, `prize`, `rebuy`, `addon`, `refund`, `rake`, `bounty`, `transfer`, `deposit`, `withdrawal`, `insurance`, `tip`

## Key Rules

- ALL wallet transactions happen through the agents cashier button
- EVERY transaction MUST be logged in wallet_transactions
- NO rounding — exact cent precision: `Math.trunc(value * 100) / 100`
- NEVER use $ anywhere in display

## Files

- `src/services/WalletService.ts` — Client-side wallet operations
- `src/pages/PlayerWalletPage.tsx` — Player wallet UI
- `src/components/table/CashierModal.tsx` — Table cashier
- `src/components/table/BuyInModal.tsx` — Table buy-in

## Flow: Tournament Buy-In

1. Player clicks "Register" on tournament detail page
2. `TournamentService.registerForTournament()` called
3. `deduct_player_wallet` RPC deducts buy_in + fee
4. `log_wallet_transaction` logs the deduction
5. `tournament_players` record created

## Flow: Tournament Prize Payout

1. Player eliminated at paid position
2. Prize = `Math.trunc(prize_pool * percentage / 100 * 100) / 100`
3. `credit_player_wallet` RPC credits prize
4. `log_wallet_transaction` logs the credit
5. `tournament_players.prize` updated

## Flow: Tournament Rake Settlement

1. Tournament finishes
2. Total rake = buy_in_fee \* total_entries
3. If club in union → rake goes to union owner
4. If standalone club → rake goes to club owner
5. Logged as category `rake`
