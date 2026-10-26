# A refused heartbeat answer is not a missing answer

The lease follow-up handoff recorded a tournament loss at 21:41:18 UTC on
October 25 (`5469ba74`) whose heartbeat answered but the engine refused to
renew. Both the ordinary ownership pass and its retained callback reported
“no answer arrived” for this path. The historical log was rotated away; this
change does not invent that incident's missing cause.

`TournamentManagerBase` retains a bounded refusal code at the exact failed
renewal branch: unavailable manager authority, invalid received deadline,
elapsed received deadline, a terminal dealer no longer owned by this server,
or a dealer that refused renewal. Dealer failures retain the table ID. The
getter copies diagnostic data and changes no authority. A successful renewal
clears the prior refusal. Condition order, deadlines, dealer checks and
fencing remain unchanged.

`GameServer` captures the first local refusal for that exact manager object
before fencing can change its state. Ordinary and retained-callback reports
say the heartbeat answered and carry the refusal. Database refutation stays
separate; absent answers stay unproven. Replacement manager/generation checks,
completion handling and classify-once fencing are preserved.

Three new regressions failed against the original implementation. The focused
83-case manager, retained transport, normal-completion, quarantined-stop and
engine-boundary suites pass, including a real dealer refusal and lost dealer
ownership. The change is engine source and needs protected integration,
qualified activation and serving inclusion. It is a reporting fix, not proof
that the separate main-thread saturation is fixed.
