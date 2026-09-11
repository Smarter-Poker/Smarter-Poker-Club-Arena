# server/src/engine/theDrillArmsATableNeverADeck.law.test.ts

The Bad Beat Jackpot drill injects the DETECTION VERDICT on a table an admin
armed, never the cards. It may not name a deck, a shuffle or a seed, may not
write a hand or a board, fires only on an atomic database claim (no env var, no
build flag), is consulted only when the real detector said no, treats an
unreachable database as no drill, and is counted separately so `detected minus
drills` is the number of genuine bad beats.

And the MINI can be drilled too (2026-09-11): an arm carries a kind, a mini arm
is guarded on the mini's own preconditions so it cannot fire into a refusal, a
union pool is out of reach for both kinds, and a mini drill is never paid as a
main jackpot.
