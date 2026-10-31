# Open rebuy offers are read completely

TournamentManagerEliminations.answerOpenHorseRebuyOffers read only the first 80 pending offers. An unanswered prefix could repeatedly hide a later horse input until its original offer expired. Regression tests against the actual manager method fail before the change at 81 and 1,001 offers; a failed suffix was also treated as a completed prefix.

Read the open offer board by stable unique ID with the existing bounded complete-read helper before deciding. Retain hand order, existing human think times, stop/freeze fences, and the original atomic purchase/decline authority. An incomplete read remains pending in the existing bounded input continuation. No new timer or repair loop is introduced.

This is a reproduced input omission, not attribution of today's original-hand freezes. Verification: three regression failures before the fix; 37 real-manager/timing tests and 65 connected policy, purchase, refusal and native PostgreSQL money tests pass afterward. Root and server TypeScript compilers pass. Hosted qualification, activation and live proof remain pending.
