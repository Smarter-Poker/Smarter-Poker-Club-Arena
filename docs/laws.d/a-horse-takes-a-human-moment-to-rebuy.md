# server/src/tournament/aHorseTakesAHumanMomentToRebuy.law.test.ts

A horse that chooses to rebuy in a tournament answers its offer a deterministic human think time after the bust (3.5-16 s, hashed from tournament, horse and busting hand; never later than 8 s before rebuy_prompt_until, or half a shorter window), on both the input device and the elimination sweep, and is not answered or charged before then - CLAUDE.md 10.5 "TIMING IS PART OF THE TREATMENT" (2026-10-24: humans 9-15 s, horses p50 2.3 s).

An earlier pending purchase response cannot hold another Horse past that deterministic due moment. The original input arms the due timer while retaining the pending purchase.
