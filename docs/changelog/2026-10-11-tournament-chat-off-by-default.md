# Tournament chat is off by default (2026-10-11)

## The ruling

Dan, 2026-10-11 22:02 CDT: "Off by default for all tournaments. Spins and Sit N Gos can have chat on." Existing schedules and tournaments that have not started switch too.

Every tournament that is not a Spin and not a Sit N Go (heads-up included) starts with table chat banned: MTTs, satellites, freerolls, bounty, progressive bounty and mystery bounty events. It is a default: a caller that explicitly sends `banChat: false` is honoured by the database.

## What production showed (read-only, 2026-10-12 04:00-04:10 UTC)

- 1,927 MTT-family events created in the last 14 days (838 `SATELLITE`, 1,089 `MTT`), 0 with chat banned.
- 1,428 of them had no schedule. The engine's recurring creator (`TournamentRecurringService`) inserts tournaments without a `ban_chat` column, so the column default (`false`) decided.
- The schedule spawner writes `ban_chat: asBool(cfg.banChat)`; none of the 338 `tournament_schedules` rows carried `banChat` (337 MTT-family, 1 Spin).
- `fn_create_tournament_governed_legacy` wrote `COALESCE((p_config->>'banChat')::boolean, false)`.
- 104 MTT-family events were ANNOUNCED or REGISTERING with chat on (51 chip MTT, 41 Diamond MTT, 12 Diamond SATELLITE; 103 with registrants). 12 RUNNING ones are left alone.
- The Create Tournament modal sent `banChat: true` for every format, Spins and Sit N Gos included, so a Spin or Sit N Go created there could never chat.

## Change #1: database default (migration `20261012040851_tournament_chat_is_off_by_default.sql`)

**What existed:** `tournaments.ban_chat boolean NOT NULL DEFAULT false`; the creator line above; schedule configs without `banChat`.

**What changed (one transaction, no engine release):**

1. `tournaments.ban_chat` loses its column default. The BEFORE INSERT trigger `a00_tournaments_chat_default` fills a value the INSERT did not supply: `true` unless `tournament_type` is `SPIN` or `SNG`. NOT NULL is checked after BEFORE triggers, so an explicit `true` or `false` is never touched. It fires first, before `a1_tournaments_restart_source` compares a restart clone with its source. Declared in `ca_declared_money_triggers`.
2. `fn_create_tournament_governed_legacy` now writes `COALESCE((p_config->>'banChat')::boolean, v_type NOT IN ('sng', 'spin'))`. One counted substitution over production's live text (definition md5 `bf284ab7932447a7d2e49a1fa7deb9d8` before, `3d40ead690de9769287475c206341668` after); owner, SECURITY DEFINER, search_path and grants unchanged.
3. `tournament_schedules` gets `a00_tournament_schedules_chat_default` (BEFORE INSERT OR UPDATE OF config): an MTT-family config whose `banChat` is absent or null is given `banChat: true`. Spin and Sit N Go labels (`spin`, `sng`, `hu_sng`, `heads_up`) are left alone unless the config names a satellite target, which the spawner turns into an MTT satellite. `fn_ca_schedule_config_keeps_chat(jsonb)` is that rule.
4. Existing schedules: every MTT-family config without `banChat` gets `banChat: true` (337 measured; retired clubs excluded, none measured).
5. Existing tournaments: every ANNOUNCED or REGISTERING MTT-family event with chat on gets `ban_chat = true` (104 measured). The UPDATE runs as the service role for those statements only (precedent `20261002014954`), because `fn_guard_managed_game_lifecycle` locks a registered event's terms for every other caller. Every other column is compared row by row before and after, and the migration refuses if anything else moved. No money, seat or status column is written.

The tournaments lock is taken first, in bounded 1.5 second attempts (pattern from `20261001204429`), so no engine write waits more than one attempt behind it. Re-running the file is safe: the creator step skips when the postimage is already live, and the data steps only touch rows still missing the flag. If the hourly break window (:50-:03 UTC) refuses it, run it once after :03.

**Not changed:** the engine, `fn_create_tournament` (the wrapper), the chat readers (`fn_table_chat_is_silenced`, `useTableChat`). A restart-every clone copies its completed source's `ban_chat`, because `a1_tournaments_restart_source` requires an exact copy; none of the not-yet-started events restarts.

**@live-proof (true only after install):** the creator md5 is `3d40ead6...`; `ban_chat` has no default and stays NOT NULL; both `a00_` triggers exist and are enabled; no MTT-family schedule outside a retired club lacks `banChat`.

**Verified:** `scripts/ci/test-tournament-chat-default-db-postgres.py` on PostgreSQL 17 rebuilds production's creator from main's migrations byte for byte, shows 17 of 39 owner cases failing on production's behaviour and 39 of 39 passing after, and shows that a drifted creator, an UPDATE that would move another column, a rolled-back run and a browser role each install nothing, and that a re-run changes nothing.

## Change #2: the Create Tournament modal

**File:** `src/components/club/CreateTournamentModal.tsx`

**What existed:** `const [banChat] = useState(true);` sent for every format, with the "Chat: Off" locked rule always shown.

**What changed:** MTT-family formats still send `banChat: true` with the locked rule (owner requirement 2026-09-20). A Spin or Sit N Go starts with chat on and shows a Ban Chat switch in Advanced Options; the host's choice is what is sent. `tournamentFromTableConfig` already behaved this way and is unchanged.

**Verified:** `tests/components/createTournamentModalAxesAndRecurrence.test.tsx` covers both formats (chat on by default, switch respected) next to the existing MTT lock test.
