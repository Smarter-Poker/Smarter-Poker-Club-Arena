# Exact installation records recovered from PR 4392

These five SQL files are byte-for-byte copies of the statements already recorded by the production migration service. They are historical evidence and must not be executed as new migrations. The manifest maps each original PR filename and hash to its actual assigned version and recorded statement hash.

A read-only production check at the manifest's timestamp matched all five complete statements, all five current function bodies, and the pending-addons column. The function records include their full observed owner, configuration and ACL. Each function is currently executable only by postgres and service_role.

The archive deliberately sits outside the forward-migration directory. It includes an already-completed, narrowly guarded tournament ladder correction and a replacement schedule for an existing job. Re-running either is outside this record change. CREATE OR REPLACE also retained the installed function grants; a fresh-create text check cannot derive that prior ACL. No migration, declaration guard or allowlist is changed to make this archive pass.

The scoped schema fragment was generated from those current catalog rows. This records installation history and current schema identities; it does not certify the original correction's complete business outcome, the pending balancing code, a funded engine journey or a production release. TournamentManagerEliminations remains with its existing owner.
