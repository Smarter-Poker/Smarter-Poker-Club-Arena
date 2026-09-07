# server/src/engine/theDrillArmsATableNeverADeck.law.test.ts

The Bad Beat Jackpot drill injects the DETECTION VERDICT on a table an admin
armed, never the cards. It may not name a deck, a shuffle or a seed, may not
write a hand or a board, fires only on an atomic database claim (no env var, no
build flag), is consulted only when the real detector said no, treats an
unreachable database as no drill, and is counted separately so `detected minus
drills` is the number of genuine bad beats.
