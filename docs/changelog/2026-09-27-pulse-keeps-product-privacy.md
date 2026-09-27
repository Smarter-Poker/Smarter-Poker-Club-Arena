# Pulse metrics keep caller product privacy

The authenticated pulse RPC failed on its direct `cron.job` lookup because browser roles have no usage privilege on the cron schema. Granting that schema or elevating the whole pulse would expose more than the two counts the pulse needs.

A fixed, argument-free function now reads only the existing active home/pnm job count and the last 24-hour failure count. This narrow function uses its owner privilege and returns two numbers; it cannot return job names, commands, errors or product rows. Only authenticated and service roles can invoke it. The pulse itself remains an invoker and every product query, output key, permission and caller RLS remains unchanged. The existing detailed health view and service-only health function are untouched. No scheduler or telemetry service is added.

The existing required discovery native test now reproduces the installed cron grants and RLS, then verifies the pulse with three distinct users, anonymous refusal, raw cron denial, count semantics, rollback, replay, zero counts and unchanged non-cron payloads. The older privacy and two-session visibility tests still execute. Source checks do not establish production installation or a UI caller; no maintained application call site was found for this existing RPC.

The native owner test also uses the actual production role boundary: postgres is NOSUPERUSER BYPASSRLS, the browser is neither, and the counts include jobs owned by another database role. Installation 20260927041025 preserved the outer RPC identity and permissions. A read-only authenticated database-role invocation returned the full pulse object with 13 active jobs and 107 failures at 04:10 UTC; this is RPC proof, not a browser/UI claim.
