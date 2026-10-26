# Late tournament entry keeps the four-game admission cap

The production `fn_enforce_booking_game_cap` returned before checking RUNNING
events. The seat trigger then honoured the newly purchased entry, so both gates
waived the same late registration. New RUNNING entries now take the existing
per-player transaction lock and load check before becoming paid commitments.
This applies equally to horses and people. Existing paid entries and chair
moves are preserved; no existing player, seat or balance is changed.

The existing required daily horse native owner executes the captured original
booking, load and seat functions in isolated PostgreSQL. It reproduces the
original fifth-entry bypass, checks refusal after the migration, races two late
entries for one remaining place, and verifies rollback, paid chair honouring,
registered-to-playing transitions and the existing one-hour booking rule.
The existing FourTableLimit source contract now reads trigger installation
from its original migration, as its seat-trigger test already did. Function
assertions continue to read the latest definition and pin RUNNING admission.

Advance bookings can still become simultaneous commitments later. This change
closes the demonstrated late-entry bypass; it does not cancel previously paid
entries or promise a scheduling interval policy for future events.
