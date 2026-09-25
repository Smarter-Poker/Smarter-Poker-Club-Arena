# Credit primitive extraction preserves PostgreSQL statement boundaries

The composed MTT push failed the existing one-payment rule on
`20260917233447_tournament_original_funding_and_obligation_receipts.sql`.
The actual credit primitive owns its one payout-evidence insert. Its captured
PostgreSQL definition ends with `$function$` and a newline before the semicolon.
The test helper at lines 70-74 recognized only an adjacent semicolon, leaving
the legitimate primitive in the caller scan and falsely reporting a duplicate.

The bounded correction recognizes whitespace before the semicolon, stops
at that definition's closing tag, and retain every following caller. The
closed historical exception list and duplicate-payment assertions stay intact.
Regression cases cover both terminators, an unsafe following caller, a missing
terminator and an unknown owner. No SQL or production financial behavior changes.

Validation: the new newline regression and the repository scan both failed
before the repair; all 14 checks pass afterward. App TypeScript passes.
The 112 qualified database inputs remain byte-identical. Normal push and
hosted checks remain required. Re-read of the final diff completed.
