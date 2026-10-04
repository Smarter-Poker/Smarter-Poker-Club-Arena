# 2026-10-04 - page preferences count the row they wrote; the dead arena freeze scope is retired

Migration `supabase/migrations/20261004231057_page_preferences_count_the_row_they_wrote_and_the_dead_arena.sql`.
It must be applied AFTER `20261004214251_the_legacy_diamond_arena_database_objects_are_dropped.sql`;
its preimage check refuses otherwise. Merged is not applied: the lead applies it.

## 1. `update_page_preferences` never saved anything

Read from production (md5 `d98e1becf64a5c606d310b26b0a1e49c`):

```sql
  EXECUTE format(
    'UPDATE profiles SET %I = $1, updated_at = now() WHERE id = $2 RETURNING %I',
    p_column_name, p_column_name
  ) INTO v_preferences USING p_preferences, p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
```

PL/pgSQL: "EXECUTE changes the output of GET DIAGNOSTICS, but does not change
FOUND." FOUND is false at the start of every call and nothing before this line
sets it, so the test was true every time. The function raised `Profile not
found` for the profile it had just updated, and the exception rolled the update
back. This is the cause, named at its line; there was nothing to "retry".

Evidence beside the code reading:

- Local PostgreSQL 16 with the live text loaded (same md5): an existing profile
  answers `ERROR: Profile not found`.
- Production: 0 profiles hold a non-empty `bankroll_preferences`,
  `news_preferences`, `memory_games_preferences` or `video_library_preferences`.
  Those columns are written only through this function.
- World Hub callers (`src/services/bankrollPreferences.js`,
  `memoryGamesPreferences.js`, `newsPreferences.js`) throw on the error;
  `pokerNearMePreferences.js` catches it and returns the optimistic value, so
  that page looked saved and was not.

The fix is the test and nothing else:

```sql
  v_rows bigint;
  ...
  ) INTO v_preferences USING p_preferences, p_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
```

Signature, SECURITY DEFINER, search_path, owner, grants and every other line
are asserted byte-identical. Preimage `8cd27b35b801feb60a239bdf1c0c51cd` (what
20261004214251 leaves), postimage `875d8538e2edb229d6ebe898eebb1281`.

No damage to settle: nothing was ever stored, so nothing is wrong in a row.
Players' earlier choices were never saved and cannot be recovered.

Not changed, deliberately:

- The allowlist still names `trivia_preferences`, `video_preferences` and
  `diamond_arcade_preferences`, which are not columns of `profiles`. A call
  naming one fails 42703 at the UPDATE, as before. No caller in either
  repository sends them.
- The function REPLACES the whole jsonb column. Now that it works,
  `bankrollPreferences.js` and `memoryGamesPreferences.js` (World Hub), which
  send a partial object without merging, will overwrite the stored blob with
  the partial one. News and Poker Near Me already merge first. That is World
  Hub's to align; it is listed in the PR.

## 2. The `arena_withdrawals` payout-freeze scope

Its one reader was `fn_arena_withdraw`, which has only raised since
20260909065458 and is dropped by 20261004214251. After that drop the name was
left in three live places, and all three are changed:

| where                                    | before      | after                                   |
| ---------------------------------------- | ----------- | --------------------------------------- |
| `fn_ca_open_payout_freeze` accepted list | 5 scopes    | 4 (`unknown_scope` for the retired one) |
| `ca_payout_freeze_scope_check`           | 10 scopes   | 9                                       |
| comment on `ca_payout_freeze.scope`      | reserves it | says it was retired and why             |

`ca_payout_freeze` holds 0 rows in any scope, so there is no history to keep.
The migration reads that under its lock and refuses if a row in the scope
exists, rather than deleting or rewriting freeze history. No other scope is
touched. Neither repository offers the scope in any UI or API list; World Hub
names it only in a CI probe schema snapshot
(`scripts/ci/probes/owner-operational-notification/inputs/schema.sql:52854`).

`fn_ca_open_payout_freeze`: preimage `ecf284c2ab749e2339918ff89ed4c874`,
postimage `03fe1a6b3b13713de339f9a9c58eedef`.

Lock: AccessExclusive on `ca_payout_freeze` (empty, read by the wheel, mint,
BBJ and settle paths), taken in at most 40 attempts of 250 ms, so no reader
waits behind this file for longer than that.

## 3. `fn_ca_arena_seat_is_same_asset` and DR15: KEEP

Decision recorded: keep both, no code change. They are shared by the new Poker
Arena seat path, not legacy.

## Local proof (PostgreSQL 16.15, live definitions loaded, md5s equal to production)

- Without 20261004214251 applied: refused at the preimage, nothing changed.
- With it emulated (`8cd27b35...` reproduced locally): applied once; all four
  `@live-proof` predicates true; grants and owner unchanged.
- `update_page_preferences` as `authenticated`: existing profile returns the
  stored jsonb and the row holds it; a NULL value is stored and returned; a
  missing profile answers `Profile not found`; another user's id answers
  `Unauthorized: User ID mismatch`; `diamond_arena_preferences` answers
  `Invalid preference column`.
- `fn_ca_open_payout_freeze('arena_withdrawals', ...)` answers `unknown_scope`;
  `diamond_issuance` still opens; a direct insert of the retired scope violates
  the CHECK; `wheel` and `mines` rows still insert.
- A row in the retired scope: refused, nothing changed.
- A competing reader holding the table 1.2 s: locked after 2 failed tries, same
  end state.
- Second apply: refused at the preimage.

The live path was reasoned about and proved locally, not executed on
production (CLAUDE.md 11.5 rule 5, and no DDL probe on production).

Regression test: `tests/page-preferences-count-the-row-they-wrote.test.ts`.
