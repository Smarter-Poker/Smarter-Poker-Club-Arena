# Downline rake uses bounded covered periods

The installed reader still exceeded the five-second check for KingFish's 635-player KINGS downline. Its edge period contained 314,291 eligible facts. Projecting `rake_record_id` forced heap reads even though the club had no launch cutoff. Broad period estimates also allowed a whole-index merge scan or repeated club scans per player. The earlier predicate push alone was insufficient for this large authorized cohort.

The follow-up migration preserves the actual authorization, hierarchy, completed daily rollups, original date boundaries and per-row cent rounding. It reads the launch boundary once per club. A separate covered lane handles null cutoffs without fetching a source-record ID; the non-null lane retains the original finite source-record timestamp rule. A lateral scan with an explicit optimization boundary keeps each source read inside its existing club/date period. Aggregation precedes materialization, and the existing everyone join preserves its multiplicity.

The read-only full production candidate returned all 635 players under the unchanged five-second cap. Its 690,466 hands and 307,948.30 rake through 2026-10-30 14:43 UTC match an independent raw-edge plus completed-rollup calculation. This is candidate-read evidence, not installation or application RPC proof. Those receipts remain in the existing task checkpoint.

Native qualification retains the existing 37 legacy checks and 11 first-repair checks, and extends the actual reader transition with real captured launch helpers, null/non-null cutoff cases and the large authorized cohort. The regression preserves money rows, function identity, defaults, ownership and grants; no balances or settled records are changed.

The successful client publisher also exposed a connected verifier defect: post-deploy job discovery did not recognize maintained nested `client-publication` job names. Exact recognized names now include that prefix while preserving unique writer, source revision, completeness and outcome checks. Executable regressions reproduce rejection of a real successful nested publisher and failure to detect a duplicate nested writer.

Real-time law: triggered by `PRIVATE_RECORD_CHANGED` discrete WS event, no snapshot diff. The published client remains event driven; this follow-up changes its reader and verification, not gameplay or the engine contract.
