# Buy-In Result Stays Visible

The initial callback hardening did not close the full silent-failure path:
TablePage closed the sheet before its request answered and caught refusals
internally, so BuyInModal had no failure result to display.

The cash callback now returns an explicit boolean through TableModalsLayer.
The modal stays open while the request runs, with its existing Joining state.
On an unsuccessful result it displays an inline message that does not claim
that chips were unchanged. The selected seat remains available for an explicit
retry. Only a confirmed purchase closes the sheet and clears the selection.
The seat still paints optimistically underneath, preserving immediate felt
feedback. A post-commit notification failure cannot revert a confirmed seat.

The decision-window guard now includes buyInProcessingRef both when arming
and at expiry, so retaining the sheet cannot revive the older paid-seat timer
bug. Existing tournament guards remain in place and their pins were updated
to require the added cash guard.

29 focused tests passed across actual callback execution, real modal rendering,
and the paid-seat decision-window laws. Client tsc --noEmit passed.
No live purchases or database migrations were performed.

Remaining: an indefinitely stalled mutation still needs a bounded request and
durable receipt reconciliation. Transport failure remains an unknown outcome,
and cancellation/reload must eventually preserve the request key and exact
payload until resolved. This change makes pending/failure visible; it does not
claim that unknown-outcome durability is finished.
