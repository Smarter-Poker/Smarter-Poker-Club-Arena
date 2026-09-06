# A schema-reload storm had no reader

**2026-09-06** — branch `fix/a-schema-reload-storm-had-no-reader`

The last open item from today's Realtime work, and the only one I had left as
"documented, not fixed". It is fixed now.

## What happened, and why nobody could see it

Between 16:04 and 16:08 UTC the platform nearly stopped dealing:

| minute (UTC) | hands                                             |
| ------------ | ------------------------------------------------- |
| 15:24–15:52  | 420–500 per minute, steady all day                |
| 16:00–16:02  | 279, 476, 444 — normal after the maintenance thaw |
| 16:05        | 119                                               |
| 16:07        | 17                                                |
| 16:08        | **6**                                             |

The engine was alive, leader, and dealing. The database was idle, with no lock
waits and no long transactions. The engine log held one line 970 times:

```
deal_step_timeout: load_seats exceeded 20s
```

plus `refresh_rake` timing out, the tournament context refresh timing out, and
elimination sweeps overrunning 65 seconds. Nothing was broken.

`ca_ddl_events` had the answer: **249 DDL statements in the single minute 16:14,
133 of them reload-triggering**, applied through Supavisor as one long script —
a video/YouTube schema change (`social_posts` columns,
`complete_rights_cleared_youtube_transcode`, `video_library_public_catalog`).

CLAUDE.md section 2 measured one PostgREST schema-cache reload on this database
at **~28 seconds**, and that is exactly why its rule 1 says a change goes in as
ONE transaction: Postgres coalesces the reload NOTIFYs inside a transaction and
does not across many.

**The rule was already written. Nothing measured it.** So nobody knew it was
being broken, and the agent running the script had no way to see that it was
stopping every table on the felt. That is 10.86 rule 3 — a guard must have a
reader — one level up: a _rule_ with no reader either.

## Counting the obvious thing would have been wrong

The first instinct is to alarm on DDL statements per minute. Measured over
seven days, that would have paged on the wrong events:

| minute      | app       | statements | distinct query texts | what it was                              |
| ----------- | --------- | ---------- | -------------------- | ---------------------------------------- |
| 08-31 20:27 | mgmt-api  | **147**    | **3**                | one migration, one transaction, harmless |
| 09-06 16:14 | Supavisor | 133        | **121**              | the incident                             |
| 09-06 12:32 | Supavisor | 72         | 1                    | one statement, harmless                  |
| 09-06 11:48 | Supavisor | 49         | 27                   | a hand-run RLS sweep                     |

The largest minute in the week by statement count was a **correctly written**
migration. Statement count would have shouted at it and shrugged at the one
that hurt.

So the check counts **distinct reload-triggering statement texts per minute**.
A migration applied through the migration API carries its whole body as one
query text however many DDL statements are inside it; a hand-run script gives
each statement its own. Distinct texts ≈ distinct transactions ≈ actual reloads.

## The threshold, derived rather than guessed

Distinct reload-triggering statements per minute, across the 938 minutes in
seven days that contained any:

```
avg 2.65   p50 2   p90 4   p99 25   max 121
>=10: 34 minutes   >=15: 16   >=20: 13   >=30: 5
```

**30.** Above p99, five minutes in seven days (~0.7/day), and every one of those
five is the same shape — a long `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
sweep or schema change run straight through the pooler or psql. Not one is a
scheduled job, so this can never fire on the ordinary rhythm of the platform.
10.84: derive a threshold, do not guess one, and write the measurement beside
it. An alarm that is always on is an alarm that gets muted.

Minutes in the 15–29 band are printed as context and do not fail. The trend is
worth seeing; only the storm is worth stopping for.

## The window is two hours, not twenty-four

The watchdog runs every 15 minutes, so a 2-hour window is seen by eight
consecutive runs — a storm cannot slip between them — and **the alarm clears
two hours after the event** instead of re-reporting the same past minute for a
day. An alarm that does not resolve teaches everybody to ignore it long before
the next real one. `--hours=24` is there for the wider look by hand.

## Three outcomes, because two would lie

```
0   no storm in the window
1   at least one minute at or over the threshold
2   COULD NOT TELL - no credentials, an unreadable response, or a row cap
    that means the window was read only in part
```

`res.ok` is checked before the body is parsed, every time, and a paginated read
that hits its page cap exits 2 rather than reporting the part it managed to
read as clean. That specific coercion — `undefined || []` arriving as good news
— is the one this estate keeps re-deriving (10.86 rules 1 and 2). All three
outcomes were exercised against the live database before this shipped: exit 0
on the current quiet window, exit 1 on a window containing 16:14, exit 2 with
no key.

## Its reader

The `ddl_reload_storms` job in `publish-watchdog.yml`, every 15 minutes, on
`ubuntu-latest` — the alarm must not share a failure domain with the boxes it
watches. A red run there is picked up by `check-main-is-green.mjs` in the same
workflow, which raises one issue for any workflow red on `main` with nobody
watching.

It **reports and never gates.** It cannot gate: the statements it is about do
not go through a pull request at all, which is precisely why no repo-side check
could ever have caught this one. A CI gate over `supabase/migrations/**` would
have been the comfortable thing to build and would have seen nothing.

## One bug found in it before it shipped

The module called `main()` unconditionally at the bottom, so importing it for
the test ran the check, found no key, and called `process.exit(2)` inside the
vitest worker. The suite still reported **15 passed** — with "1 error" beside
it, which is the shape of a failure nobody reads. It now runs only when it is
run, guarded on `import.meta.url === pathToFileURL(process.argv[1]).href` like
every other checker in that directory.

## What is still NOT fixed by this, said plainly

This is a detector, and 10.11 says a detector is not a fix. The root fix — a
schema change going in as one transaction — is a rule that already exists in
writing and belongs to whoever applies the next one. What was missing was any
way to know the rule was being broken, and by whom, while it was happening.
That gap is closed. If this alarm fires more than occasionally, the rule needs
enforcement rather than observation, and the changelog for that will say so.

## Files

- `scripts/ci/check-ddl-reload-storms.mjs` (new)
- `tests/ddl-reload-storm-detector.test.ts` (new, 15 cases)
- `.github/workflows/publish-watchdog.yml` — the `ddl_reload_storms` job
