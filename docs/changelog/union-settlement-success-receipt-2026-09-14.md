# Union settlement requires a completed receipt

The union operations panel could show “Settled” after the database returned an
HTTP-successful `success: false` response for a failed round, remaining recipient
shortfalls, or invoice failure. The service now requires an explicit completion
for the requested union and finite nonnegative round amounts with zero shortfalls
before exposing those amounts to the success message. Missing amounts no longer
default to zero. Incomplete or uncertain settlements are not retried automatically;
earlier round payments can already be durable.

Validation exercises the actual service with database refusal envelopes, absent
and mismatched receipts, both round contracts, legitimate zero-amount completion,
requested period forwarding, and transport uncertainty. No database function,
settlement policy, payment amount, or rake destination changes.
