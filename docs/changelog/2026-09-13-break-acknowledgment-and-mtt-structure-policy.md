# A break releases after acknowledgment; MTT speed follows the actual clock

Break resume previously discarded returned database errors, cleared its local
hold before persistence finished, and could release tables after losing
ownership during notification. The engine now retains the hold, coalesces
concurrent clear attempts, schedules one lifecycle-bound retry after failure,
and checks ownership after persistence, notification and deferred add-on work.
Four runtime regressions reproduced these failures before the repair.

Scheduled and recurring MTT presets now share one engine module. Scheduled,
recurring, union and Free Buy creation paths publish speed metadata from the
actual opening clock; manual repeat creation also recomputes it. Explicit
custom arrays override preset metadata, legacy seconds remain supported, and
deep stacks do not imply a slow clock. Existing ladders and funded events are
preserved. This fixes newly created turbo events silently receiving the
database's `is_turbo=false` default.

Validation: 47 focused break/clock/ownership tests, 90 structure/service tests,
65 creation-path tests and the server typecheck pass. The expanded full
tournament suite and protected CI are tracked separately; deployment and
native financial acceptance are not implied by these local results.
