# A weekly statement fits its close attempt (2026-10-17)

Migration `20261017223358_a_weekly_statement_fits_its_close_attempt.sql`.
Law: `tests/a-weekly-statement-fits-its-close-attempt.law.test.ts`.

## What was wrong

The 2026-10-05 Midway union close (fade0000) paid round 3 at 20:13:39 UTC
(588,824.90 to 777 payees, no shortfall) and then could not finish. Every job 272
attempt after that hit the tick's 240 s statement timeout inside
`fn_club_weekly_accounting_summary`, at the first of the two club statements,
and was rolled back whole. The run stayed `running` with round 3 committed.

Measured read-only on production:

| Piece (per Midway club) | Before | Why |
| --- | --- | --- |
| `fn_accounting_tournament_week_quality`, full week | more than 175 s (cancelled at every limit) | read history, not the week: 1.6M-row `club_sourced`, 529k-row `club_refunded`, the whole 686k-row settlements index, all 1.42M fee sources, and four EXISTS tests hashed over every tournament rake record ever |
| the tournament fee fingerprint, 290k records | 62 s | `fn_accounting_tournament_fee_fingerprint` converts the whole row to jsonb once per field (17 times) |
| the statement's source fingerprint, 1.2M sources | 90 s | hashed each source's 2.5 kB contract text, then sorted 1.2M rows on a collated text key |

Two clubs, both inside the one attempt that also settles the week and issues
every statement, could never fit 240 s.

## What changed

1. **The tournament week proof reads the week, by key.** Same tests, same rows:
   the settlements join and the fee-scope sources are found from the week's
   candidates; "sourced by this club or its union" and "refunded to this club"
   are per-event EXISTS on their indexes; the four unknown-scope EXISTS carry a
   no-op `OFFSET 0` so the planner keeps them per event; the rake record
   fingerprint is computed inline as exactly the jsonb object the fingerprint
   function aggregates. The fingerprint function itself is unchanged
   (`fn_ca_guard_mtt_admission_contract` pins its body), and the install checks
   the inline value equals it on the 500 most recently recognised tournaments.
   Equivalence was checked on production before writing: identical results for
   every window compared, and an identical md5 over every output row and column
   of the event query (22,602 and 1,663 rows, a union club and a standalone club)
   against the original with only the no-op `OFFSET 0`. A full Midway week now
   takes 78-87 s, a day 6 s (51 s before).
2. **A statement fingerprints its sources by identity.** Type, id, rake record,
   earned_at and rake credit, ordered by id with a C-collated type: 11.5 s a club.
   Every earning source table refuses UPDATE, DELETE and TRUNCATE, so a contract
   cannot change once its id is written. The key is `source_fingerprint_v3`, so it
   is never compared with v2; nothing reads it back. Issued statements keep v2.
3. **A chunked close proves one club per attempt.** After every round is
   committed and conservation asserted, and before anything is settled or issued,
   `fn_union_settlement_cascade` proves the next club's tournament week, keeps the
   READY proof as close certificate `club_statement_quality:<club>` (the sealed
   `fn_accounting_close_certify`), and commits that step. The statement reads it
   back. A proof that is not ready refuses the statement with the statement's own
   error; a proof that cannot be kept changes nothing. The attempt that finds every
   club proved settles and issues as before, in seconds a club.
4. **Those certificates are not a P&L re-proof.** `fn_accounting_close_report_seed`
   (20261017195000) hands a ready report on until any of the week's certificates is
   certified again after it; statement certificates no longer count, or each one
   would send the next attempt back to proving the report.

Correction to 20261017195000's header: it says the report rests on certificates
reused for 72 hours. The two-hour windows are; the combined certificates read
through the sealed `fn_accounting_close_certificate` keep its 12 hours (see
20261016133404). The report is rebuilt from the 72-hour windows when those expire.

## Verified natively

On PostgreSQL 16, with stub bodies carrying every anchor: the migration installs,
a second run is a no-op, owner, SECURITY DEFINER, configuration and ACL are kept,
a drifted body is refused, and the inline fingerprint equals the function on
generated rows (numeric(18,4), jsonb, timestamptz and nulls). The new cascade step,
run alone: unchunked does nothing; chunked proves club A, then club B, then falls
through; the union's own club row is skipped; with the memo off it proves once and
falls through; a blocked proof refuses the statement and keeps nothing; a spent
budget refuses before proving; a stale or blocked certificate is proved again.
