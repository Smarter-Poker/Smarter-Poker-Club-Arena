# Player Command Maintenance Verification Blocker

All six corrected Player Command production cases passed. The production account cleanup remained blocked because the original 13:55 maintenance countdown did not complete its thaw. Repeated read-only database witnesses showed the original thaw waiting for exclusive advisory admission while the existing hand-history pruner held the shared lane.

The new guarded successor changes only the pruner entry: known or unknown freeze state returns zero before acquiring the lane or reading policy/accounting relations, and the state is checked again after admission. The existing source hash, owner, invoker status, permissions and search path are checked before and after installation; replay and drift are refused. Schedule, eight-day retention, human history, financial evidence, deletion predicates and work bounds remain unchanged.

A new bounded native qualifier is invoked by the existing required installer qualification. The original pruner fixtures and evidence remain immutable. Verification must reproduce frozen relation access before the change and show refusal before relation or advisory access afterward, with unknown-state refusal, the second admission check, original unfrozen behavior, authority and replay protections.

This correction cannot release an already-running prune or directly thaw the platform. The original maintenance owner must complete thaw and the production cleanup must then succeed. Implementation, native qualification, protected merge, installation, readback and that live recovery are separate requirements, recorded in the existing task checkpoint.

Required hosted retention-law qualification exposed a missing explicit configurable-retention assertion in the dynamic migration. The successor now also refuses a captured source without `horse_retention_days`, while its exact source hash and unchanged-body qualification remain. No retention law assertion was weakened; the affected native and source checks are rerun on the corrected bytes.
