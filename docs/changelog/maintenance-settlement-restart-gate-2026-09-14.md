# Keep in-flight settlements behind the restart gate

Maintenance previously skipped stopped engines and only inspected whether a running engine had a hand controller. An accepted settlement can remain in flight after either state changes, allowing restart readiness to disagree with the shutdown drain's own accounting barrier. Inspection failures also silently removed a table from the gate.

The restart gate now checks the existing settlement ownership signal first, including stopped engines, and holds unreadable engines until their owner can inspect or remove them. Quiet tables with no hand or settlement remain eligible. This changes restart admission only; it does not replay payments, clear settlement barriers, release leases or change maintenance timing.

Regression cases cover running and stopped engines with pending settlements, their actual completion, and failures at each inspection step. The prior gate incorrectly admits all seven cases.
