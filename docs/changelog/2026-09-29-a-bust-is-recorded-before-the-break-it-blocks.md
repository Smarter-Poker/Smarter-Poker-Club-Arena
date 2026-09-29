# A bust is recorded before the break it blocks (2026-09-29)

## What was seen

At 07:05 UTC on 2026-09-29 (engine 0b9d311c) consolidation of the big
freerolls was limited by table breaks refused at begin:

- $100 Freeroll 12:00 PM c65c414d: break 58d02750 `begin_refused:F06_WHOLE_ROSTER_REQUIRED`
- $100 Freeroll 6:00 PM cb8f2dd1: break 556f459a, same refusal
- Morning Free Buy 6a18ddaa: break f65919c7, same refusal
- $100 Freeroll 12:00 AM 4dddfe78: table c3294d1d, `F06_MOVEMENT_WHOLE_ROSTER_REQUIRED`
  on every table-engine readmission (30 times in 30 minutes), break 3d62aef7
  `park_requested` since 06:38

## What the rows said

Read at 07:10-07:17 UTC. Every source that refused held `playing` registrations
with 0 chips and no live seat, pointing at the source table:

| event    | table    | live seats | playing registrations | zero-chip, seat left at                                                            |
| -------- | -------- | ---------- | --------------------- | ---------------------------------------------------------------------------------- |
| c65c414d | f6cda79b | 2          | 3                     | cf17ebeb kayla.duval 07:06:20                                                       |
| c65c414d | 1b5e1fa6 | 1          | 2                     | 4533f594 EzraW 07:09:15                                                             |
| c65c414d | dac92fc4 | 1          | 2                     | 27ebd8e0 BLUFFROCK 07:04:18                                                         |
| 4dddfe78 | c3294d1d | 3          | 6                     | ef1baf0a, 171038e5 and a horse, all 0 chips                                         |

Platform-wide the same shape: c65c414d 6, cb8f2dd1 7, 6a18ddaa 1 and 4dddfe78
234 zero-chip `playing` players whose seats had left, none recorded (the last
elimination in c65c414d was 06:41, cb8f2dd1 06:45, 4dddfe78 06:20), while
c65c414d sat 6 funded players on 6 tables and cb8f2dd1 26 on 26: no table
could deal, and every table that could be broken held a bust nobody had
recorded.

## Root cause

Two lines, one on each side of the same ordering.

1. `fn_f06_begin_break` begins a break only when the proposal's length equals
   the source's live seats AND its `playing`/`registered` registrations. The
   hand's stack commit takes a busted player's seat and zeroes the
   registration in one transaction; the registration stays `playing` until
   the elimination sweep's bust stage records it. `prepareParkedTournamentBreak`
   built the proposal from the live seats alone, so the door counted one more
   person than the engine proposed and raised a bare
   `F06_WHOLE_ROSTER_REQUIRED` naming nobody. The movement prior
   (`f06_movement_prior`) counts the same way, which is the c3294d1d refusal.
   Re-reading the roster after the refusal (#5509) could not help: the re-read
   was of the seats again.

2. The bust stage is what clears it, and the bust stage did not run.
   `runEliminationSweep` continues from `TournamentSweepWorkCursor`, and the
   balance stage returns with the cursor still at stage 5 whenever its work
   spends the five-second budget. A table break does exactly that (park probe,
   roster read, destination read, begin; since #5583 a break visit is not cut
   by the budget at all), so a consolidating event's every admission resumed
   at the balance stage, visited the break, was refused because of the bust,
   ran out of budget and yielded at stage 5 again. The hand-complete
   zero-stack wake only asked for another sweep, which resumed at stage 5 too.
   The mirror image of drift incident 7ab0dcbe, where the bust stage held the
   cursor and the balancer never ran.

## The fix

- `TournamentSweepWorkCursor.rewindTo` / `beginAdmission`: an earlier stage
  may ask for its turn back; the request is applied at the next admission and
  never twice in a row. After one rewind the interrupted stage must be reached
  again (advanced past, or admitted with a fresh budget) before another is
  applied, so neither the bust stage nor the balance stage can starve the
  other.
- `wireEliminationWake`: a hand that leaves a player at zero calls
  `bustAwaitsItsStage()` (rewind to stage 0, whose bounty recovery must
  precede any bust) before it wakes the sweep.
- `prepareParkedTournamentBreak` reads the source's `playing`/`registered`
  registrations after the park and compares them with the live seats exactly
  as the door does (`breakSourceRoster.ts`): same people, same chair,
  `status = 'playing'`, chips within 0.5 of the stack. A zero-chip `playing`
  registration with no live seat is a bust not yet recorded: the break is not
  sent, the refusal names the player (`source_roster_disagrees:bust_unrecorded=...`),
  and the bust stage is given the next admission. Every other difference
  (`registration_without_seat`, `seat_without_registration`,
  `seat_registration_differ`, repeats) is still refused, now by name. An
  unreadable registration list is `source_registrations_unread`, never
  agreement. The door is unchanged and stays the authority.

No money moves in this change and no database function changes. Nothing is
backfilled: once the engine carrying this is live, each stuck event's next
admission records its busts through the ordinary knockout door, and its
breaks begin.

## Tests

- `server/src/tournament/aBustIsRecordedBeforeTheBreakItBlocks.law.test.ts`
  (new, with `docs/laws.d` entry).
- `aRefusedBreakRosterIsReread.law.test.ts`, `TournamentBreakProposalResolution.test.ts`
  and `aFullFieldIsNotTheLastTable.law.test.ts` give their source mocks the
  registration read.
