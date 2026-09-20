# server/src/tournament/aRuleRefusalStopsAskingEveryFiveSeconds.law.test.ts

Tests: `server/src/tournament/aRuleRefusalStopsAskingEveryFiveSeconds.law.test.ts`.

A refused finish still asks for another pass, which is the 2026-09-09 law. It no
longer asks on a five-second clock for a reason that cannot change on its own. A
deadlock victim and a statement timeout keep
`TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS`; every other classified reason
gets one pass at that base and then doubles to a fifteen-minute cap, which is
inside the hour between maintenance breaks so a corrected fee is still noticed
promptly. The critical money alert is raised the first time a tournament reports
a reason and counted in
`poker_tournament_finish_refusal_alerts_suppressed_total` on every repeat, so the
rate lives in `poker_tournament_finish_refusals_total` where a rule can read it
instead of in an operator's inbox. A committed settlement clears the streak.

Seventeen cases. Written 2026-09-18, after the elimination scheduler was measured
holding 652 queued tournaments against four slots with its oldest wait at 469
seconds, because 547 decided tournaments were re-asking a rule refusal every
five seconds and raising a critical alert each time.
