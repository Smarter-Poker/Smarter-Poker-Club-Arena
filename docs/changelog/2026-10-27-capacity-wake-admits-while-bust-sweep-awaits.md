# Committed capacity wakes admit their dealer while a bust sweep awaits

On October 27, Coffee Break table `f0d3589d` and Morning Grinder table
`22c0c0d4` held seated players without a dealer on engine `bf0e33ae`.
Their committed capacity receipts and late-registration wakes remained pending.
Morning Grinder's missing table dealt only after its manager was replaced,
7 minutes 45 seconds after the add-on hold ended. The full add-on cohort itself
received 130 of 130 correct purchases; that purchase implementation is unchanged.

The independent masked runtime read `40527821215` captured 186,038 lines without
truncation under one immutable container identity. Coffee Break repeatedly
stalled inside `eliminatePlayer`; Morning Grinder's full sweep stalled before
its successor drain and replacement. Reading committed wakes at sweep admission
and removing the sweep's work-budget gate did not help while an older full
sweep was still unresolved: the manager refused another full sweep first.

The original `GameServer.admitTournamentManagerWake` caller now retains its
ordinary scheduler result and separately awaits the existing committed-capacity
dealer handoff for a validated late-registration wake. That handoff creates no
table, moves no seat, reprices no entry, settles no payout and acknowledges no
whole-manager wake. It reads the durable tournament status after the capacity
receipt snapshot and refuses every status except RUNNING. Existing terminal
adoption stays with its original sweep owner.

Ordinary and direct capacity admission share one in-flight receipt operation.
A cause joining a prior SELECT gets at most one fresh bounded pass afterward,
so a newly committed table cannot be lost behind the earlier snapshot. Every
pass retains the existing twenty-receipt limit. The direct cause carries its
own exact manager lifecycle and GameServer ownership checks rather than an
unrelated elimination sweep's aborted signal. Stop, replacement, lease expiry,
F06 recovery ownership and maintenance freeze still fence admission after each
await. The unchanged dealer preparation and native F06 start route retain
hourly, add-on, stage-end and hand-for-hand holds and the final database fence.
There is no new timer, polling repair, restart route or financial writer.

`CausalCapacityWakeAdmission.test.ts` drives the actual GameServer caller, real
manager, receipt admission and managed capacity start path while a real full
sweep remains unresolved. Its admission assertion fails before the caller fix
and passes afterward. It also covers concurrent/duplicate causes, a generation
arriving after an empty snapshot, an aborted ordinary admission, durable terminal
status, unknown reads, lifecycle/lease/owner changes and the existing pause
preparation. Provider publication and prompt natural dealing on the new runtime
remain separate acceptance requirements.
