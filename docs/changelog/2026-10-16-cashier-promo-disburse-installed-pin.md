# Certify the Installed Promo Disbursement Definition

Midway weekly horse promo (`20261016132743`, #7104) was installed at 16:03 UTC and replaced `fn_promo_disburse` after checking its old full definition (`54539cb4d66ffdcdacd85521e5fbb929`) as the preimage. The live Cashier verifier still pinned that preimage, so post-deploy run 38929938237 failed "Certify the live cashier database contract" with `expected 54539cb4d66ffdcdacd85521e5fbb929, got e54e4f3949335c61d4c1492d81b5ca21`.

The installed definition changes three things: the engine and scheduler caller is recognized through `fn_caller_is_engine()`, members of a union's own club are eligible recipients, and the union promo leg writes its own labelled ledger row. Owner authorization for signed-in callers, SECURITY DEFINER, and the `public` search path are unchanged.

The verifier now pins `e54e4f3949335c61d4c1492d81b5ca21`. A regression derives that fingerprint from the merged migration text and confirms the verifier no longer accepts the superseded definition. The value matches the live read in run 38929938237.

## Club Bank Ledger

The Club Bank ledger one-pass read (`20261016155801`, #7115) was installed at 16:46 UTC, after that run, and replaced `fn_club_bank_ledger`. Its install transaction asserts the post-image `cb7edf507b92e7c22535d6fed10a416b`, so the verifier would have failed on it next. The verifier now pins that value, and the regression derives it from the migration text.
