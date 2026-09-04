# 2026-09-04 — Cash games, Slice 1 hardening + ruling R9 + the game cards

Follows `2026-09-04-cash-games-slice-1.md`. Dan's instruction before Gate 3:
"do a deep dive and verify that everything you've built in the previous
phase is 100% fully built, coded, wired in and tested." A hostile audit of
Slice 1 found fifteen items; this is what was fixed, what was ruled, and
what was added.

## Migration `20260904230000_cash_games_slice_1_hardening.sql`

Applied to production 19:16 UTC in ONE transaction (`psql -f`, `BEGIN` /
`COMMIT` in the file), recorded as version `20260904230000`. Probe
(`scripts/dev/probe-cash-games.sql`, now 26 scenarios) passed 26/26 inside a
rolled-back transaction first, then the file was applied as-is:

```
A1.1 classic nlh: tables=1 role=main idx=1 lifecycle=live seats=9 buyin=120.00-600.00 stakes=1.50/3 name=NLH 1.50/3 Classic ... PASS
R3 main-1 flags: ext=t restart=t create=f union=fade0000-... PASS
A1.2 madness plo5 ... PASS   A1.3 action nlh ante_bb override ... PASS
A1.4 (x2) PASS   A1.5 (x2) PASS   A1.6 PASS   ROE7 (x2) PASS   KEY duplicate refused PASS
H2 flh 1/2 labelled by bet size: name=FLH 2/4 Classic stakes=2/4 label(0.05,0.10)=0.05/0.10 PASS
H3 NaN refused: STAKES_INVALID PASS       H3 sub-cent refused: STAKES_INVALID PASS
H4 bad override refused: OVERRIDE_INVALID: vpip_floor must be a whole number, got abc PASS
H4 bombs array refused: OVERRIDE_INVALID: bombs must be an object PASS
R9 manual: two at one key=2 ext=f restart=f mode=manual must_move=false PASS
R9 must-move still one per key: GAME_EXISTS PASS
H1 close main 1 (via the command door): ok=true enabled=f state=dormant by_owner=t table=closed after pass; recreate=recreated PASS
R3 an open game reopens after a stray close: status=waiting PASS
H5 outsider sees private=0 public=1 PASS   H5 member sees private=1 PASS
SESSION inherits clocks: stay=1200000 rejoin=14400000 remaining=1200000 PASS
AUTH stranger refused: NOT_AUTHORIZED PASS
```

| #   | Finding (severity)                                                                                                                                                                                                 | Fix                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **P1** A Slice 1 game was immortal: `auto_restart` made `fn_table_lifecycle_pass` reopen a closed Main 1 within a fleet cycle; `cash_games.enabled` had no writer; `GAME_EXISTS` refused the key forever.          | `fn_close_managed_game('table', main1)` now also sets `cash_games.enabled=false, state='dormant', closed_at, closed_by`; the restart loop skips a table whose game is disabled; the unique key frees. Both functions re-created from their deployed bodies plus the one clause. |
| H2  | **P1** Fixed-limit games were named and labelled by blinds ("FLH 1/2") while the picker, the lobby and the old path use bet sizes ("FLH 2/4").                                                                     | `fn_cash_stakes_label(sb, bb, variant)`: `bb/2bb` for `flh`/`flo8`. Name and `tables.stakes` both use it.                                                                                                                                                                       |
| H3  | P2 `NaN` passed every numeric check; sub-cent blinds hit the CHECK raw; nine-figure blinds printed `###`.                                                                                                          | `STAKES_INVALID` for NaN, non-2dp, bb > 100000.                                                                                                                                                                                                                                 |
| H4  | P2 A malformed override raised a raw cast error; `bombs` as an array silently switched bombs off.                                                                                                                  | `fn_cash_override_int/bool` raise `OVERRIDE_INVALID: <key> ...`; `bombs`/`options` must be objects.                                                                                                                                                                             |
| H5  | P2 `cash_games` was readable by every signed-in user on the platform, private games included.                                                                                                                      | Read policy: not private, or a member of the club.                                                                                                                                                                                                                              |
| H6  | P2 Default names began with the template word, which the lobby's title stripper does not know ("NLH 1/2" over "Classic NLH 1/2").                                                                                  | Names are `NLH 1/2 Classic`; `cashTitleLines` leaves "Classic".                                                                                                                                                                                                                 |
| H7  | P2 Picker prints `0.05/0.10`, label printed `0.05/0.1`.                                                                                                                                                            | `fn_cash_money_text`: two decimals when not whole.                                                                                                                                                                                                                              |
| H8  | **P1** The flow's Save/Start footer was `position: fixed; bottom: 0` and sat UNDER the club bottom nav on every viewport.                                                                                          | Deleted; the inherited `.config-footer` sticky footer already clears `--bottom-nav-clearance`.                                                                                                                                                                                  |
| H9  | P2 `cashGameCreateRefusalText` had no wording for TEMPLATE_UNKNOWN, ANTE_INVALID, VPIP_INVALID, VPIP_WINDOW_INVALID, CLOCK_TOO_LONG, CLUB_REQUIRED, OVERRIDE_INVALID.                                              | Added.                                                                                                                                                                                                                                                                          |
| H10 | P2 Dead cash-only code left in `TableConfigPage` (`isFixedLimitGame`, `limitGame`, `offeredPresets`, the blinds-snapping effect, three imports, a header that still said "40+ options ... rake settings").         | Removed; header rewritten. The cash fields on `TableConfig`/`DEFAULT_CONFIG` stay so a pre-Slice-1 `table_templates` row still restores.                                                                                                                                        |
| H11 | P2 `tables.role` could make an unqualified `role` ambiguous inside PL/pgSQL.                                                                                                                                       | Checked on production: every function that mentions both `tables` and `role` qualifies it (`m.role`, `cm.role`, `cr.role`). No change needed.                                                                                                                                   |
| H12 | P2 `src/services/HorseOrchestrator.ts` still inserts fleet cash tables from the browser, outside any cluster, with straddle on.                                                                                    | Not changed here. It is the horse fleet's own writer (sanctioned in `oneTableWriter`); it is retired at the Slice 6 cutover, which is where the fleet moves to clusters. Named in the handoff.                                                                                  |
| H13 | P2 A union operator who is not a club member can create (`fn_can_create_games`) but `authorizeTableViewer` refuses the engine wake, so Start navigates to a felt that has no engine yet.                           | Pre-existing shape; the engine still adopts the table at the first seat. Named in the handoff for Gate 3 (the controller wakes Main 1, not the browser).                                                                                                                        |
| H14 | Settled: the engine adopts Main 1 (`isWakeableCashTable` on Start; `cash_tables_needing_engine` once a seat is taken); `get_club_home` lists it; `fn_tables_creation_guard`/`autostart_guard`/`sync_rit` all pass. | No change.                                                                                                                                                                                                                                                                      |
| H15 | Settled: `fn_cash_session_open` after the re-create is the Slice 0 hardening body plus the clock inheritance; the ACL is re-stated in the file.                                                                    | No change.                                                                                                                                                                                                                                                                      |

## Ruling R9 (Dan, 2026-09-04) - the table mode

"After you select which game type you want to create for the table, you
should then have to check off, manually create individual tables, or use
automated must move games." Recorded in `docs/OPORD-1.4-AMENDMENT.md` as R9.

- `cash_games.must_move boolean NOT NULL DEFAULT true`; the one-per-key
  index is now `WHERE enabled AND must_move` (a host may run any number of
  hand-made tables at one stakes).
- `fn_cash_game_create(..., p_must_move boolean DEFAULT true)` - the old
  8-argument signature is DROPPED (the browser calls by name, so the new
  default is transparent). Snapshot carries `table_mode: must_move|manual`.
  Main 1 flags: must-move `auto_extension=true, auto_restart=true`; manual
  `false, false`. `auto_create_table` never.
- The flow has a new step 3, **Table Mode**, between Variant and Stakes:
  "Automated Must Move" / "Manual Individual Table". Stakes wait on it.
- The lobby card reads MUST MOVE or MANUAL from `must_move`.

## The game cards (Dan's artwork)

`public/images/cash-cards/{classic,action,madness}.webp` are the three
supplied JPGs with every changing value lifted out (stakes line, variant
line, the two pill texts, the four row values, the rules strip), filled from
the surrounding panel so the frame, emblem, title, row labels and button
faces are all that remain. ~120 KB each.

`src/components/cash/CashGameCard.tsx` + `.css` paints the dynamic parts over
the artwork: zones are percentages of the 784 x 1168 frame (`ZONES`, measured
against the JPGs), type is in container-query units, long labels shrink via
`--cgc-fit`. `rulesLineFor(snapshot)` produces the strip in the artwork's
wording. VIEW GAME / JOIN GAME are real buttons over the painted faces.
Verified by a headless-Chromium render of all three at 340px
(`tests/unit/cashGameCard.test.tsx` pins the rest).

**Not yet wired into the lobby.** That is Gate 4 (one card per game, fed by
`cash_games` and its cluster's tables). The handoff says exactly where.

## Tests

- `tests/cash-games-are-created-from-a-template.law.test.tsx`: step order now
  includes `mode`; Stakes disabled until a mode is chosen; Save passes
  `p_must_move`.
- The fifteen moved pins now read `20260904230000_cash_games_slice_1_hardening.sql`
  (the live definition of `fn_cash_game_create`), not the superseded file.
- `tests/unit/cashGameCard.test.tsx` (new).
- Client suite and server suite green (the one local red is
  `the-media-optimizer` for a missing local `sharp`; CI has it).

## Process

- PR #2986 was closed and re-cut as `fix/cash-games-slice-1-v2`: the first
  branch descended from the Slice 0 branch, and the Silent Revert Guard read
  those commits (not the tree) as undoing #2927. A branch cut from
  `origin/main` with the same tree carries no such history.
- The Slice 1 migration file was renamed to `20260904160500` because
  `20260904160000` was already another agent's version on production.
