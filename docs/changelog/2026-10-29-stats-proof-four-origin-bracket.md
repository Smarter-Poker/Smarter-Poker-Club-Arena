# Stats pagination proof consumes both origins before and after

The browser proof had been strengthened to emit four release observations, one for each origin before and after the interaction. Its final validator still expected the previous two originless observations, so run 40901033498 failed its final consumer despite its first-attempt browser case, source qualification and account cleanup succeeding.

The validator now requires exactly one observation for every allowed origin and phase, all on the pinned client SHA with no read error. Missing, duplicate, foreign, originless or disagreeing observations remain failures. The exact public observations from artifact 12908114713 are retained as a regression fixture, excluding authentication, traces and unrelated reporter configuration. Case count, zero retries, actual assets, read sequence, blocked-write and cleanup requirements are unchanged.

This is verification tooling only. The historical workflow remains failed; corrected local evidence does not relabel that hosted run or certify the Horse Brain engine.
