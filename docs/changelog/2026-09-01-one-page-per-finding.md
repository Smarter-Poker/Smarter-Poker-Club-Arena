# One page per finding, not one per row

Dan, 2026-09-01: "im getting double push notifications for every chip drift
again, thats has to stop, one notification one time is all that i need."

The word that mattered was **again**. This had been fixed twice, both times
with a clock, and both times the clock was the reason it came back.

## What Dan actually received

From `notifications` and `push_outbox` in production:

| when (UTC)                             | what                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| 2026-09-01 17:28:48.927063 and .927145 | "Chip drift: unauthorized_adjustment (0.00)" twice, **82 microseconds apart** |
| 2026-09-01 13:42:17.910620             | "Resolved: treasury_error drift" x3, one instant                              |
| 2026-08-31 20:10:20.800684             | "Resolved: unauthorized_adjustment drift" x20+, one instant                   |
| 2026-09-01 17:30 and 18:00             | the same standing suspense regression, paged on the hour                      |

## The two code paths

**1. `fn_ca_journal_append_only`.** A per-ROW trigger whose `dedupe_key`
carried a per-row salt, so one multi-row DELETE minted one
`ca_drift_incidents` row per deleted row, and `fn_ca_raise_drift_incident`
pushed once per row. That is the 82-microsecond pair: incidents
`bb02c201-2f16-41b9-81a6-41489cb7c930` and
`4a15aff5-6697-460d-860b-11117693f64c`, identical in every field a reader can
see, differing only in the md5 inside the key. Today's earlier migration
`20260901174548` removed the salt but replaced it with a per-DAY bucket, which
stops the flood and re-pages every midnight instead.

**2. `fn_ca_incident_action('resolve')` and `fn_ca_auto_reconcile_tick`.** Both
call `fn_ca_incident_notify` once per incident inside a loop. Twenty-five
incidents that are one finding become twenty-five pushes in one tick. That is
13:42:17 and 20:10:20.

A third path re-pages rather than double-pages, from the same root cause:
`fn_ca_suspense_regression_check` keyed on
`suspense-regression:YYYY-MM-DD-HH24`. The hour is in the key, so an unchanged
condition mints a brand-new incident every hour, forever.

## Why the previous fixes did not hold

Both were time windows.

- **`fn_ca_raise_drift_incident`** suppresses when 10 or more incidents were
  created in the last 2 minutes. A pair never reaches ten. It has never once
  fired for the case Dan is complaining about.
- **"DIGEST MODE" (2026-08-31)** in `fn_ca_incident_notify` collapsed when a
  recipient already had 3 or more financial pushes in the last 5 minutes. The
  count is taken **before** sending, so notification one and notification two
  always went out and only the third onward collapsed. **A double is
  structurally immune to a three-in-five-minutes digest** — the threshold is
  precisely why Dan received exactly two, every time.
- The same 2026-08-31 pass also made resolution pushes criticals-only. That is
  a severity filter, not a dedupe: a bulk resolve of three CRITICAL
  `treasury_error` incidents still sent three pushes.

## What changed

`ca_incident_notify_ledger` records, per recipient, the last state actually
delivered for a **finding**. `fn_ca_finding_key` defines what a finding is: the
dedupe key with the two things that were never part of the finding stripped off
(a per-row salt, a time bucket), plus its scope. The state is the kind of
notice, severity, classification, layer and scope — and for an escalation, the
level. It is deliberately **not** the amount, because a standing drift whose
number jitters from 5929.18 to 5960.92 is the same finding.

`fn_ca_incident_notify` now sends only when the upsert into that ledger wins,
which happens when the recipient has never been told about the finding or its
state has genuinely changed. The upsert carries the `WHERE` clause, so two
callers racing inside one statement cannot both win it — which is what the
82-microsecond double was.

The digest block is deleted rather than tuned. It was the failed clock, and it
also collapsed genuinely different findings into "see dashboard", which loses
signal.

Both clock-bucketed producers are also fixed at source, so one finding is one
incident row for its whole life: `journal-bypass:<table>:<op>:<kind>` and
`suspense-regression`, with no date and no hour.

The 10-in-2-minutes backstop in `fn_ca_raise_drift_incident` is deliberately
left alone. It is a last-resort circuit breaker against a storm of genuinely
distinct findings, not the primary dedupe.

## What still pages, and once

Verified against production with rolled-back probes (nothing committed;
`ca_drift_incidents` and `notifications` both confirmed clean afterwards):

| case                                                     | pushes             |
| -------------------------------------------------------- | ------------------ |
| a real drift is raised                                   | 1                  |
| a second incident row for the same finding, same instant | 0                  |
| the same finding, amount jitters                         | 0                  |
| three rows, one finding, bulk-resolved                   | 1 raise, 1 resolve |
| severity goes warning to critical                        | 1, immediately     |
| a resolved finding recurs                                | 1                  |

Live confirmation after the migration applied: the `certification-cleanup`
journal-bypass finding, which had been raising continuously all afternoon,
recorded `send_count = 1` at 18:47:37 UTC and produced exactly one
notification. Every subsequent run of that cleanup is silent until somebody
resolves it or it changes.

## The law

`tests/one-page-per-finding.law.test.ts` (registered in `docs/LAWS.md`) pins
the shape rather than the volume: the sender must key on the finding ledger,
no time window may be the dedupe inside the sender, a finding key may never
contain a clock, and no drift producer may bucket its dedupe key by
`to_char(now(), ...)`. All four assertions are RED against the tree as it stood
before this change.
