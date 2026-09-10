# Lane H - the client at the table for must-move games (2026-09-09)

Status key: DONE / PARTIAL / NOT STARTED. Written incrementally; the last
section says what was still open when the run ended.

Database used: `kuklfnapbkmacvwxktbh` (the brief's `ydsaqnnuwyvtyxgvrnys` has
zero `fn_cash_*` functions - 363 functions, none of ours; every SQL fact below
was re-read against the right project).

## 1. Read line by line

| File | Lines | Notes |
| --- | --- | --- |
| `src/components/table/CashClusterHUD.tsx` | 219 (all) | corner column: notice, Seat Change, listed, waitlist / Chair Open |
| `src/components/table/CashClusterHUD.css` | 83 (all) | |
| `src/components/table/MustMoveLobbyModal.tsx` | 456 (all) | |
| `src/components/table/MustMoveLobbyModal.css` | 394 (all) | |
| `src/components/table/TournamentLobbyModal.css` | 188 (all) | the 3/4 geometry the lobby reuses |
| `src/services/cashGameLobby.ts` | 346 (all, READ ONLY - lane G) | contract verified against the live functions |
| `src/pages/TablePage.tsx` | 985-1000, 11490-11520, 12050-12095, 15180-15240, 22470-22530, 22880-22960, 26240-26275 | movedToTableId, OPEN_MUST_MOVE_LOBBY bus, gameStyle read, SEAT_MOVE_* handlers, the corner mount, the masthead rows, the modal mount |
| `src/pages/MultiTablePage.tsx` | 575-605, 960-1020, 2160-2240, 2790-2870, 2930-2960, 3655-3735, 3935-3975, 4215-4245, 4385-4400 | route derivation, tab prune, handleTabSelect URL sync, updateTableInfo re-point, route layout effect, last-active storage, LOBBY button, TablePage key |
| `src/pages/TablePage.css` | 1225-1640 | the masthead / placard rows and the 380px override |
| `src/components/table/AddOnBubble.ts` | 1-60 | the notice bubble variant (not the move notice; the move notice is `.cch-move-notice`) |
| `src/components/table/ChatBubble.tsx` | grep of the `notice` variant | |
| `src/components/club-buttons/club-buttons.css` | 1-400 | the painted club kit on main (hub-sized, not felt-sized) |
| `src/styles/club-engine.css` | the `#SMARTERCASINOREALISM` block | the tokens the rebuild draws from |
| `src/styles/metallic-popups.css` | 1-398 | the dialog chassis; found the `[class*='-close']` trap |
| `src/components/table/TableHUD.css` | 105-320 | `.hud-ur-column` input / scale rules |
| `tests/must-move-lobby.test.tsx` | 573 (all) | |
| `tests/unit/heroVpipTrackerAndFeltStyle.test.tsx` | 379 (all) | |
| `tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx` | 280-400 | the corner / list pins |
| `.claude/skills/club-arena-console/SKILL.md` | 688 (all, from the Smarter-Poker-Club-Arena clone) | the painted-chassis standard |
| Live SQL (`pg_get_functiondef`) | `fn_cash_game_lobby`, `fn_cash_seat_change_request`, `fn_cash_seat_change_cancel`, `fn_cash_seat_change_status`, `fn_cash_game_waitlist_position`, `fn_cash_game_must_move_list` | plus `cash_seat_moves` columns and one live 5-table game's lobby JSON |
| Changelogs | `2026-09-05-the-must-move-lobby.md`, `2026-09-05-moving-in-n-hands-and-the-lobby-says-the-style.md`, `...the-move-survives-the-hand...md` (Still owed) | |

## 2. Contract, verified against the live database

- `fn_cash_game_lobby(p_game_id)`: `me` is `null` for an anonymous caller; for
  a signed-in caller it always carries `seated`, `table_id`, `on_main_one`,
  `must_move_position`, `seat_change {available, used_at, request{position}}`,
  `pending_move {reason, swap, held, to_role, to_main_index}` and, when not
  seated, `waitlist {waiting, position, on_list}` (`fn_cash_game_waitlist_position`).
  `available` = seated AND not Main 1 AND not used AND no request AND no
  pending move AND lifecycle not breaking/closed. The client reads exactly
  those fields; nothing is invented client-side.
- `fn_cash_seat_change_request(p_game_id, p_to_table_id default null, p_user_id
  default null)`: the client passes two args; `p_user_id` is engine-only
  (`fn_caller_is_engine()`). Raises: NOT_AUTHENTICATED, PLATFORM_FROZEN,
  GAME_NOT_FOUND, SEAT_CHANGE_MANUAL_GAME, NOT_IN_GAME, SEAT_CHANGE_NOT_FROM_MAIN,
  SEAT_CHANGE_TABLE_CLOSING, MOVE_PENDING, SEAT_CHANGE_USED,
  SEAT_CHANGE_TABLE_UNAVAILABLE, SEAT_CHANGE_NEVER_TO_MAIN, SEAT_CHANGE_SAME_TABLE,
  SEAT_CHANGE_NO_OTHER_TABLE. The brief's names (NOT_SEATED, MAIN_1,
  TABLE_NOT_ELIGIBLE) do not exist; the real codes all have house copy in
  `SEAT_CHANGE_REFUSALS` except NOT_AUTHENTICATED / GAME_NOT_FOUND, which fall
  to the generic line (lane G file - reported, not edited).
- `fn_cash_seat_change_cancel`: cancels only `status='requested'`, gives the
  button back (`seat_change_used_at = NULL`). Client copy matches.
- `fn_cash_seat_change_status`: `action` moving / swapping / listed / moved /
  none; `to_table_name` only when a move exists. The client falls back to the
  lobby's own label / "Any Table" for a listed request - correct.
- `cash_seat_moves` has NO hands-until column (17 columns read). "Moving After
  This Hand" is the truth; a "moving in N hands" countdown has nothing to count
  and is correctly not built (documented 09-05, pinned by test).
- Live templates: action -> `nit_game=true, maintain_percent_min=30` (20
  games), madness -> `true, 50` (20), classic -> `false, 0` (69 games, 96
  tables). The felt prints the VPIP row only when `nit_game && min > 0` and the
  hero badge only when the RPC says `nit_game`; Classic prints neither. DONE
  (existing tests cover it; re-run green).

## 3. Findings

| # | Sev | Finding | Evidence | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| H1 | P1 | The lobby printed the database's error text. `setError(String(err.message))` put `GAME_NOT_FOUND: <uuid>` (stale tab on a game since closed) or a raw PostgREST message into `.mml-error`. | `MustMoveLobbyModal.tsx` load() catch, old line 108 | New `src/components/table/mustMoveLobbyCopy.ts` (house copy, Title Case, no em dash: GAME_NOT_FOUND / NOT_AUTHENTICATED / PLATFORM_FROZEN + one fallback); the modal shows the sentence and drops its figures when the game is gone. Test: `tests/unit/mustMoveLobbyAudit.test.tsx` | DONE |
| H2 | P1 | A must-move re-pointed the tab but the address bar kept naming the OLD table. Reload / Back / dock read the URL, so a reload re-opened a table the hero had left (and after a break, one that no longer exists) and painted it first. | `MultiTablePage.tsx` updateTableInfo (re-point) vs handleTabSelect (which does sync the URL); route layout effect keyed on `routeTableId` adds any unknown id as a tab | When the route names the moved tab, `navigateRef.current('/table/<dest>', {replace:true})` before `setTables` (outside the updater; refs for the live navigate under BrowserRouter and the live route id). Never touches `activeIndex`. Test: same file, source pins | DONE |
| H3 | P2 | The corner kept its last figures through GAME_NOT_FOUND: a lit SEAT CHANGE for a ghost game. | `CashClusterHUD.tsx` load() swallowed every error | Drops state on GAME_NOT_FOUND only; a passing failure still keeps the last read (the poll continues). Test: same file | DONE |
| H4 | P2 | JOIN GAME borrowed `.tlm-close` for geometry; `metallic-popups.css` paints every `[class*='-close']` in a dialog as steel close hardware with `!important`, so the one action in the header never rendered blue. | `metallic-popups.css` close-control rule; `MustMoveLobbyModal.tsx` old line 236 | `.mml-join` owns its geometry and the lit face. Test: source pin | DONE |
| H5 | P2 | #ClubArenaConsole / #SmarterCasinoRealism: the corner and the lobby were flat generic panels (solid #1877f2 rectangles, `rgba(255,255,255,0.04)` cards, 1px grey borders). | both CSS files, TournamentLobbyModal.css | Rebuilt on the material vocabulary in `club-engine.css` (`--realism-*` with fallbacks): bevelled gunmetal frames (bevel + cavity + lift), chrome-lettered Roboto Condensed labels with an engraved shadow, cyan condensed readouts in recessed wells, illuminated blue pill buttons with a specular line, a glow and an `:active` press, no `:hover`. Markup, test ids, sentences and sizes unchanged (notice 240px / 200px, pointer-events none). Test: CSS pins | DONE (see H5b) |
| H5b | P2 | The PAINTED chassis (`SpadeConsole`, `spade-console-v1` slices) is NOT on origin/main (`git cat-file -e origin/main:src/components/console/SpadeConsole.tsx` fails at 9c0b622d17); it lives on `agent/cw-console/feat/console-rewards-promotions` in the Smarter-Poker-Club-Arena clone. Printing these surfaces onto that art is that programme's re-render once it merges; the content layer here is what it keeps. | host_terminal | Not fixable from this branch without copying another agent's unmerged art | NOT FIXABLE HERE |
| H6 | P3 | Seat-change note said "Seat Change Not Available Right Now." under a must_move / break / balance pending-move sentence that already said where the player was going (only `seat_change` was suppressed). | modal line 305 (old) | Any pending move suppresses the note. Test: all four reasons | DONE |
| H7 | P3 | The comment above `<MustMoveLobbyModal>` in TablePage described the tournament lobby. | TablePage.tsx ~26262 | Rewritten; the tournament paragraph moved to `<TournamentLobbyModal>` | DONE |
| H8 | P3 | Two em dashes in a CashClusterHUD.tsx comment. | lines 130-131 | Replaced | DONE |
| H9 | P2 (lane G) | `SEAT_CHANGE_REFUSALS` has no GAME_NOT_FOUND / NOT_AUTHENTICATED; both fall to "Seat Change Not Available Right Now." Suggested: `GAME_NOT_FOUND: 'This Game Is No Longer Here.'`, `NOT_AUTHENTICATED: 'Sign In To Request A Seat Change.'` | live function body | `cashGameLobby.ts` is lane G's - not edited | REPORTED |
| H10 | - | 5 s poll: reads on open, every tick while open, nothing while closed, cleared on unmount (effect keyed on `isOpen`/`gameId`). Corner: 10 s, re-read on every SEAT_MOVE_* event via refreshKey, cleared on unmount. | code read | No defect; pinned with fake timers | DONE |
| H11 | - | seat_moved: an embedded TablePage reports `movedToTableId`; MultiTablePage re-points that tab in place (`next[idx] = {id: dest ...}`), closes the old one if dest is already a tab, never sets activeIndex; standalone navigates with replace. In production every TablePage is embedded (PersistentTableLayer). | code read + existing pins | No defect beyond H2 | DONE |
| H12 | - | A move landing while the modal is open: the embedded TablePage is keyed by table id, so the re-point remounts it; the modal closes with it, the new page re-reads `cluster_id` and the style. No second tab. | code read | No defect | DONE |
| H13 | - | The 375px placard squash: FIXED ON 2026-09-05 (`TablePage.css` "THE PLACARD DOES NOT SQUASH", the 380px block gives each row its own step) and pinned by `heroVpipTrackerAndFeltStyle.test.tsx`. Measured from the CSS: game+stakes row clamp(0.6rem, 10.5cqw, 0.9rem) = 14.4px at 375 (0.98rem cap = 15.7px at 393), VPIP row 0.5rem = 8px at 375 and 0.54rem = 8.64px at 393, club line 7px at 375 / 7.7px at 393. The 7px squash of the style/rules rows is gone; the rows are ~8-9px captions under a 14-16px game line. Raising them further changes a masthead Dan reviewed row by row on 09-07 (items 6, 7A-7D) and is his call, not mine. | CSS + test | Not changed | VERIFIED, NOT CHANGED |

| H14 | P1 | The masthead's game line ellipsized the STAKES on phones. `clamp(0.6rem, 10.5cqw, 0.98rem)` was measured for "NLH 0.10/0.25" alone (13 characters); the style went in front of it and the ante behind it on 09-07 (7B) and nobody re-measured. Rendered headless against the real stylesheet: at 375px the box is 154px, the row 14.4px, and "MADNESS NLH 1/2 + BB Ante" (~230px) printed as "MADNESS NLH 1/..."; at 393px (178px box, 15.7px) the same. Every Action and Madness table on a phone lost its stakes and its ante - the two facts 7B put on that line. | `lane-H-renders/placard-before-375.png`, `placard-before-393.png` | New `src/components/table/MastheadGameLine.tsx`: the span measures its rendered width against the row (the way every card title does, `useFitText`) and writes `--fit`; `TablePage.css` folds it in as `font-size: calc(100% * var(--fit, 1))` and hands the tracking down as an em (`--sp-game-ls`) because inherited letter-spacing is a computed px that did not scale (measured: 12px over at the ratio that should have fit). Two passes (glyph advances round at small sizes: 3-6px over after one), a 2px margin (ellipsis fires on ANY overflow: 1px over lost the last letter), a floor of 0.55 of the designed size, and past the floor the line WRAPS centred instead of ellipsizing (7A's call for names, made for stakes). Result: 9.12px on one line at 375px, 10.66px at 393px, every character; a desktop box stays at `--fit: 1`. The tournament row is untouched. Tests: `heroVpipTrackerAndFeltStyle.test.tsx` (4 new: the wiring, the pure fit at every branch, the DOM effect under mocked widths, the CSS) | DONE |

Horses (10.5): nothing in this lane special-cases `is_horse`; the PLAYERS
figure and every chair list count horses as players. Verified by grep.

## 3b. The 375px placard, answered plainly

The 09-05 "still owed" item (style / rules rows squashed to 7px by the 380px
club-line override) was FIXED on 2026-09-05 by the "THE PLACARD DOES NOT
SQUASH" block in `TablePage.css` and is pinned by
`heroVpipTrackerAndFeltStyle.test.tsx`. I did not change those sizes. Measured
headless (Chromium, real stylesheet, DPR 3): club line 7.04px @375 / 7.68px
@393, game line 14.4px / 15.68px, VPIP row 8px / 8.64px, hand 6.4px / 7.04px.
Raising the VPIP row further changes a masthead Dan reviewed row by row on
09-07 (items 6, 7A-7D) and is his call.

What the same render found, and what I DID fix (H14): the game line was
ellipsizing its stakes on every Action / Madness phone. Before / after at both
widths: `lane-H-renders/placard-before-375.png`, `placard-after-375.png`,
`placard-before-393.png`, `placard-after-393.png`. The fixture and the fit
script are not committed (they are the skill's throwaway harness pattern); the
numbers above come from `getComputedStyle` in that render.

## 3c. #ClubArenaConsole, answered plainly

Both surfaces were flat generic panels and are now on the material vocabulary
that IS on main (`--realism-*` in `club-engine.css`): bevelled gunmetal
frames, chrome-lettered Roboto Condensed labels, cyan condensed readouts in
recessed wells, illuminated blue pill buttons with a specular line, a glow and
a real press, no `:hover`. Before / after at 393px:
`lane-H-renders/lobby-before-393.png` vs `lobby-393.png` (the sheet; the
before also shows H4, JOIN GAME painted as steel close hardware) and
`lobby-before-hud-393.png` vs `lobby-hud-393.png` (the corner, every state
stacked). Measured in the render: no horizontal overflow in the sheet at 375
or 393, the notice capped at 200px on a phone, the pill face and glow render
under `metallic-popups.css` (its `!important` bevel is out-specified).

The PAINTED chassis (`SpadeConsole`, `spade-console-v1` slices, the buy-in
deck) is not on origin/main as of 2026-09-09 (`git cat-file -e
origin/main:src/components/console/SpadeConsole.tsx` fails at 9c0b622d17); it
lives on `agent/cw-console/feat/console-rewards-promotions` in the
Smarter-Poker-Club-Arena clone. Printing these two surfaces onto that art is
that programme's re-render once it merges; the markup, test ids and copy here
are what it keeps.

## 4. Commands and output

All on the Mac worktree `~/Documents/.agent-trees/club-arena/cowork-mustmove`,
node v24.15.0, via nohup + poll.

```
npx vitest run tests/unit/heroVpipTrackerAndFeltStyle.test.tsx tests/unit/mustMoveLobbyAudit.test.tsx \
  tests/must-move-lobby.test.tsx tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx \
  tests/no-auto-table-switch.law.test.ts tests/no-hover-effects.law.test.ts tests/unit/classNamesResolve.test.ts \
  tests/unit/discardedErrorReadRatchet.test.ts tests/unit/metallicPopupSystem.test.ts tests/realism-is-one-vocabulary.law.test.ts
 ✓ tests/unit/metallicPopupSystem.test.ts (7 tests)
 ✓ tests/realism-is-one-vocabulary.law.test.ts (13 tests)
 ✓ tests/no-auto-table-switch.law.test.ts (5 tests)
 ✓ tests/unit/heroVpipTrackerAndFeltStyle.test.tsx (17 tests)
 ✓ tests/unit/discardedErrorReadRatchet.test.ts (3 tests)
 ✓ tests/no-hover-effects.law.test.ts (5 tests)
 ✓ tests/unit/classNamesResolve.test.ts (4 tests)
 ✓ tests/must-move-lobby.test.tsx (17 tests)
 ✓ tests/unit/mustMoveLobbyAudit.test.tsx (20 tests)
 ✓ tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx (27 tests)
 Test Files  10 passed (10)
      Tests  118 passed (118)

npx tsc --noEmit                      -> ROOT_TSC_EXIT=0 (no output)
npx tsc --noEmit -p tsconfig.app.json -> exit 0 (no output)

node scripts/ci/check-ui-text.mjs           -> OK - no em dashes in UI text.
node scripts/ci/check-title-case.mjs        -> OK - every static word on every page starts with a capital.
node scripts/ci/check-painted-text-case.mjs -> OK - every painted string is Title Cased.
node scripts/ci/check-nav-title-case.mjs    -> OK - every navigation label is Title Cased at its source.

npx prettier --write <every file this lane touched>  (husky would do it at commit)
```

Baseline before any edit: the same three must-move files, 57/57 green.

`tests/no-auto-table-switch.law.test.ts` (5) is green with the MultiTablePage
edit; the edit adds no `setActiveIndex` call (pinned in
`mustMoveLobbyAudit.test.tsx`: the block between `const updateTableInfo` and
`const tableInfoCbRef` navigates before `setTables` and the updater still
contains no `activeIndex`, as `must-move-lobby.test.tsx` already pinned).

## 5. Files changed by this lane

- `src/components/table/mustMoveLobbyCopy.ts` (new; imported by the modal and the corner)
- `src/components/table/MastheadGameLine.tsx` (new; imported by TablePage)
- `src/components/table/MustMoveLobbyModal.tsx`, `.css`
- `src/components/table/CashClusterHUD.tsx`, `.css`
- `src/pages/MultiTablePage.tsx` (updateTableInfo + two refs; surgical, integrator please reconcile)
- `src/pages/TablePage.tsx` (one import, the cash game line wrapped in `<MastheadGameLine className="table-brand__game">`, two comments; lane D owns hunk @15229 and it is untouched)
- `src/pages/TablePage.css` (`.table-brand__game` fit + wrap rules, `--sp-game-ls` on the cash level row)
- `tests/unit/mustMoveLobbyAudit.test.tsx` (new, 20 tests)
- `tests/unit/heroVpipTrackerAndFeltStyle.test.tsx` (+4 tests)
- `docs/audits/2026-09-09-must-move-audit/lane-H-renders/*.png` (8 before/after renders, 844K)

## 6. What the new test covers (`tests/unit/mustMoveLobbyAudit.test.tsx`, 20)

- copy: the read refusals name the game-gone case and fall back to one
  sentence; every sentence the corner and lobby can say is Title Case with no
  em dash; every code the LIVE seat-change door raises (11, read off
  `pg_get_functiondef`) maps to a sentence that contains neither the code nor
  SQL words;
- the lobby on a failed read: house copy not the code, figures dropped on
  GAME_NOT_FOUND (and JOIN GAME with them), figures kept under the notice on a
  passing failure;
- the 5 s poll: reads on open, on every tick, stops the moment it closes,
  stops on unmount; the corner's 10 s poll stops on unmount;
- every caller state: on Main 1 (no seat change, off the list, "You Are In
  The Main Game.", no JOIN); on a feeder with the change used (the used note,
  no Request buttons, still on the list); a pending move of each of the four
  reasons (the sentence, no "Not Available" note); not seated on the waitlist
  (JOIN GAME, no YOUR SEAT, the corner offers the chair "In This Game" when
  one is open in the cluster, and the place on the list when none is);
- the corner drops a lit SEAT CHANGE on GAME_NOT_FOUND and keeps it through a
  passing failure;
- the address bar follows the chair (source pins: the ref pair, navigate
  before setTables, `replace: true`), JOIN GAME does not carry `-close`;
- the chassis: both sheets tagged, every `--realism-*` read with a fallback,
  no `:hover`, `:active` press, pill radius, the `!important` restatement
  against metallic-popups, sizes unchanged, no solid `#1877f2` rectangles,
  no gold / amber.

The seat-change / listed / Request states on a feeder were already covered by
`tests/must-move-lobby.test.tsx` (17) and stay green.

## 6b. After the integrator merged origin/main (2026-09-10)

Two reds in this surface, both ours, both now settled.

**`must-move-lobby.test.tsx` > "re-points the tab in place and never touches
activeIndex".** Main added a one-line `if (updates.movedToTableId &&
updates.movedToTableId !== tableId) requestSeatResync();` guard above the
branch, and the pin anchored on that same opening text, so the scanned window
silently grew to cover the resync guard, my URL-follow block and its comment.
The comment discusses the law by name, so the pin tripped on PROSE.

Fixed by making the pin precise, not by deleting the sentence: the window is
now the re-point branch taken by its own braces (`sliceEnclosingBlock`, the
house helper `noFixedSizeSourceWindows` exists to enforce), and comments and
strings are blanked (`blankNonCode`, offsets preserved) before the assertions.

**And the pin could not fail, which is the bigger finding.** `not.toMatch(
/activeIndex/)` is case sensitive, so it never matched `setActiveIndex(` - the
one spelling 10.6 is about. Proved: `setActiveIndex(idx);` inserted into that
very branch left the test GREEN. It was tripping on a word in a comment while
blind to the call beside it, which is 10.86 exactly. The assertion is kept and
two more added: `/setActiveIndex\s*\(/` names the manipulation, and
`/activeIndex/i` catches the identifier in any casing.

Falsifiability, both directions, run and then reverted (MultiTablePage.tsx
verified byte-identical afterwards, md5 f055e005666dd7724a4ce24e57cd5fc0):

| probe, inserted into the scanned branch | required | observed |
| --- | --- | --- |
| `setActiveIndex(idx);` (code) | FAIL | FAIL at line 573 |
| `// probe B: activeIndex mentioned in prose only` (comment) | PASS | PASS |

**`tests/unit/noFixedSizeSourceWindows.test.ts`** names ONLY another lane's
file and no file of mine, so it is untouched here and reported to the
integrator: `tests/a-leave-cancels-the-move.law.test.ts` lines **89**
(`block.slice(0, 600)`), **90** (`block.slice(0, 900)`), **106** and **121**
(`stmt.slice(0, 2400)`). Four hardcoded byte windows to convert to
`tests/helpers/sourceWindow`.

Re-run after the fix:

```
npx vitest run tests/must-move-lobby.test.tsx tests/unit/noFixedSizeSourceWindows.test.ts \
  tests/unit/mustMoveLobbyAudit.test.tsx tests/unit/heroVpipTrackerAndFeltStyle.test.tsx
 ✓ tests/unit/heroVpipTrackerAndFeltStyle.test.tsx (17 tests)
 ✓ tests/must-move-lobby.test.tsx (17 tests)
 ✓ tests/unit/mustMoveLobbyAudit.test.tsx (20 tests)
 FAIL tests/unit/noFixedSizeSourceWindows.test.ts   (a-leave-cancels-the-move, another lane)
 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 55 passed (56)
```

## 7. Could not do, and why

- H5b: the painted #ClubArenaConsole rebuild - the kit is on another agent's
  unmerged branch, not on origin/main. Copying it in would duplicate their
  work and conflict on merge.
- H9: `SEAT_CHANGE_REFUSALS` additions - `cashGameLobby.ts` is lane G's file.
- The VPIP row size on phones (8px @375) - Dan's masthead, left as reviewed.
- Nothing else in the lane is open.
