# tests/a-reminder-needs-a-device.law.test.ts

No tournament reminder is enqueued for a recipient with no active push
subscription: `prepare_tournament_reminders` filters candidates on one, its
`next_due_at` report counts only the same, and `trg_claim_tournament_reminder`
refuses an unreachable row at the table without claiming a receipt - so a
device enrolled inside the window still earns the reminder. The gate is
REACHABILITY and never species (CLAUDE.md 10.5): neither routine may mention
`is_horse`, a human with no device is refused by the same line as a horse with
no device, and a horse that has one is admitted like anybody else.
