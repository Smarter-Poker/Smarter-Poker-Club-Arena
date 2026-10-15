# Cashier Send Dialogs Overhaul

Dan, 2026-10-15, on the Cashier Trade grid and its three actions.

## Roster: Tap Selects, Double Tap Opens

One tap anywhere on a row checks it, including the owner's own row when the
Club Bank can pay it. A second tap on the same row within 350 ms undoes that
toggle and opens the member's Player Management record. The name is still a
real link for the keyboard (Enter opens it). The per-row Select control now
toggles instead of opening Send Out.

## Sending To Yourself

An agent wallet cannot pay its own holder (`fn_agent_wallet_send` refuses it),
so a Send Out to your own row is paid by the Club Bank into your player wallet
through `fn_club_bank_send`, the same audited path Fund Me used, keyed by a
reserved operation id. It goes on its own, never mixed into a batch.

## Action Bar

Claim Back, Send Ticket and Send Out sit in a frame derived from the approved
footer master (`club-arena-footer-v2.webp`): its six emblems were lifted out
by random-column synthesis of its own quilt (period 78.17 px measured), giving
`public/images/cashier-actions/cashier-action-bar-v1.png` at the master's
native 1916 x 256.

## Send Out, Claim Back, Send Ticket

All three share one simple layout on approved shells: the player in the
portrait ring of `action-primary-shell` (avatar or generated Club Arena
avatar, large name, player ID, large balance), the sender's wallet and live
balance on `wallet-row-shell`, and a real entry field in the same shell. The
explanatory paragraphs and "Amount Per Player" are gone.

## Claim Back For Owners, Co Owners And Admins

They claim any amount a selected player holds, at any time, into the Club Bank
through `fn_club_bank_claim_back` (player wallet source). Every other role keeps
the ten minute reversal anchored on its own send.

## Send Ticket Into One Tournament

Send Ticket lists every future or running tournament the club's cashier may
ticket (`fn_cashier_ticketable_tournaments`); the ticket is priced by the server
from the chosen tournament and paid from the sender's player wallet. Its retry
keys and recovery journal are bound to the tournament. Server side:
`docs/changelog/2026-10-15-cashier-sends-a-ticket-into-one-tournament.md`.
