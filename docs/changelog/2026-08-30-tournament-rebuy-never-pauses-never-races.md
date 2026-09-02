# 2026-08-30 — Tournament rebuys: never a pause, never a race

Agent: Claude (Cowork, local). Phase 4 of the day's audit, triggered live: Dan
rebought into the restarted Sunday $200 (debit 21:13:57.405), the bust sweep
eliminated him off its pre-rebuy snapshot (21:13:57.911) and vacated the seat
(21:13:59.162). Row restored immediately (restore_rebuy_eliminated_player_
kingfish); this ships the fixes so it cannot recur.

Dan's directive, verbatim: "REBUYS IN A TOURNAMENT SHOULD NOT PAUSE THE
ACTION, IT SHOUD TRIGGER THE REBUY OFFER, THEN SIT THE PLAYER REBUYING AT ANY
TABLE THAT NEEDS TO BE BALANCED, OR AT ANY SEAT THAT IS OPEN OR WHERE A
PLAYER IS NEEDED FIRST, IF THEY TRULY SHOULD BE IN THE SAME TABLE, SAME SEAT,
ITS ALLOWED."

## What changed

1. RACE KILLED. eliminatePlayer's CAS now also requires chips <= 0. A rebuy
   leaves status 'playing', so the status guard alone could never catch the
   race; the chips guard makes the landed rebuy win, atomically.
2. DECISION WINDOW MOVED OFF THE FELT. Tournament tables no longer pause on a
   bust (the cash-game 5s pause of section 10.5 is untouched). Instead the
   elimination sweep holds a 30s grace (REBUY_DECISION_GRACE_MS) for any
   busted player whose rebuy window is open. Horses answer inside
   tryTournamentRebuys in the same pass — the identical window, answered
   instantly by their input device, per section 10.5's allowed branch 2.
3. SEATLESS REBUY. process_tournament_rebuy no longer demands a live seat for
   'rebuy'/'reentry' (add-ons still do). Chips land on the player row,
   elimination stamps clear (never over a paid prize), and
   ensureLateRegSeated seats the player at the table that most needs one —
   same table, same seat included when that is where the need is.

## Verification

rebuyNeverRaces.guard.test.ts pins all three; horsesAreTreatedIdentically and
the SitOutClock pins stay green (cash pause untouched); server typecheck
clean. RPC redefinition applied to production before the code merge, so the
window between them only widens behavior (seatless rebuys succeed) and
narrows nothing.
