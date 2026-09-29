# Multi-Day Tournaments: The Client, The Read And The Operator Doors

Assignment CA-PRODUCT-COMPLETION-2026-09-22, client and operator-door lane.
Design: `docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md`
sections 3, 7, 8 and 11 (section 11 listed the client read RPC and the
operator doors as not built; this is them). Builds on the capability registry
(`20260924025555`) and the multi-day database foundation
(`20260924043217`, `043224`, `043232`, `043239`).

## Database: `20260924063656_multi_day_stage_view_and_operator_doors.sql`

One transaction, `SET LOCAL lock_timeout`, no table, trigger or column.

- `fn_tournament_stage_view(tournament)` (the design's
  `ca_tournament_stage_view`). Authenticated, live session, and only for an
  event the caller could read through the tournaments SELECT policy (a
  platform event or `fn_poker_can_read_games`); anything else answers
  `tournament_not_found`. Returns the day schedule (every stage, its state,
  end level, UTC start with a `Z`), the plan's IANA zone, the current stage,
  the next start, the bagged player count, and for the caller only their own
  bag (stack, bounty head) and, once the next day runs, their own live chair.
  About other players it returns only the post-bag chip leaders, top 10, by
  display name and stack: no user id, horse flag, club or seat. There is no
  horse branch (CLAUDE.md 10.5). It does not gate on the capability, so a
  withdrawn capability strands nobody's bag.
- `fn_operator_seal_stage_plan` and `fn_operator_reschedule_stage`.
  Authenticated subject and `fn_caller_session_is_live()` (refusals raise
  28000 exactly like every other browser door), then
  `fn_capability_available('tournament.multi_day.single_flight')`, then
  `fn_can_create_games(<event club>, auth.uid())` (the authority
  `fn_create_tournament` uses), then delegation to the service-role RPC of
  `20260924043239`, whose validation, locking, receipts and idempotent replay
  are the only copy of each rule.
- Grants: `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`,
  `GRANT EXECUTE TO authenticated`, asserted in the migration; the service-role
  RPCs are asserted still closed to browsers. The definer checks pass without
  an allowlist entry: every function consults `auth.uid()` and none is
  anon-executable.
- Manifest fragment `scripts/ci/schema-manifest.d/multi-day-stage-view.json`
  (a promise until installed).
- Harness `scripts/ci/test-multi-day-stage-view.py` (11 cases on real
  PostgreSQL; it imports the foundation harness's fixture rather than
  re-typing it): grants, no subject and revoked session, capability gate,
  club authority, unreadable events, delegation of every validation reason,
  idempotent seal and reschedule replay, own-bag-only visibility for six
  players including a horse, the top-10 cap, and the Day 2 chair after a real
  resume. CI step beside the foundation step; `ci.yml` repinned in
  `scripts/qualification/cash-native-hosted.manifest.json`
  (`multiDayStageViewIntegration`).

## Client

- `src/config/platformCapabilities.ts` (the registry's client mirror),
  `src/hooks/usePlatformCapability.ts` (one shared registry read per minute,
  failed reads never kept; four outcomes: loading, available, unavailable,
  unknown; `null` asks nothing) and `tests/one-capability-registry.law.test.ts`
  ship with their first consumer, byte-identical to the Kill Pots client
  candidate; the registry PR is database and docs only. This tree does not
  carry the registry migration, so the law compares the mirror to
  `scripts/ci/fixtures/capability-registry/seeds.json`, the registry PR's
  pinned JSON copy of its seeds. Every multi-day surface shows only on
  `available`; `MULTI_DAY_CAPABILITY` lives in `src/utils/multiDaySchedule.ts`,
  not in the shared hook.
- `src/services/TournamentStageService.ts`, `src/hooks/useTournamentStageView.ts`:
  the view read (strictly parsed; malformed is unknown, not "no plan") and the
  two doors with operator-facing refusal messages.
- `src/utils/multiDaySchedule.ts`: `isBaggedStatus`, "Day 1 Complete", "Day 2
  Starts Sat 12:00 PM CDT" printed in the plan's zone (the date is added when
  the start is more than six days away), wall-time to UTC conversion across
  DST with Intl only, and `buildStagePlan`, which refuses before creation what
  the seal would refuse after it.
- Create form (`TableConfigPage`): the Multi-Day MTT switch replaces "NOT
  AVAILABLE YET" only when the capability is available, with a Day Schedule
  editor (Day, Ends After Level, Starts At, one Time Zone). The plan is
  validated before the tournament is created and sealed through
  `fn_operator_seal_stage_plan` right after. It never writes `is_multi_day` or
  `total_days` (still refused by the database guard until R6). A weekly
  schedule and a multi-day plan cannot be combined.
- Tournament lobby: BAGGED rows stay listed; the card pill says Day Complete;
  with the capability and a plan it adds "Day 1 Complete / Day 2 Starts ...".
- Tournament Overview: `MultiDayStagePanel` (Stage Schedule, Your Bag, Chip
  Leaders while bagged, Your Day 2 Seat with an Open Table button). It
  navigates only from that button. The details page's start-of-event auto-open
  now stands down on any later day (seen BAGGED on this page, or the stage view
  says the current day is past Day 1).
- Table management: Reschedule Day 2, only while the next day is `scheduled`,
  entered in the plan's zone, with the view's schedule generation so a second
  operator's move is refused rather than overwritten.

## BAGGED reader decisions (R2)

BAGGED is live, closed to entry, not dealing, never finished or cancelled.

| Reader                                                                                                                                                                                              | Decision                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/types/database.types.ts` `TournamentStatus`                                                                                                                                                    | add `'BAGGED'`                                                                                      |
| `src/types/club.types.ts` `TournamentStatus`                                                                                                                                                        | add `'bagged'`                                                                                      |
| `lobbyEntries.tournamentStatus`                                                                                                                                                                     | new branch before the format check: key `running`, label Day Complete (was the Registering default) |
| `lobbyEntries.tournamentEntry` `live`                                                                                                                                                               | false for BAGGED (no live pip)                                                                      |
| `tournamentPresentation.isTournamentEntryUnavailable`                                                                                                                                               | true (was false for unlimited MTTs: Register would have shown)                                      |
| `ClubHomePage` fetch/realtime list, `isListable`, sort rank                                                                                                                                         | listed, sorted with events under way; `stillEnterable` stays false                                  |
| `TournamentLobbyPage` queries, broadcast list, sort, card status                                                                                                                                    | listed after RUNNING, card `bagged`, stage note when gated                                          |
| `TournamentLobbyCard`                                                                                                                                                                               | `bagged` status: Day Complete pill (gold), Open Tournament / View Schedule, no Register or Watch    |
| `TournamentService.getTournaments` (club and union halves)                                                                                                                                          | listed                                                                                              |
| `TournamentPage.statePill`                                                                                                                                                                          | Day Complete (the fallback plate prints it disabled)                                                |
| `SearchPage.tournamentStatusLabel`, action label                                                                                                                                                    | Day Complete; View Schedule instead of Register                                                     |
| `useSatellites` live list and card mapping                                                                                                                                                          | live; `bagged`, not the `finished` default                                                          |
| `TournamentDetails` footer                                                                                                                                                                          | Day Complete badge before any Register or Unregister branch                                         |
| `TournamentDetails` auto-open                                                                                                                                                                       | stands down on later days (see above)                                                               |
| `DetailOverviewTab` hero                                                                                                                                                                            | Day Complete, no clock, no one-second tick                                                          |
| `BlindsTab`                                                                                                                                                                                         | clock stopped, Day Complete caption and badge, no break or urgent state                             |
| `TournamentHUD`                                                                                                                                                                                     | not terminal; no deadline armed                                                                     |
| `Badge.TournamentStatusBadge`                                                                                                                                                                       | `bagged`: Day Complete                                                                              |
| `GameManagementPage`                                                                                                                                                                                | card status `paused`, label Day Complete, Reschedule control                                        |
| `tournamentFilters.isRunning`, `advancedFilterSpec` running                                                                                                                                         | unchanged: the Running chip means dealing; BAGGED shows under All                                   |
| Every `=== 'RUNNING'` gate (TablePage add-on window, TournamentTimerService, rebuy and add-on checks, entry window, overlay announcements, starting ticker, RewardsTab, TablesTab, EntriesTab poll) | unchanged: false for BAGGED is correct (nothing deals, nothing is sold)                             |
| Terminal lists (`COMPLETED`/`CANCELLED`/`FINISHED`) in TablePage, TournamentDetails refresh, results pages                                                                                          | unchanged: BAGGED is correctly not in them                                                          |

## Not done here

- `server/` (the engine lane) and the unbuilt-multi-day guard (R6).
- The table page's Day Complete sheet after the final accepted hand (design
  section 7, `table/:tableId`): the table closes at the bag and the Overview
  carries the bag; a sheet on the felt is left for the engine lane's bag event.
- The app-wide `TournamentAutoSeat` watcher (Dan 2026-08-21, binding) will
  still open a table tab when the Day 2 chair appears, exactly as at the first
  start. Whether a later day should be exempt is an owner question.
- The `multi-day-horses-identical` law belongs to the engine lane; on the
  client there is no horse branch to pin, and the harness proves the read
  treats a horse's bag and name exactly like a human's.
