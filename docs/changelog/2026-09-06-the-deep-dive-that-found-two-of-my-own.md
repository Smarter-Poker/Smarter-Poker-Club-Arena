# The deep dive before Phase 2, and the two defects it found in my own work

2026-09-06. Dan required a full verification pass before Phase 2 of 9: everything
built must be fully coded, wired, tested, pushed and published. It found two
defects, both mine, both shipped the same day, and **neither was visible to the
tests I had written for them.**

## 1. The atomic hand insert failed on every call

`fn_ca_insert_hand_with_awards` — the whole point of the bomb-pot fix — was:

```sql
INSERT INTO public.hand_history
SELECT * FROM jsonb_populate_record(null::public.hand_history, p_row)
```

`jsonb_populate_record` over a NULL base fills every column the caller did not
name with NULL, and **an explicit NULL in an INSERT overrides the column
default**. `hand_history.id` is `uuid NOT NULL DEFAULT gen_random_uuid()`.

Measured against production in a self-aborting probe:

```
23502  null value in column "id" of relation "hand_history"
       violates not-null constraint
```

`bbj_amount` and `reported` are NOT NULL too; `created_at`, `started_at`,
`game_variant`, `source`, `version`, `players` and `actions` would all have been
written NULL instead of their defaults.

**It had no caller yet, and that is the only reason it cost nothing.** The engine
change that calls it is still in PR #3272. Had it deployed, every bomb-pot hand
would have failed its history insert, failed again in the retry queue, and lost
the entire hand record rather than just the award breakdown — I would have made
the defect I was fixing considerably worse.

Fixed in `20260906113554`: the insert names only the columns the caller supplied,
built from `information_schema` and `quote_ident`ed, so every other column keeps
its default.

## 2. The resolution propagation had never once worked

`20260906095606` added two triggers so a resolved alert closes the incident
mirroring it, and vice versa. I verified them by checking the triggers existed.
They existed.

Proved by resolving a probe alert and reading the incident back: **still open.**
`fn_ca_resolution_needs_a_cause` — a guard from an earlier phase — refuses any
resolve without a `root_cause` of at least 40 characters. My trigger set
`status`, `resolved_at`, `correction_ref` and `resolution`, and never `root_cause`.
So every propagation raised P0404.

And then my own handler ate it:

```sql
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '... failed: %', SQLERRM;
  RETURN NEW;
```

`RAISE WARNING` goes to the Postgres log — the exact place CLAUDE.md's own note
on `fn_ca_raise_drift_incident` records 901 consecutive failures hiding in. I
wrote that bug into the same file, on the same day, in a session whose Phase 1
was about a guard that reported the wrong thing.

The 83 mirrors that did close were closed by the backfill `UPDATE` in that
migration, which does set `root_cause`. The propagation — the part that has to
work tomorrow — was dead.

Fixed in `20260906113923`: both directions write a real `root_cause`, and a
failed propagation now records itself in `ca_incident_file_failures` instead of
warning into a log nobody reads. It still never rolls back the resolve that
triggered it.

## What I changed about how I verify

Both defects passed every test I wrote, because those tests **read source text**
— that the engine calls the RPC, that the units come from `perPotAwards`, that
the triggers exist. All true. None of it touched the thing on the other end of
the wire.

So a migration that defines a money-path function now **calls it against the real
table, checks what it wrote, and rolls that back inside a subtransaction**,
aborting the migration if it cannot do its job. `20260906113554` and
`20260906113923` both end that way, and
`TheBombBreakdownTravelsWithTheHand.law.test.ts` pins the habit.

## Also cleaned up

`ca_expected_cron_jobs`, `fn_ca_cron_roster_watch` and
`ca-cron-roster-watch-hourly` are removed (`20260906114257`). I built them to
watch over the bomb repair sweeps; Dan removed the sweeps, and a monitoring cron
watching nothing is exactly what he said not to add. The finding underneath —
that an applied migration's cron job had vanished from `cron.job`, invisible to
every check because a job that does not exist never fails — is kept in prose
here and in the roadmap.

## Verified live, by behaviour

| check                                                               | result                           |
| ------------------------------------------------------------------- | -------------------------------- |
| resolved alert closes its mirror                                    | PASS                             |
| same condition, new date label, same amount: folds                  | PASS (occurrences 2)             |
| same condition, new date label, DIFFERENT amount: does **not** fold | PASS                             |
| retired collusion scan files nothing                                | PASS                             |
| atomic insert writes row + units, defaults applied                  | PASS (in-migration, rolled back) |
| both propagation directions                                         | PASS (in-migration, rolled back) |
| all 8 migrations file-vs-applied parity                             | PASS                             |
| bomb repair crons                                                   | 0                                |

Board: **323 open at the start of the day, 86 now; criticals 135 to 25.**
