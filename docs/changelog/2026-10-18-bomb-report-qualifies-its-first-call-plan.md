# Bomb reports retain qualified hosted scan plans

JAQK still timed out on a fresh database backend. Catchup's custom bitmap plan selected the table/hand-number index and took 9184ms; its generic table/created-at plan took 142ms. Keep that plan function-local from the first call, preserving the exact catchup body and private grants.

The final result query independently timed out at 20 seconds. Its hosted-table relation now uses correlated reads with the actual table/date bounds, retaining that relation with OFFSET 0 and excluding future UTC dates. The exact JAQK 30-day SELECT completed in 228ms with identical empty results. Financial calculations, role checks, rollup producer and sealed archives remain intact.

The existing required PostgreSQL report path checks fail-before/pass-after, exact source/settings/owner/ACLs, restoration and replay refusal. Nonempty fixtures verify current hand pot/rake, UTC future exclusion, club isolation and archived totals. Actual authenticated JAQK/SHARK 7/30-day pages remain required after guarded installation. No engine or client release is needed.
