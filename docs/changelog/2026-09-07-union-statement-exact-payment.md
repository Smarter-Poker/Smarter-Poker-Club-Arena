# Weekly Invoice Payments Account For Every Cent

The live acknowledgement function marked a 100.00 invoice paid after 99.99. Migration 20260907210210 removes that tolerance and rejects null actions, nonfinite values, negative or zero explicit payments, and fractional-cent inputs. A partial payment cannot retain an incorrectly paid status.

The original function reproduced the defect in an isolated, self-aborting pg_temp probe. The candidate and installed function passed exact completion in both directions, default remaining payment, repeated full settlement without extra history, reversal history preservation, malformed inputs without mutation and the existing authorization refusal. Identity and authorization helpers were stubbed; production triggers and concurrent sessions were not exercised.

Applied to production on 2026-09-07. No chips moved and no historical invoices were changed. This acknowledges externally reported payments; it does not prove bank receipt. Explicit partial-payment requests still lack a request idempotency key, and historical union ownership remains a separate audit item. The repeat full-settlement path remains idempotent.
