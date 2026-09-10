# Restore Bounded Rake Attribution Retries

The current rake authority retained settlement lane exclusion but lost the bounded attribution retry loop. One transient attribution failure could leave a settled fee without attribution, and an exact settlement replay then returned the stored result.

The prepared deployment script restores only the three committed retry fragments. It refuses unexpected function bodies, helper identity, owner, security mode, search path, timeout, or service privileges, and checks unchanged metadata after replacement. Already applied source is an idempotent no-op.

The native rollback probe passed 35 assertions. It reproduced the original failure, retried lock-not-available and deadlock SQLSTATEs, stopped after four transient failures, handled permanent errors once, and verified escrow/treasury conservation, attribution rollback, alert counts, and exact replay. Existing helper and trigger metadata and the original fixture state were restored.

The fixture uses synthetic opening custody and late trigger-injected SQLSTATEs. This is settlement and attribution verification, not registration or naturally occurring concurrent deadlock acceptance. The deployment script is prepared; this source change does not apply it.

The repository composer authenticates both complete SQL inputs and reproduces the executed proof byte for byte. Run it with the tracked preimage and restoration paths and an explicit output file. Its emitted SQL refuses a database outside the owned local fixture contract.
