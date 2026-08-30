# 2026-08-30 — All-in always shows, busts clear fast

Agent: Claude (Cowork, local). Two rulings from Dan, live from the restarted
Sunday $200 (verbatim quotes carried at each governed site).

1. NO SHOW HAND BUTTON ON A TOURNAMENT ALL-IN. The engine already reveals
   every all-in hand for the whole runout (ServerTableEngineRunout's reveal
   flag), so the voluntary-show button had nothing to offer and appeared
   anyway. TablePage now suppresses it when the hand had an all-in
   (handHadAllInRef, set on the first all_in_equity broadcast, cleared at the
   next deal so it cannot pop in late during the post-hand hold).

2. THE 0%/100% OVERLAY GETS HALF A SECOND. HAND_COMPLETE arms a 500ms clear
   of allInEquities instead of letting the overlay live through the whole
   post-hand hold.

3. BUSTED PLAYERS DO NOT LINGER. The dealing loop vacates stack-0 tournament
   seats the moment the busting hand settles (guarded .lte('stack', 0) so a
   just-landed rebuy keeps its seat), broadcasting seat_left. Their
   tournament life is untouched: the elimination sweep's rebuy grace holds
   the entry, the client rebuy offer stands, and a taken rebuy re-seats via
   the seatless path wherever a player is needed.

4. LATENT CHIP MINT CLOSED. ensureLateRegSeated used to seat a zero-chip
   'playing' entrant with a FREE startingChips stack — unreachable while
   busted players kept their seats, live the moment they do not. Zero-chip
   playing entrants are now skipped (they are either mid-rebuy-decision or
   about to be eliminated).

Also repaired in passing (fix-first): rebuyNeverRaces.guard.test.ts used
fixed-size source windows, which reddened noFixedSizeSourceWindows on any
client-touching branch; rewritten on sliceBetween.

Pins: tests/unit/allInShowsAndBustsClear.law.test.ts (5). Suites: 671 client
test files and 1,762 server tests green; both typechecks clean.
