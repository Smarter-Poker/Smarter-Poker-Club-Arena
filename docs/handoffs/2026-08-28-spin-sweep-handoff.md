# SPIN & SEAT-FIRST SWEEP — FULL HANDOFF

**Written:** 2026-08-29 00:45 UTC (2026-08-28 19:45 CDT)
**Author:** Cowork/Claude session `cowork-spin`
**Repo:** `Smarter-Poker/Smarter-Poker-Club-Arena`
**Worktree used:** `~/Documents/.agent-trees/club-arena/cowork-spin`
**Last shipped:** PR #1702, merged `2026-08-29T00:19:36Z`, published as `ca_sha 575f14b1c6be66b0230cd1ea7784ed9bade4a669` at `00:30:30Z`

Read this file top to bottom before touching anything. Section 9 is the list of
things that are **not** done — that is the part you are being handed.

---

## 0. HOW TO PICK THIS UP (exact commands)

### 0.1 Read these first, in this order

1. `.agents/rules/00-agent-playbook.md` — **the binding rule set.** RULE 1
   (VERIFICATION PASS, Parts A–E), RULE 2 (worktrees only), RULE 5 (never ask
   the human to run a command), RULE 7 (fix your own build), RULE 8
   (Zero-Assumption Doctrine). This is the file that governs. Note there is a
   SECOND file, `AGENT-PLAYBOOK.md` at the repo root — I used that one for the
   first several rounds and it is not the same document. Use `.agents/rules/`.
2. `CLAUDE.md` in this repo — §10.5 HORSES ARE PLAYERS, §10.6 ANIMATION LAW +
   NO AUTO TABLE SWITCHING, §11.5 NEVER SPEND REAL CHIPS TO TEST A RULE, §12
   never rebase main, §5.7 popup Title Case with no em dashes.
3. The eight changelogs from this sweep, listed in §3.

### 0.2 Environment

**All git and `gh` work must run on the HOST shell**, not the sandbox. The
sandbox mount at `/sessions/*/mnt/` **cannot unlink files**, so any git command
that takes a lock strands a `.git/index.lock` that then blocks git on the Mac
itself. Use `mcp__counselors__host_terminal` and prefix every command:

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-spin
```

Supabase production is reachable via the Supabase MCP (`execute_sql`,
`apply_migration`) against project `kuklfnapbkmacvwxktbh`. Use it. Do not ask
Dan to paste SQL anywhere.

### 0.3 Start a fresh branch — do not reuse mine

My branches are all merged and squashed; local commits no longer match main.

```bash
git fetch origin main
git checkout -B agent/cowork-spin/fix/<slug> origin/main
```

**Never `git pull --rebase origin main`.** `.husky/pre-rebase` refuses it and
the refusal is correct (CLAUDE.md §12). Fetch + fast-forward, or
`bash scripts/git-unstick.sh`.

### 0.4 Ship

```bash
npx tsc --noEmit                 # client, must be 0
cd server && npx tsc --noEmit    # server, must be 0
npx vitest run tests/            # client suite
cd server && npx vitest run      # server suite
git add -A
git -c user.name="Smarter-Poker" \
    -c user.email="254329056+Smarter-Poker@users.noreply.github.com" \
    commit -m "..."
git push -u origin HEAD
gh pr create --fill --base main
gh pr merge <n> --squash --auto
```

Author identity is enforced (CHECK 15): a commit Vercel cannot attribute goes
to **BLOCKED** with no build logs at all. `--no-verify` is FORBIDDEN (RULE 4).

**`gh pr view --json statusCheckRollup` FAILS on this repo** with "Resource not
accessible by personal access token". Read check results with
`gh run list --branch <branch>` and `gh run view <id> --json jobs` instead.

### 0.5 Confirm it published — merging is not shipping

Merging to `club-arena` main triggers `.github/workflows/build-for-world-hub.yml`,
which runs the FULL client suite (that job is the publish gate — a red test
stops publishing for the whole estate), builds, and commits the bundle into
`Smarter-Poker-World-Hub`, which triggers Vercel on project `hub-vanguard`.

```bash
curl -s "https://smarter.poker/hub/club-arena/build-info.json?cb=$(date +%s)"
```

`ca_sha` must equal your merge commit on main. Nothing else counts as published.
Total observed latency merge → live: **~11 minutes** (00:19:36 → 00:30:30).

---

## 1. WHAT DAN ASKED FOR (verbatim, in order)

1. _"INSIDE THE SPIN, ALL THE BUTTONS ARE 'EMPTY' INSTEAD OF THE + BUTTON AND
   ABLE TO SIT DOWN TO PLAY. THE 'PLAYER ALREADY SITTING' SAYS 'SPECTATING'
   THEY AREN'T SPECTATING IF THEY ARE REGISTERED. I'M ALSO GETTING MESSAGES ON
   THE BOTTOM THAT 'THIS TABLE IS NO LONGER OPEN' YOU SAID YOU ALREADY FIXED
   THIS AND AUDITED EVERYTHING... GET MY SPINS UP AND RUNNING, FIX ANY AND ALL
   GLITCHES AND CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR
   WIRING ISSUES ANYWHERE AND EVERYWHERE."_
2. _"finish up everything thats still pending and not finished OR STILL NEEDS TO
   BE FIXED, IMPROVED, ENHANCED OR OPTIMIZED STILL... MAKE SURE EVERYTHING WAS
   UPDATED, PUSHED AND PUBLISHED. go through it all line by line, check for any
   bugs, stubs, gaps, errors, regressions or wiring issues... then find any and
   all ways to improve, enhance and upgrade this page and functionality to the
   max."_ — repeated **four** times across the session.
3. Numbered list: **(1)** remove the legacy client horse path; **(2)** build the
   `spin_chips` / `spin_button` reveal animations; **(3)** fix stale
   `SPIN_FREQ_DENOMINATOR`; **(4)** _"every single time i try to sit down at a
   spin, every single one disappears from the spins lobby. and you can't sit or
   register for one... do a deep dive and audit whats broken"_; **(5)**
   _"REMOVE ANY 'HOVER EFFECT' FROM THE SPINS LOBBY."_
4. _"ALSO IN SPINS, ITS A TOURNAMENT, SO THE 'SHOW CARDS' POP UP SHOULD NEVER
   EVER APPEAR, ALL CARDS ARE ALWAYS SHOWN AT SHOWDOWN."_
5. _"AND ON MTT'S SPINS AND HEADS UP TABLES UNDER THE 2ND LINE, A 3RD LINE
   SHOULD APPEAR WITH THE AMOUNT OF TIME LEFT IN THE ROUND (COUNT DOWN CLOCK)"_
6. A full compliance audit against `.agents/rules/00-agent-playbook.md`, with
   raw terminal output for RULE 1 Parts A–E and an explicit Hostile State &
   Cache proof.
7. _"You have all the credentials, check the .env or use cli to push and publish
   everything."_

**Standing preferences that shaped every fix:** never call AI players "bots"
(they are **horses**); mobile-first at 375px; no emoji in source; popups in
Title Case with **no em dashes**; never ask permission for obvious work.

---

## 2. THE ARCHITECTURE YOU ARE WORKING IN (so you don't rediscover it)

**Seat-first games** are Spins (3 seats) and Heads-Up SNGs (`max_players <= 2`).
The canonical test, used by the database and every correct surface, is:

```
variant = 'spin' OR max_players <= 2
```

For these, **the seat IS the entry**. There is no separate registration step.
`fn_take_seat_and_buy_in` is the only sanctioned path — it reserves the seat and
takes the money atomically. `classifyTournament` will call anything with
`max_players <= 10` an `'sng'`, which is **not** the seat-first rule; a 6-max or
9-max SNG is a registration game and must fall through to the MTT path. Sending
one down the seat-first path gets `not_a_seat_first_game` from the RPC: the
player is navigated to a table whose seats are inert, never registered and never
charged. That bug was live and is fixed (#1702 area, `GameLobbyPanel`).

**Refund paths differ by seat type** (CLAUDE.md §11.5, corrected 2026-08-26):

| Seat type            | Refund path                             | Settles into                |
| -------------------- | --------------------------------------- | --------------------------- |
| Tournament           | `fn_leave_seat_and_refund(table_id)`    | `club_members.chip_balance` |
| Cash, explicit leave | Hetzner engine cash-out                 | `club_members.chip_balance` |
| Cash, tab close      | `player_leave_table(table_id, user_id)` | `club_members.chip_balance` |

`fn_leave_seat_and_refund` is **tournament-only** — call it on a cash table and
it returns `{"ok": false, "reason": "table_not_found"}` and refunds nothing.
`public.wallets` is a DEAD pool (732,591,994.33 chips frozen since 2026-08-21);
nothing reads it. Any money path writing there is broken.

**Which table is the game:** `fn_tournament_primary_table(tournament_id)` —
occupancy first, oldest to break the tie, identical to the engine's own choice.
The client wrapper is `TableService.resolveTournamentLiveTable`. The old
"newest non-closed table" answer is wrong whenever a duplicate exists: players
sit on the FIRST table and the empty duplicate is NEWER (measured 2026-08-24 —
12 of 28 blocked seat-first games had an empty table outranking the one holding
every player).

---

## 3. WHAT SHIPPED — ALL EIGHT PRs, MERGED AND PUBLISHED

Every one is MERGED. Each has a changelog under `docs/changelog/`.

### PR #1602 — `fix(spins): pre-start tables are live and honest, and full spins start in 5s not 60`

Merged 08:48:10Z. Files: `server/src/GameServer.ts` (+207/−94), `src/pages/TablePage.tsx` (+185), `src/pages/ClubHomePage.tsx` (+40).

- **The 60-second start.** `GameServer` only noticed a filled seat-first game on
  its slow `discoverTournaments` tick. Extracted `readSeatFirstPaidSeats()` and
  added `discoverSeatFirstStarts()` as a **5-second fast lane**, summing seats
  across duplicate live tables (`seatsByTournament`) with an in-tick
  `tournamentEngines.has()` re-check so two ticks cannot double-start.
  **Measured effect: fill→start p50 went 61.2s → 4.8s.**
- **"This Table Is No Longer Running" (the 4404 toast).** Suppressed while a
  seat-first table is pre-start, via `seatFirstOpenRef`. Same ref silences the
  `Heartbeat_lost` telemetry and the WebSocket auto-reload failsafe, which were
  firing on a table that had legitimately not started yet.
- **Pre-start roster live-sync.** Realtime on `table_seats` filtered
  `table_id=eq.${tableId}`, plus a 10s poll and a tournament-status channel,
  rebuilding `players` from the DB. **It deliberately never writes `heroSeat`** —
  that reconciliation belongs to the authoritative snapshot only.

> **NOTE for the next agent:** the helpers in `GameServer.ts` are placed AFTER
> `discoverTournaments` **on purpose**. `engineStartBudget.test.ts` slices source
> between `discoverCashTables` and `discoverTournaments`; moving them breaks it.

### PR #1618 — `fix(spins): the client horse loader is banned from tournament tables`

Merged 16:55:23Z. First, narrower cut at the horse problem. Later superseded by #1690, which deleted the loader outright; the test added here (`horseLoaderNeverTouchesTournaments.test.ts`) was deleted in #1690 because it guarded a loader that no longer exists.

### PR #1642 — `fix(spins): seat-first enters through its table everywhere, plus pre-start polish`

Merged 17:49:59Z. Files: `ClubHomePage.tsx`, `TablePage.tsx`, `LobbyTable.tsx`, `HydraService.ts`, `TableService.ts`, 2 test files.

- Added `onSpinJoin` to `lobbyCtx`; `handleRegister` reroutes seat-first rows to
  `spinQuickJoin` instead of the registration modal (**this is what stopped the
  lobby charging a spin before the player picked a seat**).
- Added `TableService.resolveTournamentLiveTable`.
- **⚠ This PR introduced the CRITICAL bug fixed in #1702** — see §4.

### PR #1646 — `fix(spins): no hand means no cards, and a finished game keeps no seats`

Merged 18:43:51Z. Files: `SeatSlot.tsx`, `TablePage.tsx`, **migration**, `supabase-schema-manifest.json`, test.

- **Phantom card fans.** `SeatSlot` gained `handInPlay?: boolean` (defaults
  `true`), gating the villain card fan, with escape hatches for `holeCards`,
  `all_in`, `isDealing`, `isFolding`, `isMucking`. Added to the memo comparator.
  Fed by `handInPlay={tableState.isHandInProgress || (tableState.handNumber ?? 0) > 0}`.
- **MIGRATION `20260828g_no_live_seat_on_a_finished_game.sql` — APPLIED TO
  PRODUCTION.** A `BEFORE INSERT OR UPDATE` trigger stamping `left_at` on any
  seat that would be live on a `COMPLETED`/`CANCELLED` tournament. **It never
  refuses a write** — a guard that can refuse a seat exit can strand a player
  mid-hand. Includes a backfill and post-apply assertions.
  **Effect: ghost seats 26 → 0 (191,176 chips freed).**
- CI CHECK 17 (`check-migrations-applied.mjs`) requires the new function in
  `scripts/ci/supabase-schema-manifest.json`. I forgot this and the PR went red
  reporting it as "TypeScript Check". **If a PR fails and the message doesn't
  match the job name, check CHECK 17 first.**

### PR #1666 — `fix(spins): exits that work, recovery that turns back on, honest money, and the stale bundle`

Merged 21:48:45Z. Files: `GameServer.ts`, `TournamentManagerBase.ts`, `TournamentRecurringService.ts`, `App.tsx`, `GameLobbyPanel.tsx`, **new** `useShellUpdateGate.ts`, `TablePage.tsx` (+277), test.

- **`handleLeaveTable` now routes seat-first holders to
  `fn_leave_seat_and_refund` first**, before the engine-first
  `tableService.leaveTable`. Previously a seat-first player leaving got no
  refund. Both exit paths now also clear `setPendingSeat(null)` and
  `setSeatFirstConfirm(null)`.
- **Footer branch guard** so a paid seat is not shadowed by "Spectating":
  `!(seatFirstBuyIn && tableState.heroSeat > 0) ? (` — **this is Dan's original
  "THEY AREN'T SPECTATING IF THEY ARE REGISTERED" complaint.**
- **`accountBalance` made `useState<number | null>(null)`**; local deltas
  preserve null. (The last consumer still printing a false `0` was fixed in
  #1702.)
- **The stale bundle.** `public/sw-bus.js` serves the app shell CACHE-FIRST, so
  Dan was reading old code and reporting fixed bugs as live — this is why two
  of my findings looked wrong. New `useShellUpdateGate` listens for
  `SHELL_UPDATED` and `controllerchange` and reloads **only** when: not at a
  `/table/` route, tab visible, after `SETTLE_MS = 3000`, guarded by
  `RELOAD_COOLDOWN_MS = 10 min` in sessionStorage plus a once-per-mount disarm.
  Exports `isAtTable`, `mayReloadForShell`. Called once in `src/App.tsx`.
- **Server:** paid-gate roster read error now stands down
  (`spin_paid_roster_unreadable`) instead of proceeding on a partial roster;
  `p_seats: SPEC_SPIN_SEATS` (was `current_players`, which under-provisioned);
  unpaid seat release plus `fn_sync_seat_first_player_count`; `creditSeatStacks`
  reports read errors.

### PR #1690 — `fix(spins): tournament showdowns face up, no lobby hover, no client horses, round clock on line 3`

Merged 23:07:11Z. Files: 14, including both `spinSpec.ts` mirrors, `HandController.ts`, `ServerTableEngineDealing.ts`, `types.ts`, `TableModalsLayer.tsx`, `TablePage.tsx` (+72/−157), `HydraService.ts` (+28/−77).

- **Show Cards popup never appears in a tournament.** Two halves in two
  processes: client `TablePage` refuses to open `HandReveal`
  (`!tableStateRef.current.isTournament` inside the
  `ASK_TO_SHOW_ON_UNCONTESTED_WIN` condition), and `TableModalsLayer` refuses to
  render it (`{showHandRevealModal && tableId && !isTournament && (`). Server
  side, `HandController.applyShowdownRevealRules` gained
  `if (this.config.isTournament) return;` placed **before**
  `if (this.allInShowdownLocked) return;` so the whole muck branch is skipped.
  Plumbed by `isTournament?: boolean` on `HandConfig` (`types.ts`) and
  `isTournament: this.isTournamentTable(),` in `ServerTableEngineDealing`.
- **Client horse loader DELETED** (~150 lines: `horsesLoadedRef`,
  `horseMapRef`, `populateHorsePlayers`, the `HydraService.seedTable` call),
  replaced by an explanatory comment. `HydraService.seedTable` now **refuses on
  every table, cash included**, reporting
  `HydraService.seedTable_refused_client_seating` and returning `[]`; the dead
  body was deleted, no unreachable code. **The server fleet owns horses.**
  _Diagnostic that found this:_ a 25ms browser state sampler on the live page
  caught the loader painting stack 2000 then 0, latching `playHasBegun`.
- **`SPIN_FREQ_DENOMINATOR`** in both mirrors is now
  `SPIN_TIERS.reduce((sum, t) => sum + t.freq, 0)`, moved after the tiers array.
  Was a hard-coded `10_000_000` that had gone stale.
- **Round countdown promoted to masthead line 3** —
  `<span className="table-brand__line table-brand__line--round">Round Ends In <MastheadLevelClock .../></span>`.
- **Lobby hover removed.** Merge conflict here: another agent had removed lobby
  hover more broadly on main from the same instruction. I took **main's version**
  (the superset) via `git checkout --theirs`.

### PR #1698 — `fix(table): the round countdown belongs to a game that is still running`

Merged 23:53:22Z. **Found by my own hostile-state pass, not by Dan.** Promoting
the clock to its own line exposed that `levelHasStarted` is true for a COMPLETED
game (it has a `started_at`), so an old bookmark drew "Round Ends In 0:00" over
a game that ended hours ago. Added a `gameIsOver` guard at mount and
`setLevelClock(null)` on the live status change. Fixed under RULE 7.

### PR #1702 — `fix(spin): round 7 audit — twelve places the client answered a question it could not answer`

Merged 2026-08-29T00:19:36Z. Published 00:30:30Z. **Full detail in
`docs/changelog/2026-08-28-seat-first-audit-round-7.md`.** Summary in §4.

---

## 4. PR #1702 IN DETAIL — THE TWELVE

All twelve share one shape: **the code substituted a convenient answer for one
it could not actually obtain, and presented it with the confidence of a fact.**

| #   | Severity     | Where                                  | What                                                  |
| --- | ------------ | -------------------------------------- | ----------------------------------------------------- |
| 1   | **CRITICAL** | `ClubHomePage.tsx` sibling hop         | Unscoped club — see below                             |
| 2   | HIGH         | `ClubHomePage.tsx` ×2 membership reads | Failed read evicted a paying member to `/invite`      |
| 3   | HIGH         | `TablePage.tsx` post-spin result card  | Failed read rendered as "prize 0, finished nowhere"   |
| 4   | MED          | `TablePage.tsx` seat-first recovery    | `tournamentFormat` never restored                     |
| 5   | MED          | `GameLobbyPanel.tsx` ×2                | "Join Spin" / "Take Seat" offered on a RUNNING game   |
| 6   | MED          | `ClubHomePage.tsx`                     | Fetch statuses and realtime filter had drifted apart  |
| 7   | MED          | `TableService.ts`                      | RPC succeeded-but-empty silently replaced by fallback |
| 8   | MED-LOW      | `ClubHomePage.tsx`                     | Delete control compared a UUID against a slug         |
| 9   | MED-LOW      | `TablePage.tsx`                        | Unknown balance printed as a confident `0`            |
| 10  | LOW          | `ClubHomePage.tsx`                     | A bought seat read "You Are Registered", not "Seated" |
| 11  | LOW          | `TablePage.tsx`                        | Failed cash-out read dropped the 2h re-entry minimum  |
| 12  | LOW          | `TablePage.tsx`                        | Seat-bought toast counted from a stale closure        |

### #1 in full — because it is mine and it is the one that could have moved money

The sibling hop I added in **#1642** rescues a player who taps a tile whose game
has just been recycled. It searched for a replacement on
`name + buy_in_amount + variant + status='REGISTERING'` **with no club or union
scope.** Spin names on this platform are identical by construction — every $20
spin in every club carries the same name. The only thing keeping a player out of
a stranger's club, charged against that club's wallet, was arithmetic:

```
total_registering_spins   33
distinct_name_price_keys  33
clubs_running_spins        1     <-- the entire guard
```

One club runs spins today, so it never fired. That is a coincidence, not a
guard, and it evaporates the day a second club opens a $20 spin. **Fixed:** the
hop reads the ORIGIN tournament's own `club_id` and `buy_in_amount` and scopes
to them; if that row cannot be read it finds no sibling rather than guessing.
Scoping by the origin's real `buy_in_amount` also fixes a quieter bug — HU SNG
tiles carry buy-in **plus a 5% fee**, so the tile's displayed price never
matched the sibling's `buy_in_amount` column.

### #6 in full — because it is the closest thing to Dan's "they all disappear"

The fetch admitted `['REGISTERING','RUNNING','LATE_REG','STARTING_SOON']`.
`belongsInTournamentList` (the realtime admission test) re-typed a shorter
`['REGISTERING','RUNNING']` **beside a comment saying it must mirror the
fetch.** A tournament admitted under either extra status is DELETED from the
board by its own next UPDATE — the row vanishes while the player is looking at
it, and only a reload brings it back. Latent today (no writer sets those
statuses), fixed regardless. One module-level `LOBBY_TOURNAMENT_STATUSES` array
now feeds both consumers.

### #10 — with the production check that sized it

`playerStateOf` checks `seatedIds` **first**, precisely so a bought seat reads
SEATED, but that set held only TABLE ids while a spin row is keyed by its
TOURNAMENT id. The branch was unreachable; every seat-holder fell through to the
registered label — the same softer word as the "Spectating" Dan rejected on the
table itself. I checked before assuming it was worse:

```
live_seat_first_seats            41
with_tournament_players_row      41   <-- so registeredIds always caught it
without_tournament_players_row    0
```

Cosmetic, not a lost seat. The seat set now carries **both** ids.

### Tests and guard interactions in #1702

- New: `tests/unit/seatFirstAuditRound7.test.ts`, **15 pins**, every window
  bounded by `tests/helpers/sourceWindow.ts` (`sliceMethod`, `sliceStatement`,
  `sliceEnclosingBlock`). **Byte-count windows are forbidden** and enforced by
  `tests/unit/noFixedSizeSourceWindows.test.ts` — a 7000-char window drifting
  off its own target once stopped the entire estate publishing for 39 minutes.
- The `check-ui-text` pre-push guard **caught my em dash**: I first wrote
  `'—'` for the unknown balance. Correctly refused (Dan 2026-08-20). Now
  `'Unknown'` — a hyphen beside a wallet figure reads as a minus sign, which is
  worse than the `0` it replaced.

---

## 5. PRODUCTION BASELINE AT HANDOFF (measured, 2026-08-29 ~00:40Z)

Compare against these. If one has moved the wrong way, something regressed.

| Metric                                          | Value                      | How measured                                       |
| ----------------------------------------------- | -------------------------- | -------------------------------------------------- |
| Spin fill→start p50                             | **4.78 s**                 | last seat `joined_at` → `started_at`, 132 spins/6h |
| Spin fill→start p90                             | **6.85 s**                 | same                                               |
| Spin fill→start max                             | **8.86 s**                 | same                                               |
| (Was, before #1602)                             | 61.2 s                     | same measure                                       |
| Ghost seats on finished tournaments             | **0** (0 chips)            | was 26 / 191,176 chips                             |
| `fn_unaccounted_seat_exits()`                   | **0**                      | the §11.5 money-leak detector                      |
| Live spins                                      | 32 REGISTERING, 12 RUNNING |                                                    |
| Spins RUNNING > 30 min (stuck)                  | **0**                      |                                                    |
| Spins REGISTERING with seats already full       | **0**                      |                                                    |
| `current_players` vs actual live seats mismatch | **0**                      |                                                    |
| Started spins with NULL `spin_multiplier`       | **0** of 24,912            | the wheel-blocking failure has never fired         |
| Clubs running spins                             | **1**                      | this is what makes finding #1 latent               |

> ⚠ **Do not measure fill→start from `tournaments.created_at`.** Spins are
> created ahead of time and sit REGISTERING until they fill, so that gives ~8300 s
> and means nothing. Measure `max(table_seats.joined_at)` → `started_at`.

> ⚠ **A naive "duplicate live tables" probe gives a false positive.** A 500-player
> MTT legitimately has 8 tables. Scope any such probe to `variant='spin' OR
max_players <= 2`. I checked the one hit and it was a legitimate bounty MTT
> (`Friday Five-Card Bounty`) with the elected table correct.

---

## 6. BINDING LAWS THAT CONSTRAIN THIS WORK

- **§10.5 HORSES ARE PLAYERS.** Never write `is_horse` to leave horses OUT of
  anything a human gets — not a payout, stat, limit, sweep, count or report.
  `is_horse` is legitimate only for identification and for the horse's _input
  device_ (HorseLogic, `scheduleHorseAction`, `autoRebuyHorse`, synthetic
  heartbeat). **There is no "equal outcome by a different mechanism" exemption** —
  Dan rejected exactly that argument on 2026-08-27. The test is "is it
  **identical**", not "is it equivalent"; timing is part of the treatment. Any
  `p_include_horses` parameter defaults **true**. The single sanctioned asymmetry
  is 7-day hand-history retention for horse-only hands — a storage decision,
  Dan's to change, a config row. **Do not "fix" it.**
- **§10.6 ANIMATION LAW.** Every animation and its sound plays every time it is
  owed, for its full duration, at the player's Animation Speed. Enforced by
  `tests/animations-always-play.law.test.ts` and
  `tests/unit/handCompletionLaw.test.ts`. Every pin is a bug that actually
  shipped. Never weaken a pin — if you replace a mechanism, move the pin in the
  same commit. `skip_animations` is dead and stays dead; `--animation-speed` is
  the only sanctioned control; a sound cue at volume 0 is a bug by definition.
- **§10.6 NEVER AUTO-CHANGE TABLES.** Moving `activeIndex` without a user
  gesture is forbidden, no matter how opt-in the proposed setting. Alerts are
  welcome. Enforced by `tests/no-auto-table-switch.law.test.ts`.
- **§11.5 NEVER SPEND REAL CHIPS TO TEST A RULE.** Probe money RPCs inside a
  transaction you **ROLL BACK** (`scripts/dev/probe-rpc.sql` is the pattern).
  What you want is the error message via `GET STACKED DIAGNOSTICS`, which
  survives the rollback. **Never DELETE a `table_seats` row to clean up** — that
  skips the refund and destroys chips. Helper functions go in `pg_temp`, never
  `public`. If you cannot probe without committing, **do not probe** — assert it
  in a unit test and say plainly in the PR that the path was reasoned about
  rather than executed.
  _I followed this:_ I probed `fn_take_seat_and_buy_in` as Dan's own account
  (`kingfish`, `47965354-0e56-43ef-931c-ddaab82af765`) inside a rolled-back
  transaction and got `{"ok": true, "cost": 20.00, "seat_reserved": true}`
  without spending a chip.
- **Popups:** Title Case, **no em dashes**, deduped centrally through
  `src/utils/popupStyle.ts` and the Toast provider. Never hand-roll a popup.
- **§8 NEVER PUSH A RED TEST.** The client suite in `build-for-world-hub.yml` is
  what PUBLISHES. A red test stops the estate. Write specs first if you like, but
  commit them `it.skip()` with a note and delete the `.skip` in the implementing
  commit.
- **Changelogs go in your OWN file** — `docs/changelog/YYYY-MM-DD-<slug>.md`.
  **Do NOT append to `MIGRATION-CHANGELOG.md`**; it is frozen, and it was the
  single biggest source of merge conflict in this repo (18 of 108).

---

## 7. TRAPS THAT COST ME REAL TIME

1. **The sandbox mount cannot unlink.** All git via host terminal. (§0.2)
2. **`gh pr view --json statusCheckRollup` is refused by the token.** Use
   `gh run list` / `gh run view --json jobs`.
3. **A red "TypeScript Check" may actually be CHECK 17** (stale
   `supabase-schema-manifest.json`). Verify locally with
   `node scripts/ci/check-migrations-applied.mjs`.
4. **`.husky/pre-rebase` refusing you is correct.** Do not override. Use
   `git merge` or `git-unstick.sh`. I hit this, obeyed it, and recovered with
   `git reset --hard HEAD` (the commit was already pushed).
5. **Source-window tests:** `slice(start, start + 4000)` fails
   `noFixedSizeSourceWindows.test.ts`. Use `tests/helpers/sourceWindow.ts`.
6. **Do not assert on your own comment prose.** `expect(table).not.toContain('HydraService.seedTable')`
   matched the _comment recording the removal_. Assert on the **call**:
   `'HydraService.seedTable('`.
7. **Prettier runs on pre-commit** (husky). Content on main may differ
   cosmetically from what you authored; adopt formatted HEAD as your base.
8. **The service worker serves the shell cache-first.** Before believing a bug
   report, confirm the reporter is on the current `ca_sha`. **Twice I reported
   findings that were wrong because Dan was on a stale bundle** — I said
   `spin_chips`/`spin_button` were unwired (they are wired; see §8) and that the
   Show Cards constant needed changing (it was already `false`). I corrected both
   in writing. Do the same rather than quietly moving on.
9. **`https://engine.smarter.poker/health` is cache-frozen** (CDN + 15-min fetch
   cache). Never verify a deploy with it. Verify engine deploys through
   Supabase-visible behaviour.

---

## 8. THINGS THAT ARE ALREADY CORRECT — DO NOT "FIX" THEM

- **`spin_chips` / `spin_button` are wired.** Dan listed building them as item
  (2) and I initially reported them unwired. That was wrong. The server emits
  lowercase `type: 'spin_chips'` / `'spin_button'`
  (`TournamentManagerBase.ts:2596, 2664`); `TablePage.tsx:10773` does
  `const normalizedType = rawType.toUpperCase();` and the handlers are
  `case 'SPIN_CHIPS':` (10857) and `case 'SPIN_BUTTON':` (10874). `SPIN_CHIPS`
  writes the drawn stack only into seats still at 0 (so a second delta animation
  cannot fire off an unchanged number); `SPIN_BUTTON` sets `dealerSeat`.
- **The three `setLevelClock` call sites are coherent.** I re-checked at handoff
  time. `8479` (mount) has the `gameIsOver` guard; `14611/14637` (realtime) clears
  on COMPLETED/CANCELLED/FINISHED and returns before the setter; `9732` is inside
  the `level_up` broadcast handler, which cannot arrive for a finished game.
- **The round clock is NOT gated to spins.** It is driven by the tournament row's
  blind structure for any tournament — MTT, Spin and HU all get line 3, gated
  only on "a level has started and the game is not over."
- **`GameServer.ts` helper placement after `discoverTournaments`** — see §3/#1602.
- **Horse-only hand-history retention at 7 days** — see §6.

---

## 9. WHAT IS **NOT** DONE — THE HANDOFF PROPER

### 9.1 UNRESOLVED — the one report I could not reproduce

> Dan: _"every single time i try to sit down at a spin, every single one
> disappears from the spins lobby. and you can't sit or register for one."_

**I never reproduced this on the current build.** I found and fixed two things
that produce that exact symptom, and I believe but cannot prove they were it:

1. **A saved filter dead end.** A persisted filter set could hide every game,
   leaving an empty board. Fixed in #1690 with an auto-unfilter effect
   (`autoUnfilteredRef`) that clears filters hiding every game and toasts
   "Filters Cleared, They Were Hiding Every Game", guarded by
   `if (!narrowing.filtered || !narrowing.fSpec) return;` and
   `if (tables.length + tournaments.length <= 0) return;` so it never fires on a
   genuinely quiet club. **Proven under hostile state:** I planted a poisoned
   filter (`games:['nlh']`, `selectedRanges:['high']`, `statuses:['full']`) in
   `localStorage`, loaded the page, and **35 spin rows rendered**; the filter was
   cleared and persisted back.
2. **The status drift in #1702/#6** — a row deleting itself from the board on its
   own next UPDATE.
3. **Plus the stale bundle** (§7.8), which could make an already-fixed version of
   this look live.

**If it recurs on `ca_sha` ≥ `575f14b1c6`:** get the exact `ca_sha` from
`build-info.json` first, then capture `localStorage` and the browser console at
the moment of the disappearance. A 25ms state sampler on `window` is what caught
the horse-loader latch; the same technique is the right tool here.

### 9.2 NOT VERIFIED IN A LIVE BROWSER

I verified these in code and in the database but **did not watch them happen**:

- **Round countdown on an MTT and on a Heads-Up table.** I confirmed
  `"Round Ends In 0:05"` on a live **Spin** masthead only. The code is
  variant-agnostic (§8), so this is a verification gap, not a suspected bug —
  but Dan asked for all three and only one was seen.
- **Show Cards popup absent at a real tournament showdown.** Both refusal points
  are pinned by tests; no live showdown was observed.
- **Server-side face-up showdown in a real tournament hand.**
  `applyShowdownRevealRules` returning early is unit-pinned, not observed live.
- **The seat-first refund on a real leave.** `fn_leave_seat_and_refund` routing
  is in code and the RPC was probed in a rolled-back transaction; **no real
  seat-first leave was watched end to end**, and no wallet credit was observed
  landing. This is the highest-value live verification left.
- **`useShellUpdateGate` actually reloading a stale client.** Logic and guards
  are written and unit-reasoned; I never observed a real `SHELL_UPDATED` →
  reload cycle on Dan's machine.

### 9.3 KNOWN-INCOMPLETE, WITH NUMBERS

**Discarded-error reads remaining** (the exact shape that produced 5 of the 12
findings in #1702). Counted at handoff by
`grep -c "const { data:\? *[A-Za-z]* *} = await supabase"`:

| File                                | Reads destructuring `data` with no `error`    |
| ----------------------------------- | --------------------------------------------- |
| `src/services/TournamentService.ts` | **20** ← largest, and untouched by this sweep |
| `src/pages/TablePage.tsx`           | 17                                            |
| `src/services/TableService.ts`      | 3                                             |
| `src/pages/ClubHomePage.tsx`        | 3                                             |

Not every one is a bug — many are genuinely optional reads. **But each needs the
same question asked: if this read fails, what does the code then tell the
player?** `TournamentService.ts` is the recommended next target: it is the
service the rest of the platform uses, and it was never opened in this sweep.

**No stubs, TODOs or `not implemented` remain** in `TablePage.tsx`,
`ClubHomePage.tsx`, `TableService.ts`, `src/components/lobby/`, or
`TournamentManagerBase.ts` — I grepped at handoff time. The only `placeholder`
hits are legitimate (input placeholders, and the engine's placeholder blind
structure before the spin draw lands).

### 9.4 OPEN RISK — no repair path for a failed spin draw write

`TournamentManagerBase.ts:1569` logs, after 3 failed attempts:

> _"…`Spin draw row write FAILED after 3 attempts` … `Nx` was drawn but the row
> still reads NULL; this game will run on the placeholder structure and NO
> client can show the wheel until the row is repaired"_

**It is loud, and it has never fired** — 0 started spins with a NULL
`spin_multiplier` across 24,901 COMPLETED + 11 RUNNING. But there is **no
automated repair and no alert**; it depends on a human reading a log. A
reconciliation job that finds `variant='spin' AND started_at IS NOT NULL AND
spin_multiplier IS NULL` and repairs or flags it would close this. **Not built.**

### 9.5 NOT ATTEMPTED AT ALL

- **The "improve, enhance and upgrade to the max" half of Dan's request.** Seven
  of eight PRs were repair. Nothing was done on: spin lobby visual polish, a
  spin-specific results/history surface, spin leaderboards, sound design for the
  reveal, or the multiplier-reveal choreography beyond what already exists.
- **Heads-Up SNGs were only ever fixed _alongside_ spins** because they share the
  seat-first path. **No HU-specific audit was performed.** `max_players <= 2` is
  the rule; if HU has its own defects they are unfound.
- **`GameLobbyPanel`'s MTT branch** was never audited — only the two seat-first
  branches were touched.
- **No Playwright/E2E coverage was added** for any of this. Every new pin is a
  source-text assertion. The CSS Beat E2E job exists and passes but does not
  cover the seat-first flow.
- **No load or concurrency testing** of the 5-second `discoverSeatFirstStarts`
  fast lane. It is correct by inspection (in-tick `tournamentEngines.has()`
  re-check) and has run clean in production for ~16 hours, but two servers
  racing was never tested deliberately.

---

## 10. RECOMMENDED ORDER OF WORK FOR WHOEVER PICKS THIS UP

1. **Confirm the baseline still holds** (§5 table). Five minutes, and it tells
   you whether anything regressed since handoff.
2. **Watch one real seat-first leave end to end** (§9.2). Buy a seat, leave,
   confirm the wallet credit lands in `club_members.chip_balance` and that
   `fn_unaccounted_seat_exits()` stays at 0. **This is the largest untested money
   path in the sweep.**
3. **Audit `TournamentService.ts`** (§9.3, 20 discarded-error reads) with the
   same question that produced #1702: _if this read fails, what does the code
   then tell the player?_
4. **Verify the round clock on a live MTT and a live HU table** (§9.2).
5. **Build the spin-draw reconciliation job** (§9.4).
6. **Do a Heads-Up-specific audit** (§9.5) — it has been carried along, never
   examined.
7. **Then, and only then, the enhancement half of Dan's request** (§9.5). He
   asked for it four times and it is the part I did not get to.

---

## 11. COMPLIANCE STATEMENT (RULE 1, Parts A–E) FOR THE FINAL PR

- **A — shipped:** `git status --porcelain` clean; PR #1702 MERGED
  `2026-08-29T00:19:36Z`; on `origin/main` as `575f14b1c6`.
- **B — rules followed:** all work in `~/Documents/.agent-trees/club-arena/cowork-spin`
  (RULE 2 — the shared clone was never written to). Commits authored
  `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`.
  **`--no-verify` was never used, at any point, in any round.** When
  `check-ui-text` and `.husky/pre-rebase` refused me, I fixed the cause.
- **C — code done:** no TODO/FIXME/stub in the touched surface (grepped, §9.3).
  Every addition has a named caller. One migration
  (`20260828g_no_live_seat_on_a_finished_game.sql`) written **and applied to
  production**, with backfill and post-apply assertions, and registered in the
  CI manifest. Tests updated in the same commits as the behaviour they pin.
- **D — it runs:** `npx tsc --noEmit` 0 errors client and server;
  `npx vitest run tests/` **555 files / 8524 tests passing**;
  `server: npx vitest run` **211 files / 2308 tests passing**.
- **E — it is live:** `https://smarter.poker/hub/club-arena/build-info.json`
  served `ca_sha 575f14b1c6be66b0230cd1ea7784ed9bade4a669`,
  `run_id 33223194326`, at `2026-08-29T00:30:30Z`.
- **RULE 3:** no compiled or minified asset was ever hand-committed to World
  Hub. Every publish went through `build-for-world-hub.yml`.
- **RULE 8 (Zero-Assumption / hostile state):** the poisoned-localStorage proof
  in §9.1; the stale-bookmark proof that produced PR #1698; the stale-bundle
  gate `useShellUpdateGate`; and the production SQL sizing every claim rather
  than asserting it. **The gap in §9.1 is stated as a gap, not closed by
  assertion.**

---

## 12. ONE-PARAGRAPH VERSION, IF YOU READ NOTHING ELSE

Eight PRs merged and published across 2026-08-28 fixed the Spin and seat-first
path end to end: the 60-second start became 4.8s, ghost seats on finished games
went 26 → 0 and are now prevented by a DB trigger, a paid seat no longer reads
"Spectating", the false "table no longer running" toast is gone, phantom card
fans are gone, the client no longer seats horses at all, tournament showdowns are
always face up and the Show Cards prompt cannot appear, the lobby has no hover,
a round countdown sits on masthead line 3 and disappears when the game ends, and
a final audit closed twelve places where the client answered a question it could
not answer — including one I had introduced myself that could have sent a player
into another club's game. **What remains:** one symptom I never reproduced
(§9.1), five things verified in code but not watched live (§9.2), ~43
discarded-error reads still to triage with `TournamentService.ts` first (§9.3),
no repair path for a failed spin draw (§9.4), and the entire "improve and
enhance" half of the request, which Dan asked for four times and I did not reach
(§9.5).
