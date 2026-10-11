# A Provisional Place Is Not An Error

2026-10-11, swarm lane D (tournament engine log sources).

## What Was Reported

Two engine log sources reported designed behaviour as errors on the current engine (f47ad93c):

- `TournamentManager.finishing_ladder_exhausted`, 15 times between 18:06 and 18:13 UTC, all from Coffee Break Freeroll (PLO4) 7aace408. Each line said places were handed out too high and the standings needed renumbering.
- `Tournament.elimination_check_error` with `retirement_custody_stale`, once at 18:00:43 UTC, the first sweep after the 18:00 thaw.

## What Was Actually Happening

**The ladder.** 7aace408 had 178 entrants. Players busted from 17:44 while late registration was still open until 17:51. A bust recorded while the field is still growing takes the place the field had at that moment, so every later entrant left those early places one too low. After registration closed, the ladder ran 15 places low and ran out at seed 16 at 18:06. The sweep then did what it was built to do: it placed each player at the lowest free place above the seed instead of leaving them stuck. Nothing was wrong with the money. The finish derives every place again from when each bust happened before anything is paid. 7aace408 finished at 18:14 with 178 distinct places in bust order, and its 18 prizes (169.20, the whole pool) were paid at the finish. Nobody has to renumber anything, so the error report was noise. The branch now writes a log line instead. A ladder with no free place at all is still reported as critical.

**The yield.** A break retirement checks the sweep's work budget at every step. When a slow call spends the budget part way through, the custody throws `retirement_custody_stale`, keeps its reservation, and the sweep requeues itself. That is the designed yield. It is now logged instead of reported, but only when the budget really has expired. The same error with budget left (a lost lease or a replaced lifecycle) is still reported, and so is everything else. The other 56 `elimination_check_error` lines in the same period were `fn_f06_discover_breaks` timeouts during the 18:15 to 18:53 database slowdown; those are still reported.

## Files

- `server/src/tournament/TournamentManagerEliminations.ts`
- `server/src/tournament/retirementYield.ts`
- `server/src/tournament/aProvisionalPlaceIsNotAnError.law.test.ts` and `docs/laws.d/server-src-tournament-aProvisionalPlaceIsNotAnError.md`
