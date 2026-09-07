# A guard with no reader is not a guard (2026-09-06)

Found during the verification pass over the day's own work, by asking of each
thing shipped: is it wired to something that runs it?

## Three checks were running nowhere

`scripts/ci/` holds 70 scripts. Three matched only themselves in a grep of
`.github`, `.husky`, `package.json` and `scripts/`:

| script                                     | what it guards                                                      |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `check-realtime-publication.mjs`           | a `postgres_changes` subscription that can never fire               |
| `check-bbj-functions-match-production.mjs` | the BBJ **money path** in the repo against the one production runs  |
| `check-cosmetic-catalog-drift.mjs`         | the **price list** in the code against the trigger that enforces it |

Two of them guard money. The first was merged hours earlier **in this same
session, by me, with CLAUDE.md 10.86 rule 3 quoted in its own header** - "a
guard must have a reader, and you must name them". That is how easy this is to
do while looking straight at the rule.

## And one of them was crying wolf

`check-cosmetic-catalog-drift` exits 1 today, reporting eighteen lines of drift
in the theme catalog: nine ids "in code, MISSING from cosmetic_catalog" and
nine "in cosmetic_catalog, MISSING from code".

**All eighteen were false.** The scanner's regex was

```js
/id: '([^']+)'[\s\S]{0,260}?tier: '(free|vip)'/g;
```

with no boundary before `id:`. Every entry in `THEME_PRESET_CATALOG` also
carries `table_id`, `button_id`, `background_id` and `cards_id`, and
`table_id: 'classic_green'` _contains the substring_ `id: 'classic_green'`. So
the scanner read felt asset names (`classic_green`, `carbon_red`,
`ice_cavern`) as theme ids and compared them against a catalog of theme ids
(`default-dark`, `classic-brown`, `neon-blue`). The two lists could never
match, and the real ids in the code match the database exactly.

A lookbehind fixes it and the check now exits 0. Verified against production:
the picker and the trigger agree, and the two rows in `user_theme_settings`
both hold valid catalog ids.

Had the check been wired as it was, the watchdog's first run would have filed
an issue about a catalog that is fine - and CLAUDE.md 10.84's warning applies
directly: an alarm that is always on is an alarm that gets muted.

## What changed

- The regex is anchored, and the reason is written beside it.
- All three run in a new `live_drift` job in `publish-watchdog.yml`, twice an
  hour, on `ubuntu-latest` rather than the estate's own runners - an alarm must
  not share a failure domain with what it watches, the same reason
  `main_is_green` uses it. They ask the live database, which is why they are
  here and not in `ci.yml`: a pull-request check has no business depending on
  production being reachable.
- No step fails the job. Each records its exit code and one alarm step files a
  single issue naming whichever drifted, with the tail of each log. **Exit 2
  ("could not ask") alarms as loudly as exit 1**, because a check that cannot
  reach production must never read as a check that found nothing (10.86 rule 1).
- `tests/every-guard-has-a-reader.law.test.ts` requires every
  `scripts/ci/check-*.mjs` to be referenced by something that runs it, or to be
  named in `MANUAL_TOOLS` with the reason a person runs it by hand. Three are
  on that list today (`apply-main-ruleset`, `backfill-unrecorded-migrations`,
  `triage-open-prs`) and each carries its reason.

## The shape worth remembering

A check that nobody runs does not sit still. It decays with the code around it,
and the person who finally wires it inherits a backlog of failures - most of
them false, like these eighteen - which teaches the whole team that the check
is noise. The cost of an unwired guard is not the missed detection; it is that
wiring it later is unpleasant enough that nobody does.
