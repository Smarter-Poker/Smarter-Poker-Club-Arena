# Verify an explicit chip landing after its observed recipient leaves

Proof 39309637088 recorded a payout winner leaving before the chip's explicit
landed phase. The witness could no longer find that recipient in the DOM,
returned an unknown distance and later called the disappearing chip a failure.
The trace retained an explicit landing at the flight's launch-time destination;
that application destination is not independent proof of recipient geometry.

The witness now separately retains the actual recipient seat plate rectangle
observed for each flight. It always measures a present recipient afresh,
including replacement nodes and changed geometry. Only after that recorded
recipient node disconnects may an explicit landed chip be compared against the
last actual observed rectangle. The chip center still must land within 2px.
No animation destination, guessed seat or distance waiver supplies success.

A connected but hidden/unmeasurable recipient invalidates the saved target.
Unknown first targets, flying removal after departure and departed-target
overshoots remain failures. Unverified flights now stay in diagnostics with
flight ID, last distance, target provenance/rectangle, observation time and
recipient departure time. They never enter the verified landing list.

Focused regression: 4 failed and 48 passed before the fix; all 52 passed after.
Cases cover actual explicit landing after departure, overshoot, unknown target,
live hidden target, fresh replacement geometry and flying removal. Existing
river ordering, every-positive-recipient, both run counts, exact identities,
strict continuity and the original 120-second/20-minute budgets are unchanged.
This changes verification evidence only; production behavior remains subject
to the next actual natural-hand proof.
