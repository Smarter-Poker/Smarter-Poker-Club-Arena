# Recover completion for an orphaned engine seal owner

A manually committed serving image retained finalization under a run attempt
with no native request, pin or invocation. The ordinary release correctly
proved the already-serving image but could neither record its own completion
nor allow a later release to prepare while that finalization remained.

The existing `already-released` completion event now has a bounded recovery
path under the actual engine mutation lock and the seal lock. It verifies its
own immutable request, intent, generation and native systemd invocation;
refuses retained, active, queued, enabled or unreadable original-owner state;
and independently rechecks exact image/container/start identity, local/public
health and a database leader heartbeat no older than 15 seconds. It writes a
truthful current-run receipt and durable audited orphan disposition before
clearing only the captured finalization. Original commit authorship remains
unchanged, and the retired owner cannot recreate finalization or borrow a later
invocation to manufacture its missing original completion.

No restart, cutover, maintenance waiver, publisher, schedule or financial write
is added. A corrected protected control generation can certify the same serving
runtime through the existing receiver. This certifies present state only and
never retroactively certifies the manual activation.

The existing release-seal law invokes direct Python regression scenarios using
real locks, atomic state/result files and audit replay, with isolated native
systemd/Docker/HTTP/database witnesses. The positive regression fails against
758610f3 at the original foreign-finalization guard and passes with the repair.
Live native completion, protected delivery and affected gameplay verification
remain separate provider-owned evidence.
