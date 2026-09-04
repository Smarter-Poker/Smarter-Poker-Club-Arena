# server/src/services/PagedReadsAreDeterministic.law.test.ts

Paged reads order by a unique key, so no row is served twice or skipped across pages
