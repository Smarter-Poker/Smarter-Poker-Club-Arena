# A move the destination has already dealt is not in transit (2026-09-24)

The 19:55 UTC engine release (run 36050875490) was the first since 2026-09-22
whose legacy checkpoint finished its residue proof inside the publisher's
budget (#5211), and it refused with a name:

```
proveBanksHeldNothing.seatMoveInTransit  table e4e522db
```

A cash seat move executed at 19:34:31 into that table, twenty-one minutes
before the checkpoint, inside the guard's one-hour "a handoff could still be
claimed" window. The rows say what the window cannot: the destination had
dealt that player thirty-three hands since (`hand_history.players[].userId`,
first at 19:35:39). Once the destination has dealt the seat a hand after the
move, the bank is live there (the deal seeds it,
ServerTableEngineDealing.ts:3036) and 8825 never applies a carried bank or
presence over a live one (:4233), so the deposit can no longer change
anything whether it is claimed or not.

The hour was also a window that is almost never open: this fleet executes a
cash seat move every few minutes (414 receipts on 2026-09-24), so "no move in
the last hour" would have refused nearly every break for ever - the same
forever-block one level up that CLAUDE.md 10.86 rule 4 describes.

## The fix

A move inside the hour is asked one more question, from rows: has
`hand_history` recorded a hand at the destination table, after the move
executed, with that player in it? One row is enough (sub-millisecond on
`idx_hand_history_table_created_id`, measured). No row, an error or an
unreadable answer keeps the refusal exactly as it was. `bankDisposition`
records `arrivalsDealtSince`.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts`: a move inside the hour is
accepted once a hand has been dealt to that player since; no hand, an
unreadable answer or a row it cannot read still refuses; a move older than an
hour asks nothing.
