# Management Sees Every Cash Out Request (2026-10-23)

Dan: "MAKE SURE THAT ALL CASH GAMES ARE NO RAT HOLE ... OWNERS, CO OWNERS OR
ADMINS SHOULD BE ABLE TO SEE ALL CASH OUT REQUESTS AND PULL THOSE CHIPS. THEY
SHOULDN'T GET THE NOTIFICATION, BUT IF THEY GO TO A PLAYERS ACCOUNT, THEY SHOULD
BE ABLE TO SEE 'CASH OUT REQUESTED'. THERE SHOULD BE AN ICON ON THE CASHIER THAT
MANAGEMENT AND OWNERS CAN SEE, BELOW THE CURRENT 'REQUEST CASH OUT'."

## No rathole: verified, already universal

Read from production, not assumed:

- `fn_cash_session_close` writes a rejoin floor for every cash exit where the
  departing stack is above the session baseline (buy-in plus add-ons), keyed
  on club + variant + small blind + big blind, for 7,200,000 ms (2 hours). It
  does not read `tables.no_rathole`: every cash game is covered.
- `atomic_table_buyin`, `fn_ca_cash_entry_need`, `fn_cash_effective_buyin`,
  `fn_cash_game_join`, `fn_offer_open_seat` and horse seating all read
  `fn_cash_rejoin_floor`; a buy-in under it is refused with
  `BUYIN_BELOW_FLOOR`. The floor is capped at the table maximum.
- Every cash exit in the last two days went through `fn_cash_session_close`
  (voluntary 10,879, system 1,306, VPIP eviction 15).
- Of 2,601 re-entries in the last two days within two hours of a winning
  exit at the same stakes, **0** bought in below the floor.

No change was needed.

## Cash out requests for management

- Cashier: a **Cash Out Requests** button directly below Request Cash Out,
  shown to owners, co-owners and admins, with the pending count. It opens the
  existing approval panel (Approve moves the verified hold into the
  approver's agent wallet; Reject returns it to the player).
- Cashier roster: a player with a pending request reads "Cash Out Requested".
- Member record: a "Cash Out Requested" chip, and the request with its
  Approve / Reject actions.
- Scope is the server's `fn_cashout_queue` (owner/co-owner/admin see every
  request in the club; agents see their own and their downline). Approval
  authority is unchanged (`fn_club_cashier_scope = 'all'` for management).

## The notification

Root cause: `fn_cashier_cashout_transition` built every cashier document's
audience as {club owner, player, assigned agent}, and
`fn_deliver_accounting_invoice` sends a messenger invoice and a bell/push to
every member of it, so the owner was notified of every request in the club.
Migration `20261023161137` makes a HOLD's audience {player, assigned agent}.
The agent still gets the request message and the player still gets the
approval message. Delivery assertions compare deliveries to the same array, so
they stay consistent.

Law: `tests/management-sees-every-cash-out-request.law.test.ts`.
