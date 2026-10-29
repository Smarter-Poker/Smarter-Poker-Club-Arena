# Grouped critical digest signals retain their original alerts

The daily digest grouped newly seen or rising critical alert types into one historical signal, but omitted the original inbox identities. Its reader therefore always reported an unconfirmed assignment, even after those exact episodes resolved or were reviewed.

The producer now retains the exact original IDs and expected snapshot counts. One materialized inbox read supplies both historical comparison and current membership. The reader validates every member, day, type, count and ID before reporting a result. It recognizes reviewed records, the exact canonical financial original, and Alertmanager resolution with matching fingerprint, full labels and episode start. A later recurrence cannot borrow an older episode's resolution. Missing or malformed provenance stays explicitly unknown.

The two witnessed October 28 members receive guarded identity linkage only. Their headline counts, original events and financial records are retained. Other historical groups without proven linkage are not inferred or bulk-closed. No schedule, payment, engine activation or client release is introduced.

Disposable PostgreSQL 17 qualification exercises the exact installed source transition, positive and incomplete provenance, canonical outcomes, wrong episodes and identities, malformed input, immutable daily counts, replay refusal, preserved function authority/configuration, a single inbox scan and the UUID primary-key lookup. Required repository checks and protected installation still govern delivery.
