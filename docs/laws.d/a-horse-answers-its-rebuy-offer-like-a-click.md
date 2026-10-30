# server/src/tournament/aHorseAnswersItsRebuyOfferLikeAClick.law.test.ts

A horse answers its tournament rebuy offer as soon as the zero-stack hand completes, on its own path outside the elimination scheduler and its work budget (answering only to manager stop and the maintenance freeze), so its 30 second offer is the same window a human's click gets (2026-10-24: 85 willing horses, 19 rebuys, in one freeroll).

A horse that declines tells the database through fn_decline_tournament_rebuy, the same RPC a human's "No" reaches through POST /reject_rebuy, so its offer closes at once instead of holding a PKO knocker's rebuy behind an unclaimed bust (2026-10-24: pko_predecessor_not_ready).

Ready inputs and future due moments remain independent of a different Horse's slow purchase response. At most four purchase responses are retained at once; an unresolved generation is not submitted twice locally. Unknown responses keep the original bounded continuation, and no new input is sent at or after its offer cutoff. Diagnostics distinguish choice, attempt and receipted success.
