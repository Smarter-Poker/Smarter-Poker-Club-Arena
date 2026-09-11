# Native transport evidence blocks premature lease activation

The unit-tested three-per-scope client-operation bound is not yet a physical
renewal RPC bound. The native rehearsal now includes PostgREST14.5, a12-connection
pool, the actual structurally extracted GameServer admission method, real
five-second ticks, the actual service client and exact v4 heartbeat SQL.

The installed configuration readback found a10-second pool-acquisition timeout
and8-second role statement timeout, while the ordinary client aborts at15 seconds.
The native queue case observes physical work remaining after that client timeout.
The actual admission case observes eight simultaneous renewals after timed-out
operations free local slots. A controlled loopback gateway independently sends
early504/EOF responses, then forwards all eight already-settled calls after20
seconds and observes eight concurrent database renewals. This injected gateway
fault does not describe the installed provider's current behavior.

`scripts/dev/probe-lease-postgrest.mjs` creates and removes its own local PG17
cluster, uses loopback HTTP only and imports the real client only after stripping
inherited service credentials. It records source, SQL, client, method, probe and
binary fingerprints. Supply absolute PostgREST14.5 binary and evidence-directory
paths, followed by optional isolated pool timeout and size. The full adversarial
matrix uses10 and12. Exit2 means GAP_REPRODUCED, exit1 means a fixture failure,
and exit0 means only that the selected matrix did not reproduce the gap.

Keep proof interpretation separate from physical terminal evidence. Releasing an
unknown slot needs a trusted cancel/terminal receipt covering delayed forwarding,
or an appropriate existing session-preserving database identity and exact old
session retirement. SQL tombstones alone prevent future renewal writes but
cannot prove that a queued HTTP request has physically terminated. A smaller
pool or timeout, permanent slot quarantine, or process restart is not the fix.
No production configuration or credential was changed. D6 remains unqualified.
