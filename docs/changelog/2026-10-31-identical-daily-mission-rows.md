# Identical Daily Mission updates preserve the dashboard revision

The trusted increment API accepts a zero increment. PostgreSQL still runs the
row UPDATE trigger when the stored mission row is identical. The previous
trigger wrote a dashboard revision and sent a paid private Broadcast even
though no dashboard input changed.

Migration 20261031170536 returns before that work only when the complete OLD
and NEW records are identical. All genuine fields, inserts, deletes, diamond
and streak changes, completion notifications, existing source ACLs and
transport-error behavior remain in the original implementation. Installation
requires the captured source hash and exact private authority; drift and replay
refuse atomically. Paid Realtime remains enabled. No financial or retention
rule changes, schedules, background repair or engine replacement are involved.

The native PostgreSQL 17 regression reproduces the old failure, then checks 100
identical updates cause zero revision writes or broadcasts. It also checks
actual changes, the completion toast, two users, profile/streak sources,
savepoint rollback, transport failure, exact ACL/config drift and replay. The
existing required Data Console native PostgreSQL step invokes this regression;
its script-only changes select that step through the existing scripts/dev rule.

The regression proves avoided work for identical updates. Actual production
occurrence, billable message reductions and recurring gross/net dollar savings
must be measured after installation; they are not inferred from this test.
