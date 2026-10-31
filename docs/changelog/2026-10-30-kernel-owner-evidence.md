# Kernel owner evidence and opaque Linux process names

The scoped release reader previously decoded the private comm field in /proc/PID/stat as ASCII. Linux permits opaque bytes there. Valid UTF8 and nonUTF8 names reproduced UnicodeDecodeError before this correction; parse the bounded record as bytes and decode only the validated numeric start time.

Pending observations now use existing-release-pending-observation/v6; current serving role observations use current-serving-inspector-role/v2. Both require inspectorOwnerEvidence, an exact closed stage/code pair. This identifies the bounded failure stage without exporting native errors, process names, PIDs, namespaces, descriptors or paths. Only two complete equal snapshots can report complete/exclusive. Unknown observations retain no ownership or action authority.

Existing eight-second deadlines, 256-member cap, shared 16384-descriptor cap, bounded files, exact container membership and socket joins, before/after identity and healthy-source binding remain enforced. No new selector, Inspector attachment, release mutation, cleanup, retirement or retry is added. The optional kernel role remains independent of the original-bound Inspector admission contract.

The maintained 100-method Python suite includes strict output validation, fixed failure projections, opaque-name parsing and an actual Linux own-child socket/opaque-name regression. Local macOS executes 96 tests with four explicitly Linux-only skips; actual Linux qualification must execute all 100 without skips before production use. The reproduced parser defect is not established as the cause of production's unknown role. Deployment, release sealing, thaw and fleet behavior remain separate live acceptance requirements.
