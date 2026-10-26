# Find A Player lists only real players

**Reported (Dan, 2026-10-25):** "YOU NEED TO REMOVE ALL OF THE DELETED AND TEST
ACCOUNT COMPLETLY. THE ONE USER WITH "333" ISN'T DISPLAYING WITH ALL THIS OTHER
BULL SHIT APPEARING". Searching 333 listed the real player 333, four
DELETED-xxxx accounts and a `crest_cert_` test fixture.

## What was wrong (read from production, 2026-10-26)

`fn_search_players` searched every row of `public.profiles`. Of 2,740 non-horse
profiles only 106 are real, live people:

- 1,262 deleted accounts (`profiles.status = 'deleted'`, named DELETED-xxxx);
- 1,222 post-deploy verification identities whose sign-in was deleted while the
  profile still read `active`;
- live test identities on example.invalid, example.com and hydra.bot
  (PostDeploy, `crest_cert_`, LobbyCert, testuser, 120 hydra.bot seed names), and
  four internal QA/system sign-ins on smarter.poker.

## Root fix

`20261026011835_player_search_lists_only_real_players.sql` joins `auth.users`
into the matched set and lists a profile only when it is not deleted, its
sign-in is neither deleted nor banned, and, unless it is a horse,
`public.is_system_user(email)` says it is a real person. Horses are never
filtered by the test-identity rule (CLAUDE.md 10.5). Production preview before
applying: 106 real players and 938 live horses stay searchable, and "333"
returns exactly the real player 333.

Nothing was deleted from the database. The accounts stay as records (ledger and
hand history reference them); they simply never appear in player search.

## Screen fix

- The "No Matching Players Were Found" line now only answers the words in the
  field. Before, an empty answer to the earlier pasted text stayed on screen
  under the new "333" suggestions.
- Running a search cancels a suggestion lookup still waiting on its debounce,
  so the dropdown no longer reopens over the results.

## Tests

- `scripts/ci/test-player-search-privacy-postgres.py`: private PostgreSQL case
  proving a real player and a horse are listed while deleted, sign-in deleted,
  banned, certification, QA and deleted-horse accounts are not.
- `tests/unit/playerSearchFinalMigrationOrder.test.ts`: the final definition
  keeps the real-player filter.
- `tests/components/FindPlayerLocator.test.tsx`: the two screen fixes.
