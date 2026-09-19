# tests/no-band-aids.law.test.ts

Dan, 2026-09-07: "I DO NOT WANT CRONS AND 'BACK PAY JOBS' ... I WANT HARD CODED
FIXES AT THE ROOT SOURCE WHEN AN ISSUE IS DISCOVERED! NOT A FUCKING BAND AID!"
10.11 had already said a detector is not a fix, in writing, and the day after
the platform still paid 558 payouts and 48,146.94 chips in seven days through
repair machinery instead of through the engine - median six hours late, worst
84 days - with 29 of 127 active cron jobs repair-shaped. This pins CLAUDE.md
10.12: a migration may not declare a repair, back-pay, re-drive, catch-up,
backfill or heal path, nor schedule a cron that runs one. Deleting one is
always allowed. The allowlist is EXISTING debt only, every entry carries the
row in docs/BAND-AIDS-REGISTER.md that says what root fix lets it be deleted,
and it may only ever get shorter.

## A new schedule must say why it exists (added 2026-09-19)

Every rule in this gate was keyed on the **name**: `repair`, `backpay`,
`catchup`. So a schedule whose name carries none of those words walked past all
of them.

That is not hypothetical. On 2026-09-19,
`20260919152626_schedule_daily_diamond_spin_settlement` created the cron job
`diamond-spin-daily-settlement` and this gate said nothing. The name was never
what 10.12 is about. The schedule is.

A migration from version **20260920** on that calls `cron.schedule` must carry a
line of its own saying why the schedule is the product rather than a way to
catch up with a defect:

    -- periodic-work: <why this is not compensation>

A reason a reviewer can disagree with. "Runs daily" is not one. "The owner asked
for one settlement at local midnight, and nothing it does repairs, retries or
back-pays anything" is.

This is deliberately **not** an allowlist entry. `band-aid.allowlist.json` is
existing debt that may only ever get shorter, and a legitimate end-of-day
settlement is not debt — it is a decision, and it gets written down as one.

**The cutoff is measured, not guessed.** 101 migrations on disk call
`cron.schedule` in code and none carries the marker, so the rule cannot be
retrospective without making `--all` useless overnight. The newest migration
that schedules anything is `20260919152626`, and nothing at or after `20260920`
exists, so the cutoff is provably clean today and everything written from here
on is covered.

**The two halves read different copies on purpose.** The call is detected in
`stripNoise`'d source, because several migrations mention `cron.schedule` in
prose alone and refusing them for explaining themselves is the CLAUDE.md 7.3
trap. The justification is read from the raw text, because the marker _is_ a SQL
comment and `stripNoise` would erase it.

**Incidental fix in the same change:** `scheduledJobs()` computed
`stripNoise(sql)` into a `clean` variable and never used it — both reads below
it deliberately use the original text, so the job name survives inside the
stripped literal. The dead line is removed and a test now pins that decision
either way.
