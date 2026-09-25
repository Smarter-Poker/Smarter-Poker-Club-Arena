# Presence is observed; custody is held (2026-09-24)

The 20:55 UTC engine release (run 36056765988) went further than any since
2026-09-22: every capture refusal cleared, every row proof passed, the
previous-work join settled, and the checkpoint wrote 79 tables' park rows
(`attemptedTables: 79, completedCalls: 79, bankCount: 239`). It then refused
`engine_state_changed` on the re-verification after the write, naming nothing:
that `require` was the process-wide one.

Every part of the capture signature but one is frozen by the break itself:
the hand number (parked), the roster and stacks (the Postgres freeze guard
refuses every seat write), the banks (no hand, no timer) and the residue and
disposed sets derived from them. The one part the freeze does not touch is
the disconnect FSM. A player's socket drops or comes back during the five
minutes exactly as at any other time, and on a live fleet of hundreds of
tables one of them will in the seconds between the capture and the write.
That is presence, which the successor re-observes from heartbeats within
seconds of adopting the row; it is not custody, and refusing the whole
release on it is the same forever-block one level up (CLAUDE.md 10.86 rule 4).

## The fix

The signature is split. CUSTODY - hand number, roster, banks, residue,
disposed - must not move between observations, and a move refuses exactly as
before, now naming its table and the field (`failedCheck custody`,
`observedDetail moved=<field>`). PRESENCE may change its values between
observations and the newest observation is adopted; its REGISTRY - which
players have a state at all - may not, because a player appearing in or
vanishing from it is a roster event the freeze forbids, and that still refuses
(`failedCheck presence.registry`). The readback holds the row's presence to the
same rule: the same players, each with a record, not the same bytes; the banks
and the hand number are still held byte for byte.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts`: a presence value that moves
between the capture and the write is adopted and the row is read against it;
a presence registry that changes still refuses and names it; a readback whose
presence names a different set of players still refuses; residue that moves
still refuses, now naming `custody` and `moved=residue`.
