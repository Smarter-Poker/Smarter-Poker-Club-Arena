# Retained checkpoint native prerequisites

The engine's existing production-door check scanned only `server/src`, so it could not discover the selected serialized retained-original guard under `server/scripts`. The guard also needs the exact frozen-custody attestation contract, beyond an RPC name in `pg_proc`.

The same existing check now reads that one closed guard path and requires the exact93051 migration history plus the qualified public wrapper and private kernel bodies, read-only metadata, owner, search path, service/browser permissions and private-table denial. Missing, changed, duplicate or unreadable evidence refuses this new checkpoint target. Existing targets keep their prior compatibility and rollback rules.

The real CLI regression reproduces predecessor admission with the private kernel absent; the corrected gate refuses it. Focused contracts cover exact admission, history drift, body/config/permission drift, duplicate and unknown evidence. This changes only the existing pre-intake read, without another workflow, database writer, publisher or runtime action.
