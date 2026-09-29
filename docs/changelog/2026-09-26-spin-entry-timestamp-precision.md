# Spin entry evidence preserves PostgreSQL timestamp precision

The paid-entry qualification oracle rejected PostgreSQL timestamps with five fractional digits on Python 3.9, despite successful native SQL execution. The parser now validates the exact timezone-bearing timestamp grammar and pads one through six fractional digits losslessly before parsing. Explicit clock and timezone bounds prevent interpreter-dependent normalization, and excess precision is refused rather than rounded.

Regression coverage includes the original failed timestamp, exact microsecond preservation, timezone equivalence, malformed input refusal and the connected paid-entry observation oracle. The existing native wrapper runs these controls before its financial fixture; source manifests bind the changed oracle. This is qualification tooling only and changes no production financial transaction or historical record.

The original failed native execution remains failed. Unit and native results, publication status and outstanding incident work are recorded separately in the Production Alerts evidence/checkpoint.
