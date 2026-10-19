# The Lightning player witness taps a hand painted after its preflight

The private Action player witness (run 39315415767, 20:04Z, pool c5a84f27)
rendered and fit the phone, tablet and desktop, and Fast Fold was accepted
with the next hand painted on the phone and the tablet. The desktop Fast Fold
was refused by the engine with the native code `NO_ACTIVE_HAND`: the room had
no hand being dealt when the tap arrived.

The witness tapped the hand it had seen before its scope preflight. That
preflight is six sequential database reads from the hosted runner, long
enough for a fast Lightning hand to end (or for the horse's own normal input to
act) under a waiting tap. The engine refused correctly; the stale tap was the
witness's.

Each tap now waits, after the preflight reads and before sending anything, for
a hand painted after the preflight began. Nothing is sent while waiting, a
refused fold still stops the witness exactly as before (no re-attempt), and no
engine, client, horse, matcher or mode behaviour changes. The regression fails
before (taps reuse the hand that was on screen at the preflight) and passes
after; the witness operator tests pass.
