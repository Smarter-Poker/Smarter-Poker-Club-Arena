# Union Bank shows each club's balance

Dan, 2026-10-21: "WHEN I AM IN THE UNION BANK AND I SELECT A CLUB, I NEED TO BE ABLE TO SEE THE CLUBS BALANCES. THEY ARE CURRENTLY BLANK."

Club money columns (`clubs.chip_treasury`, `clubs.promo_balance`) are withheld from browser reads, and `fn_club_money_panel` shows club money only to that club's own owner, co-owner or admin. So the union lead pulling chips back from a club could not see what the club held.

- New read-only `fn_union_club_bank_balances(p_union_id)` (SECURITY DEFINER, `auth.uid()` checked): one row per club in the union with its Club Bank, club Promo Wallet and the opening-grant floor a clawback may not cross. It answers only the union owner or a `union_lead`, the same people `fn_union_clawback_from_club` lets move that money. Everyone else is refused before anything is read.
- Union Bank: every club row shows its balance (Club Bank, or Promo Wallet on the promo wallet). The pull screen shows the selected club's balance and, for a Club Bank with an opening grant, how much is pullable. A pull past that is refused on screen with the reason instead of after a round trip. Balances re-read after every confirmed movement.
- A refused or failed balance read never hides the clubs and never shows 0: the figure is simply absent.

Tests: `tests/union-bank-club-balances.test.ts` (parsing, pull floor, authority in the migration) and two cases in `tests/union-wallet-modal.test.tsx` (figures shown, floor refusal, refused read still lists clubs).
