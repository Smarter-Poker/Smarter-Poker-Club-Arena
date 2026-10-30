# Roster cash reads funded boundaries and each total once

The 100-member roster win/loss request repeatedly evaluated each member's cash
and tournament totals. Cash boundary rows also performed cold hand/player rake
club lookups. The replacement computes one cash batch for the authorized roster,
prefetches the canonical latest buy-in timeline, preserves latest NULL funding
and rake/fact fallback, and computes each tournament total once. A narrow
nonunique rake hand/player index includes club_id; the existing unique index
and all financial source rows remain unchanged.

The guarded migration preserves public function metadata/ACLs, launch source65
and generation identity, Chicago DST and UTC rollup boundaries, exact money and
rounding, and the 100 input-slot limit. The helper is private. It refuses stale
source, replay, incompatible index, freeze and maintenance boundary.

Required accounting shard4 executes isolated PostgreSQL17 equivalence over the
actual original cash/funding/cutoff/tournament-money/roster readers: 100-member
four-period totals, 23/25-hour DST, receipt ties/rejoins/latest NULL, source
fallback, authorization, launch cutoff and atomic refusals. Native auth/scope
collaborators and maintenance/source65 adapters are explicitly identified.
Actual tournament-money calls decrease from784 to392 for the four-period cohort.
This qualification does not certify production runtime. Protected merge,
installation/readback and the full live period-summary request remain required
before the original57014 cohort can be called fixed.
