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

The scheduled writer also preserves an explicit bounty amount to cents instead
of rounding it to whole chips. The regression reproduced a configured 6.75
head becoming 7.00 on a 13.50 contribution plus 1.50 fee. The cap remains the
contribution after the fee; existing whole-chip entry pricing and percentage
fallback policy remain intact. This changes future engine-created entries,
not already funded contracts.

Validation: 47 focused break/clock/ownership tests, 90 structure/service tests,
65 creation-path tests and the server typecheck passed. The expanded suite
passed 1,968 checks across 158 files before the additional bounty-precision
regression, which was then reproduced and repaired separately. Protected CI,
deployment and native financial acceptance remain separate evidence.
