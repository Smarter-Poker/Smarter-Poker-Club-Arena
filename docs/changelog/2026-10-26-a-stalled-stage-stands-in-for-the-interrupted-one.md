# A stalled stage stands in for the interrupted one (2026-10-26)

## What was happening

After the bust fix (2026-10-25) went live, busts recorded in batches again,
but a few still waited minutes. Read from the engine log and
`tournament_knockout_candidates`: Sunday Funday Mystery d5d373cb read no bust
at all from 02:40:09 to 02:44:06 UTC. 55 of the 61 slow busts that evening
landed while a table break was in progress.

## Root cause

`TournamentSweepWorkCursor` lets a newly seen bust rewind the sweep to the
elimination stage. The first rewind remembers the stage it interrupted and
refuses any further rewind until the pass gets back to that stage, so a busy
event cannot starve its later stages.

During a table break the rewound pass stops short of the interrupted stage at
a stage of its own that yields on the five-second budget without advancing:
the break waits for the busts on its source table to be recorded, and the
busts wait for the break. The interrupted stage was never reached, so the
guard never cleared, and every new bust's rewind was held until the break
gave up on its own.

## Fix

`server/src/tournament/TournamentSweepWorkCursor.ts`: while a rewind's guard
is held, the cursor remembers where each admission started. A stage that
starts two admissions in a row has had a whole fresh admission of its own,
which is all the guard promises the interrupted stage, so it releases the
guard exactly as reaching the interrupted stage does. A pass that is still
advancing behaves exactly as before.

Pinned by two new cases in
`server/src/tournament/aBustIsRecordedBeforeTheBreakItBlocks.law.test.ts`:
the stalled stage lets the next rewind apply (fails on the old cursor), and a
pass that keeps advancing still reaches the interrupted stage first.

## Damage

None to settle. Busts were recorded late, never wrong; the late ones were
all recorded once the break gave up.
