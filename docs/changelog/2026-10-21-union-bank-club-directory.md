# Union Bank club directory

The Union Bank directory requested every embedded club column, including financial columns intentionally unavailable to authenticated browser queries. PostgREST refused the request with `permission denied for table clubs`, leaving zero club recipients and disabling Pull Back.

Read only the union membership's club ID and the club name. Existing RLS, financial-column grants, money RPCs, operation IDs and opening-grant floor remain intact. The modal regression fixture now reproduces protected embedded club columns so the bank pull-back test fails with the old wildcard and passes with the identity projection.

Validation: production read under authenticated RLS returned all four Midway clubs; the reproduced live browser logged the same permission error. Existing modal, wallet recovery and promo routing tests pass. No chips moved for verification.
