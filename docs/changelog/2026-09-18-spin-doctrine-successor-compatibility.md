# Preserve the published settlement doctrine in Spin qualification

The read-only production capture at 2026-09-18 02:32:16 UTC found that the
settlement doctrine changed from `8dd361600c8facb1cbb99b3df853e5b9` to
`d6885832ceaa6c071d40bdc26a0b16fa`. Its exact definition matches protected
PR #4797. The earlier qualification remains valid for its captured cohort,
but cannot authorize installation over this newer definition.

The two mixed-terminal images now restore the full captured successor after
the original catalog readback. The original capture and shared paid-entry
fixture remain unchanged. Forward components require the successor; the
terminal component adds only its existing initial-lock helper to the reviewed
allowlist, and reversal restores the complete successor definition and original
permissions. Financial functions, original requests, amounts and allocation
deadlines are unchanged. Both lane refusal paths also substitute the authentic
old doctrine and require rejection with full transaction rollback.

The directly invoked stage-order regression fails against the former source.
Native verification, protected checks, publication and production installation
are distinct gates. This change does not reconstruct absent histories or close
the oldest incident, and does not claim full financial qualification.

At source `32deb975d59fcc35f0168f5c4587acf7cf4d985f`, both affected local
PostgreSQL 17.11 images passed: completion `be2d7625-6f85-4f98-9c61-81639b99752b`
and source-change refusal `22067bbe-4aad-4b91-9c0d-1654c214bd3b`. The root review
verified all 128 input hashes, 117/109 evidence leaves, 57/53 process stages,
the exact successor/extended/successor definition round trip, unchanged business
rows on reversal, 10 forward and 13 reverse refusal controls, and actual cleanup
and allocation removal. The original allocation admission failures are retained;
no database was allocated by those command-configuration refusals.
