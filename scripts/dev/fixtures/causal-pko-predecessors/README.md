# Accepted PKO predecessor qualification

`bash scripts/dev/probe-causal-pko-predecessors-pg17.sh` creates and disposes
its own PostgreSQL 17 cluster over a private Unix socket, with TCP disabled.
It accepts no database URL. Set `POKER_AUDIT_PG_BIN` for an existing PG17
installation. The required accounting CI job supplies its existing PG17 tools.

The fixture loads the captured current claim, collector and marker via the R34
and R35 fixture chain. It reproduces both wrong recipient amounts from an
unclaimed ancestor and a discarded chronological successor with a lower
reserved hand number. It then applies the exact guarded R37 migration.

The repaired cases exercise normal and inverted chronology, multiple incoming
heads, three-link carry, independent pending tables, corrupted or unavailable
accepted evidence, resolved/rebought labels without receipts, stale immutable
pending snapshots, exact settled replay, real concurrent PostgreSQL sessions,
bounded scope overflow, source drift, metadata drift and direct-role refusal.
Existing odd-cent behavior remains unchanged. Each private cluster is removed
after its server exits; the runner never calls a production payer or provider.

The accepted records are synthetic. The inherited wallet implementation is a
documented pool-bounded stand-in. These checks do not establish a legal dealer
hand, complete production schema, Diamond custody, real rebuy purchase,
financial-provider authorization, historical compensation or served adoption.
Rebought labels without receipts are tested; the actual purchase transaction
still requires the separately owned full financial qualification.

The scope test supplies the production candidate/obligation index shapes to
the minimal fixture. Local 9,999-candidate proof took about 0.45–0.50 seconds;
this is an isolated measurement, not a production latency guarantee. The
10,000-candidate proof bound returns explicit unknown on overflow. A durable
accepted participant/dependency index is still needed before claiming scalable
qualification for larger histories; never silently truncate the proof.

Already-created stale downstream snapshots remain refused after their
predecessor pays. The migration neither rewrites their amounts nor pays a
speculative adjustment. That requires a separately reviewed immutable
correction using full recipient, generation and ledger evidence.
