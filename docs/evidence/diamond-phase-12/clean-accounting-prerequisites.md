# Diamond Phase 12, Line 1: The Clean-Accounting Release Prerequisites, Read As A Time Series

> "Verify existing clean-accounting release prerequisites with actual
> time-series evidence." (docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md, Phase 12)

**Verdict: the three conditions read MET as written at 2026-10-04 22:00 UTC,
with one caveat that is Dan's to weigh before he opens a switch. The line is
not ticked by this file; the tick belongs to the release.**

Production was only read (project `kuklfnapbkmacvwxktbh`, plain SELECTs on
`ca_diamond_incidents`, `fn_ca_diamond_trial_balance()`,
`fn_ca_diamond_health()`, `ca_arena_settings`, `poker_diamond_custody`). No
switch was touched.

## The gate (docs/DIAMOND-ACCOUNTING-ROADMAP.md)

| Condition                                  | Read at 22:00 UTC, October 4                                                                                  | Verdict |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------- |
| Seven consecutive clean trial-balance days | Zero `DR11:trial_balance_break` rows on every UTC day from September 12. Last break: September 11, 15:20 UTC. | Met     |
| Suspense zero                              | `suspense` `balance_now` 0, `journal_net` 0                                                                   | Met     |
| No open critical `ca_diamond_incidents`    | 0 open. Last critical filed October 3, 19:35 UTC, resolved 21:35 UTC.                                         | Met     |

Also read: `register` difference 0 (players + house + custody = register,
exactly); `fn_ca_diamond_health()` returns thirteen areas `ok` and one
`attention` (three budget lines are fiction, which refuses nobody under
Ruling 21 and is Dan's to set); both switches false; `poker_diamond_custody`
holds 0 rows.

## The fourteen days

| UTC day      | Trial-balance breaks | Hourly summaries filed  | Criticals filed | Criticals still open |
| ------------ | -------------------- | ----------------------- | --------------- | -------------------- |
| September 21 | 0                    | 24                      | 0               | 0                    |
| September 22 | 0                    | 24                      | 0               | 0                    |
| September 23 | 0                    | 24                      | 0               | 0                    |
| September 24 | 0                    | 24                      | 0               | 0                    |
| September 25 | 0                    | 24                      | 0               | 0                    |
| September 26 | 0                    | 24                      | 0               | 0                    |
| September 27 | 0                    | 24                      | 0               | 0                    |
| September 28 | 0                    | 24                      | 0               | 0                    |
| September 29 | 0                    | 24                      | 23              | 0                    |
| September 30 | 0                    | 24                      | 23              | 0                    |
| October 1    | 0                    | 22                      | 3               | 0                    |
| October 2    | 0                    | 24                      | 0               | 0                    |
| October 3    | 0                    | 23                      | 1               | 0                    |
| October 4    | 0                    | 22 (of 22 hours so far) | 0               | 0                    |

## The caveat: three hours that were unknown, not clean

The 46 criticals of September 29 and 30 and the first of October 1 were the
horse daily-reward refusal (the streak milestone against the Ruling 18 daily
cap). That is closed: `horse claims` and `rewards lost to expiry` both read
`ok`, and no such row has been filed since October 1, 00:35 UTC.

The other three criticals are a different thing. At 16:35 and 17:35 UTC on
October 1 and at 19:35 UTC on October 3 the health check filed "Trial balance
is incomplete: require one known comparison for each of the five reconciling
accounts", status `unknown`. In those hours no hourly summary was filed
either (22 and 23 summaries on those days). Each resolved itself within two
hours when the trial balance read `ok` again.

An hour in which the trial balance could not be computed is not a break, and
the gate as written counts breaks. It is also not evidence of a clean hour
(CLAUDE.md 10.86: could not tell is its own answer). Read strictly, the last
day with a gap is October 3, so seven consecutive fully evidenced days run
October 4 through October 10. Read as written, the condition has held since
September 12.

Which reading opens the switches is Dan's decision. What caused the three
incomplete hours was not investigated here.

## How to read it again

```sql
select (occurred_at at time zone 'utc')::date as day,
       count(*) filter (where rule = 'DR11:trial_balance_break')   as breaks,
       count(*) filter (where rule = 'DR11:trial_balance_summary') as summaries,
       count(*) filter (where severity = 'critical')               as criticals,
       count(*) filter (where severity = 'critical' and resolved_at is null) as still_open
  from ca_diamond_incidents
 where occurred_at > now() - interval '14 days'
 group by 1 order by 1;
select account, balance_now, journal_net, difference
  from fn_ca_diamond_trial_balance() where account in ('suspense', 'register');
```
