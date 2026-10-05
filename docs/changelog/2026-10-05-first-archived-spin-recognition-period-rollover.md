# First archived Spin recognition period rolls forward

Required-check run `37307605805`, accounting PostgreSQL shard 1 job
`111755369379`, reached `archive_temporal_refusal` and correctly refused its
archived-spin image after the pinned recognition period ended at
`2026-10-05T07:00:00Z`. The refusal was
`ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED`. Retained execution
`2e2f8a7a-0628-4574-8e82-e8a4162135d3` records `cleanupVerified: true`. This
was the time-bound guard working, not evidence of a failed settlement and not
permission to remove the guard.

## Authentic current evidence

A new read-only production capture at `2026-10-05T12:40:08.506687Z` binds the
same maintained query to the current period
`2026-10-05T07:00:00Z..2026-10-12T07:00:00Z`. It found zero blocking runs and
zero runs overlapping that week. The current source data legitimately produces
two routing scopes: source club `a41434bb-8d0c-400a-8f0d-e8b3d65afed4` and
tournament-host club `fade0000-0000-0000-0000-000000000001`, both coordinated
by union `fade0000-0000-0000-0000-000000000001`.

The additional scope is explained by owner-authorized fee operation
`89f48f79-36cd-7306-3d5e-d3c58945ff1f`: its one event recorded three fee
sources for the source club on 2026-10-02. The capture proves the current
bounded routing scopes and absence of overlapping settlement runs. It does not
claim terminal settlement, fee payment, or complete production settlement.

## Fixture correction

The raw capture and active temporal state now carry the authentic current
evidence, while the prior capture remains in recognition-period history. The
seven runtime/SQL carriers use the new weekly bounds, and the exact two-scope
production assertion is retained in the capture validator. The isolated
temporal-refusal seed intentionally keeps its single host fallback scope: that
fixture starts before the fee-source capture, so changing it to two scopes
would erase the behavior it proves.

The rollback-probe, canonical-completion, manifest, and CI hashes are refreshed
from the resulting exact bytes. No production write, DDL, migration
installation, settlement operation, financial amount, function, or engine
behavior is part of this rollover.
