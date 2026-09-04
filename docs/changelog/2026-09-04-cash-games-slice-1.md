# 2026-09-04 — Cash games, Slice 1: a host creates a GAME, not a table

Operation Table Stakes, Gate 2 (OPORD 1.3 sections 7-8 as amended by OPORD
1.4 sections 2.6, 2.7, 18.1 and rulings R1-R3). Follows Slice 0
(`2026-09-04-chip-continuity-slice-0.md`).

## What changed, in one paragraph

The cash create path moved out of the browser and into the database. The
Regular tab of `TableConfigPage` now renders `CashGameCreateFlow`, six locked
steps in the OPORD's order (template, variant, stakes, table size, rules,
confirm); it asks `fn_cash_template_defaults` for the section 8 defaults on
every template or variant change and calls `fn_cash_game_create` once, which
validates everything, writes the `cash_games` row (the cluster) and its Main 1
`tables` row projected from the resolved `ruleset_snapshot`, and returns both
ids. `buildTableData` and the 40-control cash form are gone; the browser no
longer has a column list to get wrong. `fn_cash_session_open` was re-created
so a session inherits the game's stay clock and rejoin window from the
snapshot (raise only; the 10-minute and 120-minute floors stand).

## Scoreboard (probe, rolled back, against the LIVE definitions)

```
A1.1 classic nlh: tables=1 role=main idx=1 lifecycle=live seats=9 buyin=120.00-600.00 stakes=1.5/3 name=Classic NLH 1.5/3 status=waiting ante=f nit=f bomb=f PASS
R3 main-1 flags: ext=t restart=t create=f union=fade0000-... access.union=fade0000-... PASS
A1.2 madness plo5: seats=6 buyin=200.00-400.00 ante=t/2.00 vpip=t/70/30 bomb=t/once_per_orbit/3x/2 boards/double=t straddle=f snap.seats_locked=true PASS
A1.3 action nlh ante_bb override: snapshot=5 table=5 trigger=timed/900s seats=6 ante=1.00 vpip=30/40 name=Action NLH 1/2 PASS
A1.4 classic nlh 7 seats refused: HANDEDNESS_INVALID: 7 is not offered for classic nlh PASS
A1.4 classic nlh 6 seats accepted: seats=6 PASS
A1.5 plo8o refused: VARIANT_UNAVAILABLE: plo8o is not available yet PASS
A1.5 no silent nlh fallback row: 0 PASS
A1.6 games with a table count other than 1: 0 PASS
ROE7 stay clock 5 refused: STAY_CLOCK_BELOW_FLOOR: 5 minutes; the minimum is 10 PASS
ROE7 raised clocks accepted: snapshot stay=20 rejoin=240 seats=8 PASS
KEY duplicate refused: GAME_EXISTS: this club already runs Madness PLO5 1/2 PASS
SESSION inherits clocks: stay=1200000 rejoin=14400000 remaining=1200000 PASS
AUTH stranger refused: NOT_AUTHORIZED: you cannot create games in this club PASS
```

Probe: `scripts/dev/probe-cash-games.sql` (one `DO` block, `RAISE`s its report
so nothing commits). Owner 47965354-..., club fade0000-...0001, 18:49 UTC.

The client half (A1.1, A1.4 picker rendering 9/6 vs locked 6, A1.5 disabled
chip, A1.6 slider floors, step order, one create for Save and Start) is
`tests/cash-games-are-created-from-a-template.law.test.tsx`, registered in
`docs/LAWS.md`. Vocabulary parity (picker == engine `KNOWN_VARIANTS` == the
two SQL lists) is `tests/unit/cashGamesVocabulary.test.ts`.

## The migration, and how it reached production (read this)

`supabase/migrations/20260904160500_cash_games_slice_1.sql`, recorded in
`supabase_migrations.schema_migrations` as version `20260904160500`
(`cash_games_slice_1`, created_by `claude-cowork`). It was first written as
`20260904160000`; that version number was already taken on production by
another agent's `ca_rg_loosen_list_is_an_array`, so the file was renamed
before recording. Nothing else about it changed.

**It was applied by accident, statement by statement, at 18:45 UTC.** The
probe generator substitutes `__MIGRATION__` into the probe's `DO` block. The
probe file's header comment also contained the literal token, so the
generator pasted the whole migration into that comment line - where the
first line was still a comment and every line after it was live SQL at the
top level of the file. `psql -v ON_ERROR_STOP=1 -f` ran those statements in
autocommit, one at a time, then stopped on the syntax error the tail of the
comment produced, so the `DO` block itself never ran. Consequences, in order
of weight:

1. The content that landed is byte-for-byte the content in the migration file
   (the final version: R3 flags on Main 1, union scope through
   `fn_club_union_context`). Its own assertion block ran and passed as part
   of that sequence. Verified afterwards: `cash_games` exists, the four
   `tables` columns exist, the three functions exist, `fn_cash_session_open`
   reads `cluster_id`, zero `cash_games` rows.
2. It was NOT one transaction. Section 2's production DDL policy asks for one
   `BEGIN/COMMIT` per change so PostgREST reloads once; this reloaded roughly
   twenty times over a few seconds. No PGRST002 was observed (the
   `authenticator` timeout is 5 minutes since 2026-08-31), but the policy was
   broken and this is the record of it.
3. The probe was then run against the live definitions with `__MIGRATION__`
   replaced by a comment, and every scenario passed inside the rolled-back
   transaction (the scoreboard above).

Fix so it cannot recur: the header comment in `scripts/dev/probe-cash-games.sql`
no longer contains the placeholder tokens and says why. A generator should
substitute tokens only inside the `DO` block.

## SQL

- `public.cash_games` - the cluster: club, union, name, template
  (classic|action|madness), variant (the nine the engine deals), sb, bb,
  handedness, `ruleset_snapshot` jsonb, enabled, state (live|dormant),
  cap_mains 8, allow_second_feeder. Unique per
  (club, variant, sb, bb, template) while enabled -> `GAME_EXISTS: this club
already runs Madness PLO5 1/2`. RLS: authenticated read.
- `public.tables` gains `cluster_id` (FK cash_games), `role` (main|feeder),
  `main_index`, `lifecycle` (opening|live|breaking|closed) + partial index.
- `fn_cash_stakes_label(sb, bb)` -> `1.5/3`, `1/2`.
- `fn_cash_template_defaults(template, variant)` IMMUTABLE -> the section 8
  defaults: seats/seat_choices per family (PLO family 6 locked, Classic
  Hold'em 9 or 6, others 2-8/2-9), min buy-in 40/50/100 BB, max 200, ante
  none/sb/bb, VPIP floor (classic 0; action 30/40/35; madness 60/70/65),
  window 40 (madness 30), bombs (off / timed 15m 2BB 2 boards / every orbit
  3BB 2 boards), straddle false, stay 10, rejoin 120, run-it opt-in, rake
  existing.
- `fn_cash_game_create(club, template, variant, sb, bb, handedness, overrides,
name)` SECURITY DEFINER for authenticated: needs `auth.uid()`, a live
  session, and `fn_can_create_games` or `is_club_admin`. Refusals:
  `TEMPLATE_UNKNOWN`, `VARIANT_UNAVAILABLE`, `STAKES_INVALID`, `HANDEDNESS_INVALID`,
  `BUYIN_BAND_INVALID`, `ANTE_INVALID`, `VPIP_INVALID`, `BOMB_*`,
  STAY_CLOCK_BELOW_FLOOR, REJOIN_WINDOW_BELOW_FLOOR, CLOCK_TOO_LONG,
  NOT_AUTHORIZED, GAME_EXISTS. Writes the game, then Main 1 projected onto
  the existing engine columns: ante via `ante_enabled/ante/ante_bb`, VPIP via
  `nit_game/maintain_percent_min/maintain_hands` (enforced by
  `fn_nit_evictions`), bombs via `bomb_pot_trigger_mode 'timed'(900s) |
'once_per_orbit'`, `bomb_pot_ante_multiplier`, `bomb_pot_board_count`,
  `bomb_pot_double_board`; `run_it_mode 'player_choice'` + all three RIT
  booleans true; rake -1/-1 (schedule); straddle columns false (R2);
  `seven_deuce_enabled` only on NLH; `auto_start_players 2`;
  `auto_extension true, auto_restart true, auto_create_table false` (R3 until
  the ClusterController owns the lifecycle at Slice 6); union scope through
  `fn_club_union_context`, the same answer `fn_game_creation_access` gave the
  old page.
- `fn_cash_session_open` re-created: reads the snapshot via
  `tables.cluster_id`, `stay_clock_ms = GREATEST(600000, stay_clock_min*60000)`,
  `rejoin_window_ms = GREATEST(7200000, rejoin_window_min*60000)`.

## Client

- `src/components/cash/CashGameCreateFlow.tsx` + `.css` - the six steps.
  Template cards, variant chips (an undealt route variant shows disabled as
  "NLHE - Not Available Yet"), stakes chips from `presetsFor(limitGame)`,
  table-size chips from `seat_choices` ("6-Max Is Locked For Omaha Games"),
  rules panel (name, buy-in band sliders, ante, VPIP floor/window, bombs
  toggle/trigger/ante/boards, stay clock and rejoin window sliders whose
  minimum IS the snapshot floor, option toggles, action time 10-60s), the
  price panel carried over from the old form (`getRakeConfig` with
  `RAKE_INHERIT`, "No Bad Beat Jackpot On This Game" where the schedule says
  so), Save/Start footer. Refusals map to house copy
  (`cashGameCreateRefusalText`); anything else surfaces the server message.
- `src/config/cashGames.ts` - templates, the nine variants with family,
  snapshot/override types, refusal copy.
- `src/components/table-config/controls.tsx` - `Toggle`, `Slider`,
  `NumberField` moved verbatim out of the page so both forms draw the same
  switch; imports `TableConfigPage.css` so the classes resolve on any route.
- `src/pages/TableConfigPage.tsx` - Regular tab renders the flow; the cash
  sections, `buildTableData`, the cash Save/Start branches and the dead
  cash-only helpers are deleted. Tournament tabs untouched.

## Tests moved, not weakened

Every pin that asserted a column on `buildTableData` now asserts the same
column on the INSERT in `fn_cash_game_create`, with the date and reason in
the file: `a-control-that-says-none-must-mean-none.law`, `bombPotGuards`
(round 8), `buyInBandIsOneColumnPair`, `createTableHelpAndSwitches`,
`engineSelectIsTheContract`, `fixedLimitTableOffersOnlyWhatItHonours`,
`gameManagementArchitecture`, `limitUserIntent`, `oneTableWriter`,
`tableConfigSeatLawClamp`, `tableCreationRealitiesTest`,
`tableLifecycleSwitches`, `theCreateTableFormOffersOnlyLiveSwitches`,
`theFormSaysWhatTheTableWillCharge`, `variantSwitchesTellTheTruth`. Three
pins changed MEANING and say so: the three lifecycle switches are no longer
offered (the cluster lifecycle is autonomous); pineapple is a variant, not a
flag; straddle/cap/bomb-variant are off every cash game, not just limit ones.

## Manifest

`scripts/ci/schema-manifest.d/cash-games-slice-1.json`.
