# server/src/tournament/oneFinishPerClubIsAskedAtATime.law.test.ts

A terminal finish for a club is sent to fn_complete_tournament_terminal only after that club's previous attempt answered, in arrival order, so finishes wait in the engine instead of in the bank-scope lock queue where the 8 s lock_timeout cancels them; other clubs and un-noted tournaments are not held (2026-10-03).
