# Preserve deferred balancing through the actual thaw

This is the selected D11 work item from cf64e766666bb3deda8c473c718962001c027bec. It retains the bounded retry for budget-exhausted balance work. The alternative branch's useful delta is a causal thaw listener; its separate sweep and ruling scripts are not another release item.

Frozen balance and expansion stages now share one subscription per manager lifecycle. The real frozen-to-thawed edge schedules the owed pass through the existing scheduler, spread across ten seconds. Shutdown cancels the listener immediately. Refreezing before dispatch rearms the same debt; no wall-clock :00 assumption or fifteen-second freeze polling remains. The manager still checks the freeze before moving seats.

E2 rehearsal, R1, D1, and reviewed wakes remain prerequisites to release admission and production activation. This source change has not been published and performs no SQL repair. The historical R1/R2/R3 scripts retained from the selected branch are evidence, not blanket permission to execute stale predicates or duplicate wakes.

A composition regression also covers a thaw that resumes a sweep cursor already past the skipped balance stage. That stage's debt survives the remaining cycle, schedules a fresh cycle while thawed, and clears only when the work runs. Frozen cycles rely on their existing thaw subscription rather than starting a polling loop. The test executes the real sweep cursor and manager method.
