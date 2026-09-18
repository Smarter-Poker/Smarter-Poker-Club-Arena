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
