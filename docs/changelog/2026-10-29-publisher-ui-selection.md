# Use qualified UI selection in the existing publisher

The protected UI selector already runs in pull-request CI, but the publisher still ran all four full client shards whenever main moved and exact-tree reuse refused. A recent publisher waited over ten minutes behind the previous release and its slowest shard then waited six more minutes for a VM. Each dedicated 8-core VM also inherited the retired shared-runner two-worker cap.

Publisher shards now use the same maintained selector against the selected protected commit and the verified source currently served by both origins. Only positively proved presentation/configuration deltas select affected imports and conservative source contracts. Financial, executable, mixed, malformed or unknown deltas retain the full suite. The baseline requires a successful protected-main publisher, its exact immutable bundle artifact and successful origin verification. Every unpublished predecessor is included, so a safe UI tip above an unpublished financial change retains the full suite. Missing provenance/history fails open to the full suite. Both PR and publisher shards use four workers only on the exact approved paid repository route, retaining two on the fallback.

The test matrix, failures, required aggregates, exact-tree reuse, production concurrency, isolated release secrets, forward ancestry, host lock, compare-and-swap, rollback and both live-origin checks remain unchanged. No SQL or engine replacement is part of this change.

The required ownership/coalescing regression now resolves its initial read inside awaited React act before emitting subscription events. The mock exposes callbacks during render, before the authority effect is ready. Both exact burst and follow-up read counts remain unchanged; production and financial authorization code are unchanged.

The selection-baseline read is limited to the client component; independent private-record publication routes keep their existing controls and avoid unrelated UI origin reads.
