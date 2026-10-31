# Premium sound imports retain their requested cue

The October 29 TypeError inventory contains 97 occurrences across 82 records.
The inherited diagnosis already accounted for all of them: five Share Hand
null-rank crashes repaired in PR8746, 84 engine HTTP fetch failures, seven
welcome-access fetch failures, and one rejected PremiumSFX module import.
The transport failures' historical causes remain unknown; this change does
not certify them as repaired or suppress their reports.

The sound event now uses the existing bounded, non-reloading import retry.
Playback occurs once after loading, outside the retry, preserving each cue
and the synthesizer's existing sound setting. Final loading or playback
failure reaches a named local error boundary. A rejected promise is not cached
by this event helper, so a later interaction can attempt loading again.

The actual-source host with the real import utility fails three cases before
the fix and passes afterward: transient import failure with two owed cues,
bounded exhaustion followed by a fresh interaction, and a playback exception
that must never duplicate sound. The existing disabled/enabled sound behavior
continues through the same synthesizer calls. No asset-retention, game,
financial, navigation or global error-handler behavior changes.
