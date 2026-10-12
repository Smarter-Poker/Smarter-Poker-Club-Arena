# A Declined Rebuy Waits Out Its Window

**Date:** 2026-10-09

In a rebuy or Free Buy event, a horse that declined its rebuy was sent to the knockout door the moment it declined. The door refuses a bust whose knockout generation still holds an open rebuy deadline (`rebuy_decision_open`), and nothing closed that deadline early, so every declining horse was refused on every elimination pass for the rest of its 30 seconds. In three hours on 2026-10-09 that was 345 refusals across two Free Buy events, each reported as `Tournament.elimination_write_failed`, each counted toward the bust-refusal streak (which then reported `Tournament.bust_blocked_player_skipped`), and each ending the assignment pass for every player busted after it, which slowed recording the rest of the field.

A busted player whose decision is still open, horse or human, is now left out of the pass, and the sweep asks for the pass that runs 250 ms after the earliest open deadline. The bust is recorded once, as soon as the door will accept it. Nothing about the window itself changed: it is still the 30 seconds the database grants.

Law: `server/src/tournament/aDeclinedRebuyWaitsOutItsWindow.law.test.ts`. The `rebuyNeverRaces` guard now pins the same rule.
