# Elimination decisions require the complete field

The bust roster and occupied finishing positions were each capped at one PostgREST page. A zero-chip field larger than 1,000 no longer satisfied the corruption refusal, and a taken position outside the first page could be proposed again. The database mutation door remains authoritative, but an incomplete read must not select its input.

Read both lists through the existing ordered keyset helper, refuse incomplete reads, and stop paging when the original sweep stops or aborts. Preserve exact aggregate counts, concurrent independent reads, bounded mutation batches and the existing elimination RPC. Four regressions fail on prior source; final checks and delivery remain pending.

Validation: 4,223 tournament tests pass across the full run and the six import-hook rechecks. The first full run exposed five test transports that lacked keyset methods; their fixtures were updated with all existing behavioral assertions retained. Six unrelated import hooks exceeded 10 seconds under unrestricted worker contention; rerunning those six with two workers passed all 122 tests without changing timeouts. Both TypeScript compilers pass. New cases cover 1,000/1,001/9,001 rows, a late occupied place, later-page failure and a stopped sweep. No production elimination or payment was performed.
