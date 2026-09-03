# The alarm measures the engine, not our opinion of it

**2026-08-31 — Phase 2 completion audit**

## What happened

An hour after `fn_rake_law_check` shipped in #2191, two migrations were applied
to production on top of it — `20260831141737` and `20260831142001` — that
changed how it resolves a stake's rake cap. Neither was committed to the
repository. `fn_unscheduled_cap_bb`, which they created, returned zero hits in a
code search of the whole repo.

They moved the alarm's idea of the cap away from the engine in two ways:

1. **Six schedule rows the engine does not have** — `0.01/0.02`, `0.02/0.05`,
   `0.05/0.10`, `0.10/0.25`, `25/50`, `50/100` inserted into `ca_rake_schedule`.
   `RAKE_SCHEDULE` in `src/config/RakeConfig.ts` still carries fourteen rows and
   none of those six.
2. **A proportional bound the engine does not apply** — the tier fallback became
   `LEAST(tier.rake_cap, bb * fn_unscheduled_cap_bb())`, where that helper
   derives 15 BB from the schedule's own worst ratio. `getRakeConfig` takes the
   exact schedule row, else the tier cap, and stops.

## Why that mattered, measured

`0.05/0.10` is a live stake: **1,206 raked hands in 48 hours, top rake 3.00** —
exactly the `nano` tier cap the engine applies, and correct behaviour. After
those migrations the database answered **1.50** for that stake, so **63 of those
1,206 hands would have been filed as `over_cap` criticals against an engine
obeying its own schedule to the cent**.

No false critical was ever actually written — the window had moved past those
hands — but the landmine was armed for the next time a `0.05/0.10` table ran.
An alarm that cries wolf on correct behaviour is worse than no alarm: it teaches
whoever is on shift to scroll past `rake_law`.

## What was kept

The second migration replaced the tier lookup's `p_bb >= min_bb AND p_bb <=
max_bb` with a cascade on `max_bb` alone. **That was a genuine bug fix and it
survives**, because `getTierForBB` _is_ a cascade — `bb <= 0.2` nano, `<= 0.8`
micro, `<= 3` small, `<= 8` mid, `<= 40` high, else nosebleeds — with no gaps,
while the min/max form left `0.2–0.3`, `0.8–1.0`, `3.0–3.5`, `8.0–9.0` and
`40–41` resolving to `NULL`. A `NULL` cap does not fail loudly; it silently
switches the `over_cap` check off for every table in those bands.

## What was not thrown away

The engine's nano cap is **3.00 on a 0.10 big blind — thirty big blinds of
rake**, against a published schedule whose own worst ratio is fifteen. That is a
real observation and it deserves a decision, not a deletion. The six rows stay,
flagged `source = 'proposed'`, excluded from cap resolution, and reported by the
new `fn_rake_schedule_drift()`:

| stake     | engine charges | proposed | engine cap in BB | raked hands, 48h |
| --------- | -------------- | -------- | ---------------- | ---------------- |
| 0.01/0.02 | 3.00           | 0.30     | **150 BB**       | 0                |
| 0.02/0.05 | 3.00           | 0.75     | **60 BB**        | 0                |
| 0.05/0.10 | 3.00           | 1.50     | **30 BB**        | 1,201            |

`25/50`, `50/100` and `0.10/0.25` dropped off the list because the engine
already charges what was proposed. **What the platform charges players is Dan's
call, not an agent's** — so this is a report, never an enforcement.

## Also in this commit

`20260831141737` and `20260831142001` are committed here for the first time,
reconstructed from `supabase_migrations.schema_migrations.statements` and
**verified byte-for-byte by md5 against production** (`f21deb8b…` / `bf90f959…`),
so the repository stops lying about what production runs.

## Verification

`20260831145500` asserts, against expectations transcribed from
`src/config/RakeConfig.ts` rather than read back from the tables it just wrote:

- all fourteen scheduled stakes resolve to their schedule cap;
- seven unscheduled stakes resolve through the tier cascade, `0.05/0.10 → 3.00`
  among them;
- eight big blinds spanning every former tier gap resolve to a non-null cap;
- `fn_rake_law_violations` over the cron window reports no `over_cap` or
  `over_percent`.

Confirmed live afterwards: `0.05/0.10 → 3.0`, `1/2 → 5.0`, `25/50 → 20.0`,
`bb 0.3 → 3.0` (was `NULL`), 14 `engine_mirror` rows, 6 `proposed`, 0 false
criticals ever logged, 0 new findings in the cron window.
