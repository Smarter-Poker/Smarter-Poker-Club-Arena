# Complete tournament recovery boards

The startup recovery scan and the discovery dwell scan selected COMPLETING tournaments without paging. PostgREST returns at most 1,000 rows. A backlog beyond that boundary omitted events; an unreadable discovery response could also erase retained dwell clocks by being treated as an empty board.

Both consumers now use the same ordered id-keyset reader. Every page must succeed before either consumer proceeds. Failure, null data, thrown transport errors, the row ceiling, or discovery lifecycle withdrawal returns unknown and preserves existing dwell clocks. Explicit single-event recovery retains its id filter. Existing settlement transactions, maintenance checks, per-event authority and discovery cadence are unchanged. No repair loop is added.

Before: two real recovery-consumer regressions failed (1,001 events yielded only 1,000 settlement requests; a later-page fault was invisible). After: 102 connected tests pass, including 0/1,000/1,001/9,001 board boundaries and error/null/throw/withdrawal cases. Discovery wiring is checked separately; that source assertion is not an executed GameServer lifecycle test. Both TypeScript checks are required before submission. No production settlement was exercised. This backlog defect is not attributed to today's smaller stalled events.

Read and changed: `server/src/tournament/tournamentRecovery.ts` startup scan around line204; `server/src/GameServer.ts` discovery scan around line9170; shared reader and regression files alongside tournament source. The final changed source was reread. Delivery and live proof remain separate from local verification.
