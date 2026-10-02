# Record the installed MTT recovery source and its disposal proof

PRs #5497, #5516 and #5517 left seven already-installed SQL versions outside
protected main. This change records the exact production history bytes, including
the original ledger names, and restores their schema declarations and native
disposal/retention checks. None of these migrations requires replay or an engine
replacement.

The seven records were read from PokerIQ-Production on September 30, 2026. Their
file MD5s match the recorded statements plus the final newline. The timestamp in
each version is its ledger identity; the actual installation time is unknown.
The manifest records each original PR and the observed live authorization or
superseding implementation. Existing history is never rewritten to satisfy a
new-source rule.

The write-scope, lease-lock, PUBLIC-revoke and retention-configuration checks now
recognize the existing manifest's byte-verified records. Legacy comment markers
do not receive these new exemptions. Changed, unknown or malformed records still
face the original safety predicates, which are unchanged. The existing live
recording verifier remains required and checks the claims against production.

The two original PostgreSQL harnesses run on accounting shard 3. The retention
harness also installs the final recorded disposal versions in isolation and
checks accepted-permit evidence, departed/replaced seats, changed stacks,
idempotency, immutable snapshots, authorization and refusal boundaries. Its final
function definition matches production MD5
`4333dc1291933bf9296956903952ea6b`. All qualification databases are isolated;
production was read only.

Validation: original disposal proof passed 12 cases/31 assertions; retention and
final disposal passed 24 cases/38 assertions. Relevant source contracts, compiler,
manifest bindings and normal repository hooks are checked on the candidate. These
are local/source qualification results; protected merge and hosted publication
are separate delivery evidence.

Supersession: #5497 supplies versions 20260927231524 and 20260927231551; #5516
supplies 20260928001934, 20260928031344, 20260928133817 and 20260928134553 plus the
native proof; #5517 supplies 20260928033651. The existing current-main Spin
recognition repair is preserved. No new retry loop, financial policy, runtime
feature or production operation is introduced.
