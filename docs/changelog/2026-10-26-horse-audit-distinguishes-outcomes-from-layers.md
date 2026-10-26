# The horse audit distinguishes outcomes from execution layers

The October 25 audit called fewer unexecuted Phase 12 decisions a layer
collapse, and called quiet Phase 6 context errors missing layers. It also
graded VPIP-floor branch outcomes even though the existing audit design says
they describe outcomes within the floor rather than execution of the floor.

Keep those original counts in the existing quiet-outcome information group.
Exclude their drops from the layer-collapse calculation. Genuine layer fires,
application and authority counters, missing original populations, and the
VPIP floor's own execution counter retain their existing warnings. A quiet
error counter does not establish health; its parent and accepted execution
receipts still need inspection.

Native PostgreSQL reproduces the original false warnings, then tests the
corrected function body against quiet errors, declining unexecuted outcomes,
and changed floor outcomes. Negative controls require a genuine V15 collapse,
a missing Phase 10 application counter, and a real floor execution collapse
to remain visible. The existing accounting shard runs this source-bound fixture.
No strategy, selector, financial record, schedule or historical telemetry changes.
