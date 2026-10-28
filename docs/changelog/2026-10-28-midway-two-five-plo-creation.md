# Midway Union 2/5 PLO creation

The owner's CHEDDERS GAME attempts at 21:42 and 21:44 UTC failed with SQLSTATE 22023 from the October 23 cash-game stake-cap trigger. The creation screen discarded unknown PostgREST plain-object messages because it required `instanceof Error`, so the host saw only “Could Not Create The Game”.

The owner explicitly authorized this 2/5 game on October 28. The maintained trigger now accepts exactly 2/5 PLO4/PLO5/PLO6 on the Midway Union host. Other stakes and clubs retain the 1/2 cap. Existing games, wallets, roster rules and creation authorization remain unchanged. The client reads both plain-object and Error messages, preserving named refusal copy and duplicate-game refresh behavior.

Regression evidence: the old actual PL/pgSQL rejected Midway PLO4 2/5 locally. The new function passes an isolated PostgreSQL matrix of twelve cases and two update refusals, retained in `scripts/qualification/midway-two-five-stake-guard.sql`. Unit coverage retains the exact scope and plain-object error behavior. Installation, publication and live proof are recorded separately by the owning task.
