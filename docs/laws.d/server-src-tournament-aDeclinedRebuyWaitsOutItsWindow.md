# server/src/tournament/aDeclinedRebuyWaitsOutItsWindow.law.test.ts

A busted tournament player whose rebuy decision is still open in the database, horse or human, is never sent to the knockout door; the elimination sweep asks for the pass that runs just after the earliest open deadline, so a declined rebuy is recorded once its window closes instead of being refused on every pass.
