# Cashier Sends A Ticket Into One Tournament (2026-10-15)

## The Request

Dan, verbatim: "SEND TICKET" SHOULD HAVE A DROP DOWN WHERE ANY AND ALL "FUTURE
OR CURRENTLY RUNNING TOURNAMENTS" SHOULD BE DISPLAYED TO "SELECT" AND AWARD
THAT USER A TICKET INTO THAT TOURNAMENT. FUNDS SHOULD BE SUBTRACTED FROM THE
SENDERS BALANCE.

This change is the server side and a typed client service. The Cashier Trade
page wiring is owned separately.

## What Shipped

Migration `20261015132042_cashier_sends_a_ticket_into_one_tournament.sql`
(one transaction, `lock_timeout` 5s, every replaced body pinned to the
production md5 read at 13:20 UTC today, structural postimage checks).

| Object | Kind | Who can call it |
| --- | --- | --- |
| `fn_cashier_ticketable_tournaments(p_club_id)` | the drop-down | authenticated (issuing roles only) |
| `fn_issue_tournament_entry_ticket(p_club_id, p_holder_id, p_tournament_id, p_note, p_idempotency_key, p_expected_price)` | the money door | authenticated |
| `fn_cashier_batch_transfer` | a `ticket` item may carry `tournament_id` | authenticated (unchanged) |
| `tournament_ticket_entry_targets` | immutable binding, ticket to one tournament | read: issuer, holder, full-scope cashier |
| `fn_ca_use_cashier_entry_ticket` | the entry | owner only (reached through the ticket gates) |
| `fn_ca_settle_closed_cashier_entry_tickets` | the closed-tournament settlement | owner only (reached through the closing trigger) |
| `fn_ca_find_cashier_entry_ticket_for`, `fn_ca_cashier_ticket_target_state`, `fn_ca_cashier_ticket_target_in_club` | helpers | owner only |

Replaced, behaviour otherwise unchanged: `fn_find_tournament_entry_ticket`,
`fn_register_for_tournament_with_ticket_before_terminal_gate`,
`fn_register_horse_for_tournament_before_terminal_gate`,
`fn_horse_tournament_entry_ticket_hints`, `fn_redeem_tournament_ticket`,
`fn_cashier_batch_transfer`, `trg_ca_closed_target_pays_its_satellite_tickets`.

## How The Money Moves

1. **Send.** The price is `fn_tournament_entry_split` of the tournament
   (buy-in + fee, with the bounty split out). The sender's player wallet is
   charged exactly that through the existing
   `fn_issue_tournament_ticket_phase2_core_20260831`: same roles, same downline
   rule, same `ticket_issue` journal to the ticket escrow, same
   `tournament_ticket_issue` receipt. The binding row is written in the same
   transaction. A retry with the same key returns the original.
2. **Enter.** The holder presses Register on that tournament. The ticket finder
   offers the bound ticket when no satellite ticket applies, and the ticket
   gate routes it to `fn_ca_use_cashier_entry_ticket`, which in ONE transaction
   releases the escrow to the holder's wallet in the ticket's club (the
   `ticket_redeem` journal and one `tournament_ticket_redeem` receipt, exactly
   as `fn_redeem_tournament_ticket`) and enters the holder through the ordinary
   wallet door: `fn_register_for_tournament_before_terminal_seat_gate` for a
   person, `fn_register_horse_for_tournament_before_atomic_lifecycle_gate` for a
   horse. The wallet in the ticket's club must end exactly where it started, or
   the whole entry rolls back. A refused entry (full, closed) returns the
   reason and leaves the ticket issued.
3. **Unused.** In the transaction that finalizes, finishes or cancels the
   tournament, every still-issued bound ticket is paid to the holder in cash
   (the seat_or_cash rule of 20261012054804), or, if the holder is no longer an
   active member of the ticket's club, returned to the issuer. One receipt per
   ticket. Nothing is left for a later job (CLAUDE.md 10.12).
4. **Cancel.** The issuer can cancel an unused ticket with the existing
   `fn_cancel_tournament_ticket`; the escrow returns to the issuer.
5. **Redeem.** The holder cannot turn a bound ticket into chips.

## Why Not An Entry-Only Ticket

`tournament_tickets` already has a noncash `tournament_entry_only` mode. Its
CHECK constraint admits only system-issued tickets with satellite provenance,
and the refund and cancellation doors downstream of a ticket admission compare
`source_satellite_id` with `=`. A cashier ticket has no satellite, so that
comparison is NULL, and cancelling any tournament holding one such entrant
would raise "refund entitlement lost its exact funded source" and roll back the
cancellation for every entrant. Widening that rail means rewriting a dozen
large money functions (`atomic_cancel_tournament`,
`fn_settle_tournament_refund_exact`, `fn_ca_return_satellite_entitlement_as_ticket`
and their receipts) without being able to execute them against production
first. Entering through the wallet door keeps every one of them unchanged.

The consequence, stated plainly: once entered, the holder is an ordinary wallet
entrant, so an unregistration or a cancellation refunds the holder in chips,
not a fresh ticket.

## Horses

A horse holding a bound ticket is hinted to it by
`fn_horse_tournament_entry_ticket_hints`, and the horse gate enters it through
the same `fn_ca_use_cashier_entry_ticket` a person uses. `is_horse` is read
only to pick the horse's input device (the engine-driven entry door), never to
deny or reduce anything (CLAUDE.md 10.5).

## Proof

- Production read only (SELECT): every replaced and relied-on body read with
  `pg_get_functiondef` and pinned by md5; no object name collides.
- An isolated PostgreSQL 16 with the transcribed production issue core, cancel
  door, entry split, club resolver and late-registration reader, plus simulated
  wallet entry doors: the migration applied (preimage block removed, postimage
  block kept) and 56 assertions passed: listing scope and price, issue,
  replay, key misuse, duplicate, stale price, closed, other club, full; redeem
  refused; finder; holder entry nets to zero, one receipt, journal convention,
  replay; refused entry leaves nothing behind; another player refused; horse
  hinted and entered; close pays the active holder and returns a departed
  holder's ticket to the issuer; issuer cancel; binding immutable; batch
  routing and unchanged plain items; conservation of every chip.
- The batch and redeem replacement hashes in
  `scripts/verification-harness/cashier-release-contract.sql` were computed
  from the migration text and confirmed in that PostgreSQL. Re-read them live
  after the apply.

## Not Yet Done

- Applying the migration to production (outside :50-:03 UTC) and reading the
  postimage back.
- Wiring `src/services/CashierTournamentTickets.ts` into the Send Ticket form.
- Adding the two new public RPCs to the cashier release contract once they are
  live.
