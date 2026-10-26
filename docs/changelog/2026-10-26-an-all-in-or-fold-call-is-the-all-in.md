# At an all-in-or-fold table, calling is the all-in

The all-in-or-fold menu is fold/all-in. The horse brain's authoritative menu check (`enforceAuthoritativeDecision` in HorseLogic) answered a `call` intent with its safe fallback whenever `call` was absent, before it ever looked for the all-in. The V27 big-blind-vs-jam chart and the priced-in guard both propose `call`, so at an AoF table every hand the brain decided to call was folded.

At an AoF table with money owed and the all-in legal, a `call` intent now becomes the all-in, which the controller settles as the call. Nothing owed still checks; fold and all-in are unchanged; menus off AoF tables are untouched.

Found by the 2026-10-26 horse decision audit. Latent: no AoF table or tournament was open (8 tables and 3 tournaments configured). `anAllInOrFoldCallIsTheAllIn.guard.test.ts` fails on the previous code and passes now.
