# The Game Management health strip counts what it can read in time (2026-10-07)

## What was wrong

`fn_get_game_management_scale_health` returned an exact `count(*)` of
`game_management_events` for the scope. The busiest union holds 4,212,266 rows
and its club 2,529,360. The count took 38,111 ms (parallel index-only scan),
so every load of those scopes hit statement_timeout: 47 of the 171 statement
timeouts in postgres_logs between 07:20 and 10:20 UTC, the largest single
source. The operator saw "Management health is not available for this scope."

Behind it, the 30-day retention never kept up: job
`game-management-events-retention` ran once a day and deleted at most 5,000
rows, against 200,000-600,000 inserted a day. The table held 6.7 million rows
back to 2026-09-02, about 1.6 million past the 30 days the strip advertises.

## The fix

Migration `20261007102247_the_game_management_health_counts_what_it_can_read_in_time`:

- the event count stops at 10,001 rows and returns `event_rows_capped`; the
  oldest event is read by `ORDER BY created_at LIMIT 1` on the scope index
  (7 ms). Authorization, owner, grants and every other key are unchanged.
- the retention job runs at :07 :17 :27 :37 :47 (never inside the :50-:03
  break window) with the function's full 10,000-row batch: 1.2 million rows a
  day. One batch took 145 ms in a rolled-back probe. The prune function and
  its append-only guard are unchanged. This is the retention schedule itself,
  not a repair (CLAUDE.md 10.12).

Client: the strip shows `10,000+ Realtime Events` when the read was capped, and
formats the number with `toLocaleString()`.

## Before / after (same queries)

| measure                                            | before              | after  |
| -------------------------------------------------- | ------------------- | ------ |
| union fade0000 event count read                    | 38,111 ms (timeout) | see PR |
| rows older than 30 days                            | ~1.6 million        | see PR |
| fn_get_game_management_scale_health timeouts / 3 h | 47                  | see PR |

Pinned by `tests/unit/gameManagementHealthIsBounded.test.ts`.

## Also: the BBJ threshold panel keyed a uuid column by a slug

`ClubSettingsPage` passes its route param to `BBJThresholdPanel`. When the page
is opened from a club link that param is a slug (`deep-stack-society-11192`),
and `.eq('club_id', slug)` on `bbj_notify_thresholds.club_id` (uuid) is 22P02:
69 refusals in six hours of postgres_logs (the `crest-cert-*` rows are
certification fixtures; `deep-stack-society-*` and `shark-club` are real club
links). The list never loaded and an add never saved. The panel now resolves
the uuid with `resolveClubUUID` and reads or writes nothing until it has one.
Pinned in `tests/unit/bbjThresholdPanel.test.ts`.
