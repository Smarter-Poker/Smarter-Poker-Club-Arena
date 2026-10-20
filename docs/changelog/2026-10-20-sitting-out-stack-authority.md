# Sitting-Out Stack Authority

Live observation showed KingFish's sitting-out seat displaying the original
400 buy-in while the authoritative seat row held 528.70. Reopening the page
restored 528.70 because it cleared the pending buy-in ref.

In `TablePage.tsx`, the placeholder used the pending buy-in before the seat
row balance. That ref persists until leaving, so it remained eligible after
playing hands. The placeholder now prefers a known seat balance, including
zero. An unread seat balance is represented by null, so a newly confirmed
buy-in still displays before its first row read. No chips or server state
are changed by this presentation fix.

A newly confirmed purchase also invalidates the prior occupancy's row balance.
Receipt recovery keeps the current balance, since an old receipt is not a new
seat. The actual buy-in callback regression pins this boundary.
The first valid seat read retires the pending buy-in, so a later missing row
cannot resurrect an obsolete purchase value.

The regression executes the actual placeholder branch with the observed
400/528.70 inputs, a confirmed zero, and a not-yet-read seat. Both balance
cases failed before the repair. The existing I'm Back source contract is
updated to pin the corrected precedence. Delivery and live verification are
recorded separately in the task checkpoint; this note is not a live pass.
