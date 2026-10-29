# Horse own-history request provenance

A pending or unavailable history read previously retained only its broad state. The original decision could not distinguish an in-flight read, exhausted load slots, a provider refusal, invalid response, snapshot cutoff or heap admission refusal.

The main-owned history service and cache now capture a closed reason at that original boundary. Each FAST snapshot carries optional versioned provenance bound to the exact original decision cutoff, horse, variant, format and dealt-player count. The existing worker validates that context, state, closed reason and packet presence before accepting the request. Its existing decision journal freezes the provenance with the original snapshot. Old snapshots remain valid without the optional field; old evidence remains unknown.

The reason describes cache and load availability, not worker consumption, durable persistence or strategy qualification. No raw provider errors, cards, credentials or responses are added. Read deadlines, concurrency, retry cooldown, quota, eviction, accounting and strategy are unchanged. Existing consumers can continue using the existing state; private proof consumers must explicitly validate the new provenance before attributing a cause.

Regression coverage exercises the actual service/cache/budget and worker/journal path, exact NLH/PLO4/PLO5/PLO6/PLO8 partition binding, load capacity, failed retry admission, cutoff races, invalid packets, provider failures and diagnostic callback failure. Delivery and affected-live proof remain required before claiming these diagnostics are installed.
