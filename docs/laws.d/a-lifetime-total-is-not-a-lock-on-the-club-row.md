# tests/a-lifetime-total-is-not-a-lock-on-the-club-row.law.test.ts

atomic_distribute_rake bumped a lifetime counter on public.clubs once per raked
hand, and because it runs near the start of the hand projection that single
per-club row stayed exclusively locked through the rest of the transaction: the
remaining obligations, the whole stats projection, and a PostgREST round trip
before COMMIT. Sampled on production 2026-09-29, every backend waiting on
Lock/transactionid held a tuple lock on public.clubs or public.club_wallets, the
clubs row had taken 123,272 UPDATEs against ten live rows, and the engine logged
68 HandProjection timeouts in ten minutes. The write bought nothing: no function,
view or page reads clubs.total_rake, and only the standalone branch ever wrote
it, so two clubs read 0.00 while their wallets held millions. This law pins that
the rake path no longer writes the club settings row, that the figure is still
receipted by rake_records and totalled by club_wallets in the same transaction,
that nothing is backfilled, that the migration pins the function body it produced
and carries its own REVOKEs, and that the still-unfixed half - club_wallets is
one row per club and still held to COMMIT - stays named rather than forgotten.
