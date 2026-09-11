# Periodic Engine Supervisor Retired

The engine no longer has a 60-second systemd owner that samples runtime state
and mutates the container. That loop could overlap an intentional stop or an
in-progress release and was no longer necessary after the immutable release
transaction gained synchronous rollback plus ExecStopPost recovery.

The installer now removes the old service, timer, and enablement symlink and
fails unless they are inactive and absent. The frozen release-v1 script name is
retained only as a one-shot compatibility entrypoint. It requires the caller to
hold the engine mutation lock, demand exact health, force the sealed desired
image, and supply an absolute deadline. It has no autonomous mode, sampling
counters, heartbeat, mutable-tag repair, or background schedule.

Monitoring now loads `recovery-rules.yml`. Those rules page on the result or
absence of the daily read-only recovery audit; they do not depend on a mutating
watcher's heartbeat.

This is intentionally not described as platform-wide watcher eradication.
`sp-autoheal` remains until a causal replacement can safely own a
live-but-unhealthy process, and the durable BBJ payout queue remains until its
claim-and-deliver worker is separated from FeeReconciler's periodic historical
repair scans. Deleting either today could strand a jackpot obligation or leave
a wedged engine running forever.
