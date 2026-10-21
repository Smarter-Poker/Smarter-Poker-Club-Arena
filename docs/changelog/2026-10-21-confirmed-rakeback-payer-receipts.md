# Confirmed rakeback certificates retain their payer receipts

The original page and whole-period calculators skipped unchanged certificates before the historical payer trigger ran. Eleven unchanged Union certificates and all119 already-calculated Pilot certificates therefore lacked immutable payer receipts even though the recompute request reported complete.

Both original same-fingerprint branches now use one private owner to validate the certificate and derive its exact payer rows from recorded source allocations. The insertion trigger delegates to that same owner. Existing rows must agree exactly; certificates, payer histories, period values and money remain immutable. Original caller metadata and permissions are preserved.

A separate postgres-only finite admission accepts at most16 certificate IDs from the retained130-certificate manifest, all from one club/week. It reconstructs and verifies the original source/history/rate plan with the existing native checker before admitting those receipts. Installation does not execute admissions. There is no new service/public API, schedule or payment route.

Native PostgreSQL17 regression executes the original producer: unchanged legacy receipts fail before the repair and pass afterward, with rollback, duplicate/concurrent admission, source-history loss, conflicting immutable rows and no-money assertions. The existing required native parent invokes the fixture unconditionally. Qualification and delivery results remain in the audit checkpoint.

The required parent exposed an unrelated calendar-sensitive expiry fixture: two days ceased to be before the Oct19 close on Oct21, and the actual proof lifetime is72hours. Its expiry fault now subtracts the actual native lifetime plus one second, keeping the same refusal assertion across dates. No hand-proof production source or timeout changes.

The installer now pins the subsequently installed explicit player agreement preimages and preserves explicit zero rakeback in both calculator owners and the native legacy admission validator. The isolated native fixture covers positive rake with an explicit zero agreement across two historical agent payers; source-law mutation checks reject changes to that predicate.
