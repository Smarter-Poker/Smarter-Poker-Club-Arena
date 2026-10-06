# Three cron rows moved, and the roster says which

2026-10-03. `Cron Health` run
[37123770239](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37123770239)
failed on two separate steps. This change answers the second one:

```
[cron-roster] THE NUMBER OF ACTIVE SCHEDULED JOBS CHANGED: 124 -> 125.
```

`scripts/ci/anchor-cron-roster.mjs` is the one reader in this estate that can
see a pg_cron job appear or vanish, because every other cron check measures
jobs that RUN AND FAIL and a job that no longer exists never fails. It refuses
to pass until somebody says which job moved and why. So:

## What moved

Read live from `fn_ca_cron_health('24 hours')` at 2026-10-03 13:25 UTC: 125
active rows, 2 inactive, 127 rows in `cron.job`. The total is 127 on both sides
of this move, which is a coincidence of three rows and not one row standing
still.

| row                                                      | was               | is                   | why                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client-error-events-prune` (jobid 408, `16 * * * *`)    | absent            | active               | scheduled by applied migration `20261003080431_players_errors_reach_a_first_party_sink`. It runs `fn_prune_client_error_events(interval '14 days', 20000)`: retention pruning, which is the kind of timer CLAUDE.md 10.12 allows by name, because its schedule IS the work and it repairs nothing. Another owner's job, listed here and not judged here. |
| `union-weekly-rakeback-close` (jobid 272, `*/5 * * * *`) | retained inactive | active               | applied migration `20261003101805_the_weekly_close_commits_one_round_at_a_time` re-armed it with `cron.alter_job(..., active := true)` and the chunked command. It was stood down on 2026-09-30 while `20260928164258` reworked the close, which is why it was the third retained-inactive row; it is now a body row instead.                            |
| `midway-close-once-20260929d` (`4 13 29 9 *`)            | active            | gone from `cron.job` | unscheduled by hand. The 2026-09-30 roster note already recorded it as a hand-made spent one-shot carrying job 272's old command, whose next fire was 2027-09-29, and said unscheduling it was its owner's call.                                                                                                                                         |

## The disappearance is the part worth reading

A vanished cron job is the shape of `20260831112020`: a migration recorded as
APPLIED whose job was simply not in `cron.job` any more. That is the failure
this file exists to catch, so it does not get waved through.

It is not that case here, and the evidence is specific. A query of
`supabase_migrations.schema_migrations.statements` for `midway-close-once`
returns exactly one row - `20260930232545`, which mentions the name in a
COMMENT explaining where its `SET statement_timeout` pattern came from. No
applied migration created it and none removed it. It was hand-scheduled on
2026-09-29 and hand-removed, and nothing recorded as applied depends on it.
`20261001200224` had already unscheduled its siblings under the
`midway-0921-close-once-%` prefix, for holding one transaction open for 38-45
minutes during live play.

## What changed in the repo

- `docs/attestation/cron-roster.tsv` - regenerated body (125 rows), `# active:`
  125, `# retained-inactive:` 2, and the paragraph above in its header beside
  the previous ones.
- `tests/the-scheduled-work-roster-is-pinned.law.test.ts` - `ACTIVE_JOBS` 124 ->
  125, `RETAINED_INACTIVE` 3 -> 2, the argument in the docblock. `TOTAL_JOBS`
  still has to be 127. The "three rows cron.job keeps inactive" case now asserts
  `union-weekly-rakeback-close` is an ACTIVE BODY ROW rather than merely present
  somewhere in the file, which is a stronger statement than the one it replaces:
  the old `expect(raw).toContain(...)` would have passed on the name appearing
  in a prose note.
- `scripts/ci/anchor-cron-roster.mjs` - `RETAINED_INACTIVE` 3 -> 2 and the
  header text it writes, which no longer names job 272 as stood down.

Nothing was muted and no threshold moved. The other `Cron Health` failure in the
same run, `tourney_money_conservation_deep_daily` CRITICAL, is untouched here
and is correct: `20261003072524` made a daily job's verdict depend on its last
three finished runs, and that job's last three all failed (10-01, 10-02, 10-03)
at the old 600 s budget. The budget is now 1500 s in `cron.job` 274 against a
measured ~880 s need, and the first run that exercises it is 2026-10-04
03:25 UTC. Forcing that earlier by editing its schedule would be gaming the
check, so it waits.
