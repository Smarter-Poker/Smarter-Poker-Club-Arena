# A placement could be created and never managed

**2026-08-28.** `POST /api/club-arena/house-ads` inserted the advert plus
exactly **one** placement. `PATCH` touched `ad_catalog` only and never went
near `ad_placement`. So from the panel an operator could create a campaign on
one surface, edit its copy, pause it and delete it — and could not:

- put an existing campaign on a second surface
- change a slot, an audience or a daily cap
- pause it on the lobby while leaving it live on the Hub

Every one of the eighteen multi-slot placements running in production was
written by an agent, in a migration. The ordinary operational actions were all
schema changes.

The irony is worth stating: earlier the same day this system gained
per-placement reporting, suppression counts and a per-placement trend. That is
a great deal of reporting on a dimension the editor could not manage.

---

## What shipped

**API** — `?kind=placement` on POST, PATCH and DELETE, beside the existing
catalog verbs rather than in a second file. The authorization, the rate limit
and the service-role client are the same; a second route would be a second
place for them to drift.

**Panel** — a Placements row per campaign: the surfaces it runs on with their
audience, cap and state, and controls to add, edit, pause and remove each one.

Every branch says what actually happened:

- a duplicate on one surface returns "already has a placement on that slot",
  not a 500
- a club that does not exist returns "that club does not exist"
- a placement deleted in another tab returns "no longer exists", because the
  update asks which row it touched rather than trusting PostgREST's `{ error:
null }` on a zero-row match
- removing the **last** placement says so: _"Placement Removed. That Ad Now
  Runs Nowhere."_ An advert with no placement looks perfectly healthy in the
  list and is the commonest way to publish something and see nothing happen

## The bug this uncovered, before it could bite

`ad_placement_ad_id_slot_club_id_key` has been `UNIQUE (ad_id, slot, club_id)`
since Phase 1. **Postgres treats NULLs as distinct**, and `club_id` is NULL on
every placement in production because NULL is how "every club" is spelled.

So the key had never once fired on a real row. Found by **probing** it in a
rolled-back transaction rather than reading its definition — reading it is how
it passed review in the first place. The second insert of the same campaign on
the same surface succeeded.

It did not matter while the only writer was a hand-written migration under
review. It mattered the instant the panel could add placements: two clicks of
Add Placement on one surface would have rendered the advert twice from one
JOIN, given it two independent caps, and returned a cheerful success from an
API branch that could never fire.

Replaced with `UNIQUE NULLS NOT DISTINCT`, which says what was meant: a NULL
club is a **value** — every club — not a wildcard matching nothing. The
migration proves it by inserting the duplicate and expecting the violation.

`ad_placement.club_id` is also a real foreign key now. It has been honoured by
the resolver since Phase 1 and used by nothing, which is precisely the state in
which a typo goes unnoticed — and the panel can write it now.

## Three smaller gaps, closed in the same pass

**Images.** `ad_catalog.image_url`, rendered by the card surfaces and the Hub
rail, falling back to the glyph when the file is missing — a broken-image icon
in a promotion is worse than no promotion. Same-origin paths only, enforced in
three places: a CHECK in the database, a refusal in the API, and a guard where
it renders. An external host would hand every player's IP and user agent to a
third party chosen by whoever typed the URL into the panel. The migration
**probes** the constraint with an external URL and expects the rejection.

**Experiments.** `experiment_key`. Two campaigns sharing one are variants of a
single test; the weighted draw has split traffic correctly since it landed, but
the panel reported them as unrelated so nobody could read the result.

**Retention.** `ad_event_retention_policy` (one row, 180 days) and
`fn_prune_ad_events()`, which reads its window from that row and refuses to run
if the row is absent — no policy is not permission to delete everything.

**It is deliberately not scheduled.** `CLAUDE.md` §11 makes Open Claw the only
sanctioned scheduler and a new cron a governed change, and §11.3 fails CI on a
net-new file in `pages/api/cron/`. Wiring this to a schedule needs a paper
trail, not a side effect of a migration. At 200 rows a day, a function somebody
runs deliberately is the correct amount of automation.

## And a drift check that caught two files

Every migration was applied through the Supabase MCP and committed as a file.
Comparing the two by md5 found that **the file is not always what ran**:

- `impressions_are_not_people` — the applied version began with
  `drop function if exists public.fn_ad_stats();`, needed because the change
  adds columns to a `RETURNS TABLE` and Postgres refuses that in a
  `CREATE OR REPLACE`. The committed file lacked it and **would have failed on
  replay**.
- `a_campaign_decays_and_nothing_shows_it` — the file carried a dead
  `for ... loop end loop;` block the applied version did not.

Both corrected. This is the same species as the orphan migration found at the
start of the day, one step subtler: the file existed, and was wrong.

## Verification

```
npx tsc --noEmit                                  clean
npx vitest run                                    504 files, 0 failures
node --test house-ads-hub-promotions.test.mjs     19 passed
placement lifecycle probed against production     add, edit, pause, duplicate-refused,
                                                  bad-club-refused, club-scoped, delete
                                                  (all rolled back)
```
