# An add-on that comes due during the :55 break is that break (2026-10-26)

Dan, 2026-10-25: "ADD ON BREAK SHOULD ONLY BE 60 SECONDS, UNLESS IT HAPPENS TO
BE AT THE SAME TIME AS THE :55 BREAK, THEN ITS 5 MINUTES, THEY ARE NOT THE SAME
BREAK".

## What was wrong

When late registration closed while the field was already away for the :55
break, `reconcileTournamentEntryWindow` set `pendingAddOnPeriod` and the add-on
opened only after `resumeFromBreak`. Every table came back from five minutes
away, and then stopped again for the add-on's own minute. Over the three days
to 2026-10-26, :01 was the most common minute for a paid add-on window to open
(20 events), which is that second stop.

## What changed

- `beginBreakCountdown` records the break's end in
  `synchronizedBreakEndsAtMs` (and the restart branch that re-adopts a running
  break does the same). `pauseForBreak` and `resumeFromBreak` clear it.
- A paid add-on that opens while the countdown is running persists
  `addon_period_ends_at = max(now + addon_break_minutes, break end)`
  (`coincidingSynchronizedBreakEndMs`). The break end is used only when it lies
  within one break plus its last-hand grace.
- An add-on due during the break's last hand (no end yet) waits in
  `pendingAddOnPeriod` and opens from `beginBreakCountdown`, inside the break.
  The old open-after-the-break path remains only for a break whose countdown
  never started.

The window's final configured minute is still the add-on break
(`addOnBreakStartMs`), so nothing else about the durable window changes: the :55
break holds every table until that minute, the add-on break takes the hold
over, and play resumes once, at the break end. Purchases are bounded by the
persisted window (`process_tournament_rebuy`), and the blind publisher pauses on
`on_break` and on the final minute, as before. Free Buy windows are untouched.

The host's add-on helper text in the create-tournament modal now says the same.

Pinned by `server/src/tournament/AnAddOnAtTheBreakIsTheBreak.test.ts`.
