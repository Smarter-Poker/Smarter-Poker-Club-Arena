# A pre-start unregistration refund does not block a satellite (2026-10-03)

## Symptom

Satellite 65e8497e "Sunday Deep Stack Satellite $5" reached one player at 01:43 UTC
and could not finish. Every atomic finish was refused with "satellite ... has partial
or legacy settlement evidence", the winner stayed unpaid, and two critical drift
incidents (c9f59d93, a3160e84) reset the 24-hour burn-in gate.

## Cause

One row in `tournament_obligations`: kind `refund`, source
`fn_unregister_from_tournament`, 5.00 owed and paid, settled 2026-10-02 19:04 - a
player who unregistered before the start. The satellite settlement demands that a new
settlement start with no obligation rows at all, and its receipt demands the
obligation count equal the cash tickets plus one remainder. A settled pre-start refund
is neither, so any satellite with an unregistration could never finish.

## Fix

Migration `20261003023500_a_pre_start_unregistration_refund_does_not_block_a_satellite`
ignores exactly that row shape (refund, fn_unregister_from_tournament, settled, paid in
full) in the fresh-settlement guard of both satellite settlement entries and in the
receipt's obligation count. Every other obligation still refuses. Proved first in a
rolled-back production transaction: the satellite settled, pool 200.00, one 200.00
target ticket to the winner, fee bank 12.00 recognized, receipt fully settled.
