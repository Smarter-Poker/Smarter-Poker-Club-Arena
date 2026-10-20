# MTT Started Late

Use this runbook for `MttStartedLate` and `MttLaunchLatenessBlind` in the
`tournament-health` group of `infra/monitoring/tournament-rules.yml`. Both
observe; neither starts, reschedules or refunds a tournament.

## What fired

`MttStartedLate`: at least one MTT (`format_contract` `mtt-v1`/`mtt-v2`)

- dealt its first hand more than 120 s after `start_time`, and that hand was
  recorded in the last 15 minutes (`poker_mtt_late_first_hands`), or
- is still ANNOUNCED/REGISTERING/RUNNING with no recorded hand 240 s after
  `start_time` (`poker_mtt_late_start_waiting`). The extra 120 s exists because
  a hand is written to `hand_history` when it ends (p99 77 s after it starts),
  so an on-time first hand still in play is not counted.

`poker_mtt_worst_late_start_seconds` is the largest lateness among them.

**Do not read `tournaments.started_at` to check this.** It is written equal to
`start_time` and shows every event as on time. The truth is the first dealt
hand:

```sql
SELECT t.id, t.name, t.status, t.start_time,
       f.first_started,
       round(extract(epoch FROM f.first_started - t.start_time)) AS late_s
  FROM public.tournaments t
  LEFT JOIN LATERAL (
    SELECT min(x.started_at) AS first_started
      FROM (SELECT h.started_at FROM public.hand_history h
             WHERE h.tournament_id = t.id
             ORDER BY h.created_at ASC LIMIT 20) x
  ) f ON true
 WHERE t.start_time > now() - interval '2 hours'
   AND t.start_time < now()
   AND t.format_contract IN ('mtt-v1', 'mtt-v2')
   AND t.status <> 'CANCELLED'
 ORDER BY late_s DESC NULLS FIRST;
```

## What the measurement showed when this was built

From 2026-10-12 to 2026-10-18, 20-30% of scheduled MTTs dealt their first hand
more than 60 s late and 9-14% more than 120 s; the worst was 7,648 s. By minute
of the hour, every MTT scheduled :53-:57 was late (held through the hourly
maintenance break) and :00 starts had a median lateness of 85 s, 59 of 212 over
120 s. Starts at other minutes were almost always under 2 s. So a firing near
the top of the hour most likely names a launch held by, or released slowly
after, the break; a firing at any other minute is a launch that stalled on its
own. Read the engine log for the event's launch (`ScheduledTournaments`,
launch roster hand-off, field preparation) before anything else.

The rule is not break-guarded on purpose: players registered for the advertised
time. Fix late launches at their source; do not widen the threshold to quiet it.

## MttLaunchLatenessBlind

`poker_mtt_launch_lateness_stale_seconds` above 600 for ten minutes means the
lateness read has not answered (86400 means never since this engine started),
so `MttStartedLate` cannot fire. Check that
`public.fn_tournament_launch_lateness_metrics` exists
(`SELECT to_regprocedure('public.fn_tournament_launch_lateness_metrics(integer,integer,integer,integer)')`)
and that `service_role` can execute it. The established tournament gauges are
read separately and are not affected.
