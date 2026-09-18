# Check the whole migration branch before push

The final PR #4680 reconciliation found its PKO runtime fixes already contained
in protected main, but its local migration-presence check was omitted. The
required hosted TypeScript job still checks the whole pull request; the local
hook did not invoke that credential-free Git and schema-manifest check.

Restore the existing check inside the pre-push ref loop, before the repository
invariants (previously `.husky/pre-push:384`). Its explicit merge base covers
earlier branch migrations on follow-up pushes and refuses an unknown base.
Preserve all newer hook checks and the test fixture's `GIT_*` isolation.

The regression belongs in the existing `tests/config/migrationGateCli.test.ts`
suite. It covers an earlier unrecorded migration missed by `HEAD~1`, acceptance
after its manifest fragment exists, and refusal when no branch base is known.
It failed against the omitted hook before restoration. After restoration, all
28 existing-suite cases, root TypeScript compilation and hook shell syntax pass.
The final diff was reread; normal hook and protected-check evidence remains in
the delivery record.

This is the remaining local submission safeguard from #4680. It changes no
tournament runtime, migration, hosted workflow or retired native fixture. The
manifest check does not replace actual database installation and readback.
