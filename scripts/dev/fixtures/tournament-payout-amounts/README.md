# Installed Tournament Cash Ladder Rehearsal

Run from the repository root:

```sh
PATH=/opt/homebrew/bin:$PATH python3 scripts/dev/probe-tournament-payout-amounts-pg17.py
```

The runner creates and removes its own PostgreSQL 17 cluster. It accepts no
database URL. `PGBIN` or `POKER_AUDIT_PG_BIN` can name local PostgreSQL binaries.
`PGNODE` can select the repository's existing Node query adapter when the
PostgreSQL distribution does not include psql.

`installed.sql` is the unchanged installed
`fn_ca_tournament_place_amounts(uuid)` definition, captured on September 10.
Its PostgreSQL body MD5 must match `source-manifest.json` before any case runs.
The installed body still matched at 03:34:31 UTC after the rehearsal.

Fifteen groups execute the SQL amount authority: the historical 513.00 residual,
a funded bubble reserve, disabled protection, an all-paid field, one cent,
sparse places, duplicate places, a shortened field, a zero pool, and refusal
of unfundable bubbles, fractional pool/bubble cents, malformed ladders, empty
rosters and satellite cash pricing. Successful derivations repeat with the
same amounts; every case compares complete input rows before and after.

The two input tables are deliberately synthetic, minimal shapes. There are no
production rows or replacement money functions. This proves amount derivation
only. It does not prove pool finalization, the displayed cutoff, registration
freeze, actual wallet payments, elimination ordering or terminal closeout.
The separate current catalog review is recorded in the Phase 3 payout evidence
file. No production migration or engine deployment is introduced here.
