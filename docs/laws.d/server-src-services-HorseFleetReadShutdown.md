# Cash seeding joins its work after lifecycle withdrawal

Tests: `server/src/services/HorseFleetReadShutdown.test.ts` and
`server/src/services/supabase/paginationLifecycle.test.ts`.

A paginated read must not admit another page or retry after its owner stops,
and a late response cannot certify completeness. The request already in flight
remains owned until it settles. Cash seeding must still join its final status
write before its stop promise resolves. Queue and offer helpers must observe
the same captured generation before acting on withdrawn reads.

The twelve regression cases fail against their original implementations.
This is source verification, not proof of an installed engine or clean live
shutdown.
