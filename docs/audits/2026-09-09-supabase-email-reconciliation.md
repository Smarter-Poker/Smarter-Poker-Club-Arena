# Supabase Email Reconciliation And Execution Ownership

Date: September 9, 2026. Source: the user-supplied September 4-8 email thread and
30-day metrics screenshot. Live reads were performed on project
`kuklfnapbkmacvwxktbh` during this continuation. The common historical comparison
window below is **2026-09-08 18:30:00 UTC through 2026-09-09 18:30:00 UTC**, with the
end excluded.

This is an evidence reconciliation and a standing execution standard. It is not
a claim that every database error or notification delivery path has been repaired.
No production DDL, player mutation, notification send, credential change, or
schedule change was performed for this investigation.

## Current Phase And Preserved Work

Phase 10 Cashier history repair remains merged and published in PR3977, with its
verification record merged in PR3987. It retains reconnect invalidations,
pending-read refreshes, account/club ownership, and confirmed history on read
failure. The previous callback ownership, buy-in refusal, and connection recovery
fixes must remain intact.

Both fresh public and origin build-info returned
`18e0f76e7282655f37739750ea40b160a43cbdb8`, built at 18:51:11 UTC by publisher 34390965689. This is a later main build, not a replacement claim for Phase 10's
already recorded served-byte proof.

A fresh engine health snapshot returned version `5dd902e9`, status ok, 186 active
tables, 16 active tournaments, 66 hands in flight, zero stalled tables, and zero
blocked settlements. It reported zero seated humans. This is a snapshot, not a
loaded-fleet acceptance interval or physical-device result. Git ancestry proves
that this engine contains both callback ownership fixes, 89cabee97a and 046f9e4570.

The repository base for this record is `18e0f76e7282655f37739750ea40b160a43cbdb8`.
Current architecture, CLAUDE.md and AGENT-PLAYBOOK.md were unchanged from the
previous fully read continuation. Relevant sibling branches and current main
were checked before proposing a replacement. Diamond and chip-accounting work
remain with their existing programmes.

## Findings Reconciled

| Email Finding                                                | Current Evidence                                                                                                                                                                                                                                                                                     | Status And Ownership                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 112 published tables, 23 used                                | The application publication contains five tables. At 18:46:30 UTC all five had subscription rows: club_members 3, tournament_manager_wakes 2, tournament_bounty_obligations 2, hand_projection_outbox 1, tournament_deal_votes 1. The separate messages publication contains seven dated partitions. | Historical counts are superseded. Do not prune another table from a point-in-time subscriber count.                                                                                                              |
| Move client updates to Broadcast                             | RealtimeChannelService already uses the engine WebSocket transport. Existing private Broadcast and engine socket work must be inventoried before another transport migration. The September 6 WAL repair documents the earlier decode investigation.                                                 | Partly addressed by existing architecture. No new Broadcast migration is justified by the old counts alone.                                                                                                      |
| Six workers versus 32 cron jobs                              | At 18:30:41 UTC: PostgreSQL 17.6, max_worker_processes 6, cron.use_background_workers off, cron.max_running_jobs 32, max_connections 240, max_parallel_workers 4, per-gather 2, logical replication workers 4.                                                                                       | Cron uses client connections in this mode. Six background workers are not its execution-slot limit.                                                                                                              |
| 123 or 124 jobs, ten per minute                              | Current inventory: 140 active jobs, 12 with an every-minute schedule. One connection snapshot had 80 total backends, two active, and no idle-in-transaction backends.                                                                                                                                | Historical counts differ from current inventory. A connection snapshot does not establish peak headroom.                                                                                                         |
| Roughly 17% cron startup failures                            | The fixed 24-hour window has 24,395 succeeded and 130 failed runs, approximately 0.53% failures. Failures include materialized-view refresh errors, deadlocks, timeouts, restarts, and two recorded startup timeouts.                                                                                | Failure classes remain separate. The old rate is not the current window's rate; successful runs do not prove delivery.                                                                                           |
| Excess simultaneous cron work                                | Completed run intervals reach 28 overlapping runs, with 2,016.070 seconds above eight and zero recorded seconds at or above 32. Twenty-two runs in the window lack an end time.                                                                                                                      | This is completed-run overlap, not a complete concurrency ceiling. Treat missing ends separately. The first exploratory calculation including old null-ended records was invalid and is not acceptance evidence. |
| Deadlocks involve a hand-history FK scan from table_seats    | commander_hand_history references commander_games, commander_tables, and poker_venues. No FK in the inspected set references public.table_seats.                                                                                                                                                     | The suggested direct relationship does not exist in this schema. No index was added or restored on that premise. Commander index analysis belongs to its owner after actual conflicting statements are obtained. |
| Tournament reminders fail                                    | Fifteen deadlocks and one restart failure occurred in the reminder cron during the fixed window. The latest deadlock was 10:05:03 UTC. All 450 runs from 11:00 through 18:29 succeeded.                                                                                                              | A historical failure is proved; permanent resolution is not. The reminder generator still depends on cron and is a candidate for the new execution standard.                                                     |
| Notifications should use pgmq already installed              | Neither a pgmq extension nor a pgmq schema exists in this live project. push_outbox already exists, with claiming, attempts, status and stuck-work recovery functions.                                                                                                                               | The installation premise is unsupported. Evaluate the existing durable outbox before adding another queue.                                                                                                       |
| Notification runs equal delivery                             | The fixed window contains 864 fifteen-minute reminder rows and 911 two-minute rows. Of these, 1,773 were skipped for no_subscription; two were folded into one digest, whose row was also skipped for no_subscription.                                                                               | No successful provider or device delivery is established by these rows. Do not resend to real users as a probe or bypass consent.                                                                                |
| 160,491 undefined-column and 570,088 check-constraint errors | The authenticated CLI can see the target project, but the documented Management API logs request returned HTTP 403, error code 1010. This connector exposes no get_logs tool.                                                                                                                        | Exact current SQLSTATE/column/constraint grouping and both sides of deadlocks remain unverified. Preserve safeguards; do not diagnose chip loss from historical totals.                                          |
| Most of 2 TB egress is Realtime                              | No service-level egress breakdown for the email's billing period was retrieved. Logical slot lag was approximately 63.6 KB in one fresh snapshot.                                                                                                                                                    | Realtime's share of egress and before/after savings remain unmeasured. Slot lag is not egress or capacity proof.                                                                                                 |
| An 80 GB cold solver dataset                                 | solved_spots_gold is 85,554,315,264 bytes including its relation storage, is not published, and showed zero write counters in the snapshot. It also showed 43,719 index scans with no established comparable reset window.                                                                           | Separate storage/capacity work. Near-zero reads is not established by this snapshot. Preserve the dataset; no storage migration belongs in the Cashier repair.                                                   |
| The screenshot proves improvement                            | The screenshot covers a historical 30-day interval with frequently high CPU. Cache/buffer memory differs from active application use. The meaning of EBS balance must be checked against the actual series.                                                                                          | It does not prove current headroom, explain network spikes, or accept a release.                                                                                                                                 |

## Reminder Failure Trace

The cron job name is `sp_upcoming_tournament_pushes`; its actual function is
`public.check_upcoming_tournament_pushes()`. The live definition matches the
August 31 repair of the deleted `user_presence` dependency. It now checks
`table_seats.left_at IS NULL`.

The recorded deadlock context shows an UPDATE of
`tournament_players.push_2m_sent` joined to eligible tournaments, followed by a
foreign-key KEY SHARE check against `public.tournaments`. Both sides of the
conflicting transaction are not available in the cron record. This does not
establish a commander_hand_history scan or justify changing accounting locks.

The function inserts reminder rows into push_outbox and sets reminder booleans
inside the same transaction. A deadlock aborts that transaction, so its attempted
rows and flags do not become a committed reminder. A later invocation can retry
while its eligibility window remains open; the booleans alone do not provide
versioned rescheduling evidence or demonstrate that an expired reminder recovered.

The existing delivery route is documented by
`supabase/functions/send-push-notification/index.ts`: World Hub's
`/api/cron/push-dispatch` drains push_outbox and applies consent. That retired Edge
Function intentionally returns 410 and must not be reactivated as an unauthorized
relay. Its source establishes the named owner; its live implementation, invocation,
provider acknowledgment, retry limits, and native-device dispatch must be checked
with the World Hub owner before replacing this cross-repository path.

## User-Directed Standard And Next Implementation Boundary

The user explicitly prefers built-in execution for significant Club Arena work.
The binding standard for this programme is
`docs/standards/EVENT-DRIVEN-EXECUTION.md`.

For reminders, the replacement must give durable deadlines to an engine or
always-running service, explicitly wire creation/registration/reschedule/cancel
signals, recover on restart, and make the existing outbox delivery owner
independent of a cron-only trigger. Moving the generator while leaving its only
dispatcher cron-dependent is not complete compliance.

Before changing this flow:

- Obtain both deadlock statements and current error groups through an authorized
  logs interface. Do not infer the missing statement from a lower stack frame.
- Verify the current World Hub dispatcher and coordinate its replacement through
  the existing repository workflow. Preserve consent, private topics and native
  transport work.
- Define a stable reminder identity including the tournament schedule version,
  stage, and recipient. Acknowledge only the actual processing outcome.
- Reproduce cancellation, rescheduling, duplicate events, provider acceptance
  followed by a worker crash, restart recovery, expiry, and a missed primary wake
  in isolated tests. Prove the primary path without the old cron.
- Deploy and verify the replacement before demoting or removing either schedule.

These items are not implemented by this documentation change. The new standard
is recorded; the notification replacement remains open. The missing detailed logs,
provider acceptance evidence, and authenticated physical-device session must not
be described as completed work.

## Reproduction And Sources

Reproduction SQL: `docs/audits/2026-09-09-supabase-email-reconciliation.sql`.

The fixed window and effective settings above were read through Supabase
execute_sql, without DDL. Use start_time >= the lower bound and start_time < the
upper bound for cron.job_run_details. Aggregate error first lines separately from
run status. For overlap, use completed [start_time,end_time) intervals, group equal
timestamps, then cumulatively sum start +1 and end -1 events. Do not treat
historical null-ended failed runs as continuously running workers.

Use pg_publication_tables for the inventory, realtime.subscription grouped by
entity for the point-in-time consumers, pg_constraint plus pg_get_constraintdef
for actual FK relationships, and pg_get_functiondef for the deployed reminder
function. Outbox evidence is aggregate status/failure_reason only; no recipient
identifiers or full production rows are required.

Current official references were checked:

- https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- https://supabase.com/docs/guides/cron
- https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint

The changelog says the newer logs endpoint uses source_name and ClickHouse SQL.
The docs search also returned examples using source. Verify the actual interface
before executing a query; this run's request was refused before that syntax could
be validated. The logs.all removal date is September 23, 2026.

Supabase and Postgres best-practice skills were read, and the current changelog
was fetched and checked for relevant breaking changes. No dependency, CLI,
extension, publication, index, RLS, credential, or production schema was changed.
