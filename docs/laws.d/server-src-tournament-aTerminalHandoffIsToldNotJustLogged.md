# server/src/tournament/aTerminalHandoffIsToldNotJustLogged.law.test.ts

An F06_SOURCE_EXCLUDED terminal-settlement refusal classifies as a rule (escalating
backoff, one critical alert per reason) instead of falling through to `timeout` or
`other` and retrying forever on a flat five-second clock. `recoverTournamentBreak`'s
`terminal_handoff_required` branch raises a durable, deduped critical
`Tournament.break_terminal_handoff` alert in addition to its existing `reportError`
call, instead of only logging a condition that measured live never reached
`financial_alerts` or `operational_alert_events` in nine days of running on every
elimination sweep. Neither pin admits the underlying F06 park itself - that decision
stays with the terminal settlement authority - both make the wait impossible to miss.

Written 2026-09-27, after tournament bfcfaf17 ("DSS Thursday $5.50 NLH Turbo") sat
RUNNING and unpaid for nine days behind exactly this pair of gaps.
