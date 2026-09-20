# The predecessor checkpoint recognizes the held engine lock

The 01:55 UTC release stopped before native checkpoint invocation because the
helper compared `/run/lock/club-arena-engine-up.lock`, resolved from its inherited
descriptor, against the configured `/var/lock/club-arena-engine-up.lock` alias.
Both names identify the same file on the production host.

The helper now compares file identity using Bash's `-ef` predicate against its
own descriptor. Missing, closed and unrelated descriptors still fail before the
unchanged nonblocking lock check, immutable operation checks and native entry.
The complete maintenance certificate and 285-second reserve remain required.

The retained regression exercises the actual guard with real filesystem aliases,
including canonical, foreign, closed and missing paths. Linux uses an actual
inherited descriptor; Darwin substitutes a filesystem link for unavailable
procfs. A read-only production-host descriptor probe reproduced the old refusal
and passed the corrected predicate without acquiring or changing the lock.

Local checks, protected integration and subsequent deployment evidence are
recorded in the Must Move launch checkpoint. This source correction alone does
not establish engine activation or restored time-bank custody.
