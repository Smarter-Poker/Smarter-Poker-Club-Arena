# Lane I - the cash game creation flow and its parity with the database

Audit swarm 2026-09-09, lane I. Worktree branch
`agent/cowork-mustmove/audit/must-move-classic-action-madness` (base 98ef24c6a1).
Nothing here was committed, pushed, or applied to production.

**Database correction.** The BRIEF names Supabase project `ydsaqnnuwyvtyxgvrnys`.
That project is `pepnationlab-prod` and has no `fn_cash_*` object at all
(`select count(*) from pg_proc where proname like 'fn_cash%'` returned 0 there).
Every live body below was read from `kuklfnapbkmacvwxktbh` (PokerIQ-Production,
the database CLAUDE.md names), and every probe ran there. Nothing in this report
treats the empty answer from the wrong database as evidence (CLAUDE.md 10.86).

## 0. Status of the work (final, 2026-09-09 23:45 UTC)

| item | state |
| --- | --- |
| Live bodies read (section 1) on the correct database | DONE |
| I1 (P1) rules step offered ante / bomb controls the server ignores | DONE, tested |
| I2 (P1) `GAME_EXISTS` copy lied for the band case | DONE: migration written and probed rolled back, copy written, tested |
| I3 (P1) a locked key that arrived DIFFERENT was silently ignored | DONE: same migration, probed |
| I4 (P1) two taps could create twice; a failed create left no clean retry | DONE, tested |
| I5 (P2) the stakes ladder offered rungs the club already holds | DONE, tested |
| I6 (P3) the flow's own brown palette | DONE (CSS), realism / hover / classNames laws green |
| I7 (P2) refusal-code parity, every live code has copy | DONE, pinned by a row-per-code test |
| I8 (P2) law test mock shaped like an old server | DONE |
| I9 (P2) `bombPotGuards` pinned the removed "Bomb Ante" slider | DONE, pin moved with its mechanism |
| I10 (P2) `reportError` rewrote the caller's error message, so an unknown failure toasted "[CashGameCreateFlow.create_failed] ..." | DONE (shared-file edit, section 8), tested |
| I11 (P3) stay-clock / rejoin tooltips and refusal copy hard-coded the floors | DONE: tooltips read the snapshot, copy reads the server's "the minimum is N" |
| Migration `20260909181309` probed rolled back on `kuklfnapbkmacvwxktbh` | DONE (section 5) |
| `npx tsc --noEmit` root, vitest on 21 files, the three copy gates | DONE, all green (section 6) |
| #ClubArenaConsole painted chassis (`SpadeConsole`) for the flow | BLOCKED, kit not on `origin/main` (section 7) |
| Idempotency key on `fn_cash_game_create` (a lost success response) | NOT DONE, Tier-3 SQL signature change, recorded (section 7) |

## 1. Files and functions read line by line

Repo (worktree):

* `src/components/cash/CashGameCreateFlow.tsx` (724 lines, all)
* `src/components/cash/CashGameCreateFlow.css` (171 lines, all)
* `src/config/cashGames.ts` (186 lines, all)
* `src/components/table-config/controls.tsx` (154 lines, all)
* `src/pages/TableConfigPage.tsx` - header, the access gate (470-500), the
  Regular tab render (1030-1170), the footer (1705-1728); grep for every
  `regular` / `CashGameCreateFlow` / `localStorage` / `draft` reference
* `src/components/cash/CashGameCard.tsx` - `rulesLineFor` (250-287)
* `src/config/blindsPresets.ts` (all), `src/lib/bettingStructure.ts` (`stakesLabel`, `isFixedLimitVariant`)
* `src/styles/club-engine.css` 1260-1420 (the `--realism-*` block)
* `src/pages/TableConfigPage.css` 115-175, 300-330, 795-870 (the controls' paint)
* `tests/cash-games-are-created-from-a-template.law.test.tsx` (all)
* `tests/unit/cashGamesVocabulary.test.ts` (all), `tests/unit/cashGameCard.test.tsx` (all)
* `tests/unit/bombPotGuards.test.ts` 785-830, `tests/unit/theCreateTableFormOffersOnlyLiveSwitches.test.ts` 25-200,
  `tests/a-control-that-says-none-must-mean-none.law.test.ts` 95-185, and the FLOW-reading
  lines of `variantSwitchesTellTheTruth`, `tableLifecycleSwitches`, `limitUserIntent`,
  `tableConfigSeatLawClamp`, `fixedLimitTableOffersOnlyWhatItHonours`,
  `theFormSaysWhatTheTableWillCharge`
* `tests/actionAndMadnessAreOnePerBand.law.test.ts` 1-110, `tests/realism-is-one-vocabulary.law.test.ts` 1-80
* `supabase/migrations/20260909035303_a_classic_game_has_no_antes_and_no_bombs.sql` (all)
* `docs/changelog/2026-09-09-a-classic-game-has-no-antes-and-no-bombs.md`,
  `docs/changelog/2026-09-05-action-and-madness-are-one-game-per-blind-category.md`
* `docs/audits/2026-09-09-must-move-audit/lane-C.md` (C1, C2, section 5-8)
* `.claude/skills/club-arena-console/SKILL.md` in the sibling
  `Smarter-Poker-Club-Arena` mount (sections 0-4) - it does not exist in this
  worktree or on `origin/main`

Live production (`pg_get_functiondef`, `kuklfnapbkmacvwxktbh`, 2026-09-09 ~18:05 UTC):
`fn_cash_template_defaults(text,text)`, `fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)`,
`fn_cash_game_create_impl_20260905(...)`, `fn_cash_override_int`, `fn_cash_override_bool`,
`fn_cash_game_floor_from_template`, `fn_guard_one_game_per_blind_category`,
`fn_cash_stake_band`, `fn_cash_stakes_label`, `fn_cash_money_text`, `fn_can_create_games`,
`fn_caller_session_is_live`, `fn_caller_is_engine`, `auth.uid`; `pg_indexes` and
`pg_trigger` for `cash_games`.

## 2. The live truth table (read, not assumed)

`fn_cash_template_defaults`:

| | classic | action | madness |
| --- | --- | --- | --- |
| holdem (nlh, flh) seats / choices | 9, `[9, 6]` | 6, `[2..9]` | 6, `[2..9]` |
| plo family (plo4/5/6/8, flo8) | 6 locked `[6]` | 6 locked | 6 locked |
| short_deck / pineapple | 6, `[2..8]` | 6, `[2..8]` | 6, `[2..8]` |
| min / max buy-in bb | 40 / 200 | 50 / 200 | 100 / 200 |
| regular_ante | none | sb | bb |
| vpip_floor / window | 0 / 10 | 30 / 10 | 50 / 10 |
| bombs | off (trigger, ante_bb, boards NULL) | on, timed_15m, 2 bb, 2 boards | on, every_orbit, 3 bb, 2 boards |
| stay_clock_min / rejoin_window_min | 10 / 120 | 10 / 120 | 10 / 120 |

`fn_cash_game_create` (wrapper): authenticated caller, `fn_caller_session_is_live`,
`CLUB_REQUIRED`, `fn_can_create_games` -> `NOT_AUTHORIZED: this club is managed by
its union`, then delegates to `fn_cash_game_create_impl_20260905`.

`fn_cash_game_create_impl_20260905`, in order: authenticated caller (no code,
ERRCODE 28000), `SESSION_REVOKED`, `CLUB_REQUIRED`, `NOT_AUTHORIZED` (impl also
accepts `is_club_admin`, which the wrapper never lets through - dead branch,
noted for lane C), `TEMPLATE_UNKNOWN`, `VARIANT_UNAVAILABLE` (nine ids),
`STAKES_INVALID` (sb > 0, bb > sb, both 2 dp, bb <= 100000, no NaN),
`OVERRIDE_INVALID: overrides must be an object`, defaults, `HANDEDNESS_INVALID`
(unless `seats_locked`, in which case p_handedness is ignored),
`BUYIN_BAND_INVALID` (min >= 1, max >= min, max <= 1000), ante / vpip / window
taken from the template with `ANTE_INVALID` / `VPIP_INVALID` /
`VPIP_WINDOW_INVALID` sanity checks that can only fire on the template's own
output, `OVERRIDE_INVALID: bombs must be an object`, bombs taken from the
template (`BOMB_TRIGGER_INVALID`, `BOMB_ANTE_INVALID`, `BOMB_BOARDS_INVALID`
likewise only on the template's output), `STAY_CLOCK_BELOW_FLOOR`,
`REJOIN_WINDOW_BELOW_FLOOR`, `CLOCK_TOO_LONG` (stay > 1440 or rejoin > 10080),
`OVERRIDE_INVALID: options must be an object`, `fn_cash_override_bool` /
`fn_cash_override_int` (`OVERRIDE_INVALID: <key> must be ...`), action time
clamped 10..120, the INSERT with `EXCEPTION WHEN unique_violation` rewritten to
`GAME_EXISTS: this club already runs <Template> <Variant> <the caller's stakes>`,
then `fn_cash_cluster_open_table`.

Uniqueness on `cash_games`: `cash_games_one_per_key (club_id, variant, sb, bb,
template_name) WHERE enabled AND must_move` and
`cash_games_one_per_band_action_madness (club_id, template_name, variant,
fn_cash_stake_band(bb)) WHERE enabled AND template_name IN ('action','madness')`,
plus the BEFORE trigger `zz_one_game_per_blind_category`, which raises
`ONE_GAME_PER_BLIND_CATEGORY: this club already runs <name> (<sb>/<bb>) as its
<Template> <band> game. Close it before opening another.` with ERRCODE
`unique_violation`. Bands: micro <= 0.5, low <= 2, mid <= 6, high.

## 3. Findings

### I1 (P1, player-visible wrong behaviour) - the rules step offered four controls the server ignores. FIXED

Evidence: `CashGameCreateFlow.tsx` 462-571 (before) rendered an "Ante Each
Dealt In Player" radio (none / sb / bb), a "Bomb Pots" `Toggle`, a "Bomb
Trigger" radio, a "Bomb Ante" `Slider` and a "Boards" radio, all writing
`overrides.regular_ante` / `overrides.bombs`, and `create()` sent them as
`p_overrides`. The live impl (section 2) reads `v_ante := v_def->>'regular_ante'`
and `v_bombs := coalesce(v_def->'bombs', '{}')` - the caller's values are never
read, and the only check on them is `jsonb_typeof(v_o->'bombs') <> 'object'`.
So a host set "One Big Blind" on a Classic game, the preview card (fed from
`overrides`) showed "1 BB Ante", the toast said Game Created, and the game had
no ante. The VPIP readout had already been converted on 09-07; the ante and
bombs had not.

Fix:
* `src/config/cashGames.ts` - `TEMPLATE_LOCKED_RULES` names the four keys;
  `CashGameOverrides` and `overridesFromSnapshot` no longer carry them;
  `templatePromiseLines(snapshot)` returns the three Title Case readouts (Ante,
  VPIP Floor, Bomb Pots) each ending "Set By The <Template> Template";
  `templateLabel()`.
* `src/components/cash/CashGameCreateFlow.tsx` - the five controls are replaced
  by a read-only `cash-create__promise` group (`role="group"`,
  `aria-readonly`, `data-testid="cash-create-promise"`) printed from the
  snapshot; the preview card's rules line takes ante / VPIP / bombs from the
  snapshot; the header comment says why.
* `src/components/cash/CashGameCreateFlow.css` - the readout rows are engraved
  rows on the glass (label, value, note, a rule between rows), no control.

### I2 (P1) - `GAME_EXISTS` named the wrong game for the band case. FIXED (SQL + copy)

Evidence: impl's handler `EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION
'GAME_EXISTS: this club already runs % % %', initcap(v_t), v_variant_label,
v_label` catches the trigger's `ONE_GAME_PER_BLIND_CATEGORY` (ERRCODE
unique_violation) and rewrites it with the CALLER's stakes. Probe 4 in section
5 shows it: opening Action NLH 0.50/1 in the fleet club, which runs `NLH 1/2
Action` (both `low`), the old text was "this club already runs Action NLH
0.50/1" - a game the club does not run. The trigger's own sentence, naming the
game to close, was swallowed. `cashGameCreateRefusalText` turned that into
"This Club Already Runs Action NLH 0.50/1. Join That Game Instead." - and there
is no such game to join.

Fix: migration `20260909181309` (section 5) re-raises the trigger's exception
untouched when that is what the handler caught, keeping `GAME_EXISTS` for the
exact-key index. `cashGameCreateRefusalText` parses
`ONE_GAME_PER_BLIND_CATEGORY` into "This Club Already Runs NLH 1/2 Action
(1.00/2.00) As Its Action Small Stakes Game. Close It Before Opening Another."
(`STAKE_BAND_LABEL`: micro / low / mid / high -> Micro / Small / Mid / High
Stakes, Dan's own words for the four bands).

### I3 (P1) - a locked key that arrived different was silently ignored. FIXED (SQL)

Evidence: section 2; 20260909035303 stopped READING the four keys but never
refused them, so any stale bundle or hand-built payload asking for a different
ante got a different game and an ok:true. Fix: the same migration adds, right
after the defaults are resolved, `OVERRIDE_LOCKED: <key> is set by the
<template> template (sent %, template %)` for `regular_ante`, `vpip_floor`,
`vpip_window`, and for `bombs` when `enabled` disagrees or (template bombs on)
trigger / ante_bb / boards disagree. A locked key echoed back EQUAL to the
template is accepted, so the bundle serving today (which still sends all four,
equal) keeps working; probe 2 proves it. Client copy: "The Regular Ante Is Set
By The Classic Template. Reload And Try Again."

### I4 (P1) - two taps in one tick could create two games. FIXED

Evidence: `create()` guarded on `busy === null` through `canConfirm`, which is
React state; two clicks dispatched before the re-render both close over
`busy === null` and both reach `supabase.rpc('fn_cash_game_create')`. For a
must-move game the second is refused by `cash_games_one_per_key`; for a
CLASSIC MANUAL table (unrestricted) it is a second game. Fix: `inFlight`
`useRef` set before the RPC and cleared in `finally`, so the second tap returns
before the call. A network failure mid-create therefore clears the guard and
re-enables both buttons, and the retry is one call.

### I5 (P2) - the stakes ladder offered rungs the club already holds. FIXED

The flow could not know the club's games, so a host picked Action NLH 1/2,
filled in every step, and was refused at Confirm. Fix: one `SELECT name,
template_name, variant, sb, bb, must_move FROM cash_games WHERE club_id = ...
AND enabled = true` (advisory; the database stays the authority; a read the
host's role cannot see leaves every chip enabled), `stakesRungTaken()` mirrors
the two refusals (band for Action/Madness, exact key for must-move), a taken
chip is disabled with the reason as its `title` and `data-taken`, a chosen row
that becomes taken un-picks itself, "Use The Usual Stakes" lands on the nearest
open rung, and the ladder is re-read after a `GAME_EXISTS` /
`ONE_GAME_PER_BLIND_CATEGORY` refusal. Lane C moved the A1.1 pin from the
table to the verb for this read (their report, section 7).

### I6 (P3) - the flow carried its own brown palette. FIXED

`CashGameCreateFlow.css` used `rgba(38,24,8)` wells, `#ff9e2c` rims and
`#d9c9a8` / `#b8a888` copy - an amber-to-brown ramp, which is both the ninth
private palette `tests/realism-is-one-vocabulary.law.test.ts` exists to stop
and the colour Dan's console law forbids ("NO BROWNS OR PINKS"). Every colour
now comes from the `--realism-*` tokens `club-engine.css` defines once: gunmetal
edges with a lit bevel over a cavity, chrome labels, cyan selection, muted
notes; `:active` / `:focus-visible` feedback, no `:hover`. The chip override
carries an ancestor for specificity so it wins whatever order the two sheets
bundle in and the tournament tab's chips keep their dress.

### I7 (P2) - refusal-code parity. VERIFIED, two codes added

Every code the live impl and wrapper can raise, against `cashGameCreateRefusalText`:

| code (live body) | house copy |
| --- | --- |
| `requires an authenticated caller` (no code) | "Sign In To Create A Game" (ADDED) |
| `SESSION_REVOKED` | Your Session Is Signed Out. Sign In Again. |
| `CLUB_REQUIRED` | This Screen Needs A Club |
| `NOT_AUTHORIZED` | You Cannot Create Games In This Club |
| `TEMPLATE_UNKNOWN` | Pick A Template First |
| `VARIANT_UNAVAILABLE` | This Variant Is Not Available Yet |
| `STAKES_INVALID` | Those Stakes Are Not Valid |
| `OVERRIDE_INVALID: <key> ...` | The <Key> Setting Is Not Valid |
| `HANDEDNESS_INVALID` | That Table Size Is Not Offered For This Game |
| `BUYIN_BAND_INVALID` | The Buy In Range Is Not Valid |
| `ANTE_INVALID` | The Ante Setting Is Not Valid |
| `VPIP_INVALID` / `VPIP_WINDOW_INVALID` | (both present) |
| `BOMB_TRIGGER_INVALID` / `BOMB_ANTE_INVALID` / `BOMB_BOARDS_INVALID` | The Bomb Pot Settings Are Not Valid |
| `STAY_CLOCK_BELOW_FLOOR` / `REJOIN_WINDOW_BELOW_FLOOR` | (floor wording, pinned) |
| `CLOCK_TOO_LONG` | The Stay Clock Or Rejoin Window Is Too Long |
| `GAME_EXISTS` | This Club Already Runs <x>. Join That Game Instead. |
| `ONE_GAME_PER_BLIND_CATEGORY` (trigger, passes through after 181309) | ADDED, section I2 |
| `OVERRIDE_LOCKED` (181309) | ADDED, section I3 |

Not covered, deliberately: whatever `fn_cash_cluster_open_table` raises (lane A/C
territory) surfaces as the server's own message through the existing
`refusal ?? serverMessage` path, which the none-must-mean-none law pins.

### I10 (P2) - `reportError` rewrote the caller's error, so a host read a stack-trace prefix. FIXED (shared file)

Evidence: the I4 test's first run. The flow reports an unknown failure
(`reportError(err, 'CashGameCreateFlow.create_failed')`) and then, by the
none-must-mean-none law, toasts `err.message` so the host reads the server's
own sentence. The toast received `"[CashGameCreateFlow.create_failed] Failed
to fetch"`. `src/utils/errorReporter.ts` carried a paragraph saying "Copy
rather than mutate ... the caller's error object is left alone, which it
should have been from the start" directly above `try { err.message = prefixed }
catch { copy }` - it mutated every error that allowed it and copied only the
DOMException that did not. Every caller on the platform that reports and then
displays (`reportError` is imported by 20+ services) showed the bracketed
context to a player.

Fix: the copy is unconditional (`new Error(prefixed)` with the original name
and stack); the caller's object never changes. Surgical, 6 lines, in a shared
file - the integrator should know. Test:
`tests/unit/reportErrorLeavesTheCallersErrorAlone.test.ts` (plain Error,
DOMException, Supabase-shaped object) plus the flow test's toast assertion.

### I11 (P3) - floors restated as literals. FIXED

The two clock tooltips said "Ten Minutes Is The Minimum." / "Two Hours Is The
Minimum." while the slider floor came from the snapshot; the refusal copy said
"Above 10 Minutes" / "Above 120 Minutes" while the server's message says "the
minimum is N". Tooltips now print `snapshot.stay_clock_min` /
`snapshot.rejoin_window_min`; the copy reads N back from the message and keeps
the literal as the fallback (the law test pins the literal wording as a floor).

### Residual, recorded, not fixed - a lost SUCCESS response

If `fn_cash_game_create` commits and the response is lost on the wire, the
flow shows the failure, the host retries, and for a must-move game the second
call is refused (`GAME_EXISTS` / `ONE_GAME_PER_BLIND_CATEGORY`) - after which
the ladder re-reads and the rung greys, so the host sees the game exists. For
a CLASSIC MANUAL table, which the database does not de-duplicate, the retry
creates a second table. Closing that needs an idempotency key on the function
signature (a new parameter), a Tier-3 SQL change on a function two other lanes
are near; it is recorded here rather than bolted on. The double-tap half of the
same problem (I4) is closed.

### What was checked and found correct (no change)

* Six steps in OPORD order: template, variant, mode, stakes, handedness,
  overrides; each waits on the one before (law test pins it).
* Defaults are re-fetched on every template or variant change (`useEffect` on
  `[template, variant]`, with a `live` flag so a stale answer cannot land).
* One `fn_cash_game_create` call for Save and for Start; Start additionally
  wakes the engine with `getTableState` and navigates to the felt.
* Seat choices come from `snapshot.seat_choices` / `seats_locked`, never from
  the file; the live table in section 2 is what renders. The "6-Max Is Locked
  For Omaha Games" note fires on `seats_locked`, which the live function sets
  only for the plo family.
* Variant chips: `CASH_VARIANTS` = the nine ids = engine `KNOWN_VARIANTS` = the
  live `VARIANT_UNAVAILABLE` list (vocabulary test pins the first two; the live
  body read today lists the same nine).
* Stakes presets: all twelve rows of `BLINDS_PRESETS` satisfy `STAKES_INVALID`
  (sb > 0, bb > sb, two decimals, bb <= 100000); the limit ladder is the subset
  with bb = 2 sb.
* Buy-in sliders: min 10..400 step 10, max 40..1000 step 10, each clamped to the
  other - inside `BUYIN_BAND_INVALID` (1 <= min <= max <= 1000).
* Stay clock / rejoin window: slider `min` IS `snapshot.stay_clock_min` /
  `snapshot.rejoin_window_min` (10 / 120 live), maxima 60 / 720 are inside
  `CLOCK_TOO_LONG` (1440 / 10080).
* Action time 10..60 inside the SQL clamp 10..120 (none-must-mean-none law).
* Price panel: `getRakeConfig(bb, variant, sb, {RAKE_INHERIT, RAKE_INHERIT})`,
  the BBJ line says "No Bad Beat Jackpot On This Game" when the schedule has
  none - no invented copy.
* Hostile state: there is NO localStorage draft in the cash flow (the
  `ca_saved_start_time_<club>` key belongs to the tournament tabs and is never
  read here); all cash state is React state that resets with the route. A club
  without create rights: `canBuildHere` false disables Save and Start and
  prints `deniedMessage`; the server's `NOT_AUTHORIZED` has copy regardless.
* `TableConfigPage.tsx` Regular tab is a thin mount of the flow with the
  access gate; it writes nothing for cash (`handleSave` / `handleStart` return
  on `gameMode === 'regular'`).

## 4. Dead code, stubs, stale pins found

* `fn_cash_game_create_impl_20260905`'s `OR public.is_club_admin(...)` in the
  authorisation check is unreachable: the wrapper `fn_cash_game_create` refuses
  on `fn_can_create_games` alone first. Not changed (lane C owns the
  authorisation surface); recorded.
* `overridesFromSnapshot` filled in bomb `trigger` / `ante_bb` / `boards` for
  classic (`'timed_15m'`, 2, 2) so the controls had something to show - dead
  with the controls, removed.
* `tests/unit/bombPotGuards.test.ts` 797-801 pins a "Bomb Ante" slider in the
  flow with `step={1}` - a pin on the removed lie (I9, to move).
* Law test `defaults()` mock: `vpip_window: 40`, madness `vpip_floor: 30`,
  action holdem `seat_choices: [2..8]` - the live function says 10, 50, [2..9]
  (I8, to correct).

## 5. Migration `20260909181309` and its probe

File: `supabase/migrations/20260909181309_a_locked_rule_is_refused_not_ignored_and_a_band_refusal_names_the_holder.sql`.
One `BEGIN` / `COMMIT`; reasoning header (CLAUDE.md 10.9); an anchored literal
edit of the LIVE `fn_cash_game_create_impl_20260905` body (same method as
20260909035303): each of the two anchors must occur exactly once, the result
must still carry every sibling guard by name and the two template-sourced
assignments, and it is idempotent (both edits present -> NOTICE, no-op). A
separate post-apply `DO $assert$` reads the function back through the
catalogue and refuses to commit unless both edits and the template-sourced
ante assignment are in the live body.
Ordering: it touches ONLY `fn_cash_game_create_impl_20260905`, which no other
migration in this audit (181230 / 181259 / 181632 / 181642 / 181653 / 181704 /
191454) rewrites, so it sits anywhere in the serial order; version order
(after 181259, before 181632) is fine. No new schema object, so no
`schema-manifest.d` fragment.

Probe: ONE `execute_sql` call on `kuklfnapbkmacvwxktbh` containing the
migration's `DO $migration$` block followed by a `DO $probe$` that set
`request.jwt.claim.sub` to the fleet club's owner (`fade0000-...-0001` /
`47965354-...`) for the transaction, called the impl five times, and ended in
`RAISE EXCEPTION` so the whole call aborted. The error text returned was:

```
PROBE ROLLED BACK. results:
1 OVERRIDE_LOCKED: regular_ante is set by the classic template (sent bb, template none)
2 ok=true ante=none bombs=false
3 OVERRIDE_LOCKED: bombs is set by the action template (sent {"boards": 2, "ante_bb": 2, "enabled": false, "trigger": "timed_15m"}, template {"boards": 2, "ante_bb": 2, "enabled": true, "trigger": "timed_15m"})
4 ONE_GAME_PER_BLIND_CATEGORY: this club already runs NLH 1/2 Action (1.00/2.00) as its Action low game. Close it before opening another.
5 GAME_EXISTS: this club already runs Classic FLH 0.25/0.50
```

1 = classic with `regular_ante: bb` refused by name; 2 = classic echoing every
locked key back EQUAL (the old bundle's exact payload shape) accepted, game
resolved with no ante and no bombs; 3 = action with bombs switched off refused;
4 = the band trigger's own sentence reaches the caller; 5 = the exact-key index
still says `GAME_EXISTS`. Afterwards
`position('OVERRIDE_LOCKED' in pg_get_functiondef(impl))` = 0 and
`count(*) from cash_games where name like 'probe %'` = 0: nothing persisted.

A second probe, after the post-apply assertion block was added to the file
(23:42 UTC; the `DO $migration$` in the probe is byte-identical to the file,
md5 `7cf419fe4d26b75e23460254b101f737` both sides), ran the migration block,
then the assertion block, then two more cases, and rolled back the same way:

```
PROBE ROLLED BACK (full file body incl. post-apply assertion). results:
6 OVERRIDE_LOCKED: vpip_window is set by the madness template (sent 40, template 10)
7 ONE_GAME_PER_BLIND_CATEGORY: this club already runs NLH 1/2 Action (1.00/2.00) as its Action low game. Close it before opening another.
```

6 = a lone `vpip_window: 40` (the old law-test mock's value) refused by name;
7 = a stale bundle echoing EVERY locked key equal on an Action game passes the
guard and reaches the band trigger's sentence, which now arrives intact. The
assertion block raised nothing, i.e. it read both edits back off the catalogue
inside the transaction. Live body afterwards: `OVERRIDE_LOCKED` position 0,
zero `probe %` rows.

A first attempt at the probe set `request.jwt.claims` with `role:
'authenticated'` and got `SESSION_REVOKED` five times - `fn_caller_is_engine`
reads `auth.role()`, and a NULL role is the engine / migration context. The
second attempt set only `request.jwt.claim.sub`, which is what the scoreboard
above came from.

## 6. Commands run and their tails (host terminal, nohup + poll)

```
npx vitest run tests/cash-games-are-created-from-a-template.law.test.tsx \
  tests/unit/cashGamesVocabulary.test.ts tests/unit/cashGameCard.test.tsx \
  tests/unit/bombPotGuards.test.ts tests/a-control-that-says-none-must-mean-none.law.test.ts \
  tests/unit/theCreateTableFormOffersOnlyLiveSwitches.test.ts tests/unit/variantSwitchesTellTheTruth.test.ts \
  tests/unit/fixedLimitTableOffersOnlyWhatItHonours.test.ts tests/unit/classNamesResolve.test.ts \
  tests/no-hover-effects.law.test.ts tests/realism-is-one-vocabulary.law.test.ts \
  tests/unit/tableLifecycleSwitches.test.ts tests/unit/limitUserIntent.test.ts \
  tests/unit/tableConfigSeatLawClamp.test.ts tests/unit/theFormSaysWhatTheTableWillCharge.test.ts \
  tests/unit/discardedErrorReadRatchet.test.ts tests/unit/reportErrorLeavesTheCallersErrorAlone.test.ts \
  tests/actionAndMadnessAreOnePerBand.law.test.ts tests/unit/theTemplateIsTheWholeGame.test.ts \
  tests/unit/vpipFloorIsTheTemplates.test.ts tests/law-registry.law.test.ts
  -> Test Files  21 passed (21)      Tests  639 passed (639)

npx vitest run tests/unit/reportErrorLeavesTheCallersErrorAlone.test.ts \
  tests/unit/productionConsoleErrorPolicy.test.ts tests/unit/buyInModalConfirmationFailure.test.tsx \
  tests/unit/criticalAlertsAreNeverTruncated.test.ts
  -> Test Files  4 passed (4)        Tests  237 passed (237)

npx vitest run tests/unit/migrationVersionUniqueness.test.ts \
  tests/a-migration-version-is-reserved-not-guessed.law.test.ts tests/no-band-aids.law.test.ts \
  tests/unit/theCopyRulesReachTheEngineAndTheDatabase.test.ts tests/appliedMigrationsRecordedIndex.test.ts
  -> Test Files  5 passed (5)        Tests  49 passed (49)      (the migration file passes the repo's migration laws)

node scripts/ci/check-title-case.mjs        -> EXIT:0
node scripts/ci/check-ui-text.mjs           -> EXIT:0
node scripts/ci/check-painted-text-case.mjs -> EXIT:0

npx tsc --noEmit  (root, whole tree including the other lanes' edits)
  -> no diagnostics, TSC_EXIT:0
```

Two intermediate runs are worth recording. The first run of the lane's tests
failed 4: the I10 prefix (a real defect, fixed), an exact-text query that
matched two nodes (test corrected to count the four "Set By The Classic
Template" strings), one copy row I had written against the wrong wording, and
`bombPotGuards` line 705 - which failed on ANOTHER lane's edit: the engine's
refresh select was widened past `bomb_pot_manual_pending'`, so the pin on the
list's closing quote broke. I moved that pin one character (`['|,]`) because
the column being read is what it guards, not the end of the list; the
integrator should know that line is touched. The second-to-last run failed 7
after I changed the Table Mode blurb to say "Action And Madness Run One Per
Blind Band": `getByRole('button', { name: /Action/ })` then matched the mode
card too. The selectors are anchored (`/^Action/`) now.

`git diff --stat` for the lane:

```
 src/components/cash/CashGameCreateFlow.css         | 175 ++++++++---
 src/components/cash/CashGameCreateFlow.tsx         | 295 +++++++++---------
 src/config/cashGames.ts                            | 205 +++++++++++--
 src/utils/errorReporter.ts                         |  22 +-
 tests/cash-games-are-created-from-a-template.law.test.tsx | 330 ++++++++++-
 tests/unit/bombPotGuards.test.ts                   |  24 +-
 tests/unit/cashGamesVocabulary.test.ts             | 212 +++++++++++++
 new: tests/unit/reportErrorLeavesTheCallersErrorAlone.test.ts
 new: supabase/migrations/20260909181309_a_locked_rule_is_refused_not_ignored_and_a_band_refusal_names_the_holder.sql
 new: docs/audits/2026-09-09-must-move-audit/lane-I.md
```

## 7. What could not be done, and why

* **The painted `#ClubArenaConsole` chassis.** `SpadeConsole.tsx/.css` and
  `public/assets/club-buttons/console/spade-console-v1/*` exist only on the
  unmerged branches `feat/spade-console-waitlist-rules-buyin-confirm` and
  `agent/cw-dailybonus/feat/console-pages`; they are not on `origin/main`
  (verified with `git ls-tree origin/main`) and the skill file that governs
  them is not in this repo. Copying the kit into this lane would put the same
  assets on two branches ("NOTHING CAN BE COPY PASTED") and make the flow depend
  on art nobody has merged. So the flow keeps the shared create-form chassis
  (`config-*` classes every create surface uses) and is brought onto the ONE
  written vocabulary main does have (`--realism-*`, section I6). Rebuilding the
  template cards, chips and footer plates on `SpadeConsole` is a follow-up for
  after that branch merges.
* **The wrapper / impl authorisation asymmetry** (section 4) is recorded, not
  changed: lane C owns `fn_cash_game_create`'s authorisation surface.
* **An idempotency key for a lost success response** (section 3, residual):
  needs a new parameter on `fn_cash_game_create`; Tier 3, not started.
* **No browser or headless render of the rebuilt step.** Every claim about the
  rules step is from the DOM assertions in the law test (the readouts render
  with no `input`/`button`/`select` inside the group; the chips carry
  `disabled`, `title` and `data-taken`). The before/after shots the console
  standard asks for were not taken, because the standard's kit and harness are
  not on this branch.

## 8. Shared files touched (for the integrator)

* `src/utils/errorReporter.ts` - the unconditional copy (I10). Six lines in
  the prefixing block; nothing else in the file. Imported by 20+ services;
  the change only stops them from having their error mutated.
* `tests/unit/bombPotGuards.test.ts` - two pins: my own (the removed "Bomb
  Ante" slider, moved to the SQL bounds) and one character on line ~709 for
  another lane's widened engine select (section 6).
* `tests/cash-games-are-created-from-a-template.law.test.tsx` - lane C's
  `from` mock and moved A1.1 pin are kept as they left them; my additions are
  the corrected `defaults()` mock and the five new `describe` blocks at the
  foot of the file.
* Nothing in `lobbyEntries.ts`, `CashClusterHUD`, `MustMoveLobbyModal`,
  `TablePage`, `MultiTablePage`, `ServerTableEngineBase.ts` or
  `fn_cash_cluster_tick` was touched by this lane.

---
Last updated 2026-09-09 23:45 UTC. Nothing committed, pushed or applied.
