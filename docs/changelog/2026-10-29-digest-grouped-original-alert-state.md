# Grouped digest signals retain their original alerts and incidents

The daily digest grouped newly seen or rising critical alert types into one historical signal, but omitted the original inbox identities. Its reader therefore always reported an unconfirmed assignment, even after those exact episodes resolved or were reviewed.

The producer now retains the exact original IDs and expected snapshot counts. One materialized inbox read supplies both historical comparison and current membership. The reader validates every member, day, type, count and ID before reporting a result. It recognizes reviewed records, the exact canonical financial original, and Alertmanager resolution with matching fingerprint, full labels and episode start. A later recurrence cannot borrow an older episode's resolution. Missing or malformed provenance stays explicitly unknown.

The drift producer likewise records its exact live incident cohort and cutoff, independently of day-end health metrics. Its reader requires every original incident and verified closure evidence; four of five resolved remains in progress, while missing members or aged-out closures stay unknown.

The two witnessed October 28 critical members and five drift incidents receive guarded identity linkage only. The drift linkage asserts the exact original snapshot/payload, temporal cohort and immutable creation history before it writes cold report metadata. Their headline counts, original events and financial records are retained. Other historical groups without proven linkage are not inferred or bulk-closed. No schedule, payment, engine activation or client release is introduced.

Disposable PostgreSQL 17 qualification exercises the exact installed source transition, positive and incomplete provenance, canonical outcomes, wrong episodes and identities, malformed input, immutable daily counts, replay refusal, preserved function authority/configuration, a single inbox scan and the UUID primary-key lookup. Drift cases cover partial four-of-five, complete five-of-five, aged-out/missing proof and future live-cohort provenance. Required repository checks and protected installation still govern delivery.
