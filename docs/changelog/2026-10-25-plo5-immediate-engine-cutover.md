# Immediate PLO5 engine cutover

The owner explicitly instructed this chat to deploy now rather than wait for
04:00 Chicago, then verify the PLO5 refill split, cent rounding and add-on
notices on live tables. PR #8042 is already protected merged; its client is
published, while the engine is still serving the preceding version.

The existing owner-maintenance window names the exact #8042 merge, quotes the
order and expires in under six hours. It permits an immediate announcement
without restricting it to an hourly minute. Both existing gates still require
protected main, an unserved target, fresh health, ownership, the existing
announcement lead, drain, database freeze, full rollback reserve and thaw.
The normal daily schedule is unchanged. No migration, new scheduler, alternate
publisher, commit-message urgency or direct restart is introduced.

A real-shell regression exercises an unrestricted-minute owner order through
the existing lock, reservation and request path. Existing negative cases retain
expired, malformed, already-served and spent-hour refusals. Installation and
natural-hand behavior remain pending until the owning release seals and live
verification passes; the task checkpoint retains the actual run identities.
