# Retire an expired original while its retry owns no process

The original bd11 release can be observed in systemd activating/auto-restart with no MainPID after announcement-only recovery exits 75. The previous cancellation path required a live wrapper/child and therefore could not admit this positively empty interval.

An explicit empty-retry intent schema now records null original processes and preserves a missing original ControlGroup as null. It is limited to the same expired original request and all existing announcement, immutable source, reservation, complete owned thaw, released hold, seal, serving container and health safeguards. The loaded service must be oneshot/on-failure with the pinned 30-second delay. Exact systemd unit identity and native GetUnitProcesses returning typed empty, zero control PID, stable snapshots and any available cgroup.events establish absence. Unknown, foreign or nonempty results refuse.

The empty path masks only the three original instances. It never stops or adopts a successor racing the masks. An active retry remains pending until natural quiescence; durable intent is never rebound. Closure repeats positive native process proof for all three units before existing receipt and retirement steps. Existing process-owned intents retain their schema and one-stop semantics.

Local regression qualification covers empty admission, raced successors, pending-to-quiet continuation, exact native result shapes and loaded retry settings. The maintained required Linux fixture exercises a real exit-75 oneshot with a 30-second auto-restart delay and natural masked quiescence without a stop. Local macOS cannot execute that fixture; hosted execution remains required. No production action or recovery is claimed.

Native reference: systemd v255 src/core/dbus-unit.c bus_unit_method_get_processes enumerates the unit cgroup and its main/control PIDs; https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c.

Hosted qualification exposed a fixture-only lifecycle error: daemon-reload may unload the stopped unique instance, so reset-failed refuses before the new scenario begins. The fixture now starts its restored template directly. Runtime admission and all native assertions and budgets are unchanged; hosted rerun remains required.
