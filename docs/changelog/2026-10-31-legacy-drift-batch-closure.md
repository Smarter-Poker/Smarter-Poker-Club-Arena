# Legacy drift batches retain complete closure proof

The overdue drift group `4f6fc811` has 43 original incident events at one cron transaction timestamp. Its 43 matching critical source alerts have that same timestamp, source and normalized cause key. The previous resolution trigger required each event to match exactly one alert, so it could never close this complete batch after its last source condition resolved.

The maintained trigger now proves the complete legacy transaction set: positive alert count equals original event count at the exact source, cause and transaction timestamp, every source alert is resolved, no mixed versioned bucket exists, and the current resolving alert belongs to the set. Versioned UUID identity remains exact. Missing or extra records, wrong source, mixed formats and any unresolved member leave the incident open. The transaction owner, row locks, restrictive ACL and remaining resolution paths are preserved.

The migration changes function source only. It preserves every historical incident and event and moves no money. Installing it does not resolve the running tournaments or their source alerts.

Validation: actual PostgreSQL 17 reproduces the old complete-batch refusal, then proves partial refusal and complete-set closure with the correction. Existing real two- and three-session ownership races pass, missing/extra/wrong-source cases remain unknown, historical bytes remain unchanged, and both actual member lookups use their existing identity/time indexes. Normal protected checks and live installation/readback remain required.
