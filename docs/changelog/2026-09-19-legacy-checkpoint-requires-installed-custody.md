# Legacy checkpoint requires the installed custody contract

The exact 8825 compatibility checkpoint could persist its one-shot intent and
open inspector access before discovering that the database custody functions
were absent. The existing release checkpoint now checks the installed contract
first, through the existing immutable database-proof control artifact.

One bounded GET reads the service-only, STABLE catalog reader supplied by the
mixed-custody migration `20260918232558`. The embedded qualified manifest binds
all 14 public/private dependencies, including the reader itself, by full
signature, body and definition hashes, owner, ACL, search path, security mode
and volatility. Missing, changed, malformed or unreadable responses refuse
before intent persistence. No business RPC is invoked as an existence probe.
The fixed project origin, redirect refusal, credential isolation and existing
release ownership remain enforced. The other predecessor profiles retain their
existing paths; native readiness and the full 285-second reserve still follow
checkpoint cleanup.

Regression protection extends the existing admission suite: the old source
fails the prerequisite-order case; executable shell cases prove refusal leaves
no intent and cannot reach the inspector boundary. The real Python entrypoint
accepts the native service-role READ ONLY result, rejects every dependency's
metadata drift, and refuses transport, permission and malformed-result failures
without retry. The recorded result was independently compared with the full
PostgreSQL catalogue definitions and qualified source/migration hashes.

This source qualification does not prove production installation, the original
23 retained table objects' complete custody evidence, or activation. Those
remain separate release prerequisites; no live inspector or runtime operation
was performed for this change.
