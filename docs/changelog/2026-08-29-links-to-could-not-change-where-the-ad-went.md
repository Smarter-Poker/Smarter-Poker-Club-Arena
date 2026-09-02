# "Links To" could not change where the ad went

2026-08-29, Cowork session `cowork-ads3`. Panel half. The API half is a World
Hub PR of the same name.

## The bug

`fn_resolve_ads` serves `COALESCE(pl.target_url, c.target_url)`. The placement's
own destination wins when it is set — and **eight of the eighteen live
placements set it**: every `hub_promotions` row and both `session_summary` rows.

| campaign            | the ad's Links To         | what hub_promotions actually serves |
| ------------------- | ------------------------- | ----------------------------------- |
| `vip_upsell`        | `/vip`                    | `/hub/vip-membership`               |
| `diamonds_store`    | `/cashier`                | `/hub/diamond-store`                |
| `tournaments_daily` | `/tournaments`            | `/hub/daily-tournaments`            |
| `bbj_running`       | `/clubs/{clubId}/jackpot` | `/hub/club-arena/`                  |

The admin panel's GET never selected that column, and neither placement verb
wrote it. So the only destination control the panel offered was the campaign's,
and editing it on any of those eight reported "Saved." and changed nothing on
the surface actually serving. The panel and the database disagreed, and the
panel was the confident one.

That is the same shape as the unknown-slot bug fixed on 2026-08-28 — a control
that answers "Saved" for a write that did not land where the operator was
looking. It is the shape this whole system keeps paying for.

## What changed here

`PlacementRow` carries `target_url`. The placement table has a **Links To**
column, and a blank one reads "Inherited From The Ad" rather than being empty — blank is
a value here, not missing data. The draft form gained **Links To On This
Surface**, placeholdered "Inherited From The Ad", loaded from the row when editing.

`savePlacement` sends the field **always, including as an empty string**. The
server keys on `!== undefined`, so omitting it means "leave it alone" and an
empty string means "clear the override and fall back to the ad's own". An
operator who empties the box means the second one, and the two must stay
distinguishable on the wire.

The actions column header was an empty `<th />` — a column a screen reader
announces as nothing. It is `aria-label="Actions"` now.

Validation is the API's: both placement verbs run the value through
`readSitePath` and refuse with `Not A Site Path: <value>`, the same rule the
campaign's own destination got earlier today.

## Verification

- `npx vitest run tests/unit/houseAds.test.ts` — **97 passed** (92 before, 5 new).
- `npx tsc --noEmit` — exit 0.
- The eight overrides above were read from production, not inferred:
  `select c.ad_key, c.target_url, p.slot, p.target_url from ad_placement p join
ad_catalog c on c.id = p.ad_id`.

## A trap, recorded because it nearly cost this commit

After a husky/lint-staged commit in this repo, the **working tree can silently
still hold the pre-commit content** while `git log` shows the commit landed.
Cutting a new branch from that worktree then stages a full revert of the commit
you just made, and `git status` is where it shows up — not in
`git diff origin/main..HEAD`, which compares commits and looks perfectly fine.

It happened here between the two changes: the second branch came up with 205
deletions staged, reverting the first. Nothing was pushed. The check that caught
it was noticing the test count had gone _down_ (90, when the merged file has 92).

**`git diff HEAD --stat` immediately after cutting a branch**, and treat any file
you did not just touch as a stop. `git reset && git checkout -- .` restores the
worktree to HEAD without moving a ref, so no guard hook objects and nothing is
lost.
