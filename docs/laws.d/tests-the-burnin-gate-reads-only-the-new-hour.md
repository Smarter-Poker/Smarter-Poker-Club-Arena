# tests/the-burnin-gate-reads-only-the-new-hour.law.test.ts

The Midway burn-in gate proves no failed or stuck settlement in 24 hours by carrying a proof (from, before, open ids) from one hourly run to the next and reading only the open ids and the rows dated since, ending each proof at a horizon no open client transaction can write behind (read from pg_stat_activity before the gate's snapshot), so it never again reads a day of the 25 GB settlements table every hour; failed and stuck keep their exact meaning.
