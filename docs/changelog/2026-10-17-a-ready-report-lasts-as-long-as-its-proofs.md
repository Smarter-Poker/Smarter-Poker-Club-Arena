# A ready report lasts as long as its proofs (2026-10-17)

`20261017131056` keeps a READY union P&L evidence report so the next weekly
close attempt does not prove it again. It handed the report on for 30
minutes, which was a guess and the wrong measure.

On production the 2026-10-05 Midway close kept its report at 17:08 UTC. The
attempt at 17:13 used it and reached round 3 inside its budget, then lost the
deadlock that `20261017161610` has since fixed. After that, every attempt
found the receipt expired, re-proved the report, hit the 240 s statement
timeout, and was rolled back along with the receipt it was about to keep.

`20261017195000` changes one condition in `fn_accounting_close_report_seed`.
A ready report is handed on for `fn_accounting_close_proof_lifetime()` (72
hours), the lifetime of the certificates it is built from. It is never handed
on once any of that union's certificates for that week has been certified
again after it. The generation, closed-week, ready and chunked-attempt tests
are unchanged.

## Verified

- The preimage `e859e4e5` and postimage `981a3fdf` were derived on production
  (read-only). The migration runs twice on native PG16 with an unchanged ACL.
- Seed accepts a 2-hour-old receipt whose certificates are all older than it.
- Seed refuses the same receipt after a certificate is re-proved, a receipt
  73 hours old, and any session that is not a chunked close attempt.

## Pinned by

`tests/a-ready-report-lasts-as-long-as-its-proofs.law.test.ts`.
