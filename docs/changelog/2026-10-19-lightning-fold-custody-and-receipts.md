# Independent Lightning folds and authoritative post-commit replies

The pilot's fold-to-idle path serialized all folders on the same hand's exclusive instance lock. Each fold now retains shared instance-state custody and exclusive custody of its own player/reservation. Settlement and abandonment still require an incompatible instance lock. A held player row must not hold unrelated folders behind it.

A post-commit HTTP deadline could report failure after its transaction committed. The original call now reconciles that unknown outcome with its exact completed hand receipt, matching the hand number, result, completion timestamp and request/payload hashes. Unknown or mismatched evidence still fails; the normal one-RPC path is unchanged. No write is blindly replayed.

The existing financial-alert lifecycle recognized only physical-table post-commit alerts. It now recognizes Lightning's equivalent, with exact hand/table/number/hash/result checks. No schedule or new repair process is added. Already completed historical obligations are not paid again.

Regression protection runs in the existing required engine tests and native PostgreSQL digest-source qualification. It reproduces unrelated-folder contention before the shared lock, verifies independent progress afterward, preserves settlement exclusion and duplicate-fold idempotency, and tests the installed alert selector against missing/mismatched completion evidence. Native fixture timing is a controlled contention reproduction, not a claim that every historical latency spike had the same cause. Live delivery and measured windows are recorded in the task checkpoint.

Installation packaging correction: the original installer refused before any SQL because proof comments followed COMMIT. Move those comments inside the same transaction envelope, leaving every functional statement unchanged. The real installer regression fails on the original bytes and passes on the corrected file; malformed trailing proof bytes still refuse. The migration remains uninstalled at correction time, so its reserved version is preserved.
