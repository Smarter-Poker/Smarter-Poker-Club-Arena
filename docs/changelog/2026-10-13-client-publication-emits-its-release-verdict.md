# Client publication records its actual release verdict

Three completed publishers served their exact protected bundles while GitHub's
job and attempt APIs returned empty step arrays. Post-deploy admission correctly
refused that missing evidence and never ran its browsers.

The existing publisher now emits one immutable, attempt-bound release-verdict
artifact from its actual step outcomes, conclusions and verification outputs.
Publish, forward stand-down and finalized retained runtime remain distinct.
Failure or cancellation emits no admissible receipt; a failed outcome masked by
`continue-on-error` is still refused. No logs or aggregate job success substitute
for missing release evidence.

The existing admission reads the exact publisher run, attempt, job and artifact
envelope, validates protected ancestry and the matching bundle or retained
receipt, then admits the existing browser jobs. Missing, duplicate, stale,
expired or mismatched receipts remain failures. Publishers predating this
contract do not acquire a fabricated receipt.

Qualification executes the maintained producer and consumer shell/CLI, preserves
superseded-before-origin non-verdicts, and exercises failed/partial/masked steps,
identity and lineage mismatches, retention conflicts and removal of the actual
producer/consumer calls. The existing browser suite and cleanup remain required.
The earlier commerce reload reconnect failure remains unresolved by this source
change; it requires its own actual certificate evidence or diagnosed cause.
